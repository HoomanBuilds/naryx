import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { enumDiscriminant } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, type CommitmentHash } from './package-order-primitives.js';
import {
  assetRef,
  encodeAssetRef,
  encodeProtocolId,
  protocolId,
  type AssetRef,
  type ProtocolId,
} from './primitives.js';

export const STRATEGY_RISK_SNAPSHOT_VERSION = 1;
export const STRATEGY_RISK_MAX_DEPENDENCIES = 64;
const I128_BITS = 128;
const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;
const PPM = 1_000_000n;
const BPS = 10_000n;
const DAY_MS = 86_400_000n;

export const STRATEGY_RISK_DEPENDENCY_KIND = Object.freeze({
  DOMAIN: 1,
  VENUE: 2,
  MARKET: 3,
  ORACLE: 4,
  SOLVER: 5,
  BRIDGE: 6,
  COLLATERAL: 7,
} as const);
export type StrategyRiskDependencyKind = keyof typeof STRATEGY_RISK_DEPENDENCY_KIND;

export interface StrategyRiskDependencyInput {
  readonly kind: StrategyRiskDependencyKind;
  readonly dependencyId: string;
}

export interface StrategyRiskDependency {
  readonly kind: StrategyRiskDependencyKind;
  readonly dependencyId: ProtocolId;
}

export interface StrategyRiskSnapshotInput {
  readonly version: number;
  readonly snapshotId: string;
  readonly observedAtMs: bigint;
  readonly strategyId: string;
  readonly owner: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly seriesId: string;
  readonly riskClassId: string;
  readonly underlyingId: string;
  readonly quoteAsset: AssetRef;
  readonly grossNotionalQuoteAtoms: bigint;
  readonly marginQuoteAtoms: bigint;
  readonly deltaQuoteAtomsForFullMove: bigint;
  readonly gammaQuoteAtomsForFullMoveSquared: bigint;
  readonly vegaQuoteAtomsForFullVolMove: bigint;
  readonly thetaQuoteAtomsPerDay: bigint;
  readonly maximumLossQuoteAtoms: bigint;
  readonly closeCostQuoteAtoms: bigint;
  readonly timeToUnwindMs: bigint;
  readonly dependencies: readonly StrategyRiskDependencyInput[];
}

export interface StrategyRiskSnapshot extends Omit<StrategyRiskSnapshotInput,
  'snapshotId' | 'strategyId' | 'owner' | 'templateId' | 'seriesId' | 'riskClassId' |
  'underlyingId' | 'quoteAsset' | 'dependencies'> {
  readonly version: 1;
  readonly snapshotId: ProtocolId;
  readonly strategyId: ProtocolId;
  readonly owner: ProtocolId;
  readonly templateId: ProtocolId;
  readonly seriesId: ProtocolId;
  readonly riskClassId: ProtocolId;
  readonly underlyingId: ProtocolId;
  readonly quoteAsset: AssetRef;
  readonly dependencies: readonly StrategyRiskDependency[];
}

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

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && compareBytes(left.assetManifestHash, right.assetManifestHash) === 0;
}

function dependencies(values: readonly StrategyRiskDependencyInput[], context: string): readonly StrategyRiskDependency[] {
  if (!Array.isArray(values) || values.length > STRATEGY_RISK_MAX_DEPENDENCIES) {
    throw new MalformedInputError(context, `expected at most ${STRATEGY_RISK_MAX_DEPENDENCIES} dependencies`);
  }
  const checked: StrategyRiskDependency[] = values.map((value, index) => {
    const at = `${context}[${index}]`;
    object(value, at);
    enumDiscriminant(STRATEGY_RISK_DEPENDENCY_KIND, value.kind, `${at}.kind`);
    return Object.freeze({ kind: value.kind, dependencyId: protocolId(value.dependencyId, `${at}.dependencyId`) });
  }).sort((left, right) => STRATEGY_RISK_DEPENDENCY_KIND[left.kind as StrategyRiskDependencyKind] - STRATEGY_RISK_DEPENDENCY_KIND[right.kind as StrategyRiskDependencyKind]
    || left.dependencyId.localeCompare(right.dependencyId));
  for (let index = 1; index < checked.length; index += 1) {
    const previous = checked[index - 1]!;
    const current = checked[index]!;
    if (previous.kind === current.kind && previous.dependencyId === current.dependencyId) {
      throw new DuplicateElementError(context, 'dependency appears twice');
    }
  }
  return Object.freeze(checked);
}

