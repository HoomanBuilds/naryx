import { createHash } from 'node:crypto';
import type {
  OpenOrdersResponse,
  OrderStatusResponse,
  UserFillsByTimeResponse,
  UserRoleResponse,
} from '@nktkas/hyperliquid/api/info';
import {
  decimalToAtoms,
  type HypercoreOrderWire,
  type HyperliquidStrategyExecutionPlan,
} from '@naryx/adapter-hyperliquid';
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

export interface HyperliquidStrategyEvidenceAccount {
  readonly masterAccount: `0x${string}`;
  readonly tradingAccount: `0x${string}`;
  readonly accountKind: 'MASTER' | 'SUBACCOUNT';
}

export interface HyperliquidStrategyEvidenceWindow {
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly nowMs: number;
  readonly maxEvidenceAgeMs: number;
  readonly maxSnapshotSkewMs: number;
  readonly maxFillPages?: number;
}

export interface HyperliquidStrategyEvidenceRequest {
  readonly attemptId: string;
  readonly batchStage: number;
  readonly account: HyperliquidStrategyEvidenceAccount;
  readonly actionHash: `0x${string}`;
  readonly requestCommitment: `0x${string}`;
  readonly durableRevision: string;
  readonly legIds: readonly string[];
  readonly clientOrderIds: readonly `0x${string}`[];
  readonly plan: HyperliquidStrategyExecutionPlan;
  readonly window: HyperliquidStrategyEvidenceWindow;
}

export type HyperliquidStrategyLegTerminalStatus =
  | 'FILLED'
  | 'UNFILLED_IOC_CANCELLED'
  | 'PARTIALLY_FILLED_IOC_CANCELLED'
  | 'REJECTED'
  | 'UNKNOWN';

export interface HyperliquidStrategyLegEvidence {
  readonly legId: string;
  readonly clientOrderId: `0x${string}`;
  readonly plannedSignedBaseAtoms: bigint;
  readonly filledSignedBaseAtoms: bigint;
  readonly terminalStatus: HyperliquidStrategyLegTerminalStatus;
  readonly openOrderStatus: 'NONE' | 'OPEN' | 'UNKNOWN';
  readonly orderId: number | null;
  readonly fillCount: number;
}

export type HyperliquidStrategyEvidenceOutcome =
  | 'COMPLETED'
  | 'NO_EFFECT'
  | 'RECOVERY_REQUIRED'
  | 'MANUAL_INTERVENTION';

export type HyperliquidStrategyEvidenceIncompleteReason =
  | 'READ_FAILED'
  | 'ENVIRONMENT_MISMATCH'
  | 'REQUEST_IDENTITY_MISMATCH'
  | 'ACCOUNT_IDENTITY_MISMATCH'
  | 'AMBIGUOUS_CLOID'
  | 'CONFLICTING_DUPLICATE_FILL'
  | 'INCOMPLETE_PAGINATION'
  | 'STALE_OR_MIXED_SNAPSHOT'
  | 'MALFORMED_RESPONSE';

export type HyperliquidStrategyEvidenceResult = Readonly<{
  status: 'COMPLETE';
  outcome: HyperliquidStrategyEvidenceOutcome;
  reasons: readonly string[];
  legs: readonly HyperliquidStrategyLegEvidence[];
  rawResponseCommitments: readonly HyperliquidRawResponseCommitment[];
}> | Readonly<{
  status: 'INCOMPLETE';
  outcome: null;
  reasons: readonly HyperliquidStrategyEvidenceIncompleteReason[];
  legs: readonly HyperliquidStrategyLegEvidence[];
  rawResponseCommitments: readonly HyperliquidRawResponseCommitment[];
}>;

interface ExpectedOrder {
  readonly legId: string;
  readonly cloid: `0x${string}`;
  readonly signedBaseAtoms: bigint;
  readonly baseDecimals: number;
  readonly wire: HypercoreOrderWire;
}

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

function rawCommitment(envelope: HyperliquidInfoEnvelope<unknown>): HyperliquidRawResponseCommitment {
  return Object.freeze({
    operation: envelope.request.operation,
    request: envelope.request,
    requestedAtMs: envelope.requestedAtMs,
    receivedAtMs: envelope.receivedAtMs,
    sha256: `0x${createHash('sha256')
      .update(JSON.stringify(stableValue(envelope.payload))).digest('hex')}`,
  });
}

function actionCommitment(orders: readonly HypercoreOrderWire[]): `0x${string}` {
  return `0x${createHash('sha256').update(JSON.stringify([
    ACTION_COMMITMENT_SCHEME,
    'order',
    orders.map((order) => [order.a, order.b, order.p, order.s, order.r,
      order.t.limit.tif, order.c]),
    'na',
  ])).digest('hex')}`;
}

