import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assetAmount, builderAttributionHash, builderManifestHash, packageReceiptHash, type BuilderAttributionInput, type BuilderManifestInput } from "@naryx/protocol-types";
import { SqliteBuilderStore, SqliteEvidenceStore } from "../src/index.js";
import { manifest as evidenceManifest, outcome, receipt, signedOrder, terms, usdc } from "./evidence-fixtures.js";

test("builders register signed manifests, owners attribute orders, and only capped fees on settled receipts count", () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-builders-"));
  const evidence = new SqliteEvidenceStore(join(dir, "evidence.sqlite"), { clock: () => 1_000 });
  const builders = new SqliteBuilderStore(join(dir, "builders.sqlite"), { environment: "testnet", evidence, clock: () => 1_000 });
  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const identityKey = new Uint8Array((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
    const signed = (overrides: Partial<BuilderManifestInput> = {}): BuilderManifestInput => {
      const unsigned: BuilderManifestInput = {
        manifestVersion: 1,
        environment: "testnet",
        builderId: "builder-a",
        identityKey,
        payoutAccounts: [{ domainId: "svm:testnet", account: "payout-a" }],
        supportedDomainIds: ["svm:testnet"],
        maximumBuilderFeeBpsByTemplate: [{ templateId: "cash-and-carry-v1", maximumFeeBps: 10n }],
        validFromMs: 0n,
        validUntilMs: 10_000n,
        nonce: 1n,
        signature: new Uint8Array(64),
        ...overrides,
      };
      return { ...unsigned, signature: new Uint8Array(sign(null, builderManifestHash(unsigned), privateKey)) };
    };
    const first = signed();
    assert.deepEqual(builders.registerManifest(first).created, true);
    assert.throws(() => builders.registerManifest({ ...signed({ nonce: 2n }), signature: new Uint8Array(64) }), { code: "INVALID_SIGNATURE" });
    assert.throws(() => builders.registerManifest(signed({ nonce: 1n, validUntilMs: 11_000n })), { code: "NONCE_NOT_INCREASING" });

    const order = signedOrder("builder-order-0001");
    evidence.submitOrder(order.order, order.signature);
    const attribution: BuilderAttributionInput = { attributionVersion: 1, orderHash: order.orderHashHex, builderId: "builder-a", builderManifestHash: builderManifestHash(first), maximumBuilderFeeBps: 5n };
    const stranger = signedOrder("builder-order-0002");
    assert.throws(() => builders.attribute(attribution, stranger.signBytes(builderAttributionHash(attribution))), { code: "INVALID_SIGNATURE" });
    assert.equal(builders.attribute(attribution, order.signBytes(builderAttributionHash(attribution))).replayed, false);
    const other = { ...attribution, maximumBuilderFeeBps: 6n };
    assert.throws(() => builders.attribute(other, order.signBytes(builderAttributionHash(other))), { code: "ALREADY_ATTRIBUTED" });

    // The settled receipt charges a builder fee within the owner's 5 bps cap of its notional.
    const orderHash = Buffer.from(order.orderHashHex, "hex");
    const settled = receipt(orderHash, { rawFillFeesByAsset: [assetAmount(usdc, 79_000n)], builderFeesByAsset: [assetAmount(usdc, 70_000n)] });
    evidence.recordOutcome({
      evidenceManifest: evidenceManifest(orderHash),
      outcome: outcome(orderHash, { terminalState: "FINALIZED_COMPLETE", successfulReceiptHash: packageReceiptHash(settled) }),
      receipt: settled,
      acceptedQuoteFeeTerms: { ...terms, builderFeesByAsset: [assetAmount(usdc, 70_000n)] },
    });
    const [view] = builders.attributions("builder-a");
    assert.equal(view?.payable, true, JSON.stringify(view?.violations));
    assert.deepEqual(builders.revenue("builder-a"), [{ assetId: usdc.assetId, atoms: 70_000n, orders: 1 }]);
  } finally {
    builders.close();
    evidence.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
