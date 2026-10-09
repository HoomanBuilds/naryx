import { createHash } from 'node:crypto';
import { HttpTransport, InfoClient, TESTNET_API_URL } from '@nktkas/hyperliquid';
import {
  type ClearinghouseStateResponse,
  type MetaResponse,
  type OpenOrdersResponse,
  type OrderStatusResponse,
  type SpotClearinghouseStateResponse,
  type SpotMetaResponse,
  type UserFillsByTimeResponse,
  type UserRoleResponse,
} from '@nktkas/hyperliquid/api/info';
import { bytesEqual, type AssetRef } from '@naryx/protocol-types';
import {
  HYPERCORE_RECONCILIATION_SOURCE,
  type HyperliquidAccountIdentity,
  type HyperliquidFeeObservationInput,
  type HyperliquidLegReconciliationInput,
  type HyperliquidPackageAttempt,
  type HyperliquidReconciliationSnapshotInput,
} from './index.js';
import {
  HYPERCORE_RECOVERY_RECONCILIATION_SOURCE,
  type HyperliquidRecoveryAttempt,
  type HyperliquidRecoveryReconciliationSnapshotInput,
} from './hyperliquid-recovery-reconciliation.js';
import { hyperliquidRecoveryAggregateLossQuoteAtoms } from './hyperliquid-recovery-loss.js';

export const HYPERLIQUID_TESTNET_INFO_URL = TESTNET_API_URL;

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const CLOID_PATTERN = /^0x[0-9a-f]{32}$/;
const TERMINAL_STATUSES = new Set([
  'filled',
  'canceled',
  'rejected',
  'marginCanceled',
  'vaultWithdrawalCanceled',
  'openInterestCapCanceled',
  'selfTradeCanceled',
  'reduceOnlyCanceled',
  'siblingFilledCanceled',
  'delistedCanceled',
  'liquidatedCanceled',
  'scheduledCancel',
  'tickRejected',
  'minTradeNtlRejected',
  'perpMarginRejected',
  'reduceOnlyRejected',
  'badAloPxRejected',
  'iocCancelRejected',
  'badTriggerPxRejected',
  'marketOrderNoLiquidityRejected',
  'positionIncreaseAtOpenInterestCapRejected',
  'positionFlipAtOpenInterestCapRejected',
  'tooAggressiveAtOpenInterestCapRejected',
  'openInterestIncreaseRejected',
  'insufficientSpotBalanceRejected',
  'oracleRejected',
  'perpMaxPositionRejected',
]);

export type HyperliquidInfoOperation =
  | 'spotMeta'
  | 'meta'
  | 'spotClearinghouseState'
  | 'clearinghouseState'
  | 'openOrders'
  | 'orderStatus'
  | 'userFillsByTime'
  | 'userRole';

export interface HyperliquidInfoRequestIdentity {
  readonly operation: HyperliquidInfoOperation;
  readonly user?: `0x${string}`;
  readonly cloid?: `0x${string}`;
  readonly startTimeMs?: number;
  readonly endTimeMs?: number;
}

export interface HyperliquidInfoEnvelope<T> {
  readonly environment: 'testnet';
  readonly apiUrl: typeof HYPERLIQUID_TESTNET_INFO_URL;
  readonly request: HyperliquidInfoRequestIdentity;
  readonly requestedAtMs: number;
  readonly receivedAtMs: number;
  readonly payload: T;
}

export interface HyperliquidTestnetReadClient {
  readonly environment: 'testnet';
  readonly apiUrl: typeof HYPERLIQUID_TESTNET_INFO_URL;
  spotMeta(): Promise<HyperliquidInfoEnvelope<SpotMetaResponse>>;
  meta(): Promise<HyperliquidInfoEnvelope<MetaResponse>>;
  spotClearinghouseState(user: `0x${string}`):
    Promise<HyperliquidInfoEnvelope<SpotClearinghouseStateResponse>>;
  clearinghouseState(user: `0x${string}`):
    Promise<HyperliquidInfoEnvelope<ClearinghouseStateResponse>>;
  openOrders(user: `0x${string}`): Promise<HyperliquidInfoEnvelope<OpenOrdersResponse>>;
  userRole(user: `0x${string}`): Promise<HyperliquidInfoEnvelope<UserRoleResponse>>;
  orderStatus(user: `0x${string}`, cloid: `0x${string}`):
    Promise<HyperliquidInfoEnvelope<OrderStatusResponse>>;
  userFillsByTime(user: `0x${string}`, startTimeMs: number, endTimeMs: number):
    Promise<HyperliquidInfoEnvelope<UserFillsByTimeResponse>>;
}

export class HyperliquidSdkTestnetReadClient implements HyperliquidTestnetReadClient {
  readonly environment = 'testnet' as const;
  readonly apiUrl = HYPERLIQUID_TESTNET_INFO_URL;
  readonly #client: InfoClient;

  constructor() {
    const transport = new HttpTransport({
      isTestnet: true,
      apiUrl: HYPERLIQUID_TESTNET_INFO_URL,
    });
    if (!transport.isTestnet || transport.apiUrl.toString() !== HYPERLIQUID_TESTNET_INFO_URL) {
      throw new Error('Hyperliquid Info transport is not pinned to testnet');
    }
    this.#client = new InfoClient({ transport });
  }

  async #read<T>(request: HyperliquidInfoRequestIdentity, call: () => Promise<T>):
    Promise<HyperliquidInfoEnvelope<T>> {
    const requestedAtMs = Date.now();
    const payload = await call();
    const receivedAtMs = Date.now();
    return Object.freeze({
      environment: this.environment,
      apiUrl: this.apiUrl,
      request: Object.freeze(request),
      requestedAtMs,
      receivedAtMs,
      payload,
    });
  }

  spotMeta(): Promise<HyperliquidInfoEnvelope<SpotMetaResponse>> {
    return this.#read({ operation: 'spotMeta' }, () => this.#client.spotMeta());
  }

  meta(): Promise<HyperliquidInfoEnvelope<MetaResponse>> {
    return this.#read({ operation: 'meta' }, () => this.#client.meta());
  }

  spotClearinghouseState(user: `0x${string}`):
    Promise<HyperliquidInfoEnvelope<SpotClearinghouseStateResponse>> {
    return this.#read({ operation: 'spotClearinghouseState', user },
      () => this.#client.spotClearinghouseState({ user }));
  }

  clearinghouseState(user: `0x${string}`):
    Promise<HyperliquidInfoEnvelope<ClearinghouseStateResponse>> {
    return this.#read({ operation: 'clearinghouseState', user },
      () => this.#client.clearinghouseState({ user }));
  }

  /** Every coin's mid price; indicative marks for risk reads, never execution prices. */
  allMids(): Promise<Readonly<Record<string, string>>> {
    return this.#client.allMids();
  }

  openOrders(user: `0x${string}`): Promise<HyperliquidInfoEnvelope<OpenOrdersResponse>> {
    return this.#read({ operation: 'openOrders', user }, () => this.#client.openOrders({ user }));
  }

  userRole(user: `0x${string}`): Promise<HyperliquidInfoEnvelope<UserRoleResponse>> {
    return this.#read({ operation: 'userRole', user }, () => this.#client.userRole({ user }));
  }

