import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

/**
 * Read-only layouts and pricing for the Naryx Devnet test perp (`naryx_test_perp`) and its Pyth
 * Solana Receiver `PriceUpdateV2` oracle. Every rule mirrors the program: the exact oracle account
 * and owner, Full verification, the feed id, a positive price, `publish_time + max_age >= now`, and
 * `conf * 10000 <= max_confidence_bps * price`. Amounts are integer atoms; nothing here signs.
 */

export const PYTH_RECEIVER_PROGRAM_ID = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
export const SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
export const SOLANA_DEVNET_SOL_USD_FEED_ID_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PRICE_UPDATE_V2_DISCRIMINATOR = Uint8Array.of(34, 241, 35, 99, 157, 126, 244, 205);
const BPS = 10_000n;
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export type PythPriceMessage = Readonly<{
  feedIdHex: string;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
}>;

export type TestPerpMarketState = Readonly<{
  owner: string;
  collateralMint: string;
  oracle: string;
  feedIdHex: string;
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

export type TestPerpPositionState = Readonly<{
  market: string;
  owner: string;
  delegate: string;
  collateralAtoms: bigint;
  baseLots: bigint;
}>;

export type TestPerpStrategyState = Readonly<{
  owner: string;
  controller: string;
  strategyIdHex: string;
  market: string;
  position: string;
  maxBaseLots: bigint;
}>;

function fail(message: string): never {
  throw new Error(`Solana Devnet test perp: ${message}`);
}

export function anchorAccountDiscriminator(name: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(`account:${name}`).digest().subarray(0, 8));
}

export function anchorInstructionDiscriminator(name: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8));
}

class Reader {
  readonly #data: Buffer;
  #offset: number;

