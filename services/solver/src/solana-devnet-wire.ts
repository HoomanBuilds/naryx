import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import type { DomainRef } from '@naryx/protocol-types';

/**
 * Byte-exact readers and writers for the Solana Devnet firm route accounts the solver reads live:
 * the inventory reservation program, the package book, the core quote lock and registry indexes,
 * the Naryx test perp, and the Pyth Solana Receiver PriceUpdateV2 account. Layouts mirror the
 * programs in contracts/solana; nothing here signs or sends.
 */

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const PYTH_RECEIVER_PROGRAM_ID = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';
export const SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT = '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE';
export const SOLANA_DEVNET_SOL_USD_FEED_ID_HEX = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const PRICE_UPDATE_V2_DISCRIMINATOR = Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]);
const BPS = 10_000n;
export const QUOTE_SIDE_BID = 1;
export const QUOTE_SIDE_ASK = 2;
export const RESERVATION_ACTION_ENTRY = 1;
export const RESERVATION_ACTION_EXIT = 2;
export const QUOTE_MODE_FIRM_ONCHAIN = 2;
export const MAX_QUOTE_LEVELS = 32;

function fail(message: string): never {
  throw new Error(`Solana Devnet wire: ${message}`);
}

export function sha256(...parts: readonly Uint8Array[]): Uint8Array {
  const digest = createHash('sha256');
  for (const part of parts) digest.update(part);
  return Uint8Array.from(digest.digest());
}

export function accountDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

export function instructionDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

