import { absBigInt, checkedSigned, checkedUnsigned } from './arithmetic.js';
import { compareBytes, toHex } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  IMPLICATION_EVIDENCE,
  PACKAGE_BOOK_SIDE,
  PACKAGE_LIQUIDITY_SOURCE,
  emptyPackageBook,
  matchPackageOrder,
  packageBookState,
  packageMatchingPolicy,
  type PackageBookEntry,
  type PackageBookState,
  type PackageMatchingPolicy,
  type PackageTakerOrderInput,
} from './package-matching.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import {
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

export const PACKAGE_REOPENING_RESULT_VERSION = 1;
export const PACKAGE_REOPENING_SETTLEMENT_HANDOFF_VERSION = 1;
export const PACKAGE_REOPENING_MAX_FILLS = 2_000;

const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;

export interface PackageReopeningAdmission {
  readonly state: PackageBookState;
  readonly entry: PackageBookEntry;
  readonly expiredEntryIds: readonly CommitmentHash[];
}

export interface PackageReopeningFill {
  readonly fillSequence: bigint;
  readonly bidEntryId: CommitmentHash;
  readonly askEntryId: CommitmentHash;
  readonly bidLimitPriceTicks: bigint;
  readonly askLimitPriceTicks: bigint;
  readonly quantity: bigint;
}

export interface PackageReopeningResult {
  readonly version: 1;
  readonly environment: ProtocolId;
  readonly executionClassId: ProtocolId;
  readonly matchingPolicyHash: ManifestHash;
  readonly openingSnapshotHash: CommitmentHash;
  readonly qualificationSnapshotHash: CommitmentHash;
  readonly referencePriceTicks: bigint;
  readonly clearingPriceTicks?: bigint;
  readonly firstFillSequence: bigint;
  readonly fills: readonly PackageReopeningFill[];
  readonly executedQuantity: bigint;
  readonly expiredEntryIds: readonly CommitmentHash[];
  readonly invalidatedImpliedEntryIds: readonly CommitmentHash[];
  readonly selfMatchCancelledEntryIds: readonly CommitmentHash[];
  readonly unexecutableCancelledEntryIds: readonly CommitmentHash[];
}

export interface PackageReopeningClearance {
  readonly state: PackageBookState;
  readonly result: PackageReopeningResult;
  readonly resultHash: CommitmentHash;
}

export interface PackageReopeningSettlementFillInput {
  readonly fillSequence: bigint;
  readonly bidEntryId: Uint8Array | string;
  readonly askEntryId: Uint8Array | string;
  readonly bidSettlementCommitmentHash: Uint8Array | string;
  readonly askSettlementCommitmentHash: Uint8Array | string;
  readonly priceTicks: bigint;
  readonly quantity: bigint;
}

export interface PackageReopeningSettlementFill extends Omit<
  PackageReopeningSettlementFillInput,
  'bidEntryId' | 'askEntryId' | 'bidSettlementCommitmentHash' | 'askSettlementCommitmentHash'
> {
  readonly bidEntryId: CommitmentHash;
  readonly askEntryId: CommitmentHash;
  readonly bidSettlementCommitmentHash: CommitmentHash;
  readonly askSettlementCommitmentHash: CommitmentHash;
}

export interface PackageReopeningSettlementHandoffInput {
  readonly version: number;
  readonly reopeningResultHash: Uint8Array | string;
  readonly executionClassId: string;
  readonly fills: readonly PackageReopeningSettlementFillInput[];
}

export interface PackageReopeningSettlementHandoff extends Omit<
  PackageReopeningSettlementHandoffInput,
  'reopeningResultHash' | 'executionClassId' | 'fills'
> {
  readonly version: 1;
  readonly reopeningResultHash: CommitmentHash;
  readonly executionClassId: ProtocolId;
  readonly fills: readonly PackageReopeningSettlementFill[];
}

interface WorkingEntry {
  readonly entry: PackageBookEntry;
  remaining: bigint;
}

interface Simulation {
  readonly priceTicks: bigint;
  readonly fills: readonly PackageReopeningFill[];
  readonly executedQuantity: bigint;
  readonly imbalance: bigint;
  readonly selfMatchCancelledEntryIds: readonly CommitmentHash[];
  readonly unexecutableCancelledEntryIds: readonly CommitmentHash[];
  readonly remaining: ReadonlyMap<string, bigint>;
}

