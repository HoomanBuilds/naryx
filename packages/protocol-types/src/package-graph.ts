import { checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  EXPIRY_UNIT,
  SETTLEMENT_CLASS,
  type EnumTable,
  type ExpiryUnit,
  type SettlementClass,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  adapterRef,
  commitmentHash,
  encodeAdapterRef,
  encodeCommitmentHash,
  encodeExactPrice,
  exactPrice,
  type AdapterRef,
  type CommitmentHash,
  type ExactPrice,
  type ExactPriceInput,
} from './package-order-primitives.js';
import { packageTemplateManifest, packageTemplateManifestHash, type PackageTemplateManifestInput } from './package-template-manifest.js';
import { domainRegistryRecord, type DomainRegistryRecordInput } from './domain-registry-record.js';
import {
  assetRef,
  domainRef,
  encodeAssetRef,
  encodeDomainRef,
  encodeManifestHash,
  encodeProtocolId,
  encodeVersionedManifestRef,
  manifestHash,
  protocolId,
  versionedManifestRef,
  type AssetRef,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
  type VersionedManifestRef,
} from './primitives.js';

const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;

export const PACKAGE_GRAPH_VERSION = 1;
export const MAX_GRAPH_LEGS = 32;
export const MAX_GRAPH_EDGES = 128;
export const MAX_LEG_CONDITIONS = 16;

/** The supported leg families; a template narrows them further by its own leg type ids. */
export const LEG_FAMILY = Object.freeze({
  SPOT_SWAP: 1,
  INVENTORY_TRANSFER: 2,
  PERP_OPEN: 3,
  PERP_CLOSE: 4,
  PERP_INCREASE: 5,
  PERP_DECREASE: 6,
  PERP_MIGRATE: 7,
  FUTURE_OPEN: 8,
  FUTURE_CLOSE: 9,
  FUTURE_ROLL: 10,
  OPTION_BUY: 11,
  OPTION_SELL: 12,
  OPTION_MINT: 13,
  OPTION_EXERCISE: 14,
  OPTION_CASH_SETTLE: 15,
  LEND: 16,
  BORROW: 17,
  REPAY: 18,
  WITHDRAW: 19,
  COLLATERAL_TRANSFER: 20,
  MARGIN_DEPOSIT: 21,
  MARGIN_RELEASE: 22,
  ACCOUNT_TRANSFER: 23,
  CROSS_DOMAIN_ESCROW: 24,
} as const);
export type LegFamily = keyof typeof LEG_FAMILY;

export const GRAPH_LEG_SIDE = Object.freeze({ BUY: 1, SELL: 2, NONE: 3 } as const);
export type GraphLegSide = keyof typeof GRAPH_LEG_SIDE;

export const GRAPH_LEG_TIME_IN_FORCE = Object.freeze({ IOC: 1, FOK: 2, GTD: 3 } as const);
export type GraphLegTimeInForce = keyof typeof GRAPH_LEG_TIME_IN_FORCE;

/** How a group of legs may settle: all or none, exact quantities, or a signed residual bound. */
export const EXECUTION_GROUP_KIND = Object.freeze({ ALL_OR_NONE: 1, EXACT_FILL: 2, BOUNDED_PARTIAL: 3 } as const);
export type ExecutionGroupKind = keyof typeof EXECUTION_GROUP_KIND;

export const GRAPH_LIFECYCLE_ACTION = Object.freeze({
  ENTRY: 1,
  EXIT: 2,
  ROLL: 3,
  REBALANCE: 4,
  MIGRATE: 5,
  EMERGENCY_UNWIND: 6,
  INCREASE: 7,
  DECREASE: 8,
} as const);
export type GraphLifecycleAction = keyof typeof GRAPH_LIFECYCLE_ACTION;

export const GRAPH_RECOVERY_ACTION = Object.freeze({ COMPLETE: 1, ROLLBACK: 2 } as const);
export type GraphRecoveryAction = keyof typeof GRAPH_RECOVERY_ACTION;

export interface PackageLegInput {
  readonly legId: string;
  readonly legFamily: LegFamily;
  /** One of the template's own leg type ids. */
  readonly legTypeId: string;
  readonly domain: DomainRef;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly assets: readonly AssetRef[];
  readonly side: GraphLegSide;
  readonly quantityAsset: AssetRef;
  readonly quantityAtoms: bigint;
  /** Equal to `quantityAtoms` for an exact leg; lower for a leg in a bounded-partial group. */
  readonly minimumQuantityAtoms: bigint;
  readonly limitPrice?: ExactPriceInput;
  readonly maximumFeeQuoteAtoms: bigint;
  readonly preconditionHashes: readonly (Uint8Array | string)[];
  readonly postconditionHashes: readonly (Uint8Array | string)[];
  readonly timeInForce: GraphLegTimeInForce;
  readonly legExpiryValue: bigint;
}

export interface DependencyEdgeInput {
  /** The leg that must settle first. */
  readonly fromLegId: string;
  readonly toLegId: string;
}

export interface ExecutionGroupInput {
  readonly groupId: string;
  readonly kind: ExecutionGroupKind;
  readonly legIds: readonly string[];
  /** Required for a bounded-partial group and forbidden otherwise. */
  readonly maximumResidualQuoteAtoms?: bigint;
}

export interface GraphRecoverySlotInput {
  readonly legId: string;
  readonly action: GraphRecoveryAction;
  readonly maximumQuantityAtoms: bigint;
  readonly maximumCostQuoteAtoms: bigint;
}

export interface PackageGraphPolicyHashes {
  readonly netting: Uint8Array | string;
  readonly privacy: Uint8Array | string;
  readonly solver: Uint8Array | string;
  readonly delivery: Uint8Array | string;
  readonly resource: Uint8Array | string;
  readonly portfolioRiskLimits: Uint8Array | string;
}

