import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { compareBytes, toHex } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import {
  enumDiscriminant,
  QUOTE_MODE,
  SETTLEMENT_CLASS,
  type EnumTable,
  type QuoteMode,
  type SettlementClass,
  type SolverSignatureScheme,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { PACKAGE_BOOK_SIDE, type PackageBookSide } from './package-matching.js';
import { assetRef, encodeAssetRef, encodeDomainRef, encodeProtocolId, protocolId, type AssetRef, type DomainRef, type ProtocolId } from './primitives.js';
import {
  authorizeSolverQuote,
  solverCapabilityManifest,
  type SolverAuthorizationRejection,
  type SolverCapabilityManifestInput,
} from './solver-capability.js';

export const MAKER_QUOTE_SURFACE_VERSION = 1;
export const PERFORMANCE_BOND_VERSION = 1;
export const RFQ_MAX_RESPONSES = 64;

const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;

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

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

// A non-narrowing check: Array.isArray would widen readonly element types to any.
function requireArray(value: unknown, context: string): void {
  if (!Array.isArray(value)) throw new MalformedInputError(context, 'expected an array');
}

function bool(value: boolean, context: string): boolean {
  if (typeof value !== 'boolean') throw new MalformedInputError(context, 'expected a boolean');
  return value;
}

// ------------------------------------------------------------------ multi-dealer RFQ

export type RfqExclusionReason =
  | SolverAuthorizationRejection
  | 'NOT_INVITED'
  | 'MANIFEST_UNKNOWN'
  | 'LATE_RESPONSE'
  | 'QUOTE_EXPIRED'
  | 'DUPLICATE_SOLVER_RESPONSE'
  | 'CAPACITY_UNAVAILABLE';

export interface RfqRequest {
  readonly environment: string;
  readonly orderHash: Uint8Array | string;
  readonly domain: DomainRef;
  readonly templateId: string;
  readonly marketId: string;
  readonly notionalAtoms: bigint;
  readonly invitedSolverIds: readonly string[];
  readonly responseDeadlineValue: bigint;
  readonly atValue: bigint;
}

export interface RfqResponse {
  readonly solverId: string;
  readonly quoteHash: Uint8Array | string;
  readonly quoteMode: QuoteMode;
  readonly settlementClass: SettlementClass;
  /** Residual and quantity-policy class; quotes compare automatically only inside one class. */
  readonly riskClassId: string;
  readonly scheme: SolverSignatureScheme;
  readonly verificationKey: Uint8Array;
  /** Fee-complete net package outcome in quote atoms; higher is better for the requester. */
  readonly netOutcomeAtoms: bigint;
  readonly validUntilValue: bigint;
  readonly receivedAtValue: bigint;
}

export interface RfqSolverCapacity {
  readonly solverId: string;
  readonly state: 'ACTIVE' | 'REDUCE_ONLY';
  readonly remainingAtoms: bigint;
}

export interface RfqRankedResponse {
  readonly rank: number;
  readonly solverId: ProtocolId;
  readonly commonControlGroupId: ProtocolId;
  readonly quoteHash: CommitmentHash;
  readonly quoteMode: QuoteMode;
  readonly netOutcomeAtoms: bigint;
  readonly receivedAtValue: bigint;
}

export interface RfqComparisonGroup {
  readonly settlementClass: SettlementClass;
  readonly riskClassId: ProtocolId;
  readonly ranked: readonly RfqRankedResponse[];
}

export interface RfqExclusion {
  readonly solverId: ProtocolId;
  readonly quoteHash: CommitmentHash;
  readonly reason: RfqExclusionReason;
}

export interface RfqDecision {
  readonly orderHash: CommitmentHash;
  readonly groups: readonly RfqComparisonGroup[];
  readonly excluded: readonly RfqExclusion[];
  readonly independentOrganizations: number;
  readonly decisionHash: CommitmentHash;
}

// Firmer quote modes win exact ties; they never outrank a better net outcome.
const FIRMNESS: Readonly<Record<QuoteMode, number>> = Object.freeze({
  FIRM_ONCHAIN: 0,
  FIRM_BONDED: 1,
  FIRM_SIMULATED: 2,
  EXECUTION_COMMITMENT: 3,
  IMPLIED: 4,
});
const FIRM_MODES: ReadonlySet<QuoteMode> = new Set(['FIRM_ONCHAIN', 'FIRM_BONDED', 'FIRM_SIMULATED']);

/**
 * Collects multi-dealer responses into a replayable decision. Every response is either ranked
 * inside its settlement and risk class or excluded with one deterministic reason. Responses in
 * different classes are never ranked against each other.
 */
export function decideRfq(
  request: RfqRequest,
  responses: readonly RfqResponse[],
  manifests: readonly SolverCapabilityManifestInput[],
  capacities: readonly RfqSolverCapacity[],
): RfqDecision {
  object(request, 'decideRfq.request');
  const orderHash = commitmentHash(request.orderHash, 'decideRfq.request.orderHash');
  const deadline = unsigned(request.responseDeadlineValue, U64_BITS, 'decideRfq.request.responseDeadlineValue');
  const now = unsigned(request.atValue, U64_BITS, 'decideRfq.request.atValue');
  requireArray(request.invitedSolverIds, 'decideRfq.request.invitedSolverIds');
  requireArray(responses, 'decideRfq.responses');
  requireArray(manifests, 'decideRfq.manifests');
  requireArray(capacities, 'decideRfq.capacities');
  if (responses.length > RFQ_MAX_RESPONSES) throw new MalformedInputError('decideRfq.responses', 'too many responses');
  const invited = new Set(request.invitedSolverIds.map((value) => protocolId(value, 'decideRfq.invitedSolverIds')));
  const byId = new Map<string, ReturnType<typeof solverCapabilityManifest>>();
  for (const input of manifests) {
    const manifest = solverCapabilityManifest(input);
    if (byId.has(manifest.solverId)) throw new DuplicateElementError('decideRfq.manifests', 'two manifests for one solver');
    byId.set(manifest.solverId, manifest);
  }
  const capacityById = new Map(capacities.map((value) => [protocolId(value.solverId, 'decideRfq.capacities'), value]));

  const checked = responses
    .map((response, index) => {
      const at = `decideRfq.responses[${index}]`;
      object(response, at);
      return {
        response,
        solverId: protocolId(response.solverId, `${at}.solverId`),
        quoteHash: commitmentHash(response.quoteHash, `${at}.quoteHash`),
        quoteMode: variant(QUOTE_MODE, response.quoteMode, `${at}.quoteMode`),
        settlementClass: variant(SETTLEMENT_CLASS, response.settlementClass, `${at}.settlementClass`),
        riskClassId: protocolId(response.riskClassId, `${at}.riskClassId`),
        netOutcomeAtoms: signed(response.netOutcomeAtoms, `${at}.netOutcomeAtoms`),
        validUntilValue: unsigned(response.validUntilValue, U64_BITS, `${at}.validUntilValue`),
        receivedAtValue: unsigned(response.receivedAtValue, U64_BITS, `${at}.receivedAtValue`),
      };
    })
    // Arrival order decides which of a solver's responses counts.
    .sort((left, right) =>
      left.receivedAtValue !== right.receivedAtValue
        ? left.receivedAtValue < right.receivedAtValue ? -1 : 1
        : compareBytes(left.quoteHash, right.quoteHash),
    );

  const excluded: RfqExclusion[] = [];
  const eligible: (typeof checked[number] & { commonControlGroupId: ProtocolId })[] = [];
  const answered = new Set<string>();
  for (const item of checked) {
    const exclude = (reason: RfqExclusionReason) =>
      excluded.push(Object.freeze({ solverId: item.solverId, quoteHash: item.quoteHash, reason }));
    if (!invited.has(item.solverId)) { exclude('NOT_INVITED'); continue; }
    if (answered.has(item.solverId)) { exclude('DUPLICATE_SOLVER_RESPONSE'); continue; }
    answered.add(item.solverId);
    if (item.receivedAtValue >= deadline) { exclude('LATE_RESPONSE'); continue; }
    if (item.validUntilValue <= now) { exclude('QUOTE_EXPIRED'); continue; }
    const manifest = byId.get(item.solverId);
    if (manifest === undefined) { exclude('MANIFEST_UNKNOWN'); continue; }
    const authorization = authorizeSolverQuote(manifest as SolverCapabilityManifestInput, {
      environment: request.environment,
      domain: request.domain,
      templateId: request.templateId,
      quoteMode: item.quoteMode,
      marketId: request.marketId,
      notionalAtoms: request.notionalAtoms,
      scheme: item.response.scheme,
      verificationKey: item.response.verificationKey,
      atValue: now,
    });
    if (!authorization.authorized) { exclude(authorization.reason); continue; }
    if (FIRM_MODES.has(item.quoteMode)) {
      const capacity = capacityById.get(item.solverId);
      if (capacity === undefined || capacity.state !== 'ACTIVE' || capacity.remainingAtoms < request.notionalAtoms) {
        exclude('CAPACITY_UNAVAILABLE');
        continue;
      }
    }
    eligible.push({ ...item, commonControlGroupId: manifest.commonControlGroupId });
  }

  const groups = new Map<string, typeof eligible>();
  for (const item of eligible) {
    const key = `${enumDiscriminant(SETTLEMENT_CLASS, item.settlementClass).toString().padStart(3, '0')}:${item.riskClassId}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const rankedGroups = [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, items]) => {
      const sorted = [...items].sort((left, right) => {
        if (left.netOutcomeAtoms !== right.netOutcomeAtoms) return left.netOutcomeAtoms > right.netOutcomeAtoms ? -1 : 1;
        if (FIRMNESS[left.quoteMode] !== FIRMNESS[right.quoteMode]) return FIRMNESS[left.quoteMode] - FIRMNESS[right.quoteMode];
        if (left.receivedAtValue !== right.receivedAtValue) return left.receivedAtValue < right.receivedAtValue ? -1 : 1;
        return compareBytes(left.quoteHash, right.quoteHash);
      });
      const first = sorted[0] as (typeof sorted)[number];
      return Object.freeze({
        settlementClass: first.settlementClass,
        riskClassId: first.riskClassId,
        ranked: Object.freeze(
          sorted.map((item, rank) =>
            Object.freeze({
              rank: rank + 1,
              solverId: item.solverId,
              commonControlGroupId: item.commonControlGroupId,
              quoteHash: item.quoteHash,
              quoteMode: item.quoteMode,
              netOutcomeAtoms: item.netOutcomeAtoms,
              receivedAtValue: item.receivedAtValue,
            }),
          ),
        ),
      });
    });

  const payload = canonicalBytes((writer) => {
    encodeCommitmentHash(writer, orderHash, 'orderHash');
    encodeDomainRef(writer, request.domain);
    encodeProtocolId(writer, protocolId(request.marketId, 'decideRfq.marketId'));
    writer.writeU128(unsigned(request.notionalAtoms, U128_BITS, 'decideRfq.notionalAtoms'), 'notionalAtoms');
    writer.writeU64(deadline, 'responseDeadlineValue');
    writer.writeU64(now, 'atValue');
    writer.writeArray(rankedGroups, (element, group) => {
      element.writeEnum(SETTLEMENT_CLASS, group.settlementClass, 'settlementClass');
      encodeProtocolId(element, group.riskClassId);
      element.writeArray(group.ranked, (inner, item) => {
        encodeProtocolId(inner, item.solverId);
        encodeCommitmentHash(inner, item.quoteHash, 'quoteHash');
        inner.writeEnum(QUOTE_MODE, item.quoteMode, 'quoteMode');
        inner.writeI128(item.netOutcomeAtoms, 'netOutcomeAtoms');
      });
    });
    writer.writeArray(excluded, (element, item) => {
      encodeProtocolId(element, item.solverId);
      encodeCommitmentHash(element, item.quoteHash, 'quoteHash');
      element.writeString(item.reason, 'reason');
    });
  });
  return Object.freeze({
    orderHash,
    groups: Object.freeze(rankedGroups),
    excluded: Object.freeze(excluded),
    // Keys and processes run by one economic organization count once.
    independentOrganizations: new Set(eligible.map((item) => item.commonControlGroupId)).size,
    decisionHash: commitmentHash(domainHash(HASH_DOMAIN.RFQ_DECISION, payload), 'rfqDecisionHash'),
  });
}

// ------------------------------------------------------------------ maker quote surfaces

export interface MakerQuoteLevelInput {
  readonly levelId: bigint;
  readonly side: PackageBookSide;
  readonly sizeUnits: bigint;
  readonly offsetTicks: bigint;
}

export interface MakerQuoteSurfaceInput {
  readonly version: number;
  readonly solverId: string;
  readonly executionClassId: string;
  readonly levels: readonly MakerQuoteLevelInput[];
  readonly skewTicksPerInventoryUnit: bigint;
  readonly maximumInventoryUnits: bigint;
  readonly maximumLevelSizeUnits: bigint;
  readonly marketKillSwitch: boolean;
  readonly portfolioKillSwitch: boolean;
}

export interface MakerQuote {
  readonly levelId: bigint;
  readonly side: PackageBookSide;
  readonly priceTicks: bigint;
  readonly sizeUnits: bigint;
}

export function makerQuoteSurface(input: MakerQuoteSurfaceInput, context = 'makerQuoteSurface'): MakerQuoteSurfaceInput {
  object(input, context);
  if (input.version !== MAKER_QUOTE_SURFACE_VERSION) {
    throw new MalformedInputError(`${context}.version`, `version must equal ${MAKER_QUOTE_SURFACE_VERSION}`);
  }
  const maximumLevelSizeUnits = unsigned(input.maximumLevelSizeUnits, U128_BITS, `${context}.maximumLevelSizeUnits`);
  requireArray(input.levels, `${context}.levels`);
  if (input.levels.length === 0 || input.levels.length > RFQ_MAX_RESPONSES) {
    throw new MalformedInputError(`${context}.levels`, 'expected a bounded nonempty level list');
  }
  const ids = new Set<bigint>();
  const levels = input.levels.map((level, index) => {
    const at = `${context}.levels[${index}]`;
    object(level, at);
    const levelId = unsigned(level.levelId, U64_BITS, `${at}.levelId`);
    if (ids.has(levelId)) throw new DuplicateElementError(`${at}.levelId`, 'level ids repeat');
    ids.add(levelId);
    const sizeUnits = unsigned(level.sizeUnits, U128_BITS, `${at}.sizeUnits`);
    if (sizeUnits === 0n || sizeUnits > maximumLevelSizeUnits) {
      throw new MalformedInputError(`${at}.sizeUnits`, 'level size is zero or above the surface maximum');
    }
    return Object.freeze({
      levelId,
      side: variant(PACKAGE_BOOK_SIDE, level.side, `${at}.side`),
      sizeUnits,
      offsetTicks: signed(level.offsetTicks, `${at}.offsetTicks`),
    });
  });
  const bids = levels.filter((level) => level.side === 'BID').map((level) => level.offsetTicks);
  const asks = levels.filter((level) => level.side === 'ASK').map((level) => level.offsetTicks);
  // Offsets are relative to one reference, so a self-crossing surface crosses at every reference.
  if (bids.length > 0 && asks.length > 0 && bids.reduce((a, b) => (a > b ? a : b)) >= asks.reduce((a, b) => (a < b ? a : b))) {
    throw new MalformedInputError(`${context}.levels`, 'the surface crosses itself');
  }
  const skew = signed(input.skewTicksPerInventoryUnit, `${context}.skewTicksPerInventoryUnit`);
  if (skew < 0n) throw new MalformedInputError(`${context}.skewTicksPerInventoryUnit`, 'skew must lean against inventory');
  return Object.freeze({
    version: MAKER_QUOTE_SURFACE_VERSION,
    solverId: protocolId(input.solverId, `${context}.solverId`),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    levels: Object.freeze(levels),
    skewTicksPerInventoryUnit: skew,
    maximumInventoryUnits: unsigned(input.maximumInventoryUnits, U128_BITS, `${context}.maximumInventoryUnits`),
    maximumLevelSizeUnits,
    marketKillSwitch: bool(input.marketKillSwitch, `${context}.marketKillSwitch`),
    portfolioKillSwitch: bool(input.portfolioKillSwitch, `${context}.portfolioKillSwitch`),
  });
}

/**
 * Prices every level from one reference in constant time per level. Long inventory lowers
 * both sides, and each side is clipped so filling it cannot breach the inventory limit.
 */
export function generateMakerQuotes(
  surfaceInput: MakerQuoteSurfaceInput,
  referencePriceTicks: bigint,
  inventoryUnits: bigint,
): readonly MakerQuote[] {
  const surface = makerQuoteSurface(surfaceInput);
  const reference = signed(referencePriceTicks, 'generateMakerQuotes.referencePriceTicks');
  const inventory = signed(inventoryUnits, 'generateMakerQuotes.inventoryUnits');
  if (surface.marketKillSwitch || surface.portfolioKillSwitch) return Object.freeze([]);
  let bidRoom = surface.maximumInventoryUnits - inventory;
  let askRoom = surface.maximumInventoryUnits + inventory;
  const skew = surface.skewTicksPerInventoryUnit * inventory;
  // Best price first on each side; equal offsets fall back to the level id so capped inventory
  // room is assigned the same way whatever order the levels were listed in.
  const ordered = [...surface.levels].sort((left, right) => {
    if (left.side !== right.side) return left.side === 'BID' ? -1 : 1;
    if (left.offsetTicks !== right.offsetTicks) {
      return left.side === 'BID'
        ? (left.offsetTicks > right.offsetTicks ? -1 : 1)
        : (left.offsetTicks < right.offsetTicks ? -1 : 1);
    }
    return left.levelId < right.levelId ? -1 : left.levelId > right.levelId ? 1 : 0;
  });
  const quotes: MakerQuote[] = [];
  for (const level of ordered) {
    const room = level.side === 'BID' ? bidRoom : askRoom;
    if (room <= 0n) continue;
    const sizeUnits = level.sizeUnits < room ? level.sizeUnits : room;
    if (level.side === 'BID') bidRoom -= sizeUnits;
    else askRoom -= sizeUnits;
    quotes.push(Object.freeze({
      levelId: level.levelId,
      side: level.side,
      priceTicks: signed(reference + level.offsetTicks - skew, 'generateMakerQuotes.priceTicks'),
      sizeUnits,
    }));
  }
  return Object.freeze(quotes);
}

// ------------------------------------------------------------------ performance bonds

export const BOND_FAULT = Object.freeze({
  FAILED_TO_HONOR_FUNDED_RESERVATION: 1,
  SUBMITTED_OFF_ROUTE: 2,
  WITHHELD_REQUIRED_RECOVERY_ACTION: 3,
} as const);
export type BondFault = keyof typeof BOND_FAULT;

export type BondClaimState = 'PENDING' | 'DISPUTED' | 'PAID' | 'REJECTED';

export interface PerformanceBondInput {
  readonly version: number;
  readonly bondId: Uint8Array | string;
  readonly solverId: string;
  readonly asset: AssetRef;
  readonly bondAtoms: bigint;
  readonly coveredFaults: readonly BondFault[];
  readonly maximumPayoutPerClaimAtoms: bigint;
  readonly disputeWindowValue: bigint;
  readonly expiresAtValue: bigint;
}

export interface BondClaim {
  readonly faultEvidenceHash: CommitmentHash;
  readonly fault: BondFault;
  readonly payoutAtoms: bigint;
  readonly filedAtValue: bigint;
  readonly state: BondClaimState;
}

export interface PerformanceBondLedger {
  readonly bond: PerformanceBondInput;
  readonly bondHash: CommitmentHash;
  readonly claims: readonly BondClaim[];
  readonly released: boolean;
}

export function openPerformanceBond(input: PerformanceBondInput, context = 'performanceBond'): PerformanceBondLedger {
  object(input, context);
  if (input.version !== PERFORMANCE_BOND_VERSION) {
    throw new MalformedInputError(`${context}.version`, `version must equal ${PERFORMANCE_BOND_VERSION}`);
  }
  requireArray(input.coveredFaults, `${context}.coveredFaults`);
  if (input.coveredFaults.length === 0) {
    throw new MalformedInputError(`${context}.coveredFaults`, 'a bond must name at least one objective fault');
  }
  const faults = [...new Set(input.coveredFaults.map((fault) => variant(BOND_FAULT, fault, `${context}.coveredFaults`)))].sort(
    (left, right) => BOND_FAULT[left] - BOND_FAULT[right],
  );
  if (faults.length !== input.coveredFaults.length) throw new DuplicateElementError(`${context}.coveredFaults`, 'faults repeat');
  object(input.asset, `${context}.asset`);
  const bondAtoms = unsigned(input.bondAtoms, U128_BITS, `${context}.bondAtoms`);
  const cap = unsigned(input.maximumPayoutPerClaimAtoms, U128_BITS, `${context}.maximumPayoutPerClaimAtoms`);
  if (bondAtoms === 0n || cap === 0n || cap > bondAtoms) {
    throw new MalformedInputError(`${context}.maximumPayoutPerClaimAtoms`, 'payout cap must be positive and within the bond');
  }
  const bond: PerformanceBondInput = Object.freeze({
    version: PERFORMANCE_BOND_VERSION,
    bondId: commitmentHash(input.bondId, `${context}.bondId`),
    solverId: protocolId(input.solverId, `${context}.solverId`),
    asset: assetRef(input.asset.assetId, input.asset.assetManifestHash, input.asset.decimals, `${context}.asset`),
    bondAtoms,
    coveredFaults: Object.freeze(faults),
    maximumPayoutPerClaimAtoms: cap,
    disputeWindowValue: unsigned(input.disputeWindowValue, U64_BITS, `${context}.disputeWindowValue`),
    expiresAtValue: unsigned(input.expiresAtValue, U64_BITS, `${context}.expiresAtValue`),
  });
  const payload = canonicalBytes((writer) => {
    writer.writeU32(bond.version, 'version');
    encodeCommitmentHash(writer, bond.bondId as CommitmentHash, 'bondId');
    encodeProtocolId(writer, bond.solverId as ProtocolId);
    encodeAssetRef(writer, bond.asset);
    writer.writeU128(bond.bondAtoms, 'bondAtoms');
    writer.writeArray(bond.coveredFaults, (element, fault) => element.writeEnum(BOND_FAULT, fault));
    writer.writeU128(bond.maximumPayoutPerClaimAtoms, 'maximumPayoutPerClaimAtoms');
    writer.writeU64(bond.disputeWindowValue, 'disputeWindowValue');
    writer.writeU64(bond.expiresAtValue, 'expiresAtValue');
  });
  return Object.freeze({
    bond,
    bondHash: commitmentHash(domainHash(HASH_DOMAIN.PERFORMANCE_BOND, payload), 'performanceBondHash'),
    claims: Object.freeze([]),
    released: false,
  });
}

function withClaims(ledger: PerformanceBondLedger, claims: readonly BondClaim[], released = ledger.released): PerformanceBondLedger {
  return Object.freeze({ ...ledger, claims: Object.freeze(claims), released });
}

/** Paid plus still-contestable claims; this much of the bond can never be promised twice. */
function encumbered(ledger: PerformanceBondLedger): bigint {
  return ledger.claims
    .filter((claim) => claim.state !== 'REJECTED')
    .reduce((sum, claim) => sum + claim.payoutAtoms, 0n);
}

export function fileBondClaim(
  ledger: PerformanceBondLedger,
  input: { readonly faultEvidenceHash: Uint8Array | string; readonly fault: BondFault; readonly payoutAtoms: bigint; readonly atValue: bigint },
): PerformanceBondLedger {
  object(input, 'fileBondClaim');
  const evidence = commitmentHash(input.faultEvidenceHash, 'fileBondClaim.faultEvidenceHash');
  const fault = variant(BOND_FAULT, input.fault, 'fileBondClaim.fault');
  const payoutAtoms = unsigned(input.payoutAtoms, U128_BITS, 'fileBondClaim.payoutAtoms');
  const at = unsigned(input.atValue, U64_BITS, 'fileBondClaim.atValue');
  if (ledger.released || at >= ledger.bond.expiresAtValue) {
    throw new MalformedInputError('fileBondClaim', 'the bond is released or expired');
  }
  if (!ledger.bond.coveredFaults.includes(fault)) {
    throw new MalformedInputError('fileBondClaim.fault', 'the bond does not cover this fault');
  }
  if (ledger.claims.some((claim) => compareBytes(claim.faultEvidenceHash, evidence) === 0)) {
    throw new DuplicateElementError('fileBondClaim.faultEvidenceHash', 'this fault evidence was already claimed');
  }
  if (payoutAtoms === 0n || payoutAtoms > ledger.bond.maximumPayoutPerClaimAtoms) {
    throw new MalformedInputError('fileBondClaim.payoutAtoms', 'payout is zero or above the per-claim cap');
  }
  if (encumbered(ledger) + payoutAtoms > ledger.bond.bondAtoms) {
    throw new MalformedInputError('fileBondClaim.payoutAtoms', 'payout exceeds the unencumbered bond');
  }
  return withClaims(ledger, [
    ...ledger.claims,
    Object.freeze({ faultEvidenceHash: evidence, fault, payoutAtoms, filedAtValue: at, state: 'PENDING' as const }),
  ]);
}

function claimIndex(ledger: PerformanceBondLedger, evidence: Uint8Array | string, context: string): number {
  const id = toHex(commitmentHash(evidence, `${context}.faultEvidenceHash`));
  const index = ledger.claims.findIndex((claim) => toHex(claim.faultEvidenceHash) === id);
  if (index < 0) throw new MalformedInputError(`${context}.faultEvidenceHash`, 'claim is unknown');
  return index;
}

function replaceClaim(ledger: PerformanceBondLedger, index: number, state: BondClaimState): PerformanceBondLedger {
  return withClaims(ledger, ledger.claims.map((claim, position) => (position === index ? Object.freeze({ ...claim, state }) : claim)));
}

export function disputeBondClaim(ledger: PerformanceBondLedger, evidence: Uint8Array | string, atValue: bigint): PerformanceBondLedger {
  const index = claimIndex(ledger, evidence, 'disputeBondClaim');
  const claim = ledger.claims[index] as BondClaim;
  if (claim.state !== 'PENDING' || unsigned(atValue, U64_BITS, 'disputeBondClaim.atValue') >= claim.filedAtValue + ledger.bond.disputeWindowValue) {
    throw new MalformedInputError('disputeBondClaim', 'only a pending claim inside its dispute window can be disputed');
  }
  return replaceClaim(ledger, index, 'DISPUTED');
}

/** An undisputed claim pays once its window closes; a disputed one needs an explicit resolution. */
export function settleBondClaim(
  ledger: PerformanceBondLedger,
  evidence: Uint8Array | string,
  atValue: bigint,
  disputeUpheld?: boolean,
): PerformanceBondLedger {
  const index = claimIndex(ledger, evidence, 'settleBondClaim');
  const claim = ledger.claims[index] as BondClaim;
  if (claim.state === 'PENDING') {
    if (disputeUpheld !== undefined) throw new MalformedInputError('settleBondClaim', 'an undisputed claim has no resolution');
    if (unsigned(atValue, U64_BITS, 'settleBondClaim.atValue') < claim.filedAtValue + ledger.bond.disputeWindowValue) {
      throw new MalformedInputError('settleBondClaim', 'the dispute window is still open');
    }
    return replaceClaim(ledger, index, 'PAID');
  }
  if (claim.state === 'DISPUTED') {
    if (disputeUpheld === undefined) throw new MalformedInputError('settleBondClaim', 'a disputed claim needs a resolution');
    return replaceClaim(ledger, index, disputeUpheld ? 'REJECTED' : 'PAID');
  }
  throw new MalformedInputError('settleBondClaim', 'the claim is already final');
}

/** After expiry with no open claim, the unpaid remainder returns to the solver exactly once. */
export function releasePerformanceBond(ledger: PerformanceBondLedger, atValue: bigint): { readonly ledger: PerformanceBondLedger; readonly returnedAtoms: bigint } {
  if (ledger.released) throw new MalformedInputError('releasePerformanceBond', 'the bond was already released');
  if (unsigned(atValue, U64_BITS, 'releasePerformanceBond.atValue') < ledger.bond.expiresAtValue) {
    throw new MalformedInputError('releasePerformanceBond', 'the bond has not expired');
  }
  if (ledger.claims.some((claim) => claim.state === 'PENDING' || claim.state === 'DISPUTED')) {
    throw new MalformedInputError('releasePerformanceBond', 'open claims block release');
  }
  const paid = ledger.claims.filter((claim) => claim.state === 'PAID').reduce((sum, claim) => sum + claim.payoutAtoms, 0n);
  return { ledger: withClaims(ledger, ledger.claims, true), returnedAtoms: ledger.bond.bondAtoms - paid };
}

export type QuoteBondViolation =
  | 'NOT_BONDED_MODE'
  | 'BOND_MISMATCH'
  | 'SOLVER_MISMATCH'
  | 'FAULT_NOT_COVERED'
  | 'BOND_RELEASED'
  | 'BOND_EXPIRES_BEFORE_QUOTE'
  | 'BOND_TIME_UNIT_MISMATCH'
  | 'BOND_EXHAUSTED'
  | 'CAP_BELOW_FEE_EXPOSURE';

/**
 * A quote expiry in the bond's time unit, rounded later so a bond is never judged to outlive a
 * quote it does not. Slots have no fixed relation to wall-clock time and never convert.
 */
function inBondTime(value: bigint, from: string, to: string): bigint | undefined {
  if (from === to) return value;
  if (from === 'HYPERLIQUID_UNIX_MILLISECONDS' && to === 'EVM_UNIX_SECONDS') return (value + 999n) / 1_000n;
  if (from === 'EVM_UNIX_SECONDS' && to === 'HYPERLIQUID_UNIX_MILLISECONDS') return value * 1_000n;
  return undefined;
}

/**
 * Whether a bond ledger backs a FIRM_BONDED quote: the quote names this bond, the bond belongs to
 * the quoting solver, covers failure to honor a funded reservation, is unreleased, outlives the
 * quote, still has an unencumbered balance, and its per-claim cap covers at least the fees the
 * taker would lose. The bond is compensation for a canonical fault, never a claim on liquidity.
 */
export function verifyQuoteBond(
  quote: { readonly quoteMode: QuoteMode; readonly solverId: string; readonly performanceBondId?: Uint8Array | string; readonly validUntilUnit: string; readonly validUntilValue: bigint; readonly solverFee: { readonly atoms: bigint }; readonly protocolFee: { readonly atoms: bigint } },
  ledger: PerformanceBondLedger,
  /** The unit the bond's expiry and dispute window are measured in, such as the vault's block seconds. */
  bondTimeUnit: string,
): { readonly backed: true } | { readonly backed: false; readonly violations: readonly QuoteBondViolation[] } {
  const violations: QuoteBondViolation[] = [];
  if (quote.quoteMode !== 'FIRM_BONDED' || quote.performanceBondId === undefined) violations.push('NOT_BONDED_MODE');
  else if (toHex(commitmentHash(quote.performanceBondId, 'verifyQuoteBond.performanceBondId')) !== toHex(commitmentHash(ledger.bond.bondId, 'verifyQuoteBond.bondId'))) violations.push('BOND_MISMATCH');
  if (ledger.bond.solverId !== quote.solverId) violations.push('SOLVER_MISMATCH');
  if (!ledger.bond.coveredFaults.includes('FAILED_TO_HONOR_FUNDED_RESERVATION')) violations.push('FAULT_NOT_COVERED');
  if (ledger.released) violations.push('BOND_RELEASED');
  const quoteUntil = inBondTime(quote.validUntilValue, quote.validUntilUnit, bondTimeUnit);
  if (quoteUntil === undefined) violations.push('BOND_TIME_UNIT_MISMATCH');
  else if (ledger.bond.expiresAtValue <= quoteUntil + ledger.bond.disputeWindowValue) violations.push('BOND_EXPIRES_BEFORE_QUOTE');
  if (encumbered(ledger) >= ledger.bond.bondAtoms) violations.push('BOND_EXHAUSTED');
  if (ledger.bond.maximumPayoutPerClaimAtoms < quote.solverFee.atoms + quote.protocolFee.atoms) violations.push('CAP_BELOW_FEE_EXPOSURE');
  return violations.length === 0 ? Object.freeze({ backed: true as const }) : Object.freeze({ backed: false as const, violations: Object.freeze(violations) });
}
