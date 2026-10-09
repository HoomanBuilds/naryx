import { createHyperliquidTestnetEvidenceServer, loadKeeperServerConfig } from './hyperliquid-testnet-evidence-http.js';
import { HyperliquidAuthoritativeEvidenceCollector, HyperliquidSdkTestnetReadClient } from './hyperliquid-evidence-collector.js';
import { HyperliquidTestnetEvidenceRuntime } from './hyperliquid-testnet-evidence-runtime.js';
import { HyperliquidStrategyAuthoritativeEvidenceCollector } from './hyperliquid-strategy-evidence.js';
import { HyperliquidNettingResidualAuthoritativeEvidenceCollector } from './hyperliquid-netting-residual-evidence.js';
import { readFileSync } from 'node:fs';
import { parseProtocolJson } from '@naryx/protocol-types';
import { createCodeReader, loadCodeHashMonitorConfig, runCodeHashPass } from './code-hash-monitor.js';
import { loadKeeperRpcUrls, solanaSlotReader } from './chain-identity.js';
import { DependencyIncidentFileStore } from './dependency-incident-engine.js';
import { DependencyIncidentStatusReader } from './dependency-incident-status.js';
import { ed25519HashSigner, httpSnapshotPublisher, loadPositionSnapshotConfig, runPositionSnapshotPass } from './position-snapshot-pass.js';
import { httpCollateralSnapshotPublisher, loadCollateralSnapshotConfig, runCollateralSnapshotPass } from './collateral-snapshot-pass.js';
import {
  baseSepoliaFundingPort,
  BASE_SEPOLIA_CHAIN_REF,
  FundingSubmissionRecordFile,
  hyperliquidMainnetFundingSource,
  loadEvmKeeperAccount,
  loadFundingMirrorConfig,
  loadSolanaKeeperKeypair,
  runFundingMirrorPass,
  solanaDevnetFundingPort,
  type FundingMarketPort,
} from './funding-mirror.js';
import { httpKeeperPorts, KeeperActionJournal, keeperClock, loadKeeperAutomationConfig, runKeeperAutomationPass } from './keeper-automation-pass.js';
import { loadHyperliquidRecoverySigner, loadHyperliquidRecoveryTestnetConfig } from './hyperliquid-recovery-testnet-config.js';
import { HyperliquidRecoverySqliteStore } from './hyperliquid-recovery-store.js';
import { HyperliquidRecoveryCompiler } from './hyperliquid-recovery-compiler.js';
import { HyperliquidRecoveryTestnetController, HyperliquidRecoveryTestnetRuntime, initializeHyperliquidRecoveryJournal } from './hyperliquid-recovery-testnet-runtime.js';
import { createHyperliquidRecoveryTrustedTimeSources, HyperliquidRecoveryTrustedClock, HyperliquidSdkRecoveryClockReader, HyperliquidSdkRecoveryTestnetSubmitter } from './hyperliquid-recovery-testnet-ports.js';