function positive(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  const checked = checkedUnsigned(value, bits, context);
  if (checked === 0n) throw new MalformedInputError(context, 'value is zero');
  return checked;
}

function signed(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedSigned(value, I128_BITS, context);
}

function live(entry: PackageBookEntry, nowValue: bigint): boolean {
  return entry.expiresAtValue === undefined || nowValue < entry.expiresAtValue;
}

function entryOrder(side: 'BID' | 'ASK') {
  return (left: PackageBookEntry, right: PackageBookEntry): number => {
    if (left.priceTicks !== right.priceTicks) {
      if (side === 'BID') return left.priceTicks > right.priceTicks ? -1 : 1;
      return left.priceTicks < right.priceTicks ? -1 : 1;
    }
    if (left.sequence !== right.sequence) return left.sequence < right.sequence ? -1 : 1;
    return compareBytes(left.entryId, right.entryId);
  };
}

function encodeEntry(writer: CanonicalWriter, entry: PackageBookEntry, context: string): void {
  encodeCommitmentHash(writer, entry.entryId, `${context}.entryId`);
  writer.writeEnum(PACKAGE_BOOK_SIDE, entry.side, `${context}.side`);
  writer.writeEnum(PACKAGE_LIQUIDITY_SOURCE, entry.source, `${context}.source`);
  writer.writeI128(entry.priceTicks, `${context}.priceTicks`);
  writer.writeU128(entry.quantity, `${context}.quantity`);
  writer.writeU128(entry.minimumFillQuantity, `${context}.minimumFillQuantity`);
  writer.writeU64(entry.sequence, `${context}.sequence`);
  encodeProtocolId(writer, entry.participantId, `${context}.participantId`);
  encodeProtocolId(writer, entry.commonControlGroupId, `${context}.commonControlGroupId`);
  writer.writeOptional(entry.expiresAtValue, (inner, value) => inner.writeU64(value, `${context}.expiresAtValue`));
  writer.writeOptional(entry.implied, (inner, implied) => {
    inner.writeEnum(IMPLICATION_EVIDENCE, implied.evidence, `${context}.implied.evidence`);
    inner.writeU8(implied.derivationDepth, `${context}.implied.derivationDepth`);
    inner.writeArray(implied.sources, (sourceWriter, source) => {
      encodeProtocolId(sourceWriter, source.sourceId, `${context}.implied.sources.sourceId`);
      sourceWriter.writeU64(source.sourceVersion, `${context}.implied.sources.sourceVersion`);
      sourceWriter.writeOptional(source.reservationId, (reservationWriter, reservationId) =>
        encodeCommitmentHash(reservationWriter, reservationId, `${context}.implied.sources.reservationId`),
      );
    }, `${context}.implied.sources`);
    inner.writeOptional(implied.solverCommitment, (commitmentWriter, solverCommitment) =>
      encodeCommitmentHash(commitmentWriter, solverCommitment, `${context}.implied.solverCommitment`),
    );
  });
}

export function packageReopeningSnapshotBytes(
  policyInput: PackageMatchingPolicy,
  stateInput: PackageBookState,
): Uint8Array {
  const policy = packageMatchingPolicy(policyInput, 'packageReopeningSnapshot.policy');
  const state = packageBookState(policy, stateInput, 'packageReopeningSnapshot.state');
  return canonicalBytes((writer) => {
    writer.writeU32(PACKAGE_REOPENING_RESULT_VERSION, 'packageReopeningSnapshot.version');
    encodeProtocolId(writer, state.executionClassId, 'packageReopeningSnapshot.executionClassId');
    encodeManifestHash(writer, state.matchingPolicyHash, 'packageReopeningSnapshot.matchingPolicyHash');
    writer.writeBool(state.halted, 'packageReopeningSnapshot.halted');
    writer.writeU64(state.nextSequence, 'packageReopeningSnapshot.nextSequence');
    writer.writeArray(
      [...state.entries].sort((left, right) => left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : compareBytes(left.entryId, right.entryId)),
      (entryWriter, entry) => encodeEntry(entryWriter, entry, 'packageReopeningSnapshot.entry'),
      'packageReopeningSnapshot.entries',
    );
  });
}

