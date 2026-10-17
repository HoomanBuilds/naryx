import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { loadHyperliquidTestnetAgentSigner } from './hyperliquid-testnet-agent-key.js';
import {
  hyperliquidTestnetAttemptAccount,
  requireHyperliquidTestnetAccountBinding,
} from './hyperliquid-testnet-account-binding.js';
import {
  createHyperliquidTestnetExecutor,
  HyperliquidTestnetExecutorError,
  validateHyperliquidTestnetRuntimeAttempt,
  type HyperliquidTestnetExecutorPort,
  type HyperliquidTestnetLaneOperator,
  type HyperliquidTestnetTrustedAttemptProvider,
} from './hyperliquid-testnet-executor-http.js';
import {
  loadHyperliquidTestnetExecutorRuntime,
  type LoadedHyperliquidTestnetExecutorRuntime,
  type HyperliquidTestnetExecutorRuntimeDependencies,
} from './hyperliquid-testnet-executor-runtime.js';

export interface HyperliquidTestnetUserAccount {
  readonly owner: `0x${string}`;
  readonly agentAddress: `0x${string}`;
  readonly agentKeyPath: string;
  readonly journalPath: string;
  readonly signerLeaseId: string;
}

const ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;

export function parseHyperliquidTestnetUserAccounts(value: unknown): readonly HyperliquidTestnetUserAccount[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('per-user Hyperliquid account configuration must be an object');
  }
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).sort().join(',') !== 'accounts,environment,version'
    || envelope.version !== 1 || envelope.environment !== 'TESTNET'
    || !Array.isArray(envelope.accounts) || envelope.accounts.length > 64) {
    throw new Error('per-user Hyperliquid account configuration is invalid');
  }
  const accounts = envelope.accounts.map((entry: unknown): HyperliquidTestnetUserAccount => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('per-user Hyperliquid account is invalid');
    }
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'agentAddress,agentKeyPath,journalPath,owner,signerLeaseId'
      || typeof row.owner !== 'string' || !ADDRESS.test(row.owner)
      || typeof row.agentAddress !== 'string' || !ADDRESS.test(row.agentAddress)
      || row.owner === row.agentAddress
      || typeof row.agentKeyPath !== 'string' || !isAbsolute(row.agentKeyPath)
      || resolve(row.agentKeyPath) !== row.agentKeyPath
      || typeof row.journalPath !== 'string' || !isAbsolute(row.journalPath)
      || resolve(row.journalPath) !== row.journalPath
      || row.agentKeyPath === row.journalPath
      || typeof row.signerLeaseId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.signerLeaseId)) {
      throw new Error('per-user Hyperliquid account fields are invalid');
    }
    return Object.freeze(row as unknown as HyperliquidTestnetUserAccount);
  });
  for (const field of ['owner', 'agentAddress', 'agentKeyPath', 'journalPath', 'signerLeaseId'] as const) {
    if (new Set(accounts.map((account) => account[field])).size !== accounts.length) {
      throw new Error(`per-user Hyperliquid accounts must have unique ${field}`);
    }
  }
  if (accounts.some((account) => accounts.some((other) => other.agentAddress === account.owner
    || other.agentKeyPath === account.journalPath))) {
    throw new Error('per-user Hyperliquid account and key identities overlap');
  }
  return Object.freeze(accounts);
}

export function loadHyperliquidTestnetUserAccounts(path: string): readonly HyperliquidTestnetUserAccount[] {
  if (!isAbsolute(path)) throw new Error('per-user Hyperliquid account configuration path must be absolute');
  const bytes = readFileSync(path);
  if (bytes.length > 65_536) throw new Error('per-user Hyperliquid account configuration is too large');
  return parseHyperliquidTestnetUserAccounts(JSON.parse(bytes.toString('utf8')) as unknown);
}