export function strategyRiskSnapshot(input: StrategyRiskSnapshotInput, context = 'strategyRiskSnapshot'): StrategyRiskSnapshot {
  object(input, context);
  if (input.version !== STRATEGY_RISK_SNAPSHOT_VERSION) throw new MalformedInputError(`${context}.version`, `version must equal ${STRATEGY_RISK_SNAPSHOT_VERSION}`);
  if (!Number.isSafeInteger(input.templateVersion) || input.templateVersion < 0) {
    throw new MalformedInputError(`${context}.templateVersion`, 'expected a nonnegative safe integer');
  }
  const templateVersion = Number(unsigned(BigInt(input.templateVersion), U32_BITS, `${context}.templateVersion`));
  if (templateVersion === 0) throw new MalformedInputError(`${context}.templateVersion`, 'template version must be nonzero');
  return Object.freeze({
    version: STRATEGY_RISK_SNAPSHOT_VERSION,
    snapshotId: protocolId(input.snapshotId, `${context}.snapshotId`),
    observedAtMs: unsigned(input.observedAtMs, U64_BITS, `${context}.observedAtMs`),
    strategyId: protocolId(input.strategyId, `${context}.strategyId`),
    owner: protocolId(input.owner, `${context}.owner`),
    templateId: protocolId(input.templateId, `${context}.templateId`),
    templateVersion,
    seriesId: protocolId(input.seriesId, `${context}.seriesId`),
    riskClassId: protocolId(input.riskClassId, `${context}.riskClassId`),
    underlyingId: protocolId(input.underlyingId, `${context}.underlyingId`),
    quoteAsset: assetRef(input.quoteAsset.assetId, input.quoteAsset.assetManifestHash, input.quoteAsset.decimals, `${context}.quoteAsset`),
    grossNotionalQuoteAtoms: unsigned(input.grossNotionalQuoteAtoms, U128_BITS, `${context}.grossNotionalQuoteAtoms`),
    marginQuoteAtoms: unsigned(input.marginQuoteAtoms, U128_BITS, `${context}.marginQuoteAtoms`),
    deltaQuoteAtomsForFullMove: signed(input.deltaQuoteAtomsForFullMove, `${context}.deltaQuoteAtomsForFullMove`),
    gammaQuoteAtomsForFullMoveSquared: signed(input.gammaQuoteAtomsForFullMoveSquared, `${context}.gammaQuoteAtomsForFullMoveSquared`),
    vegaQuoteAtomsForFullVolMove: signed(input.vegaQuoteAtomsForFullVolMove, `${context}.vegaQuoteAtomsForFullVolMove`),
    thetaQuoteAtomsPerDay: signed(input.thetaQuoteAtomsPerDay, `${context}.thetaQuoteAtomsPerDay`),
    maximumLossQuoteAtoms: unsigned(input.maximumLossQuoteAtoms, U128_BITS, `${context}.maximumLossQuoteAtoms`),
    closeCostQuoteAtoms: unsigned(input.closeCostQuoteAtoms, U128_BITS, `${context}.closeCostQuoteAtoms`),
    timeToUnwindMs: unsigned(input.timeToUnwindMs, U64_BITS, `${context}.timeToUnwindMs`),
    dependencies: dependencies(input.dependencies, `${context}.dependencies`),
  });
}

function encodeDependency(writer: CanonicalWriter, value: StrategyRiskDependency): void {
  writer.writeEnum(STRATEGY_RISK_DEPENDENCY_KIND, value.kind, 'kind');
  encodeProtocolId(writer, value.dependencyId, 'dependencyId');
}