export function packageReopeningSnapshotHash(
  policy: PackageMatchingPolicy,
  state: PackageBookState,
): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.PACKAGE_REOPENING_SNAPSHOT, packageReopeningSnapshotBytes(policy, state)),
    'packageReopeningSnapshotHash',
  );
}

export function queuePackageReopeningOrder(
  policyInput: PackageMatchingPolicy,
  stateInput: PackageBookState,
  order: PackageTakerOrderInput,
  nowValue: bigint,
): PackageReopeningAdmission {
  const policy = packageMatchingPolicy(policyInput, 'queuePackageReopeningOrder.policy');
  const state = packageBookState(policy, stateInput, 'queuePackageReopeningOrder.state');
  const now = checkedUnsigned(nowValue, U64_BITS, 'queuePackageReopeningOrder.nowValue');
  if (!state.halted) throw new MalformedInputError('queuePackageReopeningOrder.state', 'book is not halted');
  if (state.entries.some((entry) => compareBytes(entry.entryId, commitmentHash(order.orderId)) === 0)) {
    throw new MalformedInputError('queuePackageReopeningOrder.order.orderId', 'order is already in the reopening book');
  }
  const isolated = matchPackageOrder(policy, emptyPackageBook(policy), order, now, 'queuePackageReopeningOrder.order');
  if (!isolated.accepted || isolated.allocation.restedQuantity !== order.quantity || isolated.state.entries.length !== 1) {
    throw new MalformedInputError('queuePackageReopeningOrder.order', 'reopening orders must be fully restable');
  }
  const expiredEntryIds = state.entries.filter((entry) => !live(entry, now)).map((entry) => entry.entryId);
  const entry = Object.freeze({ ...(isolated.state.entries[0] as PackageBookEntry), sequence: state.nextSequence });
  const nextSequence = checkedUnsigned(state.nextSequence + 1n, U64_BITS, 'queuePackageReopeningOrder.nextSequence');
  const next = packageBookState(policy, {
    ...state,
    nextSequence,
    entries: [...state.entries.filter((candidate) => live(candidate, now)), entry],
  }, 'queuePackageReopeningOrder.nextState');
  return Object.freeze({ state: next, entry, expiredEntryIds: Object.freeze(expiredEntryIds) });
}

function selfMatch(policy: PackageMatchingPolicy, bid: PackageBookEntry, ask: PackageBookEntry): boolean {
  return bid.participantId === ask.participantId
    || (policy.commonControlAsSelf && bid.commonControlGroupId === ask.commonControlGroupId);
}

function executableQuantity(
  bid: WorkingEntry,
  ask: WorkingEntry,
  minimum: bigint,
): bigint {
  let quantity = bid.remaining < ask.remaining ? bid.remaining : ask.remaining;
  for (const remaining of [bid.remaining, ask.remaining]) {
    const residual = remaining - quantity;
    if (residual > 0n && residual < minimum) quantity -= minimum - residual;
  }
  return quantity >= minimum ? quantity : 0n;
}

function cancellationTarget(policy: PackageMatchingPolicy, bid: WorkingEntry, ask: WorkingEntry): readonly WorkingEntry[] {
  if (policy.selfMatchPolicy === 'CANCEL_BOTH') return [bid, ask];
  const incoming = bid.entry.sequence > ask.entry.sequence ? bid : ask;
  const resting = incoming === bid ? ask : bid;
  return policy.selfMatchPolicy === 'CANCEL_INCOMING' ? [incoming] : [resting];
}

