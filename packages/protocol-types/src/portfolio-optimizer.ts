import { checkedSigned, checkedUnsigned, mulDiv, ROUNDING } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { enumDiscriminant } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import {
  evaluateMarginOffset,
  packageCloseCostIndex,
  stressPortfolio,
  type MarginOffsetContext,
  type MarginOffsetPolicy,
  type NormalizedPositionInput,
  type StressScenario,
} from './portfolio-risk.js';
import {
  positionSnapshotRecord,
  positionSnapshotRecordHash,
  type PositionSnapshotRecordInput,
} from './position-snapshot.js';
import {
  assetRef,
  encodeAssetRef,
  encodeProtocolId,
  protocolId,
  type AssetRef,
  type ProtocolId,
} from './primitives.js';

export const PORTFOLIO_OPTIMIZATION_POLICY_VERSION = 1;
export const COLLATERAL_SNAPSHOT_VERSION = 2;
export const PORTFOLIO_OPTIMIZATION_MAX_CANDIDATES = 64;
export const PORTFOLIO_OPTIMIZATION_MAX_SCENARIOS = 32;
const BPS = 10_000n;
const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;
const MAX_SIGNATURE_BYTES = 128;

export const COLLATERAL_MODE = Object.freeze({
  ISOLATED: 1,
  CROSS: 2,
  UNIFIED: 3,
  PORTFOLIO_MARGIN: 4,
} as const);
export type CollateralMode = keyof typeof COLLATERAL_MODE;

export const PORTFOLIO_OBJECTIVE_METRIC = Object.freeze({
  MAXIMIZE_NET_OUTCOME: 1,
  MINIMIZE_REQUIRED_COLLATERAL: 2,
  MINIMIZE_STRESS_LOSS: 3,
  MINIMIZE_TIME_TO_UNWIND: 4,
  MINIMIZE_TOTAL_COST: 5,
} as const);
export type PortfolioObjectiveMetric = keyof typeof PORTFOLIO_OBJECTIVE_METRIC;

export const PORTFOLIO_CANDIDATE_REJECTION = Object.freeze({
  INACTIVE: 1,
  STALE_STATE: 2,
  SOURCE_SKEW: 3,
  AUTHORITY_UNVERIFIED: 4,
  UNMAPPED_STATE: 5,
  INVENTORY_INELIGIBLE: 6,
  COLLATERAL_ASSET_UNSUPPORTED: 7,
  COLLATERAL_MODE_UNSUPPORTED: 8,
  RISK_DOMAIN_MISMATCH: 9,
  WITHDRAWAL_DELAY_EXCEEDED: 10,
  BORROW_UNAVAILABLE: 11,
  BORROW_LIMIT_EXCEEDED: 12,
  BORROW_COST_EXCEEDED: 13,
  INSUFFICIENT_COLLATERAL: 14,
  REQUIRED_COLLATERAL_EXCEEDED: 15,
  STRESS_LOSS_EXCEEDED: 16,
  TIME_TO_UNWIND_EXCEEDED: 17,
  SOLVER_CONCENTRATION_EXCEEDED: 18,
  RECOVERY_RESERVE_INSUFFICIENT: 19,
  POSITION_STATE_INCOMPLETE: 20,
  UNWIND_UNAVAILABLE: 21,
  TOTAL_COST_EXCEEDED: 22,
  ENVIRONMENT_MISMATCH: 23,
} as const);
export type PortfolioCandidateRejection = keyof typeof PORTFOLIO_CANDIDATE_REJECTION;

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function signed(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedSigned(value, I128_BITS, context);
}

function bps(value: bigint, context: string): bigint {
  const checked = unsigned(value, U64_BITS, context);
  if (checked > BPS) throw new MalformedInputError(context, 'basis points exceed 10000');
  return checked;
}

function nonzeroVersion(value: number, context: string): number {
  if (!Number.isSafeInteger(value)) throw new MalformedInputError(context, 'expected a safe integer');
  const checked = Number(checkedUnsigned(value, U32_BITS, context));
  if (checked === 0) throw new MalformedInputError(context, 'version is zero');
  return checked;
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && compareBytes(left.assetManifestHash, right.assetManifestHash) === 0;
}

function protocolIdSet(values: readonly string[], context: string): readonly ProtocolId[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 64) {
    throw new MalformedInputError(context, 'expected 1 to 64 identifiers');
  }
  const checked = values.map((value, index) => protocolId(value, `${context}[${index}]`)).sort();
  if (new Set(checked).size !== checked.length) throw new DuplicateElementError(context, 'identifier appears twice');
  return Object.freeze(checked);
}

export interface CollateralSnapshotInput {
  readonly version: number;
  readonly environment: string;
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly strategyAccount: string;
  readonly owner: string;
  readonly authority: string;
  readonly observedAtMs: bigint;
  readonly asset: AssetRef;
  readonly riskDomainId: string;
  readonly mode: CollateralMode;
  readonly ownAvailableQuoteAtoms: bigint;
  readonly borrowAvailableQuoteAtoms: bigint;
  readonly requestedBorrowQuoteAtoms: bigint;
  readonly borrowCostQuoteAtoms: bigint;
  readonly haircutBps: bigint;
  readonly withdrawalDelayMs: bigint;
  readonly inventoryEligible: boolean;
  readonly withdrawalAllowed: boolean;
  readonly sourceEvidenceHash: Uint8Array | string;
  readonly signature: Uint8Array;
}

export interface CollateralSnapshot extends Omit<CollateralSnapshotInput,
  'environment' | 'snapshotId' | 'sourceId' | 'strategyAccount' | 'owner' | 'authority' | 'asset' |
  'riskDomainId' | 'sourceEvidenceHash' | 'signature'> {
  readonly version: 2;
  readonly environment: ProtocolId;
  readonly snapshotId: ProtocolId;
  readonly sourceId: ProtocolId;
  readonly strategyAccount: ProtocolId;
  readonly owner: ProtocolId;
  readonly authority: ProtocolId;
  readonly asset: AssetRef;
  readonly riskDomainId: ProtocolId;
  readonly sourceEvidenceHash: CommitmentHash;
  readonly signature: Uint8Array;
}

