import {
  HYPERCORE_EXECUTION_GUARANTEE,
  type HyperliquidExecutionPlan,
  type HyperliquidPlanCommitments,
  type HyperliquidTerminalResidualPolicy,
} from '@naryx/adapter-hyperliquid';
import {
  bytesEqual,
  domainRef,
  exactPrice,
  hash32,
  manifestHash,
  type DomainRef,
  type ExactPrice,
  type Hash32,
  type ManifestHash,
} from '@naryx/protocol-types';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const CLIENT_ORDER_ID_PATTERN = /^0x[0-9a-fA-F]{32}$/;

export const HYPERCORE_RECONCILIATION_SOURCE = 'HYPERCORE_ACCOUNT_RECONCILIATION';

export type HyperliquidAttemptStatus =
  | 'PLANNED'
  | 'SUBMISSION_UNKNOWN'
  | 'RECONCILING'
  | 'RECOVERY_REQUIRED'
  | 'NO_EFFECT'
  | 'COMPLETED_EXACT'
  | 'COMPLETED_BOUNDED'
  | 'MANUAL_INTERVENTION';

export type HyperliquidReconciliationReason =
  | 'AWAITING_TERMINAL_EVIDENCE'
  | 'OPEN_IOC_ORDER'
  | 'ONE_LEG_FILLED'
  | 'UNEQUAL_FILL_RATIO'
  | 'INCOMPLETE_FILL'
  | 'OUTCOME_OUT_OF_BOUNDS'
  | 'OVERFILL'
  | 'FEE_EVIDENCE_UNCERTAIN'
  | 'EVIDENCE_INCONSISTENT'
  | 'IDENTITY_MISMATCH'
  | 'STALE_EVIDENCE'
  | 'RECOVERY_DEADLINE_BREACH'
  | 'CONFLICTING_TERMINAL_EVIDENCE';

export interface HyperliquidAccountIdentityInput {
  readonly masterAccount: `0x${string}`;
  readonly tradingAccount: `0x${string}`;
  readonly accountKind: 'MASTER' | 'SUBACCOUNT';
}

export interface HyperliquidAccountIdentity {
  readonly masterAccount: `0x${string}`;
  readonly tradingAccount: `0x${string}`;
  readonly accountKind: 'MASTER' | 'SUBACCOUNT';
}

export type HyperliquidLegTerminalStatus =
  | 'FILLED'
  | 'PARTIALLY_FILLED_IOC_CANCELLED'
  | 'UNFILLED_IOC_CANCELLED'
  | 'REJECTED'
  | 'UNKNOWN';

export type HyperliquidOpenOrderStatus = 'NONE' | 'OPEN' | 'UNKNOWN';

export interface HyperliquidLegReconciliationInput {
  readonly clientOrderId: `0x${string}`;
  readonly terminalStatus: HyperliquidLegTerminalStatus;
  readonly openOrderStatus: HyperliquidOpenOrderStatus;
  readonly filledSignedBaseAtoms: bigint;
}

export interface HyperliquidFeeObservationInput {
  readonly assetId: string;
  readonly assetDecimals: number;
  readonly amountAtoms: bigint;
  readonly evidenceStatus: 'CONFIRMED' | 'UNCERTAIN';
}

export interface HyperliquidReconciliationSnapshotInput {
  readonly source: typeof HYPERCORE_RECONCILIATION_SOURCE;
  readonly domain: DomainRef;
  readonly commitments: HyperliquidPlanCommitments;
  readonly account: HyperliquidAccountIdentityInput;
  readonly evidenceVersion: bigint;
  readonly observedAtMs: bigint;
  readonly spot: HyperliquidLegReconciliationInput;
  readonly perpetual: HyperliquidLegReconciliationInput;
  readonly netSpotDeltaAtoms: bigint;
  readonly perpetualPositionDeltaAtoms: bigint;
  readonly observedPerpetualPositionAtoms: bigint;
  readonly perpetualPositionTargetAtoms: bigint;
  readonly feeEvidenceComplete: boolean;
  readonly fees: readonly HyperliquidFeeObservationInput[];
}

export interface HyperliquidFeeObservation {
  readonly assetId: string;
  readonly assetDecimals: number;
  readonly amountAtoms: bigint;
  readonly evidenceStatus: 'CONFIRMED' | 'UNCERTAIN';
}

