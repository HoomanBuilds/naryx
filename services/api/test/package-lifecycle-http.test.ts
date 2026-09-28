import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { domainRef, packageLifecycleReceiptHash, toHex, versionedManifestRef } from "@naryx/protocol-types";
import type { PackageEvidenceGrade, PackageLifecycleReceipt, PackageLifecycleState, SettlementClass } from "@naryx/protocol-types";
import {
  createPrivateTerminalServer,
  SqlitePackageLifecycleStore,
  type PackageLifecycleStore,
} from "../src/index.js";

const PACKAGE_ID = "pkg-lifecycle-http-001";
const ATTEMPT_ID = "attempt-lifecycle-http-001";
const PACKAGE_COMMITMENT = "44".repeat(32);

const DOMAIN_A = domainRef("svm:testnet", 1, "11".repeat(32));
const DOMAIN_B = domainRef("evm:testnet", 1, "22".repeat(32));
const SOURCE_A = versionedManifestRef("evidence-schema-local", 1, "a1".repeat(32));
const SOURCE_B = versionedManifestRef("evidence-schema-controller", 1, "b2".repeat(32));

const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const ASCII_PATTERN = /^[\x00-\x7F]*$/;

function intent(
  eventId: string,
  expectedRevision: bigint,
  nextState: PackageLifecycleState,
  domain: typeof DOMAIN_A,
  grade: PackageEvidenceGrade,
  onchain: boolean,
  settlement: SettlementClass,
  evidenceCommitment: string,
) {
  const source = grade === "LOCAL_RECORDED" ? SOURCE_A : SOURCE_B;
  return {
    version: 1,
    domain,
    settlementClass: settlement,
    packageId: PACKAGE_ID,
    packageCommitment: PACKAGE_COMMITMENT,
    attemptId: ATTEMPT_ID,
    eventId,
    expectedRevision,
    nextState,
    evidenceGrade: grade,
    onchainEnforced: onchain,
    evidenceSource: source,
    evidenceCommitment,
  } as const;
}

async function listen(server: ReturnType<typeof createPrivateTerminalServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createPrivateTerminalServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function assertAsciiTree(value: unknown): void {
  if (typeof value === "string") {
    assert.match(value, ASCII_PATTERN);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertAsciiTree(entry);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value as Record<string, unknown>)) assertAsciiTree(entry);
  }
}

type LifecycleHttpBody = {
  attempt: {
    attemptId: string;
    packageId: string;
    packageCommitmentHex: string;
    revision: string;
    state: string;
    receiptHashHex: string;
    eventId: string;
    observedAtUnixMilliseconds: string;
  };
  receipts: Array<{
    version: number;
    domain: { domainId: string; domainManifestVersion: number; domainManifestHashHex: string };
    settlementClass: string;
    packageId: string;
    packageCommitmentHex: string;
    attemptId: string;
    eventId: string;
    revision: string;
    priorState?: string;
    previousReceiptHashHex?: string;
    nextState: string;
    observedAtUnixMilliseconds: string;
    evidenceGrade: string;
    onchainEnforced: boolean;
    evidenceSource: { subjectId: string; manifestVersion: number; manifestHashHex: string };
    evidenceCommitmentHex: string;
    intentCommitmentHex: string;
    receiptHashHex: string;
  }>;
};

function seedTwoReceipts(dbPath: string): { store: SqlitePackageLifecycleStore; first: PackageLifecycleReceipt; second: PackageLifecycleReceipt } {
  let tick = 1_700_000_000_000n;
  const store = new SqlitePackageLifecycleStore(dbPath, {
    clock: () => {
      tick += 7n;
      return tick;
    },
  });
  const first = store.recordEvent(
    intent("event-http-001", 0n, "PACKAGE_CREATED", DOMAIN_A, "LOCAL_RECORDED", false, "ATOMIC_POSTCONDITION", "d1".repeat(32)),
  ).receipt;
  const second = store.recordEvent(
    intent("event-http-002", 1n, "ENTRY_PREPARED", DOMAIN_B, "CONTROLLER_ATTESTED", false, "BATCHED_IOC_WITH_RECOVERY", "d2".repeat(32)),
  ).receipt;
  return { store, first, second };
}

