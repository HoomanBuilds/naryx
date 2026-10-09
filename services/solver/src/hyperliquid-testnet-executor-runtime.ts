import { getWalletAddress } from '@nktkas/hyperliquid/signing';
import {
  HyperliquidExecutionPlanner,
  decimalToAtoms,
  type HypercoreOrderWire,
  type HyperliquidExecutionPlan,
  type HyperliquidExecutionPlannerOptions,
  type HyperliquidStrategyExecutionPlan,
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
  HyperliquidRecoveryTestnetHttpExecution,
  HyperliquidRecoveryTestnetHttpReconciliation,
  HyperliquidTestnetHttpStructuralEvidence,
  HyperliquidStrategyTestnetHttpEvidence,
  type HyperliquidRecoveryExecuteResult,
  type HyperliquidTestnetEvidenceHttpOptions,
} from './hyperliquid-testnet-evidence-http.js';
import { HyperliquidStrategySqliteDurableJournal } from './hyperliquid-strategy-sqlite-journal.js';
import { HyperliquidStrategyTestnetSubmissionService } from './hyperliquid-strategy-testnet-submission.js';
import { HyperliquidStrategyTestnetRuntime } from './hyperliquid-strategy-testnet-runtime.js';
import {
  hyperliquidLaneNotSubmitted,
  hyperliquidRecoveryExecutorResult,
  hyperliquidReconciledExecutorResult,
  HyperliquidTestnetRecoveryError,
  type HyperliquidTestnetAccountInventory,
  type HyperliquidTestnetExecutorRuntimeFactory,
  type HyperliquidTestnetAttemptHandoff,
  type HyperliquidTestnetLaneReleaseRequest,
  type HyperliquidTestnetRecoveryRequest,
  type HyperliquidTestnetRecoveryReconcileRequest,
  type HyperliquidTestnetRecoveryReconcileResponse,
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
  qualifyHyperliquidPerpetualStrategyMarkets,
  type HyperliquidTestnetMarketQualificationConfig,
  type HyperliquidTestnetMarketReadPort,
} from './hyperliquid-testnet-market-preflight.js';
import {
  HyperliquidTestnetRuntimeCoordinator,
  type HyperliquidTestnetRuntimeEvidenceWindow,
  type HyperliquidTestnetStructuralEvidencePort,
} from './hyperliquid-testnet-runtime.js';
import {
  createHyperliquidTrustedTimeSources,
  HyperliquidTrustedClock,
  hyperliquidTrustedTimePolicyFromEnvironment,
  type HyperliquidTrustedTimePort,
} from './hyperliquid-trusted-time.js';

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
  recover(request: HyperliquidTestnetRecoveryRequest): Promise<HyperliquidRecoveryExecuteResult>;
  reconcileRecovery(request: HyperliquidTestnetRecoveryReconcileRequest):
    Promise<HyperliquidTestnetRecoveryReconcileResponse>;
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
  readonly trustedTime?: HyperliquidTrustedTimePort;
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

