import { createHyperliquidTestnetEvidenceServer, loadKeeperServerConfig } from './hyperliquid-testnet-evidence-http.js';
import { HyperliquidAuthoritativeEvidenceCollector, HyperliquidSdkTestnetReadClient } from './hyperliquid-evidence-collector.js';
import { HyperliquidTestnetEvidenceRuntime } from './hyperliquid-testnet-evidence-runtime.js';
import { readFileSync } from 'node:fs';
import { parseProtocolJson } from '@naryx/protocol-types';
import {
  EvmJsonRpcCodeReader,
  SolanaRpcProgramDataReader,
  loadCodeHashMonitorConfig,
  runCodeHashPass,
} from './code-hash-monitor.js';
import { DependencyIncidentFileStore } from './dependency-incident-engine.js';
import { ed25519HashSigner, httpSnapshotPublisher, loadPositionSnapshotConfig, runPositionSnapshotPass } from './position-snapshot-pass.js';

const config = loadKeeperServerConfig();
const client = new HyperliquidSdkTestnetReadClient();
const collector = new HyperliquidAuthoritativeEvidenceCollector(client);
const runtime = new HyperliquidTestnetEvidenceRuntime(collector);
const server = createHyperliquidTestnetEvidenceServer({ runtime });

// The code-hash monitor only reads chain state; it quarantines a scope in its incident journal
// when reviewed code drifts or disappears.
const monitor = loadCodeHashMonitorConfig(process.env, (path) => readFileSync(path, 'utf8'), parseProtocolJson);
let monitorTimer: ReturnType<typeof setInterval> | undefined;
if (monitor !== undefined) {
  const readers = {
    ...(monitor.evmRpcUrl === undefined ? {} : { EVM: new EvmJsonRpcCodeReader(monitor.evmRpcUrl) }),
    ...(monitor.solanaRpcUrl === undefined ? {} : { SVM: new SolanaRpcProgramDataReader(monitor.solanaRpcUrl) }),
  };
  const journals = monitor.journals.map((entry) => ({ store: new DependencyIncidentFileStore(entry.journalPath), readinessDecision: entry.readinessDecision }));
  const pass = async () => {
    try {
      const observations = await runCodeHashPass({ targets: monitor.targets, readers, journals, nowMs: BigInt(Date.now()), evidenceTtlMs: monitor.evidenceTtlMs });
      const flagged = observations.filter((entry) => entry.status !== 'MATCH');
      if (flagged.length > 0) process.stdout.write(`Code-hash monitor: ${flagged.map((entry) => `${entry.targetId} ${entry.status}`).join(', ')}\n`);
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

function shutdown(): void {
  if (monitorTimer !== undefined) clearInterval(monitorTimer);
  if (positionTimer !== undefined) clearInterval(positionTimer);
  server.close(() => {
    process.exitCode = 0;
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

server.listen(config.port, config.host, () => {
  process.stdout.write(`Keeper evidence service listening on http://${config.host}:${config.port}\n`);
});