export interface PackageGraphInput {
  readonly graphVersion: number;
  readonly environment: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array | string;
  readonly seriesId: string;
  readonly seriesVersion: number;
  readonly seriesManifestHash: Uint8Array | string;
  readonly executionClassId: string;
  readonly executionClassVersion: number;
  readonly executionClassManifestHash: Uint8Array | string;
  readonly lifecycleAction: GraphLifecycleAction;
  readonly owner: string;
  readonly strategyAccountRefs: readonly string[];
  readonly legs: readonly PackageLegInput[];
  readonly dependencyEdges: readonly DependencyEdgeInput[];
  readonly executionGroups: readonly ExecutionGroupInput[];
  readonly settlementClass: SettlementClass;
  readonly policyHashes: PackageGraphPolicyHashes;
  readonly builderAttributionHash?: Uint8Array | string;
  readonly recoverySlots: readonly GraphRecoverySlotInput[];
  /** The most every recovery action together may cost; no slot set may promise more. */
  readonly maximumRecoveryCostQuoteAtoms: bigint;
  readonly expiryUnit: ExpiryUnit;
  readonly packageExpiryValue: bigint;
  readonly nonce: bigint;
}

interface CheckedLeg {
  readonly legId: ProtocolId;
  readonly legFamily: LegFamily;
  readonly legTypeId: ProtocolId;
  readonly domain: DomainRef;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly assets: readonly AssetRef[];
  readonly side: GraphLegSide;
  readonly quantityAsset: AssetRef;
  readonly quantityAtoms: bigint;
  readonly minimumQuantityAtoms: bigint;
  readonly limitPrice?: ExactPrice;
  readonly maximumFeeQuoteAtoms: bigint;
  readonly preconditionHashes: readonly CommitmentHash[];
  readonly postconditionHashes: readonly CommitmentHash[];
  readonly timeInForce: GraphLegTimeInForce;
  readonly legExpiryValue: bigint;
}

export interface PackageGraph {
  readonly graphVersion: number;
  readonly environment: ProtocolId;
  readonly templateId: ProtocolId;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: CommitmentHash;
  readonly seriesId: ProtocolId;
  readonly seriesVersion: number;
  readonly seriesManifestHash: ManifestHash;
  readonly executionClassId: ProtocolId;
  readonly executionClassVersion: number;
  readonly executionClassManifestHash: ManifestHash;
  readonly lifecycleAction: GraphLifecycleAction;
  readonly owner: ProtocolId;
  readonly strategyAccountRefs: readonly ProtocolId[];
  /** Sorted by leg id. */
  readonly legs: readonly CheckedLeg[];
  readonly dependencyEdges: readonly { readonly fromLegId: ProtocolId; readonly toLegId: ProtocolId }[];
  readonly executionGroups: readonly { readonly groupId: ProtocolId; readonly kind: ExecutionGroupKind; readonly legIds: readonly ProtocolId[]; readonly maximumResidualQuoteAtoms?: bigint }[];
  readonly settlementClass: SettlementClass;
  readonly policyHashes: Readonly<Record<keyof PackageGraphPolicyHashes, CommitmentHash>>;
  readonly builderAttributionHash?: CommitmentHash;
  readonly recoverySlots: readonly { readonly legId: ProtocolId; readonly action: GraphRecoveryAction; readonly maximumQuantityAtoms: bigint; readonly maximumCostQuoteAtoms: bigint }[];
  readonly maximumRecoveryCostQuoteAtoms: bigint;
  readonly expiryUnit: ExpiryUnit;
  readonly packageExpiryValue: bigint;
  readonly nonce: bigint;
  /** Legs in dependency order: every leg of a stage depends only on legs of earlier stages. */
  readonly stages: readonly (readonly ProtocolId[])[];
}

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function nonzeroVersion(value: number, context: string): number {
  if (!Number.isInteger(value)) throw new MalformedInputError(context, 'expected an integer');
  const checked = unsigned(BigInt(value), U32_BITS, context);
  if (checked === 0n) throw new MalformedInputError(context, 'version is zero');
  return Number(checked);
}

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

function list<T>(value: readonly T[], maximum: number, context: string, allowEmpty = true): readonly T[] {
  if (!Array.isArray(value)) throw new MalformedInputError(context, 'expected an array');
  if (value.length > maximum || (!allowEmpty && value.length === 0)) throw new MalformedInputError(context, `expected ${allowEmpty ? 0 : 1} to ${maximum} entries`);
  return value;
}

function sortedIds(values: readonly string[], maximum: number, context: string, allowEmpty = true): readonly ProtocolId[] {
  const ids = list(values, maximum, context, allowEmpty).map((value, index) => protocolId(value, `${context}[${index}]`)).sort();
  for (let index = 1; index < ids.length; index += 1) if (ids[index - 1] === ids[index]) throw new DuplicateElementError(context, 'identifiers repeat');
  return Object.freeze(ids);
}

function sortedHashes(values: readonly (Uint8Array | string)[], context: string): readonly CommitmentHash[] {
  const hashes = list(values, MAX_LEG_CONDITIONS, context).map((value, index) => commitmentHash(value, `${context}[${index}]`)).sort(compareBytes);
  for (let index = 1; index < hashes.length; index += 1) {
    if (compareBytes(hashes[index - 1] as Uint8Array, hashes[index] as Uint8Array) === 0) throw new DuplicateElementError(context, 'conditions repeat');
  }
  return Object.freeze(hashes);
}

function checkedAsset(value: AssetRef, context: string): AssetRef {
  object(value, context);
  return assetRef(value.assetId, value.assetManifestHash, value.decimals, context);
}

function checkedManifestRef(value: VersionedManifestRef, context: string): VersionedManifestRef {
  object(value, context);
  return versionedManifestRef(value.subjectId, value.manifestVersion, value.manifestHash, context);
}

function assetKey(asset: AssetRef): string {
  return canonicalBytes((writer) => encodeAssetRef(writer, asset)).join(',');
}

