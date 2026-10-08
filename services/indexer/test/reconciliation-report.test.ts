import assert from "node:assert/strict";
import test from "node:test";
import { verifySelectiveDisclosure } from "@naryx/protocol-types";
import {
  accountingCsv,
  asyncPackageReconciliationRecord,
  buildPackageRecord,
  discloseReportRow,
  reconciliationReport,
  verifyReportHash,
  type IndexedEvent,
  type IndexedPackageRecord,
  type ObservedAsyncPackage,
} from "../src/index.js";

const fields = "ab".repeat(32);
const event = (packageId: string, domainId: string, kind: IndexedEvent["kind"], finality: IndexedEvent["finality"] = "FINALIZED", attemptId = "a1"): IndexedEvent => ({
  domainId,
  height: 1,
  locator: `${domainId}-${kind}-${attemptId}`,
  packageId,
  attemptId,
  kind,
  evidenceGrade: "CONSENSUS_VERIFIED",
  fieldsHashHex: fields,
  finality,
});

const records: IndexedPackageRecord[] = [
  buildPackageRecord("pkg-settled", [event("pkg-settled", "sol", "SETTLED")]),
  buildPackageRecord("pkg-provisional", [event("pkg-provisional", "sol", "SETTLED", "OBSERVED")]),
  buildPackageRecord("pkg-reverted", [event("pkg-reverted", "sol", "REVERTED")]),
  buildPackageRecord("pkg-partial", [event("pkg-partial", "sol", "SETTLED"), event("pkg-partial", "base", "REVERTED")]),
  buildPackageRecord("pkg-conflict", [event("pkg-conflict", "sol", "SETTLED", "FINALIZED", "a1"), event("pkg-conflict", "sol", "SETTLED", "FINALIZED", "a2")]),
  buildPackageRecord("pkg-pending", [event("pkg-pending", "sol", "SUBMITTED", "OBSERVED")]),
];

let counter = 0;
const options = {
  reportId: "2026-09-report",
  periodStartMs: 1_000,
  periodEndMs: 2_000,
  salt: () => {
    counter += 1;
    return new Uint8Array(32).fill(counter % 251);
  },
};

const asyncPackage = (state: ObservedAsyncPackage["state"], status: ObservedAsyncPackage["status"], packageByte: string): ObservedAsyncPackage => ({
  coordinator: `0x${"11".repeat(20)}`,
  packageIdHex: packageByte.repeat(32),
  status,
  state,
  stateVersion: "2",
  evidenceHash: "33".repeat(32),
  observedFromReservation: true,
  transitions: [
    { locator: `0x${"44".repeat(32)}:0`, height: 10, state: "RESERVED", stateVersion: "1", evidenceHash: "00".repeat(32) },
    { locator: `0x${"55".repeat(32)}:0`, height: 11, state: state ?? "RESERVED", stateVersion: "2", evidenceHash: "33".repeat(32) },
  ],
  slashedBondAtoms: null,
  release: null,
  lastHeight: 11,
  finality: "CONFIRMED",
  evidenceGrade: "CONSENSUS_VERIFIED",
  violations: status === "INCONSISTENT" ? ["state evidence conflicts"] : [],
});

test("every package is kept and unresolved work is flagged, not dropped", () => {
  const { report } = reconciliationReport(records, options);
  assert.equal(report.rows.length, 6);
  assert.equal(report.counts.SETTLED, 2);
  assert.equal(report.counts.FAILED_NO_EFFECT, 1);
  assert.equal(report.counts.PARTIAL_EXPOSURE, 1);
  assert.equal(report.counts.CONFLICTING_EVIDENCE, 1);
  assert.equal(report.counts.PENDING, 1);
  assert.deepEqual(report.requiresAttention, ["pkg-conflict", "pkg-partial"]);
  assert.deepEqual(report.provisional, ["pkg-provisional"]);
  assert.deepEqual(report.pending, ["pkg-pending"]);
  assert.ok(verifyReportHash(report));
});

test("async recovery and inconsistent coordinator evidence require operator attention", () => {
  const recovering = asyncPackageReconciliationRecord("eip155:421614", asyncPackage("RECOVERY_PENDING", "OPEN", "22"));
  const inconsistent = asyncPackageReconciliationRecord("eip155:421614", asyncPackage("MANUAL_INTERVENTION", "INCONSISTENT", "23"));
  const { report } = reconciliationReport([recovering, inconsistent], options);
  assert.equal(recovering.outcome, "IN_RECOVERY");
  assert.equal(inconsistent.outcome, "CONFLICTING_EVIDENCE");
  assert.deepEqual(report.requiresAttention, [inconsistent.packageId, recovering.packageId].sort());
});

test("the report hash depends on content, not input order, and detects tampering", () => {
  const fixedSalt = { ...options, salt: (packageId: string, field: string) => new Uint8Array(32).fill((packageId.length * 7 + field.length) % 251) };
  const first = reconciliationReport(records, fixedSalt).report;
  const reversed = reconciliationReport([...records].reverse(), fixedSalt).report;
  assert.equal(first.reportHash, reversed.reportHash);
  const tampered = { ...first, rows: first.rows.map((row, index) => (index === 0 ? { ...row, rowRoot: "cd".repeat(32) } : row)) };
  assert.equal(verifyReportHash(tampered), false);
  const recounted = { ...first, counts: { ...first.counts, SETTLED: 3, PENDING: 0 } };
  assert.equal(verifyReportHash(recounted), false);
  assert.throws(() => reconciliationReport([records[0] as IndexedPackageRecord, records[0] as IndexedPackageRecord], options), /appears twice/);
  assert.throws(() => reconciliationReport(records, { ...options, periodEndMs: 1_000 }), /nonempty interval/);
});

test("an auditor verifies only the disclosed fields of one row against its root", () => {
  const { report, disclosures } = reconciliationReport(records, options);
  const disclosure = discloseReportRow(disclosures, "pkg-partial", ["outcome", "finality"]);
  const row = report.rows.find((entry) => entry.packageId === "pkg-partial");
  const revealed = verifySelectiveDisclosure(row?.rowRoot as string, disclosure);
  assert.deepEqual([...revealed.keys()], ["finality", "outcome"]);
  assert.equal(new TextDecoder().decode(revealed.get("outcome")), "PARTIAL_EXPOSURE");
  assert.deepEqual(disclosure.withheld.map((field) => field.name).sort(), ["attemptCount", "eventCount", "evidenceGrade", "recordHash"]);
  assert.throws(() => discloseReportRow(disclosures, "pkg-missing", ["outcome"]), /No such package/);
});

test("the accounting export is deterministic with fixed columns and CRLF rows", () => {
  const { report } = reconciliationReport(records, options);
  const csv = accountingCsv(report);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "package_id,outcome,finality,evidence_grade,attempt_count,event_count,record_hash,row_root");
  assert.equal(lines.length, 8);
  assert.equal(lines[7], "");
  assert.ok(lines[1]?.startsWith("pkg-conflict,CONFLICTING_EVIDENCE,FINALIZED,CONSENSUS_VERIFIED,2,2,"));
  assert.equal(accountingCsv(report), csv);
});
