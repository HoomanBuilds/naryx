import {
  assetRef,
  bytesEqual,
  domainRef,
  hash32,
  manifestHash,
  type AssetRef,
  type ManifestHash,
  type RecoveryAction,
} from '@naryx/protocol-types';
import type {
  HyperliquidAccountIdentity,
  HyperliquidLegTerminalStatus,
  HyperliquidOpenOrderStatus,
  HyperliquidPackageAttempt,
} from './index.js';
import type {
  HyperliquidRecoveryExecutionPlan,
  HyperliquidRecoveryPlannedOrder,
} from './hyperliquid-recovery-compiler.js';
import {
  absolute,
  sameAccount,
  sameAsset,
  sameCommitments,
  sameDomain,
  validateHyperliquidRecoveryContinuationExecutionPlan,
  validateHyperliquidRecoveryExecutionPlan,
  type HyperliquidRecoveryVerifierIdentity,
} from './hyperliquid-recovery-validation.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CLOID = /^0x[0-9a-fA-F]{32}$/;
const U32_MAX = 0xffff_ffff;

export const HYPERCORE_RECOVERY_RECONCILIATION_SOURCE =
  'HYPERCORE_ACCOUNT_RECOVERY_RECONCILIATION';

// Terminal values use the canonical terminal-state names. A paired rollback that restores the
// pre-package state is RECOVERED_FLAT: terminal, but never a successful package receipt.
export type HyperliquidRecoveryOutcome =
  | 'RECONCILING'
  | 'RECOVERED_COMPLETE'
  | 'RECOVERED_BOUNDED'
  | 'RECOVERED_FLAT'
  | 'RECOVERY_REQUIRED'
  | 'MANUAL_INTERVENTION';

const TERMINAL_RECOVERY_OUTCOMES: ReadonlySet<HyperliquidRecoveryOutcome> = new Set([
  'RECOVERED_COMPLETE',
  'RECOVERED_BOUNDED',
  'RECOVERED_FLAT',
]);

/** Only completed recoveries (exact or bounded) produce a successful package receipt. */
export function recoveryIssuesSuccessfulReceipt(outcome: HyperliquidRecoveryOutcome): boolean {
  return outcome === 'RECOVERED_COMPLETE' || outcome === 'RECOVERED_BOUNDED';
}

export type HyperliquidRecoveryReason =
  | 'INCOMPLETE_RECOVERY'
  | 'IDENTITY_MISMATCH'
  | 'STALE_EVIDENCE'
  | 'CONFLICTING_TERMINAL_EVIDENCE'
  | 'OPEN_OR_UNCERTAIN_RECOVERY_ORDER'
  | 'UNCERTAIN_COST_EVIDENCE'
  | 'EVIDENCE_INCONSISTENT'
  | 'RECOVERY_COST_CAP_BREACH'
  | 'AGGREGATE_LOSS_CAP_BREACH'
  | 'INTERMEDIATE_RESIDUAL_BREACH'
  | 'TERMINAL_POLICY_BREACH'
  | 'RECOVERY_WINDOW_CLOSED'
  | 'NO_PERMITTED_RECOVERY';

export interface HyperliquidRecoveryOrderEvidenceInput {
  readonly clientOrderId: `0x${string}`;
  readonly terminalStatus: HyperliquidLegTerminalStatus;
  readonly openOrderStatus: HyperliquidOpenOrderStatus;
  readonly filledSignedBaseAtoms: bigint;
}

export interface HyperliquidRecoveryAmountEvidenceInput {
  readonly asset: AssetRef;
  readonly amountAtoms: bigint;
  readonly evidenceStatus: 'CONFIRMED' | 'UNCERTAIN';
}

export interface HyperliquidRecoveryReconciliationSnapshotInput {
  readonly source: typeof HYPERCORE_RECOVERY_RECONCILIATION_SOURCE;
  readonly domain: HyperliquidRecoveryExecutionPlan['domain'];
  readonly commitments: HyperliquidRecoveryExecutionPlan['commitments'];
  readonly account: HyperliquidAccountIdentity;
  readonly reconciledStateSchemaHash: ManifestHash;
  readonly sourceEvidenceVersion: bigint;
  readonly recoverySequence: number;
  readonly evidenceVersion: bigint;
  readonly observedAtMs: bigint;
  readonly recoveryOrders: readonly HyperliquidRecoveryOrderEvidenceInput[];
  readonly netSpotBalanceDeltaAtoms: bigint;
  readonly perpetualPositionDeltaAtoms: bigint;
  readonly observedPerpetualPositionAtoms: bigint;
  readonly perpetualPositionTargetAtoms: bigint;
  readonly costEvidenceComplete: boolean;
  readonly fees: readonly HyperliquidRecoveryAmountEvidenceInput[];
  readonly actualRecoveryCosts: readonly HyperliquidRecoveryAmountEvidenceInput[];
  readonly actualAggregateLoss: HyperliquidRecoveryAmountEvidenceInput;
}