  orderStatus(user: `0x${string}`, cloid: `0x${string}`):
    Promise<HyperliquidInfoEnvelope<OrderStatusResponse>> {
    return this.#read({ operation: 'orderStatus', user, cloid },
      () => this.#client.orderStatus({ user, oid: cloid }));
  }

  userFillsByTime(user: `0x${string}`, startTimeMs: number, endTimeMs: number):
    Promise<HyperliquidInfoEnvelope<UserFillsByTimeResponse>> {
    return this.#read({ operation: 'userFillsByTime', user, startTimeMs, endTimeMs },
      () => this.#client.userFillsByTime({
        user,
        startTime: startTimeMs,
        endTime: endTimeMs,
        aggregateByTime: false,
        reversed: false,
      }));
  }
}

export interface HyperliquidEvidenceMarketBinding {
  readonly spotUniverseIndex: number;
  readonly spotTokenIndex: number;
  readonly perpetualAssetIndex: number;
  readonly quoteTokenIndex: number;
}

export interface HyperliquidEvidenceWindow {
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly nowMs: number;
  readonly maxEvidenceAgeMs: number;
  readonly maxSnapshotSkewMs: number;
  readonly maxFillPages?: number;
}

export interface HyperliquidRawResponseCommitment {
  readonly operation: HyperliquidInfoOperation;
  readonly request: HyperliquidInfoRequestIdentity;
  readonly requestedAtMs: number;
  readonly receivedAtMs: number;
  readonly sha256: `0x${string}`;
}

export interface HyperliquidDecimalRatio {
  readonly coefficient: bigint;
  readonly scale: number;
}

export interface HyperliquidObservedFill {
  readonly clientOrderId: `0x${string}`;
  readonly orderId: number;
  readonly transactionId: number;
  readonly coin: string;
  readonly signedBaseAtoms: bigint;
  readonly price: HyperliquidDecimalRatio;
  readonly feeToken: string;
  readonly feeAtoms: bigint;
  readonly observedAtMs: number;
}

export interface HyperliquidCollectedStateObservation {
  readonly orders: readonly HyperliquidLegReconciliationInput[];
  readonly netSpotBalanceDeltaAtoms: bigint;
  readonly perpetualPositionDeltaAtoms: bigint;
  readonly observedPerpetualPositionAtoms: bigint;
  readonly fees: readonly Readonly<{
    readonly asset: AssetRef;
    readonly amountAtoms: bigint;
    readonly evidenceStatus: 'CONFIRMED' | 'UNCERTAIN';
  }>[];
}

export type HyperliquidEvidenceIncompleteReason =
  | 'READ_FAILED'
  | 'ENVIRONMENT_MISMATCH'
  | 'REQUEST_IDENTITY_MISMATCH'
  | 'ACCOUNT_IDENTITY_MISMATCH'
  | 'CHECKPOINT_MISMATCH'
  | 'UNKNOWN_ASSET_OR_MARKET'
  | 'AMBIGUOUS_CLOID'
  | 'CONFLICTING_DUPLICATE_FILL'
  | 'INCOMPLETE_PAGINATION'
  | 'STALE_OR_MIXED_SNAPSHOT'
  | 'UNCERTAIN_FEE_EVIDENCE'
  | 'MALFORMED_RESPONSE'
  | 'AGGREGATE_RECOVERY_LOSS_UNAVAILABLE';

export interface HyperliquidEvidenceCheckpoint {
  readonly version: 1;
  readonly attemptCommitment: `0x${string}`;
  readonly account: HyperliquidAccountIdentity;
  readonly baseSpotBalanceAtoms: bigint;
  readonly perpetualPositionAtoms: bigint;
  readonly observedAtMs: number;
  readonly rawResponseCommitments: readonly HyperliquidRawResponseCommitment[];
}

export type HyperliquidEvidenceResult<T> = Readonly<{
  status: 'COMPLETE';
  input: T;
  accountObservation: HyperliquidCollectedStateObservation;
  observedFills: readonly HyperliquidObservedFill[];
  rawResponseCommitments: readonly HyperliquidRawResponseCommitment[];
}> | Readonly<{
  status: 'INCOMPLETE';
  input: null;
  accountObservation: HyperliquidCollectedStateObservation | null;
  reasons: readonly HyperliquidEvidenceIncompleteReason[];
  observedFills: readonly HyperliquidObservedFill[];
  rawResponseCommitments: readonly HyperliquidRawResponseCommitment[];
}>;

export type HyperliquidCheckpointResult = Readonly<{
  status: 'COMPLETE';
  checkpoint: HyperliquidEvidenceCheckpoint;
}> | Readonly<{
  status: 'INCOMPLETE';
  checkpoint: null;
  reasons: readonly HyperliquidEvidenceIncompleteReason[];
  rawResponseCommitments: readonly HyperliquidRawResponseCommitment[];
}>;

interface ExpectedOrder {
  readonly role: 'SPOT' | 'PERPETUAL';
  readonly cloid: `0x${string}`;
  readonly coin: string;
  readonly signedBaseAtoms: bigint;
  readonly baseDecimals: number;
  readonly sizeDecimals: number;
  readonly wireAsset: number;
}

interface CollectedAccountEvidence {
  readonly userRole: HyperliquidInfoEnvelope<UserRoleResponse>;
  readonly spotMeta: HyperliquidInfoEnvelope<SpotMetaResponse>;
  readonly perpMeta: HyperliquidInfoEnvelope<MetaResponse>;
  readonly spotState: HyperliquidInfoEnvelope<SpotClearinghouseStateResponse>;
  readonly perpState: HyperliquidInfoEnvelope<ClearinghouseStateResponse>;
}

interface CollectedOrders {
  readonly openOrders: HyperliquidInfoEnvelope<OpenOrdersResponse>;
  readonly statuses: readonly HyperliquidInfoEnvelope<OrderStatusResponse>[];
  readonly fills: readonly HyperliquidInfoEnvelope<UserFillsByTimeResponse>[];
}

interface ResolvedMarkets {
  readonly spotCoin: string;
  readonly spotBalanceCoin: string;
  readonly perpetualCoin: string;
  readonly feeToken: string;
}