function recoveryReconcileInput(
  contextJson: string,
  recoveryAttemptId: string,
  currentTimeMs: () => number,
) {
  const context = parseProtocolJson(contextJson, CONTEXT_JSON);
  if (!isRecord(context) || !isRecord(context.prepared)
    || !isRecord(context.binding) || !isRecord(context.window)) {
    throw new Error('stored recovery evidence context is invalid');
  }
  const checkpoint = context.prepared.checkpoint;
  if (!isRecord(checkpoint)
    || typeof checkpoint.observedAtMs !== 'number'
    || !Number.isSafeInteger(checkpoint.observedAtMs)
    || checkpoint.observedAtMs < 0) {
    throw new Error('stored recovery checkpoint is invalid');
  }
  const binding = context.binding;
  const bindingFields = [
    'spotUniverseIndex', 'spotTokenIndex', 'perpetualAssetIndex', 'quoteTokenIndex',
  ] as const;
  if (bindingFields.some((field) => typeof binding[field] !== 'number'
    || !Number.isSafeInteger(binding[field]) || Number(binding[field]) < 0)) {
    throw new Error('stored recovery market binding is invalid');
  }
  const maxEvidenceAgeMs = context.window.maxEvidenceAgeMs;
  const maxSnapshotSkewMs = context.window.maxSnapshotSkewMs;
  const maxFillPages = context.window.maxFillPages;
  if (typeof maxEvidenceAgeMs !== 'number' || !Number.isSafeInteger(maxEvidenceAgeMs)
    || maxEvidenceAgeMs <= 0
    || typeof maxSnapshotSkewMs !== 'number' || !Number.isSafeInteger(maxSnapshotSkewMs)
    || maxSnapshotSkewMs <= 0
    || (maxFillPages !== undefined
      && (typeof maxFillPages !== 'number' || !Number.isSafeInteger(maxFillPages)
        || maxFillPages < 1))) {
    throw new Error('stored recovery evidence limits are invalid');
  }
  const nowMs = currentTimeMs();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error('trusted clock is invalid');
  }
  const deadline = nowMs + readBudgetMs({
    startTimeMs: checkpoint.observedAtMs,
    endTimeMs: nowMs,
    nowMs,
    maxEvidenceAgeMs,
    maxSnapshotSkewMs,
    ...(maxFillPages === undefined ? {} : { maxFillPages }),
  });
  if (!Number.isSafeInteger(deadline)) throw new Error('trusted clock deadline is invalid');
  return Object.freeze({
    recoveryAttemptId,
    checkpoint,
    binding: Object.freeze({
      spotUniverseIndex: binding.spotUniverseIndex as number,
      spotTokenIndex: binding.spotTokenIndex as number,
      perpetualAssetIndex: binding.perpetualAssetIndex as number,
      quoteTokenIndex: binding.quoteTokenIndex as number,
    }),
    window: Object.freeze({
      startTimeMs: checkpoint.observedAtMs,
      endTimeMs: deadline,
      nowMs: deadline,
      maxEvidenceAgeMs,
      maxSnapshotSkewMs,
      ...(maxFillPages === undefined ? {} : { maxFillPages }),
    }),
  });
}

type SourceHyperliquidTestnetAttempt = Extract<
  HyperliquidTestnetAttemptHandoff,
  { readonly admission: unknown }
>;

