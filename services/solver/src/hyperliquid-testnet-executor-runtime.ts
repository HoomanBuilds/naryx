import { getWalletAddress } from '@nktkas/hyperliquid/signing';
import {
  HyperliquidExecutionPlanner,
  type HyperliquidExecutionPlannerOptions,
} from '@naryx/adapter-hyperliquid';
import { adapterRef, versionedManifestRef } from '@naryx/protocol-types';
import {
  HYPERLIQUID_SERVER_SIGNER_SCOPE,
  HYPERLIQUID_TESTNET_EXCHANGE_URL,
  HyperliquidSdkTestnetOrderSubmitter,
  HyperliquidTestnetHttpExchangeTransport,
  HyperliquidTestnetPackageSubmissionService,
  type HyperliquidServerSigner,
  type HyperliquidSubmissionAccount,
  type HyperliquidTestnetExchangeTransport,
} from './index.js';
import {
  HyperliquidTestnetHttpStructuralEvidence,
  type HyperliquidTestnetEvidenceHttpOptions,
} from './hyperliquid-testnet-evidence-http.js';
import {
  type HyperliquidTestnetExecutorRuntimeFactory,
  type HyperliquidTestnetAttemptHandoff,
  type HyperliquidTestnetTrustedAttemptProvider,
} from './hyperliquid-testnet-executor-http.js';
import { HyperliquidSqliteDurableJournal } from './hyperliquid-sqlite-journal.js';
import { HyperliquidTestnetRuntimeCoordinator } from './hyperliquid-testnet-runtime.js';

const ADDRESS = /^0x[0-9a-f]{40}$/;

export const HYPERLIQUID_TESTNET_EXECUTION_ENABLED_ENV =
  'NARYX_HYPERLIQUID_TESTNET_EXECUTION_ENABLED';

export type HyperliquidTestnetExecutorRuntimeStatus = Readonly<{
  enabled: boolean;
  environment: 'TESTNET' | null;
  exchangeUrl: typeof HYPERLIQUID_TESTNET_EXCHANGE_URL | null;
  agentWallet: `0x${string}` | null;
  account: HyperliquidSubmissionAccount | null;
}>;

export type LoadedHyperliquidTestnetExecutorRuntime = Readonly<{
  status: HyperliquidTestnetExecutorRuntimeStatus;
  runtimeFactory: HyperliquidTestnetExecutorRuntimeFactory | undefined;
  close(): void;
}>;

export interface HyperliquidTestnetExecutorRuntimeDependencies {
  readonly attempts?: HyperliquidTestnetTrustedAttemptProvider;
  readonly signer?: HyperliquidServerSigner;
  readonly transportFactory?: () => HyperliquidTestnetExchangeTransport;
  readonly fetchImplementation?: typeof fetch;
  readonly currentTimeMs?: () => number;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required when Hyperliquid Testnet execution is enabled`);
  }
  return value;
}

function address(environment: NodeJS.ProcessEnv, name: string): `0x${string}` {
  const value = required(environment, name);
  if (!ADDRESS.test(value)) throw new Error(`${name} must be a lowercase 20-byte address`);
  return value as `0x${string}`;
}

function account(environment: NodeJS.ProcessEnv): HyperliquidSubmissionAccount {
  const accountKind = required(environment, 'NARYX_HYPERLIQUID_TESTNET_ACCOUNT_KIND');
  if (accountKind !== 'MASTER' && accountKind !== 'SUBACCOUNT') {
    throw new Error('NARYX_HYPERLIQUID_TESTNET_ACCOUNT_KIND must be MASTER or SUBACCOUNT');
  }
  const masterAccount = address(environment, 'NARYX_HYPERLIQUID_TESTNET_MASTER_ACCOUNT');
  const tradingAccount = address(environment, 'NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT');
  if (accountKind === 'MASTER' && masterAccount !== tradingAccount) {
    throw new Error('MASTER execution requires identical master and trading accounts');
  }
  if (accountKind === 'SUBACCOUNT' && masterAccount === tradingAccount) {
    throw new Error('SUBACCOUNT execution requires distinct master and trading accounts');
  }
  return Object.freeze({ masterAccount, tradingAccount, accountKind });
}

function enabled(environment: NodeJS.ProcessEnv): boolean {
  const value = environment[HYPERLIQUID_TESTNET_EXECUTION_ENABLED_ENV];
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${HYPERLIQUID_TESTNET_EXECUTION_ENABLED_ENV} must be true or false`);
}

function plannerOptions(attempt: HyperliquidTestnetAttemptHandoff): HyperliquidExecutionPlannerOptions {
  const marketRef = (value: Readonly<Record<string, unknown>>) => ({
    adapter: adapterRef({
      adapterId: value.adapterId as string,
      adapterManifestVersion: value.adapterManifestVersion as number,
      adapterManifestHash: value.adapterManifestHash as string,
    }),
    venue: versionedManifestRef(
      value.venueId as string,
      value.venueManifestVersion as number,
      value.venueManifestHash as string,
    ),
    market: versionedManifestRef(
      value.marketId as string,
      value.marketManifestVersion as number,
      value.marketManifestHash as string,
    ),
    assetId: value.assetId as number,
    sizeDecimals: value.sizeDecimals as number,
  });
  return {
    environment: 'testnet',
    seriesIdentity: {
      domain: attempt.admission.order.domain,
      seriesManifestHash: attempt.seriesManifestHash,
      executionClassManifestHash: attempt.executionClassManifestHash,
    },
    spot: marketRef(attempt.market.spot),
    perpetual: marketRef(attempt.market.perpetual),
  };
}