function stableValue(value: unknown): unknown {
  if (typeof value === 'bigint') return { bigint: value.toString() };
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function sha256(value: unknown): `0x${string}` {
  return `0x${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function rawCommitment(envelope: HyperliquidInfoEnvelope<unknown>): HyperliquidRawResponseCommitment {
  return Object.freeze({
    operation: envelope.request.operation,
    request: Object.freeze({ ...envelope.request }),
    requestedAtMs: envelope.requestedAtMs,
    receivedAtMs: envelope.receivedAtMs,
    sha256: sha256(envelope),
  });
}

function decimalRatio(value: string): HyperliquidDecimalRatio {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(value);
  if (match === null) throw new Error('decimal is malformed');
  const fraction = match[3] ?? '';
  const coefficient = BigInt(`${match[1] ?? ''}${match[2]}${fraction}`);
  return Object.freeze({ coefficient, scale: fraction.length });
}

function decimalToAtoms(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new Error('asset decimals are invalid');
  }
  const parsed = decimalRatio(value);
  if (parsed.scale > decimals) {
    const divisor = 10n ** BigInt(parsed.scale - decimals);
    if (parsed.coefficient % divisor !== 0n) throw new Error('decimal requires rounding');
    return parsed.coefficient / divisor;
  }
  return parsed.coefficient * 10n ** BigInt(decimals - parsed.scale);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function normalizedAssetSymbol(value: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) return null;
  return value.toLowerCase();
}

function normalizedAccount(account: HyperliquidAccountIdentity): HyperliquidAccountIdentity {
  const masterAccount = account.masterAccount.toLowerCase() as `0x${string}`;
  const tradingAccount = account.tradingAccount.toLowerCase() as `0x${string}`;
  if (!ADDRESS_PATTERN.test(masterAccount) || !ADDRESS_PATTERN.test(tradingAccount)
    || (account.accountKind !== 'MASTER' && account.accountKind !== 'SUBACCOUNT')
    || (account.accountKind === 'MASTER' && masterAccount !== tradingAccount)
    || (account.accountKind === 'SUBACCOUNT' && masterAccount === tradingAccount)) {
    throw new Error('account identity is invalid');
  }
  return Object.freeze({ masterAccount, tradingAccount, accountKind: account.accountKind });
}

function attemptCommitment(attempt: HyperliquidPackageAttempt, binding: HyperliquidEvidenceMarketBinding):
  `0x${string}` {
  return sha256({
    domain: attempt.plan.domain,
    commitments: attempt.plan.commitments,
    account: attempt.account,
    cloids: [attempt.plan.spotClientOrderId, attempt.plan.perpetualClientOrderId],
    binding,
  });
}

function addReason(reasons: HyperliquidEvidenceIncompleteReason[], reason: HyperliquidEvidenceIncompleteReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function verifyEnvelope(
  envelope: HyperliquidInfoEnvelope<unknown>,
  request: HyperliquidInfoRequestIdentity,
  window: HyperliquidEvidenceWindow,
  reasons: HyperliquidEvidenceIncompleteReason[],
): void {
  if (envelope.environment !== 'testnet' || envelope.apiUrl !== HYPERLIQUID_TESTNET_INFO_URL) {
    addReason(reasons, 'ENVIRONMENT_MISMATCH');
  }
  if (JSON.stringify(stableValue(envelope.request)) !== JSON.stringify(stableValue(request))) {
    addReason(reasons, 'REQUEST_IDENTITY_MISMATCH');
  }
  if (!Number.isSafeInteger(envelope.requestedAtMs) || !Number.isSafeInteger(envelope.receivedAtMs)
    || envelope.requestedAtMs > envelope.receivedAtMs
    || envelope.receivedAtMs > window.nowMs
    || window.nowMs - envelope.receivedAtMs > window.maxEvidenceAgeMs) {
    addReason(reasons, 'STALE_OR_MIXED_SNAPSHOT');
  }
}

function verifySnapshotSkew(
  envelopes: readonly HyperliquidInfoEnvelope<unknown>[],
  window: HyperliquidEvidenceWindow,
  reasons: HyperliquidEvidenceIncompleteReason[],
): void {
  const requested = envelopes.map((value) => value.requestedAtMs);
  const received = envelopes.map((value) => value.receivedAtMs);
  if (Math.max(...received) - Math.min(...requested) > window.maxSnapshotSkewMs) {
    addReason(reasons, 'STALE_OR_MIXED_SNAPSHOT');
  }
}

function validateWindow(window: HyperliquidEvidenceWindow): void {
  const values = [window.startTimeMs, window.endTimeMs, window.nowMs,
    window.maxEvidenceAgeMs, window.maxSnapshotSkewMs];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)
    || window.startTimeMs > window.endTimeMs || window.endTimeMs > window.nowMs
    || window.maxEvidenceAgeMs === 0 || window.maxSnapshotSkewMs === 0
    || (window.maxFillPages !== undefined
      && (!Number.isSafeInteger(window.maxFillPages) || window.maxFillPages < 1))) {
    throw new Error('evidence window is invalid');
  }
}

function verifyFillWindowFresh(
  window: HyperliquidEvidenceWindow,
  reasons: HyperliquidEvidenceIncompleteReason[],
): void {
  if (window.endTimeMs !== window.nowMs
    || window.nowMs - window.startTimeMs > window.maxEvidenceAgeMs) {
    addReason(reasons, 'STALE_OR_MIXED_SNAPSHOT');
  }
}

function expectedPackageOrders(
  attempt: HyperliquidPackageAttempt,
  markets: ResolvedMarkets,
): readonly ExpectedOrder[] {
  const spot = attempt.plan.legs.find((leg) => leg.role === 'SPOT');
  const perpetual = attempt.plan.legs.find((leg) => leg.role === 'PERPETUAL');
  if (spot === undefined || perpetual === undefined) throw new Error('attempt legs are incomplete');
  return Object.freeze([
    Object.freeze({
      role: 'SPOT' as const,
      cloid: spot.clientOrderId.toLowerCase() as `0x${string}`,
      coin: markets.spotCoin,
      signedBaseAtoms: spot.signedBaseDeltaAtoms,
      baseDecimals: spot.baseAsset.decimals,
      sizeDecimals: spot.sizeDecimals,
      wireAsset: spot.order.a,
    }),
    Object.freeze({
      role: 'PERPETUAL' as const,
      cloid: perpetual.clientOrderId.toLowerCase() as `0x${string}`,
      coin: markets.perpetualCoin,
      signedBaseAtoms: perpetual.signedBaseDeltaAtoms,
      baseDecimals: perpetual.baseAsset.decimals,
      sizeDecimals: perpetual.sizeDecimals,
      wireAsset: perpetual.order.a,
    }),
  ]);
}

function sourceWireOrders(attempt: HyperliquidPackageAttempt):
  readonly Pick<ExpectedOrder, 'role' | 'wireAsset' | 'sizeDecimals'>[] {
  return Object.freeze(attempt.plan.legs.map((leg) => Object.freeze({
    role: leg.role,
    wireAsset: leg.order.a,
    sizeDecimals: leg.sizeDecimals,
  })));
}

function expectedRecoveryOrders(
  attempt: HyperliquidRecoveryAttempt,
  markets: ResolvedMarkets,
  plannedOrders: HyperliquidRecoveryAttempt['plan']['orders'] = attempt.plan.orders,
): readonly ExpectedOrder[] {
  const baseDecimals = attempt.sourceAttempt.plan.legs[0].baseAsset.decimals;
  const sourceLegs = new Map(attempt.sourceAttempt.plan.legs.map((leg) => [leg.role, leg]));
  return Object.freeze(plannedOrders.map((order) => Object.freeze({
    role: order.role,
    cloid: order.clientOrderId.toLowerCase() as `0x${string}`,
    coin: order.role === 'SPOT' ? markets.spotCoin : markets.perpetualCoin,
    signedBaseAtoms: order.signedBaseDeltaAtoms,
    baseDecimals,
    sizeDecimals: sourceLegs.get(order.role)!.sizeDecimals,
    wireAsset: order.order.a,
  })));
}

function validateMetadata(
  accountEvidence: CollectedAccountEvidence,
  binding: HyperliquidEvidenceMarketBinding,
  sourceOrders: readonly Pick<ExpectedOrder, 'role' | 'wireAsset' | 'sizeDecimals'>[],
  baseAsset: AssetRef,
  quoteAsset: AssetRef,
  reasons: HyperliquidEvidenceIncompleteReason[],
): ResolvedMarkets | null {
  const spotMarket = accountEvidence.spotMeta.payload.universe.find(
    (market) => market.index === binding.spotUniverseIndex,
  );
  const spotToken = accountEvidence.spotMeta.payload.tokens.find(
    (token) => token.index === binding.spotTokenIndex,
  );
  const perpMarket = accountEvidence.perpMeta.payload.universe[binding.perpetualAssetIndex];
  const feeToken = accountEvidence.spotMeta.payload.tokens.find(
    (token) => token.index === binding.quoteTokenIndex,
  );
  const spotOrder = sourceOrders.find((order) => order.role === 'SPOT');
  const perpOrder = sourceOrders.find((order) => order.role === 'PERPETUAL');
  if (spotMarket === undefined || spotToken === undefined || perpMarket === undefined || feeToken === undefined
    || spotOrder === undefined || perpOrder === undefined
    || spotMarket.tokens.length !== 2
    || spotMarket.tokens[0] !== binding.spotTokenIndex
    || spotMarket.tokens[1] !== binding.quoteTokenIndex
    || spotOrder.wireAsset !== 10_000 + binding.spotUniverseIndex
    || perpOrder.wireAsset !== binding.perpetualAssetIndex
    || spotToken.szDecimals !== spotOrder.sizeDecimals
    || perpMarket.szDecimals !== perpOrder.sizeDecimals
    || spotToken.weiDecimals !== baseAsset.decimals
    || feeToken.weiDecimals !== quoteAsset.decimals
    || normalizedAssetSymbol(feeToken.name) === null
    || normalizedAssetSymbol(feeToken.name) !== normalizedAssetSymbol(quoteAsset.assetId)) {
    addReason(reasons, 'UNKNOWN_ASSET_OR_MARKET');
    return null;
  }
  return Object.freeze({
    spotCoin: spotMarket.name,
    spotBalanceCoin: spotToken.name,
    perpetualCoin: perpMarket.name,
    feeToken: feeToken.name,
  });
}

function spotBalanceAtoms(
  evidence: CollectedAccountEvidence,
  binding: HyperliquidEvidenceMarketBinding,
  balanceCoin: string,
  baseDecimals: number,
): bigint {
  const matches = evidence.spotState.payload.balances.filter(
    (balance) => 'token' in balance
      && balance.token === binding.spotTokenIndex && balance.coin === balanceCoin,
  );
  if (matches.length > 1) throw new Error('spot balance is ambiguous');
  return matches.length === 0 ? 0n : decimalToAtoms(matches[0]!.total, baseDecimals);
}

function perpetualPositionAtoms(
  evidence: CollectedAccountEvidence,
  perpetualCoin: string,
  baseDecimals: number,
): bigint {
  const matches = evidence.perpState.payload.assetPositions.filter(
    (entry) => entry.position.coin === perpetualCoin,
  );
  if (matches.length > 1) throw new Error('perpetual position is ambiguous');
  return matches.length === 0 ? 0n : decimalToAtoms(matches[0]!.position.szi, baseDecimals);
}

function validatePerpTime(
  evidence: CollectedAccountEvidence,
  window: HyperliquidEvidenceWindow,
  reasons: HyperliquidEvidenceIncompleteReason[],
): void {
  const serverTime = evidence.perpState.payload.time;
  if (!Number.isSafeInteger(serverTime) || serverTime > window.nowMs
    || window.nowMs - serverTime > window.maxEvidenceAgeMs
    || Math.abs(serverTime - evidence.perpState.receivedAtMs) > window.maxSnapshotSkewMs) {
    addReason(reasons, 'STALE_OR_MIXED_SNAPSHOT');
  }
}

async function accountEvidence(
  client: HyperliquidTestnetReadClient,
  account: HyperliquidAccountIdentity,
): Promise<CollectedAccountEvidence> {
  const [userRole, spotMeta, perpMeta, spotState, perpState] = await Promise.all([
    client.userRole(account.tradingAccount),
    client.spotMeta(),
    client.meta(),
    client.spotClearinghouseState(account.tradingAccount),
    client.clearinghouseState(account.tradingAccount),
  ]);
  return { userRole, spotMeta, perpMeta, spotState, perpState };
}

function verifyAccountEnvelopes(
  evidence: CollectedAccountEvidence,
  account: HyperliquidAccountIdentity,
  window: HyperliquidEvidenceWindow,
  reasons: HyperliquidEvidenceIncompleteReason[],
): void {
  verifyEnvelope(evidence.userRole,
    { operation: 'userRole', user: account.tradingAccount }, window, reasons);
  verifyEnvelope(evidence.spotMeta, { operation: 'spotMeta' }, window, reasons);
  verifyEnvelope(evidence.perpMeta, { operation: 'meta' }, window, reasons);
  verifyEnvelope(evidence.spotState,
    { operation: 'spotClearinghouseState', user: account.tradingAccount }, window, reasons);
  verifyEnvelope(evidence.perpState,
    { operation: 'clearinghouseState', user: account.tradingAccount }, window, reasons);
  verifySnapshotSkew([
    evidence.userRole, evidence.spotMeta, evidence.perpMeta, evidence.spotState, evidence.perpState,
  ], window, reasons);
  validatePerpTime(evidence, window, reasons);
  const role = evidence.userRole.payload;
  if ((account.accountKind === 'MASTER' && role.role !== 'user')
    || (account.accountKind === 'SUBACCOUNT'
      && (role.role !== 'subAccount'
        || role.data.master.toLowerCase() !== account.masterAccount))) {
    addReason(reasons, 'ACCOUNT_IDENTITY_MISMATCH');
  }
}

async function collectFills(
  client: HyperliquidTestnetReadClient,
  account: HyperliquidAccountIdentity,
  window: HyperliquidEvidenceWindow,
  reasons: HyperliquidEvidenceIncompleteReason[],
): Promise<readonly HyperliquidInfoEnvelope<UserFillsByTimeResponse>[]> {
  const pages: HyperliquidInfoEnvelope<UserFillsByTimeResponse>[] = [];
  const maxPages = window.maxFillPages ?? 16;
  const fillIdentities = new Set<string>();
  let cursor = window.startTimeMs;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await client.userFillsByTime(account.tradingAccount, cursor, window.endTimeMs);
    verifyEnvelope(page, {
      operation: 'userFillsByTime', user: account.tradingAccount,
      startTimeMs: cursor, endTimeMs: window.endTimeMs,
    }, window, reasons);
    pages.push(page);
    if (page.payload.some((fill, index) => fill.time < cursor || fill.time > window.endTimeMs
      || (index > 0 && fill.time < page.payload[index - 1]!.time))) {
      addReason(reasons, 'INCOMPLETE_PAGINATION');
      return Object.freeze(pages);
    }
    const priorCount = fillIdentities.size;
    page.payload.forEach((fill) => fillIdentities.add(fillKey(fill)));
    if (fillIdentities.size >= 10_000) {
      addReason(reasons, 'INCOMPLETE_PAGINATION');
      return Object.freeze(pages);
    }
    if (page.payload.length < 2_000) return Object.freeze(pages);
    const latestTime = Math.max(...page.payload.map((fill) => fill.time));
    if (!Number.isSafeInteger(latestTime) || latestTime < cursor || latestTime > window.endTimeMs
      || fillIdentities.size === priorCount) {
      addReason(reasons, 'INCOMPLETE_PAGINATION');
      return Object.freeze(pages);
    }
    const boundary = await client.userFillsByTime(
      account.tradingAccount, latestTime, latestTime,
    );
    verifyEnvelope(boundary, {
      operation: 'userFillsByTime', user: account.tradingAccount,
      startTimeMs: latestTime, endTimeMs: latestTime,
    }, window, reasons);
    pages.push(boundary);
    if (boundary.payload.length >= 2_000
      || boundary.payload.some((fill) => fill.time !== latestTime)) {
      addReason(reasons, 'INCOMPLETE_PAGINATION');
      return Object.freeze(pages);
    }
    const boundaryKeys = new Set(boundary.payload.map(fillKey));
    if (page.payload.filter((fill) => fill.time === latestTime)
      .some((fill) => !boundaryKeys.has(fillKey(fill)))) {
      addReason(reasons, 'INCOMPLETE_PAGINATION');
      return Object.freeze(pages);
    }
    boundary.payload.forEach((fill) => fillIdentities.add(fillKey(fill)));
    if (fillIdentities.size >= 10_000) {
      addReason(reasons, 'INCOMPLETE_PAGINATION');
      return Object.freeze(pages);
    }
    if (latestTime === window.endTimeMs) return Object.freeze(pages);
    cursor = latestTime + 1;
  }
  addReason(reasons, 'INCOMPLETE_PAGINATION');
  return Object.freeze(pages);
}

async function orderEvidence(
  client: HyperliquidTestnetReadClient,
  account: HyperliquidAccountIdentity,
  orders: readonly ExpectedOrder[],
  window: HyperliquidEvidenceWindow,
  reasons: HyperliquidEvidenceIncompleteReason[],
): Promise<CollectedOrders> {
  const [openOrders, statuses, fills] = await Promise.all([
    client.openOrders(account.tradingAccount),
    Promise.all(orders.map((order) => client.orderStatus(account.tradingAccount, order.cloid))),
    collectFills(client, account, window, reasons),
  ]);
  verifyEnvelope(openOrders, { operation: 'openOrders', user: account.tradingAccount }, window, reasons);
  statuses.forEach((status, index) => verifyEnvelope(status, {
    operation: 'orderStatus', user: account.tradingAccount, cloid: orders[index]!.cloid,
  }, window, reasons));
  return { openOrders, statuses, fills };
}

function fillKey(fill: UserFillsByTimeResponse[number]): string {
  return `${fill.coin}:${fill.oid}:${fill.tid}:${fill.hash.toLowerCase()}`;
}

function deduplicatedFills(
  pages: readonly HyperliquidInfoEnvelope<UserFillsByTimeResponse>[],
  reasons: HyperliquidEvidenceIncompleteReason[],
): readonly UserFillsByTimeResponse[number][] {
  const fills = new Map<string, UserFillsByTimeResponse[number]>();
  for (const fill of pages.flatMap((page) => page.payload)) {
    const key = fillKey(fill);
    const prior = fills.get(key);
    if (prior !== undefined
      && JSON.stringify(stableValue(prior)) !== JSON.stringify(stableValue(fill))) {
      addReason(reasons, 'CONFLICTING_DUPLICATE_FILL');
    } else {
      fills.set(key, fill);
    }
  }
  return Object.freeze([...fills.values()]);
}

function terminalStatus(
  status: OrderStatusResponse,
  openMatches: number,
  filledSignedBaseAtoms: bigint,
): Pick<HyperliquidLegReconciliationInput, 'terminalStatus' | 'openOrderStatus'> {
  if (openMatches > 0) return { terminalStatus: 'UNKNOWN', openOrderStatus: 'OPEN' };
  if (status.status === 'unknownOid') return { terminalStatus: 'UNKNOWN', openOrderStatus: 'UNKNOWN' };
  if (status.order.status === 'open' || status.order.status === 'triggered') {
    return { terminalStatus: 'UNKNOWN', openOrderStatus: 'UNKNOWN' };
  }
  if (status.order.status === 'filled') return { terminalStatus: 'FILLED', openOrderStatus: 'NONE' };
  if (!TERMINAL_STATUSES.has(status.order.status)) {
    return { terminalStatus: 'UNKNOWN', openOrderStatus: 'UNKNOWN' };
  }
  if (status.order.status.endsWith('Rejected') || status.order.status === 'rejected') {
    return filledSignedBaseAtoms === 0n
      ? { terminalStatus: 'REJECTED', openOrderStatus: 'NONE' }
      : { terminalStatus: 'PARTIALLY_FILLED_IOC_CANCELLED', openOrderStatus: 'NONE' };
  }
  return filledSignedBaseAtoms === 0n
    ? { terminalStatus: 'UNFILLED_IOC_CANCELLED', openOrderStatus: 'NONE' }
    : { terminalStatus: 'PARTIALLY_FILLED_IOC_CANCELLED', openOrderStatus: 'NONE' };
}

// HyperCore charges a spot buy's taker fee in the received base token and every other fill's fee
// in the quote token. A base-token fee is reported as a base-asset fee at the token's full precision,
// so the account's spot balance delta equals the spot fill less that fee exactly.
function reduceOrders(
  orders: readonly ExpectedOrder[],
  evidence: CollectedOrders,
  feeAsset: AssetRef,
  feeToken: string,
  baseAsset: AssetRef,
  baseFeeToken: string,
  window: HyperliquidEvidenceWindow,
  reasons: HyperliquidEvidenceIncompleteReason[],
): Readonly<{
  orderInputs: readonly HyperliquidLegReconciliationInput[];
  fees: readonly HyperliquidFeeObservationInput[];
  observedFills: readonly HyperliquidObservedFill[];
}> {
  const cloids = orders.map((order) => order.cloid);
  if (new Set(cloids).size !== cloids.length || cloids.some((cloid) => !CLOID_PATTERN.test(cloid))) {
    addReason(reasons, 'AMBIGUOUS_CLOID');
  }
  const allFills = deduplicatedFills(evidence.fills, reasons);
  const inputs: HyperliquidLegReconciliationInput[] = [];
  const observed: HyperliquidObservedFill[] = [];
  let feeAtoms = 0n;
  let baseFeeAtoms = 0n;
  let baseFeeObserved = false;
  const orderIds = new Set<number>();
  orders.forEach((order) => {
    const matchingStatuses = evidence.statuses.filter(
      (status) => status.request.cloid === order.cloid,
    );
    if (matchingStatuses.length !== 1) addReason(reasons, 'AMBIGUOUS_CLOID');
    const response = matchingStatuses[0]?.payload ?? { status: 'unknownOid' as const };
    if (response.status === 'order') {
      const statusOrder = response.order.order;
      if (statusOrder.cloid?.toLowerCase() !== order.cloid || statusOrder.coin !== order.coin
        || orderIds.has(statusOrder.oid)
        || statusOrder.timestamp < window.startTimeMs || statusOrder.timestamp > window.endTimeMs) {
        addReason(reasons, 'AMBIGUOUS_CLOID');
      }
      orderIds.add(statusOrder.oid);
      const openMatches = evidence.openOrders.payload.filter(
        (openOrder) => openOrder.cloid?.toLowerCase() === order.cloid,
      );
      if (openMatches.length > 1 || openMatches.some(
        (openOrder) => openOrder.oid !== statusOrder.oid || openOrder.coin !== order.coin,
      )) addReason(reasons, 'AMBIGUOUS_CLOID');
      const matchedFills = allFills.filter((fill) => fill.oid === statusOrder.oid);
      let filledSignedBaseAtoms = 0n;
      try {
        if (decimalToAtoms(statusOrder.origSz, order.baseDecimals) !== absolute(order.signedBaseAtoms)
          || statusOrder.side !== (order.signedBaseAtoms > 0n ? 'B' : 'A')) {
          addReason(reasons, 'MALFORMED_RESPONSE');
        }
      } catch {
        addReason(reasons, 'MALFORMED_RESPONSE');
      }
      for (const fill of matchedFills) {
        const baseFee = order.role === 'SPOT' && fill.side === 'B' && fill.feeToken === baseFeeToken;
        const knownFeeToken = fill.feeToken === feeToken || baseFee;
        if (fill.coin !== order.coin
          || (fill.cloid !== undefined && fill.cloid.toLowerCase() !== order.cloid)
          || !knownFeeToken
          || fill.time < window.startTimeMs || fill.time > window.endTimeMs) {
          addReason(reasons, !knownFeeToken
            ? 'UNCERTAIN_FEE_EVIDENCE' : 'AMBIGUOUS_CLOID');
          continue;
        }
        let signedSize: bigint;
        let price: HyperliquidDecimalRatio;
        try {
          const size = decimalToAtoms(fill.sz, order.baseDecimals);
          signedSize = fill.side === 'B' ? size : -size;
          price = decimalRatio(fill.px);
        } catch {
          addReason(reasons, 'MALFORMED_RESPONSE');
          continue;
        }
        if ((signedSize > 0n) !== (order.signedBaseAtoms > 0n)) {
          addReason(reasons, 'MALFORMED_RESPONSE');
        }
        let fillFeeAtoms: bigint;
        try {
          fillFeeAtoms = decimalToAtoms(fill.fee, baseFee ? baseAsset.decimals : feeAsset.decimals);
        } catch {
          addReason(reasons, 'UNCERTAIN_FEE_EVIDENCE');
          continue;
        }
        filledSignedBaseAtoms += signedSize;
        if (baseFee) {
          baseFeeAtoms += fillFeeAtoms;
          baseFeeObserved = true;
        } else {
          feeAtoms += fillFeeAtoms;
        }
        observed.push(Object.freeze({
          clientOrderId: order.cloid,
          orderId: fill.oid,
          transactionId: fill.tid,
          coin: fill.coin,
          signedBaseAtoms: signedSize,
          price,
          feeToken: fill.feeToken,
          feeAtoms: fillFeeAtoms,
          observedAtMs: fill.time,
        }));
      }
      if ((filledSignedBaseAtoms > 0n) !== (order.signedBaseAtoms > 0n)
        && filledSignedBaseAtoms !== 0n) {
        addReason(reasons, 'MALFORMED_RESPONSE');
      }
      if (absolute(filledSignedBaseAtoms) > absolute(order.signedBaseAtoms)
        || (response.order.status === 'filled'
          && filledSignedBaseAtoms !== order.signedBaseAtoms)) {
        addReason(reasons, 'INCOMPLETE_PAGINATION');
      }
      const terminal = terminalStatus(response, openMatches.length, filledSignedBaseAtoms);
      inputs.push(Object.freeze({
        clientOrderId: order.cloid,
        ...terminal,
        filledSignedBaseAtoms,
      }));
    } else {
      const openMatches = evidence.openOrders.payload.filter(
        (openOrder) => openOrder.cloid?.toLowerCase() === order.cloid,
      ).length;
      if (openMatches > 1) addReason(reasons, 'AMBIGUOUS_CLOID');
      inputs.push(Object.freeze({
        clientOrderId: order.cloid,
        terminalStatus: 'UNKNOWN',
        openOrderStatus: openMatches > 0 ? 'OPEN' : 'UNKNOWN',
        filledSignedBaseAtoms: 0n,
      }));
    }
  });
  return Object.freeze({
    orderInputs: Object.freeze(inputs),
    fees: Object.freeze([
      Object.freeze({
        assetId: feeAsset.assetId,
        assetDecimals: feeAsset.decimals,
        amountAtoms: feeAtoms,
        evidenceStatus: 'CONFIRMED' as const,
      }),
      ...(baseFeeObserved ? [Object.freeze({
        assetId: baseAsset.assetId,
        assetDecimals: baseAsset.decimals,
        amountAtoms: baseFeeAtoms,
        evidenceStatus: 'CONFIRMED' as const,
      })] : []),
    ]),
    observedFills: Object.freeze(observed),
  });
}

function allEnvelopes(account: CollectedAccountEvidence, orders?: CollectedOrders):
  readonly HyperliquidInfoEnvelope<unknown>[] {
  const base: HyperliquidInfoEnvelope<unknown>[] = [
    account.userRole, account.spotMeta, account.perpMeta, account.spotState, account.perpState,
  ];
  if (orders !== undefined) base.push(orders.openOrders, ...orders.statuses, ...orders.fills);
  return base;
}

function incomplete<T>(
  reasons: readonly HyperliquidEvidenceIncompleteReason[],
  fills: readonly HyperliquidObservedFill[],
  envelopes: readonly HyperliquidInfoEnvelope<unknown>[],
  accountObservation: HyperliquidCollectedStateObservation | null = null,
): HyperliquidEvidenceResult<T> {
  return Object.freeze({
    status: 'INCOMPLETE',
    input: null,
    accountObservation,
    reasons: Object.freeze([...new Set(reasons)]),
    observedFills: Object.freeze([...fills]),
    rawResponseCommitments: Object.freeze(envelopes.map(rawCommitment)),
  });
}

export class HyperliquidAuthoritativeEvidenceCollector {
  readonly #client: HyperliquidTestnetReadClient;

  constructor(client: HyperliquidTestnetReadClient) {
    if (client.environment !== 'testnet' || client.apiUrl !== HYPERLIQUID_TESTNET_INFO_URL) {
      throw new Error('read client must be pinned to the exact Hyperliquid testnet Info URL');
    }
    this.#client = client;
  }

  async captureCheckpoint(
    attempt: HyperliquidPackageAttempt,
    binding: HyperliquidEvidenceMarketBinding,
    window: HyperliquidEvidenceWindow,
  ): Promise<HyperliquidCheckpointResult> {
    validateWindow(window);
    const reasons: HyperliquidEvidenceIncompleteReason[] = [];
    let evidence: CollectedAccountEvidence;
    try {
      evidence = await accountEvidence(this.#client, normalizedAccount(attempt.account));
    } catch {
      const readFailed: readonly HyperliquidEvidenceIncompleteReason[] = ['READ_FAILED'];
      return Object.freeze({
        status: 'INCOMPLETE', checkpoint: null, reasons: readFailed,
        rawResponseCommitments: Object.freeze([]),
      });
    }
    const account = normalizedAccount(attempt.account);
    verifyAccountEnvelopes(evidence, account, window, reasons);
    const markets = validateMetadata(evidence, binding, sourceWireOrders(attempt),
      attempt.plan.legs[0].baseAsset,
      attempt.plan.legs[0].quoteAsset, reasons);
    let spotBalance = 0n;
    let perpPosition = 0n;
    try {
      if (markets === null) throw new Error('markets are unresolved');
      spotBalance = spotBalanceAtoms(
        evidence, binding, markets.spotBalanceCoin, attempt.plan.legs[0].baseAsset.decimals,
      );
      perpPosition = perpetualPositionAtoms(
        evidence, markets.perpetualCoin, attempt.plan.legs[0].baseAsset.decimals,
      );
      if (perpPosition !== attempt.plan.prePerpetualPositionAtoms) {
        addReason(reasons, 'CHECKPOINT_MISMATCH');
      }
    } catch {
      addReason(reasons, 'MALFORMED_RESPONSE');
    }
    const envelopes = allEnvelopes(evidence);
    if (reasons.length > 0) {
      return Object.freeze({
        status: 'INCOMPLETE', checkpoint: null, reasons: Object.freeze(reasons),
        rawResponseCommitments: Object.freeze(envelopes.map(rawCommitment)),
      });
    }
    return Object.freeze({
      status: 'COMPLETE',
      checkpoint: Object.freeze({
        version: 1,
        attemptCommitment: attemptCommitment(attempt, binding),
        account,
        baseSpotBalanceAtoms: spotBalance,
        perpetualPositionAtoms: perpPosition,
        observedAtMs: Math.max(...envelopes.map((value) => value.receivedAtMs)),
        rawResponseCommitments: Object.freeze(envelopes.map(rawCommitment)),
      }),
    });
  }

  async collectPackage(
    attempt: HyperliquidPackageAttempt,
    checkpoint: HyperliquidEvidenceCheckpoint,
    binding: HyperliquidEvidenceMarketBinding,
    window: HyperliquidEvidenceWindow,
  ): Promise<HyperliquidEvidenceResult<HyperliquidReconciliationSnapshotInput>> {
    validateWindow(window);
    const reasons: HyperliquidEvidenceIncompleteReason[] = [];
    verifyFillWindowFresh(window, reasons);
    const account = normalizedAccount(attempt.account);
    if (checkpoint.attemptCommitment !== attemptCommitment(attempt, binding)
      || checkpoint.account.masterAccount !== account.masterAccount
      || checkpoint.account.tradingAccount !== account.tradingAccount
      || checkpoint.account.accountKind !== account.accountKind
      || checkpoint.observedAtMs !== window.startTimeMs) {
      addReason(reasons, 'CHECKPOINT_MISMATCH');
    }
    let accountData: CollectedAccountEvidence;
    try {
      accountData = await accountEvidence(this.#client, account);
    } catch {
      return incomplete(reasons.length > 0 ? reasons : ['READ_FAILED'], [], []);
    }
    verifyAccountEnvelopes(accountData, account, window, reasons);
    const markets = validateMetadata(accountData, binding, sourceWireOrders(attempt),
      attempt.plan.legs[0].baseAsset,
      attempt.plan.legs[0].quoteAsset, reasons);
    if (markets === null) return incomplete(reasons, [], allEnvelopes(accountData));
    const orders = expectedPackageOrders(attempt, markets);
    let orderData: CollectedOrders;
    try {
      orderData = await orderEvidence(this.#client, account, orders, window, reasons);
    } catch {
      return incomplete(reasons.length > 0 ? reasons : ['READ_FAILED'], [], allEnvelopes(accountData));
    }
    const envelopes = allEnvelopes(accountData, orderData);
    verifySnapshotSkew(envelopes, window, reasons);
    const reduced = reduceOrders(
      orders, orderData, attempt.plan.legs[0].quoteAsset, markets.feeToken,
      attempt.plan.legs[0].baseAsset, markets.spotBalanceCoin, window, reasons,
    );
    let spotBalance = 0n;
    let perpPosition = 0n;
    try {
      spotBalance = spotBalanceAtoms(
        accountData, binding, markets.spotBalanceCoin, attempt.plan.legs[0].baseAsset.decimals,
      );
      perpPosition = perpetualPositionAtoms(
        accountData, markets.perpetualCoin, attempt.plan.legs[0].baseAsset.decimals,
      );
    } catch {
      addReason(reasons, 'MALFORMED_RESPONSE');
    }
    if (reasons.length > 0) return incomplete(reasons, reduced.observedFills, envelopes);
    const observedAtMs = Math.max(...envelopes.map((value) => value.receivedAtMs));
    const input: HyperliquidReconciliationSnapshotInput = Object.freeze({
      source: HYPERCORE_RECONCILIATION_SOURCE,
      domain: attempt.plan.domain,
      commitments: attempt.plan.commitments,
      account,
      evidenceVersion: BigInt(observedAtMs),
      observedAtMs: BigInt(observedAtMs),
      spot: reduced.orderInputs.find((order) => order.clientOrderId === orders[0]!.cloid)!,
      perpetual: reduced.orderInputs.find((order) => order.clientOrderId === orders[1]!.cloid)!,
      netSpotDeltaAtoms: spotBalance - checkpoint.baseSpotBalanceAtoms,
      perpetualPositionDeltaAtoms: perpPosition - checkpoint.perpetualPositionAtoms,
      observedPerpetualPositionAtoms: perpPosition,
      perpetualPositionTargetAtoms: attempt.plan.perpetualPositionTargetAtoms,
      feeEvidenceComplete: true,
      fees: reduced.fees,
    });
    const accountObservation: HyperliquidCollectedStateObservation = Object.freeze({
      orders: reduced.orderInputs,
      netSpotBalanceDeltaAtoms: spotBalance - checkpoint.baseSpotBalanceAtoms,
      perpetualPositionDeltaAtoms: perpPosition - checkpoint.perpetualPositionAtoms,
      observedPerpetualPositionAtoms: perpPosition,
      fees: Object.freeze(reduced.fees.map((fee) => Object.freeze({
        asset: fee.assetId === attempt.plan.legs[0].baseAsset.assetId
          ? attempt.plan.legs[0].baseAsset : attempt.plan.legs[0].quoteAsset,
        amountAtoms: fee.amountAtoms,
        evidenceStatus: fee.evidenceStatus,
      }))),
    });
    return Object.freeze({
      status: 'COMPLETE', input, accountObservation,
      observedFills: reduced.observedFills,
      rawResponseCommitments: Object.freeze(envelopes.map(rawCommitment)),
    });
  }

  async collectRecovery(
    attempt: HyperliquidRecoveryAttempt,
    checkpoint: HyperliquidEvidenceCheckpoint,
    binding: HyperliquidEvidenceMarketBinding,
    window: HyperliquidEvidenceWindow,
  ): Promise<HyperliquidEvidenceResult<HyperliquidRecoveryReconciliationSnapshotInput>> {
    validateWindow(window);
    const reasons: HyperliquidEvidenceIncompleteReason[] = [];
    verifyFillWindowFresh(window, reasons);
    const account = normalizedAccount(attempt.plan.account);
    if (checkpoint.attemptCommitment !== attemptCommitment(attempt.sourceAttempt, binding)
      || checkpoint.account.masterAccount !== account.masterAccount
      || checkpoint.account.tradingAccount !== account.tradingAccount
      || checkpoint.account.accountKind !== account.accountKind
      || checkpoint.observedAtMs !== window.startTimeMs) {
      addReason(reasons, 'CHECKPOINT_MISMATCH');
    }
    let accountData: CollectedAccountEvidence;
    try {
      accountData = await accountEvidence(this.#client, account);
    } catch {
      return incomplete(reasons.length > 0 ? reasons : ['READ_FAILED'], [], []);
    }
    verifyAccountEnvelopes(accountData, account, window, reasons);
    const markets = validateMetadata(accountData, binding, sourceWireOrders(attempt.sourceAttempt),
      attempt.sourceAttempt.plan.legs[0].baseAsset,
      attempt.sourceAttempt.plan.legs[0].quoteAsset, reasons);
    if (markets === null) return incomplete(reasons, [], allEnvelopes(accountData));
    const sourceOrders = expectedPackageOrders(attempt.sourceAttempt, markets);
    const priorRecoveryOrders = expectedRecoveryOrders(
      attempt,
      markets,
      attempt.plan.baseline.priorRecoveryOrders,
    );
    const recoveryOrders = expectedRecoveryOrders(attempt, markets);
    const allRecoveryOrders = Object.freeze([...priorRecoveryOrders, ...recoveryOrders]);
    const orders = Object.freeze([...sourceOrders, ...allRecoveryOrders]);
    if (new Set(orders.map((order) => order.cloid)).size !== orders.length) {
      addReason(reasons, 'AMBIGUOUS_CLOID');
    }
    if (allRecoveryOrders.some((order) => order.wireAsset !== (order.role === 'SPOT'
      ? 10_000 + binding.spotUniverseIndex : binding.perpetualAssetIndex))) {
      addReason(reasons, 'UNKNOWN_ASSET_OR_MARKET');
    }
    let orderData: CollectedOrders;
    try {
      orderData = await orderEvidence(this.#client, account, orders, window, reasons);
    } catch {
      return incomplete(reasons.length > 0 ? reasons : ['READ_FAILED'], [], allEnvelopes(accountData));
    }
    const envelopes = allEnvelopes(accountData, orderData);
    verifySnapshotSkew(envelopes, window, reasons);
    const reducedSource = reduceOrders(
      sourceOrders, orderData, attempt.sourceAttempt.plan.legs[0].quoteAsset,
      markets.feeToken, attempt.sourceAttempt.plan.legs[0].baseAsset, markets.spotBalanceCoin,
      window, reasons,
    );
    const reducedAllRecovery = reduceOrders(
      allRecoveryOrders, orderData, attempt.sourceAttempt.plan.legs[0].quoteAsset,
      markets.feeToken, attempt.sourceAttempt.plan.legs[0].baseAsset, markets.spotBalanceCoin,
      window, reasons,
    );
    const reducedRecovery = reduceOrders(
      recoveryOrders, orderData, attempt.sourceAttempt.plan.legs[0].quoteAsset,
      markets.feeToken, attempt.sourceAttempt.plan.legs[0].baseAsset, markets.spotBalanceCoin,
      window, reasons,
    );
    let spotBalance = 0n;
    let perpPosition = 0n;
    try {
      spotBalance = spotBalanceAtoms(accountData, binding, markets.spotBalanceCoin,
        attempt.sourceAttempt.plan.legs[0].baseAsset.decimals);
      perpPosition = perpetualPositionAtoms(
        accountData, markets.perpetualCoin,
        attempt.sourceAttempt.plan.legs[0].baseAsset.decimals,
      );
    } catch {
      addReason(reasons, 'MALFORMED_RESPONSE');
    }
    let aggregateLoss = 0n;
    try {
      aggregateLoss = hyperliquidRecoveryAggregateLossQuoteAtoms({
        attempt,
        sourceOrders: reducedSource.orderInputs,
        recoveryOrders: reducedAllRecovery.orderInputs,
        sourceFills: reducedSource.observedFills,
        recoveryFills: reducedAllRecovery.observedFills,
      });
    } catch {
      addReason(reasons, 'AGGREGATE_RECOVERY_LOSS_UNAVAILABLE');
    }
    const sourceEvidence = attempt.sourceAttempt.acceptedEvidence;
    if (sourceEvidence === null) addReason(reasons, 'AGGREGATE_RECOVERY_LOSS_UNAVAILABLE');
    const recoveryFees = Object.freeze(reducedRecovery.fees.map((fee) => Object.freeze({
      asset: fee.assetId === attempt.sourceAttempt.plan.legs[0].baseAsset.assetId
        ? attempt.sourceAttempt.plan.legs[0].baseAsset : attempt.sourceAttempt.plan.legs[0].quoteAsset,
      amountAtoms: fee.amountAtoms,
      evidenceStatus: fee.evidenceStatus,
    })));
    const accountObservation: HyperliquidCollectedStateObservation = Object.freeze({
      orders: reducedRecovery.orderInputs,
      netSpotBalanceDeltaAtoms: spotBalance - checkpoint.baseSpotBalanceAtoms,
      perpetualPositionDeltaAtoms: perpPosition - checkpoint.perpetualPositionAtoms,
      observedPerpetualPositionAtoms: perpPosition,
      fees: recoveryFees,
    });
    const observedFills = Object.freeze([
      ...reducedSource.observedFills,
      ...reducedAllRecovery.observedFills,
    ]);
    if (reasons.length > 0 || sourceEvidence === null) {
      return incomplete(reasons, observedFills, envelopes, accountObservation);
    }
    const observedAtMs = Math.max(...envelopes.map((value) => value.receivedAtMs));
    const recoveryPolicy = attempt.sourceAttempt.plan.recoveryPolicy;
    const actualRecoveryCosts = Object.freeze(recoveryPolicy.maxRecoveryCostCaps.map((cap, index) => {
      const baseline = attempt.plan.baseline.cumulativeRecoveryCosts[index];
      const amountAtoms = recoveryFees.filter((fee) => sameAsset(fee.asset, cap.asset))
        .reduce((total, fee) => total + fee.amountAtoms, 0n);
      return Object.freeze({
        asset: cap.asset,
        amountAtoms: (baseline?.atoms ?? 0n) + (amountAtoms > 0n ? amountAtoms : 0n),
        evidenceStatus: 'CONFIRMED' as const,
      });
    }));
    const input: HyperliquidRecoveryReconciliationSnapshotInput = Object.freeze({
      source: HYPERCORE_RECOVERY_RECONCILIATION_SOURCE,
      domain: attempt.plan.domain,
      commitments: attempt.plan.commitments,
      account,
      reconciledStateSchemaHash: attempt.plan.reconciledStateSchemaHash,
      sourceEvidenceVersion: attempt.plan.sourceEvidenceVersion,
      recoverySequence: attempt.plan.recoverySequence,
      evidenceVersion: BigInt(observedAtMs),
      observedAtMs: BigInt(observedAtMs),
      recoveryOrders: reducedRecovery.orderInputs,
      netSpotBalanceDeltaAtoms: spotBalance - checkpoint.baseSpotBalanceAtoms,
      perpetualPositionDeltaAtoms: perpPosition - checkpoint.perpetualPositionAtoms,
      observedPerpetualPositionAtoms: perpPosition,
      perpetualPositionTargetAtoms: attempt.plan.mode === 'PAIRED_ROLLBACK'
        ? attempt.sourceAttempt.plan.prePerpetualPositionAtoms
        : attempt.sourceAttempt.plan.perpetualPositionTargetAtoms,
      costEvidenceComplete: true,
      fees: recoveryFees,
      actualRecoveryCosts,
      actualAggregateLoss: Object.freeze({
        asset: recoveryPolicy.maxAggregateRecoveryLoss.asset,
        amountAtoms: aggregateLoss,
        evidenceStatus: 'CONFIRMED' as const,
      }),
    });
    return Object.freeze({
      status: 'COMPLETE' as const,
      input,
      accountObservation,
      observedFills,
      rawResponseCommitments: Object.freeze(envelopes.map(rawCommitment)),
    });
  }
}