export function bigEndian(value: bigint, length: number, signed = false): Uint8Array {
  const bits = BigInt(length * 8);
  let remaining = signed && value < 0n ? (1n << bits) + value : value;
  const out = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

/** Canonical bytes: u32 BE length then ASCII, as `ProtocolId::canonical_bytes`. */
export function protocolIdBytes(value: string): Uint8Array {
  const bytes = Buffer.from(value, 'ascii');
  if (bytes.length === 0 || bytes.length > 64 || !/^[\x20-\x7e]+$/.test(value)) fail('protocol id is invalid');
  return Buffer.concat([Buffer.from(bigEndian(BigInt(bytes.length), 4)), bytes]);
}

/** Canonical bytes: `DomainRef::canonical_bytes`. */
export function domainBytes(domain: DomainRef): Uint8Array {
  return Buffer.concat([
    Buffer.from(protocolIdBytes(domain.domainId)),
    Buffer.from(bigEndian(BigInt(domain.domainManifestVersion), 4)),
    Buffer.from(domain.domainManifestHash),
  ]);
}

export function reservationIdFor(domain: DomainRef, solverId: string, orderHash: Uint8Array, reservationNonce: Uint8Array): Uint8Array {
  return sha256(Buffer.from('CON/v1/reservation-id', 'ascii'), domainBytes(domain), protocolIdBytes(solverId), orderHash, reservationNonce);
}

export class BorshWriter {
  readonly #parts: Buffer[] = [];

  bytes(value: Uint8Array): this { this.#parts.push(Buffer.from(value)); return this; }
  u8(value: number): this { this.#parts.push(Buffer.from([value])); return this; }
  bool(value: boolean): this { return this.u8(value ? 1 : 0); }
  u32(value: number): this { const b = Buffer.alloc(4); b.writeUInt32LE(value); this.#parts.push(b); return this; }
  u64(value: bigint): this { const b = Buffer.alloc(8); b.writeBigUInt64LE(value); this.#parts.push(b); return this; }
  i64(value: bigint): this { const b = Buffer.alloc(8); b.writeBigInt64LE(value); this.#parts.push(b); return this; }
  i128(value: bigint): this {
    const raw = value < 0n ? (1n << 128n) + value : value;
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(raw & ((1n << 64n) - 1n), 0);
    b.writeBigUInt64LE(raw >> 64n, 8);
    this.#parts.push(b);
    return this;
  }
  string(value: string): this { const bytes = Buffer.from(value, 'utf8'); this.u32(bytes.length); return this.bytes(bytes); }
  key(value: PublicKey | string): this { return this.bytes(new PublicKey(value).toBuffer()); }
  domain(domain: DomainRef): this {
    return this.string(domain.domainId).u32(domain.domainManifestVersion).bytes(domain.domainManifestHash);
  }
  done(): Buffer { return Buffer.concat(this.#parts); }
}

export class BorshReader {
  readonly #data: Buffer;
  #offset: number;

  constructor(data: Uint8Array, discriminator: Buffer | undefined, name: string) {
    this.#data = Buffer.from(data);
    if (discriminator !== undefined
      && (this.#data.length < 8 || !this.#data.subarray(0, 8).equals(discriminator))) {
      fail(`${name} discriminator mismatch`);
    }
    this.#offset = discriminator === undefined ? 0 : 8;
  }

  take(length: number): Buffer {
    if (this.#offset + length > this.#data.length) fail('account data is truncated');
    const slice = this.#data.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }

  key(): string { return new PublicKey(this.take(32)).toBase58(); }
  hash(): Uint8Array { return Uint8Array.from(this.take(32)); }
  u8(): number { return this.take(1).readUInt8(0); }
  u16(): number { return this.take(2).readUInt16LE(0); }
  u32(): number { return this.take(4).readUInt32LE(0); }
  u64(): bigint { return this.take(8).readBigUInt64LE(0); }
  i64(): bigint { return this.take(8).readBigInt64LE(0); }
  i128(): bigint {
    const bytes = this.take(16);
    const raw = bytes.readBigUInt64LE(0) | (bytes.readBigUInt64LE(8) << 64n);
    return raw >= 1n << 127n ? raw - (1n << 128n) : raw;
  }
  bool(): boolean {
    const value = this.u8();
    if (value > 1) fail('boolean byte is invalid');
    return value === 1;
  }
  string(): string {
    const length = this.u32();
    if (length > 64) fail('string is too long');
    return this.take(length).toString('utf8');
  }
  domain(): DomainRef {
    const domainId = this.string();
    const domainManifestVersion = this.u32();
    return { domainId, domainManifestVersion, domainManifestHash: this.hash() } as DomainRef;
  }
}

export function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && Buffer.from(left.domainManifestHash).equals(Buffer.from(right.domainManifestHash));
}

export type ReservationClassState = Readonly<{
  version: number;
  domain: DomainRef;
  reservationProgram: string;
  reservationProgramData: string;
  reservationCodeIdentity: Uint8Array;
  policyHash: Uint8Array;
  baseMint: string;
  quoteMint: string;
  coreProgram: string;
  coreProgramData: string;
  coreCodeIdentity: Uint8Array;
  maxTtlSlots: bigint;
  maxBaseAtoms: bigint;
  maxSolverReservedBaseAtoms: bigint;
}>;

export function decodeReservationClass(data: Uint8Array): ReservationClassState {
  const r = new BorshReader(data, accountDiscriminator('ReservationClass'), 'ReservationClass');
  const version = r.u16();
  const domain = r.domain();
  r.hash();
  const reservationProgram = r.key();
  const reservationProgramData = r.key();
  const reservationCodeIdentity = r.hash();
  const policyHash = r.hash();
  const baseMint = r.key();
  const quoteMint = r.key();
  const coreProgram = r.key();
  const coreProgramData = r.key();
  const coreCodeIdentity = r.hash();
  r.key(); r.key(); r.hash();
  return Object.freeze({
    version, domain, reservationProgram, reservationProgramData, reservationCodeIdentity, policyHash,
    baseMint, quoteMint, coreProgram, coreProgramData, coreCodeIdentity,
    maxTtlSlots: r.u64(), maxBaseAtoms: r.u64(), maxSolverReservedBaseAtoms: r.u64(),
  });
}

export const RESERVATION_STATES = ['FUNDED', 'LIVE', 'CONSUMED', 'RELEASED'] as const;

export type FirmReservationState = Readonly<{
  reservationClass: string;
  domain: DomainRef;
  reservationId: Uint8Array;
  solverId: string;
  solver: string;
  strategyAuthority: string;
  packageNonce: bigint;
  orderHash: Uint8Array;
  quoteHash: Uint8Array;
  routeHash: Uint8Array;
  reservationNonce: Uint8Array;
  baseMint: string;
  quoteMint: string;
  solverReclaimBase: string;
  solverQuote: string;
  strategyBase: string;
  strategyQuote: string;
  baseAtoms: bigint;
  quoteAtoms: bigint;
  expirySlot: bigint;
  action: number;
  state: typeof RESERVATION_STATES[number];
}>;

export function decodeFirmReservation(data: Uint8Array): FirmReservationState {
  const r = new BorshReader(data, accountDiscriminator('FirmReservation'), 'FirmReservation');
  r.u16();
  const value = {
    reservationClass: r.key(), domain: r.domain(), reservationId: r.hash(), solverId: r.string(), solver: r.key(),
    strategyAuthority: r.key(), packageNonce: r.u64(), orderHash: r.hash(), quoteHash: r.hash(), routeHash: r.hash(),
    reservationNonce: r.hash(), baseMint: r.key(), quoteMint: r.key(), solverReclaimBase: r.key(), solverQuote: r.key(),
    strategyBase: r.key(), strategyQuote: r.key(), baseAtoms: r.u64(), quoteAtoms: r.u64(), expirySlot: r.u64(),
    action: r.u8(),
  };
  const state = RESERVATION_STATES[r.u8()];
  if (state === undefined) fail('reservation state is invalid');
  return Object.freeze({ ...value, state });
}

export type FirmQuoteLockState = Readonly<{
  domain: DomainRef;
  solver: string;
  reservation: string;
  reservationId: Uint8Array;
  reservationPolicyHash: Uint8Array;
  orderHash: Uint8Array;
  quoteHash: Uint8Array;
  routeHash: Uint8Array;
  quoteArgsHash: Uint8Array;
  seriesManifestHash: Uint8Array;
  executionClassManifestHash: Uint8Array;
  fillCommitment: Uint8Array;
  packageSizeUnits: bigint;
  baseAtoms: bigint;
  quoteAtoms: bigint;
  expirySlot: bigint;
  consumed: boolean;
}>;

export function decodeFirmQuoteLock(data: Uint8Array): FirmQuoteLockState {
  const r = new BorshReader(data, accountDiscriminator('FirmQuoteLock'), 'FirmQuoteLock');
  return Object.freeze({
    domain: r.domain(), solver: r.key(), reservation: r.key(), reservationId: r.hash(), reservationPolicyHash: r.hash(),
    orderHash: r.hash(), quoteHash: r.hash(), routeHash: r.hash(), quoteArgsHash: r.hash(), seriesManifestHash: r.hash(),
    executionClassManifestHash: r.hash(), fillCommitment: r.hash(), packageSizeUnits: r.u64(), baseAtoms: r.u64(),
    quoteAtoms: r.u64(), expirySlot: r.u64(), consumed: r.bool(),
  });
}

export type PackageQuoteShardState = Readonly<{
  domain: DomainRef;
  packageBookClass: string;
  solver: string;
  solverId: string;
  seriesManifestHash: Uint8Array;
  executionClassManifestHash: Uint8Array;
  referencePackagePrice: bigint;
  referenceStateHash: Uint8Array;
  referenceSequence: bigint;
  shardSequence: bigint;
  heartbeatExpirySlot: bigint;
  epoch: bigint;
  killed: boolean;
}>;

export function decodePackageQuoteShard(data: Uint8Array): PackageQuoteShardState {
  const r = new BorshReader(data, accountDiscriminator('PackageQuoteShard'), 'PackageQuoteShard');
  r.u16();
  const domain = r.domain();
  const packageBookClass = r.key();
  const solver = r.key();
  const solverId = r.string();
  const seriesManifestHash = r.hash();
  const executionClassManifestHash = r.hash();
  r.key(); r.key(); r.hash(); r.key(); r.key(); r.hash();
  return Object.freeze({
    domain, packageBookClass, solver, solverId, seriesManifestHash, executionClassManifestHash,
    referencePackagePrice: r.i128(), referenceStateHash: r.hash(), referenceSequence: r.u64(),
    shardSequence: r.u64(), heartbeatExpirySlot: r.u64(), epoch: r.u64(), killed: r.bool(),
  });
}

export type QuoteLevelState = Readonly<{
  slotIndex: number;
  settlementClassIdentityHash: Uint8Array;
  reservationPolicyHash: Uint8Array;
  referenceOffset: bigint;
  levelId: bigint;
  epoch: bigint;
  levelSequence: bigint;
  minPackageSizeUnits: bigint;
  maxPackageSizeUnits: bigint;
  maxFeeAtoms: bigint;
  expirySlot: bigint;
  remainingCapacity: bigint;
  active: boolean;
  side: number;
  quoteMode: number;
}>;

/** Zero-copy `QuoteLevelPage`: 32 naturally aligned 160-byte levels, then the shard key. */
export function decodeQuoteLevelPage(data: Uint8Array): Readonly<{ shard: string; levels: readonly QuoteLevelState[] }> {
  const r = new BorshReader(data, accountDiscriminator('QuoteLevelPage'), 'QuoteLevelPage');
  const levels: QuoteLevelState[] = [];
  for (let slotIndex = 0; slotIndex < MAX_QUOTE_LEVELS; slotIndex += 1) {
    const level = {
      slotIndex,
      settlementClassIdentityHash: r.hash(), reservationPolicyHash: r.hash(), referenceOffset: r.i128(),
      levelId: r.u64(), epoch: r.u64(), levelSequence: r.u64(), minPackageSizeUnits: r.u64(),
      maxPackageSizeUnits: r.u64(), maxFeeAtoms: r.u64(), expirySlot: r.u64(), remainingCapacity: r.u64(),
      active: r.u8() === 1, side: r.u8(), quoteMode: r.u8(),
    };
    r.take(13);
    levels.push(Object.freeze(level));
  }
  return Object.freeze({ shard: r.key(), levels: Object.freeze(levels) });
}

/** `ResourceIndex.active_record` and `CashCarrySeriesBindingIndex.active_record` offsets. */
export function decodeResourceIndexActiveRecord(data: Uint8Array): string {
  const r = new BorshReader(data, accountDiscriminator('ResourceIndex'), 'ResourceIndex');
  r.u8(); r.hash(); r.u32();
  return r.key();
}

export function decodeSeriesIndexActiveRecord(data: Uint8Array): string {
  const r = new BorshReader(data, accountDiscriminator('CashCarrySeriesBindingIndex'), 'CashCarrySeriesBindingIndex');
  r.hash(); r.u32();
  return r.key();
}

export function decodeTokenAccount(data: Uint8Array): Readonly<{ mint: string; owner: string; amount: bigint }> {
  const buffer = Buffer.from(data);
  if (buffer.length !== 165) fail('token account layout is invalid');
  return Object.freeze({
    mint: new PublicKey(buffer.subarray(0, 32)).toBase58(),
    owner: new PublicKey(buffer.subarray(32, 64)).toBase58(),
    amount: buffer.readBigUInt64LE(64),
  });
}

export type TestPerpMarketState = Readonly<{
  oracle: string;
  feedIdHex: string;
  collateralMint: string;
  collateralVault: string;
  feeVault: string;
  insuranceVault: string;
  collateralDecimals: number;
  baseDecimals: number;
  maxPriceAgeSeconds: number;
  maxConfidenceBps: number;
  takerFeeBps: number;
  halfSpreadBps: number;
  impactBpsPerUnit: number;
  maxSlippageBps: number;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  impactUnitLots: bigint;
  baseLotAtoms: bigint;
  quoteTickAtomsPerBaseLot: bigint;
  maxPositionLots: bigint;
  pauseOpens: boolean;
}>;

export function decodeTestPerpMarket(data: Uint8Array): TestPerpMarketState {
  const r = new BorshReader(data, accountDiscriminator('TestPerpMarket'), 'TestPerpMarket');
  r.key(); r.key();
  const collateralMint = r.key();
  const oracle = r.key();
  const feedIdHex = Buffer.from(r.hash()).toString('hex');
  const collateralVault = r.key();
  const feeVault = r.key();
  const insuranceVault = r.key();
  const collateralDecimals = r.u8();
  const baseDecimals = r.u8();
  const maxPriceAgeSeconds = r.u32();
  const maxConfidenceBps = r.u16();
  const takerFeeBps = r.u16();
  const halfSpreadBps = r.u16();
  const impactBpsPerUnit = r.u16();
  const maxSlippageBps = r.u16();
  const initialMarginBps = r.u16();
  const maintenanceMarginBps = r.u16();
  r.u16();
  const impactUnitLots = r.u64();
  const baseLotAtoms = r.u64();
  const quoteTickAtomsPerBaseLot = r.u64();
  const maxPositionLots = r.u64();
  r.take(64);
  const pauseOpens = r.bool();
  if (impactUnitLots === 0n || baseLotAtoms === 0n || quoteTickAtomsPerBaseLot === 0n) fail('market units are zero');
  return Object.freeze({
    oracle, feedIdHex, collateralMint, collateralVault, feeVault, insuranceVault, collateralDecimals, baseDecimals,
    maxPriceAgeSeconds, maxConfidenceBps, takerFeeBps, halfSpreadBps, impactBpsPerUnit, maxSlippageBps,
    initialMarginBps, maintenanceMarginBps, impactUnitLots, baseLotAtoms, quoteTickAtomsPerBaseLot, maxPositionLots, pauseOpens,
  });
}

export function decodeTestPerpPosition(data: Uint8Array): Readonly<{
  market: string; owner: string; delegate: string; collateralAtoms: bigint; baseLots: bigint; entryNotionalAtoms: bigint;
}> {
  const r = new BorshReader(data, accountDiscriminator('TestPerpPosition'), 'TestPerpPosition');
  return Object.freeze({
    market: r.key(), owner: r.key(), delegate: r.key(), collateralAtoms: r.u64(), baseLots: r.i64(), entryNotionalAtoms: r.u64(),
  });
}

/** The leading fields of naryx_core `OpenCashCarryPackage`. */
export function decodeOpenCashCarryPackage(data: Uint8Array): Readonly<{
  version: number; domain: DomainRef; trader: string; entryReceipt: string;
}> {
  const r = new BorshReader(data, accountDiscriminator('OpenCashCarryPackage'), 'OpenCashCarryPackage');
  return Object.freeze({ version: r.u8(), domain: r.domain(), trader: r.key(), entryReceipt: r.key() });
}

export function decodeTestPerpStrategyController(data: Uint8Array): Readonly<{ owner: string; controller: string; market: string; position: string }> {
  const r = new BorshReader(data, accountDiscriminator('TestPerpStrategy'), 'TestPerpStrategy');
  const owner = r.key();
  const controller = r.key();
  r.hash();
  return Object.freeze({ owner, controller, market: r.key(), position: r.key() });
}

/** Mirrors `oracle_price_per_lot`: exact oracle, receiver owner, Full verification, feed, age, confidence. */
export function testPerpOraclePricePerLot(
  market: TestPerpMarketState,
  oracle: Readonly<{ address: string; owner: string; data: Uint8Array }>,
  nowUnixSeconds: bigint,
): bigint {
  if (oracle.owner !== PYTH_RECEIVER_PROGRAM_ID || oracle.address !== market.oracle) fail('oracle account or owner mismatch');
  const data = Buffer.from(oracle.data);
  if (data.length < 41 + 92 || !data.subarray(0, 8).equals(PRICE_UPDATE_V2_DISCRIMINATOR)) fail('oracle is not PriceUpdateV2');
  if (data[40] !== 1) fail('oracle update is not fully verified');
  const feedIdHex = data.subarray(41, 73).toString('hex');
  const price = data.readBigInt64LE(73);
  const conf = data.readBigUInt64LE(81);
  const exponent = data.readInt32LE(89);
  const publishTime = data.readBigInt64LE(93);
  if (feedIdHex !== market.feedIdHex) fail('oracle feed mismatch');
  if (price <= 0n) fail('oracle price is not positive');
  if (publishTime + BigInt(market.maxPriceAgeSeconds) < nowUnixSeconds) fail('oracle price is stale');
  if (conf * BPS > price * BigInt(market.maxConfidenceBps)) fail('oracle confidence is too wide');
  const scale = exponent + market.collateralDecimals - market.baseDecimals;
  if (Math.abs(scale) > 36) fail('oracle exponent is out of range');
  const numerator = price * market.baseLotAtoms;
  const factor = 10n ** BigInt(Math.abs(scale));
  const perLot = scale >= 0 ? numerator * factor : numerator / factor;
  if (perLot <= 0n || perLot >= 1n << 64n) fail('oracle price per lot is out of range');
  return perLot;
}

export type TestPerpShortPricing = Readonly<{
  baseLots: bigint;
  fillPricePerLot: bigint;
  notionalAtoms: bigint;
  feeAtoms: bigint;
  initialMarginAtoms: bigint;
}>;

/** Mirrors `fill_price_per_lot` for an Ask, the taker fee, and the initial margin requirement. */
export function priceTestPerpShort(market: TestPerpMarketState, oraclePricePerLot: bigint, baseAtoms: bigint): TestPerpShortPricing {
  if (baseAtoms <= 0n || baseAtoms % market.baseLotAtoms !== 0n) fail('quantity is not an exact market lot');
  const baseLots = baseAtoms / market.baseLotAtoms;
  if (baseLots > market.maxPositionLots) fail('quantity exceeds the market position limit');
  const impactUnits = (baseLots + market.impactUnitLots - 1n) / market.impactUnitLots;
  const slippage = impactUnits * BigInt(market.impactBpsPerUnit) + BigInt(market.halfSpreadBps);
  if (slippage > BigInt(market.maxSlippageBps)) fail('quantity exceeds the market slippage bound');
  const fillPricePerLot = (oraclePricePerLot * (BPS - slippage)) / BPS;
  if (fillPricePerLot <= 0n) fail('fill price is zero');
  const notionalAtoms = fillPricePerLot * baseLots;
  return Object.freeze({
    baseLots,
    fillPricePerLot,
    notionalAtoms,
    feeAtoms: (notionalAtoms * BigInt(market.takerFeeBps) + BPS - 1n) / BPS,
    initialMarginAtoms: (oraclePricePerLot * baseLots * BigInt(market.initialMarginBps) + BPS - 1n) / BPS,
  });
}

/**
 * Buying back a short of `baseAtoms`: the test perp fills a bid at the oracle plus spread and impact,
 * rounded up like the venue's `mul_div_ceil`, and charges the taker fee rounded up.
 */
export function priceTestPerpCloseShort(market: TestPerpMarketState, oraclePricePerLot: bigint, baseAtoms: bigint): Readonly<{
  baseLots: bigint; fillPricePerLot: bigint; notionalAtoms: bigint; feeAtoms: bigint;
}> {
  if (baseAtoms <= 0n || baseAtoms % market.baseLotAtoms !== 0n) fail('quantity is not an exact market lot');
  const baseLots = baseAtoms / market.baseLotAtoms;
  const impactUnits = (baseLots + market.impactUnitLots - 1n) / market.impactUnitLots;
  const slippage = impactUnits * BigInt(market.impactBpsPerUnit) + BigInt(market.halfSpreadBps);
  if (slippage > BigInt(market.maxSlippageBps)) fail('quantity exceeds the market slippage bound');
  const fillPricePerLot = (oraclePricePerLot * (BPS + slippage) + BPS - 1n) / BPS;
  const notionalAtoms = fillPricePerLot * baseLots;
  return Object.freeze({
    baseLots,
    fillPricePerLot,
    notionalAtoms,
    feeAtoms: (notionalAtoms * BigInt(market.takerFeeBps) + BPS - 1n) / BPS,
  });
}

export function associatedTokenAddress(owner: PublicKey | string, mint: PublicKey | string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** `fill_commitment` from naryx_package_book consume_capacity, over the post-consumption sequences. */
export function packageFillCommitment(input: Readonly<{
  domain: DomainRef;
  shard: string;
  solver: string;
  solverId: string;
  consumerAuthority: string;
  seriesManifestHash: Uint8Array;
  executionClassManifestHash: Uint8Array;
  referenceStateHash: Uint8Array;
  level: QuoteLevelState;
  referenceSequence: bigint;
  shardSequenceAfter: bigint;
  packageSizeUnits: bigint;
  packagePrice: bigint;
  reservationId: Uint8Array;
  orderHash: Uint8Array;
  quoteHash: Uint8Array;
  routeHash: Uint8Array;
}>): Uint8Array {
  return sha256(
    Buffer.from('CON/v1/package-fill-commitment', 'ascii'),
    domainBytes(input.domain),
    new PublicKey(input.shard).toBytes(),
    new PublicKey(input.solver).toBytes(),
    protocolIdBytes(input.solverId),
    new PublicKey(input.consumerAuthority).toBytes(),
    input.seriesManifestHash,
    input.executionClassManifestHash,
    input.referenceStateHash,
    bigEndian(input.level.levelId, 8),
    bigEndian(input.level.levelSequence, 8),
    bigEndian(input.referenceSequence, 8),
    bigEndian(input.shardSequenceAfter, 8),
    bigEndian(input.level.epoch, 8),
    Uint8Array.of(input.level.side),
    bigEndian(input.packageSizeUnits, 8),
    bigEndian(input.packagePrice, 16, true),
    bigEndian(input.level.maxFeeAtoms, 8),
    input.level.settlementClassIdentityHash,
    Uint8Array.of(input.level.quoteMode),
    input.level.reservationPolicyHash,
    input.reservationId,
    input.orderHash,
    input.quoteHash,
    input.routeHash,
  );
}
