import { getWalletAddress } from '@nktkas/hyperliquid/signing';
import {
  HyperliquidExecutionPlanner,
  decimalToAtoms,
  type HyperliquidExecutionPlan,
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
  hyperliquidLaneNotSubmitted,
  type HyperliquidTestnetAccountInventory,
  type HyperliquidTestnetExecutorRuntimeFactory,
  type HyperliquidTestnetAttemptHandoff,
  type HyperliquidTestnetTrustedAttemptProvider,
} from './hyperliquid-testnet-executor-http.js';
import { HyperliquidTestnetLane } from './hyperliquid-testnet-lane.js';
import { HyperliquidSqliteDurableJournal } from './hyperliquid-sqlite-journal.js';
import {
  HyperliquidAuthorityFenceStore,
  HyperliquidSdkTestnetAuthorityReader,
  HyperliquidTestnetAuthorityPreflight,
  type HyperliquidAuthorityClearanceInput,
  type HyperliquidAuthorityClearancePort,
  type HyperliquidTestnetAuthorityReadPort,
  type HyperliquidTestnetAuthoritySnapshot,
} from './hyperliquid-testnet-authority.js';
import {
  HyperliquidSdkTestnetMarketReadClient,
  HyperliquidTestnetMarketPreflight,
  type HyperliquidTestnetMarketQualificationConfig,
  type HyperliquidTestnetMarketReadPort,
} from './hyperliquid-testnet-market-preflight.js';
import {
  HyperliquidTestnetRuntimeCoordinator,
  type HyperliquidTestnetStructuralEvidencePort,
} from './hyperliquid-testnet-runtime.js';

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
  clearAuthorityIncident(input: HyperliquidAuthorityClearanceInput): Promise<void>;
  /** Operator release of a lane blocked by an attempt whose recovery was resolved and reviewed. */
  releaseLane(holderAttemptId: string): void;
  close(): void;
}>;

export interface HyperliquidTestnetExecutorRuntimeDependencies {
  readonly attempts?: HyperliquidTestnetTrustedAttemptProvider;
  readonly signer?: HyperliquidServerSigner;
  readonly transportFactory?: () => HyperliquidTestnetExchangeTransport;
  readonly fetchImplementation?: typeof fetch;
  readonly currentTimeMs?: () => number;
  readonly marketReader?: HyperliquidTestnetMarketReadPort;
  readonly authorityReader?: HyperliquidTestnetAuthorityReadPort;
  readonly authorityClearance?: HyperliquidAuthorityClearancePort;
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

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, maximum: number): number {
  const value = required(environment, name);
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function nonNegativeInteger(environment: NodeJS.ProcessEnv, name: string, maximum: number): number {
  const value = required(environment, name);
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a nonnegative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be a nonnegative integer no greater than ${maximum}`);
  }
  return parsed;
}

function booleanValue(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = required(environment, name);
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function integerList(environment: NodeJS.ProcessEnv, name: string): readonly number[] {
  const values = required(environment, name).split(',');
  const parsed = values.map((value) => {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be comma-separated integers`);
    const integer = Number(value);
    if (!Number.isSafeInteger(integer)) throw new Error(`${name} contains an unsafe integer`);
    return integer;
  });
  if (new Set(parsed).size !== parsed.length) throw new Error(`${name} must not contain duplicates`);
  return Object.freeze(parsed);
}

function nameList(environment: NodeJS.ProcessEnv, name: string): readonly string[] {
  const values = required(environment, name).split(',');
  if (values.some((value) => !/^[A-Za-z0-9@._:/-]{1,64}$/.test(value))
    || new Set(values).size !== values.length) {
    throw new Error(`${name} must contain unique comma-separated market names`);
  }
  return Object.freeze(values);
}