export interface HyperliquidReconciliationSnapshot {
  readonly source: typeof HYPERCORE_RECONCILIATION_SOURCE;
  readonly domain: DomainRef;
  readonly commitments: HyperliquidPlanCommitments;
  readonly account: HyperliquidAccountIdentity;
  readonly evidenceVersion: bigint;
  readonly observedAtMs: bigint;
  readonly spot: HyperliquidLegReconciliationInput;
  readonly perpetual: HyperliquidLegReconciliationInput;
  readonly netSpotDeltaAtoms: bigint;
  readonly perpetualPositionDeltaAtoms: bigint;
  readonly observedPerpetualPositionAtoms: bigint;
  readonly perpetualPositionTargetAtoms: bigint;
  readonly feeEvidenceComplete: boolean;
  readonly fees: readonly HyperliquidFeeObservation[];
}

export interface HyperliquidReconciliationPlan {
  readonly domain: DomainRef;
  readonly commitments: HyperliquidPlanCommitments;
  readonly spotClientOrderId: `0x${string}`;
  readonly perpetualClientOrderId: `0x${string}`;
  readonly plannedSpotDeltaAtoms: bigint;
  readonly prePerpetualPositionAtoms: bigint;
  readonly plannedPerpetualDeltaAtoms: bigint;
  readonly perpetualPositionTargetAtoms: bigint;
  readonly terminalResidualPolicy: HyperliquidTerminalResidualPolicy;
  readonly requestExpiryMs: bigint;
  readonly recoveryDeadlineMs: bigint;
}

export type HyperliquidRecoverySignedLimits =
  | Readonly<{
      kind: 'EXACT_NET';
      minNetSpotDeltaAtoms: bigint;
      maxNetSpotDeltaAtoms: bigint;
      maxTerminalResidualBaseAtoms: 0n;
      maxTerminalResidualQuoteAtoms: 0n;
    }>
  | Readonly<{
      kind: 'BOUNDED_NET';
      minNetSpotDeltaAtoms: bigint;
      maxNetSpotDeltaAtoms: bigint;
      maxTerminalResidualBaseAtoms: bigint;
      residualValuationSchemaVersion: number;
      residualValuationReferencePrice: ExactPrice;
      maxTerminalResidualQuoteAtoms: bigint;
    }>;

export interface HyperliquidRecoveryObligation {
  readonly domain: DomainRef;
  readonly commitments: HyperliquidPlanCommitments;
  readonly account: HyperliquidAccountIdentity;
  readonly observedNetSpotDeltaAtoms: bigint;
  readonly observedPerpetualDeltaAtoms: bigint;
  readonly observedPerpetualPositionAtoms: bigint;
  readonly targetPerpetualPositionAtoms: bigint;
  readonly remainingPerpetualDeltaAtoms: bigint;
  readonly remainingNetSpotDeltaToMinimumAtoms: bigint;
  readonly remainingNetSpotDeltaToMaximumAtoms: bigint;
  readonly signedLimits: HyperliquidRecoverySignedLimits;
  readonly deadlineMs: bigint;
  readonly allowedTerminalOutcome: 'EXACT_NET' | 'BOUNDED_NET';
}