export function strategyRiskSnapshotBytes(input: StrategyRiskSnapshotInput): Uint8Array {
  const value = strategyRiskSnapshot(input);
  return canonicalBytes((writer) => {
    writer.writeU32(value.version, 'version');
    encodeProtocolId(writer, value.snapshotId, 'snapshotId');
    writer.writeU64(value.observedAtMs, 'observedAtMs');
    encodeProtocolId(writer, value.strategyId, 'strategyId');
    encodeProtocolId(writer, value.owner, 'owner');
    encodeProtocolId(writer, value.templateId, 'templateId');
    writer.writeU32(value.templateVersion, 'templateVersion');
    encodeProtocolId(writer, value.seriesId, 'seriesId');
    encodeProtocolId(writer, value.riskClassId, 'riskClassId');
    encodeProtocolId(writer, value.underlyingId, 'underlyingId');
    encodeAssetRef(writer, value.quoteAsset);
    writer.writeU128(value.grossNotionalQuoteAtoms, 'grossNotionalQuoteAtoms');
    writer.writeU128(value.marginQuoteAtoms, 'marginQuoteAtoms');
    writer.writeI128(value.deltaQuoteAtomsForFullMove, 'deltaQuoteAtomsForFullMove');
    writer.writeI128(value.gammaQuoteAtomsForFullMoveSquared, 'gammaQuoteAtomsForFullMoveSquared');
    writer.writeI128(value.vegaQuoteAtomsForFullVolMove, 'vegaQuoteAtomsForFullVolMove');
    writer.writeI128(value.thetaQuoteAtomsPerDay, 'thetaQuoteAtomsPerDay');
    writer.writeU128(value.maximumLossQuoteAtoms, 'maximumLossQuoteAtoms');
    writer.writeU128(value.closeCostQuoteAtoms, 'closeCostQuoteAtoms');
    writer.writeU64(value.timeToUnwindMs, 'timeToUnwindMs');
    writer.writeArray(value.dependencies, encodeDependency, 'dependencies');
  });
}

export function strategyRiskSnapshotHash(input: StrategyRiskSnapshotInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.STRATEGY_RISK_SNAPSHOT, strategyRiskSnapshotBytes(input)), 'strategyRiskSnapshotHash');
}

export interface StrategyRiskAggregate {
  readonly quoteAsset: AssetRef;
  readonly grossNotionalQuoteAtoms: bigint;
  readonly marginQuoteAtoms: bigint;
  readonly maximumLossQuoteAtoms: bigint;
  readonly closeCostQuoteAtoms: bigint;
  readonly maximumTimeToUnwindMs: bigint;
  readonly byUnderlying: readonly Readonly<{
    underlyingId: ProtocolId;
    grossNotionalQuoteAtoms: bigint;
    deltaQuoteAtomsForFullMove: bigint;
    gammaQuoteAtomsForFullMoveSquared: bigint;
    vegaQuoteAtomsForFullVolMove: bigint;
    thetaQuoteAtomsPerDay: bigint;
  }>[];
  readonly dependencyConcentrations: readonly Readonly<{
    kind: StrategyRiskDependencyKind;
    dependencyId: ProtocolId;
    grossNotionalQuoteAtoms: bigint;
    strategyCount: number;
  }>[];
}

function snapshots(inputs: readonly StrategyRiskSnapshotInput[], context: string): readonly StrategyRiskSnapshot[] {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 256) throw new MalformedInputError(context, 'expected 1 to 256 strategy risk snapshots');
  const checked = inputs.map((input, index) => strategyRiskSnapshot(input, `${context}[${index}]`));
  const ids = new Set<string>();
  for (const value of checked) {
    if (ids.has(value.snapshotId)) throw new DuplicateElementError(context, `snapshot ${value.snapshotId} appears twice`);
    ids.add(value.snapshotId);
  }
  const quoteAsset = checked[0]!.quoteAsset;
  if (checked.some((value) => !sameAsset(value.quoteAsset, quoteAsset))) throw new MalformedInputError(context, 'all snapshots must use one accounting asset');
  return Object.freeze(checked);
}