function checkedLeg(input: PackageLegInput, expiryLimit: bigint, context: string): CheckedLeg {
  object(input, context);
  object(input.domain, `${context}.domain`);
  object(input.adapter, `${context}.adapter`);
  const assets = list(input.assets, 8, `${context}.assets`, false).map((asset, index) => checkedAsset(asset, `${context}.assets[${index}]`));
  const keys = assets.map(assetKey);
  if (new Set(keys).size !== keys.length) throw new DuplicateElementError(`${context}.assets`, 'assets repeat');
  const quantityAsset = checkedAsset(input.quantityAsset, `${context}.quantityAsset`);
  if (!keys.includes(assetKey(quantityAsset))) throw new MalformedInputError(`${context}.quantityAsset`, 'the quantity asset is not one of the leg assets');
  const quantityAtoms = unsigned(input.quantityAtoms, U128_BITS, `${context}.quantityAtoms`);
  if (quantityAtoms === 0n) throw new MalformedInputError(`${context}.quantityAtoms`, 'a leg moves a positive quantity');
  const minimumQuantityAtoms = unsigned(input.minimumQuantityAtoms, U128_BITS, `${context}.minimumQuantityAtoms`);
  if (minimumQuantityAtoms > quantityAtoms) throw new MalformedInputError(`${context}.minimumQuantityAtoms`, 'the minimum exceeds the quantity');
  const limitPrice = input.limitPrice === undefined ? undefined : exactPrice(input.limitPrice, `${context}.limitPrice`);
  if (limitPrice !== undefined && (!keys.includes(assetKey(limitPrice.baseAsset)) || !keys.includes(assetKey(limitPrice.quoteAsset)))) {
    throw new MalformedInputError(`${context}.limitPrice`, 'the limit price names an asset outside the leg');
  }
  const side = variant(GRAPH_LEG_SIDE, input.side, `${context}.side`);
  const legExpiryValue = unsigned(input.legExpiryValue, U64_BITS, `${context}.legExpiryValue`);
  if (legExpiryValue > expiryLimit) throw new MalformedInputError(`${context}.legExpiryValue`, 'a leg cannot outlive its package');
  return Object.freeze({
    legId: protocolId(input.legId, `${context}.legId`),
    legFamily: variant(LEG_FAMILY, input.legFamily, `${context}.legFamily`),
    legTypeId: protocolId(input.legTypeId, `${context}.legTypeId`),
    domain: domainRef(input.domain.domainId, input.domain.domainManifestVersion, input.domain.domainManifestHash, `${context}.domain`),
    adapter: adapterRef(input.adapter, `${context}.adapter`),
    venue: checkedManifestRef(input.venue, `${context}.venue`),
    market: checkedManifestRef(input.market, `${context}.market`),
    assets: Object.freeze(assets),
    side,
    quantityAsset,
    quantityAtoms,
    minimumQuantityAtoms,
    ...(limitPrice === undefined ? {} : { limitPrice }),
    maximumFeeQuoteAtoms: unsigned(input.maximumFeeQuoteAtoms, U128_BITS, `${context}.maximumFeeQuoteAtoms`),
    preconditionHashes: sortedHashes(input.preconditionHashes, `${context}.preconditionHashes`),
    postconditionHashes: sortedHashes(input.postconditionHashes, `${context}.postconditionHashes`),
    timeInForce: variant(GRAPH_LEG_TIME_IN_FORCE, input.timeInForce, `${context}.timeInForce`),
    legExpiryValue,
  });
}

/** Kahn's algorithm by level; a leg left unplaced sits on a cycle. */
function stagesOf(legIds: readonly ProtocolId[], edges: readonly { fromLegId: ProtocolId; toLegId: ProtocolId }[], context: string): readonly (readonly ProtocolId[])[] {
  const indegree = new Map<ProtocolId, number>(legIds.map((id) => [id, 0]));
  const next = new Map<ProtocolId, ProtocolId[]>();
  for (const edge of edges) {
    indegree.set(edge.toLegId, (indegree.get(edge.toLegId) ?? 0) + 1);
    next.set(edge.fromLegId, [...(next.get(edge.fromLegId) ?? []), edge.toLegId]);
  }
  const stages: ProtocolId[][] = [];
  let ready = legIds.filter((id) => indegree.get(id) === 0);
  let placed = 0;
  while (ready.length > 0) {
    const stage = [...ready].sort();
    stages.push(stage);
    placed += stage.length;
    const upcoming: ProtocolId[] = [];
    for (const id of stage) {
      for (const target of next.get(id) ?? []) {
        const remaining = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, remaining);
        if (remaining === 0) upcoming.push(target);
      }
    }
    ready = upcoming;
  }
  if (placed !== legIds.length) throw new MalformedInputError(`${context}.dependencyEdges`, 'the dependency graph has a cycle');
  return Object.freeze(stages.map((stage) => Object.freeze(stage)));
}

/**
 * Validates a package graph's structure. It is a directed acyclic graph of typed legs; every edge
 * names two distinct known legs; a leg belongs to at most one execution group; no leg outlives
 * the package; and every leg that can be left partly done, because it is not inside an
 * all-or-none group, carries a signed completion or rollback slot within its own quantity. The
 * recovery slots together never promise more than the signed recovery cost bound.
 */
