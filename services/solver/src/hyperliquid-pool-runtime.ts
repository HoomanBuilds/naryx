import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { HttpTransport, InfoClient, TESTNET_API_URL } from '@nktkas/hyperliquid';
import { nettingPolicyManifest, parseProtocolJson, type NettingPolicyManifest } from '@naryx/protocol-types';
import { HyperliquidSqliteDurableJournal } from './index.js';
import { HyperliquidPooledCollateralStore, type HyperliquidPoolBinding } from './hyperliquid-pooled-collateral-store.js';
import { HyperliquidPoolFundingService } from './hyperliquid-pool-funding.js';
import { hyperliquidTestnetPoolFundingReads } from './hyperliquid-pool-funding-reads.js';
import { HyperliquidPoolWithdrawalService, hyperliquidTestnetPoolWithdrawalTransport } from './hyperliquid-pool-withdrawal.js';
import { HyperliquidPoolEpochService, poolEpochPolicyHash } from './hyperliquid-pool-epoch.js';
import { HyperliquidPoolNettingExecution } from './hyperliquid-pool-netting-execution.js';
import { hyperliquidTestnetPoolExecutionReads, type HyperliquidPoolMarketBinding } from './hyperliquid-pool-execution-reads.js';
import { loadHyperliquidNettingResidualTestnetRuntime, type HyperliquidNettingResidualLoadedRuntime } from './hyperliquid-netting-residual-config.js';
import { loadHyperliquidTestnetAgentSigner } from './hyperliquid-testnet-agent-key.js';
import { createHyperliquidPoolController } from './hyperliquid-pool-http.js';
import { HyperliquidTrustedClock, hyperliquidTrustedTimePolicyFromEnvironment, createHyperliquidTrustedTimeSources } from './hyperliquid-trusted-time.js';
import { HyperliquidSdkTestnetMarketReadClient } from './hyperliquid-testnet-market-preflight.js';

interface PoolRuntimeConfig {
  readonly version: 1;
  readonly environment: 'TESTNET';
  readonly binding: HyperliquidPoolBinding;
  readonly databasePath: string;
  readonly journalPath: string;
  readonly entryConfigPath: string;
  readonly exitConfigPath: string;
  readonly markets: readonly HyperliquidPoolMarketBinding[];
  readonly agentAddress: `0x${string}`;
  readonly agentKeyPath: string;
  readonly custodyKeyPath: string;
  readonly encryptionKeyPath: string;
  readonly operatorTokenPath: string;
  readonly keeperOrigin: string;
}

function outsideRepository(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Pool paths must be absolute');
  const resolved = resolve(path);
  const local = relative(resolve(import.meta.dirname, '../../..'), resolved);
  if (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)) throw new Error('Pool state and secrets must be outside the repository');
  return resolved;
}

function readPrivate(path: string, maximum: number): string {
  path = outsideRepository(path);
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || realpathSync(path) !== path || (status.mode & 0o077) !== 0
    || status.size === 0 || status.size > maximum || status.uid !== process.getuid?.()) throw new Error('Pool config must be a canonical owner-only file');
  return readFileSync(path, 'utf8');
}

function readPolicy(path: string): NettingPolicyManifest {
  const config = parseProtocolJson(readPrivate(path, 1_048_576)) as { policy: NettingPolicyManifest };
  return nettingPolicyManifest(config.policy);
}