function normalizedAccount(input: HyperliquidStrategyEvidenceAccount): HyperliquidStrategyEvidenceAccount {
  const masterAccount = input.masterAccount.toLowerCase();
  const tradingAccount = input.tradingAccount.toLowerCase();
  requireCondition(ADDRESS.test(masterAccount) && ADDRESS.test(tradingAccount), 'account addresses are invalid');
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

function validateWindow(window: HyperliquidStrategyEvidenceWindow): void {
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

function expectedOrders(input: HyperliquidStrategyEvidenceRequest): readonly ExpectedOrder[] {
  requireCondition(IDENTIFIER.test(input.attemptId) && Number.isSafeInteger(input.batchStage)
    && input.batchStage >= 0 && HASH.test(input.actionHash)
    && HASH.test(input.requestCommitment) && IDENTIFIER.test(input.durableRevision),
  'strategy evidence identity is invalid');
  requireCondition(input.plan.version === 1
    && input.plan.guarantee === 'BATCHED_IOC_WITH_BOUNDED_RECOVERY'
    && input.plan.domain.domainId === 'hypercore:testnet', 'strategy plan is unsupported');
  const batches = input.plan.batches.filter((batch) => batch.stage === input.batchStage);
  requireCondition(batches.length === 1, 'strategy batch stage is ambiguous');
  const batch = batches[0]!;
  const orders = input.plan.orders.filter((order) => order.stage === input.batchStage);
  requireCondition(orders.length > 0 && orders.length <= 16
    && orders.length === batch.action.orders.length
    && orders.length === batch.legIds.length
    && orders.length === input.legIds.length
    && orders.length === input.clientOrderIds.length,
  'strategy batch membership is inconsistent');
  requireCondition(actionCommitment(batch.action.orders) === input.actionHash,
    'strategy action commitment differs from the handoff');
  const result = orders.map((order, index): ExpectedOrder => {
    const cloid = order.clientOrderId.toLowerCase();
    requireCondition(CLOID.test(cloid) && cloid === order.wire.c.toLowerCase()
      && input.clientOrderIds[index]?.toLowerCase() === cloid
      && input.legIds[index] === order.legId && batch.legIds[index] === order.legId,
    'strategy leg identity differs from the handoff');
    return Object.freeze({
      legId: order.legId,
      cloid: cloid as `0x${string}`,
      signedBaseAtoms: order.signedBaseDeltaAtoms,
      baseDecimals: order.baseAsset.decimals,
      wire: order.wire,
    });
  });
  requireCondition(new Set(result.map((order) => order.cloid)).size === result.length,
    'strategy client order IDs must be unique');
  return Object.freeze(result);
}

function addReason(
  reasons: HyperliquidStrategyEvidenceIncompleteReason[],
  reason: HyperliquidStrategyEvidenceIncompleteReason,
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
  window: HyperliquidStrategyEvidenceWindow,
  reasons: HyperliquidStrategyEvidenceIncompleteReason[],
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
  account: HyperliquidStrategyEvidenceAccount,
  window: HyperliquidStrategyEvidenceWindow,
  reasons: HyperliquidStrategyEvidenceIncompleteReason[],
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
  reasons: HyperliquidStrategyEvidenceIncompleteReason[],
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

function terminalStatus(
  status: OrderStatusResponse,
  openMatches: number,
  filledSignedBaseAtoms: bigint,
): Pick<HyperliquidStrategyLegEvidence, 'terminalStatus' | 'openOrderStatus'> {
  if (openMatches > 0) return { terminalStatus: 'UNKNOWN', openOrderStatus: 'OPEN' };
  if (status.status === 'unknownOid' || status.order.status === 'open'
    || status.order.status === 'triggered' || !TERMINAL_STATUSES.has(status.order.status)) {
    return { terminalStatus: 'UNKNOWN', openOrderStatus: 'UNKNOWN' };
  }
  if (status.order.status === 'filled') return { terminalStatus: 'FILLED', openOrderStatus: 'NONE' };
  if (status.order.status.endsWith('Rejected') || status.order.status === 'rejected') {
    return filledSignedBaseAtoms === 0n
      ? { terminalStatus: 'REJECTED', openOrderStatus: 'NONE' }
      : { terminalStatus: 'PARTIALLY_FILLED_IOC_CANCELLED', openOrderStatus: 'NONE' };
  }
  return filledSignedBaseAtoms === 0n
    ? { terminalStatus: 'UNFILLED_IOC_CANCELLED', openOrderStatus: 'NONE' }
    : { terminalStatus: 'PARTIALLY_FILLED_IOC_CANCELLED', openOrderStatus: 'NONE' };
}

function reduceLegs(
  expected: readonly ExpectedOrder[],
  openOrders: OpenOrdersResponse,
  statuses: readonly OrderStatusResponse[],
  fills: readonly UserFillsByTimeResponse[number][],
  window: HyperliquidStrategyEvidenceWindow,
  reasons: HyperliquidStrategyEvidenceIncompleteReason[],
): readonly HyperliquidStrategyLegEvidence[] {
  const orderIds = new Set<number>();
  return Object.freeze(expected.map((order, index) => {
    const response = statuses[index]!;
    if (response.status !== 'order') {
      const openMatches = openOrders.filter((candidate) => candidate.cloid?.toLowerCase() === order.cloid);
      if (openMatches.length > 1) addReason(reasons, 'AMBIGUOUS_CLOID');
      return Object.freeze({
        legId: order.legId,
        clientOrderId: order.cloid,
        plannedSignedBaseAtoms: order.signedBaseAtoms,
        filledSignedBaseAtoms: 0n,
        terminalStatus: 'UNKNOWN' as const,
        openOrderStatus: openMatches.length === 1 ? 'OPEN' as const : 'UNKNOWN' as const,
        orderId: null,
        fillCount: 0,
      });
    }
    const observedOrder = response.order.order;
    if (observedOrder.cloid?.toLowerCase() !== order.cloid || orderIds.has(observedOrder.oid)
      || observedOrder.timestamp < window.startTimeMs || observedOrder.timestamp > window.endTimeMs) {
      addReason(reasons, 'AMBIGUOUS_CLOID');
    }
    orderIds.add(observedOrder.oid);
    const openMatches = openOrders.filter((candidate) => candidate.cloid?.toLowerCase() === order.cloid);
    if (openMatches.length > 1 || openMatches.some((candidate) =>
      candidate.oid !== observedOrder.oid || candidate.coin !== observedOrder.coin)) {
      addReason(reasons, 'AMBIGUOUS_CLOID');
    }
    const matchedFills = fills.filter((fill) => fill.oid === observedOrder.oid);
    let filledSignedBaseAtoms = 0n;
    try {
      if (decimalToAtoms(observedOrder.origSz, order.baseDecimals, 'observed order size')
        !== (order.signedBaseAtoms < 0n ? -order.signedBaseAtoms : order.signedBaseAtoms)
        || observedOrder.side !== (order.signedBaseAtoms > 0n ? 'B' : 'A')) {
        addReason(reasons, 'MALFORMED_RESPONSE');
      }
      for (const fill of matchedFills) {
        if (fill.coin !== observedOrder.coin
          || (fill.cloid !== undefined && fill.cloid.toLowerCase() !== order.cloid)
          || fill.time < window.startTimeMs || fill.time > window.endTimeMs) {
          addReason(reasons, 'AMBIGUOUS_CLOID');
          continue;
        }
        const atoms = decimalToAtoms(fill.sz, order.baseDecimals, 'observed fill size');
        filledSignedBaseAtoms += fill.side === 'B' ? atoms : -atoms;
      }
    } catch {
      addReason(reasons, 'MALFORMED_RESPONSE');
    }
    const absoluteFill = filledSignedBaseAtoms < 0n ? -filledSignedBaseAtoms : filledSignedBaseAtoms;
    const absolutePlan = order.signedBaseAtoms < 0n ? -order.signedBaseAtoms : order.signedBaseAtoms;
    if (absoluteFill > absolutePlan
      || (filledSignedBaseAtoms !== 0n
        && (filledSignedBaseAtoms > 0n) !== (order.signedBaseAtoms > 0n))) {
      addReason(reasons, 'MALFORMED_RESPONSE');
    }
    return Object.freeze({
      legId: order.legId,
      clientOrderId: order.cloid,
      plannedSignedBaseAtoms: order.signedBaseAtoms,
      filledSignedBaseAtoms,
      ...terminalStatus(response, openMatches.length, filledSignedBaseAtoms),
      orderId: observedOrder.oid,
      fillCount: matchedFills.length,
    });
  }));
}

function outcome(legs: readonly HyperliquidStrategyLegEvidence[]): Readonly<{
  outcome: HyperliquidStrategyEvidenceOutcome;
  reasons: readonly string[];
}> {
  if (legs.some((leg) => leg.openOrderStatus === 'OPEN')) {
    return Object.freeze({ outcome: 'MANUAL_INTERVENTION', reasons: Object.freeze(['OPEN_IOC_ORDER']) });
  }
  if (legs.every((leg) => leg.filledSignedBaseAtoms === 0n)) {
    return Object.freeze({ outcome: 'NO_EFFECT', reasons: Object.freeze([]) });
  }
  if (legs.every((leg) => leg.filledSignedBaseAtoms === leg.plannedSignedBaseAtoms
    && leg.terminalStatus === 'FILLED')) {
    return Object.freeze({ outcome: 'COMPLETED', reasons: Object.freeze([]) });
  }
  if (legs.some((leg) => {
    const fill = leg.filledSignedBaseAtoms < 0n ? -leg.filledSignedBaseAtoms : leg.filledSignedBaseAtoms;
    const plan = leg.plannedSignedBaseAtoms < 0n ? -leg.plannedSignedBaseAtoms : leg.plannedSignedBaseAtoms;
    return fill > plan || (leg.filledSignedBaseAtoms !== 0n
      && (leg.filledSignedBaseAtoms > 0n) !== (leg.plannedSignedBaseAtoms > 0n));
  })) {
    return Object.freeze({ outcome: 'MANUAL_INTERVENTION', reasons: Object.freeze(['OVERFILL_OR_SIDE_MISMATCH']) });
  }
  return Object.freeze({ outcome: 'RECOVERY_REQUIRED', reasons: Object.freeze(['PARTIAL_PACKAGE_FILL']) });
}

export class HyperliquidStrategyAuthoritativeEvidenceCollector {
  readonly #client: HyperliquidTestnetReadClient;

  constructor(client: HyperliquidTestnetReadClient) {
    if (client.environment !== 'testnet' || client.apiUrl !== HYPERLIQUID_TESTNET_INFO_URL) {
      throw new Error('read client must be pinned to the exact Hyperliquid testnet Info URL');
    }
    this.#client = client;
  }

  async collect(input: HyperliquidStrategyEvidenceRequest): Promise<HyperliquidStrategyEvidenceResult> {
    validateWindow(input.window);
    const account = normalizedAccount(input.account);
    const expected = expectedOrders(input);
    const reasons: HyperliquidStrategyEvidenceIncompleteReason[] = [];
    let role: HyperliquidInfoEnvelope<UserRoleResponse>;
    let openOrders: HyperliquidInfoEnvelope<OpenOrdersResponse>;
    let statuses: readonly HyperliquidInfoEnvelope<OrderStatusResponse>[];
    let fillPages: readonly HyperliquidInfoEnvelope<UserFillsByTimeResponse>[];
    try {
      [role, openOrders, statuses, fillPages] = await Promise.all([
        this.#client.userRole(account.tradingAccount),
        this.#client.openOrders(account.tradingAccount),
        Promise.all(expected.map((order) => this.#client.orderStatus(account.tradingAccount, order.cloid))),
        collectFills(this.#client, account, input.window, reasons),
      ]);
    } catch {
      return Object.freeze({
        status: 'INCOMPLETE', outcome: null,
        reasons: Object.freeze(['READ_FAILED'] as const),
        legs: Object.freeze([]), rawResponseCommitments: Object.freeze([]),
      });
    }
    verifyEnvelope(role, { operation: 'userRole', user: account.tradingAccount }, input.window, reasons);
    verifyEnvelope(openOrders, { operation: 'openOrders', user: account.tradingAccount }, input.window, reasons);
    statuses.forEach((status, index) => verifyEnvelope(status, {
      operation: 'orderStatus', user: account.tradingAccount, cloid: expected[index]!.cloid,
    }, input.window, reasons));
    const rolePayload = role.payload;
    if ((account.accountKind === 'MASTER' && rolePayload.role !== 'user')
      || (account.accountKind === 'SUBACCOUNT'
        && (rolePayload.role !== 'subAccount'
          || rolePayload.data.master.toLowerCase() !== account.masterAccount))) {
      addReason(reasons, 'ACCOUNT_IDENTITY_MISMATCH');
    }
    const envelopes: readonly HyperliquidInfoEnvelope<unknown>[] = [
      role, openOrders, ...statuses, ...fillPages,
    ];
    const times = envelopes.flatMap((envelope) => [envelope.requestedAtMs, envelope.receivedAtMs]);
    if (Math.max(...times) - Math.min(...times) > input.window.maxSnapshotSkewMs) {
      addReason(reasons, 'STALE_OR_MIXED_SNAPSHOT');
    }
    const fills = deduplicatedFills(fillPages, reasons);
    const legs = reduceLegs(expected, openOrders.payload, statuses.map((status) => status.payload),
      fills, input.window, reasons);
    const commitments = Object.freeze(envelopes.map(rawCommitment));
    if (reasons.length > 0 || legs.some((leg) => leg.terminalStatus === 'UNKNOWN'
      || leg.openOrderStatus === 'UNKNOWN')) {
      return Object.freeze({
        status: 'INCOMPLETE',
        outcome: null,
        reasons: Object.freeze(reasons.length > 0
          ? reasons : ['MALFORMED_RESPONSE'] as HyperliquidStrategyEvidenceIncompleteReason[]),
        legs,
        rawResponseCommitments: commitments,
      });
    }
    const classified = outcome(legs);
    return Object.freeze({
      status: 'COMPLETE',
      outcome: classified.outcome,
      reasons: classified.reasons,
      legs,
      rawResponseCommitments: commitments,
    });
  }
}