export function packageGraph(input: PackageGraphInput, context = 'packageGraph'): PackageGraph {
  object(input, context);
  if (input.graphVersion !== PACKAGE_GRAPH_VERSION) throw new MalformedInputError(`${context}.graphVersion`, `version must equal ${PACKAGE_GRAPH_VERSION}`);
  const expiryUnit = variant(EXPIRY_UNIT, input.expiryUnit, `${context}.expiryUnit`);
  const packageExpiryValue = unsigned(input.packageExpiryValue, U64_BITS, `${context}.packageExpiryValue`);
  const legs = list(input.legs, MAX_GRAPH_LEGS, `${context}.legs`, false)
    .map((leg, index) => checkedLeg(leg, packageExpiryValue, `${context}.legs[${index}]`))
    .sort((left, right) => (left.legId < right.legId ? -1 : left.legId > right.legId ? 1 : 0));
  const legIds = legs.map((leg) => leg.legId);
  for (let index = 1; index < legIds.length; index += 1) if (legIds[index - 1] === legIds[index]) throw new DuplicateElementError(`${context}.legs`, 'leg ids repeat');
  const known = new Set<string>(legIds);
  const edges = list(input.dependencyEdges, MAX_GRAPH_EDGES, `${context}.dependencyEdges`)
    .map((edge, index) => {
      const at = `${context}.dependencyEdges[${index}]`;
      object(edge, at);
      const fromLegId = protocolId(edge.fromLegId, `${at}.fromLegId`);
      const toLegId = protocolId(edge.toLegId, `${at}.toLegId`);
      if (!known.has(fromLegId) || !known.has(toLegId)) throw new MalformedInputError(at, 'an edge names an unknown leg');
      if (fromLegId === toLegId) throw new MalformedInputError(at, 'a leg cannot depend on itself');
      return Object.freeze({ fromLegId, toLegId });
    })
    .sort((left, right) => (left.fromLegId === right.fromLegId ? (left.toLegId < right.toLegId ? -1 : 1) : left.fromLegId < right.fromLegId ? -1 : 1));
  for (let index = 1; index < edges.length; index += 1) {
    const previous = edges[index - 1] as { fromLegId: string; toLegId: string };
    const current = edges[index] as { fromLegId: string; toLegId: string };
    if (previous.fromLegId === current.fromLegId && previous.toLegId === current.toLegId) throw new DuplicateElementError(`${context}.dependencyEdges`, 'edges repeat');
  }
  const stages = stagesOf(legIds, edges, context);
  const grouped = new Set<string>();
  const groups = list(input.executionGroups, MAX_GRAPH_LEGS, `${context}.executionGroups`)
    .map((group, index) => {
      const at = `${context}.executionGroups[${index}]`;
      object(group, at);
      const kind = variant(EXECUTION_GROUP_KIND, group.kind, `${at}.kind`);
      const members = sortedIds(group.legIds, MAX_GRAPH_LEGS, `${at}.legIds`, false);
      for (const legId of members) {
        if (!known.has(legId)) throw new MalformedInputError(`${at}.legIds`, 'a group names an unknown leg');
        if (grouped.has(legId)) throw new DuplicateElementError(`${at}.legIds`, 'a leg belongs to two groups');
        grouped.add(legId);
      }
      if ((kind === 'BOUNDED_PARTIAL') !== (group.maximumResidualQuoteAtoms !== undefined)) {
        throw new MalformedInputError(`${at}.maximumResidualQuoteAtoms`, 'only a bounded-partial group carries a residual bound, and it must');
      }
      if (kind !== 'BOUNDED_PARTIAL') {
        for (const legId of members) {
          const leg = legs.find((entry) => entry.legId === legId) as CheckedLeg;
          if (leg.minimumQuantityAtoms !== leg.quantityAtoms) throw new MalformedInputError(`${at}.legIds`, `leg ${legId} is not exact inside an exact group`);
        }
      }
      return Object.freeze({
        groupId: protocolId(group.groupId, `${at}.groupId`),
        kind,
        legIds: members,
        ...(group.maximumResidualQuoteAtoms === undefined ? {} : { maximumResidualQuoteAtoms: unsigned(group.maximumResidualQuoteAtoms, U128_BITS, `${at}.maximumResidualQuoteAtoms`) }),
      });
    })
    .sort((left, right) => (left.groupId < right.groupId ? -1 : left.groupId > right.groupId ? 1 : 0));
  for (let index = 1; index < groups.length; index += 1) {
    if ((groups[index - 1] as { groupId: string }).groupId === (groups[index] as { groupId: string }).groupId) throw new DuplicateElementError(`${context}.executionGroups`, 'group ids repeat');
  }
  const maximumRecoveryCostQuoteAtoms = unsigned(input.maximumRecoveryCostQuoteAtoms, U128_BITS, `${context}.maximumRecoveryCostQuoteAtoms`);
  let promised = 0n;
  const slotKeys = new Set<string>();
  const slots = list(input.recoverySlots, MAX_GRAPH_LEGS * 2, `${context}.recoverySlots`)
    .map((slot, index) => {
      const at = `${context}.recoverySlots[${index}]`;
      object(slot, at);
      const legId = protocolId(slot.legId, `${at}.legId`);
      const leg = legs.find((entry) => entry.legId === legId);
      if (leg === undefined) throw new MalformedInputError(`${at}.legId`, 'a recovery slot names an unknown leg');
      const action = variant(GRAPH_RECOVERY_ACTION, slot.action, `${at}.action`);
      if (slotKeys.has(`${legId}/${action}`)) throw new DuplicateElementError(at, 'a leg has two slots for one action');
      slotKeys.add(`${legId}/${action}`);
      const maximumQuantityAtoms = unsigned(slot.maximumQuantityAtoms, U128_BITS, `${at}.maximumQuantityAtoms`);
      if (maximumQuantityAtoms === 0n || maximumQuantityAtoms > leg.quantityAtoms) {
        throw new MalformedInputError(`${at}.maximumQuantityAtoms`, 'a recovery action is bounded by its leg and cannot exceed it');
      }
      const maximumCostQuoteAtoms = unsigned(slot.maximumCostQuoteAtoms, U128_BITS, `${at}.maximumCostQuoteAtoms`);
      promised += maximumCostQuoteAtoms;
      return Object.freeze({ legId, action, maximumQuantityAtoms, maximumCostQuoteAtoms });
    })
    .sort((left, right) => (left.legId === right.legId ? GRAPH_RECOVERY_ACTION[left.action] - GRAPH_RECOVERY_ACTION[right.action] : left.legId < right.legId ? -1 : 1));
  if (promised > maximumRecoveryCostQuoteAtoms) throw new MalformedInputError(`${context}.recoverySlots`, 'recovery slots promise more than the signed recovery cost bound');
  // Only a graph that is one all-or-none group has no partial state; otherwise any leg can be
  // left done while another is not, so every leg needs a signed way to complete or roll back.
  const oneAtomicGroup = groups.length === 1 && groups[0]?.kind === 'ALL_OR_NONE' && groups[0].legIds.length === legs.length;
  if (!oneAtomicGroup) {
    for (const leg of legs) {
      if (!slots.some((slot) => slot.legId === leg.legId)) {
        throw new MalformedInputError(`${context}.recoverySlots`, `leg ${leg.legId} can be left partly done with no signed completion or rollback`);
      }
    }
  }
  const policies = input.policyHashes;
  object(policies, `${context}.policyHashes`);
  return Object.freeze({
    graphVersion: PACKAGE_GRAPH_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    templateId: protocolId(input.templateId, `${context}.templateId`),
    templateVersion: nonzeroVersion(input.templateVersion, `${context}.templateVersion`),
    packageTemplateManifestHash: commitmentHash(input.packageTemplateManifestHash, `${context}.packageTemplateManifestHash`),
    seriesId: protocolId(input.seriesId, `${context}.seriesId`),
    seriesVersion: nonzeroVersion(input.seriesVersion, `${context}.seriesVersion`),
    seriesManifestHash: manifestHash(input.seriesManifestHash, `${context}.seriesManifestHash`),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    executionClassVersion: nonzeroVersion(input.executionClassVersion, `${context}.executionClassVersion`),
    executionClassManifestHash: manifestHash(input.executionClassManifestHash, `${context}.executionClassManifestHash`),
    lifecycleAction: variant(GRAPH_LIFECYCLE_ACTION, input.lifecycleAction, `${context}.lifecycleAction`),
    owner: protocolId(input.owner, `${context}.owner`),
    strategyAccountRefs: sortedIds(input.strategyAccountRefs, 16, `${context}.strategyAccountRefs`, false),
    legs: Object.freeze(legs),
    dependencyEdges: Object.freeze(edges),
    executionGroups: Object.freeze(groups),
    settlementClass: variant(SETTLEMENT_CLASS, input.settlementClass, `${context}.settlementClass`),
    policyHashes: Object.freeze({
      netting: commitmentHash(policies.netting, `${context}.policyHashes.netting`),
      privacy: commitmentHash(policies.privacy, `${context}.policyHashes.privacy`),
      solver: commitmentHash(policies.solver, `${context}.policyHashes.solver`),
      delivery: commitmentHash(policies.delivery, `${context}.policyHashes.delivery`),
      resource: commitmentHash(policies.resource, `${context}.policyHashes.resource`),
      portfolioRiskLimits: commitmentHash(policies.portfolioRiskLimits, `${context}.policyHashes.portfolioRiskLimits`),
    }),
    ...(input.builderAttributionHash === undefined ? {} : { builderAttributionHash: commitmentHash(input.builderAttributionHash, `${context}.builderAttributionHash`) }),
    recoverySlots: Object.freeze(slots),
    maximumRecoveryCostQuoteAtoms,
    expiryUnit,
    packageExpiryValue,
    nonce: unsigned(input.nonce, U64_BITS, `${context}.nonce`),
    stages,
  });
}