export function aggregateStrategyRisk(inputs: readonly StrategyRiskSnapshotInput[]): StrategyRiskAggregate {
  const checked = snapshots(inputs, 'aggregateStrategyRisk.snapshots');
  const byUnderlying = new Map<string, {
    gross: bigint;
    delta: bigint;
    gamma: bigint;
    vega: bigint;
    theta: bigint;
  }>();
  const byDependency = new Map<string, { kind: StrategyRiskDependencyKind; dependencyId: ProtocolId; gross: bigint; strategies: Set<string> }>();
  for (const value of checked) {
    const line = byUnderlying.get(value.underlyingId) ?? { gross: 0n, delta: 0n, gamma: 0n, vega: 0n, theta: 0n };
    line.gross += value.grossNotionalQuoteAtoms;
    line.delta += value.deltaQuoteAtomsForFullMove;
    line.gamma += value.gammaQuoteAtomsForFullMoveSquared;
    line.vega += value.vegaQuoteAtomsForFullVolMove;
    line.theta += value.thetaQuoteAtomsPerDay;
    byUnderlying.set(value.underlyingId, line);
    for (const dependency of value.dependencies) {
      const key = `${dependency.kind}/${dependency.dependencyId}`;
      const concentration = byDependency.get(key) ?? { ...dependency, gross: 0n, strategies: new Set<string>() };
      concentration.gross += value.grossNotionalQuoteAtoms;
      concentration.strategies.add(value.strategyId);
      byDependency.set(key, concentration);
    }
  }
  return Object.freeze({
    quoteAsset: checked[0]!.quoteAsset,
    grossNotionalQuoteAtoms: checked.reduce((sum, value) => sum + value.grossNotionalQuoteAtoms, 0n),
    marginQuoteAtoms: checked.reduce((sum, value) => sum + value.marginQuoteAtoms, 0n),
    maximumLossQuoteAtoms: checked.reduce((sum, value) => sum + value.maximumLossQuoteAtoms, 0n),
    closeCostQuoteAtoms: checked.reduce((sum, value) => sum + value.closeCostQuoteAtoms, 0n),
    maximumTimeToUnwindMs: checked.reduce((maximum, value) => value.timeToUnwindMs > maximum ? value.timeToUnwindMs : maximum, 0n),
    byUnderlying: Object.freeze([...byUnderlying.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([underlyingId, value]) => Object.freeze({
      underlyingId: protocolId(underlyingId),
      grossNotionalQuoteAtoms: value.gross,
      deltaQuoteAtomsForFullMove: value.delta,
      gammaQuoteAtomsForFullMoveSquared: value.gamma,
      vegaQuoteAtomsForFullVolMove: value.vega,
      thetaQuoteAtomsPerDay: value.theta,
    }))),
    dependencyConcentrations: Object.freeze([...byDependency.values()].sort((left, right) => STRATEGY_RISK_DEPENDENCY_KIND[left.kind] - STRATEGY_RISK_DEPENDENCY_KIND[right.kind]
      || left.dependencyId.localeCompare(right.dependencyId)).map((value) => Object.freeze({
      kind: value.kind,
      dependencyId: value.dependencyId,
      grossNotionalQuoteAtoms: value.gross,
      strategyCount: value.strategies.size,
    }))),
  });
}

export interface StrategyRiskShockInput {
  readonly underlyingId: string;
  readonly priceShockPpm: bigint;
  readonly volatilityShockPpm: bigint;
}

export interface StrategyRiskStressInput {
  readonly shocks: readonly StrategyRiskShockInput[];
  readonly horizonMs: bigint;
  readonly closeCostMultiplierBps: bigint;
  readonly failedDependencies: readonly StrategyRiskDependencyInput[];
}

export interface StrategyRiskStressResult {
  readonly pnlQuoteAtoms: bigint;
  readonly closeCostQuoteAtoms: bigint;
  readonly lossQuoteAtoms: bigint;
  readonly uncloseableStrategyIds: readonly ProtocolId[];
  readonly byStrategy: readonly Readonly<{
    strategyId: ProtocolId;
    pnlQuoteAtoms: bigint;
    closeCostQuoteAtoms: bigint;
    lossQuoteAtoms: bigint;
    dependencyFailed: boolean;
  }>[];
}