function marketQualificationConfig(
  environment: NodeJS.ProcessEnv,
): HyperliquidTestnetMarketQualificationConfig {
  return Object.freeze({
    spotUniverseName: required(environment, 'NARYX_HYPERLIQUID_TESTNET_SPOT_UNIVERSE_NAME'),
    spotTokenName: required(environment, 'NARYX_HYPERLIQUID_TESTNET_SPOT_TOKEN_NAME'),
    quoteTokenName: required(environment, 'NARYX_HYPERLIQUID_TESTNET_QUOTE_TOKEN_NAME'),
    perpetualName: required(environment, 'NARYX_HYPERLIQUID_TESTNET_PERPETUAL_NAME'),
    spotUniverseCanonical: booleanValue(
      environment, 'NARYX_HYPERLIQUID_TESTNET_SPOT_UNIVERSE_CANONICAL',
    ),
    spotTokenCanonical: booleanValue(
      environment, 'NARYX_HYPERLIQUID_TESTNET_SPOT_TOKEN_CANONICAL',
    ),
    quoteTokenCanonical: booleanValue(
      environment, 'NARYX_HYPERLIQUID_TESTNET_QUOTE_TOKEN_CANONICAL',
    ),
    spotTokenId: required(
      environment, 'NARYX_HYPERLIQUID_TESTNET_SPOT_TOKEN_ID',
    ) as `0x${string}`,
    quoteTokenId: required(
      environment, 'NARYX_HYPERLIQUID_TESTNET_QUOTE_TOKEN_ID',
    ) as `0x${string}`,
    spotSizeDecimals: nonNegativeInteger(
      environment, 'NARYX_HYPERLIQUID_TESTNET_SPOT_SIZE_DECIMALS', 18,
    ),
    perpetualSizeDecimals: nonNegativeInteger(
      environment, 'NARYX_HYPERLIQUID_TESTNET_PERPETUAL_SIZE_DECIMALS', 18,
    ),
    maxBookAgeMs: positiveInteger(
      environment, 'NARYX_HYPERLIQUID_TESTNET_MAX_BOOK_AGE_MS', 60_000,
    ),
    maxSnapshotSkewMs: positiveInteger(
      environment, 'NARYX_HYPERLIQUID_TESTNET_MAX_BOOK_SNAPSHOT_SKEW_MS', 60_000,
    ),
    maxReferenceDivergenceBps: positiveInteger(
      environment, 'NARYX_HYPERLIQUID_TESTNET_MAX_REFERENCE_DIVERGENCE_BPS', 10_000,
    ),
    minimumSpotDepth: required(
      environment, 'NARYX_HYPERLIQUID_TESTNET_MINIMUM_SPOT_DEPTH',
    ),
    minimumPerpetualDepth: required(
      environment, 'NARYX_HYPERLIQUID_TESTNET_MINIMUM_PERPETUAL_DEPTH',
    ),
  });
}

/**
 * The trading account's perpetual position and spot base balance for the configured market, from
 * the authority snapshot read under the lane lock. Venue decimals that atoms cannot hold fail closed.
 */