export async function loadHyperliquidTestnetPerUserRuntime(input: Readonly<{
  environment: NodeJS.ProcessEnv;
  accounts: readonly HyperliquidTestnetUserAccount[];
  attempts: HyperliquidTestnetTrustedAttemptProvider;
  loadRuntime?: (
    environment: NodeJS.ProcessEnv,
    dependencies: HyperliquidTestnetExecutorRuntimeDependencies,
  ) => Promise<LoadedHyperliquidTestnetExecutorRuntime>;
  loadSigner?: typeof loadHyperliquidTestnetAgentSigner;
}>): Promise<Readonly<{
  executor: HyperliquidTestnetExecutorPort;
  operator: HyperliquidTestnetLaneOperator;
  close(): void;
}>> {
  if (input.environment.NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT !== undefined
    && input.environment.NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT !== 'TESTNET') {
    throw new Error('per-user Hyperliquid execution environment must be TESTNET');
  }
  const accounts = parseHyperliquidTestnetUserAccounts({ version: 1, environment: 'TESTNET', accounts: input.accounts });
  const runtimes = new Map<string, Readonly<{
    runtime: LoadedHyperliquidTestnetExecutorRuntime;
    executor: HyperliquidTestnetExecutorPort;
  }>>();
  const close = () => { for (const entry of runtimes.values()) entry.runtime.close(); };
  try {
    for (const account of accounts) {
      const boundAccount = Object.freeze({
        masterAccount: account.owner, tradingAccount: account.owner, accountKind: 'MASTER' as const,
      });
      const runtime = await (input.loadRuntime ?? loadHyperliquidTestnetExecutorRuntime)({
        ...input.environment,
        NARYX_HYPERLIQUID_TESTNET_EXECUTION_ENABLED: 'true',
        NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT: 'TESTNET',
        NARYX_HYPERLIQUID_TESTNET_ACCOUNT_MODE: 'PER_USER',
        NARYX_HYPERLIQUID_TESTNET_ACCOUNT_KIND: 'MASTER',
        NARYX_HYPERLIQUID_TESTNET_MASTER_ACCOUNT: account.owner,
        NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT: account.owner,
        NARYX_HYPERLIQUID_TESTNET_AGENT_ADDRESS: account.agentAddress,
        NARYX_HYPERLIQUID_TESTNET_JOURNAL_DB: account.journalPath,
        NARYX_HYPERLIQUID_TESTNET_SIGNER_LEASE_ID: account.signerLeaseId,
      }, {
        signer: (input.loadSigner ?? loadHyperliquidTestnetAgentSigner)(account.agentKeyPath, account.agentAddress),
        attempts: {
          async resolve(attemptId) {
            const attempt = await input.attempts.resolve(attemptId);
            if (attempt !== undefined) requireHyperliquidTestnetAccountBinding(attempt, boundAccount);
            return attempt;
          },
        },
      });
      let executor: HyperliquidTestnetExecutorPort | undefined;
      try {
        executor = createHyperliquidTestnetExecutor(runtime.runtimeFactory);
      } catch (error) {
        runtime.close();
        throw error;
      }
      if (executor === undefined) {
        runtime.close();
        throw new Error('per-user Hyperliquid execution runtime is unavailable');
      }
      runtimes.set(account.owner, Object.freeze({ runtime, executor }));
    }
  } catch (error) {
    close();
    throw error;
  }
  const select = async (attemptId: string) => {
    const resolved = await input.attempts.resolve(attemptId);
    if (resolved === undefined) throw new HyperliquidTestnetExecutorError('ATTEMPT_NOT_FOUND', 'attempt was not found');
    const attempt = validateHyperliquidTestnetRuntimeAttempt(attemptId, resolved);
    const binding = hyperliquidTestnetAttemptAccount(attempt);
    const entry = runtimes.get(binding.owner);
    if (entry === undefined || binding.owner !== binding.settlementAccount) {
      throw new HyperliquidTestnetExecutorError('INVALID_ATTEMPT',
        'the owner has no configured per-user Hyperliquid account; shared-account fallback is disabled');
    }
    return entry;
  };
  const executor: HyperliquidTestnetExecutorPort = {
    execute: async (request) => (await select(request.attemptId)).executor.execute(request),
    status: async (request) => (await select(request.attemptId)).executor.status(request),
  };
  const operator: HyperliquidTestnetLaneOperator = {
    releaseLane: async (request) => (await select(request.attemptId)).runtime.releaseLane(request),
    recover: async (request) => (await select(request.attemptId)).runtime.recover(request),
    reconcileRecovery: async (request) => (await select(request.attemptId)).runtime.reconcileRecovery(request),
  };
  return Object.freeze({
    executor: Object.freeze(executor),
    operator: Object.freeze(operator),
    close,
  });
}
