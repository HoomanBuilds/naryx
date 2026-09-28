import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  domainRef,
  packageLifecycleReceiptHash,
  versionedManifestRef,
} from "@naryx/protocol-types";
import type {
  PackageEvidenceGrade,
  PackageLifecycleState,
  SettlementClass,
} from "@naryx/protocol-types";
import {
  PackageLifecycleEventConflictError,
  PackageLifecycleStoreError,
  SqlitePackageLifecycleStore,
} from "../src/index.js";

const PACKAGE_ID = "pkg-lifecycle-001";
const ATTEMPT_ID = "attempt-lifecycle-001";
const PACKAGE_COMMITMENT = "44".repeat(32);

const DOMAIN_A = domainRef("svm:testnet", 1, "11".repeat(32));
const DOMAIN_B = domainRef("evm:testnet", 1, "22".repeat(32));
const DOMAIN_C = domainRef("hypercore:testnet", 1, "33".repeat(32));

const SOURCE_A = versionedManifestRef("evidence-schema-local", 1, "a1".repeat(32));
const SOURCE_B = versionedManifestRef("evidence-schema-controller", 1, "b2".repeat(32));
const SOURCE_C = versionedManifestRef("evidence-schema-venue", 1, "c3".repeat(32));

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
  const source = grade === "LOCAL_RECORDED" ? SOURCE_A : grade === "CONTROLLER_ATTESTED" ? SOURCE_B : SOURCE_C;
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