function encodeLeg(writer: CanonicalWriter, leg: CheckedLeg): void {
  encodeProtocolId(writer, leg.legId, 'legId');
  writer.writeEnum(LEG_FAMILY, leg.legFamily, 'legFamily');
  encodeProtocolId(writer, leg.legTypeId, 'legTypeId');
  encodeDomainRef(writer, leg.domain);
  encodeAdapterRef(writer, leg.adapter);
  encodeVersionedManifestRef(writer, leg.venue);
  encodeVersionedManifestRef(writer, leg.market);
  writer.writeArray(leg.assets, (inner, asset) => encodeAssetRef(inner, asset), 'assets');
  writer.writeEnum(GRAPH_LEG_SIDE, leg.side, 'side');
  encodeAssetRef(writer, leg.quantityAsset);
  writer.writeU128(leg.quantityAtoms, 'quantityAtoms');
  writer.writeU128(leg.minimumQuantityAtoms, 'minimumQuantityAtoms');
  writer.writeOptional(leg.limitPrice, (inner, value) => encodeExactPrice(inner, value), 'limitPrice');
  writer.writeU128(leg.maximumFeeQuoteAtoms, 'maximumFeeQuoteAtoms');
  writer.writeArray(leg.preconditionHashes, (inner, value) => encodeCommitmentHash(inner, value, 'precondition'), 'preconditionHashes');
  writer.writeArray(leg.postconditionHashes, (inner, value) => encodeCommitmentHash(inner, value, 'postcondition'), 'postconditionHashes');
  writer.writeEnum(GRAPH_LEG_TIME_IN_FORCE, leg.timeInForce, 'timeInForce');
  writer.writeU64(leg.legExpiryValue, 'legExpiryValue');
}