export async function loadHyperliquidPoolRuntime(environment: NodeJS.ProcessEnv) {
  if (environment.NARYX_HYPERLIQUID_POOL_ENABLED !== 'true'
    || environment.NARYX_HYPERLIQUID_POOL_ENVIRONMENT !== 'TESTNET') throw new Error('Dedicated testnet pool activation is required');
  const config = parseProtocolJson(readPrivate(environment.NARYX_HYPERLIQUID_POOL_CONFIG ?? '', 1_048_576)) as PoolRuntimeConfig;
  if (config.version !== 1 || config.environment !== 'TESTNET'
    || Object.keys(config).sort().join(',') !== 'agentAddress,agentKeyPath,binding,custodyKeyPath,databasePath,encryptionKeyPath,entryConfigPath,environment,exitConfigPath,journalPath,keeperOrigin,markets,operatorTokenPath,version'
    || config.agentAddress === config.binding.poolAccount || config.binding.dedicatedTestOwners.includes(config.agentAddress)
    || config.binding.version !== 3 && config.binding.maximumTotalQuoteAtoms > 100_000_000n) throw new Error('Invalid dedicated test pool configuration');
  const databasePath = outsideRepository(config.databasePath);
  const journalPath = outsideRepository(config.journalPath);
  if (databasePath === journalPath) throw new Error('Custody and execution journals need separate files');
  const entryPolicy = readPolicy(config.entryConfigPath);
  const exitPolicy = readPolicy(config.exitConfigPath);
  if (config.binding.policyHash !== poolEpochPolicyHash(entryPolicy, exitPolicy)) throw new Error('Pool policy binding differs');
  const token = readPrivate(config.operatorTokenPath, 128).trim();
  const agent = loadHyperliquidTestnetAgentSigner(config.agentKeyPath, config.agentAddress, config.encryptionKeyPath);
  const custody = loadHyperliquidTestnetAgentSigner(config.custodyKeyPath, config.binding.poolAccount, config.encryptionKeyPath);
  const store = new HyperliquidPooledCollateralStore(databasePath, config.binding);
  let entry: HyperliquidNettingResidualLoadedRuntime | undefined;
  let exit: HyperliquidNettingResidualLoadedRuntime | undefined;
  try {
    new HyperliquidSqliteDurableJournal({ databasePath: journalPath }).close();
    const trustedTime = new HyperliquidTrustedClock(hyperliquidTrustedTimePolicyFromEnvironment(environment),
      createHyperliquidTrustedTimeSources(new HyperliquidSdkTestnetMarketReadClient(), Date.now));
    const shared: NodeJS.ProcessEnv = {
      NARYX_HYPERLIQUID_TESTNET_NETTING_RESIDUAL_ENABLED: 'true', NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT: 'TESTNET',
      NARYX_HYPERLIQUID_TESTNET_ACCOUNT_KIND: 'MASTER', NARYX_HYPERLIQUID_TESTNET_MASTER_ACCOUNT: config.binding.poolAccount,
      NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT: config.binding.poolAccount, NARYX_HYPERLIQUID_TESTNET_AGENT_ADDRESS: config.agentAddress,
      NARYX_HYPERLIQUID_TESTNET_JOURNAL_DB: journalPath, NARYX_HYPERLIQUID_TESTNET_SIGNER_LEASE_ID: 'dedicated-pool-v1',
      NARYX_HYPERLIQUID_TESTNET_KEEPER_ORIGIN: config.keeperOrigin,
      NARYX_HYPERLIQUID_TESTNET_ALLOWED_PERPETUAL_COINS: config.markets.map(row => row.coin).join(','),
      NARYX_HYPERLIQUID_TESTNET_QUOTE_TOKEN_ID: config.binding.collateralTokenId,
    };
    entry = await loadHyperliquidNettingResidualTestnetRuntime({ ...shared,
      NARYX_HYPERLIQUID_TESTNET_NETTING_RESIDUAL_CONFIG: config.entryConfigPath }, { signer: agent, trustedTime });
    exit = await loadHyperliquidNettingResidualTestnetRuntime({ ...shared,
      NARYX_HYPERLIQUID_TESTNET_NETTING_RESIDUAL_CONFIG: config.exitConfigPath }, { signer: agent, trustedTime });
    if (entry === undefined || exit === undefined) throw new Error('Pool residual execution failed to load');
    const fundingReads = hyperliquidTestnetPoolFundingReads(config.binding.collateralTokenId);
    const execution = new HyperliquidPoolNettingExecution(store, entry.runtime, exit.runtime,
      hyperliquidTestnetPoolExecutionReads(config.binding.poolAccount, entryPolicy, config.markets, config.binding.collateralTokenId));
    const info = new InfoClient({ transport: new HttpTransport({ isTestnet: true, apiUrl: TESTNET_API_URL, timeout: 5_000 }) });
    const epochs = new HyperliquidPoolEpochService(store, fundingReads, {
      async enter(plan) {
        const started = Date.now();
        const [agents, abstraction, dex, modes] = await Promise.all([
          info.extraAgents({ user: config.binding.poolAccount }), info.userAbstraction({ user: config.binding.poolAccount }),
          info.userDexAbstraction({ user: config.binding.poolAccount }),
          Promise.all(config.markets.map(row => info.activeAssetData({ user: config.binding.poolAccount, coin: row.coin }))),
        ]);
        const active = agents.filter(row => row.validUntil === null || row.validUntil > started);
        if (Date.now() - started > 5_000 || active.length !== 1 || active[0]!.address.toLowerCase() !== config.agentAddress
          || active[0]!.validUntil === null || active[0]!.validUntil! < plan.closeAfterMs + 86_400_000
          || (abstraction !== 'default' && abstraction !== 'disabled') || dex !== false
          || !modes.every(row => row.leverage.type === 'cross' && row.leverage.value > 0 && row.leverage.value <= 5)) {
          throw new Error('Pool entry requires exclusive current authority and bounded cross margin');
        }
        await execution.enter(plan);
      },
      close: plan => execution.close(plan), closure: plan => execution.closure(plan), recover: plan => execution.recover(plan),
    });
    const funding = new HyperliquidPoolFundingService(store, fundingReads);
    const withdrawals = new HyperliquidPoolWithdrawalService(store, fundingReads, hyperliquidTestnetPoolWithdrawalTransport(custody));
    const controller = createHyperliquidPoolController({ store, funding, epochs, withdrawals }, token);
    return { controller, close() { entry?.close(); exit?.close(); store.close(); } };
  } catch (error) { entry?.close(); exit?.close(); store.close(); throw error; }
}