export function hyperliquidTestnetAccountInventory(
  snapshot: Pick<HyperliquidTestnetAuthoritySnapshot, 'perpetualState' | 'spotState'>,
  perpetualCoin: string,
  spotTokenIndex: number,
  baseDecimals: number,
): HyperliquidTestnetAccountInventory {
  const positions = snapshot.perpetualState.assetPositions.filter((entry) => entry.position.coin === perpetualCoin);
  const balances = snapshot.spotState.balances.filter((balance) => 'token' in balance && balance.token === spotTokenIndex);
  if (positions.length > 1 || balances.length > 1) throw new Error('trading account inventory is ambiguous');
  return Object.freeze({
    perpetualPositionAtoms: positions[0] === undefined
      ? 0n : decimalToAtoms(positions[0].position.szi, baseDecimals, 'perpetual position'),
    spotBalanceAtoms: balances[0] === undefined
      ? 0n : decimalToAtoms(balances[0].total, baseDecimals, 'spot balance'),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The keeper checkpoint re-reads the account before submission; it must see exactly the position
// the plan targets from, or another actor moved the account and nothing is sent.
function checkpointBoundEvidence(
  evidence: HyperliquidTestnetStructuralEvidencePort<unknown, unknown>,
): HyperliquidTestnetStructuralEvidencePort<unknown, unknown> {
  return Object.freeze({
    async prepare(input: Parameters<typeof evidence.prepare>[0]) {
      const prepared = await evidence.prepare(input);
      if (prepared.status === 'PREPARED') {
        const checkpoint = isRecord(prepared.state) ? prepared.state.checkpoint : undefined;
        if (!isRecord(checkpoint) || checkpoint.perpetualPositionAtoms !== input.plan.prePerpPositionAtoms) {
          throw new Error('checkpoint perpetual position does not match the planned account pre-position');
        }
      }
      return prepared;
    },
    reconcile: (...args: Parameters<typeof evidence.reconcile>) => evidence.reconcile(...args),
  });
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
      async clearAuthorityIncident() {
        throw new Error('Hyperliquid Testnet authority clearance is unavailable');
      },
      releaseLane() {
        throw new Error('Hyperliquid Testnet execution lane is unavailable');
      },
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
  const qualificationConfig = marketQualificationConfig(environment);
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
  const authorityStore = new HyperliquidAuthorityFenceStore(journalPath);
  let lane: HyperliquidTestnetLane | undefined;
  try {
    lane = new HyperliquidTestnetLane({
      databasePath: journalPath,
      notSubmitted: hyperliquidLaneNotSubmitted,
      ...(dependencies.currentTimeMs === undefined ? {} : { currentTimeMs: dependencies.currentTimeMs }),
    });
    const currentTimeMs = dependencies.currentTimeMs ?? Date.now;
    const expectedLeverageMode = required(
      environment, 'NARYX_HYPERLIQUID_TESTNET_EXPECTED_LEVERAGE_MODE',
    );
    if (expectedLeverageMode !== 'cross' && expectedLeverageMode !== 'isolated') {
      throw new Error('NARYX_HYPERLIQUID_TESTNET_EXPECTED_LEVERAGE_MODE must be cross or isolated');
    }
    const authorityPreflight = new HyperliquidTestnetAuthorityPreflight(
      dependencies.authorityReader ?? new HyperliquidSdkTestnetAuthorityReader(currentTimeMs),
      authorityStore,
      Object.freeze({
        account: expectedAccount,
        approvedAgent: expectedAgent,
        incidentBufferMs: positiveInteger(
          environment, 'NARYX_HYPERLIQUID_TESTNET_AUTHORITY_INCIDENT_BUFFER_MS', 604_800_000,
        ),
        expectedPortfolioMarginEnabled: booleanValue(
          environment, 'NARYX_HYPERLIQUID_TESTNET_EXPECTED_PORTFOLIO_MARGIN_ENABLED',
        ),
        expectedPerpetualLeverageMode: expectedLeverageMode,
        allowedSpotTokenIndices: integerList(
          environment, 'NARYX_HYPERLIQUID_TESTNET_ALLOWED_SPOT_TOKEN_INDICES',
        ),
        allowedPerpetualCoins: nameList(
          environment, 'NARYX_HYPERLIQUID_TESTNET_ALLOWED_PERPETUAL_COINS',
        ),
        maxSnapshotAgeMs: positiveInteger(
          environment, 'NARYX_HYPERLIQUID_TESTNET_MAX_AUTHORITY_SNAPSHOT_AGE_MS', 60_000,
        ),
        maxClearanceAgeMs: positiveInteger(
          environment, 'NARYX_HYPERLIQUID_TESTNET_MAX_AUTHORITY_CLEARANCE_AGE_MS', 60_000,
        ),
      }),
      currentTimeMs,
      dependencies.authorityClearance,
    );
    const marketPreflight = new HyperliquidTestnetMarketPreflight(
      dependencies.marketReader ?? new HyperliquidSdkTestnetMarketReadClient(),
      qualificationConfig,
      currentTimeMs,
    );
    const transport = (dependencies.transportFactory
      ?? (() => new HyperliquidTestnetHttpExchangeTransport()))();
    if (transport.isTestnet !== true || transport.apiUrl !== HYPERLIQUID_TESTNET_EXCHANGE_URL) {
      throw new Error('exchange transport identity is not exact Hyperliquid Testnet');
    }
    const submitter = new HyperliquidSdkTestnetOrderSubmitter(signer, transport);
    const submission = new HyperliquidTestnetPackageSubmissionService(journal, submitter);
    const coordinator = new HyperliquidTestnetRuntimeCoordinator(checkpointBoundEvidence(evidence), submission);
    const runtime = Object.freeze({
      attempts,
      lane,
      async preflight(attempt: HyperliquidTestnetAttemptHandoff): Promise<HyperliquidTestnetAccountInventory> {
        const snapshot = await authorityPreflight.qualify(attempt.admission);
        const inventory = hyperliquidTestnetAccountInventory(
          snapshot,
          qualificationConfig.perpetualName,
          attempt.market.spot.tokenIndex,
          attempt.admission.order.quantity.asset.decimals,
        );
        const plan = new HyperliquidExecutionPlanner(plannerOptions(attempt)).compile(attempt.admission, {
          accountPrePerpPositionAtoms: inventory.perpetualPositionAtoms,
        });
        requireExitInventory(plan, inventory);
        await marketPreflight.qualify({
          plan,
          binding: {
            spotUniverseIndex: attempt.market.spot.universeIndex,
            spotTokenIndex: attempt.market.spot.tokenIndex,
            perpetualAssetIndex: attempt.market.perpetual.assetIndex,
            quoteTokenIndex: attempt.market.quoteTokenIndex,
          },
        });
        return inventory;
      },
      prepareAttempt(attempt: HyperliquidTestnetAttemptHandoff, inventory?: HyperliquidTestnetAccountInventory) {
        if (inventory === undefined) throw new Error('the account inventory read under the lane lock is required');
        const now = currentTimeMs();
        if (!Number.isSafeInteger(now) || now <= 0) throw new Error('trusted clock is invalid');
        const nowMs = BigInt(now);
        const plan = new HyperliquidExecutionPlanner(plannerOptions(attempt)).compile(attempt.admission, {
          accountPrePerpPositionAtoms: inventory.perpetualPositionAtoms,
        });
        requireExitInventory(plan, inventory);
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
      clearAuthorityIncident: (input) => authorityPreflight.clearIncident(input),
      releaseLane: (holderAttemptId) => lane!.release(holderAttemptId),
      close: () => {
        lane?.close();
        authorityStore.close();
        journal.close();
      },
    });
  } catch (error) {
    lane?.close();
    authorityStore.close();
    journal.close();
    throw error;
  }
}

// An exit sells spot the omnibus account must already hold for this package.
function requireExitInventory(plan: HyperliquidExecutionPlan, inventory: HyperliquidTestnetAccountInventory): void {
  const spot = plan.legs.find((leg) => leg.role === 'SPOT');
  if (spot !== undefined && spot.signedBaseDeltaAtoms < 0n
    && inventory.spotBalanceAtoms + spot.signedBaseDeltaAtoms < 0n) {
    throw new Error('trading account spot balance does not cover the package exit');
  }
}