// Keeper automation dispatches only owner-authorized, kernel-approved actions to a loopback
// executor, consuming each authorization once in its journal. It is off without its config.
// SOLANA_SLOT time comes only from a Solana Devnet endpoint in NARYX_KEEPER_RPC_URLS.
const automation = loadKeeperAutomationConfig(process.env, (path) => readFileSync(path, 'utf8'));
if (automation !== undefined) {
  const journal = new KeeperActionJournal(automation.journalPath);
  const solanaDevnetRpcUrl = loadKeeperRpcUrls(process.env).get('solana:devnet');
  const now = keeperClock({ nowMs: Date.now, ...(solanaDevnetRpcUrl === undefined ? {} : { solanaSlot: solanaSlotReader('solana:devnet', solanaDevnetRpcUrl) }) });
  const ports = { ...httpKeeperPorts(automation.executorOrigin), now };
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const results = await runKeeperAutomationPass({ keeperId: automation.keeperId, entries: automation.entries, ports, journal });
      const acted = results.filter((result) => result.status !== 'NOT_READY' && result.status !== 'SKIPPED_CONSUMED');
      if (acted.length > 0) process.stdout.write(`Keeper automation: ${acted.map((result) => `${result.strategyId} ${result.status}${result.detail === undefined ? '' : ` ${result.detail}`}`).join(', ')}\n`);
    } catch (error) {
      process.stderr.write(`Keeper automation pass failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    } finally {
      running = false;
    }
  };
  void pass();
  setInterval(() => void pass(), automation.intervalMs).unref();
}

const config = loadKeeperServerConfig();
const client = new HyperliquidSdkTestnetReadClient();
const collector = new HyperliquidAuthoritativeEvidenceCollector(client);
const runtime = new HyperliquidTestnetEvidenceRuntime(collector);
const strategy = new HyperliquidStrategyAuthoritativeEvidenceCollector(client);
const nettingResidual = new HyperliquidNettingResidualAuthoritativeEvidenceCollector(client);
const recoveryConfig = loadHyperliquidRecoveryTestnetConfig();
let recoveryStore: HyperliquidRecoverySqliteStore | undefined;
let recovery: HyperliquidRecoveryTestnetController | undefined;
if (recoveryConfig !== undefined) {
  recoveryStore = new HyperliquidRecoverySqliteStore({
    databasePath: recoveryConfig.databasePath,
  });
  try {
    initializeHyperliquidRecoveryJournal({
      store: recoveryStore,
      verifierIdentity: recoveryConfig.verifierIdentity,
      agentWallet: recoveryConfig.agentWallet,
      signerLeaseId: recoveryConfig.signerLeaseId,
    });
    const signer = loadHyperliquidRecoverySigner(
      recoveryConfig.keyPath,
      recoveryConfig.agentWallet,
    );
    const trustedTime = new HyperliquidRecoveryTrustedClock(
      recoveryConfig.trustedTimePolicy,
      createHyperliquidRecoveryTrustedTimeSources(new HyperliquidSdkRecoveryClockReader()),
    );
    const recoveryRuntime = new HyperliquidRecoveryTestnetRuntime({
      store: recoveryStore,
      trustedTime,
      submitter: new HyperliquidSdkRecoveryTestnetSubmitter(signer),
      agentWallet: recoveryConfig.agentWallet,
      signerLeaseId: recoveryConfig.signerLeaseId,
      vaultAddress: recoveryConfig.vaultAddress,
    });
    recovery = new HyperliquidRecoveryTestnetController({
      compiler: new HyperliquidRecoveryCompiler(recoveryConfig.verifierIdentity),
      trustedTime,
      runtime: recoveryRuntime,
    });
  } catch (error) {
    recoveryStore.close();
    throw error;
  }
}

// The code-hash monitor only reads chain state; it quarantines a scope in its incident journal
// when reviewed code drifts or disappears.
const monitor = loadCodeHashMonitorConfig(process.env, (path) => readFileSync(path, 'utf8'), parseProtocolJson);
const monitorJournals = monitor?.journals.map((entry) => ({
  store: new DependencyIncidentFileStore(entry.journalPath),
  readinessDecision: entry.readinessDecision,
}));
const dependencyIncidents = monitorJournals === undefined
  ? undefined
  : new DependencyIncidentStatusReader(monitorJournals.map((entry) => entry.store));
const server = createHyperliquidTestnetEvidenceServer({
  runtime,
  strategy,
  nettingResidual,
  ...(recovery === undefined ? {} : { recovery }),
  ...(dependencyIncidents === undefined ? {} : { dependencyIncidents }),
});
let monitorTimer: ReturnType<typeof setInterval> | undefined;
if (monitor !== undefined && monitorJournals !== undefined) {
  const readers = Object.fromEntries([...monitor.rpcUrls].map(([chainRef, url]) => [chainRef, createCodeReader(chainRef, url)]));
  const pass = async () => {
    try {
      const observations = await runCodeHashPass({ targets: monitor.targets, readers, journals: monitorJournals, nowMs: BigInt(Date.now()), evidenceTtlMs: monitor.evidenceTtlMs });
      const flagged = observations.filter((entry) => entry.status !== 'MATCH');
      if (flagged.length > 0) process.stdout.write(`Code-hash monitor: ${flagged.map((entry) => `${entry.targetId} ${entry.chainRef} ${entry.status}${entry.detail === undefined ? '' : ` (${entry.detail})`}`).join(', ')}\n`);
    } catch (error) {
      process.stderr.write(`Code-hash monitor pass failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    }
  };
  void pass();
  monitorTimer = setInterval(() => void pass(), monitor.intervalMs);
}

// The position snapshot pass only reads HyperCore testnet accounts; its key signs observations,
// never actions, and the public API verifies each snapshot before storing it.
const positionWatch = loadPositionSnapshotConfig(process.env, (path) => readFileSync(path, 'utf8'), parseProtocolJson);
let positionTimer: ReturnType<typeof setInterval> | undefined;
if (positionWatch !== undefined) {
  const signHash = ed25519HashSigner(readFileSync(positionWatch.authorityKeyPath, 'utf8'));
  const publish = httpSnapshotPublisher(positionWatch.apiBaseUrl);
  const reader = {
    clearinghouseState: async (user: `0x${string}`) => (await client.clearinghouseState(user)).payload,
    spotClearinghouseState: async (user: `0x${string}`) => (await client.spotClearinghouseState(user)).payload,
    allMids: () => client.allMids(),
  };
  const pass = async () => {
    const results = await runPositionSnapshotPass({ environment: positionWatch.environment, accounts: positionWatch.accounts, reader, authority: positionWatch.authority, signHash, publish, nowMs: Date.now });
    const failed = results.filter((entry) => entry.status === 'FAILED');
    if (failed.length > 0) process.stderr.write(`Position snapshots failed: ${failed.map((entry) => `${entry.strategyAccount} ${entry.detail ?? ''}`).join('; ')}\n`);
  };
  void pass();
  positionTimer = setInterval(() => void pass(), positionWatch.intervalMs);
}