function simulate(
  policy: PackageMatchingPolicy,
  entries: readonly PackageBookEntry[],
  priceTicks: bigint,
  firstFillSequence: bigint,
): Simulation {
  const bids = entries
    .filter((entry) => entry.side === 'BID' && entry.priceTicks >= priceTicks)
    .sort(entryOrder('BID'))
    .map((entry) => ({ entry, remaining: entry.quantity }));
  const asks = entries
    .filter((entry) => entry.side === 'ASK' && entry.priceTicks <= priceTicks)
    .sort(entryOrder('ASK'))
    .map((entry) => ({ entry, remaining: entry.quantity }));
  const demand = bids.reduce((sum, entry) => sum + entry.remaining, 0n);
  const supply = asks.reduce((sum, entry) => sum + entry.remaining, 0n);
  const selfCancelled: CommitmentHash[] = [];
  const unexecutableCancelled: CommitmentHash[] = [];
  const fills: PackageReopeningFill[] = [];
  let bidIndex = 0;
  let askIndex = 0;
  let fillSequence = firstFillSequence;
  while (bidIndex < bids.length && askIndex < asks.length) {
    const bid = bids[bidIndex] as WorkingEntry;
    const ask = asks[askIndex] as WorkingEntry;
    if (bid.remaining === 0n) {
      bidIndex += 1;
      continue;
    }
    if (ask.remaining === 0n) {
      askIndex += 1;
      continue;
    }
    if (selfMatch(policy, bid.entry, ask.entry)) {
      for (const target of cancellationTarget(policy, bid, ask)) {
        target.remaining = 0n;
        selfCancelled.push(target.entry.entryId);
      }
      continue;
    }
    const quantity = executableQuantity(bid, ask, policy.minimumExecutionQuantity);
    if (quantity === 0n) {
      const target = bid.entry.sequence > ask.entry.sequence ? bid : ask;
      target.remaining = 0n;
      unexecutableCancelled.push(target.entry.entryId);
      continue;
    }
    fills.push(Object.freeze({
      fillSequence,
      bidEntryId: bid.entry.entryId,
      askEntryId: ask.entry.entryId,
      bidLimitPriceTicks: bid.entry.priceTicks,
      askLimitPriceTicks: ask.entry.priceTicks,
      quantity,
    }));
    fillSequence += 1n;
    bid.remaining -= quantity;
    ask.remaining -= quantity;
  }
  const remaining = new Map(entries.map((entry) => [toHex(entry.entryId), entry.quantity]));
  for (const entry of [...bids, ...asks]) remaining.set(toHex(entry.entry.entryId), entry.remaining);
  return Object.freeze({
    priceTicks,
    fills: Object.freeze(fills),
    executedQuantity: fills.reduce((sum, fill) => sum + fill.quantity, 0n),
    imbalance: absBigInt(demand - supply),
    selfMatchCancelledEntryIds: Object.freeze(selfCancelled),
    unexecutableCancelledEntryIds: Object.freeze(unexecutableCancelled),
    remaining,
  });
}

function better(left: Simulation, right: Simulation | undefined, referencePriceTicks: bigint): boolean {
  if (right === undefined) return true;
  if (left.executedQuantity !== right.executedQuantity) return left.executedQuantity > right.executedQuantity;
  if (left.imbalance !== right.imbalance) return left.imbalance < right.imbalance;
  const leftDistance = absBigInt(left.priceTicks - referencePriceTicks);
  const rightDistance = absBigInt(right.priceTicks - referencePriceTicks);
  if (leftDistance !== rightDistance) return leftDistance < rightDistance;
  return left.priceTicks < right.priceTicks;
}

function assertUncrossed(entries: readonly PackageBookEntry[]): void {
  const bestBid = entries
    .filter((entry) => entry.side === 'BID')
    .reduce<bigint | undefined>((best, entry) => best === undefined || entry.priceTicks > best ? entry.priceTicks : best, undefined);
  const bestAsk = entries
    .filter((entry) => entry.side === 'ASK')
    .reduce<bigint | undefined>((best, entry) => best === undefined || entry.priceTicks < best ? entry.priceTicks : best, undefined);
  if (bestBid !== undefined && bestAsk !== undefined && bestBid >= bestAsk) {
    throw new MalformedInputError('clearPackageReopeningAuction.state', 'auction leaves a crossed book');
  }
}

function checkedFill(fill: PackageReopeningFill, context: string): PackageReopeningFill {
  const quantity = positive(fill.quantity, U128_BITS, `${context}.quantity`);
  return Object.freeze({
    fillSequence: positive(fill.fillSequence, U64_BITS, `${context}.fillSequence`),
    bidEntryId: commitmentHash(fill.bidEntryId, `${context}.bidEntryId`),
    askEntryId: commitmentHash(fill.askEntryId, `${context}.askEntryId`),
    bidLimitPriceTicks: signed(fill.bidLimitPriceTicks, `${context}.bidLimitPriceTicks`),
    askLimitPriceTicks: signed(fill.askLimitPriceTicks, `${context}.askLimitPriceTicks`),
    quantity,
  });
}

