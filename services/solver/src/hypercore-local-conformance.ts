import { createHash } from 'node:crypto';
import type { HyperliquidStrategyExecutionPlan } from '@naryx/adapter-hyperliquid';
import type { HyperliquidSubmissionAccount } from './index.js';
import type {
  HyperliquidStrategyEvidenceResult,
} from './hyperliquid-testnet-evidence-http.js';
import type {
  HyperliquidStrategyEvidenceBinding,
  HyperliquidStrategyRuntimeEvidencePort,
  HyperliquidStrategyRuntimeJournalPort,
  HyperliquidStrategyRuntimeSubmissionPort,
} from './hyperliquid-strategy-testnet-runtime.js';
import type {
  HyperliquidStrategyReconciliationHandoff,
  HyperliquidStrategySubmissionInput,
  HyperliquidStrategySubmissionResult,
} from './hyperliquid-strategy-testnet-submission.js';
import type { HyperliquidTrustedTimeDecision } from './hyperliquid-trusted-time.js';

export const HYPERCORE_LOCAL_CONFORMANCE_EVIDENCE_CLASS =
  'NARYX_HYPERCORE_LOCAL_CONFORMANCE_V1' as const;

export interface HypercoreLocalConformanceRecoveryLeg {
  readonly legId: string;
  readonly action: 'COMPLETE' | 'ROLLBACK';
  readonly assetIndex: number;
  readonly signedBaseDeltaAtoms: bigint;
  readonly costQuoteAtoms: bigint;
}

export interface HypercoreLocalConformanceRecoveryReceipt {
  readonly evidenceClass: typeof HYPERCORE_LOCAL_CONFORMANCE_EVIDENCE_CLASS;
  readonly attemptId: string;
  readonly status: 'COMPLETED' | 'ROLLED_BACK' | 'BOUNDED_RESIDUAL';
  readonly aggregateCostQuoteAtoms: bigint;
  readonly legs: readonly HypercoreLocalConformanceRecoveryLeg[];
  readonly receiptCommitment: `0x${string}`;
}

export interface HypercoreLocalConformanceSnapshot {
  readonly evidenceClass: typeof HYPERCORE_LOCAL_CONFORMANCE_EVIDENCE_CLASS;
  readonly revision: bigint;
  readonly positions: readonly Readonly<{
    assetIndex: number;
    signedBaseAtoms: bigint;
  }>[];
}

interface ConformanceLegFill {
  readonly legId: string;
  readonly clientOrderId: `0x${string}`;
  readonly assetIndex: number;
  readonly plannedSignedBaseAtoms: bigint;
  readonly filledSignedBaseAtoms: bigint;
  readonly grossQuoteAtoms: bigint;
  readonly feeQuoteAtoms: bigint;
  readonly observedAtMs: number;
}

interface ConformanceRecord {
  readonly attemptId: string;
  readonly batchStage: number;
  readonly actionCommitment: `0x${string}`;
  readonly requestCommitment: `0x${string}`;
  readonly responseCommitment: `0x${string}`;
  readonly revision: bigint;
  readonly account: HyperliquidSubmissionAccount;
  readonly commitments: Readonly<{
    orderHash: Uint8Array;
    graphHash: Uint8Array;
    quoteHash: Uint8Array;
    routeHash: Uint8Array;
  }>;
  readonly legIds: readonly string[];
  readonly clientOrderIds: readonly `0x${string}`[];
  readonly fills: readonly ConformanceLegFill[];
  readonly submission: HyperliquidStrategySubmissionResult;
  recovered: boolean;
}

interface ArmedFailure {
  readonly attemptId: string;
  readonly batchStage: number;
  readonly legId: string;
}

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
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