export function collateralSnapshot(input: CollateralSnapshotInput, context = 'collateralSnapshot'): CollateralSnapshot {
  object(input, context);
  if (input.version !== COLLATERAL_SNAPSHOT_VERSION) {
    throw new MalformedInputError(`${context}.version`, `version must equal ${COLLATERAL_SNAPSHOT_VERSION}`);
  }
  if (typeof input.inventoryEligible !== 'boolean' || typeof input.withdrawalAllowed !== 'boolean') {
    throw new MalformedInputError(context, 'collateral flags must be boolean');
  }
  if (!(input.signature instanceof Uint8Array) || input.signature.length === 0 || input.signature.length > MAX_SIGNATURE_BYTES) {
    throw new MalformedInputError(`${context}.signature`, `expected 1 to ${MAX_SIGNATURE_BYTES} bytes`);
  }
  const ownAvailableQuoteAtoms = unsigned(input.ownAvailableQuoteAtoms, U128_BITS, `${context}.ownAvailableQuoteAtoms`);
  const borrowAvailableQuoteAtoms = unsigned(input.borrowAvailableQuoteAtoms, U128_BITS, `${context}.borrowAvailableQuoteAtoms`);
  const requestedBorrowQuoteAtoms = unsigned(input.requestedBorrowQuoteAtoms, U128_BITS, `${context}.requestedBorrowQuoteAtoms`);
  if (requestedBorrowQuoteAtoms > borrowAvailableQuoteAtoms) {
    throw new MalformedInputError(`${context}.requestedBorrowQuoteAtoms`, 'requested borrow exceeds available borrow');
  }
  const borrowCostQuoteAtoms = unsigned(input.borrowCostQuoteAtoms, U128_BITS, `${context}.borrowCostQuoteAtoms`);
  if (requestedBorrowQuoteAtoms === 0n && borrowCostQuoteAtoms !== 0n) {
    throw new MalformedInputError(`${context}.borrowCostQuoteAtoms`, 'borrow cost exists without a requested borrow');
  }
  enumDiscriminant(COLLATERAL_MODE, input.mode, `${context}.mode`);
  return Object.freeze({
    version: COLLATERAL_SNAPSHOT_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    snapshotId: protocolId(input.snapshotId, `${context}.snapshotId`),
    sourceId: protocolId(input.sourceId, `${context}.sourceId`),
    strategyAccount: protocolId(input.strategyAccount, `${context}.strategyAccount`),
    owner: protocolId(input.owner, `${context}.owner`),
    authority: protocolId(input.authority, `${context}.authority`),
    observedAtMs: unsigned(input.observedAtMs, U64_BITS, `${context}.observedAtMs`),
    asset: assetRef(input.asset.assetId, input.asset.assetManifestHash, input.asset.decimals, `${context}.asset`),
    riskDomainId: protocolId(input.riskDomainId, `${context}.riskDomainId`),
    mode: input.mode,
    ownAvailableQuoteAtoms,
    borrowAvailableQuoteAtoms,
    requestedBorrowQuoteAtoms,
    borrowCostQuoteAtoms,
    haircutBps: bps(input.haircutBps, `${context}.haircutBps`),
    withdrawalDelayMs: unsigned(input.withdrawalDelayMs, U64_BITS, `${context}.withdrawalDelayMs`),
    inventoryEligible: input.inventoryEligible,
    withdrawalAllowed: input.withdrawalAllowed,
    sourceEvidenceHash: commitmentHash(input.sourceEvidenceHash, `${context}.sourceEvidenceHash`),
    signature: Uint8Array.from(input.signature),
  });
}

function encodeCollateralSnapshot(writer: CanonicalWriter, value: CollateralSnapshot): void {
  writer.writeU32(value.version, 'version');
  encodeProtocolId(writer, value.environment, 'environment');
  encodeProtocolId(writer, value.snapshotId, 'snapshotId');
  encodeProtocolId(writer, value.sourceId, 'sourceId');
  encodeProtocolId(writer, value.strategyAccount, 'strategyAccount');
  encodeProtocolId(writer, value.owner, 'owner');
  encodeProtocolId(writer, value.authority, 'authority');
  writer.writeU64(value.observedAtMs, 'observedAtMs');
  encodeAssetRef(writer, value.asset);
  encodeProtocolId(writer, value.riskDomainId, 'riskDomainId');
  writer.writeEnum(COLLATERAL_MODE, value.mode, 'mode');
  writer.writeU128(value.ownAvailableQuoteAtoms, 'ownAvailableQuoteAtoms');
  writer.writeU128(value.borrowAvailableQuoteAtoms, 'borrowAvailableQuoteAtoms');
  writer.writeU128(value.requestedBorrowQuoteAtoms, 'requestedBorrowQuoteAtoms');
  writer.writeU128(value.borrowCostQuoteAtoms, 'borrowCostQuoteAtoms');
  writer.writeU64(value.haircutBps, 'haircutBps');
  writer.writeU64(value.withdrawalDelayMs, 'withdrawalDelayMs');
  writer.writeBool(value.inventoryEligible, 'inventoryEligible');
  writer.writeBool(value.withdrawalAllowed, 'withdrawalAllowed');
  encodeCommitmentHash(writer, value.sourceEvidenceHash, 'sourceEvidenceHash');
}

export function collateralSnapshotBytes(input: CollateralSnapshotInput): Uint8Array {
  const value = collateralSnapshot(input);
  return canonicalBytes((writer) => encodeCollateralSnapshot(writer, value));
}

export function collateralSnapshotHash(input: CollateralSnapshotInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.COLLATERAL_SNAPSHOT, collateralSnapshotBytes(input)), 'collateralSnapshotHash');
}