function hashList(values: readonly CommitmentHash[], context: string): readonly CommitmentHash[] {
  if (!Array.isArray(values)) throw new MalformedInputError(context, 'expected an array');
  const checked = values.map((value, index) => commitmentHash(value, `${context}[${index}]`));
  const seen = new Set(checked.map(toHex));
  if (seen.size !== checked.length) throw new MalformedInputError(context, 'entry id repeats');
  return Object.freeze(checked);
}

export function packageReopeningResult(input: PackageReopeningResult): PackageReopeningResult {
  if (typeof input !== 'object' || input === null) throw new MalformedInputError('packageReopeningResult', 'expected an object');
  if (input.version !== PACKAGE_REOPENING_RESULT_VERSION) {
    throw new MalformedInputError('packageReopeningResult.version', `version must equal ${PACKAGE_REOPENING_RESULT_VERSION}`);
  }
  const fills = input.fills.map((fill, index) => checkedFill(fill, `packageReopeningResult.fills[${index}]`));
  const firstFillSequence = positive(input.firstFillSequence, U64_BITS, 'packageReopeningResult.firstFillSequence');
  fills.forEach((fill, index) => {
    if (fill.fillSequence !== firstFillSequence + BigInt(index)) {
      throw new MalformedInputError(`packageReopeningResult.fills[${index}].fillSequence`, 'fill sequence is not contiguous');
    }
  });
  const executedQuantity = checkedUnsigned(input.executedQuantity, U128_BITS, 'packageReopeningResult.executedQuantity');
  if (fills.reduce((sum, fill) => sum + fill.quantity, 0n) !== executedQuantity) {
    throw new MalformedInputError('packageReopeningResult.executedQuantity', 'quantity does not equal the fills');
  }
  const clearingPriceTicks = input.clearingPriceTicks === undefined
    ? undefined
    : signed(input.clearingPriceTicks, 'packageReopeningResult.clearingPriceTicks');
  if ((fills.length > 0) !== (clearingPriceTicks !== undefined)) {
    throw new MalformedInputError('packageReopeningResult.clearingPriceTicks', 'a clearing price is required exactly when the auction fills');
  }
  return Object.freeze({
    version: PACKAGE_REOPENING_RESULT_VERSION,
    environment: protocolId(input.environment, 'packageReopeningResult.environment'),
    executionClassId: protocolId(input.executionClassId, 'packageReopeningResult.executionClassId'),
    matchingPolicyHash: manifestHash(input.matchingPolicyHash, 'packageReopeningResult.matchingPolicyHash'),
    openingSnapshotHash: commitmentHash(input.openingSnapshotHash, 'packageReopeningResult.openingSnapshotHash'),
    qualificationSnapshotHash: commitmentHash(input.qualificationSnapshotHash, 'packageReopeningResult.qualificationSnapshotHash'),
    referencePriceTicks: signed(input.referencePriceTicks, 'packageReopeningResult.referencePriceTicks'),
    ...(clearingPriceTicks === undefined ? {} : { clearingPriceTicks }),
    firstFillSequence,
    fills: Object.freeze(fills),
    executedQuantity,
    expiredEntryIds: hashList(input.expiredEntryIds, 'packageReopeningResult.expiredEntryIds'),
    invalidatedImpliedEntryIds: hashList(input.invalidatedImpliedEntryIds, 'packageReopeningResult.invalidatedImpliedEntryIds'),
    selfMatchCancelledEntryIds: hashList(input.selfMatchCancelledEntryIds, 'packageReopeningResult.selfMatchCancelledEntryIds'),
    unexecutableCancelledEntryIds: hashList(input.unexecutableCancelledEntryIds, 'packageReopeningResult.unexecutableCancelledEntryIds'),
  });
}

function encodeHashList(writer: CanonicalWriter, values: readonly CommitmentHash[], context: string): void {
  writer.writeArray(values, (element, value) => encodeCommitmentHash(element, value, context), context);
}

