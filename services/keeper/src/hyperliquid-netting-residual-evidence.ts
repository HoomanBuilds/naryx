import { createHash } from 'node:crypto';
import type {
  OpenOrdersResponse,
  OrderStatusResponse,
  UserFillsByTimeResponse,
  UserRoleResponse,
} from '@nktkas/hyperliquid/api/info';
import {
  decimalToAtoms,
  type HyperliquidNettingResidualObservation,
  type HyperliquidNettingResidualPlan,
} from '@naryx/adapter-hyperliquid';
import type { CommitmentHash } from '@naryx/protocol-types';
import {
  HYPERLIQUID_TESTNET_INFO_URL,
  type HyperliquidInfoEnvelope,
  type HyperliquidRawResponseCommitment,
  type HyperliquidTestnetReadClient,
} from './hyperliquid-evidence-collector.js';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const CLOID = /^0x[0-9a-f]{32}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const ACTION_COMMITMENT_SCHEME = 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1';
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

export interface HyperliquidNettingResidualEvidenceAccount {
  readonly masterAccount: `0x${string}`;
  readonly tradingAccount: `0x${string}`;
  readonly accountKind: 'MASTER' | 'SUBACCOUNT';
}

export interface HyperliquidNettingResidualEvidenceWindow {
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly nowMs: number;
  readonly maxEvidenceAgeMs: number;
  readonly maxSnapshotSkewMs: number;
  readonly maxFillPages?: number;
}

export interface HyperliquidNettingResidualEvidenceBinding {
  readonly assetId: number;
  readonly marketKind: 'SPOT' | 'PERPETUAL';
  readonly baseFeeToken: string;
  readonly quoteFeeToken: string;
}

export interface HyperliquidNettingResidualEvidenceRequest {
  readonly attemptId: string;
  readonly account: HyperliquidNettingResidualEvidenceAccount;
  readonly actionHash: `0x${string}`;
  readonly requestCommitment: `0x${string}`;
  readonly durableRevision: string;
  readonly clientOrderId: `0x${string}`;
  readonly intentHash: CommitmentHash;
  readonly instrumentHash: CommitmentHash;
  readonly plan: HyperliquidNettingResidualPlan;
  readonly binding: HyperliquidNettingResidualEvidenceBinding;
  readonly window: HyperliquidNettingResidualEvidenceWindow;
}

export type HyperliquidNettingResidualEvidenceIncompleteReason =
  | 'READ_FAILED'
  | 'ENVIRONMENT_MISMATCH'
  | 'REQUEST_IDENTITY_MISMATCH'
  | 'ACCOUNT_IDENTITY_MISMATCH'
  | 'AMBIGUOUS_CLOID'
  | 'CONFLICTING_DUPLICATE_FILL'
  | 'INCOMPLETE_PAGINATION'
  | 'STALE_OR_MIXED_SNAPSHOT'
  | 'UNCERTAIN_FEE_EVIDENCE'
  | 'MALFORMED_RESPONSE';

export type HyperliquidNettingResidualEvidenceResult = Readonly<{
  status: 'COMPLETE';
  observation: HyperliquidNettingResidualObservation;
  rawResponseCommitments: readonly HyperliquidRawResponseCommitment[];
}> | Readonly<{
  status: 'INCOMPLETE';
  observation: null;
  reasons: readonly HyperliquidNettingResidualEvidenceIncompleteReason[];
  rawResponseCommitments: readonly HyperliquidRawResponseCommitment[];
}>;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

