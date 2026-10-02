import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adapterRef, assetRef, toProtocolJson } from "@naryx/protocol-types";
import { baseSepoliaSpotAsk, loadBaseSepoliaOrderContextConfig } from "../src/base-sepolia-order-context.js";

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

test("refuses at load a spread cap that every order would reject as not in lowest terms", () => {
  const directory = mkdtempSync(join(tmpdir(), "naryx-base-context-"));
  const adapter = adapterRef({ adapterId: "spot", adapterManifestVersion: 1, adapterManifestHash: new Uint8Array(32).fill(3) });
  const config = (quoteAtoms: bigint, baseAtoms: bigint) => ({
    schemaVersion: 1, contextId: "base-sepolia:weth-usdc", orderVersion: 1, templateId: "cash-and-carry-v1", templateVersion: 1,
    packageTemplateManifestHash: new Uint8Array(32).fill(4), baseAsset: base, quoteAsset: quote,
    spotAdapter: adapter, perpetualAdapter: adapter, maxStalenessSeconds: 60n, pollIntervalMs: 5_000, expiryTtlSeconds: 600n,
    maxEntrySpread: { baseAsset: base, quoteAsset: quote, quoteAtoms, baseAtoms, roundingDirection: "CEIL" },
    maximumQuantityAtoms: 10n ** 17n, maxSlippageBps: 100, maxVenueFeeAtomsByAsset: [{ asset: quote, maxAtoms: 10_000_000n }],
    maxMarginAddedAtoms: 10n ** 9n, maxProtocolFeeAtoms: 0n, maxSolverFeeAtoms: 0n, maxPriorityFeeAtoms: 0n, maxAccountFundingAtoms: 10n ** 10n,
  });
  const write = (name: string, value: unknown) => {
    const path = join(directory, name);
    writeFileSync(path, JSON.stringify(toProtocolJson(value)));
    return path;
  };
  try {
    // 50 quote per base written as 50,000,000 / 10^18 instead of 1 / 20,000,000,000.
    assert.throws(() => loadBaseSepoliaOrderContextConfig(write("unreduced.json", config(50_000_000n, 10n ** 18n))), /maxEntrySpread is invalid/);
    assert.equal(loadBaseSepoliaOrderContextConfig(write("reduced.json", config(1n, 20_000_000_000n))).maxEntrySpread.baseAtoms, 20_000_000_000n);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
