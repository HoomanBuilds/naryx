import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  compareHypercoreWirePriceToExact,
  formatHypercorePrice,
  formatHypercoreSize,
  type HyperliquidPlannedLeg,
  type HyperliquidPlanCommitments,
} from '@naryx/adapter-hyperliquid';
import {
  bytesEqual,
  manifestHash,
  protocolId,
  recoveryPlan,
  type AssetRef,
  type DomainRef,
  type RecoveryAction,
  type RecoveryActionSlot,
} from '@naryx/protocol-types';
import type { HyperliquidPackageAttempt } from './index.js';
import type { HyperliquidRecoveryAttempt } from './hyperliquid-recovery-reconciliation.js';
import { hyperliquidBaseFeeAtoms } from './hyperliquid-base-fee.js';
import {
  NARYX_UNSIGNED_HYPERCORE_RECOVERY,
  type HyperliquidRecoveryExecutionPlan,
  type HyperliquidRecoveryPlannedOrder,
} from './hyperliquid-recovery-compiler.js';

const RECOVERY_CLOID_DOMAIN = 'naryx/hypercore/recovery-cloid/v1';
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;

export interface HyperliquidRecoveryVerifierIdentity {
  readonly environment: 'testnet';
  readonly controllerId: string;
  readonly controllerCodeHash: Uint8Array | string;
  readonly authorityModeId: string;
  readonly actionBuilderCodeHash: Uint8Array | string;
}