export function packageReopeningResultBytes(input: PackageReopeningResult): Uint8Array {
  const result = packageReopeningResult(input);
  return canonicalBytes((writer) => {
    writer.writeU32(result.version, 'packageReopeningResult.version');
    encodeProtocolId(writer, result.environment, 'packageReopeningResult.environment');
    encodeProtocolId(writer, result.executionClassId, 'packageReopeningResult.executionClassId');
    encodeManifestHash(writer, result.matchingPolicyHash, 'packageReopeningResult.matchingPolicyHash');
    encodeCommitmentHash(writer, result.openingSnapshotHash, 'packageReopeningResult.openingSnapshotHash');
    encodeCommitmentHash(writer, result.qualificationSnapshotHash, 'packageReopeningResult.qualificationSnapshotHash');
    writer.writeI128(result.referencePriceTicks, 'packageReopeningResult.referencePriceTicks');
    writer.writeOptional(result.clearingPriceTicks, (inner, value) => inner.writeI128(value, 'packageReopeningResult.clearingPriceTicks'));
    writer.writeU64(result.firstFillSequence, 'packageReopeningResult.firstFillSequence');
    writer.writeArray(result.fills, (inner, fill) => {
      inner.writeU64(fill.fillSequence, 'packageReopeningResult.fill.fillSequence');
      encodeCommitmentHash(inner, fill.bidEntryId, 'packageReopeningResult.fill.bidEntryId');
      encodeCommitmentHash(inner, fill.askEntryId, 'packageReopeningResult.fill.askEntryId');
      inner.writeI128(fill.bidLimitPriceTicks, 'packageReopeningResult.fill.bidLimitPriceTicks');
      inner.writeI128(fill.askLimitPriceTicks, 'packageReopeningResult.fill.askLimitPriceTicks');
      inner.writeU128(fill.quantity, 'packageReopeningResult.fill.quantity');
    }, 'packageReopeningResult.fills');
    writer.writeU128(result.executedQuantity, 'packageReopeningResult.executedQuantity');
    encodeHashList(writer, result.expiredEntryIds, 'packageReopeningResult.expiredEntryIds');
    encodeHashList(writer, result.invalidatedImpliedEntryIds, 'packageReopeningResult.invalidatedImpliedEntryIds');
    encodeHashList(writer, result.selfMatchCancelledEntryIds, 'packageReopeningResult.selfMatchCancelledEntryIds');
    encodeHashList(writer, result.unexecutableCancelledEntryIds, 'packageReopeningResult.unexecutableCancelledEntryIds');
  });
}

export function packageReopeningResultHash(input: PackageReopeningResult): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.PACKAGE_REOPENING_RESULT, packageReopeningResultBytes(input)),
    'packageReopeningResultHash',
  );
}

function reopeningSettlementFill(
  input: PackageReopeningSettlementFillInput,
  context: string,
): PackageReopeningSettlementFill {
  if (typeof input !== 'object' || input === null) throw new MalformedInputError(context, 'expected an object');
  return Object.freeze({
    fillSequence: positive(input.fillSequence, U64_BITS, `${context}.fillSequence`),
    bidEntryId: commitmentHash(input.bidEntryId, `${context}.bidEntryId`),
    askEntryId: commitmentHash(input.askEntryId, `${context}.askEntryId`),
    bidSettlementCommitmentHash: commitmentHash(
      input.bidSettlementCommitmentHash,
      `${context}.bidSettlementCommitmentHash`,
    ),
    askSettlementCommitmentHash: commitmentHash(
      input.askSettlementCommitmentHash,
      `${context}.askSettlementCommitmentHash`,
    ),
    priceTicks: signed(input.priceTicks, `${context}.priceTicks`),
    quantity: positive(input.quantity, U128_BITS, `${context}.quantity`),
  });
}

