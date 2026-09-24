import { createHash } from 'node:crypto';
import {
  compareHypercoreWirePriceToExact,
  formatHypercorePrice,
  formatHypercoreSize,
  type HypercoreOrderWire,
  type HyperliquidPlannedLeg,
  type HyperliquidPlanCommitments,
} from '@naryx/adapter-hyperliquid';
import {
  assetRef,
  bytesEqual,
  manifestHash,
  protocolId,
  type AssetRef,
  type DomainRef,
  type ExactPrice,
  type ManifestHash,
  type ProtocolId,
  type RecoveryAction,
  type RecoveryActionSlot,
} from '@naryx/protocol-types';
import type {
  HyperliquidAccountIdentity,
  HyperliquidPackageAttempt,
  HyperliquidReconciliationSnapshot,
} from './index.js';

const RECOVERY_CLOID_DOMAIN = 'naryx/hypercore/recovery-cloid/v1';
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const U64_MAX = (1n << 64n) - 1n;

export const NARYX_UNSIGNED_HYPERCORE_RECOVERY = 'NARYX_UNSIGNED_HYPERCORE_RECOVERY_V1';

export interface HyperliquidRecoveryCompilerOptions {
  readonly environment: 'testnet';
  readonly controllerId: string;
  readonly controllerCodeHash: Uint8Array | string;
  readonly authorityModeId: string;
  readonly actionBuilderCodeHash: Uint8Array | string;
}

export interface HyperliquidRecoveryBoundInput {
  readonly asset: AssetRef;
  readonly atoms: bigint;
}

export interface HyperliquidRecoveryCompileInput {
  readonly attempt: HyperliquidPackageAttempt;
  readonly nowMs: bigint;
  readonly recoverySequence: number;
  readonly projectedRecoveryCosts: readonly HyperliquidRecoveryBoundInput[];
  readonly projectedAggregateLoss: HyperliquidRecoveryBoundInput;
}

export interface HypercoreRecoveryOrderAction {
  readonly type: 'order';
  readonly orders: readonly HypercoreOrderWire[];
  readonly grouping: 'na';
}

export interface HyperliquidRecoveryPlannedOrder {
  readonly action: Exclude<RecoveryAction, 'CANCEL_OPEN_ORDERS'>;
  readonly actionSlotSequence: number;
  readonly role: 'SPOT' | 'PERPETUAL';
  readonly signedBaseDeltaAtoms: bigint;
  readonly clientOrderId: `0x${string}`;
  readonly order: HypercoreOrderWire;
}

export interface HyperliquidRecoveryExecutionPlan {
  readonly version: 1;
  readonly guarantee: typeof NARYX_UNSIGNED_HYPERCORE_RECOVERY;
  readonly mode: 'COMPLETE_MISSING_LEG' | 'PAIRED_ROLLBACK';
  readonly domain: DomainRef;
  readonly commitments: HyperliquidPlanCommitments;
  readonly account: HyperliquidAccountIdentity;
  readonly recoverySequence: number;
  readonly sourceEvidenceVersion: bigint;
  readonly reconciledStateSchemaHash: ManifestHash;
  readonly controllerId: ProtocolId;
  readonly controllerCodeHash: ManifestHash;
  readonly authorityModeId: ProtocolId;
  readonly actionBuilderCodeHash: ManifestHash;
  readonly actionExpiryMs: bigint;
  readonly recoveryDeadlineMs: bigint;
  readonly projectedRecoveryCosts: readonly HyperliquidRecoveryBoundInput[];
  readonly projectedAggregateLoss: HyperliquidRecoveryBoundInput;
  readonly initialResidualBaseAtoms: bigint;
  readonly terminalResidualBaseAtoms: bigint;
  readonly orders: readonly HyperliquidRecoveryPlannedOrder[];
  readonly unsignedRequestFields: Readonly<{
    readonly action: HypercoreRecoveryOrderAction;
    readonly expiresAfter: number;
  }>;
}

interface CompilerIdentity {
  readonly controllerId: ProtocolId;
  readonly controllerCodeHash: ManifestHash;
  readonly authorityModeId: ProtocolId;
  readonly actionBuilderCodeHash: ManifestHash;
}