test("lifecycle read is unavailable without a store and reports health", async () => {
  const config = { host: "127.0.0.1", port: 0, terminalOrigin: null as string | null };
  const server = createPrivateTerminalServer(config);
  const url = await listen(server);
  try {
    const health = await fetch(`${url}/internal/healthz`);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { lifecycleReadAvailable: boolean };
    assert.equal(healthBody.lifecycleReadAvailable, false);

    const missing = await fetch(`${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}`);
    assert.equal(missing.status, 503);
    assert.deepEqual(await missing.json(), {
      error: { code: "LIFECYCLE_UNAVAILABLE", message: "Package lifecycle reading is unavailable." },
    });
  } finally {
    await close(server);
  }
});

test("lifecycle read returns two chained receipts and filters by revision", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-lifecycle-http-"));
  const dbPath = join(scratch, "lifecycle.db");
  const { store, first, second } = seedTwoReceipts(dbPath);
  try {
    const config = { host: "127.0.0.1", port: 0, terminalOrigin: null as string | null };
    const server = createPrivateTerminalServer(config, {}, undefined, undefined, {}, store);
    const url = await listen(server);
    try {
      const health = await fetch(`${url}/internal/healthz`);
      assert.equal((await health.json() as { lifecycleReadAvailable: boolean }).lifecycleReadAvailable, true);

      const response = await fetch(`${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = (await response.json()) as LifecycleHttpBody;
      assert.deepEqual(JSON.parse(JSON.stringify(body)), body);
      assertAsciiTree(body);

      assert.equal(body.attempt.attemptId, ATTEMPT_ID);
      assert.equal(body.attempt.packageId, PACKAGE_ID);
      assert.match(body.attempt.packageCommitmentHex, HEX_64_PATTERN);
      assert.match(body.attempt.receiptHashHex, HEX_64_PATTERN);
      assert.match(body.attempt.revision, DECIMAL_PATTERN);
      assert.equal(body.attempt.revision, "2");
      assert.equal(body.attempt.state, "ENTRY_PREPARED");
      assert.equal(body.attempt.eventId, "event-http-002");
      assert.match(body.attempt.observedAtUnixMilliseconds, DECIMAL_PATTERN);

      assert.equal(body.receipts.length, 2);
      assert.equal(body.receipts[0]?.eventId, "event-http-001");
      assert.equal(body.receipts[1]?.eventId, "event-http-002");
      assert.equal(body.receipts[0]?.revision, "1");
      assert.equal(body.receipts[1]?.revision, "2");
      assert.equal(body.receipts[0]?.priorState, undefined);
      assert.equal(body.receipts[0]?.previousReceiptHashHex, undefined);
      assert.ok(!("priorState" in (body.receipts[0] as Record<string, unknown>)));
      assert.ok(!("previousReceiptHashHex" in (body.receipts[0] as Record<string, unknown>)));
      assert.equal(body.receipts[1]?.priorState, "PACKAGE_CREATED");
      assert.match(body.receipts[1]?.previousReceiptHashHex ?? "", HEX_64_PATTERN);
      assert.deepEqual(body.receipts[1]?.previousReceiptHashHex, toHex(packageLifecycleReceiptHash(first)));
      assert.equal(body.receipts[1]?.nextState, "ENTRY_PREPARED");

      for (const receipt of body.receipts) {
        assert.equal(receipt.version, 1);
        assert.match(receipt.packageCommitmentHex, HEX_64_PATTERN);
        assert.match(receipt.receiptHashHex, HEX_64_PATTERN);
        assert.match(receipt.intentCommitmentHex, HEX_64_PATTERN);
        assert.match(receipt.evidenceCommitmentHex, HEX_64_PATTERN);
        assert.match(receipt.domain.domainManifestHashHex, HEX_64_PATTERN);
        assert.match(receipt.evidenceSource.manifestHashHex, HEX_64_PATTERN);
        assert.match(receipt.revision, DECIMAL_PATTERN);
        assert.match(receipt.observedAtUnixMilliseconds, DECIMAL_PATTERN);
        assert.equal(typeof receipt.onchainEnforced, "boolean");
        assert.equal(receipt.attemptId, ATTEMPT_ID);
        assert.equal(receipt.packageId, PACKAGE_ID);
      }
      assert.equal(body.receipts[0]?.domain.domainId, "svm:testnet");
      assert.equal(body.receipts[1]?.domain.domainId, "evm:testnet");
      assert.equal(body.receipts[0]?.evidenceSource.subjectId, "evidence-schema-local");
      assert.equal(body.receipts[1]?.evidenceSource.subjectId, "evidence-schema-controller");

      const filtered = await fetch(
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&afterRevision=1`,
      );
      assert.equal(filtered.status, 200);
      const filteredBody = (await filtered.json()) as LifecycleHttpBody;
      assert.equal(filteredBody.receipts.length, 1);
      assert.equal(filteredBody.receipts[0]?.eventId, "event-http-002");
      assert.equal(filteredBody.receipts[0]?.revision, "2");
      assert.equal(filteredBody.attempt.revision, "2");

      const empty = await fetch(
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&afterRevision=2&limit=10`,
      );
      assert.equal(empty.status, 200);
      assert.deepEqual((await empty.json() as LifecycleHttpBody).receipts, []);

      const limited = await fetch(
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&afterRevision=0&limit=1`,
      );
      assert.equal(limited.status, 200);
      const limitedBody = (await limited.json()) as LifecycleHttpBody;
      assert.equal(limitedBody.receipts.length, 1);
      assert.equal(limitedBody.receipts[0]?.revision, "1");

      assert.deepEqual(toHex(second.packageCommitment), body.receipts[1]?.packageCommitmentHex);
    } finally {
      await close(server);
    }
  } finally {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("lifecycle read rejects unknown attempts, invalid queries, duplicates, and methods", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-lifecycle-http-reject-"));
  const dbPath = join(scratch, "lifecycle.db");
  const { store } = seedTwoReceipts(dbPath);
  try {
    const config = { host: "127.0.0.1", port: 0, terminalOrigin: null as string | null };
    const server = createPrivateTerminalServer(config, {}, undefined, undefined, {}, store);
    const url = await listen(server);
    try {
      const unknown = await fetch(`${url}/internal/terminal/lifecycle?attemptId=no-such-attempt`);
      assert.equal(unknown.status, 404);
      assert.deepEqual(await unknown.json(), {
        error: { code: "ATTEMPT_NOT_FOUND", message: "Attempt was not found." },
      });

      const missing = await fetch(`${url}/internal/terminal/lifecycle`);
      assert.equal(missing.status, 400);
      assert.equal(((await missing.json()) as { error: { code: string } }).error.code, "INVALID_ATTEMPT_ID");

      const invalidCases = [
        `${url}/internal/terminal/lifecycle?attemptId=`,
        `${url}/internal/terminal/lifecycle?attemptId=${"a".repeat(129)}`,
        `${url}/internal/terminal/lifecycle?attemptId=${encodeURIComponent("caf\u00e9")}`,
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&afterRevision=01`,
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&afterRevision=-1`,
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&afterRevision=1.5`,
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&afterRevision=abc`,
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&afterRevision=${Number.MAX_SAFE_INTEGER + 1}`,
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&limit=0`,
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&limit=101`,
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&limit=01`,
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&limit=abc`,
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&unknown=1`,
      ];
      for (const target of invalidCases) {
        const response = await fetch(target);
        assert.equal(response.status, 400, target);
        const payload = (await response.json()) as { error: { code: string; message: string } };
        assert.match(payload.error.code, /^[A-Z][A-Z0-9_]*$/);
        assert.match(payload.error.message, ASCII_PATTERN);
      }

      const duplicateAttempt = await fetch(
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&attemptId=${ATTEMPT_ID}`,
      );
      assert.equal(duplicateAttempt.status, 400);
      assert.equal(
        ((await duplicateAttempt.json()) as { error: { code: string } }).error.code,
        "INVALID_ATTEMPT_ID",
      );

      const spaced = await fetch(`${url}/internal/terminal/lifecycle?attemptId=bad%20id`);
      assert.equal(spaced.status, 404);

      const duplicateAfter = await fetch(
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&afterRevision=0&afterRevision=0`,
      );
      assert.equal(duplicateAfter.status, 400);

      const duplicateLimit = await fetch(
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&limit=10&limit=10`,
      );
      assert.equal(duplicateLimit.status, 400);

      const posted = await fetch(`${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}`, {
        method: "POST",
      });
      assert.equal(posted.status, 405);
      assert.equal(posted.headers.get("allow"), "GET, OPTIONS");
      assert.deepEqual(await posted.json(), {
        error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is allowed." },
      });

      const put = await fetch(`${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}`, {
        method: "PUT",
      });
      assert.equal(put.status, 405);
      assert.equal(put.headers.get("allow"), "GET, OPTIONS");
    } finally {
      await close(server);
    }
  } finally {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("lifecycle GET does not call recordEvent", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-lifecycle-http-spy-"));
  const dbPath = join(scratch, "lifecycle.db");
  const { store } = seedTwoReceipts(dbPath);
  try {
    let recordCalls = 0;
    const spy: PackageLifecycleStore = {
      recordEvent: (...args: Parameters<PackageLifecycleStore["recordEvent"]>) => {
        recordCalls += 1;
        return store.recordEvent(...args);
      },
      getAttempt: (attemptId: string) => store.getAttempt(attemptId),
      getReceiptByEventId: (eventId: string) => store.getReceiptByEventId(eventId),
      listReceipts: (attemptId: string, afterRevision: bigint, limit: number) =>
        store.listReceipts(attemptId, afterRevision, limit),
      close: () => {},
    };
    const config = { host: "127.0.0.1", port: 0, terminalOrigin: null as string | null };
    const server = createPrivateTerminalServer(config, {}, undefined, undefined, {}, spy);
    const url = await listen(server);
    try {
      const response = await fetch(`${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}`);
      assert.equal(response.status, 200);
      assert.equal(recordCalls, 0);
      const filtered = await fetch(
        `${url}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&afterRevision=1&limit=10`,
      );
      assert.equal(filtered.status, 200);
      assert.equal(recordCalls, 0);
      const missing = await fetch(`${url}/internal/terminal/lifecycle?attemptId=missing-attempt`);
      assert.equal(missing.status, 404);
      assert.equal(recordCalls, 0);
    } finally {
      await close(server);
    }
  } finally {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("lifecycle read fails closed on corrupted store results", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-lifecycle-http-corrupt-"));
  const dbPath = join(scratch, "lifecycle.db");
  const { store } = seedTwoReceipts(dbPath);
  const attempt = store.getAttempt(ATTEMPT_ID);
  assert.ok(attempt !== undefined);
  const receipts = store.listReceipts(ATTEMPT_ID, 0n, 100);
  assert.equal(receipts.length, 2);
  const config = { host: "127.0.0.1", port: 0, terminalOrigin: null as string | null };

  const corruptedReceiptStore: PackageLifecycleStore = {
    recordEvent: (input) => store.recordEvent(input),
    getAttempt: () => attempt,
    getReceiptByEventId: (eventId: string) => store.getReceiptByEventId(eventId),
    listReceipts: () => [{ ...receipts[0], revision: 0n } as unknown as PackageLifecycleReceipt],
    close: () => {},
  };
  const corruptedServer = createPrivateTerminalServer(config, {}, undefined, undefined, {}, corruptedReceiptStore);
  const corruptedUrl = await listen(corruptedServer);
  try {
    const response = await fetch(`${corruptedUrl}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: { code: "LIFECYCLE_READ_FAILED", message: "Package lifecycle reading failed closed." },
    });
  } finally {
    await close(corruptedServer);
  }

  const throwingStore: PackageLifecycleStore = {
    recordEvent: (input) => store.recordEvent(input),
    getAttempt: () => {
      throw new Error("boom");
    },
    getReceiptByEventId: (eventId: string) => store.getReceiptByEventId(eventId),
    listReceipts: (id: string, after: bigint, limit: number) => store.listReceipts(id, after, limit),
    close: () => {},
  };
  const throwingServer = createPrivateTerminalServer(config, {}, undefined, undefined, {}, throwingStore);
  const throwingUrl = await listen(throwingServer);
  try {
    const response = await fetch(`${throwingUrl}/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: { code: "LIFECYCLE_READ_FAILED", message: "Package lifecycle reading failed closed." },
    });
  } finally {
    await close(throwingServer);
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("lifecycle read fails closed on skipped revision, broken link, and head mismatch", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-lifecycle-http-chain-"));
  const dbPath = join(scratch, "lifecycle.db");
  const { store, first, second } = seedTwoReceipts(dbPath);
  const attempt = store.getAttempt(ATTEMPT_ID);
  assert.ok(attempt !== undefined);
  const config = { host: "127.0.0.1", port: 0, terminalOrigin: null as string | null };
  const expectedFailure = {
    error: { code: "LIFECYCLE_READ_FAILED", message: "Package lifecycle reading failed closed." },
  };

  async function fetchWith(fake: PackageLifecycleStore, target: string): Promise<Response> {
    const server = createPrivateTerminalServer(config, {}, undefined, undefined, {}, fake);
    const url = await listen(server);
    try {
      return await fetch(`${url}${target}`);
    } finally {
      await close(server);
    }
  }

  try {
    let recordCalls = 0;
    const skipped: PackageLifecycleStore = {
      recordEvent: (input) => {
        recordCalls += 1;
        return store.recordEvent(input);
      },
      getAttempt: () => attempt,
      getReceiptByEventId: (eventId: string) => store.getReceiptByEventId(eventId),
      listReceipts: () => [second],
      close: () => {},
    };
    const skippedResponse = await fetchWith(
      skipped,
      `/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}`,
    );
    assert.equal(skippedResponse.status, 502);
    assert.deepEqual(await skippedResponse.json(), expectedFailure);

    const brokenHash = new Uint8Array(32).fill(0x5a);
    const tampered = {
      ...second,
      previousReceiptHash: brokenHash,
    } as unknown as PackageLifecycleReceipt;
    const brokenLink: PackageLifecycleStore = {
      recordEvent: (input) => {
        recordCalls += 1;
        return store.recordEvent(input);
      },
      getAttempt: () => attempt,
      getReceiptByEventId: (eventId: string) => store.getReceiptByEventId(eventId),
      listReceipts: (id: string, after: bigint, limit: number) => {
        if (after === 0n) {
          return store.listReceipts(id, after, limit);
        }
        return [tampered];
      },
      close: () => {},
    };
    const brokenResponse = await fetchWith(
      brokenLink,
      `/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}&afterRevision=1`,
    );
    assert.equal(brokenResponse.status, 502);
    assert.deepEqual(await brokenResponse.json(), expectedFailure);

    const mismatchedHead = { ...attempt, eventId: "event-http-999" };
    const headMismatch: PackageLifecycleStore = {
      recordEvent: (input) => {
        recordCalls += 1;
        return store.recordEvent(input);
      },
      getAttempt: () => mismatchedHead,
      getReceiptByEventId: (eventId: string) => store.getReceiptByEventId(eventId),
      listReceipts: (id: string, after: bigint, limit: number) => store.listReceipts(id, after, limit),
      close: () => {},
    };
    const headResponse = await fetchWith(
      headMismatch,
      `/internal/terminal/lifecycle?attemptId=${ATTEMPT_ID}`,
    );
    assert.equal(headResponse.status, 502);
    assert.deepEqual(await headResponse.json(), expectedFailure);
    assert.equal(recordCalls, 0);
    assert.ok(first.revision === 1n);
  } finally {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