export interface PortfolioOptimizationPolicyInput {
  readonly version: number;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly environment: string;
  readonly owner: string;
  readonly accountingAsset: AssetRef;
  readonly allowedSnapshotAuthorities: readonly string[];
  readonly allowedCollateralAssetIds: readonly string[];
  readonly allowedCollateralModes: readonly CollateralMode[];
  readonly allowedRiskDomainIds: readonly string[];
  readonly objectivePriority: readonly PortfolioObjectiveMetric[];
  readonly maximumStateAgeMs: bigint;
  readonly maximumSourceSkewMs: bigint;
  readonly maximumWithdrawalDelayMs: bigint;
  readonly maximumTimeToUnwindMs: bigint;
  readonly maximumStressLossQuoteAtoms: bigint;
  readonly maximumRequiredCollateralQuoteAtoms: bigint;
  readonly maximumTotalCostQuoteAtoms: bigint;
  readonly maximumBorrowQuoteAtoms: bigint;
  readonly maximumBorrowCostQuoteAtoms: bigint;
  readonly maximumSolverConcentrationBps: bigint;
  readonly minimumRecoveryReserveQuoteAtoms: bigint;
  readonly allowBorrow: boolean;
}

export interface PortfolioOptimizationPolicy extends Omit<PortfolioOptimizationPolicyInput,
  'policyId' | 'environment' | 'owner' | 'accountingAsset' | 'allowedSnapshotAuthorities' |
  'allowedCollateralAssetIds' | 'allowedCollateralModes' | 'allowedRiskDomainIds' |
  'objectivePriority'> {
  readonly version: 1;
  readonly policyId: ProtocolId;
  readonly environment: ProtocolId;
  readonly owner: ProtocolId;
  readonly accountingAsset: AssetRef;
  readonly allowedSnapshotAuthorities: readonly ProtocolId[];
  readonly allowedCollateralAssetIds: readonly ProtocolId[];
  readonly allowedCollateralModes: readonly CollateralMode[];
  readonly allowedRiskDomainIds: readonly ProtocolId[];
  readonly objectivePriority: readonly PortfolioObjectiveMetric[];
}

