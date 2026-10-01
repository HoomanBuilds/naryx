import assert from "node:assert/strict";
import test from "node:test";
import { assetRef } from "@naryx/protocol-types";
import { deriveHyperliquidTestnetLivePrices, type HyperliquidTestnetRuntimeConfig } from "../src/index.js";
import {
  createHyperliquidTestnetMarketSource,
  type TerminalMarketSources,
} from "../src/private-terminal-manifest.js";
import {
  createTerminalPreview,
  TerminalMarketUnavailableError,
  type TerminalMarketContext,
} from "../src/terminal-preview.js";
import { createTerminalSnapshot } from "../src/terminal-snapshot.js";

const NOW_MS = 1_800_000_000_000;
const MAX_STALENESS_MS = 5_000;
const BASE = assetRef("hypercore:testnet:btc", "31".repeat(32), 5);
const QUOTE = assetRef("hypercore:testnet:usdc", "32".repeat(32), 6);
const BOOKS = {
  spot: { bid: "99.5", ask: "100.3" },
  perp: { bid: "100.9", ask: "101.1" },
  spotTakerRate: "0.0007",
  perpTakerRate: "0.00035",
};

function sources(capturedAtMs: number): TerminalMarketSources {
  const config = {
    orderContext: {
      contextId: "hyperliquid:testnet:btc-carry-v1",
      baseAsset: BASE,
      quoteAsset: QUOTE,
      maximumQuantityAtoms: 10_000_000n,
      maxSlippageBps: 50,
      maxStalenessMs: BigInt(MAX_STALENESS_MS),
    },
  } as unknown as HyperliquidTestnetRuntimeConfig;
  return { hyperliquid: createHyperliquidTestnetMarketSource(config, { latest: () => ({ ...BOOKS, capturedAtMs }) }) };
}

function context(capturedAtMs: number): TerminalMarketContext {
  return { sources: sources(capturedAtMs), nowMs: NOW_MS, executionAvailable: () => false };
}

function request(mode: "entry" | "exit") {
  return { domain: "hyperliquid", mode, size: "1.23457", slippageBps: 10, quoteMode: "coordinated_limits" } as const;
}

test("live preview bounds and fees are exact with tested rounding direction", () => {
  const entry = createTerminalPreview(request("entry"), context(NOW_MS - MAX_STALENESS_MS));
  // ceil(123457 * 100.3 * 1.001) = ceil(123951198.371) quote atoms; a floor would read ...198.
  assert.equal(entry.bound.quoteAtoms, "123951199");
  assert.equal(entry.bound.value, "123.951199");
  const prices = deriveHyperliquidTestnetLivePrices(BASE, QUOTE, { ...BOOKS, capturedAtMs: NOW_MS }, 50, 200, 1);
  const reference = prices.spotReferencePrice;
  const canonical = (123_457n * reference.quoteAtoms * 10_010n + reference.baseAtoms * 10_000n - 1n) /
    (reference.baseAtoms * 10_000n);
  assert.equal(entry.bound.quoteAtoms, canonical.toString());
  assert.deepEqual(entry.fees.map((fee) => fee.amountAtoms), ["86680", "43599"]);
  assert.deepEqual(entry.totalFee, { amountAtoms: "130279", value: "0.130279", symbol: "USDC" });
  assert.deepEqual(entry.size, { baseAtoms: "123457", value: "1.23457", symbol: "BTC" });
  assert.deepEqual(entry.legs.map((leg) => [leg.quantity, leg.limit]), [
    ["1.23457 BTC", "$100.4003"],
    ["1.23457 BTC", "$100.7991"],
  ]);
  assert.equal(entry.evidenceGrade, "OBSERVED_UNATTESTED");
  assert.equal(entry.capturedAt, new Date(NOW_MS - MAX_STALENESS_MS).toISOString());

  // floor(123457 * 99.5 * 0.999) = floor(122716875.285).
  const exit = createTerminalPreview(request("exit"), context(NOW_MS));
  assert.equal(exit.bound.quoteAtoms, "122716875");

  const snapshot = createTerminalSnapshot("hyperliquid", context(NOW_MS));
  assert.deepEqual(snapshot.market.metrics.slice(0, 4).map((metric) => metric.value), [
    "$99.90", "$101.00", "+110.11 bps", "7 / 3.5 bps",
  ]);
  assert.equal(snapshot.domains.find((domain) => domain.id === "hyperliquid")?.state, "Live");
});

test("stale observations and domains without a live source answer unavailable", () => {
  const stale = context(NOW_MS - MAX_STALENESS_MS - 1);
  const code = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      assert.ok(error instanceof TerminalMarketUnavailableError);
      return error.code;
    }
    assert.fail("expected an unavailable market");
  };
  assert.equal(code(() => createTerminalPreview(request("entry"), stale)), "PREVIEW_UNAVAILABLE");
  assert.equal(code(() => createTerminalSnapshot("hyperliquid", stale)), "SNAPSHOT_UNAVAILABLE");
  assert.equal(code(() => createTerminalPreview(request("entry"), context(NOW_MS + 1))), "PREVIEW_UNAVAILABLE");
  assert.equal(
    code(() => createTerminalPreview({ ...request("entry"), domain: "solana" }, context(NOW_MS))),
    "DOMAIN_MARKET_UNAVAILABLE",
  );
});