export interface HyperliquidRecoveryOrderEvidence {
  readonly clientOrderId: `0x${string}`;
  readonly terminalStatus: HyperliquidLegTerminalStatus;
  readonly openOrderStatus: HyperliquidOpenOrderStatus;
  readonly filledSignedBaseAtoms: bigint;
}

export interface HyperliquidRecoveryAmountEvidence {
  readonly asset: AssetRef;
  readonly amountAtoms: bigint;
  readonly evidenceStatus: 'CONFIRMED' | 'UNCERTAIN';
}

export interface HyperliquidRecoveryReconciliationSnapshot
  extends Omit<HyperliquidRecoveryReconciliationSnapshotInput,
  'domain' | 'commitments' | 'account' | 'reconciledStateSchemaHash' | 'recoveryOrders'
  | 'fees' | 'actualRecoveryCosts' | 'actualAggregateLoss'> {
  readonly domain: HyperliquidRecoveryExecutionPlan['domain'];
  readonly commitments: HyperliquidRecoveryExecutionPlan['commitments'];
  readonly account: HyperliquidAccountIdentity;
  readonly reconciledStateSchemaHash: ManifestHash;
  readonly recoveryOrders: readonly HyperliquidRecoveryOrderEvidence[];
  readonly fees: readonly HyperliquidRecoveryAmountEvidence[];
  readonly actualRecoveryCosts: readonly HyperliquidRecoveryAmountEvidence[];
  readonly actualAggregateLoss: HyperliquidRecoveryAmountEvidence;
}

export interface HyperliquidNextRecoveryAction {
  readonly action: Exclude<RecoveryAction, 'CANCEL_OPEN_ORDERS'>;
  readonly role: 'SPOT' | 'PERPETUAL';
  readonly signedBaseDeltaAtoms: bigint;
}

export interface HyperliquidNextRecoveryObligation {
  readonly domain: HyperliquidRecoveryExecutionPlan['domain'];
  readonly commitments: HyperliquidRecoveryExecutionPlan['commitments'];
  readonly account: HyperliquidAccountIdentity;
  readonly sourceEvidenceVersion: bigint;
  readonly recoverySequence: number;
  readonly mode: HyperliquidRecoveryExecutionPlan['mode'];
  readonly actions: readonly HyperliquidNextRecoveryAction[];
  readonly remainingRecoveryCostCaps: readonly Readonly<{ asset: AssetRef; atoms: bigint }>[];
  readonly remainingAggregateLoss: Readonly<{ asset: AssetRef; atoms: bigint }>;
  readonly actionExpiryMs: bigint;
  readonly recoveryDeadlineMs: bigint;
}

