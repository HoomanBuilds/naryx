import { checkedUnsigned } from './arithmetic.js';
import { canonicalBytes } from './encoding.js';
import { enumDiscriminant } from './enums.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { packageGraph, packageGraphHash, type PackageGraph, type PackageGraphInput } from './package-graph.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';

const U64_BITS = 64;
const U128_BITS = 128;

export const STRATEGY_SLICE_POLICY_VERSION = 1;

export const STRATEGY_SLICE_POLICY_CATEGORY = Object.freeze({
  NETTING: 1,
  PRIVACY: 2,
  SOLVER: 3,
  DELIVERY: 4,
  RESOURCE: 5,
  PORTFOLIO_RISK_LIMITS: 6,
} as const);
export type StrategySlicePolicyCategory = keyof typeof STRATEGY_SLICE_POLICY_CATEGORY;

export interface StrategySlicePolicyInput {
  readonly policyVersion: number;
  readonly category: StrategySlicePolicyCategory;
  readonly parentOrderHash: Uint8Array | string;
  readonly parentGraphHash: Uint8Array | string;
  readonly parentPolicyHash: Uint8Array | string;
  readonly activationAttemptId: Uint8Array | string;
  readonly parentEconomicQuantity: bigint;
  readonly childEconomicQuantity: bigint;
  readonly graphNonce: bigint;
}

export interface StrategySlicePolicy extends Omit<
  StrategySlicePolicyInput,
  'parentOrderHash' | 'parentGraphHash' | 'parentPolicyHash' | 'activationAttemptId'
> {
  readonly policyVersion: 1;
  readonly parentOrderHash: CommitmentHash;
  readonly parentGraphHash: CommitmentHash;
  readonly parentPolicyHash: CommitmentHash;
  readonly activationAttemptId: CommitmentHash;
}

export interface StrategySliceResult {
  readonly graph: PackageGraph;
  readonly policies: Readonly<Record<StrategySlicePolicyCategory, StrategySlicePolicy>>;
}

function positive(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  const checked = checkedUnsigned(value, bits, context);
  if (checked === 0n) throw new MalformedInputError(context, 'expected a positive value');
  return checked;
}

export function strategySlicePolicy(
  input: StrategySlicePolicyInput,
  context = 'strategySlicePolicy',
): StrategySlicePolicy {
  if (typeof input !== 'object' || input === null) throw new MalformedInputError(context, 'expected an object');
  if (input.policyVersion !== STRATEGY_SLICE_POLICY_VERSION) {
    throw new MalformedInputError(`${context}.policyVersion`, `version must equal ${STRATEGY_SLICE_POLICY_VERSION}`);
  }
  enumDiscriminant(STRATEGY_SLICE_POLICY_CATEGORY, input.category, `${context}.category`);
  const parentEconomicQuantity = positive(input.parentEconomicQuantity, U128_BITS, `${context}.parentEconomicQuantity`);
  const childEconomicQuantity = positive(input.childEconomicQuantity, U128_BITS, `${context}.childEconomicQuantity`);
  if (childEconomicQuantity > parentEconomicQuantity) {
    throw new MalformedInputError(`${context}.childEconomicQuantity`, 'child quantity exceeds its parent');
  }
  return Object.freeze({
    policyVersion: STRATEGY_SLICE_POLICY_VERSION,
    category: input.category,
    parentOrderHash: commitmentHash(input.parentOrderHash, `${context}.parentOrderHash`),
    parentGraphHash: commitmentHash(input.parentGraphHash, `${context}.parentGraphHash`),
    parentPolicyHash: commitmentHash(input.parentPolicyHash, `${context}.parentPolicyHash`),
    activationAttemptId: commitmentHash(input.activationAttemptId, `${context}.activationAttemptId`),
    parentEconomicQuantity,
    childEconomicQuantity,
    graphNonce: positive(input.graphNonce, U64_BITS, `${context}.graphNonce`),
  });
}

export function strategySlicePolicyBytes(input: StrategySlicePolicyInput): Uint8Array {
  const policy = strategySlicePolicy(input);
  return canonicalBytes((writer) => {
    writer.writeU32(policy.policyVersion, 'policyVersion');
    writer.writeEnum(STRATEGY_SLICE_POLICY_CATEGORY, policy.category, 'category');
    encodeCommitmentHash(writer, policy.parentOrderHash, 'parentOrderHash');
    encodeCommitmentHash(writer, policy.parentGraphHash, 'parentGraphHash');
    encodeCommitmentHash(writer, policy.parentPolicyHash, 'parentPolicyHash');
    encodeCommitmentHash(writer, policy.activationAttemptId, 'activationAttemptId');
    writer.writeU128(policy.parentEconomicQuantity, 'parentEconomicQuantity');
    writer.writeU128(policy.childEconomicQuantity, 'childEconomicQuantity');
    writer.writeU64(policy.graphNonce, 'graphNonce');
  });
}

