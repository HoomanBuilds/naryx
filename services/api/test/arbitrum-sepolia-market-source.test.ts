import assert from "node:assert/strict";
import test from "node:test";
import { createArbitrumSepoliaMarketSource, type ArbitrumSepoliaMarketSnapshot } from "../src/arbitrum-sepolia-market-source.js";

const config = {
  contextId: "arbitrum-sepolia:eth-usdc:gmx",
  baseAsset: { assetId: "arbitrum-sepolia:weth", assetManifestHash: new Uint8Array(32), decimals: 18 },
  quoteAsset: { assetId: "naryx-gmx-usdc-sg", assetManifestHash: new Uint8Array(32), decimals: 6 },
  maximumQuantityAtoms: 10n ** 18n,
  maxSlippageBps: 100,
  maxStalenessSeconds: 3_600n,
} as unknown as Parameters<typeof createArbitrumSepoliaMarketSource>[0];
// 2,741.69 USD with 8 feed decimals.
const reference = { latest: () => ({ answer: 274_169_000_000n, decimals: 8, updatedAt: 1n, observedAt: 1n }) };

function sqrtX96(token1PerToken0: number): bigint {
  return BigInt(Math.round(Math.sqrt(token1PerToken0) * 2 ** 48)) * 2n ** 48n;
}

function pool(baseIsToken0: boolean): ArbitrumSepoliaMarketSnapshot {
  // 2,740 USDC per WETH: 2740e6 quote atoms per 1e18 base atoms.
  const price = 2_740e6 / 1e18;
  return { sqrtPriceX96: sqrtX96(baseIsToken0 ? price : 1 / price), baseIsToken0, poolFee: 100n, positionFeeFactor: 6n * 10n ** 26n, observedAtMs: 5 };
}

test("Arbitrum market source prices spot from either pool token order and shows GMX and pool fees", () => {
  for (const baseIsToken0 of [true, false]) {
    const source = createArbitrumSepoliaMarketSource(config, reference, { latest: () => pool(baseIsToken0) });
    const observation = source.latest();
    assert.ok(observation !== undefined);
    assert.ok(Math.abs(Number(observation.spotBid) - 2_740) < 0.01, `spot ${observation.spotBid}`);
    assert.equal(observation.perpBid, "2741.69");
    assert.equal(observation.spotTakerRate, "0.0001");
    assert.equal(observation.perpTakerRate, "0.0006");
    assert.equal(observation.capturedAtMs, 5);
  }
  // GMX's own execution prices for opening and closing the largest short replace the reference.
  const impacted = createArbitrumSepoliaMarketSource(config, reference, {
    latest: () => ({ ...pool(true), gmxShortOpenPrice: 2_330_000_000_000_000n, gmxShortClosePrice: 2_740_500_000_000_000n }),
  }).latest();
  assert.deepEqual([impacted?.perpBid, impacted?.perpAsk], ["2330", "2740.5"]);
  const source = createArbitrumSepoliaMarketSource(config, reference, { latest: () => pool(true) });
  assert.equal(source.descriptor.baseSymbol, "WETH");
  // An asset id without a plain symbol segment shows the fallback instead of failing startup.
  assert.equal(source.descriptor.quoteSymbol, "USDC");
  assert.equal(createArbitrumSepoliaMarketSource(config, { latest: () => undefined }, { latest: () => pool(true) }).latest(), undefined);
});