const collateralWatch = loadCollateralSnapshotConfig(process.env, (path) => readFileSync(path, 'utf8'), parseProtocolJson);
let collateralTimer: ReturnType<typeof setInterval> | undefined;
if (collateralWatch !== undefined) {
  const signHash = ed25519HashSigner(readFileSync(collateralWatch.authorityKeyPath, 'utf8'));
  const publish = httpCollateralSnapshotPublisher(collateralWatch.apiBaseUrl);
  const reader = {
    clearinghouseState: async (user: `0x${string}`) => (await client.clearinghouseState(user)).payload,
  };
  const pass = async () => {
    const results = await runCollateralSnapshotPass({
      environment: collateralWatch.environment,
      accounts: collateralWatch.accounts,
      reader,
      authority: collateralWatch.authority,
      signHash,
      publish,
      nowMs: Date.now,
    });
    const failed = results.filter((entry) => entry.status === 'FAILED');
    if (failed.length > 0) process.stderr.write(`Collateral snapshots failed: ${failed.map((entry) => `${entry.strategyAccount} ${entry.detail ?? ''}`).join('; ')}\n`);
  };
  void pass();
  collateralTimer = setInterval(() => void pass(), collateralWatch.intervalMs);
}

// Funding mirror: reads Hyperliquid mainnet funding signerless and mirrors it onto the Base Sepolia
// and Solana Devnet test perps. Off without NARYX_FUNDING_MIRROR_CONFIG; a dry run unless
// NARYX_FUNDING_MIRROR_WRITES=enabled. Keys come only from the external files the env names.
const fundingMirror = loadFundingMirrorConfig(process.env, (path) => readFileSync(path, 'utf8'));
let fundingTimer: ReturnType<typeof setInterval> | undefined;
if (fundingMirror !== undefined) {
  const rpcUrls = loadKeeperRpcUrls(process.env);
  const evmAccount = fundingMirror.writesEnabled && fundingMirror.evmKeyPath !== undefined ? loadEvmKeeperAccount(readFileSync(fundingMirror.evmKeyPath, 'utf8')) : undefined;
  const solanaKeeper = fundingMirror.writesEnabled && fundingMirror.solanaKeyPath !== undefined ? loadSolanaKeeperKeypair(readFileSync(fundingMirror.solanaKeyPath, 'utf8')) : undefined;
  const ports = new Map<string, FundingMarketPort>();
  for (const market of fundingMirror.markets) {
    const url = rpcUrls.get(market.chainRef);
    if (url === undefined) throw new Error(`NARYX_KEEPER_RPC_URLS has no ${market.chainRef} endpoint for ${market.id}`);
    ports.set(
      market.id,
      market.chainRef === BASE_SEPOLIA_CHAIN_REF
        ? baseSepoliaFundingPort(url, market.market, evmAccount)
        : solanaDevnetFundingPort(url, market.market, market.programId as string, solanaKeeper),
    );
  }
  const source = hyperliquidMainnetFundingSource();
  const record = new FundingSubmissionRecordFile(fundingMirror.recordPath);
  const log = (line: string) => process.stdout.write(`${line}\n`);
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const results = await runFundingMirrorPass({ markets: fundingMirror.markets, source, ports, record, writesEnabled: fundingMirror.writesEnabled, nowMs: Date.now, log });
      for (const result of results) {
        if (result.status === 'SKIPPED_BELOW_THRESHOLD') continue;
        const line = `Funding mirror ${result.marketId} ${result.status}${result.targetRate === undefined ? '' : ` target ${result.targetRate} current ${result.currentRate}`}${result.transaction === undefined ? '' : ` tx ${result.transaction}`}${result.detail === undefined ? '' : ` (${result.detail})`}`;
        (result.status === 'FAILED' ? process.stderr : process.stdout).write(`${line}\n`);
      }
    } catch (error) {
      process.stderr.write(`Funding mirror pass failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    } finally {
      running = false;
    }
  };
  void pass();
  fundingTimer = setInterval(() => void pass(), fundingMirror.intervalMs);
}

function shutdown(): void {
  if (fundingTimer !== undefined) clearInterval(fundingTimer);
  if (monitorTimer !== undefined) clearInterval(monitorTimer);
  if (positionTimer !== undefined) clearInterval(positionTimer);
  if (collateralTimer !== undefined) clearInterval(collateralTimer);
  server.close(() => {
    recoveryStore?.close();
    process.exitCode = 0;
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

server.listen(config.port, config.host, () => {
  process.stdout.write(`Keeper evidence service listening on http://${config.host}:${config.port}\n`);
});