export function stressStrategyRisk(
  inputs: readonly StrategyRiskSnapshotInput[],
  scenario: StrategyRiskStressInput,
): StrategyRiskStressResult {
  const checked = snapshots(inputs, 'stressStrategyRisk.snapshots');
  object(scenario, 'stressStrategyRisk.scenario');
  if (!Array.isArray(scenario.shocks) || scenario.shocks.length > 64) throw new MalformedInputError('stressStrategyRisk.scenario.shocks', 'expected at most 64 shocks');
  const shocks = new Map<string, { price: bigint; volatility: bigint }>();
  for (const [index, input] of scenario.shocks.entries()) {
    const at = `stressStrategyRisk.scenario.shocks[${index}]`;
    const underlyingId = protocolId(input.underlyingId, `${at}.underlyingId`);
    if (shocks.has(underlyingId)) throw new DuplicateElementError(at, 'underlying appears twice');
    const price = signed(input.priceShockPpm, `${at}.priceShockPpm`);
    if (price <= -PPM) throw new MalformedInputError(`${at}.priceShockPpm`, 'price shock reaches or crosses zero');
    shocks.set(underlyingId, { price, volatility: signed(input.volatilityShockPpm, `${at}.volatilityShockPpm`) });
  }
  const horizonMs = unsigned(scenario.horizonMs, U64_BITS, 'stressStrategyRisk.scenario.horizonMs');
  const closeMultiplier = unsigned(scenario.closeCostMultiplierBps, U64_BITS, 'stressStrategyRisk.scenario.closeCostMultiplierBps');
  const failed = new Set(dependencies(scenario.failedDependencies, 'stressStrategyRisk.scenario.failedDependencies').map((value) => `${value.kind}/${value.dependencyId}`));
  const byStrategy = checked.map((value) => {
    const shock = shocks.get(value.underlyingId) ?? { price: 0n, volatility: 0n };
    const deltaPnl = value.deltaQuoteAtomsForFullMove * shock.price / PPM;
    const gammaPnl = value.gammaQuoteAtomsForFullMoveSquared * shock.price * shock.price / (2n * PPM * PPM);
    const vegaPnl = value.vegaQuoteAtomsForFullVolMove * shock.volatility / PPM;
    const thetaPnl = value.thetaQuoteAtomsPerDay * horizonMs / DAY_MS;
    const pnlQuoteAtoms = signed(deltaPnl + gammaPnl + vegaPnl + thetaPnl, 'stressStrategyRisk.pnlQuoteAtoms');
    const closeCostQuoteAtoms = checkedUnsigned(value.closeCostQuoteAtoms * closeMultiplier / BPS, U128_BITS, 'stressStrategyRisk.closeCostQuoteAtoms');
    const dependencyFailed = value.dependencies.some((dependency) => failed.has(`${dependency.kind}/${dependency.dependencyId}`));
    const marketLoss = pnlQuoteAtoms < 0n ? -pnlQuoteAtoms + closeCostQuoteAtoms : closeCostQuoteAtoms;
    const lossQuoteAtoms = dependencyFailed && value.maximumLossQuoteAtoms > marketLoss ? value.maximumLossQuoteAtoms : marketLoss;
    return Object.freeze({ strategyId: value.strategyId, pnlQuoteAtoms, closeCostQuoteAtoms, lossQuoteAtoms, dependencyFailed });
  });
  return Object.freeze({
    pnlQuoteAtoms: byStrategy.reduce((sum, value) => sum + value.pnlQuoteAtoms, 0n),
    closeCostQuoteAtoms: byStrategy.reduce((sum, value) => sum + value.closeCostQuoteAtoms, 0n),
    lossQuoteAtoms: byStrategy.reduce((sum, value) => sum + value.lossQuoteAtoms, 0n),
    uncloseableStrategyIds: Object.freeze(byStrategy.filter((value) => value.dependencyFailed).map((value) => value.strategyId).sort()),
    byStrategy: Object.freeze(byStrategy),
  });
}
