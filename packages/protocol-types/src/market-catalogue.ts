import { assertUint8Array } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { enumDiscriminant, SETTLEMENT_CLASS, type SettlementClass } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { encodeProtocolId, protocolId, type ProtocolId } from './primitives.js';

export const MARKET_CATALOGUE_VERSION = 1;
export const MAX_CATALOGUE_ENTRIES = 1_024;
const MAX_LIST = 32;
const MAX_SOLVERS = 256;

/** One package market as a client needs it to search locally, with nothing about any order. */
export interface MarketCatalogueEntryInput {
  readonly packageMarketId: string;
  readonly executionClassVersion: number;
  readonly seriesId: string;
  readonly seriesVersion: number;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly underlyingRefs: readonly string[];
  readonly quoteAsset: string;
  readonly settlementClass: SettlementClass;
  readonly firmnessClass: string;
  readonly collateralMode: string;
  readonly domainIds: readonly string[];
  readonly halted: boolean;
}

export interface MarketCatalogueEntry {
  readonly packageMarketId: ProtocolId;
  readonly executionClassVersion: number;
  readonly seriesId: ProtocolId;
  readonly seriesVersion: number;
  readonly templateId: ProtocolId;
  readonly templateVersion: number;
  readonly underlyingRefs: readonly ProtocolId[];
  readonly quoteAsset: ProtocolId;
  readonly settlementClass: SettlementClass;
  readonly firmnessClass: ProtocolId;
  readonly collateralMode: ProtocolId;
  readonly domainIds: readonly ProtocolId[];
  readonly halted: boolean;
}

/**
 * The whole signed catalogue of package markets and registered solvers. A client downloads it
 * once and searches it locally, so an ordinary search reveals no trading intent to the server.
 */
export interface MarketCatalogueInput {
  readonly catalogueVersion: number;
  readonly environment: string;
  /** Strictly increases with each catalogue the authority issues. */
  readonly sequence: bigint;
  readonly issuedAtMs: bigint;
  readonly expiresAtMs: bigint;
  readonly entries: readonly MarketCatalogueEntryInput[];
  readonly solverIds: readonly string[];
  readonly authority: string;
  readonly signature: Uint8Array;
}

export interface MarketCatalogue {
  readonly catalogueVersion: number;
  readonly environment: ProtocolId;
  readonly sequence: bigint;
  readonly issuedAtMs: bigint;
  readonly expiresAtMs: bigint;
  /** Sorted by package market id. */
  readonly entries: readonly MarketCatalogueEntry[];
  readonly solverIds: readonly ProtocolId[];
  readonly authority: ProtocolId;
  readonly signature: Uint8Array;
}

function u64(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << 64n) throw new MalformedInputError(context, 'expected a u64');
  return value;
}

function u32(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffff_ffff) throw new MalformedInputError(context, 'expected a positive u32');
  return value;
}

function ids(values: readonly string[], maximum: number, context: string, allowEmpty = false): readonly ProtocolId[] {
  if (!Array.isArray(values) || values.length > maximum || (!allowEmpty && values.length === 0)) {
    throw new MalformedInputError(context, `expected ${allowEmpty ? 0 : 1} to ${maximum} identifiers`);
  }
  const sorted = values.map((value, index) => protocolId(value, `${context}[${index}]`)).sort();
  for (let index = 1; index < sorted.length; index += 1) if (sorted[index - 1] === sorted[index]) throw new DuplicateElementError(context, 'identifiers repeat');
  return Object.freeze(sorted);
}

function entry(input: MarketCatalogueEntryInput, context: string): MarketCatalogueEntry {
  if (typeof input !== 'object' || input === null) throw new MalformedInputError(context, 'expected an object');
  if (typeof input.halted !== 'boolean') throw new MalformedInputError(`${context}.halted`, 'expected a boolean');
  enumDiscriminant(SETTLEMENT_CLASS, input.settlementClass, `${context}.settlementClass`);
  return Object.freeze({
    packageMarketId: protocolId(input.packageMarketId, `${context}.packageMarketId`),
    executionClassVersion: u32(input.executionClassVersion, `${context}.executionClassVersion`),
    seriesId: protocolId(input.seriesId, `${context}.seriesId`),
    seriesVersion: u32(input.seriesVersion, `${context}.seriesVersion`),
    templateId: protocolId(input.templateId, `${context}.templateId`),
    templateVersion: u32(input.templateVersion, `${context}.templateVersion`),
    underlyingRefs: ids(input.underlyingRefs, MAX_LIST, `${context}.underlyingRefs`),
    quoteAsset: protocolId(input.quoteAsset, `${context}.quoteAsset`),
    settlementClass: input.settlementClass,
    firmnessClass: protocolId(input.firmnessClass, `${context}.firmnessClass`),
    collateralMode: protocolId(input.collateralMode, `${context}.collateralMode`),
    domainIds: ids(input.domainIds, MAX_LIST, `${context}.domainIds`),
    halted: input.halted,
  });
}