export function packageReopeningSettlementHandoff(
  input: PackageReopeningSettlementHandoffInput,
  context = 'packageReopeningSettlementHandoff',
): PackageReopeningSettlementHandoff {
  if (typeof input !== 'object' || input === null) throw new MalformedInputError(context, 'expected an object');
  if (input.version !== PACKAGE_REOPENING_SETTLEMENT_HANDOFF_VERSION) {
    throw new MalformedInputError(`${context}.version`, `version must equal ${PACKAGE_REOPENING_SETTLEMENT_HANDOFF_VERSION}`);
  }
  if (!Array.isArray(input.fills) || input.fills.length === 0 || input.fills.length > PACKAGE_REOPENING_MAX_FILLS) {
    throw new MalformedInputError(`${context}.fills`, `expected 1 to ${PACKAGE_REOPENING_MAX_FILLS} fills`);
  }
  const fills = input.fills.map((fill, index) => reopeningSettlementFill(fill, `${context}.fills[${index}]`));
  fills.forEach((fill, index) => {
    if (index > 0 && fill.fillSequence !== fills[index - 1]!.fillSequence + 1n) {
      throw new MalformedInputError(`${context}.fills[${index}].fillSequence`, 'fill sequence is not contiguous');
    }
  });
  return Object.freeze({
    version: PACKAGE_REOPENING_SETTLEMENT_HANDOFF_VERSION,
    reopeningResultHash: commitmentHash(input.reopeningResultHash, `${context}.reopeningResultHash`),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    fills: Object.freeze(fills),
  });
}

export function packageReopeningSettlementHandoffBytes(
  input: PackageReopeningSettlementHandoffInput,
  context = 'packageReopeningSettlementHandoff',
): Uint8Array {
  const handoff = packageReopeningSettlementHandoff(input, context);
  return canonicalBytes((writer) => {
    writer.writeU32(handoff.version, `${context}.version`);
    encodeCommitmentHash(writer, handoff.reopeningResultHash, `${context}.reopeningResultHash`);
    encodeProtocolId(writer, handoff.executionClassId, `${context}.executionClassId`);
    writer.writeArray(handoff.fills, (element, fill) => {
      element.writeU64(fill.fillSequence, `${context}.fills.fillSequence`);
      encodeCommitmentHash(element, fill.bidEntryId, `${context}.fills.bidEntryId`);
      encodeCommitmentHash(element, fill.askEntryId, `${context}.fills.askEntryId`);
      encodeCommitmentHash(
        element,
        fill.bidSettlementCommitmentHash,
        `${context}.fills.bidSettlementCommitmentHash`,
      );
      encodeCommitmentHash(
        element,
        fill.askSettlementCommitmentHash,
        `${context}.fills.askSettlementCommitmentHash`,
      );
      element.writeI128(fill.priceTicks, `${context}.fills.priceTicks`);
      element.writeU128(fill.quantity, `${context}.fills.quantity`);
    }, `${context}.fills`);
  });
}

export function packageReopeningSettlementHandoffHash(
  input: PackageReopeningSettlementHandoffInput,
): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.PACKAGE_REOPENING_SETTLEMENT_HANDOFF, packageReopeningSettlementHandoffBytes(input)),
    'packageReopeningSettlementHandoffHash',
  );
}

export function verifyPackageReopeningSettlementHandoff(
  resultInput: PackageReopeningResult,
  handoffInput: PackageReopeningSettlementHandoffInput,
  context = 'verifyPackageReopeningSettlementHandoff',
): void {
  const result = packageReopeningResult(resultInput);
  const handoff = packageReopeningSettlementHandoff(handoffInput);
  if (compareBytes(handoff.reopeningResultHash, packageReopeningResultHash(result)) !== 0) {
    throw new MalformedInputError(context, 'handoff cites another reopening result');
  }
  if (handoff.executionClassId !== result.executionClassId || handoff.fills.length !== result.fills.length) {
    throw new MalformedInputError(context, 'handoff does not cover the reopening result');
  }
  if (result.clearingPriceTicks === undefined) {
    throw new MalformedInputError(context, 'a result without fills has no settlement handoff');
  }
  result.fills.forEach((fill, index) => {
    const settlement = handoff.fills[index]!;
    if (
      fill.fillSequence !== settlement.fillSequence
      || compareBytes(fill.bidEntryId, settlement.bidEntryId) !== 0
      || compareBytes(fill.askEntryId, settlement.askEntryId) !== 0
      || fill.quantity !== settlement.quantity
      || settlement.priceTicks !== result.clearingPriceTicks
    ) {
      throw new MalformedInputError(`${context}.fills[${index}]`, 'settlement fill differs from the reopening result');
    }
  });
}

