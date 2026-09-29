import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assetAmount,
  evidenceManifestHash,
  fromProtocolJson,
  packageReceiptHash,
  toHex,
  toProtocolJson,
} from "@naryx/protocol-types";
import { createPublicApiHandler, SqliteEvidenceStore, SqlitePackageExchangeStore } from "../src/index.js";
import { CLASS_SUPPORT, NOW, SERIES_SUPPORT } from "./exchange-fixtures.js";
import { hash, manifest, outcome, receipt, signedOrder, terms, usdc } from "./evidence-fixtures.js";

function withEvidence(run: (store: SqliteEvidenceStore, dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "naryx-evidence-"));
  const store = new SqliteEvidenceStore(join(dir, "evidence.sqlite"), { clock: () => 1_000 });
  return Promise.resolve(run(store, dir)).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

test("orders enter only with the owner's signature over exact bytes, one order per owner nonce", async () => {
  await withEvidence((store) => {
    const { order, orderHashHex, signature, signOrder } = signedOrder();
    assert.deepEqual(store.submitOrder(order, signature), { orderHashHex, replayed: false });
    assert.deepEqual(store.submitOrder(order, signature), { orderHashHex, replayed: true });
    assert.equal(store.getOrder(orderHashHex)?.owner, order.owner);
    const other = signedOrder("evidence-order-0002");
    assert.throws(() => store.submitOrder(other.order, signature), { code: "INVALID_SIGNATURE" });
    const sameNonce = { ...order, expiryValue: order.expiryValue + 1n };
    assert.throws(() => store.submitOrder(sameNonce, signOrder(sameNonce)), { code: "NONCE_REUSED" });
    assert.throws(() => store.submitOrder({ ...order, owner: "0x1111111111111111111111111111111111111111" }, signature), { code: "UNSUPPORTED_AUTHORIZATION" });
    assert.deepEqual(store.openOrders(0, 10).map((entry) => entry.orderHashHex), [orderHashHex]);
  });
});

test("a terminal outcome is recorded once, with its receipt and fees checked against the accepted quote", async () => {
  await withEvidence((store) => {
    const orderHash = hash(1);
    const successful = outcome(orderHash, {
      terminalState: "FINALIZED_COMPLETE",
      successfulReceiptHash: packageReceiptHash(receipt(orderHash)),
    });
    assert.throws(() => store.recordOutcome({ evidenceManifest: manifest(orderHash), outcome: successful }), { code: "RECEIPT_REQUIRED" });
    const overcharged = receipt(orderHash, { solverFee: assetAmount(usdc, 10_001n) });
    assert.throws(
      () => store.recordOutcome({
        evidenceManifest: manifest(orderHash),
        outcome: { ...successful, successfulReceiptHash: packageReceiptHash(overcharged) },
        receipt: overcharged,
        acceptedQuoteFeeTerms: terms,
      }),
      { code: "FEE_VIOLATION" },
    );
    const recorded = store.recordOutcome({ evidenceManifest: manifest(orderHash), outcome: successful, receipt: receipt(orderHash), acceptedQuoteFeeTerms: terms });
    assert.equal(recorded.receiptHashHex, toHex(packageReceiptHash(receipt(orderHash))));
    assert.equal(store.recordOutcome({ evidenceManifest: manifest(orderHash), outcome: successful, receipt: receipt(orderHash), acceptedQuoteFeeTerms: terms }).replayed, true);
    const differentManifest = { ...manifest(orderHash), entries: manifest(orderHash).entries.slice(0, 1) };
    assert.throws(() => store.recordOutcome({ evidenceManifest: differentManifest, outcome: successful }), { code: "EVIDENCE_MISMATCH" });
    assert.throws(
      () => store.recordOutcome({ evidenceManifest: manifest(hash(9)), outcome: outcome(hash(9)), receipt: receipt(hash(9)) }),
      { code: "RECEIPT_NOT_EXPECTED" },
    );
    const quality = store.executionQuality();
    assert.equal(quality.terminalOutcomes, 1);
    assert.equal(quality.successfulBps, 10_000);
    assert.deepEqual(quality.timeUnhedgedMs, { median: 0n, p95: 0n, max: 0n });
  });
});

test("public routes serve signed orders, recorded outcomes with their hashes, and measured analytics", async () => {
  await withEvidence(async (evidence, dir) => {
    const exchange = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
    const handler = createPublicApiHandler({ exchange, evidence, nowValue: () => NOW, rateLimit: { windowMs: 60_000, maxRequests: 1_000 } });
    const server = createServer((request, response) => {
      if (!handler(request, response)) {
        response.statusCode = 418;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(toProtocolJson(body)) }),
      });
      return { status: response.status, body: fromProtocolJson(JSON.parse(await response.text())) as Record<string, unknown> };
    };
    try {
      const { order, orderHashHex, signature } = signedOrder();
      const submitted = await call("POST", "/v1/orders", { order, authorization: { scheme: "ED25519", signature } });
      assert.equal(submitted.status, 200);
      assert.equal(submitted.body.orderHash ?? submitted.body.orderHashHex, orderHashHex);
      assert.equal((await call("POST", "/v1/orders", { order, authorization: { scheme: "EIP712", signature } })).status, 400);
      const open = await call("GET", `/v1/orders/${orderHashHex}`);
      assert.equal(open.body.status, "OPEN");
      assert.equal((await call("GET", `/v1/receipts/${orderHashHex}`)).status, 404);

      const orderHash = Buffer.from(orderHashHex, "hex");
      evidence.recordOutcome({ evidenceManifest: manifest(orderHash), outcome: outcome(orderHash) });
      const closed = await call("GET", `/v1/orders/${orderHashHex}`);
      assert.equal(closed.body.status, "NO_EFFECT");
      const receipts = await call("GET", `/v1/receipts/${orderHashHex}`);
      assert.equal(receipts.body.terminalState, "NO_EFFECT");
      assert.equal(receipts.body.receipt, undefined);
      assert.equal(receipts.body.evidenceManifestHash, toHex(evidenceManifestHash(manifest(orderHash))));
      const outcomeRead = await call("GET", `/v1/outcomes/${orderHashHex}`);
      assert.equal(outcomeRead.body.terminalState, "NO_EFFECT");
      assert.equal(outcomeRead.body.outcomeHash, receipts.body.outcomeHash);
      assert.equal(outcomeRead.body.receipt, undefined);
      assert.equal((await call("GET", `/v1/outcomes/${"cd".repeat(32)}`)).status, 404);
      const quality = await call("GET", "/v1/analytics/execution-quality");
      assert.equal(quality.body.label, "OBSERVED");
      assert.equal(quality.body.terminalOutcomes, 1);
      assert.equal((await call("GET", "/v1/orders/not-a-hash")).status, 400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      exchange.close();
    }
  });
});