export function packageGraphBytes(input: PackageGraphInput): Uint8Array {
  const graph = packageGraph(input);
  return canonicalBytes((writer) => {
    writer.writeU32(graph.graphVersion, 'graphVersion');
    encodeProtocolId(writer, graph.environment, 'environment');
    encodeProtocolId(writer, graph.templateId, 'templateId');
    writer.writeU32(graph.templateVersion, 'templateVersion');
    encodeCommitmentHash(writer, graph.packageTemplateManifestHash, 'packageTemplateManifestHash');
    encodeProtocolId(writer, graph.seriesId, 'seriesId');
    writer.writeU32(graph.seriesVersion, 'seriesVersion');
    encodeManifestHash(writer, graph.seriesManifestHash, 'seriesManifestHash');
    encodeProtocolId(writer, graph.executionClassId, 'executionClassId');
    writer.writeU32(graph.executionClassVersion, 'executionClassVersion');
    encodeManifestHash(writer, graph.executionClassManifestHash, 'executionClassManifestHash');
    writer.writeEnum(GRAPH_LIFECYCLE_ACTION, graph.lifecycleAction, 'lifecycleAction');
    encodeProtocolId(writer, graph.owner, 'owner');
    writer.writeArray(graph.strategyAccountRefs, (inner, value) => encodeProtocolId(inner, value, 'strategyAccountRef'), 'strategyAccountRefs');
    writer.writeArray(graph.legs, encodeLeg, 'legs');
    writer.writeArray(graph.dependencyEdges, (inner, edge) => {
      encodeProtocolId(inner, edge.fromLegId, 'fromLegId');
      encodeProtocolId(inner, edge.toLegId, 'toLegId');
    }, 'dependencyEdges');
    writer.writeArray(graph.executionGroups, (inner, group) => {
      encodeProtocolId(inner, group.groupId, 'groupId');
      inner.writeEnum(EXECUTION_GROUP_KIND, group.kind, 'kind');
      inner.writeArray(group.legIds, (member, value) => encodeProtocolId(member, value, 'legId'), 'legIds');
      inner.writeOptional(group.maximumResidualQuoteAtoms, (bound, value) => bound.writeU128(value, 'maximumResidualQuoteAtoms'), 'maximumResidualQuoteAtoms');
    }, 'executionGroups');
    writer.writeEnum(SETTLEMENT_CLASS, graph.settlementClass, 'settlementClass');
    for (const name of ['netting', 'privacy', 'solver', 'delivery', 'resource', 'portfolioRiskLimits'] as const) {
      encodeCommitmentHash(writer, graph.policyHashes[name], `policyHashes.${name}`);
    }
    writer.writeOptional(graph.builderAttributionHash, (inner, value) => encodeCommitmentHash(inner, value, 'builderAttributionHash'), 'builderAttributionHash');
    writer.writeArray(graph.recoverySlots, (inner, slot) => {
      encodeProtocolId(inner, slot.legId, 'legId');
      inner.writeEnum(GRAPH_RECOVERY_ACTION, slot.action, 'action');
      inner.writeU128(slot.maximumQuantityAtoms, 'maximumQuantityAtoms');
      inner.writeU128(slot.maximumCostQuoteAtoms, 'maximumCostQuoteAtoms');
    }, 'recoverySlots');
    writer.writeU128(graph.maximumRecoveryCostQuoteAtoms, 'maximumRecoveryCostQuoteAtoms');
    writer.writeEnum(EXPIRY_UNIT, graph.expiryUnit, 'expiryUnit');
    writer.writeU64(graph.packageExpiryValue, 'packageExpiryValue');
    writer.writeU64(graph.nonce, 'nonce');
  });
}

export function packageGraphHash(input: PackageGraphInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.PACKAGE_GRAPH, packageGraphBytes(input)), 'packageGraphHash');
}

// ------------------------------------------------------------------ compilation

export interface DomainResourceLimit {
  readonly domainId: string;
  /** The most leg actions one transaction or venue action group may carry in this domain. */
  readonly maximumActionsPerTransaction: number;
}

export interface PackageGraphCompileContext {
  readonly templateManifest: PackageTemplateManifestInput;
  readonly activeRegistryRecords: readonly DomainRegistryRecordInput[];
  readonly resourceLimits: readonly DomainResourceLimit[];
  readonly currentTime: { readonly unit: ExpiryUnit; readonly value: bigint };
}

export type PackageGraphRejection =
  | 'EXPIRED'
  | 'TEMPLATE_MISMATCH'
  | 'LEG_TYPE_NOT_IN_TEMPLATE'
  | 'TOO_MANY_LEGS'
  | 'DOMAIN_NOT_IN_TEMPLATE'
  | 'SETTLEMENT_CLASS_UNSUPPORTED'
  | 'ADAPTER_NOT_IN_TEMPLATE'
  | 'ADAPTER_NOT_ACTIVE'
  | 'ASSET_NOT_ACTIVE'
  | 'VENUE_NOT_ACTIVE'
  | 'MARKET_NOT_ACTIVE'
  | 'ROLLBACK_BOUNDARY_MISSING'
  | 'ATOMIC_CLASS_NEEDS_ONE_ATOMIC_GROUP'
  | 'RESOURCE_LIMIT_UNKNOWN'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'PARTIAL_STATE_UNRECOVERABLE';

export interface PackageResourceGroupPlan {
  readonly groupId: ProtocolId;
  readonly domainId: ProtocolId;
  readonly legIds: readonly ProtocolId[];
  readonly actionCount: number;
  readonly maximumActionsPerTransaction: number;
}

export interface CompiledPackageGraph {
  readonly compiled: true;
  readonly graphHash: CommitmentHash;
  readonly stages: readonly (readonly ProtocolId[])[];
  readonly groups: readonly PackageResourceGroupPlan[];
  /** Legs outside any group each settle on their own, each with its recovery slots. */
  readonly ungroupedLegIds: readonly ProtocolId[];
  readonly worstCaseRecoveryCostQuoteAtoms: bigint;
}

type RegistrySubject = { readonly subjectId: string; readonly subjectManifestVersion: number; readonly subjectManifestHash: Uint8Array };

function refMatcher(ref: { subjectId: string; manifestVersion: number; manifestHash: Uint8Array }): (record: RegistrySubject) => boolean {
  return (record) => record.subjectId === ref.subjectId && record.subjectManifestVersion === ref.manifestVersion && compareBytes(record.subjectManifestHash, ref.manifestHash) === 0;
}

function permits(state: string, action: GraphLifecycleAction): boolean {
  if (state === 'ACTIVE') return true;
  return (action === 'EXIT' || action === 'EMERGENCY_UNWIND') && (state === 'ENTRY_PAUSED' || state === 'EXIT_ONLY');
}