interface RecoveryIntent {
  readonly mode: HyperliquidRecoveryExecutionPlan['mode'];
  readonly action: Exclude<RecoveryAction, 'CANCEL_OPEN_ORDERS'>;
  readonly role: 'SPOT' | 'PERPETUAL';
  readonly signedBaseDeltaAtoms: bigint;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function sameAdapter(
  left: HyperliquidPlannedLeg['adapter'],
  right: HyperliquidPlannedLeg['adapter'],
): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function sameMarket(
  left: HyperliquidPlannedLeg['market'],
  right: HyperliquidPlannedLeg['market'],
): boolean {
  return left.subjectId === right.subjectId
    && left.manifestVersion === right.manifestVersion
    && bytesEqual(left.manifestHash, right.manifestHash);
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

function sameAccount(left: HyperliquidAccountIdentity, right: HyperliquidAccountIdentity): boolean {
  return left.masterAccount === right.masterAccount
    && left.tradingAccount === right.tradingAccount
    && left.accountKind === right.accountKind;
}

function samePrice(
  left: ExactPrice,
  right: ExactPrice,
): boolean {
  return sameAsset(left.baseAsset, right.baseAsset)
    && sameAsset(left.quoteAsset, right.quoteAsset)
    && left.baseAtoms === right.baseAtoms
    && left.quoteAtoms === right.quoteAtoms
    && left.roundingDirection === right.roundingDirection;
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

function recoveryClientOrderId(
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
  ]) {
    digest.update(encodedPart(part));
  }
  return `0x${digest.digest().subarray(0, 16).toString('hex')}`;
}

function normalizedBound(input: HyperliquidRecoveryBoundInput, name: string): HyperliquidRecoveryBoundInput {
  requireCondition(input.atoms >= 0n, `${name}.atoms must be nonnegative`);
  return Object.freeze({
    asset: assetRef(
      input.asset.assetId,
      input.asset.assetManifestHash,
      input.asset.decimals,
      `${name}.asset`,
    ),
    atoms: input.atoms,
  });
}

function validateCosts(
  projected: readonly HyperliquidRecoveryBoundInput[],
  signed: HyperliquidPackageAttempt['plan']['recoveryPolicy']['maxRecoveryCostCaps'],
): readonly HyperliquidRecoveryBoundInput[] {
  requireCondition(projected.length === signed.length, 'projected recovery costs must cover every signed cost asset');
  const normalized = projected.map((value, index) => normalizedBound(value, `projectedRecoveryCosts[${index}]`));
  for (let index = 0; index < normalized.length; index += 1) {
    const value = normalized[index]!;
    requireCondition(
      normalized.findIndex((other) => sameAsset(other.asset, value.asset)) === index,
      'projected recovery cost assets must be unique',
    );
    const cap = signed.find((candidate) => sameAsset(candidate.asset, value.asset));
    requireCondition(cap !== undefined, 'projected recovery cost asset is not signed');
    requireCondition(value.atoms <= cap.maxAtoms, 'projected recovery cost exceeds signed cap');
  }
  return Object.freeze(signed.map((cap) => normalized.find((value) => sameAsset(value.asset, cap.asset))!));
}

function requireFreshTerminalEvidence(
  attempt: HyperliquidPackageAttempt,
  nowMs: bigint,
): HyperliquidReconciliationSnapshot {
  requireCondition(attempt.status === 'RECOVERY_REQUIRED', 'recovery compilation requires RECOVERY_REQUIRED');
  requireCondition(attempt.lockEvidence === null, 'manual or conflicting evidence cannot compile recovery');
  const evidence = attempt.acceptedEvidence;
  requireCondition(evidence !== null && attempt.recoveryObligation !== null,
    'recovery obligation and accepted evidence are required');
  requireCondition(evidence.observedAtMs === nowMs,
    'recovery requires an authoritative snapshot at the compilation time');
  requireCondition(evidence.feeEvidenceComplete
    && evidence.fees.every((fee) => fee.evidenceStatus === 'CONFIRMED'),
  'uncertain fee evidence cannot compile recovery');
  requireCondition(evidence.spot.openOrderStatus === 'NONE'
    && evidence.perpetual.openOrderStatus === 'NONE',
  'open or uncertain IOC orders cannot compile recovery');
  requireCondition(evidence.spot.terminalStatus !== 'UNKNOWN'
    && evidence.perpetual.terminalStatus !== 'UNKNOWN',
  'uncertain terminal evidence cannot compile recovery');
  requireCondition(evidence.netSpotDeltaAtoms === evidence.spot.filledSignedBaseAtoms,
    'spot balance effects are ambiguous');
  return evidence;
}

function validateRecoveryObligation(
  attempt: HyperliquidPackageAttempt,
  evidence: HyperliquidReconciliationSnapshot,
): void {
  const obligation = attempt.recoveryObligation;
  requireCondition(obligation !== null, 'recovery obligation is missing');
  requireCondition(sameDomain(obligation.domain, attempt.plan.domain)
    && sameCommitments(obligation.commitments, attempt.plan.commitments)
    && sameAccount(obligation.account, attempt.account),
  'recovery obligation identity mismatch');
  requireCondition(sameDomain(evidence.domain, attempt.plan.domain)
    && sameCommitments(evidence.commitments, attempt.plan.commitments)
    && sameAccount(evidence.account, attempt.account),
  'accepted recovery evidence identity mismatch');
  requireCondition(evidence.spot.clientOrderId === attempt.plan.spotClientOrderId
    && evidence.perpetual.clientOrderId === attempt.plan.perpetualClientOrderId,
  'accepted recovery evidence order identity mismatch');
  requireCondition(obligation.observedNetSpotDeltaAtoms === evidence.netSpotDeltaAtoms
    && obligation.observedPerpetualDeltaAtoms === evidence.perpetualPositionDeltaAtoms
    && obligation.observedPerpetualPositionAtoms === evidence.observedPerpetualPositionAtoms,
  'recovery obligation does not match accepted evidence');
  requireCondition(evidence.observedPerpetualPositionAtoms
    === attempt.plan.prePerpetualPositionAtoms + evidence.perpetualPositionDeltaAtoms,
  'accepted recovery evidence has an inconsistent perpetual position');
  requireCondition(obligation.targetPerpetualPositionAtoms
    === attempt.plan.perpetualPositionTargetAtoms
    && obligation.remainingPerpetualDeltaAtoms
      === attempt.plan.perpetualPositionTargetAtoms - evidence.observedPerpetualPositionAtoms,
  'recovery obligation perpetual target mismatch');
  const terminal = attempt.plan.terminalResidualPolicy;
  const minSpot = terminal.kind === 'EXACT_NET'
    ? terminal.netSpotDeltaAtoms
    : terminal.minNetSpotDeltaAtoms;
  const maxSpot = terminal.kind === 'EXACT_NET'
    ? terminal.netSpotDeltaAtoms
    : terminal.maxNetSpotDeltaAtoms;
  requireCondition(obligation.remainingNetSpotDeltaToMinimumAtoms
    === minSpot - evidence.netSpotDeltaAtoms
    && obligation.remainingNetSpotDeltaToMaximumAtoms
      === maxSpot - evidence.netSpotDeltaAtoms
    && obligation.allowedTerminalOutcome === terminal.kind
    && obligation.signedLimits.kind === terminal.kind,
  'recovery obligation signed limits mismatch');
  requireCondition(obligation.signedLimits.minNetSpotDeltaAtoms === minSpot
    && obligation.signedLimits.maxNetSpotDeltaAtoms === maxSpot
    && obligation.signedLimits.maxTerminalResidualBaseAtoms
      === terminal.maxTerminalResidualBaseAtoms
    && obligation.signedLimits.maxTerminalResidualQuoteAtoms
      === terminal.maxTerminalResidualQuoteAtoms,
  'recovery obligation terminal caps mismatch');
  if (terminal.kind === 'BOUNDED_NET') {
    requireCondition(obligation.signedLimits.kind === 'BOUNDED_NET'
      && obligation.signedLimits.residualValuationSchemaVersion
        === terminal.residualValuationSchemaVersion
      && samePrice(
        obligation.signedLimits.residualValuationReferencePrice,
        terminal.residualValuationReferencePrice,
      ),
    'recovery obligation valuation mismatch');
  }
}

function matchingSlot(
  attempt: HyperliquidPackageAttempt,
  action: Exclude<RecoveryAction, 'CANCEL_OPEN_ORDERS'>,
  leg: HyperliquidPlannedLeg,
): RecoveryActionSlot | undefined {
  const candidates = attempt.plan.recoveryPolicy.actionSlots.filter((slot) => slot.action === action);
  if (candidates.length === 0) return undefined;
  requireCondition(candidates.length === 1, `${action} recovery action is ambiguous`);
  const slot = candidates[0]!;
  requireCondition(slot.targetLeg === leg.legIndex, `${action} target leg mismatch`);
  requireCondition(sameAdapter(slot.adapter, leg.adapter), `${action} adapter mismatch`);
  requireCondition(slot.markets.length === 1 && sameMarket(slot.markets[0]!, leg.market),
    `${action} market binding mismatch`);
  return slot;
}

function completionIntent(
  attempt: HyperliquidPackageAttempt,
  evidence: HyperliquidReconciliationSnapshot,
  spot: HyperliquidPlannedLeg,
  perpetual: HyperliquidPlannedLeg,
): RecoveryIntent | null {
  const spotMissing = spot.signedBaseDeltaAtoms - evidence.netSpotDeltaAtoms;
  const perpetualMissing = attempt.plan.plannedPerpetualDeltaAtoms
    - evidence.perpetualPositionDeltaAtoms;
  if (evidence.netSpotDeltaAtoms === spot.signedBaseDeltaAtoms && perpetualMissing !== 0n) {
    if (matchingSlot(attempt, 'COMPLETE_PERP', perpetual) === undefined) return null;
    return { mode: 'COMPLETE_MISSING_LEG', action: 'COMPLETE_PERP', role: 'PERPETUAL',
      signedBaseDeltaAtoms: perpetualMissing };
  }
  if (evidence.perpetualPositionDeltaAtoms === attempt.plan.plannedPerpetualDeltaAtoms
    && spotMissing !== 0n) {
    if (matchingSlot(attempt, 'COMPLETE_SPOT', spot) === undefined) return null;
    return { mode: 'COMPLETE_MISSING_LEG', action: 'COMPLETE_SPOT', role: 'SPOT',
      signedBaseDeltaAtoms: spotMissing };
  }
  return null;
}

function rollbackIntents(
  attempt: HyperliquidPackageAttempt,
  evidence: HyperliquidReconciliationSnapshot,
  spot: HyperliquidPlannedLeg,
  perpetual: HyperliquidPlannedLeg,
): readonly RecoveryIntent[] {
  const intents: RecoveryIntent[] = [];
  if (evidence.netSpotDeltaAtoms !== 0n) {
    requireCondition(matchingSlot(attempt, 'ROLLBACK_SPOT', spot) !== undefined,
      'ROLLBACK_SPOT recovery action is unavailable');
    intents.push({ mode: 'PAIRED_ROLLBACK', action: 'ROLLBACK_SPOT', role: 'SPOT',
      signedBaseDeltaAtoms: -evidence.netSpotDeltaAtoms });
  }
  if (evidence.perpetualPositionDeltaAtoms !== 0n) {
    requireCondition(matchingSlot(attempt, 'ROLLBACK_PERP', perpetual) !== undefined,
      'ROLLBACK_PERP recovery action is unavailable');
    intents.push({ mode: 'PAIRED_ROLLBACK', action: 'ROLLBACK_PERP', role: 'PERPETUAL',
      signedBaseDeltaAtoms: -evidence.perpetualPositionDeltaAtoms });
  }
  requireCondition(intents.length > 0, 'recovery has no deterministic completion or rollback action');
  return intents;
}

function requirePerpetualPositionSafety(
  slot: RecoveryActionSlot,
  currentPosition: bigint,
  delta: bigint,
  expectedFinalPosition: bigint,
): void {
  const finalPosition = currentPosition + delta;
  requireCondition(finalPosition === expectedFinalPosition, 'perpetual recovery target mismatch');
  requireCondition(
    currentPosition === 0n || finalPosition === 0n || (currentPosition > 0n) === (finalPosition > 0n),
    'perpetual recovery would flip the position',
  );
  const reduces = absolute(finalPosition) < absolute(currentPosition);
  requireCondition(slot.reduceOnly === reduces, 'perpetual reduce-only policy is incorrect');
  if (slot.reduceOnly) {
    requireCondition(currentPosition !== 0n && absolute(delta) <= absolute(currentPosition),
      'reduce-only recovery can cross the position');
  }
}

function compileOrder(
  attempt: HyperliquidPackageAttempt,
  evidence: HyperliquidReconciliationSnapshot,
  intent: RecoveryIntent,
  slot: RecoveryActionSlot,
  leg: HyperliquidPlannedLeg,
  recoverySequence: number,
  ordinal: number,
): HyperliquidRecoveryPlannedOrder {
  requireCondition(intent.signedBaseDeltaAtoms !== 0n, 'recovery action quantity is zero');
  requireCondition(slot.maxQuantity !== undefined && slot.limitPrice !== undefined
    && slot.reduceOnly !== undefined && slot.timeInForce === 'IOC',
  'recovery trade slot is incomplete');
  requireCondition(sameAsset(slot.maxQuantity.asset, leg.baseAsset), 'recovery quantity asset mismatch');
  requireCondition(absolute(intent.signedBaseDeltaAtoms) <= slot.maxQuantity.atoms,
    'recovery quantity exceeds signed maximum');
  requireCondition(sameAsset(slot.limitPrice.baseAsset, leg.baseAsset)
    && sameAsset(slot.limitPrice.quoteAsset, leg.quoteAsset),
  'recovery price assets mismatch');
  if (intent.role === 'SPOT') {
    requireCondition(slot.reduceOnly === false, 'spot recovery cannot be reduce-only');
  } else {
    const expectedFinalPosition = intent.mode === 'COMPLETE_MISSING_LEG'
      ? attempt.plan.perpetualPositionTargetAtoms
      : attempt.plan.prePerpetualPositionAtoms;
    requirePerpetualPositionSafety(
      slot,
      evidence.observedPerpetualPositionAtoms,
      intent.signedBaseDeltaAtoms,
      expectedFinalPosition,
    );
  }
  const buy = intent.signedBaseDeltaAtoms > 0n;
  const price = formatHypercorePrice(slot.limitPrice, leg.maxPriceDecimals);
  const priceRelation = compareHypercoreWirePriceToExact(price, slot.limitPrice);
  requireCondition(buy ? priceRelation <= 0 : priceRelation >= 0,
    buy ? 'wire buy price exceeds signed cap' : 'wire sell price is below signed minimum');
  const size = formatHypercoreSize(
    absolute(intent.signedBaseDeltaAtoms),
    leg.baseAsset.decimals,
    leg.sizeDecimals,
  );
  const clientOrderId = recoveryClientOrderId(
    attempt.plan.domain,
    attempt.plan.commitments,
    evidence.evidenceVersion,
    recoverySequence,
    slot.sequence,
    intent.role,
    ordinal,
  );
  const order: HypercoreOrderWire = Object.freeze({
    a: leg.order.a,
    b: buy,
    p: price.value,
    s: size,
    r: slot.reduceOnly,
    t: Object.freeze({ limit: Object.freeze({ tif: 'Ioc' as const }) }),
    c: clientOrderId,
  });
  return Object.freeze({
    action: intent.action,
    actionSlotSequence: slot.sequence,
    role: intent.role,
    signedBaseDeltaAtoms: intent.signedBaseDeltaAtoms,
    clientOrderId,
    order,
  });
}

function quoteResidualAtoms(baseResidualAtoms: bigint, attempt: HyperliquidPackageAttempt): bigint {
  const policy = attempt.plan.terminalResidualPolicy;
  requireCondition(policy.kind === 'BOUNDED_NET', 'quote residual valuation is unavailable');
  const numerator = baseResidualAtoms * policy.residualValuationReferencePrice.quoteAtoms;
  const denominator = policy.residualValuationReferencePrice.baseAtoms;
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

export class HyperliquidRecoveryCompiler {
  readonly #identity: CompilerIdentity;

  constructor(options: HyperliquidRecoveryCompilerOptions) {
    requireCondition(options.environment === 'testnet', 'only HyperCore testnet recovery is enabled');
    this.#identity = Object.freeze({
      controllerId: protocolId(options.controllerId, 'controllerId'),
      controllerCodeHash: manifestHash(options.controllerCodeHash, 'controllerCodeHash'),
      authorityModeId: protocolId(options.authorityModeId, 'authorityModeId'),
      actionBuilderCodeHash: manifestHash(options.actionBuilderCodeHash, 'actionBuilderCodeHash'),
    });
  }

