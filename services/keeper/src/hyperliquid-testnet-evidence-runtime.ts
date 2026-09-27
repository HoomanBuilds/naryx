import { createHash } from 'node:crypto';
import type { HyperliquidExecutionPlan } from '@naryx/adapter-hyperliquid';
import {
  beginHyperliquidReconciliation,
  createHyperliquidPackageAttempt,
  markHyperliquidSubmissionUnknown,
  reconcileHyperliquidPackageAttempt,
  type HyperliquidAccountIdentityInput,
  type HyperliquidPackageAttempt,
} from './index.js';
import { NARYX_HYPERCORE_ACTION_COMMITMENT_SCHEME } from './hyperliquid-submission-journal.js';
import {
  type HyperliquidAuthoritativeEvidenceCollector,
  type HyperliquidCollectedStateObservation,
  type HyperliquidEvidenceCheckpoint,
  type HyperliquidEvidenceIncompleteReason,
  type HyperliquidEvidenceMarketBinding,
  type HyperliquidEvidenceWindow,
  type HyperliquidObservedFill,
  type HyperliquidRawResponseCommitment,
} from './hyperliquid-evidence-collector.js';

export const HYPERLIQUID_TESTNET_EVIDENCE_RECONCILIATION_COLLECTOR =
  'HYPERLIQUID_TESTNET_AUTHORITATIVE_EVIDENCE' as const;

export interface HyperliquidTestnetSubmissionHandoff {
  readonly collector: typeof HYPERLIQUID_TESTNET_EVIDENCE_RECONCILIATION_COLLECTOR;
  readonly attemptId: string;
  readonly account: HyperliquidAccountIdentityInput;
  readonly actionHash: `0x${string}`;
  readonly actionCommitmentScheme: typeof NARYX_HYPERCORE_ACTION_COMMITMENT_SCHEME;
  readonly requestCommitment: `0x${string}`;
  readonly durableRevision: string;
  readonly spotClientOrderId: `0x${string}`;
  readonly perpetualClientOrderId: `0x${string}`;
}

export interface HyperliquidTestnetEvidencePrepareInput {
  readonly attemptId: string;
  readonly plan: HyperliquidExecutionPlan;
  readonly account: HyperliquidAccountIdentityInput;
  readonly binding: HyperliquidEvidenceMarketBinding;
  readonly window: HyperliquidEvidenceWindow;
}

export interface HyperliquidTestnetEvidenceRuntimeState {
  readonly attemptId: string;
  readonly actionHash: `0x${string}`;
  readonly attempt: HyperliquidPackageAttempt;
  readonly checkpoint: HyperliquidEvidenceCheckpoint;
  readonly binding: HyperliquidEvidenceMarketBinding;
}

export type HyperliquidTestnetPrepareResult = Readonly<{
  status: 'PREPARED';
  state: HyperliquidTestnetEvidenceRuntimeState;
}> | Readonly<{
  status: 'CHECKPOINT_INCOMPLETE';
  reasons: readonly HyperliquidEvidenceIncompleteReason[];
  rawResponseCommitments: readonly HyperliquidRawResponseCommitment[];
}>;

export type HyperliquidTestnetHandoffRejectionReason =
  | 'UNKNOWN_COLLECTOR'
  | 'UNSUPPORTED_COMMITMENT_SCHEME'
  | 'INVALID_ATTEMPT_ID'
  | 'ATTEMPT_ID_MISMATCH'
  | 'INVALID_DURABLE_REVISION'
  | 'INVALID_ACTION_HASH'
  | 'ACTION_HASH_MISMATCH'
  | 'INVALID_REQUEST_COMMITMENT'
  | 'ACCOUNT_MISMATCH'
  | 'CLIENT_ORDER_ID_MISMATCH'
  | 'MARKET_BINDING_MISMATCH';

export type HyperliquidTestnetReconcileResult = Readonly<{
  status: 'RECONCILED';
  attempt: HyperliquidPackageAttempt;
  accountObservation: HyperliquidCollectedStateObservation;
  observedFills: readonly HyperliquidObservedFill[];
  rawResponseCommitments: readonly HyperliquidRawResponseCommitment[];
}> | Readonly<{
  status: 'EVIDENCE_INCOMPLETE';
  attempt: HyperliquidPackageAttempt;
  reasons: readonly HyperliquidEvidenceIncompleteReason[];
  accountObservation: HyperliquidCollectedStateObservation | null;
  observedFills: readonly HyperliquidObservedFill[];
  rawResponseCommitments: readonly HyperliquidRawResponseCommitment[];
}> | Readonly<{
  status: 'HANDOFF_REJECTED';
  reason: HyperliquidTestnetHandoffRejectionReason;
}>;

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const CLOID_PATTERN = /^0x[0-9a-f]{32}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function sameBinding(
  left: HyperliquidEvidenceMarketBinding,
  right: HyperliquidEvidenceMarketBinding,
): boolean {
  return left.spotUniverseIndex === right.spotUniverseIndex
    && left.spotTokenIndex === right.spotTokenIndex
    && left.perpetualAssetIndex === right.perpetualAssetIndex
    && left.quoteTokenIndex === right.quoteTokenIndex;
}