/**
 * Compiles a validated graph against the template it binds, the domain registry records active
 * now, and each domain's resource limits. Every leg must be a template leg type on a template
 * domain through a template adapter whose adapter, assets, venue, and market are active for the
 * template and settlement class. An all-or-none group must sit inside one domain, where a rollback
 * boundary exists, and fit one transaction; an atomic settlement class needs every leg in one
 * such group. A graph that does not fit is rejected, never relabeled.
 */
export function compilePackageGraph(
  graphInput: PackageGraphInput,
  context: PackageGraphCompileContext,
): CompiledPackageGraph | { readonly compiled: false; readonly reasons: readonly PackageGraphRejection[] } {
  const graph = packageGraph(graphInput);
  object(context, 'compilePackageGraph.context');
  const template = packageTemplateManifest(context.templateManifest, 'compilePackageGraph.templateManifest');
  const records = list(context.activeRegistryRecords, 1_024, 'compilePackageGraph.activeRegistryRecords').map((record, index) =>
    domainRegistryRecord(record, `compilePackageGraph.activeRegistryRecords[${index}]`),
  );
  const reasons = new Set<PackageGraphRejection>();
  const now = context.currentTime;
  if (now.unit !== graph.expiryUnit || unsigned(now.value, U64_BITS, 'compilePackageGraph.currentTime.value') >= graph.packageExpiryValue) reasons.add('EXPIRED');
  if (
    compareBytes(packageTemplateManifestHash(context.templateManifest), graph.packageTemplateManifestHash) !== 0 ||
    template.templateId !== graph.templateId ||
    template.templateVersion !== graph.templateVersion ||
    template.environment !== graph.environment
  ) {
    reasons.add('TEMPLATE_MISMATCH');
  }
  if (!template.supportedSettlementClasses.includes(graph.settlementClass)) reasons.add('SETTLEMENT_CLASS_UNSUPPORTED');
  if (graph.legs.length > template.legCount) reasons.add('TOO_MANY_LEGS');
  const allowedAdapters = new Set<string>([
    ...template.allowedSpotAdapterIds,
    ...template.allowedPerpAdapterIds,
    ...(template.allowedAdapterIds ?? []),
  ]);
  const active = (kind: string, leg: CheckedLeg, subject: (record: RegistrySubject) => boolean) =>
    records.some(
      (record) =>
        record.recordKind === kind &&
        record.environment === graph.environment &&
        record.domain.domainId === leg.domain.domainId &&
        compareBytes(record.domain.domainManifestHash, leg.domain.domainManifestHash) === 0 &&
        subject(record) &&
        permits(record.registryState, graph.lifecycleAction) &&
        record.activationUnit === now.unit &&
        record.activationValue <= now.value &&
        record.allowedSettlementClasses.includes(graph.settlementClass) &&
        record.allowedTemplates.some(
          (allowed) => allowed.templateId === graph.templateId && allowed.templateVersion === graph.templateVersion && compareBytes(allowed.packageTemplateManifestHash, graph.packageTemplateManifestHash) === 0,
        ),
    );
  for (const leg of graph.legs) {
    if (!template.legTypes.includes(leg.legTypeId)) reasons.add('LEG_TYPE_NOT_IN_TEMPLATE');
    if (!template.supportedDomains.some((domain) => domain.domainId === leg.domain.domainId && compareBytes(domain.domainManifestHash, leg.domain.domainManifestHash) === 0)) {
      reasons.add('DOMAIN_NOT_IN_TEMPLATE');
    }
    if (!allowedAdapters.has(leg.adapter.adapterId)) reasons.add('ADAPTER_NOT_IN_TEMPLATE');
    if (!active('ADAPTER', leg, refMatcher({ subjectId: leg.adapter.adapterId, manifestVersion: leg.adapter.adapterManifestVersion, manifestHash: leg.adapter.adapterManifestHash }))) {
      reasons.add('ADAPTER_NOT_ACTIVE');
    }
    for (const asset of leg.assets) {
      // An asset reference carries its id and manifest hash; the registry holds its version.
      if (!active('ASSET', leg, (record) => record.subjectId === asset.assetId && compareBytes(record.subjectManifestHash, asset.assetManifestHash) === 0)) reasons.add('ASSET_NOT_ACTIVE');
    }
    if (!active('VENUE', leg, refMatcher(leg.venue))) reasons.add('VENUE_NOT_ACTIVE');
    if (!active('MARKET', leg, refMatcher(leg.market))) reasons.add('MARKET_NOT_ACTIVE');
  }
  const limits = new Map<string, number>();
  for (const [index, limit] of list(context.resourceLimits, 64, 'compilePackageGraph.resourceLimits').entries()) {
    object(limit, `compilePackageGraph.resourceLimits[${index}]`);
    if (!Number.isSafeInteger(limit.maximumActionsPerTransaction) || limit.maximumActionsPerTransaction < 1) {
      throw new MalformedInputError(`compilePackageGraph.resourceLimits[${index}]`, 'a domain allows at least one action per transaction');
    }
    limits.set(protocolId(limit.domainId, `compilePackageGraph.resourceLimits[${index}].domainId`), limit.maximumActionsPerTransaction);
  }
  const plans: PackageResourceGroupPlan[] = [];
  for (const group of graph.executionGroups) {
    const members = group.legIds.map((legId) => graph.legs.find((leg) => leg.legId === legId) as CheckedLeg);
    const domains = new Set(members.map((leg) => leg.domain.domainId));
    const [domainId] = [...domains];
    if (group.kind === 'ALL_OR_NONE' && domains.size !== 1) {
      reasons.add('ROLLBACK_BOUNDARY_MISSING');
      continue;
    }
    if (domains.size !== 1) continue;
    const limit = limits.get(domainId as string);
    if (limit === undefined) {
      reasons.add('RESOURCE_LIMIT_UNKNOWN');
      continue;
    }
    if (group.kind === 'ALL_OR_NONE' && members.length > limit) reasons.add('RESOURCE_LIMIT_EXCEEDED');
    plans.push(Object.freeze({ groupId: group.groupId, domainId: domainId as ProtocolId, legIds: group.legIds, actionCount: members.length, maximumActionsPerTransaction: limit }));
  }
  if (simulatePackageGraphFailures(graphInput).some((point) => !point.recoverable)) reasons.add('PARTIAL_STATE_UNRECOVERABLE');
  if (graph.settlementClass === 'ATOMIC_POSTCONDITION') {
    const atomic = graph.executionGroups.filter((group) => group.kind === 'ALL_OR_NONE');
    if (atomic.length !== 1 || atomic[0]?.legIds.length !== graph.legs.length) reasons.add('ATOMIC_CLASS_NEEDS_ONE_ATOMIC_GROUP');
  }
  if (reasons.size > 0) return Object.freeze({ compiled: false as const, reasons: Object.freeze([...reasons].sort()) });
  const grouped = new Set<string>(graph.executionGroups.flatMap((group) => group.legIds));
  return Object.freeze({
    compiled: true as const,
    graphHash: packageGraphHash(graphInput),
    stages: graph.stages,
    groups: Object.freeze(plans),
    ungroupedLegIds: Object.freeze(graph.legs.map((leg) => leg.legId).filter((legId) => !grouped.has(legId))),
    worstCaseRecoveryCostQuoteAtoms: graph.recoverySlots.reduce((sum, slot) => sum + slot.maximumCostQuoteAtoms, 0n),
  });
}

