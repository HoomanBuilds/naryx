import assert from "node:assert/strict";
import test from "node:test";
import { assetRef, domainRef } from "@naryx/protocol-types";
import { bindNativeHyperliquidStrategyRuntime } from "../src/http-server.js";

test("native runtime metadata uses the exact reviewed strategy profile, not the default carry series", () => {
  const domain = domainRef("hypercore:testnet", 1, new Uint8Array(32).fill(1));
  const baseAsset = assetRef("btc", new Uint8Array(32).fill(2), 10);
  const quoteAsset = assetRef("usdc", new Uint8Array(32).fill(3), 8);
  const runtime = { domain, baseAsset, quoteAsset, market: {}, bounds: { maxEvidenceAgeMs: 600_000, maxSnapshotSkewMs: 10_000, maxFillPages: 16 },
    seriesManifestHash: "04".repeat(32), executionClassManifestHash: "05".repeat(32) } as unknown as Parameters<typeof bindNativeHyperliquidStrategyRuntime>[0];
  const profile = { domain, baseAsset, quoteAsset, templateId: "external-inventory-hedge-v1", templateVersion: 1,
    seriesId: "treasury", seriesVersion: 1, seriesManifestHash: new Uint8Array(32).fill(6),
    executionClassId: "treasury-ioc", executionClassVersion: 1, executionClassManifestHash: new Uint8Array(32).fill(7),
    packageTemplateManifestHash: new Uint8Array(32).fill(8), settlementAccount: `0x${"11".repeat(20)}` };
  const admission = { order: profile } as unknown as Parameters<typeof bindNativeHyperliquidStrategyRuntime>[1];
  const profiles = [profile] as unknown as Parameters<typeof bindNativeHyperliquidStrategyRuntime>[2];
  const bound = bindNativeHyperliquidStrategyRuntime(runtime, admission, profiles);
  assert.equal(bound.seriesManifestHash, "06".repeat(32));
  assert.equal(bound.executionClassManifestHash, "07".repeat(32));
  assert.equal(bound.market, runtime.market);
  assert.equal(bound.bounds.maxEvidenceAgeMs, 300_000);
  assert.equal(runtime.bounds.maxEvidenceAgeMs, 600_000);
  assert.equal(runtime.seriesManifestHash, "04".repeat(32));
  assert.throws(() => bindNativeHyperliquidStrategyRuntime(runtime, admission, []), /No reviewed native runtime profile/);
  for (const change of [{ seriesVersion: 2 }, { settlementAccount: `0x${"22".repeat(20)}` }]) {
    assert.throws(() => bindNativeHyperliquidStrategyRuntime(runtime,
      { order: { ...profile, ...change } } as unknown as typeof admission, profiles), /No reviewed native runtime profile/);
  }
  const anotherOwner = `0x${'22'.repeat(20)}`;
  const personal = { order: { ...profile, owner: anotherOwner, settlementAccount: anotherOwner } } as unknown as typeof admission;
  assert.equal(bindNativeHyperliquidStrategyRuntime(runtime, personal, profiles, 'PER_USER').seriesManifestHash, '06'.repeat(32));
  assert.throws(() => bindNativeHyperliquidStrategyRuntime(runtime,
    { order: { ...personal.order, settlementAccount: profile.settlementAccount } } as typeof admission, profiles, 'PER_USER'), /signed owner account/);
  assert.throws(() => bindNativeHyperliquidStrategyRuntime(runtime,
    { order: { ...personal.order, seriesVersion: 2 } } as typeof admission, profiles, 'PER_USER'), /No reviewed native runtime profile/);
});