export interface HyperliquidRecoveryAttempt {
  readonly version: 1;
  readonly status: HyperliquidRecoveryOutcome;
  readonly sourceAttempt: HyperliquidPackageAttempt;
  readonly plan: HyperliquidRecoveryExecutionPlan;
  readonly reasons: readonly HyperliquidRecoveryReason[];
  readonly acceptedEvidence: HyperliquidRecoveryReconciliationSnapshot | null;
  readonly lockEvidence: HyperliquidRecoveryReconciliationSnapshot | null;
  readonly nextRecoveryObligation: HyperliquidNextRecoveryObligation | null;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizedAccount(input: HyperliquidAccountIdentity): HyperliquidAccountIdentity {
  requireCondition(ADDRESS.test(input.masterAccount) && ADDRESS.test(input.tradingAccount),
    'recovery evidence account address is invalid');
  const masterAccount = input.masterAccount.toLowerCase() as `0x${string}`;
  const tradingAccount = input.tradingAccount.toLowerCase() as `0x${string}`;
  requireCondition(input.accountKind === 'MASTER' || input.accountKind === 'SUBACCOUNT',
    'recovery evidence account kind is invalid');
  requireCondition(input.accountKind === 'MASTER'
    ? masterAccount === tradingAccount
    : masterAccount !== tradingAccount,
  'recovery evidence account relationship is invalid');
  return Object.freeze({ masterAccount, tradingAccount, accountKind: input.accountKind });
}

function normalizedOrder(
  input: HyperliquidRecoveryOrderEvidenceInput,
  index: number,
): HyperliquidRecoveryOrderEvidence {
  requireCondition(CLOID.test(input.clientOrderId),
    `recoveryOrders[${index}].clientOrderId is invalid`);
  requireCondition(input.terminalStatus === 'FILLED'
    || input.terminalStatus === 'PARTIALLY_FILLED_IOC_CANCELLED'
    || input.terminalStatus === 'UNFILLED_IOC_CANCELLED'
    || input.terminalStatus === 'REJECTED'
    || input.terminalStatus === 'UNKNOWN',
  `recoveryOrders[${index}].terminalStatus is invalid`);
  requireCondition(input.openOrderStatus === 'NONE'
    || input.openOrderStatus === 'OPEN'
    || input.openOrderStatus === 'UNKNOWN',
  `recoveryOrders[${index}].openOrderStatus is invalid`);
  return Object.freeze({
    clientOrderId: input.clientOrderId.toLowerCase() as `0x${string}`,
    terminalStatus: input.terminalStatus,
    openOrderStatus: input.openOrderStatus,
    filledSignedBaseAtoms: input.filledSignedBaseAtoms,
  });
}

function normalizedAmount(
  input: HyperliquidRecoveryAmountEvidenceInput,
  context: string,
  requireNonnegative = true,
): HyperliquidRecoveryAmountEvidence {
  requireCondition(!requireNonnegative || input.amountAtoms >= 0n,
    `${context}.amountAtoms must be nonnegative`);
  requireCondition(input.evidenceStatus === 'CONFIRMED' || input.evidenceStatus === 'UNCERTAIN',
    `${context}.evidenceStatus is invalid`);
  return Object.freeze({
    asset: assetRef(
      input.asset.assetId,
      input.asset.assetManifestHash,
      input.asset.decimals,
      `${context}.asset`,
    ),
    amountAtoms: input.amountAtoms,
    evidenceStatus: input.evidenceStatus,
  });
}

function normalizedSnapshot(
  input: HyperliquidRecoveryReconciliationSnapshotInput,
): HyperliquidRecoveryReconciliationSnapshot {
  requireCondition(input.source === HYPERCORE_RECOVERY_RECONCILIATION_SOURCE,
    'only authoritative HyperCore recovery evidence is accepted');
  requireCondition(Number.isInteger(input.recoverySequence)
    && input.recoverySequence >= 0 && input.recoverySequence <= U32_MAX,
  'recovery evidence sequence must fit u32');
  return Object.freeze({
    source: input.source,
    domain: domainRef(
      input.domain.domainId,
      input.domain.domainManifestVersion,
      input.domain.domainManifestHash,
      'recoveryEvidence.domain',
    ),
    commitments: Object.freeze({
      seriesManifestHash: manifestHash(
        input.commitments.seriesManifestHash,
        'recoveryEvidence.commitments.seriesManifestHash',
      ),
      executionClassManifestHash: manifestHash(
        input.commitments.executionClassManifestHash,
        'recoveryEvidence.commitments.executionClassManifestHash',
      ),
      orderHash: hash32(input.commitments.orderHash, 'recoveryEvidence.commitments.orderHash'),
      quoteHash: hash32(input.commitments.quoteHash, 'recoveryEvidence.commitments.quoteHash'),
      routeHash: hash32(input.commitments.routeHash, 'recoveryEvidence.commitments.routeHash'),
    }),
    account: normalizedAccount(input.account),
    reconciledStateSchemaHash: manifestHash(
      input.reconciledStateSchemaHash,
      'recoveryEvidence.reconciledStateSchemaHash',
    ),
    sourceEvidenceVersion: input.sourceEvidenceVersion,
    recoverySequence: input.recoverySequence,
    evidenceVersion: input.evidenceVersion,
    observedAtMs: input.observedAtMs,
    recoveryOrders: Object.freeze(input.recoveryOrders.map(normalizedOrder)),
    netSpotBalanceDeltaAtoms: input.netSpotBalanceDeltaAtoms,
    perpetualPositionDeltaAtoms: input.perpetualPositionDeltaAtoms,
    observedPerpetualPositionAtoms: input.observedPerpetualPositionAtoms,
    perpetualPositionTargetAtoms: input.perpetualPositionTargetAtoms,
    costEvidenceComplete: input.costEvidenceComplete,
    fees: Object.freeze(input.fees.map(
      (value, index) => normalizedAmount(value, `fees[${index}]`, false),
    )),
    actualRecoveryCosts: Object.freeze(input.actualRecoveryCosts.map(
      (value, index) => normalizedAmount(value, `actualRecoveryCosts[${index}]`),
    )),
    actualAggregateLoss: normalizedAmount(input.actualAggregateLoss, 'actualAggregateLoss'),
  });
}

function stableValue(value: unknown): unknown {
  if (typeof value === 'bigint') return { bigint: value.toString() };
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function evidencePayload(evidence: HyperliquidRecoveryReconciliationSnapshot): string {
  const { evidenceVersion: _evidenceVersion, observedAtMs: _observedAtMs, ...payload } = evidence;
  return JSON.stringify(stableValue(payload));
}

function sameEvidence(
  left: HyperliquidRecoveryReconciliationSnapshot,
  right: HyperliquidRecoveryReconciliationSnapshot,
): boolean {
  return left.evidenceVersion === right.evidenceVersion
    && left.observedAtMs === right.observedAtMs
    && evidencePayload(left) === evidencePayload(right);
}

function sameEvidencePayload(
  left: HyperliquidRecoveryReconciliationSnapshot,
  right: HyperliquidRecoveryReconciliationSnapshot,
): boolean {
  return evidencePayload(left) === evidencePayload(right);
}

function withOutcome(
  attempt: HyperliquidRecoveryAttempt,
  status: HyperliquidRecoveryOutcome,
  reasons: readonly HyperliquidRecoveryReason[],
  acceptedEvidence: HyperliquidRecoveryReconciliationSnapshot | null,
  lockEvidence: HyperliquidRecoveryReconciliationSnapshot | null,
  nextRecoveryObligation: HyperliquidNextRecoveryObligation | null,
): HyperliquidRecoveryAttempt {
  return Object.freeze({
    version: 1,
    status,
    sourceAttempt: attempt.sourceAttempt,
    plan: attempt.plan,
    reasons: Object.freeze([...reasons]),
    acceptedEvidence,
    lockEvidence,
    nextRecoveryObligation,
  });
}

function manual(
  attempt: HyperliquidRecoveryAttempt,
  reason: HyperliquidRecoveryReason,
  evidence: HyperliquidRecoveryReconciliationSnapshot,
): HyperliquidRecoveryAttempt {
  return withOutcome(attempt, 'MANUAL_INTERVENTION', [reason],
    attempt.acceptedEvidence, evidence, null);
}

function terminalStatusConsistent(
  status: HyperliquidLegTerminalStatus,
  fill: bigint,
  planned: bigint,
): boolean {
  const filled = absolute(fill);
  const maximum = absolute(planned);
  if (status === 'FILLED') return fill === planned;
  if (status === 'PARTIALLY_FILLED_IOC_CANCELLED') {
    return filled > 0n && filled < maximum && (fill > 0n) === (planned > 0n);
  }
  if (status === 'UNFILLED_IOC_CANCELLED' || status === 'REJECTED') return fill === 0n;
  return true;
}

function recoveryOrderEvidence(
  plan: HyperliquidRecoveryExecutionPlan,
  evidence: HyperliquidRecoveryReconciliationSnapshot,
): readonly Readonly<{
  plan: HyperliquidRecoveryPlannedOrder;
  evidence: HyperliquidRecoveryOrderEvidence;
}>[] | null {
  if (evidence.recoveryOrders.length !== plan.orders.length) return null;
  const matched = plan.orders.map((order) => {
    const candidates = evidence.recoveryOrders.filter(
      (item) => item.clientOrderId === order.clientOrderId.toLowerCase(),
    );
    return candidates.length === 1 ? Object.freeze({ plan: order, evidence: candidates[0]! }) : null;
  });
  return matched.every((item) => item !== null)
    ? matched as readonly Readonly<{
        plan: HyperliquidRecoveryPlannedOrder;
        evidence: HyperliquidRecoveryOrderEvidence;
      }>[]
    : null;
}

function maximumIntermediateResidual(
  initialSpot: bigint,
  initialPerpetual: bigint,
  orders: readonly Readonly<{
    plan: HyperliquidRecoveryPlannedOrder;
    evidence: HyperliquidRecoveryOrderEvidence;
  }>[],
): bigint {
  let maximum = absolute(initialSpot + initialPerpetual);
  for (let mask = 1; mask < (1 << orders.length); mask += 1) {
    let spot = initialSpot;
    let perpetual = initialPerpetual;
    for (let index = 0; index < orders.length; index += 1) {
      if ((mask & (1 << index)) === 0) continue;
      const order = orders[index]!;
      if (order.plan.role === 'SPOT') spot += order.evidence.filledSignedBaseAtoms;
      else perpetual += order.evidence.filledSignedBaseAtoms;
    }
    const residual = absolute(spot + perpetual);
    if (residual > maximum) maximum = residual;
  }
  return maximum;
}

export function hyperliquidRecoveryResidualQuoteAtoms(
  baseResidualAtoms: bigint,
  attempt: HyperliquidPackageAttempt,
): bigint {
  const terminal = attempt.plan.terminalResidualPolicy;
  requireCondition(terminal.kind === 'BOUNDED_NET', 'bounded residual valuation is unavailable');
  const numerator = baseResidualAtoms * terminal.residualValuationReferencePrice.quoteAtoms;
  const denominator = terminal.residualValuationReferencePrice.baseAtoms;
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

function actionSlot(
  source: HyperliquidPackageAttempt,
  action: Exclude<RecoveryAction, 'CANCEL_OPEN_ORDERS'>,
): HyperliquidPackageAttempt['plan']['recoveryPolicy']['actionSlots'][number] | null {
  const slots = source.plan.recoveryPolicy.actionSlots.filter((slot) => slot.action === action);
  return slots.length === 1 ? slots[0]! : null;
}

function safeAction(
  source: HyperliquidPackageAttempt,
  action: Exclude<RecoveryAction, 'CANCEL_OPEN_ORDERS'>,
  role: 'SPOT' | 'PERPETUAL',
  delta: bigint,
  currentPerpetualPositionAtoms: bigint,
  finalPerpetualPositionAtoms: bigint,
): HyperliquidNextRecoveryAction | null {
  const leg = source.plan.legs.find((candidate) => candidate.role === role);
  const slot = actionSlot(source, action);
  if (leg === undefined || slot === null || slot.targetLeg !== leg.legIndex
    || slot.maxQuantity === undefined || slot.reduceOnly === undefined
    || absolute(delta) > slot.maxQuantity.atoms || delta === 0n) return null;
  if (role === 'SPOT') {
    if (slot.reduceOnly) return null;
  } else {
    const next = currentPerpetualPositionAtoms + delta;
    if (next !== finalPerpetualPositionAtoms
      || (currentPerpetualPositionAtoms !== 0n && next !== 0n
        && (currentPerpetualPositionAtoms > 0n) !== (next > 0n))) return null;
    const reduces = absolute(next) < absolute(currentPerpetualPositionAtoms);
    if (slot.reduceOnly !== reduces
      || (slot.reduceOnly && absolute(delta) > absolute(currentPerpetualPositionAtoms))) return null;
  }
  return Object.freeze({ action, role, signedBaseDeltaAtoms: delta });
}

function candidateWithinResidualBounds(
  source: HyperliquidPackageAttempt,
  evidence: HyperliquidRecoveryReconciliationSnapshot,
  actions: readonly HyperliquidNextRecoveryAction[],
  mode: HyperliquidRecoveryExecutionPlan['mode'],
): boolean {
  const initialSpot = evidence.netSpotBalanceDeltaAtoms;
  const initialPerpetual = evidence.perpetualPositionDeltaAtoms;
  let terminalSpot = initialSpot;
  let terminalPerpetual = initialPerpetual;
  let maximum = absolute(initialSpot + initialPerpetual);
  for (let mask = 1; mask < (1 << actions.length); mask += 1) {
    let spot = initialSpot;
    let perpetual = initialPerpetual;
    for (let index = 0; index < actions.length; index += 1) {
      if ((mask & (1 << index)) === 0) continue;
      const action = actions[index]!;
      if (action.role === 'SPOT') spot += action.signedBaseDeltaAtoms;
      else perpetual += action.signedBaseDeltaAtoms;
    }
    const residual = absolute(spot + perpetual);
    if (residual > maximum) maximum = residual;
  }
  for (const action of actions) {
    if (action.role === 'SPOT') terminalSpot += action.signedBaseDeltaAtoms;
    else terminalPerpetual += action.signedBaseDeltaAtoms;
  }
  if (maximum > source.plan.recoveryPolicy.maxIntermediateResidual.atoms) return false;
  const terminalResidual = absolute(terminalSpot + terminalPerpetual);
  if (terminalResidual > source.plan.recoveryPolicy.maxTerminalResidual.atoms) return false;
  if (mode === 'PAIRED_ROLLBACK') return terminalSpot === 0n && terminalPerpetual === 0n;
  const terminal = source.plan.terminalResidualPolicy;
  if (terminal.kind === 'EXACT_NET') {
    return terminalSpot === terminal.netSpotDeltaAtoms && terminalResidual === 0n;
  }
  return terminalSpot >= terminal.minNetSpotDeltaAtoms
    && terminalSpot <= terminal.maxNetSpotDeltaAtoms
    && terminalResidual <= terminal.maxTerminalResidualBaseAtoms
    && hyperliquidRecoveryResidualQuoteAtoms(terminalResidual, source)
      <= terminal.maxTerminalResidualQuoteAtoms;
}

function nextRecoveryActions(
  attempt: HyperliquidRecoveryAttempt,
  evidence: HyperliquidRecoveryReconciliationSnapshot,
): Readonly<{
  mode: HyperliquidRecoveryExecutionPlan['mode'];
  actions: readonly HyperliquidNextRecoveryAction[];
}> | null {
  const source = attempt.sourceAttempt;
  const currentPosition = evidence.observedPerpetualPositionAtoms;
  const completion: HyperliquidNextRecoveryAction[] = [];
  if (evidence.netSpotBalanceDeltaAtoms === source.plan.plannedSpotDeltaAtoms
    && evidence.perpetualPositionDeltaAtoms !== source.plan.plannedPerpetualDeltaAtoms) {
    const action = safeAction(
      source,
      'COMPLETE_PERP',
      'PERPETUAL',
      source.plan.plannedPerpetualDeltaAtoms - evidence.perpetualPositionDeltaAtoms,
      currentPosition,
      source.plan.perpetualPositionTargetAtoms,
    );
    if (action !== null) completion.push(action);
  } else if (evidence.perpetualPositionDeltaAtoms === source.plan.plannedPerpetualDeltaAtoms
    && evidence.netSpotBalanceDeltaAtoms !== source.plan.plannedSpotDeltaAtoms) {
    const action = safeAction(
      source,
      'COMPLETE_SPOT',
      'SPOT',
      source.plan.plannedSpotDeltaAtoms - evidence.netSpotBalanceDeltaAtoms,
      currentPosition,
      source.plan.perpetualPositionTargetAtoms,
    );
    if (action !== null) completion.push(action);
  }
  if (completion.length === 1
    && candidateWithinResidualBounds(source, evidence, completion, 'COMPLETE_MISSING_LEG')) {
    return Object.freeze({ mode: 'COMPLETE_MISSING_LEG', actions: Object.freeze(completion) });
  }

  const rollback: HyperliquidNextRecoveryAction[] = [];
  if (evidence.netSpotBalanceDeltaAtoms !== 0n) {
    const action = safeAction(source, 'ROLLBACK_SPOT', 'SPOT',
      -evidence.netSpotBalanceDeltaAtoms, currentPosition, source.plan.prePerpetualPositionAtoms);
    if (action === null) return null;
    rollback.push(action);
  }
  if (evidence.perpetualPositionDeltaAtoms !== 0n) {
    const action = safeAction(source, 'ROLLBACK_PERP', 'PERPETUAL',
      -evidence.perpetualPositionDeltaAtoms, currentPosition,
      source.plan.prePerpetualPositionAtoms);
    if (action === null) return null;
    rollback.push(action);
  }
  rollback.sort((left, right) => actionSlot(source, left.action)!.sequence
    - actionSlot(source, right.action)!.sequence);
  return rollback.length > 0
    && candidateWithinResidualBounds(source, evidence, rollback, 'PAIRED_ROLLBACK')
    ? Object.freeze({ mode: 'PAIRED_ROLLBACK', actions: Object.freeze(rollback) })
    : null;
}

function nextObligation(
  attempt: HyperliquidRecoveryAttempt,
  evidence: HyperliquidRecoveryReconciliationSnapshot,
): HyperliquidNextRecoveryObligation | HyperliquidRecoveryReason {
  if (evidence.observedAtMs >= attempt.plan.actionExpiryMs
    || evidence.observedAtMs >= attempt.plan.recoveryDeadlineMs
    || attempt.plan.recoverySequence === U32_MAX) return 'RECOVERY_WINDOW_CLOSED';
  const next = nextRecoveryActions(attempt, evidence);
  if (next === null) return 'NO_PERMITTED_RECOVERY';
  const caps = attempt.sourceAttempt.plan.recoveryPolicy.maxRecoveryCostCaps;
  return Object.freeze({
    domain: attempt.plan.domain,
    commitments: attempt.plan.commitments,
    account: attempt.plan.account,
    sourceEvidenceVersion: evidence.evidenceVersion,
    recoverySequence: attempt.plan.recoverySequence + 1,
    mode: next.mode,
    actions: next.actions,
    remainingRecoveryCostCaps: Object.freeze(caps.map((cap) => Object.freeze({
      asset: cap.asset,
      atoms: cap.maxAtoms - evidence.actualRecoveryCosts.find(
        (cost) => sameAsset(cost.asset, cap.asset),
      )!.amountAtoms,
    }))),
    remainingAggregateLoss: Object.freeze({
      asset: attempt.sourceAttempt.plan.recoveryPolicy.maxAggregateRecoveryLoss.asset,
      atoms: attempt.sourceAttempt.plan.recoveryPolicy.maxAggregateRecoveryLoss.atoms
        - evidence.actualAggregateLoss.amountAtoms,
    }),
    actionExpiryMs: attempt.plan.actionExpiryMs,
    recoveryDeadlineMs: attempt.plan.recoveryDeadlineMs,
  });
}

function recoveryAttempt(
  sourceAttempt: HyperliquidPackageAttempt,
  plan: HyperliquidRecoveryExecutionPlan,
): HyperliquidRecoveryAttempt {
  return Object.freeze({
    version: 1,
    status: 'RECONCILING',
    sourceAttempt: structuredClone(sourceAttempt),
    plan: structuredClone(plan),
    reasons: Object.freeze([]),
    acceptedEvidence: null,
    lockEvidence: null,
    nextRecoveryObligation: null,
  });
}

export function createHyperliquidRecoveryAttempt(
  sourceAttempt: HyperliquidPackageAttempt,
  plan: HyperliquidRecoveryExecutionPlan,
  identity: HyperliquidRecoveryVerifierIdentity,
  nowMs: bigint,
): HyperliquidRecoveryAttempt {
  validateHyperliquidRecoveryExecutionPlan(sourceAttempt, plan, identity, nowMs);
  return recoveryAttempt(sourceAttempt, plan);
}

export function createHyperliquidRecoveryContinuationAttempt(
  previousAttempt: HyperliquidRecoveryAttempt,
  plan: HyperliquidRecoveryExecutionPlan,
  identity: HyperliquidRecoveryVerifierIdentity,
  nowMs: bigint,
): HyperliquidRecoveryAttempt {
  validateHyperliquidRecoveryContinuationExecutionPlan(
    previousAttempt,
    plan,
    identity,
    nowMs,
  );
  return recoveryAttempt(previousAttempt.sourceAttempt, plan);
}

function terminalOutcome(
  attempt: HyperliquidRecoveryAttempt,
  evidence: HyperliquidRecoveryReconciliationSnapshot,
): 'RECOVERED_COMPLETE' | 'RECOVERED_BOUNDED' | 'RECOVERED_FLAT' | null {
  const residual = absolute(
    evidence.netSpotBalanceDeltaAtoms + evidence.perpetualPositionDeltaAtoms,
  );
  if (attempt.plan.mode === 'PAIRED_ROLLBACK') {
    return evidence.netSpotBalanceDeltaAtoms === 0n
      && evidence.perpetualPositionDeltaAtoms === 0n
      && evidence.observedPerpetualPositionAtoms
        === attempt.sourceAttempt.plan.prePerpetualPositionAtoms
      && evidence.perpetualPositionTargetAtoms
        === attempt.sourceAttempt.plan.prePerpetualPositionAtoms
      ? 'RECOVERED_FLAT'
      : null;
  }
  if (evidence.observedPerpetualPositionAtoms
      !== attempt.sourceAttempt.plan.perpetualPositionTargetAtoms
    || evidence.perpetualPositionTargetAtoms
      !== attempt.sourceAttempt.plan.perpetualPositionTargetAtoms) return null;
  const terminal = attempt.sourceAttempt.plan.terminalResidualPolicy;
  if (terminal.kind === 'EXACT_NET') {
    return evidence.netSpotBalanceDeltaAtoms === terminal.netSpotDeltaAtoms && residual === 0n
      ? 'RECOVERED_COMPLETE'
      : null;
  }
  return evidence.netSpotBalanceDeltaAtoms >= terminal.minNetSpotDeltaAtoms
    && evidence.netSpotBalanceDeltaAtoms <= terminal.maxNetSpotDeltaAtoms
    && residual <= terminal.maxTerminalResidualBaseAtoms
    && hyperliquidRecoveryResidualQuoteAtoms(residual, attempt.sourceAttempt)
      <= terminal.maxTerminalResidualQuoteAtoms
    ? 'RECOVERED_BOUNDED'
    : null;
}

export function reconcileHyperliquidRecovery(
  attempt: HyperliquidRecoveryAttempt,
  input: HyperliquidRecoveryReconciliationSnapshotInput,
): HyperliquidRecoveryAttempt {
  const evidence = normalizedSnapshot(input);
  if (attempt.lockEvidence !== null && sameEvidence(attempt.lockEvidence, evidence)) return attempt;
  if (attempt.acceptedEvidence !== null
    && (sameEvidence(attempt.acceptedEvidence, evidence)
      || sameEvidencePayload(attempt.acceptedEvidence, evidence))) return attempt;
  if (attempt.status === 'MANUAL_INTERVENTION') return attempt;
  if (TERMINAL_RECOVERY_OUTCOMES.has(attempt.status)) {
    return manual(attempt, 'CONFLICTING_TERMINAL_EVIDENCE', evidence);
  }
  if (attempt.acceptedEvidence !== null
    && (evidence.evidenceVersion <= attempt.acceptedEvidence.evidenceVersion
      || evidence.observedAtMs <= attempt.acceptedEvidence.observedAtMs)) {
    return manual(attempt, 'STALE_EVIDENCE', evidence);
  }
  if (evidence.evidenceVersion <= attempt.plan.sourceEvidenceVersion
    || evidence.observedAtMs <= attempt.plan.baseline.observedAtMs) {
    return manual(attempt, 'STALE_EVIDENCE', evidence);
  }
  if (!sameDomain(evidence.domain, attempt.plan.domain)
    || !sameCommitments(evidence.commitments, attempt.plan.commitments)
    || !sameAccount(evidence.account, attempt.plan.account)
    || !bytesEqual(evidence.reconciledStateSchemaHash, attempt.plan.reconciledStateSchemaHash)
    || evidence.sourceEvidenceVersion !== attempt.plan.sourceEvidenceVersion
    || evidence.recoverySequence !== attempt.plan.recoverySequence) {
    return manual(attempt, 'IDENTITY_MISMATCH', evidence);
  }
  const orders = recoveryOrderEvidence(attempt.plan, evidence);
  if (orders === null) return manual(attempt, 'IDENTITY_MISMATCH', evidence);
  if (orders.some(({ evidence: order }) => order.terminalStatus === 'UNKNOWN'
    || order.openOrderStatus !== 'NONE')) {
    return manual(attempt, 'OPEN_OR_UNCERTAIN_RECOVERY_ORDER', evidence);
  }
  if (orders.some(({ plan, evidence: order }) => !terminalStatusConsistent(
    order.terminalStatus,
    order.filledSignedBaseAtoms,
    plan.signedBaseDeltaAtoms,
  ))) return manual(attempt, 'EVIDENCE_INCONSISTENT', evidence);

  const recoverySpotFill = orders.filter(({ plan }) => plan.role === 'SPOT')
    .reduce((total, { evidence: order }) => total + order.filledSignedBaseAtoms, 0n);
  const recoveryPerpetualFill = orders.filter(({ plan }) => plan.role === 'PERPETUAL')
    .reduce((total, { evidence: order }) => total + order.filledSignedBaseAtoms, 0n);
  // A recovery spot buy pays its taker fee in the base asset, as the source entry did.
  const baseAsset = attempt.sourceAttempt.plan.legs[0].baseAsset;
  const recoveryBaseFee = evidence.fees.filter((fee) => sameAsset(fee.asset, baseAsset))
    .reduce((total, fee) => total + fee.amountAtoms, 0n);
  if (evidence.netSpotBalanceDeltaAtoms
      !== attempt.plan.baseline.netSpotDeltaAtoms + recoverySpotFill - recoveryBaseFee
    || evidence.perpetualPositionDeltaAtoms
      !== attempt.plan.baseline.perpetualPositionDeltaAtoms + recoveryPerpetualFill
    || evidence.observedPerpetualPositionAtoms
      !== attempt.sourceAttempt.plan.prePerpetualPositionAtoms
        + evidence.perpetualPositionDeltaAtoms
    || evidence.perpetualPositionTargetAtoms !== (attempt.plan.mode === 'PAIRED_ROLLBACK'
      ? attempt.sourceAttempt.plan.prePerpetualPositionAtoms
      : attempt.sourceAttempt.plan.perpetualPositionTargetAtoms)) {
    return manual(attempt, 'EVIDENCE_INCONSISTENT', evidence);
  }
  if (!evidence.costEvidenceComplete
    || evidence.fees.some((fee) => fee.evidenceStatus !== 'CONFIRMED')
    || evidence.actualRecoveryCosts.some((cost) => cost.evidenceStatus !== 'CONFIRMED')
    || evidence.actualAggregateLoss.evidenceStatus !== 'CONFIRMED') {
    return manual(attempt, 'UNCERTAIN_COST_EVIDENCE', evidence);
  }
  const caps = attempt.sourceAttempt.plan.recoveryPolicy.maxRecoveryCostCaps;
  if (evidence.actualRecoveryCosts.length !== caps.length
    || caps.some((cap) => evidence.actualRecoveryCosts.filter(
      (cost) => sameAsset(cost.asset, cap.asset),
    ).length !== 1)) return manual(attempt, 'UNCERTAIN_COST_EVIDENCE', evidence);
  for (const cap of caps) {
    const cost = evidence.actualRecoveryCosts.find((value) => sameAsset(value.asset, cap.asset))!;
    const feeTotal = evidence.fees.filter((fee) => sameAsset(fee.asset, cap.asset))
      .reduce((total, fee) => total + fee.amountAtoms, 0n);
    if (cost.amountAtoms > cap.maxAtoms || feeTotal > cost.amountAtoms) {
      return manual(attempt, 'RECOVERY_COST_CAP_BREACH', evidence);
    }
  }
  if (evidence.fees.some((fee) => !caps.some((cap) => sameAsset(fee.asset, cap.asset)))) {
    return manual(attempt, 'RECOVERY_COST_CAP_BREACH', evidence);
  }
  const lossCap = attempt.sourceAttempt.plan.recoveryPolicy.maxAggregateRecoveryLoss;
  if (!sameAsset(evidence.actualAggregateLoss.asset, lossCap.asset)
    || evidence.actualAggregateLoss.amountAtoms > lossCap.atoms) {
    return manual(attempt, 'AGGREGATE_LOSS_CAP_BREACH', evidence);
  }
  if (maximumIntermediateResidual(
    attempt.plan.baseline.netSpotDeltaAtoms,
    attempt.plan.baseline.perpetualPositionDeltaAtoms,
    orders,
  ) > attempt.sourceAttempt.plan.recoveryPolicy.maxIntermediateResidual.atoms) {
    return manual(attempt, 'INTERMEDIATE_RESIDUAL_BREACH', evidence);
  }

  const outcome = terminalOutcome(attempt, evidence);
  if (outcome !== null) return withOutcome(attempt, outcome, [], evidence, null, null);
  const next = nextObligation(attempt, evidence);
  if (typeof next === 'string') {
    const residual = absolute(
      evidence.netSpotBalanceDeltaAtoms + evidence.perpetualPositionDeltaAtoms,
    );
    const terminalCap = attempt.sourceAttempt.plan.recoveryPolicy.maxTerminalResidual.atoms;
    return manual(attempt, residual > terminalCap ? 'TERMINAL_POLICY_BREACH' : next, evidence);
  }
  return withOutcome(attempt, 'RECOVERY_REQUIRED', ['INCOMPLETE_RECOVERY'],
    evidence, null, next);
}