function quoteCost(quantityAtoms: bigint, price: Readonly<{
  quoteAtoms: bigint;
  baseAtoms: bigint;
}>): bigint {
  const numerator = quantityAtoms * price.quoteAtoms;
  return numerator / price.baseAtoms + (numerator % price.baseAtoms === 0n ? 0n : 1n);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePlan(record: ConformanceRecord, plan: HyperliquidStrategyExecutionPlan): boolean {
  return sameBytes(plan.orderHash, record.commitments.orderHash)
    && sameBytes(plan.graphHash, record.commitments.graphHash)
    && sameBytes(plan.quoteHash, record.commitments.quoteHash)
    && sameBytes(plan.routeHash, record.commitments.routeHash);
}

function recordKey(attemptId: string, batchStage: number): string {
  return `${attemptId}:${batchStage}`;
}

function sameWire(
  left: HyperliquidStrategyExecutionPlan['orders'][number]['wire'],
  right: HyperliquidStrategyExecutionPlan['batches'][number]['action']['orders'][number],
): boolean {
  return left.a === right.a && left.b === right.b && left.p === right.p
    && left.s === right.s && left.r === right.r && left.c === right.c
    && left.t.limit.tif === right.t.limit.tif;
}

export class HypercoreLocalConformanceVenue
implements HyperliquidStrategyRuntimeJournalPort,
HyperliquidStrategyRuntimeSubmissionPort,
HyperliquidStrategyRuntimeEvidencePort {
  readonly #feeBps: bigint;
  readonly #positions = new Map<number, bigint>();
  readonly #records = new Map<string, ConformanceRecord>();
  readonly #timeDecisions = new Set<string>();
  #armedFailure: ArmedFailure | null = null;
  #revision = 0n;
  #lastNonce = 0n;

  constructor(feeBps = 1n) {
    requireCondition(feeBps >= 0n && feeBps <= 100n, 'conformance fee must be 0 to 100 bps');
    this.#feeBps = feeBps;
  }

  armOneLegNoFill(input: ArmedFailure): void {
    requireCondition(IDENTIFIER.test(input.attemptId)
      && Number.isSafeInteger(input.batchStage) && input.batchStage >= 0
      && IDENTIFIER.test(input.legId), 'conformance failure identity is invalid');
    requireCondition(this.#armedFailure === null, 'a conformance failure is already armed');
    this.#armedFailure = Object.freeze({ ...input });
  }

  submissionContext(input: Readonly<{
    account: HyperliquidSubmissionAccount;
    agentWallet: `0x${string}`;
    signerLeaseId: string;
    nowMs: bigint;
    timeDecisionHash: `0x${string}`;
  }>): Readonly<{ expectedVersion: bigint; nonce: bigint }> {
    requireCondition(input.nowMs > 0n && IDENTIFIER.test(input.signerLeaseId)
      && this.#timeDecisions.has(input.timeDecisionHash),
      'conformance submission context is invalid');
    this.#lastNonce = input.nowMs > this.#lastNonce ? input.nowMs : this.#lastNonce + 1n;
    return Object.freeze({ expectedVersion: this.#revision, nonce: this.#lastNonce });
  }

  recordTrustedTimeDecision(scope: string, decision: HyperliquidTrustedTimeDecision): void {
    requireCondition(IDENTIFIER.test(scope) && decision.selectedTimeMs > 0,
      'conformance trusted time decision is invalid');
    this.#timeDecisions.add(decision.decisionHash);
  }

  async submitBatch(
    input: HyperliquidStrategySubmissionInput,
  ): Promise<HyperliquidStrategySubmissionResult> {
    const key = recordKey(input.attemptId, input.batchStage);
    const replay = this.#records.get(key);
    if (replay !== undefined) return replay.submission;
    requireCondition(input.expectedVersion === this.#revision,
      'conformance submission journal version is stale');
    requireCondition(input.plan.domain.domainId === 'hypercore:testnet'
      && input.plan.requestExpiryMs > input.nowMs
      && input.plan.requestExpiryMs > input.nonce, 'conformance plan is stale or unsupported');
    const batch = input.plan.batches.find((candidate) => candidate.stage === input.batchStage);
    requireCondition(batch !== undefined && batch.legIds.length === batch.action.orders.length
      && batch.legIds.length > 0, 'conformance batch is invalid');
    const planned = batch.legIds.map((legId, index) => {
      const order = input.plan.orders.find((candidate) => candidate.legId === legId);
      requireCondition(order !== undefined && order.stage === input.batchStage
        && sameWire(order.wire, batch.action.orders[index]!)
        && order.clientOrderId === batch.action.orders[index]!.c
        && order.wire.t.limit.tif === 'Ioc', 'conformance batch does not match the plan');
      return order;
    });
    requireCondition(new Set(batch.legIds).size === batch.legIds.length,
      'conformance batch leg ids must be unique');
    const failure = this.#armedFailure;
    if (failure !== null && failure.attemptId === input.attemptId
      && failure.batchStage === input.batchStage) {
      requireCondition(batch.legIds.includes(failure.legId),
        'armed conformance failure does not belong to the batch');
      this.#armedFailure = null;
    }
    const observedAtMs = Number(input.nowMs);
    const fills = planned.map((order): ConformanceLegFill => {
      const filledSignedBaseAtoms = failure?.attemptId === input.attemptId
        && failure.batchStage === input.batchStage && failure.legId === order.legId
        ? 0n : order.signedBaseDeltaAtoms;
      const grossQuoteAtoms = quoteCost(absolute(filledSignedBaseAtoms), order.limitPrice);
      const feeQuoteAtoms = grossQuoteAtoms * this.#feeBps / 10_000n
        + (grossQuoteAtoms * this.#feeBps % 10_000n === 0n ? 0n : 1n);
      this.#positions.set(order.wire.a,
        (this.#positions.get(order.wire.a) ?? 0n) + filledSignedBaseAtoms);
      return Object.freeze({
        legId: order.legId,
        clientOrderId: order.clientOrderId,
        assetIndex: order.wire.a,
        plannedSignedBaseAtoms: order.signedBaseDeltaAtoms,
        filledSignedBaseAtoms,
        grossQuoteAtoms,
        feeQuoteAtoms,
        observedAtMs,
      });
    });
    const actionCommitment = commitment({ evidenceClass: HYPERCORE_LOCAL_CONFORMANCE_EVIDENCE_CLASS,
      plan: input.plan, batchStage: input.batchStage });
    const requestCommitment = commitment({ actionCommitment, attemptId: input.attemptId,
      nonce: input.nonce, account: input.account });
    const responseCommitment = commitment({ requestCommitment, fills });
    this.#revision += 1n;
    const handoff: HyperliquidStrategyReconciliationHandoff = Object.freeze({
      collector: 'HYPERLIQUID_TESTNET_AUTHORITATIVE_EVIDENCE',
      attemptId: input.attemptId,
      batchStage: input.batchStage,
      account: input.account,
      actionHash: actionCommitment,
      actionCommitmentScheme: 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1',
      requestCommitment,
      durableRevision: `local-conformance-${this.#revision}`,
      legIds: Object.freeze([...batch.legIds]),
      clientOrderIds: Object.freeze(planned.map((order) => order.clientOrderId)),
    });
    const submission: HyperliquidStrategySubmissionResult = Object.freeze({
      attemptId: input.attemptId,
      batchStage: input.batchStage,
      actionCommitment,
      requestCommitment,
      status: 'SUBMISSION_ACKNOWLEDGED',
      evidenceStatus: 'SUBMISSION_EVIDENCE_ONLY',
      settlementStatus: 'RECONCILIATION_REQUIRED',
      responseCommitment,
      reconciliation: handoff,
    });
    this.#records.set(key, {
      attemptId: input.attemptId,
      batchStage: input.batchStage,
      actionCommitment,
      requestCommitment,
      responseCommitment,
      revision: this.#revision,
      account: input.account,
      commitments: Object.freeze({
        orderHash: new Uint8Array(input.plan.orderHash),
        graphHash: new Uint8Array(input.plan.graphHash),
        quoteHash: new Uint8Array(input.plan.quoteHash),
        routeHash: new Uint8Array(input.plan.routeHash),
      }),
      legIds: handoff.legIds,
      clientOrderIds: handoff.clientOrderIds,
      fills: Object.freeze(fills),
      submission,
      recovered: false,
    });
    return submission;
  }

  async collect(input: Readonly<{
    handoff: HyperliquidStrategyReconciliationHandoff;
    binding: HyperliquidStrategyEvidenceBinding;
    plan: HyperliquidStrategyExecutionPlan;
    window: Readonly<{
      startTimeMs: number;
      endTimeMs: number;
      nowMs: number;
      maxEvidenceAgeMs: number;
      maxSnapshotSkewMs: number;
      maxFillPages: number;
    }>;
  }>): Promise<HyperliquidStrategyEvidenceResult> {
    const record = this.#records.get(recordKey(input.handoff.attemptId, input.handoff.batchStage));
    requireCondition(record !== undefined && record.actionCommitment === input.handoff.actionHash
      && record.requestCommitment === input.handoff.requestCommitment
      && record.legIds.length === input.handoff.legIds.length
      && record.legIds.every((legId, index) => legId === input.handoff.legIds[index])
      && record.clientOrderIds.length === input.handoff.clientOrderIds.length
      && record.clientOrderIds.every((clientOrderId, index) =>
        clientOrderId === input.handoff.clientOrderIds[index])
      && record.account.masterAccount === input.handoff.account.masterAccount
      && record.account.tradingAccount === input.handoff.account.tradingAccount
      && record.account.accountKind === input.handoff.account.accountKind
      && samePlan(record, input.plan)
      && commitment({ evidenceClass: HYPERCORE_LOCAL_CONFORMANCE_EVIDENCE_CLASS,
        plan: input.plan, batchStage: input.handoff.batchStage }) === record.actionCommitment,
    'conformance reconciliation handoff is invalid');
    const observedAtMs = Math.max(...record.fills.map((fill) => fill.observedAtMs));
    if (observedAtMs < input.window.startTimeMs || observedAtMs > input.window.endTimeMs
      || input.window.nowMs - observedAtMs > input.window.maxEvidenceAgeMs) {
      return Object.freeze({
        status: 'INCOMPLETE', outcome: null, reasons: Object.freeze(['CONFORMANCE_EVIDENCE_STALE']),
        observedAtMs, legs: Object.freeze([]), rawResponseCommitments: Object.freeze([]),
      });
    }
    const completed = record.fills.filter((fill) =>
      fill.filledSignedBaseAtoms === fill.plannedSignedBaseAtoms).length;
    const noEffect = record.fills.every((fill) => fill.filledSignedBaseAtoms === 0n);
    const outcome = completed === record.fills.length ? 'COMPLETED'
      : noEffect ? 'NO_EFFECT' : 'RECOVERY_REQUIRED';
    return Object.freeze({
      status: 'COMPLETE',
      outcome,
      reasons: Object.freeze(outcome === 'RECOVERY_REQUIRED' ? ['PARTIAL_PACKAGE_FILL']
        : outcome === 'NO_EFFECT' ? ['PACKAGE_UNFILLED'] : []),
      observedAtMs,
      legs: Object.freeze(record.fills.map((fill) => Object.freeze({
        legId: fill.legId,
        clientOrderId: fill.clientOrderId,
        plannedSignedBaseAtoms: fill.plannedSignedBaseAtoms,
        filledSignedBaseAtoms: fill.filledSignedBaseAtoms,
        terminalStatus: fill.filledSignedBaseAtoms === fill.plannedSignedBaseAtoms
          ? 'FILLED' as const : 'UNFILLED_IOC_CANCELLED' as const,
        openOrderStatus: 'NONE' as const,
        orderId: Number(record.revision),
        fillCount: fill.filledSignedBaseAtoms === 0n ? 0 : 1,
        grossQuoteAtoms: fill.grossQuoteAtoms,
        feeAssetId: input.binding.quoteFeeToken,
        feeAssetDecimals: input.plan.orders.find((order) => order.legId === fill.legId)!
          .quoteAsset.decimals,
        feeAtoms: fill.feeQuoteAtoms,
        venueFeeQuoteAtoms: fill.feeQuoteAtoms,
        observedAtMs: fill.filledSignedBaseAtoms === 0n ? null : fill.observedAtMs,
      }))),
      rawResponseCommitments: Object.freeze([Object.freeze({
        evidenceClass: HYPERCORE_LOCAL_CONFORMANCE_EVIDENCE_CLASS,
        responseCommitment: record.responseCommitment,
      })]),
    });
  }

  recover(
    attemptId: string,
    plan: HyperliquidStrategyExecutionPlan,
  ): HypercoreLocalConformanceRecoveryReceipt {
    const records = [...this.#records.values()].filter((record) => record.attemptId === attemptId)
      .sort((left, right) => left.batchStage - right.batchStage);
    requireCondition(records.length > 0 && records.every((record) => !record.recovered),
      'conformance recovery attempt is missing or already recovered');
    requireCondition(records.every((record) => samePlan(record, plan)
      && commitment({ evidenceClass: HYPERCORE_LOCAL_CONFORMANCE_EVIDENCE_CLASS,
        plan, batchStage: record.batchStage }) === record.actionCommitment),
    'conformance recovery plan does not match the submitted plan');
    const legs: HypercoreLocalConformanceRecoveryLeg[] = [];
    for (const record of records) {
      for (const fill of record.fills) {
        const authorization = plan.recoveryAuthorizations.filter((candidate) =>
          candidate.legId === fill.legId);
        requireCondition(authorization.length === 1,
          `conformance recovery authorization is missing for ${fill.legId}`);
        const selected = authorization[0]!;
        const signedBaseDeltaAtoms = selected.action === 'COMPLETE'
          ? fill.plannedSignedBaseAtoms - fill.filledSignedBaseAtoms
          : -fill.filledSignedBaseAtoms;
        const quantityAtoms = absolute(signedBaseDeltaAtoms);
        if (quantityAtoms === 0n) continue;
        const planned = plan.orders.find((order) => order.legId === fill.legId);
        requireCondition(planned !== undefined && quantityAtoms <= selected.maximumQuantityAtoms,
          `conformance recovery quantity exceeds authorization for ${fill.legId}`);
        const costQuoteAtoms = quoteCost(quantityAtoms, planned.limitPrice);
        requireCondition(costQuoteAtoms <= selected.maximumCostQuoteAtoms,
          `conformance recovery cost exceeds authorization for ${fill.legId}`);
        legs.push(Object.freeze({
          legId: fill.legId,
          action: selected.action,
          assetIndex: fill.assetIndex,
          signedBaseDeltaAtoms,
          costQuoteAtoms,
        }));
      }
    }
    requireCondition(legs.length > 0, 'conformance recovery has no authorized work');
    const aggregateCostQuoteAtoms = legs.reduce((total, leg) => total + leg.costQuoteAtoms, 0n);
    requireCondition(aggregateCostQuoteAtoms <= plan.maximumRecoveryCostQuoteAtoms,
      'conformance aggregate recovery cost exceeds authorization');
    for (const leg of legs) {
      this.#positions.set(leg.assetIndex,
        (this.#positions.get(leg.assetIndex) ?? 0n) + leg.signedBaseDeltaAtoms);
    }
    for (const record of records) record.recovered = true;
    const actions = new Set(legs.map((leg) => leg.action));
    const status = actions.size === 1 && actions.has('COMPLETE') ? 'COMPLETED'
      : actions.size === 1 && actions.has('ROLLBACK') ? 'ROLLED_BACK' : 'BOUNDED_RESIDUAL';
    const receipt = {
      evidenceClass: HYPERCORE_LOCAL_CONFORMANCE_EVIDENCE_CLASS,
      attemptId,
      status,
      aggregateCostQuoteAtoms,
      legs: Object.freeze(legs),
    } as const;
    return Object.freeze({ ...receipt, receiptCommitment: commitment(receipt) });
  }

  snapshot(): HypercoreLocalConformanceSnapshot {
    return Object.freeze({
      evidenceClass: HYPERCORE_LOCAL_CONFORMANCE_EVIDENCE_CLASS,
      revision: this.#revision,
      positions: Object.freeze([...this.#positions.entries()]
        .sort(([left], [right]) => left - right)
        .map(([assetIndex, signedBaseAtoms]) => Object.freeze({ assetIndex, signedBaseAtoms }))),
    });
  }
}
