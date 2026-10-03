import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adapterRef, assetRef, toProtocolJson } from "@naryx/protocol-types";
import { loadArbitrumSepoliaOrderContextConfig } from "../src/arbitrum-sepolia-order-context.js";

const base = assetRef("weth", new Uint8Array(32).fill(1), 18);
const quote = assetRef("usdc", new Uint8Array(32).fill(2), 6);

test("refuses at load an Arbitrum spread cap that every order would reject as not in lowest terms", () => {
  const directory = mkdtempSync(join(tmpdir(), "naryx-arbitrum-context-"));
  const adapter = adapterRef({ adapterId: "gmx", adapterManifestVersion: 1, adapterManifestHash: new Uint8Array(32).fill(3) });
  const config = (quoteAtoms: bigint, baseAtoms: bigint) => ({
    schemaVersion: 1, contextId: "arbitrum-sepolia:eth-usdc:gmx", orderVersion: 1, templateId: "cash-and-carry-v1", templateVersion: 1,
    packageTemplateManifestHash: new Uint8Array(32).fill(4), baseAsset: base, quoteAsset: quote,
    spotAdapter: adapter, perpetualAdapter: adapter,
    priceFeed: { address: `0x${"d3".repeat(20)}`, expectedCodeHash: `0x${"d4".repeat(32)}` }, priceFeedDecimals: 8,
    spotQuoter: { address: `0x${"c5".repeat(20)}`, expectedCodeHash: `0x${"c6".repeat(32)}` },
    maxStalenessSeconds: 600n, pollIntervalMs: 5_000, expiryTtlSeconds: 900n,
    maxEntrySpread: { baseAsset: base, quoteAsset: quote, quoteAtoms, baseAtoms, roundingDirection: "CEIL" },
    maximumQuantityAtoms: 10n ** 17n, maxSlippageBps: 100, maxVenueFeeAtomsByAsset: [{ asset: quote, maxAtoms: 10_000_000n }],
    maxMarginAddedAtoms: 10n ** 9n, maxProtocolFeeAtoms: 0n, maxSolverFeeAtoms: 0n, maxPriorityFeeAtoms: 0n,
  });
  const write = (name: string, value: unknown) => {
    const path = join(directory, name);
    writeFileSync(path, JSON.stringify(toProtocolJson(value)));
    return path;
  };
  try {
    // 50 quote per base written as 50,000,000 / 10^18 instead of 1 / 20,000,000,000.
    assert.throws(() => loadArbitrumSepoliaOrderContextConfig(write("unreduced.json", config(50_000_000n, 10n ** 18n))), /maxEntrySpread is invalid/);
    assert.equal(loadArbitrumSepoliaOrderContextConfig(write("reduced.json", config(1n, 20_000_000_000n))).maxEntrySpread.baseAtoms, 20_000_000_000n);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