  compile(input: HyperliquidRecoveryCompileInput): HyperliquidRecoveryExecutionPlan {
    const { attempt } = input;
    requireCondition(attempt.plan.domain.domainId === 'hypercore:testnet',
      'only the exact HyperCore testnet domain is supported');
    const policy = attempt.plan.recoveryPolicy;
    requireCondition(policy.recoveryExpiryUnit === 'HYPERLIQUID_UNIX_MILLISECONDS',
      'recovery clock is unsupported');
    requireCondition(policy.deadlineValue === attempt.plan.recoveryDeadlineMs
      && policy.deadlineValue === attempt.recoveryObligation?.deadlineMs,
    'recovery deadline binding mismatch');
    requireCondition(input.nowMs > 0n
      && input.nowMs < policy.maxActionExpiryValue
      && input.nowMs < policy.deadlineValue,
    'signed recovery action expiry or deadline is stale');
    requireCondition(policy.maxActionExpiryValue <= MAX_SAFE_INTEGER,
      'recovery action expiry exceeds the unsigned request range');
    requireCondition(policy.maxActionExpiryValue + policy.minRecoveryWindowMs <= policy.deadlineValue,
      'signed minimum recovery window is not preserved');
    requireCondition(policy.controllerId === this.#identity.controllerId
      && bytesEqual(policy.controllerCodeHash, this.#identity.controllerCodeHash)
      && policy.authorityModeId === this.#identity.authorityModeId
      && bytesEqual(policy.actionBuilderCodeHash, this.#identity.actionBuilderCodeHash),
    'recovery controller or action-builder identity mismatch');
    requireCondition(Number.isInteger(input.recoverySequence)
      && input.recoverySequence >= 0 && input.recoverySequence <= 0xffff_ffff,
    'recoverySequence must fit u32');

    const evidence = requireFreshTerminalEvidence(attempt, input.nowMs);
    requireCondition(evidence.evidenceVersion <= U64_MAX, 'recovery evidence version exceeds u64');
    validateRecoveryObligation(attempt, evidence);
    const spot = attempt.plan.legs.find((leg) => leg.role === 'SPOT');
    const perpetual = attempt.plan.legs.find((leg) => leg.role === 'PERPETUAL');
    requireCondition(spot !== undefined && perpetual !== undefined, 'exact spot and perpetual legs are required');
    requireCondition(sameAsset(spot.baseAsset, perpetual.baseAsset)
      && sameAsset(spot.quoteAsset, perpetual.quoteAsset),
    'recovery leg assets mismatch');
    requireCondition(sameAsset(policy.maxIntermediateResidual.asset, spot.baseAsset)
      && sameAsset(policy.maxTerminalResidual.asset, spot.baseAsset),
    'recovery residual cap asset mismatch');

    const costs = validateCosts(input.projectedRecoveryCosts, policy.maxRecoveryCostCaps);
    const projectedLoss = normalizedBound(input.projectedAggregateLoss, 'projectedAggregateLoss');
    requireCondition(sameAsset(projectedLoss.asset, policy.maxAggregateRecoveryLoss.asset),
      'projected recovery loss asset mismatch');
    requireCondition(projectedLoss.atoms <= policy.maxAggregateRecoveryLoss.atoms,
      'projected aggregate recovery loss exceeds signed cap');

    const completion = completionIntent(attempt, evidence, spot, perpetual);
    const intents = completion === null
      ? rollbackIntents(attempt, evidence, spot, perpetual)
      : [completion];
    const ordered = [...intents].sort((left, right) => {
      const leftLeg = left.role === 'SPOT' ? spot : perpetual;
      const rightLeg = right.role === 'SPOT' ? spot : perpetual;
      return matchingSlot(attempt, left.action, leftLeg)!.sequence
        - matchingSlot(attempt, right.action, rightLeg)!.sequence;
    });
    const orders = Object.freeze(ordered.map((intent, ordinal) => {
      const leg = intent.role === 'SPOT' ? spot : perpetual;
      const slot = matchingSlot(attempt, intent.action, leg);
      requireCondition(slot !== undefined, `${intent.action} recovery action is unavailable`);
      return compileOrder(attempt, evidence, intent, slot, leg, input.recoverySequence, ordinal);
    }));

    let netSpotDeltaAtoms = evidence.netSpotDeltaAtoms;
    let perpetualDeltaAtoms = evidence.perpetualPositionDeltaAtoms;
    const initialResidualBaseAtoms = absolute(netSpotDeltaAtoms + perpetualDeltaAtoms);
    requireCondition(initialResidualBaseAtoms <= policy.maxIntermediateResidual.atoms,
      'initial recovery residual exceeds signed intermediate cap');
    for (const order of orders) {
      if (order.role === 'SPOT') netSpotDeltaAtoms += order.signedBaseDeltaAtoms;
      else perpetualDeltaAtoms += order.signedBaseDeltaAtoms;
      requireCondition(absolute(netSpotDeltaAtoms + perpetualDeltaAtoms)
        <= policy.maxIntermediateResidual.atoms,
      'recovery action exceeds signed intermediate residual cap');
    }
    const terminalResidualBaseAtoms = absolute(netSpotDeltaAtoms + perpetualDeltaAtoms);
    requireCondition(terminalResidualBaseAtoms <= policy.maxTerminalResidual.atoms,
      'recovery result exceeds signed terminal residual cap');
    const terminalPolicy = attempt.plan.terminalResidualPolicy;
    const mode = orders[0]!.action.startsWith('COMPLETE_')
      ? 'COMPLETE_MISSING_LEG'
      : 'PAIRED_ROLLBACK';
    if (mode === 'PAIRED_ROLLBACK') {
      requireCondition(netSpotDeltaAtoms === 0n && perpetualDeltaAtoms === 0n,
        'rollback recovery does not flatten package effects');
    } else if (terminalPolicy.kind === 'EXACT_NET') {
      requireCondition(netSpotDeltaAtoms === terminalPolicy.netSpotDeltaAtoms
        && terminalResidualBaseAtoms === 0n,
      'recovery result violates exact terminal policy');
    } else {
      requireCondition(netSpotDeltaAtoms >= terminalPolicy.minNetSpotDeltaAtoms
        && netSpotDeltaAtoms <= terminalPolicy.maxNetSpotDeltaAtoms,
      'recovery result violates signed spot interval');
      requireCondition(terminalResidualBaseAtoms <= terminalPolicy.maxTerminalResidualBaseAtoms
        && quoteResidualAtoms(terminalResidualBaseAtoms, attempt)
          <= terminalPolicy.maxTerminalResidualQuoteAtoms,
      'recovery result violates signed terminal valuation caps');
    }

    const action: HypercoreRecoveryOrderAction = Object.freeze({
      type: 'order',
      orders: Object.freeze(orders.map((order) => order.order)),
      grouping: 'na',
    });
    return Object.freeze({
      version: 1,
      guarantee: NARYX_UNSIGNED_HYPERCORE_RECOVERY,
      mode,
      domain: attempt.plan.domain,
      commitments: attempt.plan.commitments,
      account: attempt.account,
      recoverySequence: input.recoverySequence,
      sourceEvidenceVersion: evidence.evidenceVersion,
      reconciledStateSchemaHash: policy.reconciledStateSchemaHash,
      controllerId: policy.controllerId,
      controllerCodeHash: policy.controllerCodeHash,
      authorityModeId: policy.authorityModeId,
      actionBuilderCodeHash: policy.actionBuilderCodeHash,
      actionExpiryMs: policy.maxActionExpiryValue,
      recoveryDeadlineMs: policy.deadlineValue,
      projectedRecoveryCosts: costs,
      projectedAggregateLoss: projectedLoss,
      initialResidualBaseAtoms,
      terminalResidualBaseAtoms,
      orders,
      unsignedRequestFields: Object.freeze({
        action,
        expiresAfter: Number(policy.maxActionExpiryValue),
      }),
    });
  }
}