export function strategySlicePolicyHash(input: StrategySlicePolicyInput): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.STRATEGY_SLICE_POLICY, strategySlicePolicyBytes(input)),
    'strategySlicePolicyHash',
  );
}

function exactScale(value: bigint, child: bigint, parent: bigint, context: string): bigint {
  const product = value * child;
  if (product % parent !== 0n) {
    throw new MalformedInputError(context, 'quantity cannot be sliced without changing the package ratio');
  }
  const scaled = product / parent;
  if (value > 0n && scaled === 0n) throw new MalformedInputError(context, 'slice is below the package lot size');
  return scaled;
}

function boundedScale(value: bigint, child: bigint, parent: bigint): bigint {
  return (value * child) / parent;
}

const POLICY_KEYS = Object.freeze([
  ['NETTING', 'netting'],
  ['PRIVACY', 'privacy'],
  ['SOLVER', 'solver'],
  ['DELIVERY', 'delivery'],
  ['RESOURCE', 'resource'],
  ['PORTFOLIO_RISK_LIMITS', 'portfolioRiskLimits'],
] as const);

export function sliceStrategyPackageGraph(input: Readonly<{
  parentGraph: PackageGraphInput;
  parentOrderHash: Uint8Array | string;
  activationAttemptId: Uint8Array | string;
  parentEconomicQuantity: bigint;
  childEconomicQuantity: bigint;
  graphNonce: bigint;
}>): StrategySliceResult {
  const parent = packageGraph(input.parentGraph, 'sliceStrategyPackageGraph.parentGraph');
  const parentQuantity = positive(input.parentEconomicQuantity, U128_BITS, 'sliceStrategyPackageGraph.parentEconomicQuantity');
  const childQuantity = positive(input.childEconomicQuantity, U128_BITS, 'sliceStrategyPackageGraph.childEconomicQuantity');
  if (childQuantity > parentQuantity) {
    throw new MalformedInputError('sliceStrategyPackageGraph.childEconomicQuantity', 'child quantity exceeds its parent');
  }
  const graphNonce = positive(input.graphNonce, U64_BITS, 'sliceStrategyPackageGraph.graphNonce');
  const parentGraphHash = packageGraphHash(parent);
  const policies = Object.fromEntries(POLICY_KEYS.map(([category, key]) => {
    const policy = strategySlicePolicy({
      policyVersion: STRATEGY_SLICE_POLICY_VERSION,
      category,
      parentOrderHash: input.parentOrderHash,
      parentGraphHash,
      parentPolicyHash: parent.policyHashes[key],
      activationAttemptId: input.activationAttemptId,
      parentEconomicQuantity: parentQuantity,
      childEconomicQuantity: childQuantity,
      graphNonce,
    });
    return [category, policy];
  })) as unknown as Record<StrategySlicePolicyCategory, StrategySlicePolicy>;
  const graph = packageGraph({
    ...parent,
    legs: parent.legs.map((leg) => {
      if (leg.preconditionHashes.length > 0 || leg.postconditionHashes.length > 0) {
        throw new MalformedInputError(
          `sliceStrategyPackageGraph.legs.${leg.legId}`,
          'opaque leg conditions cannot be proportionally sliced',
        );
      }
      return {
        ...leg,
        quantityAtoms: exactScale(leg.quantityAtoms, childQuantity, parentQuantity, `sliceStrategyPackageGraph.legs.${leg.legId}.quantityAtoms`),
        minimumQuantityAtoms: exactScale(leg.minimumQuantityAtoms, childQuantity, parentQuantity, `sliceStrategyPackageGraph.legs.${leg.legId}.minimumQuantityAtoms`),
        maximumFeeQuoteAtoms: boundedScale(leg.maximumFeeQuoteAtoms, childQuantity, parentQuantity),
      };
    }),
    executionGroups: parent.executionGroups.map((group) => ({
      ...group,
      ...(group.maximumResidualQuoteAtoms === undefined ? {} : {
        maximumResidualQuoteAtoms: boundedScale(group.maximumResidualQuoteAtoms, childQuantity, parentQuantity),
      }),
    })),
    policyHashes: parent.policyHashes,
    recoverySlots: parent.recoverySlots.map((slot) => ({
      ...slot,
      maximumQuantityAtoms: exactScale(slot.maximumQuantityAtoms, childQuantity, parentQuantity, `sliceStrategyPackageGraph.recoverySlots.${slot.legId}.maximumQuantityAtoms`),
      maximumCostQuoteAtoms: boundedScale(slot.maximumCostQuoteAtoms, childQuantity, parentQuantity),
    })),
    maximumRecoveryCostQuoteAtoms: boundedScale(parent.maximumRecoveryCostQuoteAtoms, childQuantity, parentQuantity),
    nonce: graphNonce,
  });
  return Object.freeze({ graph, policies: Object.freeze(policies) });
}