type CommitmentOrderTuple = readonly [
  number,
  boolean,
  string,
  string,
  boolean,
  'Ioc',
  `0x${string}`,
];

function commitmentOrderFields(value: unknown): CommitmentOrderTuple {
  if (value === null || typeof value !== 'object') {
    throw new Error('compiled package order is malformed');
  }
  const order = value as Record<string, unknown> & {
    readonly t?: { readonly limit?: { readonly tif?: unknown } };
  };
  const tif = order.t?.limit?.tif;
  if (tif !== 'Ioc') {
    throw new Error('compiled package action is not two HyperCore IOC orders');
  }
  if (typeof order.a !== 'number'
    || typeof order.b !== 'boolean'
    || typeof order.p !== 'string'
    || typeof order.s !== 'string'
    || typeof order.r !== 'boolean'
    || typeof order.c !== 'string') {
    throw new Error('compiled package order is malformed');
  }
  const c = order.c.toLowerCase();
  if (!CLOID_PATTERN.test(c)) {
    throw new Error('compiled client order ID is not a canonical 16-byte ID');
  }
  return [order.a, order.b, order.p, order.s, order.r, 'Ioc', c as `0x${string}`];
}

function recomputedActionHash(plan: HyperliquidExecutionPlan): `0x${string}` {
  const action = (plan as { readonly unsignedRequestFields?: { readonly action?: unknown } })
    .unsignedRequestFields?.action;
  if (action === null || typeof action !== 'object') {
    throw new Error('compiled package action is malformed');
  }
  const candidate = action as { readonly type?: unknown; readonly grouping?: unknown; readonly orders?: unknown };
  if (candidate.type !== 'order'
    || candidate.grouping !== 'na'
    || !Array.isArray(candidate.orders)
    || candidate.orders.length !== 2) {
    throw new Error('compiled package action is not two HyperCore IOC orders');
  }
  const firstFields = commitmentOrderFields(candidate.orders[0]);
  const secondFields = commitmentOrderFields(candidate.orders[1]);
  if (firstFields[6] === secondFields[6]) {
    throw new Error('compiled action client order IDs must differ');
  }
  const legs = (plan as { readonly legs?: unknown }).legs;
  if (!Array.isArray(legs) || legs.length !== 2) {
    throw new Error('execution plan must have exactly two legs');
  }
  const legFields: CommitmentOrderTuple[] = legs.map((leg) => {
    if (leg === null || typeof leg !== 'object') {
      throw new Error('planned leg is malformed');
    }
    const entry = leg as { readonly order?: unknown; readonly clientOrderId?: unknown };
    const fields = commitmentOrderFields(entry.order);
    if (typeof entry.clientOrderId !== 'string') {
      throw new Error('planned client order ID is malformed');
    }
    const clientOrderId = entry.clientOrderId.toLowerCase();
    if (!CLOID_PATTERN.test(clientOrderId)) {
      throw new Error('planned client order ID is not a canonical 16-byte ID');
    }
    if (clientOrderId !== fields[6]) {
      throw new Error('planned leg client order ID does not match its order');
    }
    return fields;
  });
  const firstLeg = legFields[0]!;
  const secondLeg = legFields[1]!;
  if (firstLeg[6] === secondLeg[6]) {
    throw new Error('planned client order IDs must differ');
  }
  const actionJson = [JSON.stringify(firstFields), JSON.stringify(secondFields)];
  const legJson = legFields.map((fields) => JSON.stringify(fields));
  for (const json of legJson) {
    if (actionJson.filter((entry) => entry === json).length !== 1) {
      throw new Error('compiled action and planned legs differ');
    }
  }
  for (const json of actionJson) {
    if (legJson.filter((entry) => entry === json).length !== 1) {
      throw new Error('compiled action and planned legs differ');
    }
  }
  return `0x${createHash('sha256').update(JSON.stringify([
    NARYX_HYPERCORE_ACTION_COMMITMENT_SCHEME,
    candidate.type,
    [Array.from(firstFields), Array.from(secondFields)],
    candidate.grouping,
  ])).digest('hex')}` as `0x${string}`;
}

