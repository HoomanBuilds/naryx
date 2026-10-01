import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { solanaDevnetBindingSlotWithinWindow } from "../src/solana-devnet-context-provider.js";
import {
  PYTH_RECEIVER_PROGRAM_ID,
  SOLANA_DEVNET_SOL_USD_FEED_ID_HEX,
  SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT,
  decodeTestPerpMarket,
  priceTestPerpShortEntry,
  testPerpOraclePricePerLot,
} from "../src/solana-devnet-test-perp.js";

const key = (byte: number) => Buffer.from(new Uint8Array(32).fill(byte));

function marketData(): Buffer {
  const u16 = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
  const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
  const u64 = (value: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(value); return b; };
  return Buffer.concat([
    createHash("sha256").update("account:TestPerpMarket").digest().subarray(0, 8),
    key(1), key(2), key(3), new PublicKey(SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT).toBuffer(),
    Buffer.from(SOLANA_DEVNET_SOL_USD_FEED_ID_HEX, "hex"), key(4), key(5), key(6),
    Buffer.from([6, 9]), u32(60), u16(50), u16(5), u16(2), u16(1), u16(100), u16(1000), u16(500), u16(100),
    u64(10_000n), u64(1_000_000n), u64(1n), u64(1_000_000n),
    Buffer.alloc(64), Buffer.from([0, 255]),
  ]);
}

// Pyth PriceUpdateV2: discriminator, write authority, Full verification, then the price message.
function oracleData(price: bigint, conf: bigint, publishTime: bigint, level = 1): Buffer {
  const message = Buffer.alloc(92);
  Buffer.from(SOLANA_DEVNET_SOL_USD_FEED_ID_HEX, "hex").copy(message, 0);
  message.writeBigInt64LE(price, 32);
  message.writeBigUInt64LE(conf, 40);
  message.writeInt32LE(-8, 48);
  message.writeBigInt64LE(publishTime, 52);
  return Buffer.concat([Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]), key(9), Buffer.from([level]), message, Buffer.alloc(8)]);
}

test("prices the test perp from a fully verified, fresh, tight Pyth SOL/USD update", () => {
  const market = decodeTestPerpMarket(marketData());
  const oracle = (data: Buffer) => ({ address: SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT, owner: PYTH_RECEIVER_PROGRAM_ID, data });
  // $150.00000000 with expo -8, 6-decimal USDC collateral, 9-decimal SOL, 0.001 SOL lots: 150000 atoms per lot.
  const priced = testPerpOraclePricePerLot(market, oracle(oracleData(15_000_000_000n, 1_000_000n, 1_000n)), 1_030n);
  assert.equal(priced.pricePerLot, 150_000n);
  const entry = priceTestPerpShortEntry(market, priced.pricePerLot, 2_000_000_000n);
  // 2000 lots: spread 2 bps + 1 bps impact, sell fill floor(150000 * 9997 / 10000), fee ceil(5 bps).
  assert.equal(entry.fillPricePerLot, 149_955n);
  assert.equal(entry.notionalAtoms, 299_910_000n);
  assert.equal(entry.feeAtoms, 149_955n);
  assert.equal(entry.initialMarginAtoms, 30_000_000n);
  assert.throws(() => testPerpOraclePricePerLot(market, oracle(oracleData(15_000_000_000n, 1_000_000n, 1_000n)), 1_061n), /stale/);
  assert.throws(() => testPerpOraclePricePerLot(market, oracle(oracleData(15_000_000_000n, 80_000_000n, 1_000n)), 1_030n), /confidence/);
  assert.throws(() => testPerpOraclePricePerLot(market, oracle(oracleData(15_000_000_000n, 1n, 1_000n, 0)), 1_030n), /not fully verified/);
  assert.throws(() => testPerpOraclePricePerLot(market, { ...oracle(oracleData(1n, 0n, 1_000n)), owner: key(8).toString("hex") }, 1_030n), /owner/);
});

test("accepts a binding slot only inside the bounded window around the admission slot", () => {
  assert.equal(solanaDevnetBindingSlotWithinWindow(1_000n, 1_000n), true);
  assert.equal(solanaDevnetBindingSlotWithinWindow(1_000n, 1_160n), true);
  assert.equal(solanaDevnetBindingSlotWithinWindow(1_000n, 1_161n), false);
  assert.equal(solanaDevnetBindingSlotWithinWindow(1_000n, 968n), true);
  assert.equal(solanaDevnetBindingSlotWithinWindow(1_000n, 967n), false);
});