function plannerOptions(attempt: SourceHyperliquidTestnetAttempt): HyperliquidExecutionPlannerOptions {
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

function sourceExecutionPlan(
  attempt: SourceHyperliquidTestnetAttempt,
  inventory: HyperliquidTestnetAccountInventory,
): HyperliquidExecutionPlan {
  return new HyperliquidExecutionPlanner(plannerOptions(attempt)).compile(attempt.admission, {
    accountPrePerpPositionAtoms: inventory.perpetualPositionAtoms,
  });
}

type RuntimeDecimal = Readonly<{ atoms: bigint; scale: number }>;

function runtimeDecimal(value: string): RuntimeDecimal {
  if (value.length > 80) throw new Error('generalized strategy decimal is invalid');
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (match === null) throw new Error('generalized strategy decimal is invalid');
  const fraction = match[2] ?? '';
  const atoms = BigInt(`${match[1]}${fraction}`);
  if (atoms <= 0n) throw new Error('generalized strategy decimal is invalid');
  return Object.freeze({ atoms, scale: fraction.length });
}

function runtimePow10(value: number): bigint {
  return 10n ** BigInt(value);
}

function compareRuntimeDecimals(left: RuntimeDecimal, right: RuntimeDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const a = left.atoms * runtimePow10(scale - left.scale);
  const b = right.atoms * runtimePow10(scale - right.scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sumRuntimeDecimals(values: readonly string[]): string {
  const parsed = values.map(runtimeDecimal);
  const scale = Math.max(...parsed.map((value) => value.scale));
  const total = parsed.reduce(
    (sum, value) => sum + value.atoms * runtimePow10(scale - value.scale),
    0n,
  );
  const digits = total.toString().padStart(scale + 1, '0');
  if (scale === 0) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return fraction.length === 0 ? digits.slice(0, -scale) : `${digits.slice(0, -scale)}.${fraction}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hypercoreAssetRole(assetId: number): 'SPOT' | 'PERPETUAL' {
  if (Number.isSafeInteger(assetId) && assetId >= 0 && assetId < 10_000) return 'PERPETUAL';
  if (Number.isSafeInteger(assetId) && assetId >= 10_000 && assetId < 100_000) return 'SPOT';
  if (Number.isSafeInteger(assetId) && assetId >= 110_000 && assetId < 100_000_000) return 'PERPETUAL';
  throw new Error('generalized strategy references a reserved or unsupported HyperCore asset ID');
}

function qualifyStrategyShape(
  attempt: HyperliquidTestnetAttemptHandoff,
  inventory: HyperliquidTestnetAccountInventory,
): readonly Readonly<{
  legs: readonly Readonly<{
    role: 'SPOT' | 'PERPETUAL';
    order: HypercoreOrderWire;
  }>[];
}>[] {
  const strategy = attempt.strategy?.plan;
  if (strategy === undefined) throw new Error('generalized strategy plan is missing');
  const expectedDomain = 'admission' in attempt ? attempt.admission.order.domain : strategy.domain;
  if (strategy.domain.domainId !== expectedDomain.domainId
    || strategy.domain.domainManifestVersion !== expectedDomain.domainManifestVersion
    || !sameBytes(strategy.domain.domainManifestHash, expectedDomain.domainManifestHash)
    || strategy.orders.length < 1 || strategy.orders.length > 16
    || strategy.batches.length < 1 || strategy.batches.length > 16
    || strategy.requestExpiryMs <= 0n
    || strategy.requestExpiryMs > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('generalized strategy does not match the qualified HyperCore domain');
  }
  const legIds = new Set(strategy.orders.map((order) => order.legId));
  const clientOrderIds = new Set(strategy.orders.map((order) => order.clientOrderId));
  const batchStages = new Set(strategy.batches.map((batch) => batch.stage));
  if (legIds.size !== strategy.orders.length || clientOrderIds.size !== strategy.orders.length
    || batchStages.size !== strategy.batches.length
    || strategy.batches.reduce((sum, batch) => sum + batch.legIds.length, 0)
      !== strategy.orders.length) {
    throw new Error('generalized strategy plan identities are invalid');
  }
  for (const batch of strategy.batches) {
    const planned = strategy.orders.filter((order) => order.stage === batch.stage);
    if (batch.action.type !== 'order' || batch.action.grouping !== 'na'
      || planned.length < 1 || planned.length !== batch.legIds.length
      || planned.length !== batch.action.orders.length
      || planned.some((order, index) => batch.legIds[index] !== order.legId
        || batch.action.orders[index]?.a !== order.wire.a
        || batch.action.orders[index]?.b !== order.wire.b
        || batch.action.orders[index]?.p !== order.wire.p
        || batch.action.orders[index]?.s !== order.wire.s
        || batch.action.orders[index]?.r !== order.wire.r
        || batch.action.orders[index]?.t.limit.tif !== order.wire.t.limit.tif
        || batch.action.orders[index]?.c !== order.wire.c)) {
      throw new Error(`generalized strategy stage ${batch.stage} is inconsistent`);
    }
  }
  if (attempt.market.spot.assetId === attempt.market.perpetual.assetId) {
    throw new Error('qualified HyperCore market identifiers are invalid');
  }
  const baseAssetDecimals = 'authority' in attempt
    ? attempt.authority.baseAssetDecimals
    : attempt.admission.order.quantity.asset.decimals;
  const assetIdentities = new Map<number, typeof strategy.orders[number]>();
  for (const order of strategy.orders) {
    const role = hypercoreAssetRole(order.wire.a);
    const known = assetIdentities.get(order.wire.a);
    if ((role === 'SPOT' && order.wire.a !== attempt.market.spot.assetId)
      || order.baseAsset.decimals !== baseAssetDecimals
      || (known !== undefined && (order.baseAsset.assetId !== known.baseAsset.assetId
        || order.baseAsset.decimals !== known.baseAsset.decimals
        || !sameBytes(order.baseAsset.assetManifestHash, known.baseAsset.assetManifestHash)
        || order.quoteAsset.assetId !== known.quoteAsset.assetId
        || order.quoteAsset.decimals !== known.quoteAsset.decimals
        || !sameBytes(order.quoteAsset.assetManifestHash, known.quoteAsset.assetManifestHash)))) {
      throw new Error(`generalized strategy leg ${order.legId} uses an unqualified market or asset`);
    }
    assetIdentities.set(order.wire.a, order);
  }
  let availableSpotAtoms = inventory.spotBalanceAtoms;
  const stages = [...new Set(strategy.orders.map((order) => order.stage))]
    .sort((left, right) => left - right);
  for (const stage of stages) {
    const spotOrders = strategy.orders.filter((order) =>
      order.stage === stage && hypercoreAssetRole(order.wire.a) === 'SPOT');
    const requiredSellAtoms = spotOrders.reduce((sum, order) =>
      order.signedBaseDeltaAtoms < 0n ? sum - order.signedBaseDeltaAtoms : sum, 0n);
    if (requiredSellAtoms > availableSpotAtoms) {
      throw new Error(`generalized strategy stage ${stage} exceeds qualified spot inventory`);
    }
    availableSpotAtoms += spotOrders.reduce((sum, order) => sum + order.signedBaseDeltaAtoms, 0n);
  }
  const groups = new Map<string, HypercoreOrderWire[]>();
  for (const order of strategy.orders) {
    const key = `${order.wire.a}:${order.wire.b ? 'BUY' : 'SELL'}`;
    const group = groups.get(key) ?? [];
    group.push(order.wire);
    groups.set(key, group);
  }
  return Object.freeze([...groups.values()].map((orders) => {
    const first = orders[0]!;
    const restrictive = orders.reduce((selected, order) => {
      const comparison = compareRuntimeDecimals(runtimeDecimal(order.p), runtimeDecimal(selected.p));
      return first.b ? comparison < 0 ? order : selected : comparison > 0 ? order : selected;
    }, first);
    const aggregateOrder = Object.freeze({
      ...restrictive,
      s: sumRuntimeDecimals(orders.map((order) => order.s)),
    });
    const role = hypercoreAssetRole(aggregateOrder.a);
    return Object.freeze({
      legs: Object.freeze([Object.freeze({ role, order: aggregateOrder })]),
    });
  }));
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
      async recover() {
        throw new Error('Hyperliquid Testnet recovery is unavailable');
      },
      async reconcileRecovery() {
        throw new Error('Hyperliquid Testnet recovery reconciliation is unavailable');
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
  const allowedPerpetualCoins = nameList(
    environment, 'NARYX_HYPERLIQUID_TESTNET_ALLOWED_PERPETUAL_COINS',
  );
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
  const recoveryExecution = new HyperliquidRecoveryTestnetHttpExecution(evidenceOptions);
  const recoveryReconciliation = new HyperliquidRecoveryTestnetHttpReconciliation(evidenceOptions);
  const signerAddress = (await getWalletAddress(signer)).toLowerCase();
  if (!ADDRESS.test(signerAddress) || signerAddress !== expectedAgent) {
    throw new Error('injected signer does not match the configured Testnet agent address');
  }

  const journal = new HyperliquidSqliteDurableJournal({ databasePath: journalPath });
  let strategyJournal: HyperliquidStrategySqliteDurableJournal | undefined;
  const authorityStore = new HyperliquidAuthorityFenceStore(journalPath);
  let lane: HyperliquidTestnetLane | undefined;
  try {
    strategyJournal = new HyperliquidStrategySqliteDurableJournal({ databasePath: journalPath });
    const generalizedJournal = strategyJournal;
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
        allowedPerpetualCoins,
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
    const marketReader = dependencies.marketReader ?? new HyperliquidSdkTestnetMarketReadClient();
    const trustedTime = dependencies.trustedTime ?? new HyperliquidTrustedClock(
      hyperliquidTrustedTimePolicyFromEnvironment(environment),
      createHyperliquidTrustedTimeSources(marketReader, currentTimeMs),
    );
    const marketPreflight = new HyperliquidTestnetMarketPreflight(
      marketReader,
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
    const strategySubmission = new HyperliquidStrategyTestnetSubmissionService(
      generalizedJournal,
      submitter,
    );
    const strategyEvidence = new HyperliquidStrategyTestnetHttpEvidence(evidenceOptions);
    const lanePort = lane;
    const alignedEvidence = hyperliquidTestnetAlignedEvidence(evidence, {
      currentTimeMs,
      recordContext: (attemptId, contextJson) => lanePort.recordReconcileContext(attemptId, contextJson),
    });
    const coordinator = new HyperliquidTestnetRuntimeCoordinator(alignedEvidence, submission);
    const freshHolderObservation = async (
      stored: Parameters<typeof hyperliquidReconciledExecutorResult>[0],
    ) => {
      const context = lanePort.reconcileContext(stored.attemptId);
      if (context === undefined) return undefined;
      const reconciliation = await alignedEvidence.reconcileStored(context);
      const result = hyperliquidReconciledExecutorResult(stored, reconciliation);
      return result === undefined ? undefined : Object.freeze({ reconciliation, result });
    };
    // A fresh keeper reconciliation of the holder from its stored inputs, or undefined.
    const freshHolderResult = async (stored: Parameters<typeof hyperliquidReconciledExecutorResult>[0]) => {
      try {
        return (await freshHolderObservation(stored))?.result;
      } catch {
        return undefined;
      }
    };
    const runtime = Object.freeze({
      attempts,
      lane,
      async preflight(attempt: HyperliquidTestnetAttemptHandoff): Promise<HyperliquidTestnetAccountInventory> {
        const snapshot = 'authority' in attempt
          ? await authorityPreflight.qualifyUntil(attempt.authority.requiredUntilMs)
          : await authorityPreflight.qualify(attempt.admission);
        const baseAssetDecimals = 'authority' in attempt
          ? attempt.authority.baseAssetDecimals
          : attempt.admission.order.quantity.asset.decimals;
        const inventory = hyperliquidTestnetAccountInventory(
          snapshot,
          qualificationConfig.perpetualName,
          attempt.market.spot.tokenIndex,
          baseAssetDecimals,
        );
        const binding = {
          spotUniverseIndex: attempt.market.spot.universeIndex,
          spotTokenIndex: attempt.market.spot.tokenIndex,
          perpetualAssetIndex: attempt.market.perpetual.assetIndex,
          quoteTokenIndex: attempt.market.quoteTokenIndex,
        };
        if (attempt.strategy === undefined) {
          if (!('admission' in attempt)) throw new Error('native execution requires a strategy plan');
          const plan = sourceExecutionPlan(attempt, inventory);
          requireExitInventory(plan, inventory);
          await marketPreflight.qualify({ plan, binding });
        } else {
          const qualificationPlans = qualifyStrategyShape(attempt, inventory);
          if (qualificationPlans.every((plan) => plan.legs.every((leg) => leg.role === 'PERPETUAL'))) {
            await qualifyHyperliquidPerpetualStrategyMarkets({
              reader: marketReader,
              plans: qualificationPlans,
              allowedCoins: allowedPerpetualCoins,
              quoteTokenIndex: attempt.market.quoteTokenIndex,
              minimumDepth: qualificationConfig.minimumPerpetualDepth,
              maxBookAgeMs: qualificationConfig.maxBookAgeMs,
              maxSnapshotSkewMs: qualificationConfig.maxSnapshotSkewMs,
              maxReferenceDivergenceBps: qualificationConfig.maxReferenceDivergenceBps,
              currentTimeMs,
            });
          } else {
            for (const qualificationPlan of qualificationPlans) {
              if (qualificationPlan.legs.some((leg) =>
                leg.role === 'PERPETUAL' && leg.order.a !== attempt.market.perpetual.assetId)) {
                throw new Error('mixed spot strategy references an unqualified perpetual market');
              }
              await marketPreflight.qualify({ plan: qualificationPlan, binding });
            }
          }
        }
        return inventory;
      },
      async prepareAttempt(
        attempt: HyperliquidTestnetAttemptHandoff,
        inventory?: HyperliquidTestnetAccountInventory,
      ) {
        if (inventory === undefined) throw new Error('the account inventory read under the lane lock is required');
        const timeDecision = await trustedTime.decide(attempt.attemptId);
        const now = timeDecision.selectedTimeMs;
        const nowMs = BigInt(now);
        if (attempt.strategy !== undefined) {
          throw new Error('generalized strategy plans use the strategy runtime');
        }
        if (!('admission' in attempt)) throw new Error('native execution requires a strategy plan');
        const plan = sourceExecutionPlan(attempt, inventory);
        requireExitInventory(plan, inventory);
        journal.recordTrustedTimeDecision(attempt.attemptId, timeDecision);
        const context = journal.submissionContext({
          account: expectedAccount,
          agentWallet: expectedAgent,
          signerLeaseId,
          nowMs,
          timeDecisionHash: timeDecision.decisionHash,
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
      async executeStrategy(attempt: HyperliquidTestnetAttemptHandoff) {
        if (attempt.strategy === undefined) throw new Error('generalized strategy plan is missing');
        const strategyRuntime = new HyperliquidStrategyTestnetRuntime(
          generalizedJournal,
          strategySubmission,
          strategyEvidence,
          {
            account: expectedAccount,
            agentWallet: expectedAgent,
            signerLeaseId,
            maxEvidenceAgeMs: attempt.limits.maxEvidenceAgeMs,
            maxSnapshotSkewMs: attempt.limits.maxSnapshotSkewMs,
            maxFillPages: attempt.limits.maxFillPages,
            evidenceBinding: {
              spotAssetId: attempt.market.spot.assetId,
              perpetualAssetId: attempt.market.perpetual.assetId,
              additionalPerpetualAssetIds: Object.freeze([...new Set(
                attempt.strategy.plan.orders
                  .filter((order) => hypercoreAssetRole(order.wire.a) === 'PERPETUAL'
                    && order.wire.a !== attempt.market.perpetual.assetId)
                  .map((order) => order.wire.a),
              )].sort((left, right) => left - right)),
              baseFeeToken: qualificationConfig.spotTokenName,
              quoteFeeToken: qualificationConfig.quoteTokenName,
            },
            trustedTime,
            currentTimeMs,
          },
        );
        return strategyRuntime.execute(attempt.attemptId, attempt.strategy.plan);
      },
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
      async recover(
        request: HyperliquidTestnetRecoveryRequest,
      ): Promise<HyperliquidRecoveryExecuteResult> {
        const holder = lanePort.blockedHolder();
        if (holder === undefined || holder.attemptId !== request.attemptId) {
          throw new HyperliquidTestnetLaneError(
            'LANE_NOT_BLOCKED_BY_ATTEMPT',
            'Hyperliquid lane is not blocked by that attempt',
          );
        }
        if (holder.result === null) {
          throw new HyperliquidTestnetRecoveryError(
            'RECOVERY_EVIDENCE_UNAVAILABLE',
            'the blocked attempt has no durable result to reconcile',
          );
        }
        let observation;
        try {
          observation = await freshHolderObservation(holder.result);
        } catch {
          throw new HyperliquidTestnetRecoveryError(
            'RECOVERY_EVIDENCE_UNAVAILABLE',
            'fresh authoritative recovery evidence is unavailable',
          );
        }
        if (observation === undefined) {
          throw new HyperliquidTestnetRecoveryError(
            'RECOVERY_EVIDENCE_UNAVAILABLE',
            'the blocked attempt has no stored reconciliation context',
          );
        }
        if (observation.result.status !== 'RECONCILED'
          || observation.result.packageStatus !== 'RECOVERY_REQUIRED') {
          throw new HyperliquidTestnetRecoveryError(
            'RECOVERY_NOT_REQUIRED',
            'fresh authoritative evidence does not require recovery',
          );
        }
        if (!isRecord(observation.reconciliation)
          || observation.reconciliation.status !== 'RECONCILED'
          || !isRecord(observation.reconciliation.attempt)
          || observation.reconciliation.attempt.status !== 'RECOVERY_REQUIRED') {
          throw new HyperliquidTestnetRecoveryError(
            'RECOVERY_EVIDENCE_UNAVAILABLE',
            'fresh authoritative source attempt is invalid',
          );
        }
        return recoveryExecution.execute({
          recoveryAttemptId: request.recoveryAttemptId,
          sourceAttempt: observation.reconciliation.attempt,
          recoverySequence: 0,
          projectedRecoveryCosts: request.projectedRecoveryCosts,
          projectedAggregateLoss: request.projectedAggregateLoss,
        });
      },
      async reconcileRecovery(
        request: HyperliquidTestnetRecoveryReconcileRequest,
      ): Promise<HyperliquidTestnetRecoveryReconcileResponse> {
        const holder = lanePort.blockedHolder();
        if (holder === undefined || holder.attemptId !== request.attemptId) {
          throw new HyperliquidTestnetLaneError(
            'LANE_NOT_BLOCKED_BY_ATTEMPT',
            'Hyperliquid lane is not blocked by that attempt',
          );
        }
        if (holder.result === null || holder.result.status !== 'RECONCILED'
          || holder.result.packageStatus !== 'RECOVERY_REQUIRED') {
          throw new HyperliquidTestnetRecoveryError(
            'RECOVERY_NOT_REQUIRED',
            'the blocked attempt does not have a recovery-required result',
          );
        }
        const context = lanePort.reconcileContext(holder.attemptId);
        if (context === undefined) {
          throw new HyperliquidTestnetRecoveryError(
            'RECOVERY_EVIDENCE_UNAVAILABLE',
            'the blocked attempt has no stored reconciliation context',
          );
        }
        let reconciliation;
        try {
          reconciliation = await recoveryReconciliation.reconcile(
            recoveryReconcileInput(context, request.recoveryAttemptId, currentTimeMs),
          );
        } catch {
          throw new HyperliquidTestnetRecoveryError(
            'RECOVERY_RECONCILIATION_UNAVAILABLE',
            'authoritative recovery reconciliation is unavailable',
          );
        }
        if (reconciliation.status === 'EVIDENCE_INCOMPLETE') {
          return Object.freeze({
            attemptId: holder.attemptId,
            recoveryAttemptId: request.recoveryAttemptId,
            status: 'EVIDENCE_INCOMPLETE' as const,
            reasons: reconciliation.reasons,
            rawEvidenceCommitments: Object.freeze(
              reconciliation.rawResponseCommitments.map((entry) => entry.sha256),
            ),
            release: null,
          });
        }
        const result = hyperliquidRecoveryExecutorResult(
          holder.result,
          request.recoveryAttemptId,
          reconciliation,
        );
        if (result === undefined) {
          throw new HyperliquidTestnetRecoveryError(
            'RECOVERY_RECONCILIATION_UNAVAILABLE',
            'authoritative recovery reconciliation is invalid',
          );
        }
        const release = hyperliquidLaneReleases(result)
          ? lanePort.release({
              holderAttemptId: holder.attemptId,
              disposition: 'FINAL',
              reason: 'automatic: authoritative recovery reconciliation is terminal',
              result,
            })
          : null;
        return Object.freeze({
          attemptId: holder.attemptId,
          recoveryAttemptId: request.recoveryAttemptId,
          status: 'RECONCILED' as const,
          result,
          release,
        });
      },
      close: () => {
        closed = true;
        if (reconcileTimer !== undefined) clearTimeout(reconcileTimer);
        lane?.close();
        authorityStore.close();
        strategyJournal?.close();
        journal.close();
      },
    });
  } catch (error) {
    lane?.close();
    authorityStore.close();
    strategyJournal?.close();
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