export function portfolioOptimizationPolicy(
  input: PortfolioOptimizationPolicyInput,
  context = 'portfolioOptimizationPolicy',
): PortfolioOptimizationPolicy {
  object(input, context);
  if (input.version !== PORTFOLIO_OPTIMIZATION_POLICY_VERSION) {
    throw new MalformedInputError(`${context}.version`, `version must equal ${PORTFOLIO_OPTIMIZATION_POLICY_VERSION}`);
  }
  if (typeof input.allowBorrow !== 'boolean') throw new MalformedInputError(`${context}.allowBorrow`, 'expected a boolean');
  if (!Array.isArray(input.allowedCollateralModes) || input.allowedCollateralModes.length === 0) {
    throw new MalformedInputError(`${context}.allowedCollateralModes`, 'expected a nonempty array');
  }
  const modes: CollateralMode[] = Array.from(input.allowedCollateralModes);
  modes.sort((left, right) => COLLATERAL_MODE[left] - COLLATERAL_MODE[right]);
  modes.forEach((mode, index) => enumDiscriminant(COLLATERAL_MODE, mode, `${context}.allowedCollateralModes[${index}]`));
  if (new Set(modes).size !== modes.length) throw new DuplicateElementError(`${context}.allowedCollateralModes`, 'mode appears twice');
  const objectiveKeys = Object.keys(PORTFOLIO_OBJECTIVE_METRIC) as PortfolioObjectiveMetric[];
  if (!Array.isArray(input.objectivePriority) || input.objectivePriority.length !== objectiveKeys.length) {
    throw new MalformedInputError(`${context}.objectivePriority`, 'every objective metric must appear exactly once');
  }
  input.objectivePriority.forEach((metric, index) => enumDiscriminant(PORTFOLIO_OBJECTIVE_METRIC, metric, `${context}.objectivePriority[${index}]`));
  if (new Set(input.objectivePriority).size !== objectiveKeys.length) {
    throw new DuplicateElementError(`${context}.objectivePriority`, 'objective metric appears twice');
  }
  return Object.freeze({
    version: PORTFOLIO_OPTIMIZATION_POLICY_VERSION,
    policyId: protocolId(input.policyId, `${context}.policyId`),
    policyVersion: nonzeroVersion(input.policyVersion, `${context}.policyVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    owner: protocolId(input.owner, `${context}.owner`),
    accountingAsset: assetRef(input.accountingAsset.assetId, input.accountingAsset.assetManifestHash, input.accountingAsset.decimals, `${context}.accountingAsset`),
    allowedSnapshotAuthorities: protocolIdSet(input.allowedSnapshotAuthorities, `${context}.allowedSnapshotAuthorities`),
    allowedCollateralAssetIds: protocolIdSet(input.allowedCollateralAssetIds, `${context}.allowedCollateralAssetIds`),
    allowedCollateralModes: Object.freeze(modes),
    allowedRiskDomainIds: protocolIdSet(input.allowedRiskDomainIds, `${context}.allowedRiskDomainIds`),
    objectivePriority: Object.freeze([...input.objectivePriority]),
    maximumStateAgeMs: unsigned(input.maximumStateAgeMs, U64_BITS, `${context}.maximumStateAgeMs`),
    maximumSourceSkewMs: unsigned(input.maximumSourceSkewMs, U64_BITS, `${context}.maximumSourceSkewMs`),
    maximumWithdrawalDelayMs: unsigned(input.maximumWithdrawalDelayMs, U64_BITS, `${context}.maximumWithdrawalDelayMs`),
    maximumTimeToUnwindMs: unsigned(input.maximumTimeToUnwindMs, U64_BITS, `${context}.maximumTimeToUnwindMs`),
    maximumStressLossQuoteAtoms: unsigned(input.maximumStressLossQuoteAtoms, U128_BITS, `${context}.maximumStressLossQuoteAtoms`),
    maximumRequiredCollateralQuoteAtoms: unsigned(input.maximumRequiredCollateralQuoteAtoms, U128_BITS, `${context}.maximumRequiredCollateralQuoteAtoms`),
    maximumTotalCostQuoteAtoms: unsigned(input.maximumTotalCostQuoteAtoms, U128_BITS, `${context}.maximumTotalCostQuoteAtoms`),
    maximumBorrowQuoteAtoms: unsigned(input.maximumBorrowQuoteAtoms, U128_BITS, `${context}.maximumBorrowQuoteAtoms`),
    maximumBorrowCostQuoteAtoms: unsigned(input.maximumBorrowCostQuoteAtoms, U128_BITS, `${context}.maximumBorrowCostQuoteAtoms`),
    maximumSolverConcentrationBps: bps(input.maximumSolverConcentrationBps, `${context}.maximumSolverConcentrationBps`),
    minimumRecoveryReserveQuoteAtoms: unsigned(input.minimumRecoveryReserveQuoteAtoms, U128_BITS, `${context}.minimumRecoveryReserveQuoteAtoms`),
    allowBorrow: input.allowBorrow,
  });
}

function encodePolicy(writer: CanonicalWriter, value: PortfolioOptimizationPolicy): void {
  writer.writeU32(value.version, 'version');
  encodeProtocolId(writer, value.policyId, 'policyId');
  writer.writeU32(value.policyVersion, 'policyVersion');
  encodeProtocolId(writer, value.environment, 'environment');
  encodeProtocolId(writer, value.owner, 'owner');
  encodeAssetRef(writer, value.accountingAsset);
  writer.writeArray(value.allowedSnapshotAuthorities, (inner, id) => encodeProtocolId(inner, id), 'allowedSnapshotAuthorities');
  writer.writeArray(value.allowedCollateralAssetIds, (inner, id) => encodeProtocolId(inner, id), 'allowedCollateralAssetIds');
  writer.writeArray(value.allowedCollateralModes, (inner, mode) => inner.writeEnum(COLLATERAL_MODE, mode), 'allowedCollateralModes');
  writer.writeArray(value.allowedRiskDomainIds, (inner, id) => encodeProtocolId(inner, id), 'allowedRiskDomainIds');
  writer.writeArray(value.objectivePriority, (inner, metric) => inner.writeEnum(PORTFOLIO_OBJECTIVE_METRIC, metric), 'objectivePriority');
  writer.writeU64(value.maximumStateAgeMs, 'maximumStateAgeMs');
  writer.writeU64(value.maximumSourceSkewMs, 'maximumSourceSkewMs');
  writer.writeU64(value.maximumWithdrawalDelayMs, 'maximumWithdrawalDelayMs');
  writer.writeU64(value.maximumTimeToUnwindMs, 'maximumTimeToUnwindMs');
  writer.writeU128(value.maximumStressLossQuoteAtoms, 'maximumStressLossQuoteAtoms');
  writer.writeU128(value.maximumRequiredCollateralQuoteAtoms, 'maximumRequiredCollateralQuoteAtoms');
  writer.writeU128(value.maximumTotalCostQuoteAtoms, 'maximumTotalCostQuoteAtoms');
  writer.writeU128(value.maximumBorrowQuoteAtoms, 'maximumBorrowQuoteAtoms');
  writer.writeU128(value.maximumBorrowCostQuoteAtoms, 'maximumBorrowCostQuoteAtoms');
  writer.writeU64(value.maximumSolverConcentrationBps, 'maximumSolverConcentrationBps');
  writer.writeU128(value.minimumRecoveryReserveQuoteAtoms, 'minimumRecoveryReserveQuoteAtoms');
  writer.writeBool(value.allowBorrow, 'allowBorrow');
}

export function portfolioOptimizationPolicyBytes(input: PortfolioOptimizationPolicyInput): Uint8Array {
  const value = portfolioOptimizationPolicy(input);
  return canonicalBytes((writer) => encodePolicy(writer, value));
}

export function portfolioOptimizationPolicyHash(input: PortfolioOptimizationPolicyInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.PORTFOLIO_OPTIMIZATION_POLICY, portfolioOptimizationPolicyBytes(input)), 'portfolioOptimizationPolicyHash');
}

export interface PortfolioOptimizationCandidateInput {
  readonly candidateId: string;
  readonly active: boolean;
  readonly authorityVerified: boolean;
  readonly positionSnapshot: PositionSnapshotRecordInput;
  readonly collateralSnapshot: CollateralSnapshotInput;
  readonly routeHash: Uint8Array | string;
  readonly executionGraphHash: Uint8Array | string;
  readonly unwindRouteHash: Uint8Array | string;
  readonly solverId: string;
  readonly solverConcentrationBps: bigint;
  readonly expectedGrossOutcomeQuoteAtoms: bigint;
  readonly expectedFeesQuoteAtoms: bigint;
  readonly expectedGasQuoteAtoms: bigint;
  readonly expectedFundingCostQuoteAtoms: bigint;
  readonly expectedRebatesQuoteAtoms: bigint;
  readonly marginOffsetPolicy: MarginOffsetPolicy;
  readonly marginOffsetContext: MarginOffsetContext;
  readonly stressScenarios: readonly StressScenario[];
}

export interface PortfolioCandidateMetrics {
  readonly netOutcomeQuoteAtoms: bigint;
  readonly totalCostQuoteAtoms: bigint;
  readonly requiredCollateralQuoteAtoms: bigint;
  readonly effectiveCollateralQuoteAtoms: bigint;
  readonly maximumStressLossQuoteAtoms: bigint;
  readonly timeToUnwindMs: bigint;
  readonly solverConcentrationBps: bigint;
}

export interface PortfolioCandidateDecision {
  readonly candidateId: ProtocolId;
  readonly candidateInputHash: CommitmentHash;
  readonly positionSnapshotHash: CommitmentHash;
  readonly collateralSnapshotHash: CommitmentHash;
  readonly routeHash: CommitmentHash;
  readonly executionGraphHash: CommitmentHash;
  readonly unwindRouteHash: CommitmentHash;
  readonly eligible: boolean;
  readonly rejections: readonly PortfolioCandidateRejection[];
  readonly metrics: PortfolioCandidateMetrics;
}

export interface PortfolioOptimizationDecision {
  readonly advisory: true;
  readonly policyHash: CommitmentHash;
  readonly decisionAtMs: bigint;
  readonly candidates: readonly PortfolioCandidateDecision[];
  readonly selectedCandidateId?: ProtocolId;
  readonly decisionHash: CommitmentHash;
}

function addReason(reasons: Set<PortfolioCandidateRejection>, reason: PortfolioCandidateRejection): void {
  reasons.add(reason);
}

function candidateInputHash(
  raw: PortfolioOptimizationCandidateInput,
  positionHash: CommitmentHash,
  collateralHash: CommitmentHash,
): CommitmentHash {
  const scenarios = raw.stressScenarios.map((scenario, index) => {
    const scenarioId = protocolId(scenario.scenarioId, `optimizePortfolio.candidate.stressScenarios[${index}].scenarioId`);
    const shocks = scenario.priceShocksBps.map((shock, shockIndex) => Object.freeze({
      underlyingId: protocolId(shock.underlyingId, `optimizePortfolio.candidate.stressScenarios[${index}].priceShocksBps[${shockIndex}].underlyingId`),
      shockBps: checkedSigned(shock.shockBps, U64_BITS, `optimizePortfolio.candidate.stressScenarios[${index}].priceShocksBps[${shockIndex}].shockBps`),
    })).sort((left, right) => left.underlyingId.localeCompare(right.underlyingId));
    if (new Set(shocks.map((shock) => shock.underlyingId)).size !== shocks.length) {
      throw new DuplicateElementError('optimizePortfolio.candidate.stressScenarios.priceShocksBps', 'underlying appears twice');
    }
    const failed = scenario.failedDependencyIds
      .map((value, failedIndex) => protocolId(value, `optimizePortfolio.candidate.stressScenarios[${index}].failedDependencyIds[${failedIndex}]`))
      .sort();
    if (new Set(failed).size !== failed.length) {
      throw new DuplicateElementError('optimizePortfolio.candidate.stressScenarios.failedDependencyIds', 'dependency appears twice');
    }
    return Object.freeze({
      scenarioId,
      shocks: Object.freeze(shocks),
      closeCostMultiplierBps: unsigned(scenario.closeCostMultiplierBps, U64_BITS, `optimizePortfolio.candidate.stressScenarios[${index}].closeCostMultiplierBps`),
      failed: Object.freeze(failed),
    });
  }).sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
  if (new Set(scenarios.map((scenario) => scenario.scenarioId)).size !== scenarios.length) {
    throw new DuplicateElementError('optimizePortfolio.candidate.stressScenarios', 'scenario id appears twice');
  }
  const failedDependencies = [...raw.marginOffsetContext.failedDependencyIds]
    .map((value, index) => protocolId(value, `optimizePortfolio.candidate.marginOffsetContext.failedDependencyIds[${index}]`))
    .sort();
  if (new Set(failedDependencies).size !== failedDependencies.length) {
    throw new DuplicateElementError('optimizePortfolio.candidate.marginOffsetContext.failedDependencyIds', 'dependency appears twice');
  }
  const policy = raw.marginOffsetPolicy;
  const context = raw.marginOffsetContext;
  const bytes = canonicalBytes((writer) => {
    encodeProtocolId(writer, protocolId(raw.candidateId), 'candidateId');
    writer.writeBool(raw.active, 'active');
    writer.writeBool(raw.authorityVerified, 'authorityVerified');
    encodeCommitmentHash(writer, positionHash, 'positionSnapshotHash');
    encodeCommitmentHash(writer, collateralHash, 'collateralSnapshotHash');
    encodeCommitmentHash(writer, commitmentHash(raw.routeHash), 'routeHash');
    encodeCommitmentHash(writer, commitmentHash(raw.executionGraphHash), 'executionGraphHash');
    encodeCommitmentHash(writer, commitmentHash(raw.unwindRouteHash), 'unwindRouteHash');
    encodeProtocolId(writer, protocolId(raw.solverId), 'solverId');
    writer.writeU64(raw.solverConcentrationBps, 'solverConcentrationBps');
    writer.writeI128(raw.expectedGrossOutcomeQuoteAtoms, 'expectedGrossOutcomeQuoteAtoms');
    writer.writeU128(raw.expectedFeesQuoteAtoms, 'expectedFeesQuoteAtoms');
    writer.writeU128(raw.expectedGasQuoteAtoms, 'expectedGasQuoteAtoms');
    writer.writeU128(raw.expectedFundingCostQuoteAtoms, 'expectedFundingCostQuoteAtoms');
    writer.writeU128(raw.expectedRebatesQuoteAtoms, 'expectedRebatesQuoteAtoms');
    encodeProtocolId(writer, protocolId(policy.riskDomainId), 'riskDomainId');
    writer.writeU64(policy.offsetRateBps, 'offsetRateBps');
    writer.writeU64(policy.haircutsBps.basis, 'basisHaircutBps');
    writer.writeU64(policy.haircutsBps.liquidity, 'liquidityHaircutBps');
    writer.writeU64(policy.haircutsBps.latency, 'latencyHaircutBps');
    writer.writeU64(policy.haircutsBps.oracle, 'oracleHaircutBps');
    writer.writeU64(policy.haircutsBps.venue, 'venueHaircutBps');
    writer.writeU64(policy.haircutsBps.bridge, 'bridgeHaircutBps');
    writer.writeU64(policy.haircutsBps.issuer, 'issuerHaircutBps');
    writer.writeU64(policy.haircutsBps.recovery, 'recoveryHaircutBps');
    writer.writeU64(policy.maximumStalenessMs, 'maximumStalenessMs');
    writer.writeU64(policy.maximumTimeToUnwindMs, 'maximumTimeToUnwindMs');
    writer.writeU128(policy.riskDomainGrossCapQuoteAtoms, 'riskDomainGrossCapQuoteAtoms');
    writer.writeU128(policy.requiredRecoveryReserveQuoteAtoms, 'requiredRecoveryReserveQuoteAtoms');
    writer.writeU128(policy.absoluteFloorQuoteAtoms, 'absoluteFloorQuoteAtoms');
    writer.writeU64(context.nowMs, 'nowMs');
    writer.writeU128(context.reservedRecoveryQuoteAtoms, 'reservedRecoveryQuoteAtoms');
    writer.writeBool(context.fundedCreditAvailable, 'fundedCreditAvailable');
    writer.writeArray(failedDependencies, (inner, value) => encodeProtocolId(inner, value), 'failedDependencyIds');
    writer.writeArray(scenarios, (inner, scenario) => {
      encodeProtocolId(inner, scenario.scenarioId, 'scenarioId');
      inner.writeArray(scenario.shocks, (shockWriter, shock) => {
        encodeProtocolId(shockWriter, shock.underlyingId, 'underlyingId');
        shockWriter.writeI128(shock.shockBps, 'shockBps');
      }, 'priceShocksBps');
      inner.writeU64(scenario.closeCostMultiplierBps, 'closeCostMultiplierBps');
      inner.writeArray(scenario.failed, (failedWriter, value) => encodeProtocolId(failedWriter, value), 'failedDependencyIds');
    }, 'stressScenarios');
  });
  return commitmentHash(domainHash(HASH_DOMAIN.PORTFOLIO_OPTIMIZATION_CANDIDATE, bytes), 'portfolioOptimizationCandidateHash');
}

function candidateDecision(
  raw: PortfolioOptimizationCandidateInput,
  policy: PortfolioOptimizationPolicy,
  decisionAtMs: bigint,
): PortfolioCandidateDecision {
  object(raw, 'optimizePortfolio.candidate');
  if (typeof raw.active !== 'boolean' || typeof raw.authorityVerified !== 'boolean') {
    throw new MalformedInputError('optimizePortfolio.candidate', 'candidate flags must be boolean');
  }
  if (!Array.isArray(raw.stressScenarios) || raw.stressScenarios.length === 0 || raw.stressScenarios.length > PORTFOLIO_OPTIMIZATION_MAX_SCENARIOS) {
    throw new MalformedInputError('optimizePortfolio.candidate.stressScenarios', `expected 1 to ${PORTFOLIO_OPTIMIZATION_MAX_SCENARIOS} scenarios`);
  }
  const snapshot = positionSnapshotRecord(raw.positionSnapshot);
  const collateral = collateralSnapshot(raw.collateralSnapshot);
  if (snapshot.positions.length === 0) throw new MalformedInputError('optimizePortfolio.candidate.positionSnapshot.positions', 'candidate has no positions');
  if (snapshot.signature.length === 0) throw new MalformedInputError('optimizePortfolio.candidate.positionSnapshot.signature', 'signature is empty');
  const candidateId = protocolId(raw.candidateId, 'optimizePortfolio.candidate.candidateId');
  const solverConcentrationBps = bps(raw.solverConcentrationBps, 'optimizePortfolio.candidate.solverConcentrationBps');
  protocolId(raw.solverId, 'optimizePortfolio.candidate.solverId');
  const expectedFees = unsigned(raw.expectedFeesQuoteAtoms, U128_BITS, 'optimizePortfolio.candidate.expectedFeesQuoteAtoms');
  const expectedGas = unsigned(raw.expectedGasQuoteAtoms, U128_BITS, 'optimizePortfolio.candidate.expectedGasQuoteAtoms');
  const expectedFunding = unsigned(raw.expectedFundingCostQuoteAtoms, U128_BITS, 'optimizePortfolio.candidate.expectedFundingCostQuoteAtoms');
  const expectedRebates = unsigned(raw.expectedRebatesQuoteAtoms, U128_BITS, 'optimizePortfolio.candidate.expectedRebatesQuoteAtoms');
  const borrowCost = collateral.borrowCostQuoteAtoms;
  const grossCost = expectedFees + expectedGas + expectedFunding + borrowCost;
  if (expectedRebates > grossCost) throw new MalformedInputError('optimizePortfolio.candidate.expectedRebatesQuoteAtoms', 'rebates exceed gross costs');
  const totalCostQuoteAtoms = grossCost - expectedRebates;
  const netOutcomeQuoteAtoms = signed(
    signed(raw.expectedGrossOutcomeQuoteAtoms, 'optimizePortfolio.candidate.expectedGrossOutcomeQuoteAtoms') - totalCostQuoteAtoms,
    'optimizePortfolio.candidate.netOutcomeQuoteAtoms',
  );
  const reasons = new Set<PortfolioCandidateRejection>();
  if (!raw.active) addReason(reasons, 'INACTIVE');
  if (snapshot.environment !== policy.environment || collateral.environment !== policy.environment) {
    addReason(reasons, 'ENVIRONMENT_MISMATCH');
  }
  if (!raw.authorityVerified
    || snapshot.strategyAccount !== collateral.strategyAccount
    || collateral.owner !== policy.owner
    || !policy.allowedSnapshotAuthorities.includes(snapshot.authority)
    || !policy.allowedSnapshotAuthorities.includes(collateral.authority)) {
    addReason(reasons, 'AUTHORITY_UNVERIFIED');
  }
  if (snapshot.unmappedInstruments.length > 0) addReason(reasons, 'UNMAPPED_STATE');
  const observationTimes = [snapshot.observedAtMs, collateral.observedAtMs, ...snapshot.positions.map((position) => position.observedAtMs)];
  const oldest = observationTimes.reduce((left, right) => left < right ? left : right);
  const newest = observationTimes.reduce((left, right) => left > right ? left : right);
  if (newest > decisionAtMs || decisionAtMs - oldest > policy.maximumStateAgeMs) addReason(reasons, 'STALE_STATE');
  if (newest - oldest > policy.maximumSourceSkewMs) addReason(reasons, 'SOURCE_SKEW');
  if (!collateral.inventoryEligible || !collateral.withdrawalAllowed) addReason(reasons, 'INVENTORY_INELIGIBLE');
  if (!sameAsset(collateral.asset, policy.accountingAsset)
    || !policy.allowedCollateralAssetIds.includes(collateral.asset.assetId)) {
    addReason(reasons, 'COLLATERAL_ASSET_UNSUPPORTED');
  }
  if (!policy.allowedCollateralModes.includes(collateral.mode)) addReason(reasons, 'COLLATERAL_MODE_UNSUPPORTED');
  if (!policy.allowedRiskDomainIds.includes(collateral.riskDomainId)
    || protocolId(raw.marginOffsetPolicy.riskDomainId, 'optimizePortfolio.candidate.marginOffsetPolicy.riskDomainId') !== collateral.riskDomainId
    || snapshot.positions.some((position) => position.riskDomainId !== collateral.riskDomainId)) {
    addReason(reasons, 'RISK_DOMAIN_MISMATCH');
  }
  if (collateral.withdrawalDelayMs > policy.maximumWithdrawalDelayMs) addReason(reasons, 'WITHDRAWAL_DELAY_EXCEEDED');
  if (collateral.requestedBorrowQuoteAtoms > 0n && !policy.allowBorrow) addReason(reasons, 'BORROW_UNAVAILABLE');
  if (collateral.requestedBorrowQuoteAtoms > policy.maximumBorrowQuoteAtoms) addReason(reasons, 'BORROW_LIMIT_EXCEEDED');
  if (collateral.borrowCostQuoteAtoms > policy.maximumBorrowCostQuoteAtoms) addReason(reasons, 'BORROW_COST_EXCEEDED');
  if (solverConcentrationBps > policy.maximumSolverConcentrationBps) addReason(reasons, 'SOLVER_CONCENTRATION_EXCEEDED');
  if (raw.marginOffsetContext.reservedRecoveryQuoteAtoms < policy.minimumRecoveryReserveQuoteAtoms) {
    addReason(reasons, 'RECOVERY_RESERVE_INSUFFICIENT');
  }
  if (raw.marginOffsetContext.nowMs !== decisionAtMs) {
    throw new MalformedInputError('optimizePortfolio.candidate.marginOffsetContext.nowMs', 'context time must equal decision time');
  }
  const close = packageCloseCostIndex(raw.positionSnapshot.positions, raw.marginOffsetContext.failedDependencyIds);
  if (!close.complete) addReason(reasons, 'UNWIND_UNAVAILABLE');
  if (close.timeToUnwindMs > policy.maximumTimeToUnwindMs) addReason(reasons, 'TIME_TO_UNWIND_EXCEEDED');
  const margin = evaluateMarginOffset(
    raw.positionSnapshot.positions,
    raw.marginOffsetPolicy,
    raw.marginOffsetContext,
    policy.accountingAsset,
  );
  if (margin.failedConditions.includes('STALE_OR_UNKNOWN_STATE')) addReason(reasons, 'POSITION_STATE_INCOMPLETE');
  if (margin.failedConditions.some((condition) => condition === 'MISSING_CLOSE_AUTHORITY'
    || condition === 'NO_SHARED_UNWIND'
    || condition === 'INSUFFICIENT_EXECUTABLE_LIQUIDITY'
    || condition === 'FAILED_DEPENDENCY')) addReason(reasons, 'UNWIND_UNAVAILABLE');
  if (margin.failedConditions.includes('RECOVERY_CAPITAL_NOT_RESERVED')) addReason(reasons, 'RECOVERY_RESERVE_INSUFFICIENT');
  if (margin.failedConditions.includes('OUTSIDE_RISK_DOMAIN')) addReason(reasons, 'RISK_DOMAIN_MISMATCH');
  const stressResults = raw.stressScenarios.map((scenario) => stressPortfolio(raw.positionSnapshot.positions, scenario, policy.accountingAsset));
  if (stressResults.some((result) => result.unclosableSnapshotIds.length > 0)) addReason(reasons, 'UNWIND_UNAVAILABLE');
  const stressLosses = stressResults.map((result) => result.lossQuoteAtoms);
  const maximumStressLossQuoteAtoms = stressLosses.reduce((maximum, value) => value > maximum ? value : maximum, 0n);
  if (maximumStressLossQuoteAtoms > policy.maximumStressLossQuoteAtoms) addReason(reasons, 'STRESS_LOSS_EXCEEDED');
  const stressRequirement = maximumStressLossQuoteAtoms + policy.minimumRecoveryReserveQuoteAtoms;
  const requiredBeforeCosts = margin.resultingRequirementQuoteAtoms > stressRequirement
    ? margin.resultingRequirementQuoteAtoms
    : stressRequirement;
  const requiredCollateralQuoteAtoms = checkedUnsigned(requiredBeforeCosts + totalCostQuoteAtoms, U128_BITS, 'optimizePortfolio.requiredCollateralQuoteAtoms');
  if (requiredCollateralQuoteAtoms > policy.maximumRequiredCollateralQuoteAtoms) addReason(reasons, 'REQUIRED_COLLATERAL_EXCEEDED');
  if (totalCostQuoteAtoms > policy.maximumTotalCostQuoteAtoms) addReason(reasons, 'TOTAL_COST_EXCEEDED');
  const available = checkedUnsigned(
    collateral.ownAvailableQuoteAtoms + collateral.requestedBorrowQuoteAtoms,
    U128_BITS,
    'optimizePortfolio.availableCollateralQuoteAtoms',
  );
  const effectiveCollateralQuoteAtoms = mulDiv(available, BPS - collateral.haircutBps, BPS, ROUNDING.FLOOR);
  if (effectiveCollateralQuoteAtoms < requiredCollateralQuoteAtoms) addReason(reasons, 'INSUFFICIENT_COLLATERAL');
  const rejections = [...reasons].sort((left, right) => PORTFOLIO_CANDIDATE_REJECTION[left] - PORTFOLIO_CANDIDATE_REJECTION[right]);
  const positionHash = positionSnapshotRecordHash(raw.positionSnapshot);
  const collateralHash = collateralSnapshotHash(raw.collateralSnapshot);
  return Object.freeze({
    candidateId,
    candidateInputHash: candidateInputHash(raw, positionHash, collateralHash),
    positionSnapshotHash: positionHash,
    collateralSnapshotHash: collateralHash,
    routeHash: commitmentHash(raw.routeHash, 'optimizePortfolio.candidate.routeHash'),
    executionGraphHash: commitmentHash(raw.executionGraphHash, 'optimizePortfolio.candidate.executionGraphHash'),
    unwindRouteHash: commitmentHash(raw.unwindRouteHash, 'optimizePortfolio.candidate.unwindRouteHash'),
    eligible: rejections.length === 0,
    rejections: Object.freeze(rejections),
    metrics: Object.freeze({
      netOutcomeQuoteAtoms,
      totalCostQuoteAtoms,
      requiredCollateralQuoteAtoms,
      effectiveCollateralQuoteAtoms,
      maximumStressLossQuoteAtoms,
      timeToUnwindMs: close.timeToUnwindMs,
      solverConcentrationBps,
    }),
  });
}

function compareMetric(metric: PortfolioObjectiveMetric, left: PortfolioCandidateDecision, right: PortfolioCandidateDecision): number {
  const leftValue = metric === 'MAXIMIZE_NET_OUTCOME' ? left.metrics.netOutcomeQuoteAtoms
    : metric === 'MINIMIZE_REQUIRED_COLLATERAL' ? left.metrics.requiredCollateralQuoteAtoms
      : metric === 'MINIMIZE_STRESS_LOSS' ? left.metrics.maximumStressLossQuoteAtoms
        : metric === 'MINIMIZE_TIME_TO_UNWIND' ? left.metrics.timeToUnwindMs
          : left.metrics.totalCostQuoteAtoms;
  const rightValue = metric === 'MAXIMIZE_NET_OUTCOME' ? right.metrics.netOutcomeQuoteAtoms
    : metric === 'MINIMIZE_REQUIRED_COLLATERAL' ? right.metrics.requiredCollateralQuoteAtoms
      : metric === 'MINIMIZE_STRESS_LOSS' ? right.metrics.maximumStressLossQuoteAtoms
        : metric === 'MINIMIZE_TIME_TO_UNWIND' ? right.metrics.timeToUnwindMs
          : right.metrics.totalCostQuoteAtoms;
  if (leftValue === rightValue) return 0;
  if (metric === 'MAXIMIZE_NET_OUTCOME') return leftValue > rightValue ? -1 : 1;
  return leftValue < rightValue ? -1 : 1;
}

function encodeDecisionCandidate(writer: CanonicalWriter, value: PortfolioCandidateDecision): void {
  encodeProtocolId(writer, value.candidateId, 'candidateId');
  encodeCommitmentHash(writer, value.candidateInputHash, 'candidateInputHash');
  encodeCommitmentHash(writer, value.positionSnapshotHash, 'positionSnapshotHash');
  encodeCommitmentHash(writer, value.collateralSnapshotHash, 'collateralSnapshotHash');
  encodeCommitmentHash(writer, value.routeHash, 'routeHash');
  encodeCommitmentHash(writer, value.executionGraphHash, 'executionGraphHash');
  encodeCommitmentHash(writer, value.unwindRouteHash, 'unwindRouteHash');
  writer.writeBool(value.eligible, 'eligible');
  writer.writeArray(value.rejections, (inner, reason) => inner.writeEnum(PORTFOLIO_CANDIDATE_REJECTION, reason), 'rejections');
  writer.writeI128(value.metrics.netOutcomeQuoteAtoms, 'netOutcomeQuoteAtoms');
  writer.writeU128(value.metrics.totalCostQuoteAtoms, 'totalCostQuoteAtoms');
  writer.writeU128(value.metrics.requiredCollateralQuoteAtoms, 'requiredCollateralQuoteAtoms');
  writer.writeU128(value.metrics.effectiveCollateralQuoteAtoms, 'effectiveCollateralQuoteAtoms');
  writer.writeU128(value.metrics.maximumStressLossQuoteAtoms, 'maximumStressLossQuoteAtoms');
  writer.writeU64(value.metrics.timeToUnwindMs, 'timeToUnwindMs');
  writer.writeU64(value.metrics.solverConcentrationBps, 'solverConcentrationBps');
}

export function optimizePortfolio(
  policyInput: PortfolioOptimizationPolicyInput,
  decisionAtMsInput: bigint,
  candidateInputs: readonly PortfolioOptimizationCandidateInput[],
): PortfolioOptimizationDecision {
  const policy = portfolioOptimizationPolicy(policyInput);
  const decisionAtMs = unsigned(decisionAtMsInput, U64_BITS, 'optimizePortfolio.decisionAtMs');
  if (!Array.isArray(candidateInputs) || candidateInputs.length === 0 || candidateInputs.length > PORTFOLIO_OPTIMIZATION_MAX_CANDIDATES) {
    throw new MalformedInputError('optimizePortfolio.candidates', `expected 1 to ${PORTFOLIO_OPTIMIZATION_MAX_CANDIDATES} candidates`);
  }
  const candidates = candidateInputs.map((candidate) => candidateDecision(candidate, policy, decisionAtMs));
  const ids = candidates.map((candidate) => candidate.candidateId);
  if (new Set(ids).size !== ids.length) throw new DuplicateElementError('optimizePortfolio.candidates', 'candidate id appears twice');
  const orderedCandidates = Object.freeze([...candidates].sort((left, right) => left.candidateId.localeCompare(right.candidateId)));
  const ranked = candidates.filter((candidate) => candidate.eligible).sort((left, right) => {
    for (const metric of policy.objectivePriority) {
      const result = compareMetric(metric, left, right);
      if (result !== 0) return result;
    }
    const routeOrder = compareBytes(left.routeHash, right.routeHash);
    return routeOrder !== 0 ? routeOrder : left.candidateId.localeCompare(right.candidateId);
  });
  const selectedCandidateId = ranked[0]?.candidateId;
  const policyHash = portfolioOptimizationPolicyHash(policyInput);
  const bytes = canonicalBytes((writer) => {
    writer.writeU32(PORTFOLIO_OPTIMIZATION_POLICY_VERSION, 'version');
    encodeCommitmentHash(writer, policyHash, 'policyHash');
    writer.writeU64(decisionAtMs, 'decisionAtMs');
    writer.writeArray(orderedCandidates, encodeDecisionCandidate, 'candidates');
    writer.writeOptional(selectedCandidateId, (inner, value) => encodeProtocolId(inner, value), 'selectedCandidateId');
    writer.writeBool(true, 'advisory');
  });
  const decisionHash = commitmentHash(domainHash(HASH_DOMAIN.PORTFOLIO_OPTIMIZATION_DECISION, bytes), 'portfolioOptimizationDecisionHash');
  return Object.freeze({
    advisory: true,
    policyHash,
    decisionAtMs,
    candidates: orderedCandidates,
    ...(selectedCandidateId === undefined ? {} : { selectedCandidateId }),
    decisionHash,
  });
}
