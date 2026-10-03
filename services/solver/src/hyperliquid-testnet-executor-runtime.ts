import { getWalletAddress } from '@nktkas/hyperliquid/signing';
import {
  HyperliquidExecutionPlanner,
  decimalToAtoms,
  type HyperliquidExecutionPlan,
  type HyperliquidExecutionPlannerOptions,
} from '@naryx/adapter-hyperliquid';
import {
  adapterRef,
  parseProtocolJson,
  stringifyProtocolJson,
  versionedManifestRef,
} from '@naryx/protocol-types';
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
  hyperliquidReconciledExecutorResult,
  type HyperliquidTestnetAccountInventory,
  type HyperliquidTestnetExecutorRuntimeFactory,
  type HyperliquidTestnetAttemptHandoff,
  type HyperliquidTestnetLaneReleaseRequest,
  type HyperliquidTestnetTrustedAttemptProvider,
} from './hyperliquid-testnet-executor-http.js';
import {
  HyperliquidTestnetLane,
  HyperliquidTestnetLaneError,
  hyperliquidLaneReleases,
  type HyperliquidLaneRelease,
} from './hyperliquid-testnet-lane.js';
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
  type HyperliquidTestnetRuntimeEvidenceWindow,
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
  /**
   * Journaled operator release of a blocked lane: FINAL only when a fresh keeper reconciliation of
   * the holder shows nothing pending, ABANDONED on the operator's stated reason.
   */
  releaseLane(request: HyperliquidTestnetLaneReleaseRequest): Promise<HyperliquidLaneRelease>;
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