export interface HyperliquidPackageAttempt {
  readonly version: 1;
  readonly status: HyperliquidAttemptStatus;
  readonly plan: HyperliquidReconciliationPlan;
  readonly account: HyperliquidAccountIdentity;
  readonly reasons: readonly HyperliquidReconciliationReason[];
  readonly acceptedEvidence: HyperliquidReconciliationSnapshot | null;
  readonly lockEvidence: HyperliquidReconciliationSnapshot | null;
  readonly recoveryObligation: HyperliquidRecoveryObligation | null;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function cloneHash(value: Hash32, name: string): Hash32 {
  return hash32(value, name);
}

function cloneManifestHash(value: ManifestHash, name: string): ManifestHash {
  return manifestHash(value, name);
}

function cloneDomain(value: DomainRef, name: string): DomainRef {
  return domainRef(
    value.domainId,
    value.domainManifestVersion,
    value.domainManifestHash,
    name,
  );
}

function cloneCommitments(value: HyperliquidPlanCommitments): HyperliquidPlanCommitments {
  return Object.freeze({
    seriesManifestHash: cloneManifestHash(value.seriesManifestHash, 'commitments.seriesManifestHash'),
    executionClassManifestHash: cloneManifestHash(
      value.executionClassManifestHash,
      'commitments.executionClassManifestHash',
    ),
    orderHash: cloneHash(value.orderHash, 'commitments.orderHash'),
    quoteHash: cloneHash(value.quoteHash, 'commitments.quoteHash'),
    routeHash: cloneHash(value.routeHash, 'commitments.routeHash'),
  });
}

function clonePrice(value: ExactPrice): ExactPrice {
  return exactPrice({
    baseAsset: value.baseAsset,
    quoteAsset: value.quoteAsset,
    quoteAtoms: value.quoteAtoms,
    baseAtoms: value.baseAtoms,
    roundingDirection: value.roundingDirection,
  });
}

function cloneResidualPolicy(
  value: HyperliquidTerminalResidualPolicy,
): HyperliquidTerminalResidualPolicy {
  if (value.kind === 'EXACT_NET') {
    return Object.freeze({
      kind: 'EXACT_NET',
      netSpotDeltaAtoms: value.netSpotDeltaAtoms,
      maxTerminalResidualBaseAtoms: 0n,
      maxTerminalResidualQuoteAtoms: 0n,
    });
  }
  return Object.freeze({
    kind: 'BOUNDED_NET',
    minNetSpotDeltaAtoms: value.minNetSpotDeltaAtoms,
    maxNetSpotDeltaAtoms: value.maxNetSpotDeltaAtoms,
    maxTerminalResidualBaseAtoms: value.maxTerminalResidualBaseAtoms,
    residualValuationSchemaVersion: value.residualValuationSchemaVersion,
    residualValuationReferencePrice: clonePrice(value.residualValuationReferencePrice),
    maxTerminalResidualQuoteAtoms: value.maxTerminalResidualQuoteAtoms,
  });
}

function normalizedAddress(value: string, name: string): `0x${string}` {
  requireCondition(ADDRESS_PATTERN.test(value), `${name} must be a 20-byte hex address`);
  return value.toLowerCase() as `0x${string}`;
}

function normalizedClientOrderId(value: string, name: string): `0x${string}` {
  requireCondition(CLIENT_ORDER_ID_PATTERN.test(value), `${name} must be a 128-bit client order ID`);
  return value.toLowerCase() as `0x${string}`;
}

function normalizedAccount(
  input: HyperliquidAccountIdentityInput,
  context: string,
): HyperliquidAccountIdentity {
  const masterAccount = normalizedAddress(input.masterAccount, `${context}.masterAccount`);
  const tradingAccount = normalizedAddress(input.tradingAccount, `${context}.tradingAccount`);
  requireCondition(
    input.accountKind === 'MASTER' || input.accountKind === 'SUBACCOUNT',
    `${context}.accountKind is unsupported`,
  );
  requireCondition(
    input.accountKind === 'MASTER'
      ? masterAccount === tradingAccount
      : masterAccount !== tradingAccount,
    `${context} master/subaccount relationship is invalid`,
  );
  return Object.freeze({ masterAccount, tradingAccount, accountKind: input.accountKind });
}

function normalizedPlan(plan: HyperliquidExecutionPlan): HyperliquidReconciliationPlan {
  requireCondition(plan.version === 1, 'execution plan version is unsupported');
  requireCondition(
    plan.guarantee === HYPERCORE_EXECUTION_GUARANTEE,
    'execution plan guarantee is unsupported',
  );
  const spot = plan.legs.find((leg) => leg.role === 'SPOT');
  const perpetual = plan.legs.find((leg) => leg.role === 'PERPETUAL');
  requireCondition(spot !== undefined && perpetual !== undefined, 'execution plan requires two distinct legs');
  const spotClientOrderId = normalizedClientOrderId(spot.clientOrderId, 'plan.spot.clientOrderId');
  const perpetualClientOrderId = normalizedClientOrderId(
    perpetual.clientOrderId,
    'plan.perpetual.clientOrderId',
  );
  requireCondition(spotClientOrderId !== perpetualClientOrderId, 'client order IDs must be distinct');
  requireCondition(
    spot.signedBaseDeltaAtoms !== 0n && perpetual.signedBaseDeltaAtoms !== 0n,
    'planned leg deltas must be nonzero',
  );
  requireCondition(
    plan.signedPerpDeltaAtoms === perpetual.signedBaseDeltaAtoms,
    'planned perpetual delta mismatch',
  );
  requireCondition(
    plan.prePerpPositionAtoms + plan.signedPerpDeltaAtoms === plan.signedPerpTargetAtoms,
    'planned perpetual target mismatch',
  );
  requireCondition(
    plan.recoveryDeadlineMs >= plan.requestExpiryMs,
    'recovery deadline precedes request expiry',
  );
  const terminalResidualPolicy = cloneResidualPolicy(plan.terminalResidualPolicy);
  if (terminalResidualPolicy.kind === 'EXACT_NET') {
    requireCondition(
      terminalResidualPolicy.netSpotDeltaAtoms === spot.signedBaseDeltaAtoms
        && terminalResidualPolicy.netSpotDeltaAtoms + plan.signedPerpDeltaAtoms === 0n,
      'EXACT_NET plan does not compile to zero residual',
    );
  } else {
    requireCondition(
      terminalResidualPolicy.minNetSpotDeltaAtoms <= terminalResidualPolicy.maxNetSpotDeltaAtoms,
      'BOUNDED_NET interval is descending',
    );
    requireCondition(
      terminalResidualPolicy.maxTerminalResidualBaseAtoms >= 0n
        && terminalResidualPolicy.maxTerminalResidualQuoteAtoms >= 0n,
      'BOUNDED_NET residual caps must be nonnegative',
    );
    const neutralSpotDelta = -plan.signedPerpDeltaAtoms;
    const closestAllowedSpotDelta = neutralSpotDelta < terminalResidualPolicy.minNetSpotDeltaAtoms
      ? terminalResidualPolicy.minNetSpotDeltaAtoms
      : neutralSpotDelta > terminalResidualPolicy.maxNetSpotDeltaAtoms
        ? terminalResidualPolicy.maxNetSpotDeltaAtoms
        : neutralSpotDelta;
    const minimumResidualBaseAtoms = absolute(
      closestAllowedSpotDelta + plan.signedPerpDeltaAtoms,
    );
    requireCondition(
      minimumResidualBaseAtoms <= terminalResidualPolicy.maxTerminalResidualBaseAtoms
        && quoteResidualAtoms(
          minimumResidualBaseAtoms,
          terminalResidualPolicy.residualValuationReferencePrice,
        ) <= terminalResidualPolicy.maxTerminalResidualQuoteAtoms,
      'BOUNDED_NET interval and residual caps have no satisfiable outcome',
    );
  }
  return Object.freeze({
    domain: cloneDomain(plan.domain, 'plan.domain'),
    commitments: cloneCommitments(plan.commitments),
    spotClientOrderId,
    perpetualClientOrderId,
    plannedSpotDeltaAtoms: spot.signedBaseDeltaAtoms,
    prePerpetualPositionAtoms: plan.prePerpPositionAtoms,
    plannedPerpetualDeltaAtoms: plan.signedPerpDeltaAtoms,
    perpetualPositionTargetAtoms: plan.signedPerpTargetAtoms,
    terminalResidualPolicy,
    requestExpiryMs: plan.requestExpiryMs,
    recoveryDeadlineMs: plan.recoveryDeadlineMs,
  });
}

function normalizedLeg(
  input: HyperliquidLegReconciliationInput,
  context: string,
): HyperliquidLegReconciliationInput {
  requireCondition(
    input.terminalStatus === 'FILLED'
      || input.terminalStatus === 'PARTIALLY_FILLED_IOC_CANCELLED'
      || input.terminalStatus === 'UNFILLED_IOC_CANCELLED'
      || input.terminalStatus === 'REJECTED'
      || input.terminalStatus === 'UNKNOWN',
    `${context}.terminalStatus is unsupported`,
  );
  requireCondition(
    input.openOrderStatus === 'NONE'
      || input.openOrderStatus === 'OPEN'
      || input.openOrderStatus === 'UNKNOWN',
    `${context}.openOrderStatus is unsupported`,
  );
  return Object.freeze({
    clientOrderId: normalizedClientOrderId(input.clientOrderId, `${context}.clientOrderId`),
    terminalStatus: input.terminalStatus,
    openOrderStatus: input.openOrderStatus,
    filledSignedBaseAtoms: input.filledSignedBaseAtoms,
  });
}

function normalizedSnapshot(
  input: HyperliquidReconciliationSnapshotInput,
): HyperliquidReconciliationSnapshot {
  requireCondition(
    input.source === HYPERCORE_RECONCILIATION_SOURCE,
    'only authoritative account reconciliation evidence is accepted',
  );
  const fees = input.fees.map((fee, index) => {
    requireCondition(fee.assetId.trim().length > 0, `fees[${index}].assetId is empty`);
    requireCondition(
      Number.isInteger(fee.assetDecimals) && fee.assetDecimals >= 0 && fee.assetDecimals <= 30,
      `fees[${index}].assetDecimals is invalid`,
    );
    requireCondition(
      fee.evidenceStatus === 'CONFIRMED' || fee.evidenceStatus === 'UNCERTAIN',
      `fees[${index}].evidenceStatus is unsupported`,
    );
    return Object.freeze({ ...fee });
  });
  return Object.freeze({
    source: input.source,
    domain: cloneDomain(input.domain, 'evidence.domain'),
    commitments: cloneCommitments(input.commitments),
    account: normalizedAccount(input.account, 'evidence.account'),
    evidenceVersion: input.evidenceVersion,
    observedAtMs: input.observedAtMs,
    spot: normalizedLeg(input.spot, 'evidence.spot'),
    perpetual: normalizedLeg(input.perpetual, 'evidence.perpetual'),
    netSpotDeltaAtoms: input.netSpotDeltaAtoms,
    perpetualPositionDeltaAtoms: input.perpetualPositionDeltaAtoms,
    observedPerpetualPositionAtoms: input.observedPerpetualPositionAtoms,
    perpetualPositionTargetAtoms: input.perpetualPositionTargetAtoms,
    feeEvidenceComplete: input.feeEvidenceComplete,
    fees: Object.freeze(fees),
  });
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function sameCommitments(
  left: HyperliquidPlanCommitments,
  right: HyperliquidPlanCommitments,
): boolean {
  return bytesEqual(left.seriesManifestHash, right.seriesManifestHash)
    && bytesEqual(left.executionClassManifestHash, right.executionClassManifestHash)
    && bytesEqual(left.orderHash, right.orderHash)
    && bytesEqual(left.quoteHash, right.quoteHash)
    && bytesEqual(left.routeHash, right.routeHash);
}

function sameAccount(
  left: HyperliquidAccountIdentity,
  right: HyperliquidAccountIdentity,
): boolean {
  return left.masterAccount === right.masterAccount
    && left.tradingAccount === right.tradingAccount
    && left.accountKind === right.accountKind;
}

function sameLeg(
  left: HyperliquidLegReconciliationInput,
  right: HyperliquidLegReconciliationInput,
): boolean {
  return left.clientOrderId === right.clientOrderId
    && left.terminalStatus === right.terminalStatus
    && left.openOrderStatus === right.openOrderStatus
    && left.filledSignedBaseAtoms === right.filledSignedBaseAtoms;
}

function sameSnapshot(
  left: HyperliquidReconciliationSnapshot,
  right: HyperliquidReconciliationSnapshot,
): boolean {
  return sameDomain(left.domain, right.domain)
    && sameCommitments(left.commitments, right.commitments)
    && sameAccount(left.account, right.account)
    && left.evidenceVersion === right.evidenceVersion
    && left.observedAtMs === right.observedAtMs
    && sameLeg(left.spot, right.spot)
    && sameLeg(left.perpetual, right.perpetual)
    && left.netSpotDeltaAtoms === right.netSpotDeltaAtoms
    && left.perpetualPositionDeltaAtoms === right.perpetualPositionDeltaAtoms
    && left.observedPerpetualPositionAtoms === right.observedPerpetualPositionAtoms
    && left.perpetualPositionTargetAtoms === right.perpetualPositionTargetAtoms
    && left.feeEvidenceComplete === right.feeEvidenceComplete
    && left.fees.length === right.fees.length
    && left.fees.every((fee, index) => {
      const other = right.fees[index];
      return other !== undefined
        && fee.assetId === other.assetId
        && fee.assetDecimals === other.assetDecimals
        && fee.amountAtoms === other.amountAtoms
        && fee.evidenceStatus === other.evidenceStatus;
    });
}

function attemptWith(
  attempt: HyperliquidPackageAttempt,
  status: HyperliquidAttemptStatus,
  reasons: readonly HyperliquidReconciliationReason[],
  acceptedEvidence: HyperliquidReconciliationSnapshot | null,
  lockEvidence: HyperliquidReconciliationSnapshot | null,
  recoveryObligation: HyperliquidRecoveryObligation | null,
): HyperliquidPackageAttempt {
  return Object.freeze({
    version: 1,
    status,
    plan: attempt.plan,
    account: attempt.account,
    reasons: Object.freeze([...reasons]),
    acceptedEvidence,
    lockEvidence,
    recoveryObligation,
  });
}

function manualLock(
  attempt: HyperliquidPackageAttempt,
  reason: HyperliquidReconciliationReason,
  evidence: HyperliquidReconciliationSnapshot,
): HyperliquidPackageAttempt {
  return attemptWith(
    attempt,
    'MANUAL_INTERVENTION',
    [reason],
    attempt.acceptedEvidence,
    evidence,
    null,
  );
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function sameDirectionOrZero(observed: bigint, planned: bigint): boolean {
  return observed === 0n || (observed > 0n) === (planned > 0n);
}

function quoteResidualAtoms(baseResidualAtoms: bigint, price: ExactPrice): bigint {
  const numerator = baseResidualAtoms * price.quoteAtoms;
  const quotient = numerator / price.baseAtoms;
  return numerator % price.baseAtoms === 0n ? quotient : quotient + 1n;
}

function recoverySignedLimits(
  policy: HyperliquidTerminalResidualPolicy,
): HyperliquidRecoverySignedLimits {
  if (policy.kind === 'EXACT_NET') {
    return Object.freeze({
      kind: 'EXACT_NET',
      minNetSpotDeltaAtoms: policy.netSpotDeltaAtoms,
      maxNetSpotDeltaAtoms: policy.netSpotDeltaAtoms,
      maxTerminalResidualBaseAtoms: 0n,
      maxTerminalResidualQuoteAtoms: 0n,
    });
  }
  return Object.freeze({
    kind: 'BOUNDED_NET',
    minNetSpotDeltaAtoms: policy.minNetSpotDeltaAtoms,
    maxNetSpotDeltaAtoms: policy.maxNetSpotDeltaAtoms,
    maxTerminalResidualBaseAtoms: policy.maxTerminalResidualBaseAtoms,
    residualValuationSchemaVersion: policy.residualValuationSchemaVersion,
    residualValuationReferencePrice: policy.residualValuationReferencePrice,
    maxTerminalResidualQuoteAtoms: policy.maxTerminalResidualQuoteAtoms,
  });
}

function recoveryObligation(
  attempt: HyperliquidPackageAttempt,
  evidence: HyperliquidReconciliationSnapshot,
): HyperliquidRecoveryObligation {
  const limits = recoverySignedLimits(attempt.plan.terminalResidualPolicy);
  return Object.freeze({
    domain: attempt.plan.domain,
    commitments: attempt.plan.commitments,
    account: attempt.account,
    observedNetSpotDeltaAtoms: evidence.netSpotDeltaAtoms,
    observedPerpetualDeltaAtoms: evidence.perpetualPositionDeltaAtoms,
    observedPerpetualPositionAtoms: evidence.observedPerpetualPositionAtoms,
    targetPerpetualPositionAtoms: attempt.plan.perpetualPositionTargetAtoms,
    remainingPerpetualDeltaAtoms:
      attempt.plan.perpetualPositionTargetAtoms - evidence.observedPerpetualPositionAtoms,
    remainingNetSpotDeltaToMinimumAtoms:
      limits.minNetSpotDeltaAtoms - evidence.netSpotDeltaAtoms,
    remainingNetSpotDeltaToMaximumAtoms:
      limits.maxNetSpotDeltaAtoms - evidence.netSpotDeltaAtoms,
    signedLimits: limits,
    deadlineMs: attempt.plan.recoveryDeadlineMs,
    allowedTerminalOutcome: limits.kind,
  });
}

function recoveryRequired(
  attempt: HyperliquidPackageAttempt,
  reason: HyperliquidReconciliationReason,
  evidence: HyperliquidReconciliationSnapshot,
): HyperliquidPackageAttempt {
  return attemptWith(
    attempt,
    'RECOVERY_REQUIRED',
    [reason],
    evidence,
    null,
    recoveryObligation(attempt, evidence),
  );
}

function isTerminalHistory(status: HyperliquidAttemptStatus): boolean {
  return status === 'NO_EFFECT'
    || status === 'COMPLETED_EXACT'
    || status === 'COMPLETED_BOUNDED'
    || status === 'MANUAL_INTERVENTION';
}

function legStatusConsistent(
  status: HyperliquidLegTerminalStatus,
  fill: bigint,
  planned: bigint,
): boolean {
  const filled = absolute(fill);
  const expected = absolute(planned);
  if (status === 'FILLED') return filled === expected;
  if (status === 'PARTIALLY_FILLED_IOC_CANCELLED') return filled > 0n && filled < expected;
  if (status === 'UNFILLED_IOC_CANCELLED' || status === 'REJECTED') return filled === 0n;
  return true;
}

export function createHyperliquidPackageAttempt(
  plan: HyperliquidExecutionPlan,
  account: HyperliquidAccountIdentityInput,
): HyperliquidPackageAttempt {
  return Object.freeze({
    version: 1,
    status: 'PLANNED',
    plan: normalizedPlan(plan),
    account: normalizedAccount(account, 'account'),
    reasons: Object.freeze([]),
    acceptedEvidence: null,
    lockEvidence: null,
    recoveryObligation: null,
  });
}

export function markHyperliquidSubmissionUnknown(
  attempt: HyperliquidPackageAttempt,
): HyperliquidPackageAttempt {
  if (attempt.status === 'SUBMISSION_UNKNOWN') return attempt;
  requireCondition(attempt.status === 'PLANNED', 'submission can only start from PLANNED');
  return attemptWith(attempt, 'SUBMISSION_UNKNOWN', [], null, null, null);
}

export function beginHyperliquidReconciliation(
  attempt: HyperliquidPackageAttempt,
): HyperliquidPackageAttempt {
  if (attempt.status === 'RECONCILING') return attempt;
  requireCondition(
    attempt.status === 'PLANNED' || attempt.status === 'SUBMISSION_UNKNOWN',
    'reconciliation cannot replace accepted evidence',
  );
  return attemptWith(attempt, 'RECONCILING', [], null, null, null);
}

export function reconcileHyperliquidPackageAttempt(
  attempt: HyperliquidPackageAttempt,
  input: HyperliquidReconciliationSnapshotInput,
): HyperliquidPackageAttempt {
  const evidence = normalizedSnapshot(input);
  if (attempt.lockEvidence !== null && sameSnapshot(attempt.lockEvidence, evidence)) return attempt;
  if (attempt.acceptedEvidence !== null && sameSnapshot(attempt.acceptedEvidence, evidence)) return attempt;
  if (attempt.status === 'MANUAL_INTERVENTION') return attempt;
  if (isTerminalHistory(attempt.status)) {
    return manualLock(attempt, 'CONFLICTING_TERMINAL_EVIDENCE', evidence);
  }
  if (attempt.acceptedEvidence !== null) {
    if (
      evidence.evidenceVersion <= attempt.acceptedEvidence.evidenceVersion
      || evidence.observedAtMs <= attempt.acceptedEvidence.observedAtMs
    ) {
      return manualLock(attempt, 'STALE_EVIDENCE', evidence);
    }
  } else if (evidence.evidenceVersion <= 0n || evidence.observedAtMs <= 0n) {
    return manualLock(attempt, 'STALE_EVIDENCE', evidence);
  }
  const identityMatches = sameDomain(attempt.plan.domain, evidence.domain)
    && sameCommitments(attempt.plan.commitments, evidence.commitments)
    && sameAccount(attempt.account, evidence.account)
    && attempt.plan.spotClientOrderId === evidence.spot.clientOrderId
    && attempt.plan.perpetualClientOrderId === evidence.perpetual.clientOrderId
    && attempt.plan.perpetualPositionTargetAtoms === evidence.perpetualPositionTargetAtoms;
  if (!identityMatches) return manualLock(attempt, 'IDENTITY_MISMATCH', evidence);
  if (evidence.observedAtMs > attempt.plan.recoveryDeadlineMs) {
    return manualLock(attempt, 'RECOVERY_DEADLINE_BREACH', evidence);
  }
  if (
    !evidence.feeEvidenceComplete
    || evidence.fees.some((fee) => fee.evidenceStatus !== 'CONFIRMED')
  ) {
    return manualLock(attempt, 'FEE_EVIDENCE_UNCERTAIN', evidence);
  }
  if (
    !sameDirectionOrZero(evidence.spot.filledSignedBaseAtoms, attempt.plan.plannedSpotDeltaAtoms)
    || !sameDirectionOrZero(
      evidence.perpetual.filledSignedBaseAtoms,
      attempt.plan.plannedPerpetualDeltaAtoms,
    )
    || absolute(evidence.spot.filledSignedBaseAtoms)
      > absolute(attempt.plan.plannedSpotDeltaAtoms)
    || absolute(evidence.perpetual.filledSignedBaseAtoms)
      > absolute(attempt.plan.plannedPerpetualDeltaAtoms)
  ) {
    return manualLock(attempt, 'OVERFILL', evidence);
  }
  if (
    !legStatusConsistent(
      evidence.spot.terminalStatus,
      evidence.spot.filledSignedBaseAtoms,
      attempt.plan.plannedSpotDeltaAtoms,
    )
    || !legStatusConsistent(
      evidence.perpetual.terminalStatus,
      evidence.perpetual.filledSignedBaseAtoms,
      attempt.plan.plannedPerpetualDeltaAtoms,
    )
    || evidence.perpetualPositionDeltaAtoms !== evidence.perpetual.filledSignedBaseAtoms
    || attempt.plan.prePerpetualPositionAtoms + evidence.perpetualPositionDeltaAtoms
      !== evidence.observedPerpetualPositionAtoms
  ) {
    return manualLock(attempt, 'EVIDENCE_INCONSISTENT', evidence);
  }
  if (
    evidence.spot.openOrderStatus === 'UNKNOWN'
    || evidence.perpetual.openOrderStatus === 'UNKNOWN'
    || evidence.spot.terminalStatus === 'UNKNOWN'
    || evidence.perpetual.terminalStatus === 'UNKNOWN'
  ) {
    return attemptWith(
      attempt,
      'RECONCILING',
      ['AWAITING_TERMINAL_EVIDENCE'],
      evidence,
      null,
      null,
    );
  }
  if (
    evidence.spot.openOrderStatus === 'OPEN'
    || evidence.perpetual.openOrderStatus === 'OPEN'
  ) {
    return recoveryRequired(attempt, 'OPEN_IOC_ORDER', evidence);
  }
  const spotFill = evidence.spot.filledSignedBaseAtoms;
  const perpetualFill = evidence.perpetual.filledSignedBaseAtoms;
  if (spotFill === 0n && perpetualFill === 0n) {
    if (
      evidence.netSpotDeltaAtoms === 0n
      && evidence.perpetualPositionDeltaAtoms === 0n
      && evidence.observedPerpetualPositionAtoms === attempt.plan.prePerpetualPositionAtoms
      && evidence.fees.every((fee) => fee.amountAtoms === 0n)
    ) {
      return attemptWith(attempt, 'NO_EFFECT', [], evidence, null, null);
    }
    return manualLock(attempt, 'EVIDENCE_INCONSISTENT', evidence);
  }
  if (spotFill === 0n || perpetualFill === 0n) {
    return recoveryRequired(attempt, 'ONE_LEG_FILLED', evidence);
  }
  if (
    absolute(spotFill) * absolute(attempt.plan.plannedPerpetualDeltaAtoms)
      !== absolute(perpetualFill) * absolute(attempt.plan.plannedSpotDeltaAtoms)
  ) {
    return recoveryRequired(attempt, 'UNEQUAL_FILL_RATIO', evidence);
  }
  if (
    spotFill !== attempt.plan.plannedSpotDeltaAtoms
    || perpetualFill !== attempt.plan.plannedPerpetualDeltaAtoms
    || evidence.perpetualPositionDeltaAtoms !== attempt.plan.plannedPerpetualDeltaAtoms
    || evidence.observedPerpetualPositionAtoms !== attempt.plan.perpetualPositionTargetAtoms
  ) {
    return recoveryRequired(attempt, 'INCOMPLETE_FILL', evidence);
  }
  const residualBaseAtoms = absolute(
    evidence.netSpotDeltaAtoms + evidence.perpetualPositionDeltaAtoms,
  );
  const policy = attempt.plan.terminalResidualPolicy;
  if (policy.kind === 'EXACT_NET') {
    if (
      evidence.netSpotDeltaAtoms === policy.netSpotDeltaAtoms
      && residualBaseAtoms === 0n
    ) {
      return attemptWith(attempt, 'COMPLETED_EXACT', [], evidence, null, null);
    }
    return recoveryRequired(attempt, 'OUTCOME_OUT_OF_BOUNDS', evidence);
  }
  const residualQuoteAtoms = quoteResidualAtoms(
    residualBaseAtoms,
    policy.residualValuationReferencePrice,
  );
  if (
    evidence.netSpotDeltaAtoms >= policy.minNetSpotDeltaAtoms
    && evidence.netSpotDeltaAtoms <= policy.maxNetSpotDeltaAtoms
    && residualBaseAtoms <= policy.maxTerminalResidualBaseAtoms
    && residualQuoteAtoms <= policy.maxTerminalResidualQuoteAtoms
  ) {
    return attemptWith(attempt, 'COMPLETED_BOUNDED', [], evidence, null, null);
  }
  return recoveryRequired(attempt, 'OUTCOME_OUT_OF_BOUNDS', evidence);
}