export function clearPackageReopeningAuction(
  policyInput: PackageMatchingPolicy,
  stateInput: PackageBookState,
  qualificationSnapshotHashInput: Uint8Array | string,
  referencePriceTicksInput: bigint,
  nowValue: bigint,
): PackageReopeningClearance {
  const policy = packageMatchingPolicy(policyInput, 'clearPackageReopeningAuction.policy');
  const state = packageBookState(policy, stateInput, 'clearPackageReopeningAuction.state');
  if (!state.halted) throw new MalformedInputError('clearPackageReopeningAuction.state', 'book is not halted');
  const now = checkedUnsigned(nowValue, U64_BITS, 'clearPackageReopeningAuction.nowValue');
  const referencePriceTicks = signed(referencePriceTicksInput, 'clearPackageReopeningAuction.referencePriceTicks');
  const qualificationSnapshotHash = commitmentHash(qualificationSnapshotHashInput, 'clearPackageReopeningAuction.qualificationSnapshotHash');
  const openingSnapshotHash = packageReopeningSnapshotHash(policy, state);
  const expiredEntryIds = state.entries.filter((entry) => !live(entry, now)).map((entry) => entry.entryId);
  const invalidatedImpliedEntryIds = state.entries
    .filter((entry) => live(entry, now) && entry.source === 'IMPLIED')
    .map((entry) => entry.entryId);
  const direct = state.entries.filter((entry) => live(entry, now) && entry.source === 'DIRECT');
  const priceSet = new Set(direct.map((entry) => entry.priceTicks));
  priceSet.add(referencePriceTicks);
  let selected: Simulation | undefined;
  for (const priceTicks of [...priceSet].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
    const simulation = simulate(policy, direct, priceTicks, state.nextSequence);
    if (better(simulation, selected, referencePriceTicks)) selected = simulation;
  }
  const remaining = selected?.remaining ?? new Map(direct.map((entry) => [toHex(entry.entryId), entry.quantity]));
  const entries = direct.flatMap((entry) => {
    const quantity = remaining.get(toHex(entry.entryId)) ?? 0n;
    return quantity === 0n ? [] : [Object.freeze({ ...entry, quantity })];
  });
  assertUncrossed(entries);
  const fillCount = BigInt(selected?.fills.length ?? 0);
  const nextSequence = checkedUnsigned(state.nextSequence + fillCount, U64_BITS, 'clearPackageReopeningAuction.nextSequence');
  const nextState = packageBookState(policy, {
    ...state,
    halted: false,
    nextSequence,
    entries,
  }, 'clearPackageReopeningAuction.nextState');
  const result = packageReopeningResult({
    version: PACKAGE_REOPENING_RESULT_VERSION,
    environment: policy.environment,
    executionClassId: policy.executionClassId,
    matchingPolicyHash: state.matchingPolicyHash,
    openingSnapshotHash,
    qualificationSnapshotHash,
    referencePriceTicks,
    ...(selected !== undefined && selected.executedQuantity > 0n ? { clearingPriceTicks: selected.priceTicks } : {}),
    firstFillSequence: state.nextSequence,
    fills: selected?.fills ?? [],
    executedQuantity: selected?.executedQuantity ?? 0n,
    expiredEntryIds,
    invalidatedImpliedEntryIds,
    selfMatchCancelledEntryIds: selected?.selfMatchCancelledEntryIds ?? [],
    unexecutableCancelledEntryIds: selected?.unexecutableCancelledEntryIds ?? [],
  });
  return Object.freeze({ state: nextState, result, resultHash: packageReopeningResultHash(result) });
}

export function verifyPackageReopeningResult(
  policy: PackageMatchingPolicy,
  openingState: PackageBookState,
  qualificationSnapshotHash: Uint8Array | string,
  referencePriceTicks: bigint,
  nowValue: bigint,
  claimedResult: PackageReopeningResult,
): void {
  const expected = clearPackageReopeningAuction(
    policy,
    openingState,
    qualificationSnapshotHash,
    referencePriceTicks,
    nowValue,
  );
  if (compareBytes(expected.resultHash, packageReopeningResultHash(claimedResult)) !== 0) {
    throw new MalformedInputError('verifyPackageReopeningResult.claimedResult', 'result does not replay from the opening snapshot');
  }
}