function commitment(value: unknown): `0x${string}` {
  return `0x${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function rawCommitment(envelope: HyperliquidInfoEnvelope<unknown>): HyperliquidRawResponseCommitment {
  return Object.freeze({
    operation: envelope.request.operation,
    request: envelope.request,
    requestedAtMs: envelope.requestedAtMs,
    receivedAtMs: envelope.receivedAtMs,
    sha256: commitment(envelope.payload),
  });
}

function actionCommitment(plan: HyperliquidNettingResidualPlan): `0x${string}` {
  const order = plan.order;
  return commitment([
    ACTION_COMMITMENT_SCHEME,
    'order',
    [[order.a, order.b, order.p, order.s, order.r, order.t.limit.tif, order.c]],
    'na',
  ]);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameOrder(
  left: HyperliquidNettingResidualPlan['order'],
  right: HyperliquidNettingResidualPlan['order'],
): boolean {
  return JSON.stringify([
    left.a, left.b, left.p, left.s, left.r, left.t.limit.tif, left.c.toLowerCase(),
  ]) === JSON.stringify([
    right.a, right.b, right.p, right.s, right.r, right.t.limit.tif, right.c.toLowerCase(),
  ]);
}

function normalizedAccount(
  input: HyperliquidNettingResidualEvidenceAccount,
): HyperliquidNettingResidualEvidenceAccount {
  const masterAccount = input.masterAccount.toLowerCase();
  const tradingAccount = input.tradingAccount.toLowerCase();
  requireCondition(ADDRESS.test(masterAccount) && ADDRESS.test(tradingAccount),
    'account addresses are invalid');
  requireCondition(input.accountKind === 'MASTER' || input.accountKind === 'SUBACCOUNT',
    'account kind is invalid');
  requireCondition(input.accountKind === 'MASTER'
    ? masterAccount === tradingAccount
    : masterAccount !== tradingAccount, 'account relation is invalid');
  return Object.freeze({
    masterAccount: masterAccount as `0x${string}`,
    tradingAccount: tradingAccount as `0x${string}`,
    accountKind: input.accountKind,
  });
}

function validateWindow(window: HyperliquidNettingResidualEvidenceWindow): void {
  for (const value of [window.startTimeMs, window.endTimeMs, window.nowMs,
    window.maxEvidenceAgeMs, window.maxSnapshotSkewMs]) {
    requireCondition(Number.isSafeInteger(value) && value >= 0, 'evidence window values are invalid');
  }
  requireCondition(window.startTimeMs <= window.endTimeMs && window.endTimeMs <= window.nowMs
    && window.nowMs - window.startTimeMs <= window.maxEvidenceAgeMs,
  'evidence window is stale or inverted');
  if (window.maxFillPages !== undefined) {
    requireCondition(Number.isSafeInteger(window.maxFillPages)
      && window.maxFillPages > 0 && window.maxFillPages <= 64, 'fill page limit is invalid');
  }
}

function validateRequest(input: HyperliquidNettingResidualEvidenceRequest): void {
  const { plan, binding } = input;
  requireCondition(IDENTIFIER.test(input.attemptId) && HASH.test(input.actionHash)
    && HASH.test(input.requestCommitment) && IDENTIFIER.test(input.durableRevision)
    && CLOID.test(input.clientOrderId.toLowerCase()), 'residual evidence identity is invalid');
  requireCondition(plan.version === 1 && plan.guarantee === 'SINGLE_IOC_WITH_TERMINAL_EVIDENCE'
    && plan.domain.domainId === 'hypercore:testnet'
    && plan.action.orders.length === 1 && sameOrder(plan.action.orders[0]!, plan.order),
  'residual evidence plan is unsupported');
  requireCondition(input.clientOrderId.toLowerCase() === plan.clientOrderId.toLowerCase()
    && input.clientOrderId.toLowerCase() === plan.order.c.toLowerCase()
    && bytesEqual(input.intentHash, plan.intentHash)
    && bytesEqual(input.instrumentHash, plan.instrumentHash)
    && actionCommitment(plan) === input.actionHash,
  'residual evidence handoff differs from the compiled plan');
  requireCondition(Number.isSafeInteger(binding.assetId) && binding.assetId >= 0
    && binding.assetId <= 0xffff_ffff && binding.assetId === plan.order.a,
  'residual evidence asset binding is invalid');
  requireCondition(binding.marketKind === 'SPOT' || binding.marketKind === 'PERPETUAL',
    'residual market kind is invalid');
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(binding.baseFeeToken)
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(binding.quoteFeeToken)
    && binding.baseFeeToken !== binding.quoteFeeToken, 'residual fee-token binding is invalid');
}

function addReason(
  reasons: HyperliquidNettingResidualEvidenceIncompleteReason[],
  reason: HyperliquidNettingResidualEvidenceIncompleteReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function sameRequest(
  actual: HyperliquidInfoEnvelope<unknown>['request'],
  expected: HyperliquidInfoEnvelope<unknown>['request'],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function verifyEnvelope(
  envelope: HyperliquidInfoEnvelope<unknown>,
  expectedRequest: HyperliquidInfoEnvelope<unknown>['request'],
  window: HyperliquidNettingResidualEvidenceWindow,
  reasons: HyperliquidNettingResidualEvidenceIncompleteReason[],
): void {
  if (envelope.environment !== 'testnet' || envelope.apiUrl !== HYPERLIQUID_TESTNET_INFO_URL) {
    addReason(reasons, 'ENVIRONMENT_MISMATCH');
  }
  if (!sameRequest(envelope.request, expectedRequest)) addReason(reasons, 'REQUEST_IDENTITY_MISMATCH');
  if (!Number.isSafeInteger(envelope.requestedAtMs) || !Number.isSafeInteger(envelope.receivedAtMs)
    || envelope.requestedAtMs < window.startTimeMs || envelope.receivedAtMs > window.endTimeMs
    || envelope.receivedAtMs < envelope.requestedAtMs) {
    addReason(reasons, 'STALE_OR_MIXED_SNAPSHOT');
  }
}

function fillKey(fill: UserFillsByTimeResponse[number]): string {
  return `${fill.coin}:${fill.oid}:${fill.tid}:${fill.hash.toLowerCase()}`;
}

async function collectFills(
  client: HyperliquidTestnetReadClient,
  account: HyperliquidNettingResidualEvidenceAccount,
  window: HyperliquidNettingResidualEvidenceWindow,
  reasons: HyperliquidNettingResidualEvidenceIncompleteReason[],
): Promise<readonly HyperliquidInfoEnvelope<UserFillsByTimeResponse>[]> {
  const pages: HyperliquidInfoEnvelope<UserFillsByTimeResponse>[] = [];
  const identities = new Set<string>();
  const maximum = window.maxFillPages ?? 16;
  let cursor = window.startTimeMs;
  for (let pageIndex = 0; pageIndex < maximum; pageIndex += 1) {
    const page = await client.userFillsByTime(account.tradingAccount, cursor, window.endTimeMs);
    verifyEnvelope(page, {
      operation: 'userFillsByTime', user: account.tradingAccount,
      startTimeMs: cursor, endTimeMs: window.endTimeMs,
    }, window, reasons);
    pages.push(page);
    if (page.payload.some((fill, index) => fill.time < cursor || fill.time > window.endTimeMs
      || (index > 0 && fill.time < page.payload[index - 1]!.time))) {
      addReason(reasons, 'INCOMPLETE_PAGINATION');
      break;
    }
    const previousSize = identities.size;
    page.payload.forEach((fill) => identities.add(fillKey(fill)));
    if (page.payload.length < 2_000) return Object.freeze(pages);
    const latestTime = Math.max(...page.payload.map((fill) => fill.time));
    if (!Number.isSafeInteger(latestTime) || latestTime > window.endTimeMs
      || identities.size === previousSize) {
      addReason(reasons, 'INCOMPLETE_PAGINATION');
      break;
    }
    const boundary = await client.userFillsByTime(account.tradingAccount, latestTime, latestTime);
    verifyEnvelope(boundary, {
      operation: 'userFillsByTime', user: account.tradingAccount,
      startTimeMs: latestTime, endTimeMs: latestTime,
    }, window, reasons);
    pages.push(boundary);
    if (boundary.payload.length >= 2_000
      || boundary.payload.some((fill) => fill.time !== latestTime)) {
      addReason(reasons, 'INCOMPLETE_PAGINATION');
      break;
    }
    const boundaryKeys = new Set(boundary.payload.map(fillKey));
    if (page.payload.filter((fill) => fill.time === latestTime)
      .some((fill) => !boundaryKeys.has(fillKey(fill)))) {
      addReason(reasons, 'INCOMPLETE_PAGINATION');
      break;
    }
    boundary.payload.forEach((fill) => identities.add(fillKey(fill)));
    if (latestTime === window.endTimeMs) return Object.freeze(pages);
    cursor = latestTime + 1;
  }
  addReason(reasons, 'INCOMPLETE_PAGINATION');
  return Object.freeze(pages);
}

function deduplicatedFills(
  pages: readonly HyperliquidInfoEnvelope<UserFillsByTimeResponse>[],
  reasons: HyperliquidNettingResidualEvidenceIncompleteReason[],
): readonly UserFillsByTimeResponse[number][] {
  const fills = new Map<string, UserFillsByTimeResponse[number]>();
  for (const fill of pages.flatMap((page) => page.payload)) {
    const key = fillKey(fill);
    const previous = fills.get(key);
    if (previous !== undefined
      && JSON.stringify(stableValue(previous)) !== JSON.stringify(stableValue(fill))) {
      addReason(reasons, 'CONFLICTING_DUPLICATE_FILL');
    } else {
      fills.set(key, fill);
    }
  }
  return Object.freeze([...fills.values()]);
}

function decimalRatio(value: string): Readonly<{ coefficient: bigint; scale: number }> {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(value);
  if (match === null) throw new Error('decimal is malformed');
  const fraction = match[2] ?? '';
  return Object.freeze({ coefficient: BigInt(`${match[1]}${fraction}`), scale: fraction.length });
}

function divideUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('division is invalid');
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function quoteAtomsForBase(
  price: Readonly<{ coefficient: bigint; scale: number }>,
  baseAtoms: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  roundUp: boolean,
): bigint {
  const amount = baseAtoms < 0n ? -baseAtoms : baseAtoms;
  const numerator = price.coefficient * amount * (10n ** BigInt(quoteDecimals));
  const denominator = 10n ** BigInt(price.scale + baseDecimals);
  return roundUp ? divideUp(numerator, denominator) : numerator / denominator;
}

function terminalStatus(
  response: OrderStatusResponse,
  filledSignedQuantityAtoms: bigint,
): HyperliquidNettingResidualObservation['terminalStatus'] {
  if (response.status !== 'order' || response.order.status === 'open'
    || response.order.status === 'triggered' || !TERMINAL_STATUSES.has(response.order.status)) {
    return 'UNKNOWN';
  }
  if (response.order.status === 'filled') return 'FILLED';
  if (response.order.status.endsWith('Rejected') || response.order.status === 'rejected') {
    return filledSignedQuantityAtoms === 0n ? 'REJECTED' : 'PARTIALLY_FILLED_IOC_CANCELLED';
  }
  return filledSignedQuantityAtoms === 0n
    ? 'UNFILLED_IOC_CANCELLED' : 'PARTIALLY_FILLED_IOC_CANCELLED';
}

export class HyperliquidNettingResidualAuthoritativeEvidenceCollector {
  readonly #client: HyperliquidTestnetReadClient;

  constructor(client: HyperliquidTestnetReadClient) {
    if (client.environment !== 'testnet' || client.apiUrl !== HYPERLIQUID_TESTNET_INFO_URL) {
      throw new Error('read client must be pinned to the exact Hyperliquid Testnet Info URL');
    }
    this.#client = client;
  }

  async collect(input: HyperliquidNettingResidualEvidenceRequest):
  Promise<HyperliquidNettingResidualEvidenceResult> {
    validateWindow(input.window);
    validateRequest(input);
    const account = normalizedAccount(input.account);
    const cloid = input.clientOrderId.toLowerCase() as `0x${string}`;
    const reasons: HyperliquidNettingResidualEvidenceIncompleteReason[] = [];
    let role: HyperliquidInfoEnvelope<UserRoleResponse>;
    let openOrders: HyperliquidInfoEnvelope<OpenOrdersResponse>;
    let status: HyperliquidInfoEnvelope<OrderStatusResponse>;
    let fillPages: readonly HyperliquidInfoEnvelope<UserFillsByTimeResponse>[];
    try {
      [role, openOrders, status, fillPages] = await Promise.all([
        this.#client.userRole(account.tradingAccount),
        this.#client.openOrders(account.tradingAccount),
        this.#client.orderStatus(account.tradingAccount, cloid),
        collectFills(this.#client, account, input.window, reasons),
      ]);
    } catch {
      return Object.freeze({
        status: 'INCOMPLETE', observation: null,
        reasons: Object.freeze(['READ_FAILED'] as const), rawResponseCommitments: Object.freeze([]),
      });
    }
    verifyEnvelope(role, { operation: 'userRole', user: account.tradingAccount }, input.window, reasons);
    verifyEnvelope(openOrders, { operation: 'openOrders', user: account.tradingAccount }, input.window, reasons);
    verifyEnvelope(status, {
      operation: 'orderStatus', user: account.tradingAccount, cloid,
    }, input.window, reasons);
    if ((account.accountKind === 'MASTER' && role.payload.role !== 'user')
      || (account.accountKind === 'SUBACCOUNT'
        && (role.payload.role !== 'subAccount'
          || role.payload.data.master.toLowerCase() !== account.masterAccount))) {
      addReason(reasons, 'ACCOUNT_IDENTITY_MISMATCH');
    }
    const envelopes: readonly HyperliquidInfoEnvelope<unknown>[] = [
      role, openOrders, status, ...fillPages,
    ];
    const times = envelopes.flatMap((envelope) => [envelope.requestedAtMs, envelope.receivedAtMs]);
    if (Math.max(...times) - Math.min(...times) > input.window.maxSnapshotSkewMs) {
      addReason(reasons, 'STALE_OR_MIXED_SNAPSHOT');
    }
    const openMatches = openOrders.payload.filter((order) => order.cloid?.toLowerCase() === cloid);
    if (openMatches.length > 0) addReason(reasons, 'AMBIGUOUS_CLOID');
    const allFills = deduplicatedFills(fillPages, reasons);
    let submittedAtMs = 0n;
    let filledSignedQuantityAtoms = 0n;
    let grossQuoteAtoms = 0n;
    let feeQuoteAtoms = 0n;
    let orderId: number | null = null;
    let statusValue: HyperliquidNettingResidualObservation['terminalStatus'] = 'UNKNOWN';
    const matchedFillKeys: string[] = [];
    try {
      if (status.payload.status !== 'order') {
        addReason(reasons, 'AMBIGUOUS_CLOID');
      } else {
        const observed = status.payload.order.order;
        orderId = observed.oid;
        submittedAtMs = BigInt(observed.timestamp);
        if (observed.cloid?.toLowerCase() !== cloid || observed.timestamp < input.window.startTimeMs
          || observed.timestamp > input.window.endTimeMs
          || observed.side !== (input.plan.requestedSignedQuantityAtoms > 0n ? 'B' : 'A')
          || decimalToAtoms(observed.origSz, input.plan.quantityAsset.decimals, 'observed order size')
            !== (input.plan.requestedSignedQuantityAtoms < 0n
              ? -input.plan.requestedSignedQuantityAtoms : input.plan.requestedSignedQuantityAtoms)
          || openMatches.some((order) => order.oid !== observed.oid || order.coin !== observed.coin)) {
          addReason(reasons, 'AMBIGUOUS_CLOID');
        }
        const matchedFills = allFills.filter((fill) => fill.oid === observed.oid);
        for (const fill of matchedFills) {
          if (fill.coin !== observed.coin || fill.cloid?.toLowerCase() !== cloid
            || fill.time < input.window.startTimeMs || fill.time > input.window.endTimeMs) {
            addReason(reasons, 'AMBIGUOUS_CLOID');
            continue;
          }
          const baseFee = input.binding.marketKind === 'SPOT' && fill.side === 'B';
          const expectedFeeToken = baseFee
            ? input.binding.baseFeeToken : input.binding.quoteFeeToken;
          if (fill.feeToken !== expectedFeeToken) {
            addReason(reasons, 'UNCERTAIN_FEE_EVIDENCE');
            continue;
          }
          const atoms = decimalToAtoms(fill.sz, input.plan.quantityAsset.decimals, 'observed fill size');
          const signedAtoms = fill.side === 'B' ? atoms : -atoms;
          const price = decimalRatio(fill.px);
          const feeAtoms = decimalToAtoms(fill.fee, baseFee
            ? input.plan.quantityAsset.decimals : input.plan.quoteAsset.decimals, 'observed fill fee');
          filledSignedQuantityAtoms += signedAtoms;
          grossQuoteAtoms += quoteAtomsForBase(price, atoms, input.plan.quantityAsset.decimals,
            input.plan.quoteAsset.decimals, fill.side === 'B');
          feeQuoteAtoms += baseFee
            ? quoteAtomsForBase(price, feeAtoms, input.plan.quantityAsset.decimals,
                input.plan.quoteAsset.decimals, true)
            : feeAtoms;
          matchedFillKeys.push(fillKey(fill));
        }
        const absoluteFill = filledSignedQuantityAtoms < 0n
          ? -filledSignedQuantityAtoms : filledSignedQuantityAtoms;
        const absolutePlan = input.plan.requestedSignedQuantityAtoms < 0n
          ? -input.plan.requestedSignedQuantityAtoms : input.plan.requestedSignedQuantityAtoms;
        if (absoluteFill > absolutePlan || (filledSignedQuantityAtoms !== 0n
          && (filledSignedQuantityAtoms > 0n) !== (input.plan.requestedSignedQuantityAtoms > 0n))) {
          addReason(reasons, 'MALFORMED_RESPONSE');
        }
        statusValue = terminalStatus(status.payload, filledSignedQuantityAtoms);
      }
    } catch {
      addReason(reasons, 'MALFORMED_RESPONSE');
    }
    const rawResponseCommitments = Object.freeze(envelopes.map(rawCommitment));
    if (statusValue === 'UNKNOWN') addReason(reasons, 'MALFORMED_RESPONSE');
    if (reasons.length > 0) {
      return Object.freeze({
        status: 'INCOMPLETE', observation: null,
        reasons: Object.freeze(reasons), rawResponseCommitments,
      });
    }
    const observedAtMs = Math.max(...envelopes.map((envelope) => envelope.receivedAtMs));
    const executionReferenceHash = commitment({
      clientOrderId: cloid,
      orderId,
      status: status.payload,
      matchedFillKeys: matchedFillKeys.sort(),
    });
    const authoritativeEvidenceHash = commitment({
      attemptId: input.attemptId,
      actionHash: input.actionHash,
      requestCommitment: input.requestCommitment,
      intentHash: input.intentHash,
      instrumentHash: input.instrumentHash,
      rawResponseCommitments,
    });
    return Object.freeze({
      status: 'COMPLETE',
      observation: Object.freeze({
        clientOrderId: cloid,
        terminalStatus: statusValue,
        filledSignedQuantityAtoms,
        grossQuoteAtoms,
        feeQuoteAtoms,
        submittedAtMs,
        observedAtMs: BigInt(observedAtMs),
        executionReferenceHash,
        authoritativeEvidenceHash,
      }),
      rawResponseCommitments,
    });
  }
}