export async function loadHyperliquidTestnetExecutorRuntime(
  environment: NodeJS.ProcessEnv,
  dependencies: HyperliquidTestnetExecutorRuntimeDependencies = {},
): Promise<LoadedHyperliquidTestnetExecutorRuntime> {
  if (!enabled(environment)) {
    return Object.freeze({
      status: Object.freeze({
        enabled: false,
        environment: null,
        exchangeUrl: null,
        agentWallet: null,
        account: null,
      }),
      runtimeFactory: undefined,
      close() {},
    });
  }

  if (required(environment, 'NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT') !== 'TESTNET') {
    throw new Error('Hyperliquid execution environment must be TESTNET');
  }
  const expectedAgent = address(environment, 'NARYX_HYPERLIQUID_TESTNET_AGENT_ADDRESS');
  const expectedAccount = account(environment);
  const journalPath = required(environment, 'NARYX_HYPERLIQUID_TESTNET_JOURNAL_DB');
  const signerLeaseId = required(environment, 'NARYX_HYPERLIQUID_TESTNET_SIGNER_LEASE_ID');
  const keeperOrigin = required(environment, 'NARYX_HYPERLIQUID_TESTNET_KEEPER_ORIGIN');
  const attempts = dependencies.attempts;
  const signer = dependencies.signer;
  if (attempts === undefined || typeof attempts.resolve !== 'function') {
    throw new Error('a trusted Hyperliquid attempt provider is required');
  }
  if (signer === undefined || signer.signerScope !== HYPERLIQUID_SERVER_SIGNER_SCOPE) {
    throw new Error('an injected server-side Hyperliquid Testnet signer is required');
  }
  const evidenceOptions: HyperliquidTestnetEvidenceHttpOptions = dependencies.fetchImplementation
    ? { keeperOrigin, fetchImplementation: dependencies.fetchImplementation }
    : { keeperOrigin };
  const evidence = new HyperliquidTestnetHttpStructuralEvidence(evidenceOptions);
  const signerAddress = (await getWalletAddress(signer)).toLowerCase();
  if (!ADDRESS.test(signerAddress) || signerAddress !== expectedAgent) {
    throw new Error('injected signer does not match the configured Testnet agent address');
  }

  const journal = new HyperliquidSqliteDurableJournal({ databasePath: journalPath });
  try {
    const transport = (dependencies.transportFactory
      ?? (() => new HyperliquidTestnetHttpExchangeTransport()))();
    if (transport.isTestnet !== true || transport.apiUrl !== HYPERLIQUID_TESTNET_EXCHANGE_URL) {
      throw new Error('exchange transport identity is not exact Hyperliquid Testnet');
    }
    const submitter = new HyperliquidSdkTestnetOrderSubmitter(signer, transport);
    const submission = new HyperliquidTestnetPackageSubmissionService(journal, submitter);
    const coordinator = new HyperliquidTestnetRuntimeCoordinator(evidence, submission);
    const currentTimeMs = dependencies.currentTimeMs ?? Date.now;
    const runtime = Object.freeze({
      attempts,
      prepareAttempt(attempt: HyperliquidTestnetAttemptHandoff) {
        const now = currentTimeMs();
        if (!Number.isSafeInteger(now) || now <= 0) throw new Error('trusted clock is invalid');
        const nowMs = BigInt(now);
        const plan = new HyperliquidExecutionPlanner(plannerOptions(attempt)).compile(attempt.admission);
        const context = journal.submissionContext({
          account: expectedAccount,
          agentWallet: expectedAgent,
          signerLeaseId,
          nowMs,
        });
        const startTimeMs = Math.max(0, now - attempt.limits.maxEvidenceAgeMs);
        return Object.freeze({
          expectedVersion: context.expectedVersion,
          attemptId: attempt.attemptId,
          agentWallet: expectedAgent,
          signerLeaseId,
          plan,
          account: expectedAccount,
          nonce: context.nonce,
          nowMs,
          vaultAddress: expectedAccount.accountKind === 'SUBACCOUNT'
            ? expectedAccount.tradingAccount : null,
          binding: {
            spotUniverseIndex: attempt.market.spot.universeIndex,
            spotTokenIndex: attempt.market.spot.tokenIndex,
            perpetualAssetIndex: attempt.market.perpetual.assetIndex,
            quoteTokenIndex: attempt.market.quoteTokenIndex,
          },
          checkpointWindow: {
            startTimeMs, endTimeMs: now, nowMs: now,
            maxEvidenceAgeMs: attempt.limits.maxEvidenceAgeMs,
            maxSnapshotSkewMs: attempt.limits.maxSnapshotSkewMs,
            maxFillPages: attempt.limits.maxFillPages,
          },
          reconciliationWindow: {
            startTimeMs: now, endTimeMs: now, nowMs: now,
            maxEvidenceAgeMs: attempt.limits.maxEvidenceAgeMs,
            maxSnapshotSkewMs: attempt.limits.maxSnapshotSkewMs,
            maxFillPages: attempt.limits.maxFillPages,
          },
        });
      },
      coordinator,
    });
    return Object.freeze({
      status: Object.freeze({
        enabled: true,
        environment: 'TESTNET',
        exchangeUrl: HYPERLIQUID_TESTNET_EXCHANGE_URL,
        agentWallet: expectedAgent,
        account: expectedAccount,
      }),
      runtimeFactory: () => runtime,
      close: () => journal.close(),
    });
  } catch (error) {
    journal.close();
    throw error;
  }
}
