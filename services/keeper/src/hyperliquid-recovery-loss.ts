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

function completionLoss(
  attempt: HyperliquidRecoveryAttempt,
  recoveryFills: readonly HyperliquidObservedFill[],
): bigint {
  let total = 0n;
  for (const order of attempt.plan.orders) {
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
      const observed = observedRatio(fill, leg.baseAsset.decimals, leg.quoteAsset.decimals);
      const directionalDifference = fill.signedBaseAtoms > 0n
        ? observed.numerator * reference.denominator
          - reference.numerator * observed.denominator
        : reference.numerator * observed.denominator
          - observed.numerator * reference.denominator;
      if (directionalDifference > 0n) {
        total += ceilPositive({
          numerator: absolute(fill.signedBaseAtoms) * directionalDifference,
          denominator: observed.denominator * reference.denominator,
        });
      }
    }
  }
  return total;
}

function rollbackLoss(
  attempt: HyperliquidRecoveryAttempt,
  sourceFills: readonly HyperliquidObservedFill[],
  recoveryFills: readonly HyperliquidObservedFill[],
): bigint {
  let total = 0n;
  for (const order of attempt.plan.orders) {
    const leg = attempt.sourceAttempt.plan.legs.find((candidate) => candidate.role === order.role);
    requireCondition(leg !== undefined, 'rollback leg is missing');
    const source = sortedFills(sourceFills.filter(
      (candidate) => candidate.clientOrderId === leg.clientOrderId,
    ));
    const recovery = recoveryFills.filter(
      (candidate) => candidate.clientOrderId === order.clientOrderId,
    );
    const recoveredAtoms = absolute(fillTotal(recovery));
    let remaining = recoveredAtoms;
    let roundTrip: Ratio = Object.freeze({ numerator: 0n, denominator: 1n });
    for (const fill of source) {
      if (remaining === 0n) break;
      const quantity = remaining < absolute(fill.signedBaseAtoms)
        ? remaining
        : absolute(fill.signedBaseAtoms);
      const signedQuantity = fill.signedBaseAtoms > 0n ? quantity : -quantity;
      roundTrip = add(roundTrip, signedNotional(
        signedQuantity,
        observedRatio(fill, leg.baseAsset.decimals, leg.quoteAsset.decimals),
      ));
      remaining -= quantity;
    }
    requireCondition(remaining === 0n, 'rollback fill exceeds the source fill');
    for (const fill of recovery) {
      roundTrip = add(roundTrip, signedNotional(
        fill.signedBaseAtoms,
        observedRatio(fill, leg.baseAsset.decimals, leg.quoteAsset.decimals),
      ));
    }
    total += ceilPositive(roundTrip);
  }
  return total;
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
  const expectedRecovery = new Map(attempt.plan.orders.map((order) => [
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
  return input.attempt.plan.mode === 'COMPLETE_MISSING_LEG'
    ? completionLoss(input.attempt, input.recoveryFills)
    : rollbackLoss(input.attempt, input.sourceFills, input.recoveryFills);
}
