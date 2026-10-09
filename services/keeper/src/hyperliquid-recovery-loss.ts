import type { HyperliquidRecoveryAttempt } from './hyperliquid-recovery-reconciliation.js';
import type { HyperliquidLegReconciliationInput } from './index.js';
import type { HyperliquidObservedFill } from './hyperliquid-evidence-collector.js';

export const HYPERLIQUID_RECOVERY_LOSS_VALUATION_V1 =
  'NARYX_HYPERCORE_RECOVERY_ADVERSE_EXECUTION_LOSS_V1';

type Ratio = Readonly<{ numerator: bigint; denominator: bigint }>;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Hyperliquid recovery loss valuation failed: ${message}`);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function decimalRatio(value: string, baseDecimals: number, quoteDecimals: number): Ratio {
  requireCondition(Number.isSafeInteger(baseDecimals) && baseDecimals >= 0 && baseDecimals <= 38
    && Number.isSafeInteger(quoteDecimals) && quoteDecimals >= 0 && quoteDecimals <= 38,
  'asset decimals are unsupported');
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(value);
  requireCondition(match !== null, 'reference price is malformed');
  const fraction = match[2] ?? '';
  requireCondition(fraction.length <= 38, 'reference price precision is unsupported');
  const coefficient = BigInt(`${match[1]}${fraction}`);
  requireCondition(coefficient > 0n, 'reference price must be positive');
  return Object.freeze({
    numerator: coefficient * 10n ** BigInt(quoteDecimals),
    denominator: 10n ** BigInt(fraction.length + baseDecimals),
  });
}

function observedRatio(
  fill: HyperliquidObservedFill,
  baseDecimals: number,
  quoteDecimals: number,
): Ratio {
  requireCondition(fill.price.coefficient > 0n
    && Number.isSafeInteger(fill.price.scale)
    && fill.price.scale >= 0
    && fill.price.scale <= 38,
  'observed fill price is invalid');
  return Object.freeze({
    numerator: fill.price.coefficient * 10n ** BigInt(quoteDecimals),
    denominator: 10n ** BigInt(fill.price.scale + baseDecimals),
  });
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = absolute(left);
  let b = absolute(right);
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function add(left: Ratio, right: Ratio): Ratio {
  const divisor = greatestCommonDivisor(left.denominator, right.denominator);
  const leftFactor = right.denominator / divisor;
  const rightFactor = left.denominator / divisor;
  return Object.freeze({
    numerator: left.numerator * leftFactor + right.numerator * rightFactor,
    denominator: left.denominator * leftFactor,
  });
}

function signedNotional(quantityAtoms: bigint, price: Ratio): Ratio {
  return Object.freeze({
    numerator: quantityAtoms * price.numerator,
    denominator: price.denominator,
  });
}

function ceilPositive(value: Ratio): bigint {
  if (value.numerator <= 0n) return 0n;
  return value.numerator / value.denominator
    + (value.numerator % value.denominator === 0n ? 0n : 1n);
}

function sortedFills(fills: readonly HyperliquidObservedFill[]): readonly HyperliquidObservedFill[] {
  return Object.freeze([...fills].sort((left, right) =>
    left.observedAtMs - right.observedAtMs
      || left.orderId - right.orderId
      || left.transactionId - right.transactionId));
}

function fillTotal(fills: readonly HyperliquidObservedFill[]): bigint {
  return fills.reduce((total, fill) => total + fill.signedBaseAtoms, 0n);
}

function lineageOrders(attempt: HyperliquidRecoveryAttempt) {
  return Object.freeze([
    ...attempt.plan.baseline.priorRecoveryOrders,
    ...attempt.plan.orders,
  ]);
}

function completionLoss(
  attempt: HyperliquidRecoveryAttempt,
  recoveryFills: readonly HyperliquidObservedFill[],
  remainingByFill: ReadonlyMap<HyperliquidObservedFill, bigint>,
): bigint {
  let total = 0n;
  for (const order of lineageOrders(attempt).filter(
    (candidate) => candidate.action === 'COMPLETE_SPOT' || candidate.action === 'COMPLETE_PERP',
  )) {
    const leg = attempt.sourceAttempt.plan.legs.find((candidate) => candidate.role === order.role);
    requireCondition(leg !== undefined, 'completion leg is missing');
    const reference = decimalRatio(
      leg.order.p,
      leg.baseAsset.decimals,
      leg.quoteAsset.decimals,
    );
    for (const fill of recoveryFills.filter(
      (candidate) => candidate.clientOrderId === order.clientOrderId,
    )) {
      const remaining = remainingByFill.get(fill) ?? 0n;
      if (remaining === 0n) continue;
      const observed = observedRatio(fill, leg.baseAsset.decimals, leg.quoteAsset.decimals);
      const directionalDifference = fill.signedBaseAtoms > 0n
        ? observed.numerator * reference.denominator
          - reference.numerator * observed.denominator
        : reference.numerator * observed.denominator
          - observed.numerator * reference.denominator;
      if (directionalDifference > 0n) {
        total += ceilPositive({
          numerator: remaining * directionalDifference,
          denominator: observed.denominator * reference.denominator,
        });
      }
    }
  }
  return total;
}

function lineageLoss(
  attempt: HyperliquidRecoveryAttempt,
  sourceFills: readonly HyperliquidObservedFill[],
  recoveryFills: readonly HyperliquidObservedFill[],
): bigint {
  let total = 0n;
  const remainingByCompletionFill = new Map<HyperliquidObservedFill, bigint>();
  const planned = lineageOrders(attempt);
  for (const role of ['SPOT', 'PERPETUAL'] as const) {
    const leg = attempt.sourceAttempt.plan.legs.find((candidate) => candidate.role === role);
    requireCondition(leg !== undefined, 'recovery leg is missing');
    const completionIds = new Set(planned.filter((order) => order.role === role
      && (order.action === 'COMPLETE_SPOT' || order.action === 'COMPLETE_PERP'))
      .map((order) => order.clientOrderId));
    const rollbackIds = new Set(planned.filter((order) => order.role === role
      && (order.action === 'ROLLBACK_SPOT' || order.action === 'ROLLBACK_PERP'))
      .map((order) => order.clientOrderId));
    const openings = sortedFills([
      ...sourceFills.filter((fill) => fill.clientOrderId === leg.clientOrderId),
      ...recoveryFills.filter((fill) => completionIds.has(fill.clientOrderId)),
    ]).map((fill) => ({ fill, remaining: absolute(fill.signedBaseAtoms) }));
    for (const opening of openings) {
      if (completionIds.has(opening.fill.clientOrderId)) {
        remainingByCompletionFill.set(opening.fill, opening.remaining);
      }
    }
    const rollbacks = sortedFills(recoveryFills.filter(
      (fill) => rollbackIds.has(fill.clientOrderId),
    ));
    let roundTrip: Ratio = Object.freeze({ numerator: 0n, denominator: 1n });
    let openingIndex = 0;
    for (const rollback of rollbacks) {
      let remaining = absolute(rollback.signedBaseAtoms);
      while (remaining > 0n) {
        const opening = openings[openingIndex];
        requireCondition(opening !== undefined, 'rollback fill exceeds opening fills');
        if (opening.remaining === 0n) {
          openingIndex += 1;
          continue;
        }
        requireCondition((opening.fill.signedBaseAtoms > 0n) !== (rollback.signedBaseAtoms > 0n),
          'rollback fill does not reverse an opening fill');
        const quantity = remaining < opening.remaining ? remaining : opening.remaining;
        roundTrip = add(roundTrip, signedNotional(
          opening.fill.signedBaseAtoms > 0n ? quantity : -quantity,
          observedRatio(opening.fill, leg.baseAsset.decimals, leg.quoteAsset.decimals),
        ));
        roundTrip = add(roundTrip, signedNotional(
          rollback.signedBaseAtoms > 0n ? quantity : -quantity,
          observedRatio(rollback, leg.baseAsset.decimals, leg.quoteAsset.decimals),
        ));
        opening.remaining -= quantity;
        remaining -= quantity;
        if (completionIds.has(opening.fill.clientOrderId)) {
          remainingByCompletionFill.set(opening.fill, opening.remaining);
        }
      }
    }
    total += ceilPositive(roundTrip);
  }
  return total + completionLoss(attempt, recoveryFills, remainingByCompletionFill);
}

function validateObservedFills(
  attempt: HyperliquidRecoveryAttempt,
  sourceOrders: readonly HyperliquidLegReconciliationInput[],
  recoveryOrders: readonly HyperliquidLegReconciliationInput[],
  sourceFills: readonly HyperliquidObservedFill[],
  recoveryFills: readonly HyperliquidObservedFill[],
): void {
  const sourceEvidence = attempt.sourceAttempt.acceptedEvidence;
  requireCondition(sourceEvidence !== null, 'source evidence is missing');
  const expectedSource = new Map<`0x${string}`, bigint>([
    [sourceEvidence.spot.clientOrderId, sourceEvidence.spot.filledSignedBaseAtoms],
    [sourceEvidence.perpetual.clientOrderId, sourceEvidence.perpetual.filledSignedBaseAtoms],
  ]);
  const expectedRecovery = new Map(lineageOrders(attempt).map((order) => [
    order.clientOrderId,
    order.signedBaseDeltaAtoms,
  ]));
  requireCondition(sourceOrders.length === expectedSource.size
    && recoveryOrders.length === expectedRecovery.size
    && new Set(sourceOrders.map((order) => order.clientOrderId)).size === sourceOrders.length
    && new Set(recoveryOrders.map((order) => order.clientOrderId)).size === recoveryOrders.length,
  'order evidence identities are incomplete or duplicated');
  for (const order of sourceOrders) {
    const expected = expectedSource.get(order.clientOrderId);
    requireCondition(expected !== undefined
      && expected === order.filledSignedBaseAtoms
      && fillTotal(sourceFills.filter(
        (fill) => fill.clientOrderId === order.clientOrderId,
      )) === order.filledSignedBaseAtoms,
    'source fill evidence differs from the accepted source state');
  }
  for (const order of recoveryOrders) {
    const planned = expectedRecovery.get(order.clientOrderId);
    requireCondition(planned !== undefined
      && (order.filledSignedBaseAtoms === 0n
        || (order.filledSignedBaseAtoms > 0n) === (planned > 0n))
      && absolute(order.filledSignedBaseAtoms) <= absolute(planned)
      && fillTotal(recoveryFills.filter(
      (fill) => fill.clientOrderId === order.clientOrderId,
    )) === order.filledSignedBaseAtoms,
    'recovery fill evidence differs from the recovery order state');
  }
  requireCondition(sourceFills.every((fill) => {
    const expected = expectedSource.get(fill.clientOrderId);
    return expected !== undefined && expected !== 0n && fill.signedBaseAtoms !== 0n
      && (fill.signedBaseAtoms > 0n) === (expected > 0n);
  }) && recoveryFills.every((fill) => {
    const expected = expectedRecovery.get(fill.clientOrderId);
    return expected !== undefined && fill.signedBaseAtoms !== 0n
      && (fill.signedBaseAtoms > 0n) === (expected > 0n);
  }),
  'fill evidence contains an unknown order or direction');
}

export function hyperliquidRecoveryAggregateLossQuoteAtoms(input: Readonly<{
  attempt: HyperliquidRecoveryAttempt;
  sourceOrders: readonly HyperliquidLegReconciliationInput[];
  recoveryOrders: readonly HyperliquidLegReconciliationInput[];
  sourceFills: readonly HyperliquidObservedFill[];
  recoveryFills: readonly HyperliquidObservedFill[];
}>): bigint {
  validateObservedFills(
    input.attempt,
    input.sourceOrders,
    input.recoveryOrders,
    input.sourceFills,
    input.recoveryFills,
  );
  return lineageLoss(input.attempt, input.sourceFills, input.recoveryFills);
}