  constructor(data: Uint8Array, discriminator: Uint8Array, name: string) {
    const buffer = Buffer.from(data);
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(Buffer.from(discriminator))) fail(`${name} discriminator mismatch`);
    this.#data = buffer;
    this.#offset = 8;
  }

  #take(length: number): Buffer {
    if (this.#offset + length > this.#data.length) fail("account data is truncated");
    const slice = this.#data.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }

  key(): string { return new PublicKey(this.#take(32)).toBase58(); }
  bytes32Hex(): string { return this.#take(32).toString("hex"); }
  u8(): number { return this.#take(1).readUInt8(0); }
  u16(): number { return this.#take(2).readUInt16LE(0); }
  u32(): number { return this.#take(4).readUInt32LE(0); }
  u64(): bigint { return this.#take(8).readBigUInt64LE(0); }
  i64(): bigint { return this.#take(8).readBigInt64LE(0); }
  skip(length: number): void { this.#take(length); }
  bool(): boolean {
    const value = this.u8();
    if (value > 1) fail("boolean byte is invalid");
    return value === 1;
  }
}

export function decodePythPriceUpdateV2(data: Uint8Array): PythPriceMessage {
  const buffer = Buffer.from(data);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(Buffer.from(PRICE_UPDATE_V2_DISCRIMINATOR))) {
    fail("oracle is not a PriceUpdateV2 account");
  }
  const level = buffer[40];
  if (level === 0) fail("oracle update is not fully verified");
  if (level !== 1) fail("oracle verification level is invalid");
  const start = 41;
  if (buffer.length < start + 92) fail("oracle message is truncated");
  return Object.freeze({
    feedIdHex: buffer.subarray(start, start + 32).toString("hex"),
    price: buffer.readBigInt64LE(start + 32),
    conf: buffer.readBigUInt64LE(start + 40),
    exponent: buffer.readInt32LE(start + 48),
    publishTime: buffer.readBigInt64LE(start + 52),
  });
}

export function decodeTestPerpMarket(data: Uint8Array): TestPerpMarketState {
  const reader = new Reader(data, anchorAccountDiscriminator("TestPerpMarket"), "TestPerpMarket");
  const owner = reader.key();
  reader.skip(32);
  const collateralMint = reader.key();
  const oracle = reader.key();
  const feedIdHex = reader.bytes32Hex();
  const collateralVault = reader.key();
  const feeVault = reader.key();
  const insuranceVault = reader.key();
  const collateralDecimals = reader.u8();
  const baseDecimals = reader.u8();
  const maxPriceAgeSeconds = reader.u32();
  const maxConfidenceBps = reader.u16();
  const takerFeeBps = reader.u16();
  const halfSpreadBps = reader.u16();
  const impactBpsPerUnit = reader.u16();
  const maxSlippageBps = reader.u16();
  const initialMarginBps = reader.u16();
  const maintenanceMarginBps = reader.u16();
  reader.u16();
  const impactUnitLots = reader.u64();
  const baseLotAtoms = reader.u64();
  const quoteTickAtomsPerBaseLot = reader.u64();
  const maxPositionLots = reader.u64();
  reader.skip(8 + 8 + 16 + 8 + 8 + 8 + 8);
  const pauseOpens = reader.bool();
  if (impactUnitLots === 0n || baseLotAtoms === 0n || quoteTickAtomsPerBaseLot === 0n) fail("market units are zero");
  return Object.freeze({
    owner, collateralMint, oracle, feedIdHex, collateralVault, feeVault, insuranceVault,
    collateralDecimals, baseDecimals, maxPriceAgeSeconds, maxConfidenceBps, takerFeeBps, halfSpreadBps,
    impactBpsPerUnit, maxSlippageBps, initialMarginBps, maintenanceMarginBps, impactUnitLots, baseLotAtoms,
    quoteTickAtomsPerBaseLot, maxPositionLots, pauseOpens,
  });
}

export function decodeTestPerpPosition(data: Uint8Array): TestPerpPositionState {
  const reader = new Reader(data, anchorAccountDiscriminator("TestPerpPosition"), "TestPerpPosition");
  return Object.freeze({
    market: reader.key(),
    owner: reader.key(),
    delegate: reader.key(),
    collateralAtoms: reader.u64(),
    baseLots: reader.i64(),
  });
}

export function decodeTestPerpStrategy(data: Uint8Array): TestPerpStrategyState {
  const reader = new Reader(data, anchorAccountDiscriminator("TestPerpStrategy"), "TestPerpStrategy");
  return Object.freeze({
    owner: reader.key(),
    controller: reader.key(),
    strategyIdHex: reader.bytes32Hex(),
    market: reader.key(),
    position: reader.key(),
    maxBaseLots: reader.u64(),
  });
}

/** SPL Token account amount, mint, and owner; legacy Token program layout. */
export function decodeTokenAccount(data: Uint8Array): Readonly<{ mint: string; owner: string; amount: bigint }> {
  const buffer = Buffer.from(data);
  if (buffer.length !== 165) fail("token account layout is invalid");
  return Object.freeze({
    mint: new PublicKey(buffer.subarray(0, 32)).toBase58(),
    owner: new PublicKey(buffer.subarray(32, 64)).toBase58(),
    amount: buffer.readBigUInt64LE(64),
  });
}

/** Validates the oracle exactly as the program does and returns collateral atoms per base lot (floor). */
export function testPerpOraclePricePerLot(
  market: TestPerpMarketState,
  oracle: Readonly<{ address: string; owner: string; data: Uint8Array }>,
  nowUnixSeconds: bigint,
): Readonly<{ pricePerLot: bigint; message: PythPriceMessage }> {
  if (oracle.owner !== PYTH_RECEIVER_PROGRAM_ID) fail("oracle owner is not the Pyth receiver");
  if (oracle.address !== market.oracle) fail("oracle account does not match the market");
  const message = decodePythPriceUpdateV2(oracle.data);
  if (message.feedIdHex !== market.feedIdHex) fail("oracle feed id does not match the market");
  if (message.price <= 0n) fail("oracle price is not positive");
  if (message.publishTime + BigInt(market.maxPriceAgeSeconds) < nowUnixSeconds) fail("oracle price is stale");
  if (message.conf * BPS > message.price * BigInt(market.maxConfidenceBps)) fail("oracle confidence is too wide");
  const scale = message.exponent + market.collateralDecimals - market.baseDecimals;
  if (Math.abs(scale) > 36) fail("oracle exponent is out of range");
  const numerator = message.price * market.baseLotAtoms;
  const factor = 10n ** BigInt(Math.abs(scale));
  const pricePerLot = scale >= 0 ? numerator * factor : numerator / factor;
  if (pricePerLot <= 0n || pricePerLot > (1n << 64n) - 1n) fail("oracle price per lot is out of range");
  return Object.freeze({ pricePerLot, message });
}

/** Spread plus size impact in bps, as `fill_price_per_lot` computes it; fails above max slippage. */
export function testPerpSlippageBps(market: TestPerpMarketState, baseLots: bigint): bigint {
  if (baseLots <= 0n) fail("order size must be positive");
  const impactUnits = (baseLots + market.impactUnitLots - 1n) / market.impactUnitLots;
  const slippage = impactUnits * BigInt(market.impactBpsPerUnit) + BigInt(market.halfSpreadBps);
  if (slippage > BigInt(market.maxSlippageBps)) fail("order size exceeds the market slippage bound");
  return slippage;
}

export type TestPerpShortEntry = Readonly<{
  baseLots: bigint;
  fillPricePerLot: bigint;
  notionalAtoms: bigint;
  feeAtoms: bigint;
  initialMarginAtoms: bigint;
}>;

/** A market sell (short open) for `baseAtoms`, with the venue taker fee and initial margin, all in atoms. */
export function priceTestPerpShortEntry(market: TestPerpMarketState, oraclePricePerLot: bigint, baseAtoms: bigint): TestPerpShortEntry {
  if (baseAtoms <= 0n || baseAtoms % market.baseLotAtoms !== 0n) fail("quantity is not an exact market lot");
  const baseLots = baseAtoms / market.baseLotAtoms;
  if (baseLots > market.maxPositionLots) fail("quantity exceeds the market position limit");
  const slippage = testPerpSlippageBps(market, baseLots);
  const fillPricePerLot = (oraclePricePerLot * (BPS - slippage)) / BPS;
  if (fillPricePerLot <= 0n) fail("fill price is zero");
  const notionalAtoms = fillPricePerLot * baseLots;
  const feeAtoms = (notionalAtoms * BigInt(market.takerFeeBps) + BPS - 1n) / BPS;
  const markAtoms = oraclePricePerLot * baseLots;
  const initialMarginAtoms = (markAtoms * BigInt(market.initialMarginBps) + BPS - 1n) / BPS;
  return Object.freeze({ baseLots, fillPricePerLot, notionalAtoms, feeAtoms, initialMarginAtoms });
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export type SolanaDevnetTraderAccounts = Readonly<{
  trader: string;
  position: string;
  strategy: string;
  executorAuthority: string;
  openPackage: string;
  traderBase: string;
  traderQuote: string;
  executorBase: string;
  executorQuote: string;
}>;

/**
 * Every per-trader account is a PDA or associated token account of the connected wallet, so any
 * wallet can trade through its own strategy without operator configuration.
 */
export function deriveSolanaDevnetTraderAccounts(input: Readonly<{
  owner: string;
  strategyIdHex: string;
  market: string;
  coreProgram: string;
  perpAdapterProgram: string;
  perpVenueProgram: string;
  baseMint: string;
  quoteMint: string;
}>): SolanaDevnetTraderAccounts {
  if (!/^[0-9a-f]{64}$/.test(input.strategyIdHex) || /^0+$/.test(input.strategyIdHex)) fail("strategy id is invalid");
  const owner = new PublicKey(input.owner);
  const market = new PublicKey(input.market);
  const core = new PublicKey(input.coreProgram);
  const position = PublicKey.findProgramAddressSync(
    [Buffer.from("test-perp-position"), market.toBuffer(), owner.toBuffer()],
    new PublicKey(input.perpVenueProgram),
  )[0];
  const strategy = PublicKey.findProgramAddressSync(
    [Buffer.from("test-perp-strategy"), owner.toBuffer(), Buffer.from(input.strategyIdHex, "hex")],
    new PublicKey(input.perpAdapterProgram),
  )[0];
  const executorAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("cash-carry-executor"), owner.toBuffer(), strategy.toBuffer()],
    core,
  )[0];
  const openPackage = PublicKey.findProgramAddressSync(
    [Buffer.from("cash-carry-open"), owner.toBuffer(), strategy.toBuffer()],
    core,
  )[0];
  const baseMint = new PublicKey(input.baseMint);
  const quoteMint = new PublicKey(input.quoteMint);
  return Object.freeze({
    trader: owner.toBase58(),
    position: position.toBase58(),
    strategy: strategy.toBase58(),
    executorAuthority: executorAuthority.toBase58(),
    openPackage: openPackage.toBase58(),
    traderBase: associatedTokenAddress(owner, baseMint).toBase58(),
    traderQuote: associatedTokenAddress(owner, quoteMint).toBase58(),
    executorBase: associatedTokenAddress(executorAuthority, baseMint).toBase58(),
    executorQuote: associatedTokenAddress(executorAuthority, quoteMint).toBase58(),
  });
}