export interface GraphFailurePoint {
  /** The stage that stopped part way: stages before it settled, stages after it did not start. */
  readonly stage: number;
  readonly settledBeforeLegIds: readonly ProtocolId[];
  /** Any subset of these may have settled when the stage stopped. */
  readonly stageLegIds: readonly ProtocolId[];
  readonly notStartedLegIds: readonly ProtocolId[];
  /** Rollback slots of legs that may have settled and completion slots of legs that may not have. */
  readonly recoverySlots: readonly { readonly legId: ProtocolId; readonly action: GraphRecoveryAction; readonly maximumCostQuoteAtoms: bigint }[];
  readonly worstCaseRecoveryCostQuoteAtoms: bigint;
  /** True when, whatever subset of the stage settled, everything settled can roll back or everything else can complete. */
  readonly recoverable: boolean;
}

/**
 * Walks every stage at which a staged graph can stop part way, under stage-by-stage execution:
 * the legs of earlier stages settled, any subset of the stage's own legs settled, and no later leg
 * started. A state is recoverable when every settled leg has a signed rollback or every unsettled
 * leg a signed completion. Recoverability is decided exactly over every subset of the stage in
 * closed form, so no partial state is missed. A single all-or-none graph has no partial state.
 * This is a deterministic walk over the signed graph, not a forecast of venue fills.
 */
export function simulatePackageGraphFailures(graphInput: PackageGraphInput): readonly GraphFailurePoint[] {
  const graph = packageGraph(graphInput);
  const oneAtomicGroup = graph.executionGroups.length === 1 && graph.executionGroups[0]?.kind === 'ALL_OR_NONE' && graph.executionGroups[0].legIds.length === graph.legs.length;
  if (oneAtomicGroup) return Object.freeze([]);
  const canRollBack = new Set<string>(graph.recoverySlots.filter((slot) => slot.action === 'ROLLBACK').map((slot) => slot.legId));
  const canComplete = new Set<string>(graph.recoverySlots.filter((slot) => slot.action === 'COMPLETE').map((slot) => slot.legId));
  const points: GraphFailurePoint[] = [];
  for (let index = 0; index < graph.stages.length; index += 1) {
    const before = graph.stages.slice(0, index).flat();
    const stage = [...(graph.stages[index] as readonly ProtocolId[])];
    const after = graph.stages.slice(index + 1).flat();
    // Only a state with something settled and something not is partial.
    if (before.length === 0 && stage.length === 1) continue;
    const beforeRolls = before.every((legId) => canRollBack.has(legId));
    const afterCompletes = after.every((legId) => canComplete.has(legId));
    const notRolling = stage.filter((legId) => !canRollBack.has(legId));
    const notCompleting = stage.filter((legId) => !canComplete.has(legId));
    let unrecoverable: boolean;
    if (!beforeRolls) {
      // Nothing settled can roll back, so every leg still open must complete, from any subset.
      unrecoverable = notCompleting.length > 0 || !afterCompletes;
    } else if (!afterCompletes) {
      // Later legs cannot all complete, so whatever settled in this stage must roll back.
      unrecoverable = notRolling.length > 0;
    } else {
      // Stuck only when one leg that cannot roll back settled while another that cannot complete did not.
      unrecoverable = notRolling.some((settled) => notCompleting.some((open) => open !== settled));
    }
    const slots = graph.recoverySlots.filter(
      (slot) => (slot.action === 'ROLLBACK' && (before.includes(slot.legId) || stage.includes(slot.legId))) || (slot.action === 'COMPLETE' && (stage.includes(slot.legId) || after.includes(slot.legId))),
    );
    points.push(Object.freeze({
      stage: index,
      settledBeforeLegIds: Object.freeze([...before].sort()),
      stageLegIds: Object.freeze(stage.sort()),
      notStartedLegIds: Object.freeze([...after].sort()),
      recoverySlots: Object.freeze(slots.map((slot) => Object.freeze({ legId: slot.legId, action: slot.action, maximumCostQuoteAtoms: slot.maximumCostQuoteAtoms }))),
      worstCaseRecoveryCostQuoteAtoms: slots.reduce((sum, slot) => sum + slot.maximumCostQuoteAtoms, 0n),
      recoverable: !unrecoverable,
    }));
  }
  return Object.freeze(points);
}