test("package lifecycle store keeps an append-only cross-domain ledger", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-lifecycle-"));
  const dbPath = join(scratch, "lifecycle.db");
  let tick = 1_700_000_000_000n;
  const clock = (): bigint => {
    tick += 7n;
    return tick;
  };
  const store = new SqlitePackageLifecycleStore(dbPath, { clock });
  try {
    const created = store.recordEvent(
      intent("event-001", 0n, "PACKAGE_CREATED", DOMAIN_A, "LOCAL_RECORDED", false, "ATOMIC_POSTCONDITION", "d1".repeat(32)),
    );
    assert.equal(created.created, true);
    assert.equal(created.receipt.revision, 1n);
    assert.equal(created.receipt.priorState, undefined);
    assert.equal(created.receipt.nextState, "PACKAGE_CREATED");
    assert.equal(typeof created.receipt.observedAtUnixMilliseconds, "bigint");
    assert.equal(store.getAttempt(ATTEMPT_ID)?.revision, 1n);

    const prepared = store.recordEvent(
      intent("event-002", 1n, "ENTRY_PREPARED", DOMAIN_B, "CONTROLLER_ATTESTED", false, "BATCHED_IOC_WITH_RECOVERY", "d2".repeat(32)),
    );
    assert.equal(prepared.created, true);
    assert.equal(prepared.receipt.revision, 2n);
    assert.equal(prepared.receipt.priorState, "PACKAGE_CREATED");
    assert.deepEqual(prepared.receipt.previousReceiptHash, packageLifecycleReceiptHash(created.receipt));
    assert.equal(prepared.receipt.domain.domainId, "evm:testnet");

    const replayed = store.recordEvent(
      intent("event-002", 1n, "ENTRY_PREPARED", DOMAIN_B, "CONTROLLER_ATTESTED", false, "BATCHED_IOC_WITH_RECOVERY", "d2".repeat(32)),
    );
    assert.equal(replayed.created, false);
    assert.deepEqual(replayed.receipt, prepared.receipt);

    assert.throws(
      () =>
        store.recordEvent(
          intent("event-002", 1n, "ENTRY_PREPARED", DOMAIN_B, "CONTROLLER_ATTESTED", false, "BATCHED_IOC_WITH_RECOVERY", "e9".repeat(32)),
        ),
      (error: unknown) => error instanceof PackageLifecycleEventConflictError,
    );

    assert.throws(
      () =>
        store.recordEvent(
          intent("event-stale", 1n, "ENTRY_SUBMITTED", DOMAIN_A, "VENUE_CORROBORATED", true, "ASYNC_BONDED_SOLVER", "d3".repeat(32)),
        ),
      (error: unknown) => error instanceof PackageLifecycleStoreError && error.code === "STALE_REVISION",
    );

    const submitted = store.recordEvent(
      intent("event-003", 2n, "ENTRY_SUBMITTED", DOMAIN_C, "VENUE_CORROBORATED", true, "ASYNC_BONDED_SOLVER", "d3".repeat(32)),
    );
    assert.equal(submitted.receipt.revision, 3n);
    assert.equal(submitted.receipt.domain.domainId, "hypercore:testnet");

    const confirmed = store.recordEvent(
      intent("event-004", 3n, "ENTRY_CONFIRMED", DOMAIN_A, "CONSENSUS_VERIFIED", true, "ATOMIC_POSTCONDITION", "d4".repeat(32)),
    );
    const opened = store.recordEvent(
      intent("event-005", 4n, "OPEN", DOMAIN_B, "CONSENSUS_VERIFIED", true, "ATOMIC_POSTCONDITION", "d5".repeat(32)),
    );
    const exitRequested = store.recordEvent(
      intent("event-006", 5n, "EXIT_REQUESTED", DOMAIN_C, "VENUE_CORROBORATED", false, "BATCHED_IOC_WITH_RECOVERY", "d6".repeat(32)),
    );
    const exitSubmitted = store.recordEvent(
      intent("event-007", 6n, "EXIT_SUBMITTED", DOMAIN_A, "CONTROLLER_ATTESTED", false, "ATOMIC_POSTCONDITION", "d7".repeat(32)),
    );
    const closed = store.recordEvent(
      intent("event-008", 7n, "CLOSED", DOMAIN_B, "CONSENSUS_VERIFIED", true, "ATOMIC_POSTCONDITION", "d8".repeat(32)),
    );
    assert.equal(closed.receipt.revision, 8n);
    assert.equal(closed.receipt.nextState, "CLOSED");
    assert.equal(store.getAttempt(ATTEMPT_ID)?.state, "CLOSED");

    assert.throws(
      () =>
        store.recordEvent(
          intent("event-009", 8n, "RECOVERY_PENDING", DOMAIN_A, "LOCAL_RECORDED", false, "ATOMIC_POSTCONDITION", "d9".repeat(32)),
        ),
      (error: unknown) => error instanceof PackageLifecycleStoreError && error.code === "TERMINAL_STATE",
    );

    const listed = store.listReceipts(ATTEMPT_ID, 0n, 100);
    assert.equal(listed.length, 8);
    assert.deepEqual(
      listed.map((receipt) => receipt.revision),
      [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n],
    );
    for (let index = 1; index < listed.length; index += 1) {
      const prior = listed[index - 1]!;
      const current = listed[index]!;
      assert.equal(current.priorState, prior.nextState);
      assert.deepEqual(current.previousReceiptHash, packageLifecycleReceiptHash(prior));
    }
    assert.equal(listed[0]!.eventId, "event-001");

    const byEvent = store.getReceiptByEventId("event-003");
    assert.deepEqual(byEvent, submitted.receipt);
  } finally {
    store.close();
  }

  const reopened = new SqlitePackageLifecycleStore(dbPath, { clock });
  try {
    const head = reopened.getAttempt(ATTEMPT_ID);
    assert.ok(head !== undefined);
    assert.equal(head.revision, 8n);
    assert.equal(head.state, "CLOSED");
    const listed = reopened.listReceipts(ATTEMPT_ID, 2n, 10);
    assert.deepEqual(
      listed.map((receipt) => receipt.revision),
      [3n, 4n, 5n, 6n, 7n, 8n],
    );
    const replayed = reopened.recordEvent(
      intent("event-002", 1n, "ENTRY_PREPARED", DOMAIN_B, "CONTROLLER_ATTESTED", false, "BATCHED_IOC_WITH_RECOVERY", "d2".repeat(32)),
    );
    assert.equal(replayed.created, false);
    assert.throws(
      () =>
        reopened.recordEvent(
          intent("event-010", 8n, "OPEN", DOMAIN_A, "LOCAL_RECORDED", false, "ATOMIC_POSTCONDITION", "da".repeat(32)),
        ),
      (error: unknown) => error instanceof PackageLifecycleStoreError && error.code === "TERMINAL_STATE",
    );
  } finally {
    reopened.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("package lifecycle store rejects a reused event id with different bytes", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-lifecycle-conflict-"));
  const dbPath = join(scratch, "lifecycle.db");
  const store = new SqlitePackageLifecycleStore(dbPath);
  try {
    const first = store.recordEvent(
      intent("event-x-001", 0n, "PACKAGE_CREATED", DOMAIN_A, "LOCAL_RECORDED", false, "ATOMIC_POSTCONDITION", "f1".repeat(32)),
    );
    assert.equal(first.created, true);
    assert.throws(
      () =>
        store.recordEvent(
          intent("event-x-001", 0n, "PACKAGE_CREATED", DOMAIN_A, "CONTROLLER_ATTESTED", false, "ATOMIC_POSTCONDITION", "f2".repeat(32)),
        ),
      (error: unknown) => error instanceof PackageLifecycleEventConflictError && error.code === "EVENT_ID_CONFLICT",
    );
  } finally {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
