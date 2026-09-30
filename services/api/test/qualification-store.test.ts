import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { domainRef, fromProtocolJson, qualificationRecordHash, toHex, type QualificationRecordInput } from "@naryx/protocol-types";
import { createPublicApiHandler, SqlitePackageExchangeStore, SqliteQualificationStore } from "../src/index.js";
import { CLASS_SUPPORT, NOW, SERIES_SUPPORT } from "./exchange-fixtures.js";

const NOW_S = 1_790_000_000n;

function authority() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
  const signRecord = (record: QualificationRecordInput): QualificationRecordInput => ({
    ...record,
    signature: new Uint8Array(sign(null, qualificationRecordHash(record), privateKey)),
  });
  return { raw, signRecord };
}

function record(overrides: Partial<QualificationRecordInput> = {}): QualificationRecordInput {
  return {
    recordVersion: 1,
    environment: "testnet",
    objectType: "VENUE",
    objectId: "phoenix-sol-usdc",
    domain: domainRef("svm:testnet", 1, "11".repeat(32)),
    state: "ACTIVE",
    effectiveLimits: { maximumNotionalQuoteAtoms: 1_000_000n, maximumOpenPackages: 10 },
    evidenceRefs: ["21".repeat(32)],
    triggerCodes: [],
    timeUnit: "EVM_UNIX_SECONDS",
    observedAtValue: NOW_S - 1_000n,
    effectiveAtValue: NOW_S - 900n,
    authorityKind: "REVIEWED_ACTIVATION",
    authority: "qualification-key-1",
    reviewerIds: ["reviewer-a", "reviewer-b"],
    signature: new Uint8Array(0),
    ...overrides,
  };
}

test("qualification records append only as signed links of their object's chain and are served with their hashes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-qualification-"));
  const key = authority();
  // Server time tracks each record's observation, as an operator appending it live would.
  let clockMs = Number(NOW_S - 1_000n) * 1_000;
  const store = new SqliteQualificationStore(join(dir, "qualification.sqlite"), {
    authorities: new Map([["qualification-key-1", key.raw]]),
    minimumActivationDelay: 100n,
    clock: () => clockMs,
  });
  const exchange = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
  const handler = createPublicApiHandler({
    exchange,
    qualification: store,
    nowValue: () => NOW,
    clockMs: () => Number(NOW_S) * 1_000,
    rateLimit: { windowMs: 60_000, maxRequests: 1_000 },
  });
  const server = createServer((request, response) => {
    if (!handler(request, response)) {
      response.statusCode = 418;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: fromProtocolJson(JSON.parse(await response.text())) as Record<string, unknown> };
  };
  try {
    assert.equal((await get("/v1/qualification/VENUE/phoenix-sol-usdc")).status, 404);

    const first = key.signRecord(record());
    assert.throws(() => store.append({ ...first, signature: new Uint8Array(64).fill(1) }), { code: "INVALID_SIGNATURE" });
    assert.throws(() => store.append(key.signRecord(record({ authority: "someone-else" }))), { code: "UNKNOWN_AUTHORITY" });
    assert.throws(() => store.append(key.signRecord(record({ effectiveAtValue: NOW_S - 950n }))), { code: "ACTIVATION_TOO_EARLY" });
    // A backdated observation cannot start the activation delay early.
    assert.throws(() => store.append(key.signRecord(record({ observedAtValue: NOW_S - 2_000n, effectiveAtValue: NOW_S - 1_000n }))), { code: "OBSERVATION_OUT_OF_WINDOW" });
    assert.throws(() => store.append(key.signRecord(record({ observedAtValue: NOW_S - 600n, effectiveAtValue: NOW_S - 500n }))), { code: "OBSERVATION_OUT_OF_WINDOW" });
    assert.throws(() => store.append(key.signRecord(record({ timeUnit: "SOLANA_SLOT" }))), { code: "TIME_UNIT_UNSUPPORTED" });
    assert.deepEqual(store.append(first), { recordHashHex: toHex(qualificationRecordHash(first)), replayed: false });
    assert.equal(store.append(first).replayed, true);

    // A monitor may tighten at once but may never loosen.
    clockMs = Number(NOW_S - 500n) * 1_000;
    const downgrade = key.signRecord(record({
      state: "REDUCE_ONLY",
      triggerCodes: ["ORACLE_STALE"],
      observedAtValue: NOW_S - 500n,
      effectiveAtValue: NOW_S - 500n,
      authorityKind: "AUTOMATED_MONITOR",
      reviewerIds: [],
      previousRecordHash: qualificationRecordHash(first),
    }));
    store.append(downgrade);
    clockMs = Number(NOW_S - 100n) * 1_000;
    const loosen = key.signRecord(record({
      observedAtValue: NOW_S - 100n,
      effectiveAtValue: NOW_S - 100n,
      authorityKind: "AUTOMATED_MONITOR",
      reviewerIds: [],
      previousRecordHash: qualificationRecordHash(downgrade),
    }));
    assert.throws(() => store.append(loosen), { code: "MONITOR_CANNOT_LOOSEN" });

    const current = await get("/v1/qualification/VENUE/phoenix-sol-usdc");
    assert.equal(current.status, 200);
    assert.equal((current.body.record as { state: string }).state, "REDUCE_ONLY");
    assert.equal(current.body.recordHash, toHex(qualificationRecordHash(downgrade)));
    assert.equal(current.body.asOfValue, NOW_S);
    const history = await get("/v1/qualification/VENUE/phoenix-sol-usdc/history");
    assert.deepEqual((history.body.records as readonly { recordHash: string }[]).map((entry) => entry.recordHash), [
      toHex(qualificationRecordHash(first)),
      toHex(qualificationRecordHash(downgrade)),
    ]);
    assert.equal((await get("/v1/qualification/PLANET/phoenix")).status, 400);
    assert.equal((await get("/v1/qualification/VENUE/phoenix-sol-usdc?at=1")).status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    exchange.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an expired current record governs nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-qualification-"));
  const key = authority();
  const store = new SqliteQualificationStore(join(dir, "qualification.sqlite"), {
    authorities: new Map([["qualification-key-1", key.raw]]),
    minimumActivationDelay: 100n,
    clock: () => Number(NOW_S - 1_000n) * 1_000,
  });
  try {
    store.append(key.signRecord(record({ expiresAtValue: NOW_S - 10n })));
    const nowIn = (unit: string) => (unit === "EVM_UNIX_SECONDS" ? NOW_S : undefined);
    assert.deepEqual(store.current("VENUE", "phoenix-sol-usdc", nowIn), { unavailable: "EXPIRED" });
    assert.deepEqual(store.current("VENUE", "phoenix-sol-usdc", () => undefined), { unavailable: "TIME_UNIT_UNSUPPORTED" });
    assert.throws(() => new SqliteQualificationStore(join(dir, "other.sqlite"), { authorities: new Map(), minimumActivationDelay: 1n }), { code: "INVALID_CONFIGURATION" });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
