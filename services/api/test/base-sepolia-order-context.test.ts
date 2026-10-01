import assert from "node:assert/strict";
import test from "node:test";
import { assetRef } from "@naryx/protocol-types";
import { baseSepoliaSpotAsk } from "../src/base-sepolia-order-context.js";

const base = assetRef("weth", new Uint8Array(32).fill(1), 18);
const quote = assetRef("usdc", new Uint8Array(32).fill(2), 6);
const Q96 = 1n << 96n;

test("prices the Uniswap ask from slot0 in either token order and adds the pool fee", () => {
  // Base is token0 at one quote atom per base atom; the 0.3% fee scales the ask to 1003/1000.
  const token0 = baseSepoliaSpotAsk(base, quote, { sqrtPriceX96: Q96, baseIsToken0: true, poolFee: 3_000n });
  assert.equal(token0.quoteAtoms * 1_000n, token0.baseAtoms * 1_003n);
  assert.equal(token0.roundingDirection, "CEIL");
  // Base is token1 and sqrtP = 2: token1 per token0 is 4, so quote per base is 1/4 before the fee.
  const token1 = baseSepoliaSpotAsk(base, quote, { sqrtPriceX96: 2n * Q96, baseIsToken0: false, poolFee: 3_000n });
  assert.equal(token1.quoteAtoms * 4_000n, token1.baseAtoms * 1_003n);
  assert.throws(() => baseSepoliaSpotAsk(base, quote, { sqrtPriceX96: 0n, baseIsToken0: true, poolFee: 0n }), /positive/);
});