export function marketCatalogue(input: MarketCatalogueInput, context = 'marketCatalogue'): MarketCatalogue {
  if (typeof input !== 'object' || input === null) throw new MalformedInputError(context, 'expected an object');
  if (input.catalogueVersion !== MARKET_CATALOGUE_VERSION) throw new MalformedInputError(`${context}.catalogueVersion`, `version must equal ${MARKET_CATALOGUE_VERSION}`);
  const issuedAtMs = u64(input.issuedAtMs, `${context}.issuedAtMs`);
  const expiresAtMs = u64(input.expiresAtMs, `${context}.expiresAtMs`);
  if (expiresAtMs <= issuedAtMs) throw new MalformedInputError(`${context}.expiresAtMs`, 'a catalogue must expire after it is issued');
  if (!Array.isArray(input.entries) || input.entries.length > MAX_CATALOGUE_ENTRIES) {
    throw new MalformedInputError(`${context}.entries`, `expected at most ${MAX_CATALOGUE_ENTRIES} markets`);
  }
  const entries = input.entries
    .map((value, index) => entry(value, `${context}.entries[${index}]`))
    .sort((left, right) => (left.packageMarketId < right.packageMarketId ? -1 : left.packageMarketId > right.packageMarketId ? 1 : 0));
  for (let index = 1; index < entries.length; index += 1) {
    if ((entries[index - 1] as MarketCatalogueEntry).packageMarketId === (entries[index] as MarketCatalogueEntry).packageMarketId) {
      throw new DuplicateElementError(`${context}.entries`, 'a market is listed twice');
    }
  }
  assertUint8Array(input.signature, `${context}.signature`);
  if (input.signature.length > 128) throw new MalformedInputError(`${context}.signature`, 'signature is too long');
  return Object.freeze({
    catalogueVersion: MARKET_CATALOGUE_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    sequence: u64(input.sequence, `${context}.sequence`),
    issuedAtMs,
    expiresAtMs,
    entries: Object.freeze(entries),
    solverIds: ids(input.solverIds, MAX_SOLVERS, `${context}.solverIds`, true),
    authority: protocolId(input.authority, `${context}.authority`),
    signature: Uint8Array.from(input.signature),
  });
}

function encodeEntry(writer: CanonicalWriter, value: MarketCatalogueEntry): void {
  encodeProtocolId(writer, value.packageMarketId, 'packageMarketId');
  writer.writeU32(value.executionClassVersion, 'executionClassVersion');
  encodeProtocolId(writer, value.seriesId, 'seriesId');
  writer.writeU32(value.seriesVersion, 'seriesVersion');
  encodeProtocolId(writer, value.templateId, 'templateId');
  writer.writeU32(value.templateVersion, 'templateVersion');
  writer.writeArray(value.underlyingRefs, (inner, id) => encodeProtocolId(inner, id, 'underlyingRef'), 'underlyingRefs');
  encodeProtocolId(writer, value.quoteAsset, 'quoteAsset');
  writer.writeEnum(SETTLEMENT_CLASS, value.settlementClass, 'settlementClass');
  encodeProtocolId(writer, value.firmnessClass, 'firmnessClass');
  encodeProtocolId(writer, value.collateralMode, 'collateralMode');
  writer.writeArray(value.domainIds, (inner, id) => encodeProtocolId(inner, id, 'domainId'), 'domainIds');
  writer.writeBool(value.halted, 'halted');
}

/** Every catalogue field except the signature, which signs this hash. */
export function marketCatalogueBytes(input: MarketCatalogueInput): Uint8Array {
  const catalogue = marketCatalogue(input);
  return canonicalBytes((writer) => {
    writer.writeU32(catalogue.catalogueVersion, 'catalogueVersion');
    encodeProtocolId(writer, catalogue.environment, 'environment');
    writer.writeU64(catalogue.sequence, 'sequence');
    writer.writeU64(catalogue.issuedAtMs, 'issuedAtMs');
    writer.writeU64(catalogue.expiresAtMs, 'expiresAtMs');
    writer.writeArray(catalogue.entries, encodeEntry, 'entries');
    writer.writeArray(catalogue.solverIds, (inner, id) => encodeProtocolId(inner, id, 'solverId'), 'solverIds');
    encodeProtocolId(writer, catalogue.authority, 'authority');
  });
}

export function marketCatalogueHash(input: MarketCatalogueInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.MARKET_CATALOGUE, marketCatalogueBytes(input)), 'marketCatalogueHash');
}

export interface MarketCatalogueQuery {
  /** Matched case-insensitively against market, series, template, underlying, and quote asset ids. */
  readonly text?: string;
  readonly settlementClass?: SettlementClass;
  readonly domainId?: string;
  readonly underlying?: string;
  readonly includeHalted?: boolean;
}

/** Searches a catalogue already held locally. It never touches the network, so it reveals nothing. */
export function searchMarketCatalogue(catalogueInput: MarketCatalogueInput, query: MarketCatalogueQuery): readonly MarketCatalogueEntry[] {
  const catalogue = marketCatalogue(catalogueInput);
  const text = query.text?.trim().toLowerCase();
  return Object.freeze(
    catalogue.entries.filter((candidate) => {
      if (!query.includeHalted && candidate.halted) return false;
      if (query.settlementClass !== undefined && candidate.settlementClass !== query.settlementClass) return false;
      if (query.domainId !== undefined && !candidate.domainIds.includes(query.domainId as ProtocolId)) return false;
      if (query.underlying !== undefined && !candidate.underlyingRefs.includes(query.underlying as ProtocolId)) return false;
      if (text === undefined || text === '') return true;
      return [candidate.packageMarketId, candidate.seriesId, candidate.templateId, candidate.quoteAsset, ...candidate.underlyingRefs].some((value) => value.toLowerCase().includes(text));
    }),
  );
}

/** Whether a catalogue is current at `nowMs`: issued no later than now and not yet expired. */
export function marketCatalogueCurrent(catalogueInput: MarketCatalogueInput, nowMs: bigint): boolean {
  const catalogue = marketCatalogue(catalogueInput);
  return catalogue.issuedAtMs <= nowMs && nowMs < catalogue.expiresAtMs;
}