interface ExpectedRecoveryOrder {
  readonly action: Exclude<RecoveryAction, 'CANCEL_OPEN_ORDERS'>;
  readonly role: 'SPOT' | 'PERPETUAL';
  readonly signedBaseDeltaAtoms: bigint;
  readonly slot: RecoveryActionSlot;
  readonly leg: HyperliquidPlannedLeg;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

export function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

export function sameCommitments(
  left: HyperliquidPlanCommitments,
  right: HyperliquidPlanCommitments,
): boolean {
  return bytesEqual(left.seriesManifestHash, right.seriesManifestHash)
    && bytesEqual(left.executionClassManifestHash, right.executionClassManifestHash)
    && bytesEqual(left.orderHash, right.orderHash)
    && bytesEqual(left.quoteHash, right.quoteHash)
    && bytesEqual(left.routeHash, right.routeHash);
}

export function sameAccount(
  left: HyperliquidPackageAttempt['account'],
  right: HyperliquidPackageAttempt['account'],
): boolean {
  return left.masterAccount === right.masterAccount
    && left.tradingAccount === right.tradingAccount
    && left.accountKind === right.accountKind;
}

function sameAdapter(left: HyperliquidPlannedLeg['adapter'], right: HyperliquidPlannedLeg['adapter']): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function sameMarket(left: HyperliquidPlannedLeg['market'], right: HyperliquidPlannedLeg['market']): boolean {
  return left.subjectId === right.subjectId
    && left.manifestVersion === right.manifestVersion
    && bytesEqual(left.manifestHash, right.manifestHash);
}

function encodedPart(value: Uint8Array): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function u32Bytes(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function u64Bytes(value: bigint): Buffer {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(value);
  return bytes;
}

export function hyperliquidRecoveryClientOrderId(
  domain: DomainRef,
  commitments: HyperliquidPlanCommitments,
  evidenceVersion: bigint,
  recoverySequence: number,
  slotSequence: number,
  role: 'SPOT' | 'PERPETUAL',
  orderOrdinal: number,
): `0x${string}` {
  const digest = createHash('sha256');
  for (const part of [
    Buffer.from(RECOVERY_CLOID_DOMAIN, 'ascii'),
    Buffer.from(domain.domainId, 'ascii'),
    u32Bytes(domain.domainManifestVersion),
    domain.domainManifestHash,
    commitments.seriesManifestHash,
    commitments.executionClassManifestHash,
    commitments.orderHash,
    commitments.quoteHash,
    commitments.routeHash,
    u64Bytes(evidenceVersion),
    u32Bytes(recoverySequence),
    u32Bytes(slotSequence),
    Buffer.from(role, 'ascii'),
    u32Bytes(orderOrdinal),
  ]) digest.update(encodedPart(part));
  return `0x${digest.digest().subarray(0, 16).toString('hex')}`;
}

function matchingSlot(
  attempt: HyperliquidPackageAttempt,
  action: Exclude<RecoveryAction, 'CANCEL_OPEN_ORDERS'>,
  leg: HyperliquidPlannedLeg,
): RecoveryActionSlot {
  const slots = attempt.plan.recoveryPolicy.actionSlots.filter((slot) => slot.action === action);
  requireCondition(slots.length === 1, `${action} recovery action is unavailable or ambiguous`);
  const slot = slots[0]!;
  requireCondition(slot.targetLeg === leg.legIndex, `${action} target leg mismatch`);
  requireCondition(sameAdapter(slot.adapter, leg.adapter), `${action} adapter mismatch`);
  requireCondition(slot.markets.length === 1 && sameMarket(slot.markets[0]!, leg.market),
    `${action} market mismatch`);
  requireCondition(slot.maxQuantity !== undefined && slot.limitPrice !== undefined
    && slot.reduceOnly !== undefined && slot.timeInForce === 'IOC',
  `${action} signed slot is incomplete`);
  requireCondition(sameAsset(slot.maxQuantity.asset, leg.baseAsset), `${action} quantity asset mismatch`);
  requireCondition(sameAsset(slot.limitPrice.baseAsset, leg.baseAsset)
    && sameAsset(slot.limitPrice.quoteAsset, leg.quoteAsset), `${action} price asset mismatch`);
  return slot;
}

function expectedOrders(attempt: HyperliquidPackageAttempt, mode: HyperliquidRecoveryExecutionPlan['mode']):
  readonly ExpectedRecoveryOrder[] {
  const evidence = attempt.acceptedEvidence!;
  const spot = attempt.plan.legs.find((leg) => leg.role === 'SPOT');
  const perpetual = attempt.plan.legs.find((leg) => leg.role === 'PERPETUAL');
  requireCondition(spot !== undefined && perpetual !== undefined, 'source attempt legs are incomplete');
  const expected: ExpectedRecoveryOrder[] = [];
  if (mode === 'COMPLETE_MISSING_LEG') {
    if (evidence.netSpotDeltaAtoms === spot.signedBaseDeltaAtoms
      && evidence.perpetualPositionDeltaAtoms !== attempt.plan.plannedPerpetualDeltaAtoms) {
      expected.push({
        action: 'COMPLETE_PERP', role: 'PERPETUAL',
        signedBaseDeltaAtoms: attempt.plan.plannedPerpetualDeltaAtoms
          - evidence.perpetualPositionDeltaAtoms,
        slot: matchingSlot(attempt, 'COMPLETE_PERP', perpetual), leg: perpetual,
      });
    } else if (evidence.perpetualPositionDeltaAtoms === attempt.plan.plannedPerpetualDeltaAtoms
      && evidence.netSpotDeltaAtoms !== spot.signedBaseDeltaAtoms) {
      expected.push({
        action: 'COMPLETE_SPOT', role: 'SPOT',
        signedBaseDeltaAtoms: spot.signedBaseDeltaAtoms - evidence.netSpotDeltaAtoms,
        slot: matchingSlot(attempt, 'COMPLETE_SPOT', spot), leg: spot,
      });
    }
    requireCondition(expected.length === 1, 'complete recovery does not match the source obligation');
  } else {
    if (evidence.netSpotDeltaAtoms !== 0n) {
      expected.push({
        action: 'ROLLBACK_SPOT', role: 'SPOT', signedBaseDeltaAtoms: -evidence.netSpotDeltaAtoms,
        slot: matchingSlot(attempt, 'ROLLBACK_SPOT', spot), leg: spot,
      });
    }
    if (evidence.perpetualPositionDeltaAtoms !== 0n) {
      expected.push({
        action: 'ROLLBACK_PERP', role: 'PERPETUAL',
        signedBaseDeltaAtoms: -evidence.perpetualPositionDeltaAtoms,
        slot: matchingSlot(attempt, 'ROLLBACK_PERP', perpetual), leg: perpetual,
      });
    }
    requireCondition(expected.length > 0, 'rollback recovery has no package effect to reverse');
  }
  return Object.freeze(expected.sort((left, right) => left.slot.sequence - right.slot.sequence));
}

function expectedContinuationOrders(
  previousAttempt: HyperliquidRecoveryAttempt,
): readonly ExpectedRecoveryOrder[] {
  const obligation = previousAttempt.nextRecoveryObligation;
  requireCondition(obligation !== null, 'continuation recovery obligation is missing');
  const source = previousAttempt.sourceAttempt;
  const spot = source.plan.legs.find((leg) => leg.role === 'SPOT');
  const perpetual = source.plan.legs.find((leg) => leg.role === 'PERPETUAL');
  requireCondition(spot !== undefined && perpetual !== undefined,
    'source attempt legs are incomplete');
  return Object.freeze(obligation.actions.map((action) => {
    const leg = action.role === 'SPOT' ? spot : perpetual;
    return Object.freeze({
      action: action.action,
      role: action.role,
      signedBaseDeltaAtoms: action.signedBaseDeltaAtoms,
      slot: matchingSlot(source, action.action, leg),
      leg,
    });
  }).sort((left, right) => left.slot.sequence - right.slot.sequence));
}

function validateSourceAttempt(attempt: HyperliquidPackageAttempt): void {
  requireCondition(attempt.status === 'RECOVERY_REQUIRED' && attempt.lockEvidence === null,
    'recovery source must be an unlocked RECOVERY_REQUIRED attempt');
  const evidence = attempt.acceptedEvidence;
  const obligation = attempt.recoveryObligation;
  requireCondition(evidence !== null && obligation !== null,
    'recovery source evidence and obligation are required');
  requireCondition(evidence.evidenceVersion > 0n && evidence.evidenceVersion <= U64_MAX,
    'source evidence version is invalid');
  requireCondition(evidence.spot.openOrderStatus === 'NONE'
    && evidence.perpetual.openOrderStatus === 'NONE'
    && evidence.spot.terminalStatus !== 'UNKNOWN'
    && evidence.perpetual.terminalStatus !== 'UNKNOWN',
  'source evidence must be terminal with no open orders');
  requireCondition(evidence.feeEvidenceComplete
    && evidence.fees.every((fee) => fee.evidenceStatus === 'CONFIRMED'),
  'source fee evidence is uncertain');
  requireCondition(sameDomain(evidence.domain, attempt.plan.domain)
    && sameDomain(obligation.domain, attempt.plan.domain)
    && sameCommitments(evidence.commitments, attempt.plan.commitments)
    && sameCommitments(obligation.commitments, attempt.plan.commitments)
    && sameAccount(evidence.account, attempt.account)
    && sameAccount(obligation.account, attempt.account),
  'source recovery identity mismatch');
  requireCondition(evidence.spot.clientOrderId === attempt.plan.spotClientOrderId
    && evidence.perpetual.clientOrderId === attempt.plan.perpetualClientOrderId,
  'source order identity mismatch');
  requireCondition(evidence.netSpotDeltaAtoms === evidence.spot.filledSignedBaseAtoms
      - hyperliquidBaseFeeAtoms(evidence.fees, attempt.plan.legs[0].baseAsset)
    && evidence.perpetualPositionDeltaAtoms === evidence.perpetual.filledSignedBaseAtoms
    && evidence.observedPerpetualPositionAtoms
      === attempt.plan.prePerpetualPositionAtoms + evidence.perpetualPositionDeltaAtoms,
  'source account evidence is inconsistent');
  requireCondition(obligation.observedNetSpotDeltaAtoms === evidence.netSpotDeltaAtoms
    && obligation.observedPerpetualDeltaAtoms === evidence.perpetualPositionDeltaAtoms
    && obligation.observedPerpetualPositionAtoms === evidence.observedPerpetualPositionAtoms
    && obligation.targetPerpetualPositionAtoms === attempt.plan.perpetualPositionTargetAtoms
    && obligation.deadlineMs === attempt.plan.recoveryDeadlineMs,
  'source recovery obligation mismatch');
  const terminal = attempt.plan.terminalResidualPolicy;
  const minimumSpot = terminal.kind === 'EXACT_NET'
    ? terminal.netSpotDeltaAtoms
    : terminal.minNetSpotDeltaAtoms;
  const maximumSpot = terminal.kind === 'EXACT_NET'
    ? terminal.netSpotDeltaAtoms
    : terminal.maxNetSpotDeltaAtoms;
  requireCondition(obligation.remainingPerpetualDeltaAtoms
      === attempt.plan.plannedPerpetualDeltaAtoms - evidence.perpetualPositionDeltaAtoms
    && obligation.remainingNetSpotDeltaToMinimumAtoms
      === minimumSpot - evidence.netSpotDeltaAtoms
    && obligation.remainingNetSpotDeltaToMaximumAtoms
      === maximumSpot - evidence.netSpotDeltaAtoms
    && obligation.allowedTerminalOutcome === terminal.kind
    && obligation.signedLimits.kind === terminal.kind
    && obligation.signedLimits.minNetSpotDeltaAtoms === minimumSpot
    && obligation.signedLimits.maxNetSpotDeltaAtoms === maximumSpot
    && obligation.signedLimits.maxTerminalResidualBaseAtoms
      === terminal.maxTerminalResidualBaseAtoms
    && obligation.signedLimits.maxTerminalResidualQuoteAtoms
      === terminal.maxTerminalResidualQuoteAtoms,
  'source recovery signed limits mismatch');
  if (terminal.kind === 'BOUNDED_NET') {
    requireCondition(obligation.signedLimits.kind === 'BOUNDED_NET'
      && obligation.signedLimits.residualValuationSchemaVersion
        === terminal.residualValuationSchemaVersion
      && obligation.signedLimits.residualValuationReferencePrice.baseAtoms
        === terminal.residualValuationReferencePrice.baseAtoms
      && obligation.signedLimits.residualValuationReferencePrice.quoteAtoms
        === terminal.residualValuationReferencePrice.quoteAtoms
      && obligation.signedLimits.residualValuationReferencePrice.roundingDirection
        === terminal.residualValuationReferencePrice.roundingDirection
      && sameAsset(
        obligation.signedLimits.residualValuationReferencePrice.baseAsset,
        terminal.residualValuationReferencePrice.baseAsset,
      )
      && sameAsset(
        obligation.signedLimits.residualValuationReferencePrice.quoteAsset,
        terminal.residualValuationReferencePrice.quoteAsset,
      ),
    'source recovery residual valuation mismatch');
  }
}

function validateIdentity(
  attempt: HyperliquidPackageAttempt,
  plan: HyperliquidRecoveryExecutionPlan,
  identity: HyperliquidRecoveryVerifierIdentity,
): void {
  requireCondition(identity.environment === 'testnet'
    && attempt.plan.domain.domainId === 'hypercore:testnet',
  'only the exact HyperCore testnet domain is supported');
  const controllerId = protocolId(identity.controllerId, 'identity.controllerId');
  const controllerCodeHash = manifestHash(identity.controllerCodeHash, 'identity.controllerCodeHash');
  const authorityModeId = protocolId(identity.authorityModeId, 'identity.authorityModeId');
  const actionBuilderCodeHash = manifestHash(
    identity.actionBuilderCodeHash,
    'identity.actionBuilderCodeHash',
  );
  const policy = recoveryPlan(attempt.plan.recoveryPolicy, 'source.recoveryPolicy');
  requireCondition(plan.controllerId === controllerId && policy.controllerId === controllerId
    && bytesEqual(plan.controllerCodeHash, controllerCodeHash)
    && bytesEqual(policy.controllerCodeHash, controllerCodeHash)
    && plan.authorityModeId === authorityModeId && policy.authorityModeId === authorityModeId
    && bytesEqual(plan.actionBuilderCodeHash, actionBuilderCodeHash)
    && bytesEqual(policy.actionBuilderCodeHash, actionBuilderCodeHash),
  'recovery controller or action-builder identity mismatch');
  requireCondition(bytesEqual(plan.reconciledStateSchemaHash, policy.reconciledStateSchemaHash),
    'reconciled state schema mismatch');
}

function validateOrder(
  plan: HyperliquidRecoveryExecutionPlan,
  expected: ExpectedRecoveryOrder,
  order: HyperliquidRecoveryPlannedOrder,
  ordinal: number,
  currentPerpetualPositionAtoms: bigint,
  prePerpetualPositionAtoms: bigint,
  perpetualTargetAtoms: bigint,
): bigint {
  requireCondition(order.action === expected.action && order.role === expected.role
    && order.actionSlotSequence === expected.slot.sequence
    && order.signedBaseDeltaAtoms === expected.signedBaseDeltaAtoms,
  'recovery order does not match the signed action obligation');
  requireCondition(order.signedBaseDeltaAtoms !== 0n
    && absolute(order.signedBaseDeltaAtoms) <= expected.slot.maxQuantity!.atoms,
  'recovery order quantity exceeds its signed slot');
  const clientOrderId = hyperliquidRecoveryClientOrderId(
    plan.domain,
    plan.commitments,
    plan.sourceEvidenceVersion,
    plan.recoverySequence,
    expected.slot.sequence,
    expected.role,
    ordinal,
  );
  requireCondition(order.clientOrderId.toLowerCase() === clientOrderId
    && order.order.c.toLowerCase() === clientOrderId,
  'recovery client order ID mismatch');
  const buy = order.signedBaseDeltaAtoms > 0n;
  requireCondition(order.order.a === expected.leg.order.a
    && order.order.b === buy
    && order.order.s === formatHypercoreSize(
      absolute(order.signedBaseDeltaAtoms),
      expected.leg.baseAsset.decimals,
      expected.leg.sizeDecimals,
    )
    && order.order.t.limit.tif === 'Ioc'
    && order.order.r === expected.slot.reduceOnly,
  'recovery wire order fields do not match the signed leg');
  const price = formatHypercorePrice(expected.slot.limitPrice!, expected.leg.maxPriceDecimals);
  requireCondition(order.order.p === price.value, 'recovery wire price does not match the signed slot');
  const priceRelation = compareHypercoreWirePriceToExact(price, expected.slot.limitPrice!);
  requireCondition(buy ? priceRelation <= 0 : priceRelation >= 0,
    'recovery wire price violates the signed directional limit');
  if (expected.role === 'SPOT') {
    requireCondition(expected.slot.reduceOnly === false, 'spot recovery cannot be reduce-only');
    return currentPerpetualPositionAtoms;
  }
  const finalPosition = currentPerpetualPositionAtoms + order.signedBaseDeltaAtoms;
  const expectedPosition = plan.mode === 'PAIRED_ROLLBACK'
    ? prePerpetualPositionAtoms
    : perpetualTargetAtoms;
  requireCondition(finalPosition === expectedPosition, 'perpetual recovery target mismatch');
  requireCondition(currentPerpetualPositionAtoms === 0n || finalPosition === 0n
    || (currentPerpetualPositionAtoms > 0n) === (finalPosition > 0n),
  'perpetual recovery would flip the position');
  const reduces = absolute(finalPosition) < absolute(currentPerpetualPositionAtoms);
  requireCondition(expected.slot.reduceOnly === reduces, 'perpetual reduce-only policy mismatch');
  if (expected.slot.reduceOnly) {
    requireCondition(currentPerpetualPositionAtoms !== 0n
      && absolute(order.signedBaseDeltaAtoms) <= absolute(currentPerpetualPositionAtoms),
    'reduce-only recovery can cross the position');
  }
  return finalPosition;
}

function quoteResidualAtoms(baseResidualAtoms: bigint, attempt: HyperliquidPackageAttempt): bigint {
  const terminal = attempt.plan.terminalResidualPolicy;
  requireCondition(terminal.kind === 'BOUNDED_NET', 'bounded residual price is unavailable');
  const numerator = baseResidualAtoms * terminal.residualValuationReferencePrice.quoteAtoms;
  const denominator = terminal.residualValuationReferencePrice.baseAtoms;
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

function validateProjectedBounds(
  attempt: HyperliquidPackageAttempt,
  plan: HyperliquidRecoveryExecutionPlan,
): void {
  const policy = attempt.plan.recoveryPolicy;
  requireCondition(plan.projectedRecoveryCosts.length === policy.maxRecoveryCostCaps.length,
    'projected recovery costs do not cover every signed asset');
  for (const [index, cap] of policy.maxRecoveryCostCaps.entries()) {
    const projected = plan.projectedRecoveryCosts[index];
    requireCondition(projected !== undefined && sameAsset(projected.asset, cap.asset)
      && projected.atoms >= 0n && projected.atoms <= cap.maxAtoms,
    'projected recovery cost violates a signed cap');
  }
  requireCondition(sameAsset(plan.projectedAggregateLoss.asset, policy.maxAggregateRecoveryLoss.asset)
    && plan.projectedAggregateLoss.atoms >= 0n
    && plan.projectedAggregateLoss.atoms <= policy.maxAggregateRecoveryLoss.atoms,
  'projected aggregate loss violates the signed cap');
}

function validateInitialBaseline(
  sourceAttempt: HyperliquidPackageAttempt,
  plan: HyperliquidRecoveryExecutionPlan,
): void {
  const source = sourceAttempt.acceptedEvidence!;
  const policy = sourceAttempt.plan.recoveryPolicy;
  requireCondition(plan.baseline.evidenceVersion === source.evidenceVersion
    && plan.baseline.observedAtMs === source.observedAtMs
    && plan.baseline.netSpotDeltaAtoms === source.netSpotDeltaAtoms
    && plan.baseline.perpetualPositionDeltaAtoms === source.perpetualPositionDeltaAtoms
    && plan.baseline.observedPerpetualPositionAtoms === source.observedPerpetualPositionAtoms
    && plan.baseline.priorRecoveryOrders.length === 0,
  'initial recovery baseline differs from source evidence');
  requireCondition(plan.baseline.cumulativeRecoveryCosts.length
    === policy.maxRecoveryCostCaps.length,
  'initial recovery cost baseline is incomplete');
  for (const [index, cap] of policy.maxRecoveryCostCaps.entries()) {
    const cost = plan.baseline.cumulativeRecoveryCosts[index];
    requireCondition(cost !== undefined && sameAsset(cost.asset, cap.asset) && cost.atoms === 0n,
      'initial recovery cost baseline must be zero');
  }
  requireCondition(sameAsset(
    plan.baseline.cumulativeAggregateLoss.asset,
    policy.maxAggregateRecoveryLoss.asset,
  ) && plan.baseline.cumulativeAggregateLoss.atoms === 0n,
  'initial aggregate loss baseline must be zero');
}

export function validateHyperliquidRecoveryExecutionPlan(
  sourceAttempt: HyperliquidPackageAttempt,
  plan: HyperliquidRecoveryExecutionPlan,
  identity: HyperliquidRecoveryVerifierIdentity,
  nowMs: bigint,
): void {
  validateSourceAttempt(sourceAttempt);
  requireCondition(plan.version === 1 && plan.guarantee === NARYX_UNSIGNED_HYPERCORE_RECOVERY,
    'unsupported recovery execution plan');
  requireCondition(plan.mode === 'COMPLETE_MISSING_LEG' || plan.mode === 'PAIRED_ROLLBACK',
    'unsupported recovery mode');
  requireCondition(sameDomain(plan.domain, sourceAttempt.plan.domain)
    && sameCommitments(plan.commitments, sourceAttempt.plan.commitments)
    && sameAccount(plan.account, sourceAttempt.account),
  'recovery plan domain, commitment, or account mismatch');
  requireCondition(plan.sourceEvidenceVersion === sourceAttempt.acceptedEvidence!.evidenceVersion,
    'recovery source evidence version mismatch');
  requireCondition(plan.recoverySequence === 0,
    'initial recovery sequence must be zero');
  validateInitialBaseline(sourceAttempt, plan);
  validateIdentity(sourceAttempt, plan, identity);
  const policy = sourceAttempt.plan.recoveryPolicy;
  requireCondition(policy.recoveryExpiryUnit === 'HYPERLIQUID_UNIX_MILLISECONDS'
    && plan.actionExpiryMs === policy.maxActionExpiryValue
    && plan.recoveryDeadlineMs === policy.deadlineValue
    && plan.recoveryDeadlineMs === sourceAttempt.plan.recoveryDeadlineMs
    && plan.actionExpiryMs <= MAX_SAFE_INTEGER
    && Number.isSafeInteger(plan.unsignedRequestFields.expiresAfter)
    && BigInt(plan.unsignedRequestFields.expiresAfter) === plan.actionExpiryMs,
  'recovery expiry or deadline binding mismatch');
  requireCondition(nowMs > 0n && nowMs < plan.actionExpiryMs && nowMs < plan.recoveryDeadlineMs,
    'recovery action expiry or deadline is stale');
  requireCondition(plan.actionExpiryMs + policy.minRecoveryWindowMs <= plan.recoveryDeadlineMs,
    'signed recovery window is not preserved');
  validateProjectedBounds(sourceAttempt, plan);

  const expected = expectedOrders(sourceAttempt, plan.mode);
  requireCondition(plan.orders.length === expected.length && plan.orders.length > 0,
    'recovery order count does not match the signed obligation');
  requireCondition(plan.unsignedRequestFields.action.type === 'order'
    && plan.unsignedRequestFields.action.grouping === 'na'
    && plan.unsignedRequestFields.action.orders.length === plan.orders.length,
  'recovery action envelope is invalid');
  const source = sourceAttempt.acceptedEvidence!;
  let netSpotDeltaAtoms = source.netSpotDeltaAtoms;
  let perpetualDeltaAtoms = source.perpetualPositionDeltaAtoms;
  let perpetualPositionAtoms = source.observedPerpetualPositionAtoms;
  const initialResidualBaseAtoms = absolute(netSpotDeltaAtoms + perpetualDeltaAtoms);
  requireCondition(plan.initialResidualBaseAtoms === initialResidualBaseAtoms
    && initialResidualBaseAtoms <= policy.maxIntermediateResidual.atoms,
  'initial recovery residual violates its signed bound');
  const cloids = new Set<string>();
  for (let index = 0; index < plan.orders.length; index += 1) {
    const order = plan.orders[index]!;
    const expectedOrder = expected[index]!;
    perpetualPositionAtoms = validateOrder(
      plan,
      expectedOrder,
      order,
      index,
      perpetualPositionAtoms,
      sourceAttempt.plan.prePerpetualPositionAtoms,
      sourceAttempt.plan.perpetualPositionTargetAtoms,
    );
    requireCondition(!cloids.has(order.clientOrderId.toLowerCase()),
      'recovery client order IDs must be unique');
    cloids.add(order.clientOrderId.toLowerCase());
    const wire = plan.unsignedRequestFields.action.orders[index]!;
    requireCondition(JSON.stringify(wire) === JSON.stringify(order.order),
      'recovery action order differs from the planned order');
    if (order.role === 'SPOT') netSpotDeltaAtoms += order.signedBaseDeltaAtoms;
    else perpetualDeltaAtoms += order.signedBaseDeltaAtoms;
    requireCondition(absolute(netSpotDeltaAtoms + perpetualDeltaAtoms)
      <= policy.maxIntermediateResidual.atoms,
    'recovery order exceeds the signed intermediate residual');
  }
  const terminalResidualBaseAtoms = absolute(netSpotDeltaAtoms + perpetualDeltaAtoms);
  requireCondition(plan.terminalResidualBaseAtoms === terminalResidualBaseAtoms
    && terminalResidualBaseAtoms <= policy.maxTerminalResidual.atoms,
  'recovery terminal residual violates its signed bound');
  if (plan.mode === 'PAIRED_ROLLBACK') {
    requireCondition(netSpotDeltaAtoms === 0n && perpetualDeltaAtoms === 0n
      && perpetualPositionAtoms === sourceAttempt.plan.prePerpetualPositionAtoms,
    'paired rollback does not restore the pre-package state');
    return;
  }
  const terminal = sourceAttempt.plan.terminalResidualPolicy;
  if (terminal.kind === 'EXACT_NET') {
    requireCondition(netSpotDeltaAtoms === terminal.netSpotDeltaAtoms
      && perpetualPositionAtoms === sourceAttempt.plan.perpetualPositionTargetAtoms
      && terminalResidualBaseAtoms === 0n,
    'complete recovery violates the exact terminal policy');
  } else {
    requireCondition(netSpotDeltaAtoms >= terminal.minNetSpotDeltaAtoms
      && netSpotDeltaAtoms <= terminal.maxNetSpotDeltaAtoms
      && perpetualPositionAtoms === sourceAttempt.plan.perpetualPositionTargetAtoms
      && terminalResidualBaseAtoms <= terminal.maxTerminalResidualBaseAtoms
      && quoteResidualAtoms(terminalResidualBaseAtoms, sourceAttempt)
        <= terminal.maxTerminalResidualQuoteAtoms,
    'complete recovery violates the bounded terminal policy');
  }
}

export function validateHyperliquidRecoveryContinuationExecutionPlan(
  previousAttempt: HyperliquidRecoveryAttempt,
  plan: HyperliquidRecoveryExecutionPlan,
  identity: HyperliquidRecoveryVerifierIdentity,
  nowMs: bigint,
): void {
  const evidence = previousAttempt.acceptedEvidence;
  const obligation = previousAttempt.nextRecoveryObligation;
  requireCondition(previousAttempt.status === 'RECOVERY_REQUIRED'
    && previousAttempt.lockEvidence === null
    && evidence !== null
    && obligation !== null,
  'continuation source has no trusted recovery obligation');
  const sourceAttempt = previousAttempt.sourceAttempt;
  const policy = sourceAttempt.plan.recoveryPolicy;
  requireCondition(plan.version === 1 && plan.guarantee === NARYX_UNSIGNED_HYPERCORE_RECOVERY,
    'unsupported recovery execution plan');
  requireCondition(plan.mode === obligation.mode
    && sameDomain(plan.domain, obligation.domain)
    && sameCommitments(plan.commitments, obligation.commitments)
    && sameAccount(plan.account, obligation.account),
  'continuation plan differs from its obligation');
  requireCondition(plan.sourceEvidenceVersion === evidence.evidenceVersion
    && plan.sourceEvidenceVersion === obligation.sourceEvidenceVersion
    && plan.recoverySequence === obligation.recoverySequence
    && plan.recoverySequence === previousAttempt.plan.recoverySequence + 1
    && plan.recoverySequence <= U32_MAX,
  'continuation sequence or evidence binding mismatch');
  requireCondition(plan.baseline.evidenceVersion === evidence.evidenceVersion
    && plan.baseline.observedAtMs === evidence.observedAtMs
    && plan.baseline.netSpotDeltaAtoms === evidence.netSpotBalanceDeltaAtoms
    && plan.baseline.perpetualPositionDeltaAtoms === evidence.perpetualPositionDeltaAtoms
    && plan.baseline.observedPerpetualPositionAtoms === evidence.observedPerpetualPositionAtoms,
  'continuation baseline differs from reconciled evidence');
  const expectedPriorOrders = [
    ...previousAttempt.plan.baseline.priorRecoveryOrders,
    ...previousAttempt.plan.orders,
  ];
  requireCondition(isDeepStrictEqual(plan.baseline.priorRecoveryOrders, expectedPriorOrders),
    'continuation prior recovery orders differ');
  requireCondition(plan.baseline.cumulativeRecoveryCosts.length
    === policy.maxRecoveryCostCaps.length
    && evidence.actualRecoveryCosts.length === policy.maxRecoveryCostCaps.length
    && obligation.remainingRecoveryCostCaps.length === policy.maxRecoveryCostCaps.length,
  'continuation recovery cost state is incomplete');
  for (const [index, cap] of policy.maxRecoveryCostCaps.entries()) {
    const baseline = plan.baseline.cumulativeRecoveryCosts[index];
    const actual = evidence.actualRecoveryCosts.find((item) => sameAsset(item.asset, cap.asset));
    const remaining = obligation.remainingRecoveryCostCaps.find(
      (item) => sameAsset(item.asset, cap.asset),
    );
    const projected = plan.projectedRecoveryCosts[index];
    requireCondition(baseline !== undefined && actual !== undefined && remaining !== undefined
      && projected !== undefined
      && actual.evidenceStatus === 'CONFIRMED'
      && sameAsset(baseline.asset, cap.asset)
      && baseline.atoms === actual.amountAtoms
      && actual.amountAtoms >= 0n
      && actual.amountAtoms <= cap.maxAtoms
      && remaining.atoms === cap.maxAtoms - actual.amountAtoms
      && sameAsset(projected.asset, cap.asset)
      && projected.atoms >= 0n
      && projected.atoms <= remaining.atoms,
    'continuation recovery cost exceeds its remaining cap');
  }
  requireCondition(evidence.actualAggregateLoss.evidenceStatus === 'CONFIRMED'
    && sameAsset(evidence.actualAggregateLoss.asset, policy.maxAggregateRecoveryLoss.asset)
    && sameAsset(
      plan.baseline.cumulativeAggregateLoss.asset,
      policy.maxAggregateRecoveryLoss.asset,
    )
    && plan.baseline.cumulativeAggregateLoss.atoms
      === evidence.actualAggregateLoss.amountAtoms
    && evidence.actualAggregateLoss.amountAtoms >= 0n
    && evidence.actualAggregateLoss.amountAtoms <= policy.maxAggregateRecoveryLoss.atoms
    && sameAsset(obligation.remainingAggregateLoss.asset, policy.maxAggregateRecoveryLoss.asset)
    && obligation.remainingAggregateLoss.atoms
      === policy.maxAggregateRecoveryLoss.atoms - evidence.actualAggregateLoss.amountAtoms
    && sameAsset(plan.projectedAggregateLoss.asset, obligation.remainingAggregateLoss.asset)
    && plan.projectedAggregateLoss.atoms >= 0n
    && plan.projectedAggregateLoss.atoms <= obligation.remainingAggregateLoss.atoms,
  'continuation aggregate loss exceeds its remaining cap');

  validateIdentity(sourceAttempt, plan, identity);
  requireCondition(policy.recoveryExpiryUnit === 'HYPERLIQUID_UNIX_MILLISECONDS'
    && plan.actionExpiryMs === obligation.actionExpiryMs
    && plan.actionExpiryMs === policy.maxActionExpiryValue
    && plan.recoveryDeadlineMs === obligation.recoveryDeadlineMs
    && plan.recoveryDeadlineMs === policy.deadlineValue
    && plan.actionExpiryMs <= MAX_SAFE_INTEGER
    && Number.isSafeInteger(plan.unsignedRequestFields.expiresAfter)
    && BigInt(plan.unsignedRequestFields.expiresAfter) === plan.actionExpiryMs,
  'continuation recovery timing binding mismatch');
  requireCondition(nowMs > 0n && nowMs < plan.actionExpiryMs && nowMs < plan.recoveryDeadlineMs,
    'continuation recovery action expiry or deadline is stale');
  requireCondition(plan.actionExpiryMs + policy.minRecoveryWindowMs <= plan.recoveryDeadlineMs,
    'signed recovery window is not preserved');

  const expected = expectedContinuationOrders(previousAttempt);
  requireCondition(plan.orders.length === expected.length && plan.orders.length > 0,
    'continuation order count does not match its obligation');
  requireCondition(plan.unsignedRequestFields.action.type === 'order'
    && plan.unsignedRequestFields.action.grouping === 'na'
    && plan.unsignedRequestFields.action.orders.length === plan.orders.length,
  'continuation recovery action envelope is invalid');
  let netSpotDeltaAtoms = plan.baseline.netSpotDeltaAtoms;
  let perpetualDeltaAtoms = plan.baseline.perpetualPositionDeltaAtoms;
  let perpetualPositionAtoms = plan.baseline.observedPerpetualPositionAtoms;
  const initialResidualBaseAtoms = absolute(netSpotDeltaAtoms + perpetualDeltaAtoms);
  requireCondition(plan.initialResidualBaseAtoms === initialResidualBaseAtoms
    && initialResidualBaseAtoms <= policy.maxIntermediateResidual.atoms,
  'continuation initial residual violates its signed bound');
  const cloids = new Set(plan.baseline.priorRecoveryOrders.map(
    (order) => order.clientOrderId.toLowerCase(),
  ));
  requireCondition(cloids.size === plan.baseline.priorRecoveryOrders.length,
    'prior recovery client order IDs are duplicated');
  for (let index = 0; index < plan.orders.length; index += 1) {
    const order = plan.orders[index]!;
    const expectedOrder = expected[index]!;
    perpetualPositionAtoms = validateOrder(
      plan,
      expectedOrder,
      order,
      index,
      perpetualPositionAtoms,
      sourceAttempt.plan.prePerpetualPositionAtoms,
      sourceAttempt.plan.perpetualPositionTargetAtoms,
    );
    requireCondition(!cloids.has(order.clientOrderId.toLowerCase()),
      'recovery lineage client order IDs must be unique');
    cloids.add(order.clientOrderId.toLowerCase());
    requireCondition(JSON.stringify(plan.unsignedRequestFields.action.orders[index])
      === JSON.stringify(order.order),
    'continuation action order differs from the planned order');
    if (order.role === 'SPOT') netSpotDeltaAtoms += order.signedBaseDeltaAtoms;
    else perpetualDeltaAtoms += order.signedBaseDeltaAtoms;
    requireCondition(absolute(netSpotDeltaAtoms + perpetualDeltaAtoms)
      <= policy.maxIntermediateResidual.atoms,
    'continuation order exceeds the signed intermediate residual');
  }
  const terminalResidualBaseAtoms = absolute(netSpotDeltaAtoms + perpetualDeltaAtoms);
  requireCondition(plan.terminalResidualBaseAtoms === terminalResidualBaseAtoms
    && terminalResidualBaseAtoms <= policy.maxTerminalResidual.atoms,
  'continuation terminal residual violates its signed bound');
  if (plan.mode === 'PAIRED_ROLLBACK') {
    requireCondition(netSpotDeltaAtoms === 0n && perpetualDeltaAtoms === 0n
      && perpetualPositionAtoms === sourceAttempt.plan.prePerpetualPositionAtoms,
    'continuation rollback does not restore the pre-package state');
    return;
  }
  const terminal = sourceAttempt.plan.terminalResidualPolicy;
  if (terminal.kind === 'EXACT_NET') {
    requireCondition(netSpotDeltaAtoms === terminal.netSpotDeltaAtoms
      && perpetualPositionAtoms === sourceAttempt.plan.perpetualPositionTargetAtoms
      && terminalResidualBaseAtoms === 0n,
    'continuation completion violates the exact terminal policy');
  } else {
    requireCondition(netSpotDeltaAtoms >= terminal.minNetSpotDeltaAtoms
      && netSpotDeltaAtoms <= terminal.maxNetSpotDeltaAtoms
      && perpetualPositionAtoms === sourceAttempt.plan.perpetualPositionTargetAtoms
      && terminalResidualBaseAtoms <= terminal.maxTerminalResidualBaseAtoms
      && quoteResidualAtoms(terminalResidualBaseAtoms, sourceAttempt)
        <= terminal.maxTerminalResidualQuoteAtoms,
    'continuation completion violates the bounded terminal policy');
  }
}