export type HyperliquidTestnetEvidenceAlignmentOptions = Readonly<{
  currentTimeMs: () => number;
  /** Keeps an attempt's reconcile inputs (protocol JSON) so a FINAL lane release can re-read them. */
  recordContext: (attemptId: string, contextJson: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

export type HyperliquidTestnetAlignedEvidence = HyperliquidTestnetStructuralEvidencePort<unknown, unknown>
  & Readonly<{ reconcileStored(contextJson: string): Promise<unknown> }>;

const RECONCILE_READS = 3;
const RECONCILE_RETRY_DELAY_MS = 1_000;
const MAX_READ_BUDGET_MS = 5_000;
const CONTEXT_JSON = 'solver.hyperliquidTestnet.reconcileContext';

// The keeper checks every read it makes against the window's now, so each window closes at a short
// read deadline after the call starts: the reads land inside it and the age bound still holds.
function readBudgetMs(window: HyperliquidTestnetRuntimeEvidenceWindow): number {
  return Math.max(1, Math.min(MAX_READ_BUDGET_MS, Math.floor(window.maxEvidenceAgeMs / 4)));
}

/**
 * The keeper evidence port as the executor uses it. The checkpoint must see exactly the position the
 * plan targets from, or another actor moved the account and nothing is sent. Reconciliation opens
 * at the checkpoint read, so the measured deltas run from exactly that read, and an incomplete read
 * (fills not yet visible) is re-read a bounded number of times inside the evidence age bound.
 */
export function hyperliquidTestnetAlignedEvidence(
  evidence: HyperliquidTestnetStructuralEvidencePort<unknown, unknown>,
  options: HyperliquidTestnetEvidenceAlignmentOptions,
): HyperliquidTestnetAlignedEvidence {
  const sleep = options.sleep
    ?? ((milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); }));
  const clock = (): number => {
    const value = options.currentTimeMs();
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('trusted clock is invalid');
    return value;
  };
  const reconcileAligned = async (
    prepared: unknown,
    handoff: Parameters<typeof evidence.reconcile>[1],
    binding: Parameters<typeof evidence.reconcile>[2],
    window: HyperliquidTestnetRuntimeEvidenceWindow,
  ): Promise<unknown> => {
    const checkpoint = isRecord(prepared) ? prepared.checkpoint : undefined;
    const startTimeMs = isRecord(checkpoint) ? checkpoint.observedAtMs : undefined;
    if (typeof startTimeMs !== 'number' || !Number.isSafeInteger(startTimeMs) || startTimeMs < 0) {
      throw new Error('prepared checkpoint time is invalid');
    }
    const budget = readBudgetMs(window);
    for (let read = 1; ; read += 1) {
      const deadline = clock() + budget;
      const result = await evidence.reconcile(prepared, handoff, binding, {
        ...window, startTimeMs, endTimeMs: deadline, nowMs: deadline,
      });
      const incomplete = isRecord(result) && result.status === 'EVIDENCE_INCOMPLETE';
      if (!incomplete || read >= RECONCILE_READS
        || clock() + RECONCILE_RETRY_DELAY_MS + budget - startTimeMs > window.maxEvidenceAgeMs) {
        return result;
      }
      await sleep(RECONCILE_RETRY_DELAY_MS);
    }
  };
  return Object.freeze({
    async prepare(input: Parameters<typeof evidence.prepare>[0]) {
      const deadline = clock() + readBudgetMs(input.window);
      const prepared = await evidence.prepare({
        ...input, window: { ...input.window, endTimeMs: deadline, nowMs: deadline },
      });
      if (prepared.status === 'PREPARED') {
        const checkpoint = isRecord(prepared.state) ? prepared.state.checkpoint : undefined;
        if (!isRecord(checkpoint) || checkpoint.perpetualPositionAtoms !== input.plan.prePerpPositionAtoms) {
          throw new Error('checkpoint perpetual position does not match the planned account pre-position');
        }
      }
      return prepared;
    },
    async reconcile(...args: Parameters<typeof evidence.reconcile>) {
      const [prepared, handoff, binding, window] = args;
      const attemptId = isRecord(prepared) ? prepared.attemptId : undefined;
      if (typeof attemptId !== 'string' || attemptId.length === 0) {
        throw new Error('prepared evidence state is invalid');
      }
      try {
        options.recordContext(attemptId, stringifyProtocolJson({ prepared, handoff, binding, window }, CONTEXT_JSON));
      } catch {
        // Without a stored context the lane can only be released as ABANDONED; reconciliation goes on.
      }
      return reconcileAligned(prepared, handoff, binding, window);
    },
    async reconcileStored(contextJson: string) {
      const context = parseProtocolJson(contextJson, CONTEXT_JSON);
      if (!isRecord(context) || !isRecord(context.handoff) || !isRecord(context.binding)
        || !isRecord(context.window)) {
        throw new Error('stored reconcile context is invalid');
      }
      return reconcileAligned(
        context.prepared,
        context.handoff as unknown as Parameters<typeof evidence.reconcile>[1],
        context.binding as unknown as Parameters<typeof evidence.reconcile>[2],
        context.window as unknown as HyperliquidTestnetRuntimeEvidenceWindow,
      );
    },
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

/** How often a blocked shared lane is re-reconciled for automatic release. */
const LANE_RECONCILE_INTERVAL_MS = 30_000;

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
      async releaseLane() {
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
    const lanePort = lane;
    const alignedEvidence = hyperliquidTestnetAlignedEvidence(evidence, {
      currentTimeMs,
      recordContext: (attemptId, contextJson) => lanePort.recordReconcileContext(attemptId, contextJson),
    });
    const coordinator = new HyperliquidTestnetRuntimeCoordinator(alignedEvidence, submission);
    // A fresh keeper reconciliation of the holder from its stored inputs, or undefined.
    const freshHolderResult = async (stored: Parameters<typeof hyperliquidReconciledExecutorResult>[0]) => {
      const context = lanePort.reconcileContext(stored.attemptId);
      if (context === undefined) return undefined;
      try {
        return hyperliquidReconciledExecutorResult(stored, await alignedEvidence.reconcileStored(context));
      } catch {
        return undefined;
      }
    };
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
    // Automatic reconciliation of a blocked lane, as the operator's FINAL release does it: while the
    // shared account is blocked by a holder with a stored result, fresh authoritative evidence is
    // re-read every 30 s, and the lane is released only when that evidence shows the holder's
    // outcome is final with nothing pending. A holder interrupted before any result, or one that
    // never reconciles, still waits for the operator.
    let reconcileTimer: NodeJS.Timeout | undefined;
    let closed = false;
    const reconcileBlockedLane = async () => {
      try {
        const holder = lanePort.blockedHolder();
        if (holder !== undefined && holder.result !== null) {
          const result = await freshHolderResult(holder.result);
          if (result !== undefined && hyperliquidLaneReleases(result)) {
            lanePort.release({
              holderAttemptId: holder.attemptId,
              disposition: 'FINAL',
              reason: 'automatic: fresh reconciliation shows the outcome is final',
              result,
            });
            process.stdout.write(`Hyperliquid lane released automatically after ${holder.attemptId} reconciled final\n`);
          }
        }
      } catch {
        // Not final yet, or evidence is unavailable: the lane stays blocked and is retried.
      } finally {
        if (!closed) {
          reconcileTimer = setTimeout(() => void reconcileBlockedLane(), LANE_RECONCILE_INTERVAL_MS);
          reconcileTimer.unref();
        }
      }
    };
    reconcileTimer = setTimeout(() => void reconcileBlockedLane(), LANE_RECONCILE_INTERVAL_MS);
    reconcileTimer.unref();
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
      async releaseLane(request: HyperliquidTestnetLaneReleaseRequest): Promise<HyperliquidLaneRelease> {
        const holder = lanePort.blockedHolder();
        if (holder === undefined || holder.attemptId !== request.attemptId) {
          throw new HyperliquidTestnetLaneError(
            'LANE_NOT_BLOCKED_BY_ATTEMPT',
            'Hyperliquid lane is not blocked by that attempt',
          );
        }
        if (request.disposition === 'ABANDONED') {
          return lanePort.release({
            holderAttemptId: holder.attemptId, disposition: 'ABANDONED', reason: request.reason,
          });
        }
        const result = holder.result === null ? undefined : await freshHolderResult(holder.result);
        if (result === undefined || !hyperliquidLaneReleases(result)) {
          throw new HyperliquidTestnetLaneError(
            'HOLDER_NOT_FINAL',
            'fresh evidence does not show a final outcome for the holder; resolve it and release it as ABANDONED',
          );
        }
        return lanePort.release({
          holderAttemptId: holder.attemptId, disposition: 'FINAL', reason: request.reason, result,
        });
      },
      close: () => {
        closed = true;
        if (reconcileTimer !== undefined) clearTimeout(reconcileTimer);
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