function verifyHandoff(
  prepared: HyperliquidTestnetEvidenceRuntimeState,
  handoff: HyperliquidTestnetSubmissionHandoff,
  binding: HyperliquidEvidenceMarketBinding,
): HyperliquidTestnetHandoffRejectionReason | null {
  if (handoff.collector !== HYPERLIQUID_TESTNET_EVIDENCE_RECONCILIATION_COLLECTOR) {
    return 'UNKNOWN_COLLECTOR';
  }
  if (handoff.actionCommitmentScheme !== NARYX_HYPERCORE_ACTION_COMMITMENT_SCHEME) {
    return 'UNSUPPORTED_COMMITMENT_SCHEME';
  }
  if (typeof handoff.attemptId !== 'string' || !IDENTIFIER_PATTERN.test(handoff.attemptId)) {
    return 'INVALID_ATTEMPT_ID';
  }
  if (handoff.attemptId !== prepared.attemptId) return 'ATTEMPT_ID_MISMATCH';
  if (typeof handoff.durableRevision !== 'string' || !IDENTIFIER_PATTERN.test(handoff.durableRevision)) {
    return 'INVALID_DURABLE_REVISION';
  }
  if (typeof handoff.actionHash !== 'string' || !HASH_PATTERN.test(handoff.actionHash)) {
    return 'INVALID_ACTION_HASH';
  }
  if (handoff.actionHash !== prepared.actionHash) return 'ACTION_HASH_MISMATCH';
  if (typeof handoff.requestCommitment !== 'string' || !HASH_PATTERN.test(handoff.requestCommitment)) {
    return 'INVALID_REQUEST_COMMITMENT';
  }
  const account = handoff.account;
  if (!ADDRESS_PATTERN.test(account.masterAccount)
    || !ADDRESS_PATTERN.test(account.tradingAccount)
    || account.masterAccount.toLowerCase() !== prepared.attempt.account.masterAccount
    || account.tradingAccount.toLowerCase() !== prepared.attempt.account.tradingAccount
    || account.accountKind !== prepared.attempt.account.accountKind) {
    return 'ACCOUNT_MISMATCH';
  }
  const spot = handoff.spotClientOrderId.toLowerCase();
  const perpetual = handoff.perpetualClientOrderId.toLowerCase();
  if (spot !== prepared.attempt.plan.spotClientOrderId
    || perpetual !== prepared.attempt.plan.perpetualClientOrderId
    || spot === perpetual) {
    return 'CLIENT_ORDER_ID_MISMATCH';
  }
  if (!sameBinding(binding, prepared.binding)) return 'MARKET_BINDING_MISMATCH';
  return null;
}

export class HyperliquidTestnetEvidenceRuntime {
  readonly #collector: HyperliquidAuthoritativeEvidenceCollector;

  constructor(collector: HyperliquidAuthoritativeEvidenceCollector) {
    if (collector === null
      || typeof collector !== 'object'
      || typeof collector.captureCheckpoint !== 'function'
      || typeof collector.collectPackage !== 'function') {
      throw new Error('an authoritative evidence collector is required');
    }
    this.#collector = collector;
  }

  async prepare(
    input: HyperliquidTestnetEvidencePrepareInput,
  ): Promise<HyperliquidTestnetPrepareResult> {
    if (input === null || typeof input !== 'object') {
      throw new Error('prepare input is invalid');
    }
    const { attemptId, plan, account, binding, window } = input;
    if (typeof attemptId !== 'string' || !IDENTIFIER_PATTERN.test(attemptId)) {
      throw new Error('attemptId is invalid');
    }
    const actionHash = recomputedActionHash(plan);
    const attempt = createHyperliquidPackageAttempt(plan, account);
    const boundBinding: HyperliquidEvidenceMarketBinding = Object.freeze({ ...binding });
    const checkpoint = await this.#collector.captureCheckpoint(attempt, boundBinding, window);
    if (checkpoint.status === 'INCOMPLETE') {
      return Object.freeze({
        status: 'CHECKPOINT_INCOMPLETE' as const,
        reasons: checkpoint.reasons,
        rawResponseCommitments: checkpoint.rawResponseCommitments,
      });
    }
    return Object.freeze({
      status: 'PREPARED' as const,
      state: Object.freeze({
        attemptId,
        actionHash,
        attempt,
        checkpoint: checkpoint.checkpoint,
        binding: boundBinding,
      }),
    });
  }

  async reconcile(
    prepared: HyperliquidTestnetEvidenceRuntimeState,
    handoff: HyperliquidTestnetSubmissionHandoff,
    binding: HyperliquidEvidenceMarketBinding,
    window: HyperliquidEvidenceWindow,
  ): Promise<HyperliquidTestnetReconcileResult> {
    const rejection = verifyHandoff(prepared, handoff, binding);
    if (rejection !== null) {
      return Object.freeze({ status: 'HANDOFF_REJECTED' as const, reason: rejection });
    }
    const reconciling = beginHyperliquidReconciliation(
      markHyperliquidSubmissionUnknown(prepared.attempt),
    );
    const evidence = await this.#collector.collectPackage(
      reconciling,
      prepared.checkpoint,
      prepared.binding,
      window,
    );
    if (evidence.status === 'INCOMPLETE') {
      return Object.freeze({
        status: 'EVIDENCE_INCOMPLETE' as const,
        attempt: reconciling,
        reasons: evidence.reasons,
        accountObservation: evidence.accountObservation,
        observedFills: evidence.observedFills,
        rawResponseCommitments: evidence.rawResponseCommitments,
      });
    }
    const attempt = reconcileHyperliquidPackageAttempt(reconciling, evidence.input);
    return Object.freeze({
      status: 'RECONCILED' as const,
      attempt,
      accountObservation: evidence.accountObservation,
      observedFills: evidence.observedFills,
      rawResponseCommitments: evidence.rawResponseCommitments,
    });
  }
}
