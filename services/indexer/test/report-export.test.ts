import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseProtocolJson } from "@naryx/protocol-types";
import { exportReconciliationReport, SqliteReceiptIndex, verifyReportHash, type ReconciliationReport } from "../src/index.js";

const hash = (label: string) => Buffer.from(label).toString("hex").padEnd(64, "0").slice(0, 64);

test("the report export covers canonical packages in the range and keeps salts in an owner-only file", () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-report-"));
  const index = new SqliteReceiptIndex(join(dir, "index.sqlite"));
  try {
    const coordinator = `0x${"cc".repeat(20)}`;
    const asyncPackageId = "dd".repeat(32);
    const asyncLocator = (label: string, logIndex: number) => `0x${hash(label)}:${logIndex}`;
    const asyncCloseTransaction = "async-close-release";
    const transition = (state: "RESERVED" | "CLOSED", stateVersion: string, locator: string) => ({
      locator,
      coordinator,
      packageIdHex: asyncPackageId,
      type: "PACKAGE_TRANSITION" as const,
      evidenceGrade: "CONSENSUS_VERIFIED" as const,
      fields: { state, stateVersion, evidenceHash: "00".repeat(32) },
    });
    const event = (packageId: string, locator: string) => ({ locator, packageId, attemptId: `${packageId}-a`, kind: "SETTLED" as const, evidenceGrade: "CONTROLLER_ATTESTED" as const, fieldsHashHex: hash(locator) });
    index.ingestBlock("eip155:84532", { height: 0, blockHashHex: hash("b0"), parentHashHex: "00".repeat(32), events: [] });
    index.ingestBlock("eip155:84532", {
      height: 1,
      blockHashHex: hash("b1"),
      parentHashHex: hash("b0"),
      events: [event("pkg-a", "tx1:0")],
      coordinatorEvents: [transition("RESERVED", "1", asyncLocator("async-reserved", 0))],
    });
    index.ingestBlock("eip155:84532", {
      height: 2,
      blockHashHex: hash("b2"),
      parentHashHex: hash("b1"),
      events: [event("pkg-b", "tx2:0")],
      coordinatorEvents: [
        transition("CLOSED", "2", asyncLocator(asyncCloseTransaction, 0)),
        {
          locator: asyncLocator(asyncCloseTransaction, 1),
          coordinator,
          packageIdHex: asyncPackageId,
          type: "PACKAGE_RELEASED",
          evidenceGrade: "CONSENSUS_VERIFIED",
          fields: {
            bondRecipient: `0x${"11".repeat(20)}`,
            reserveRecipient: `0x${"22".repeat(20)}`,
            reserveAtoms: "100",
            lossRecipient: `0x${"33".repeat(20)}`,
            lossAtoms: "0",
          },
        },
      ],
    });
    index.ingestBlock("eip155:84532", { height: 3, blockHashHex: hash("b3"), parentHashHex: hash("b2"), events: [event("pkg-c", "tx3:0")] });
    assert.deepEqual(index.packageIdsInRange("eip155:84532", 1, 2), ["pkg-a", "pkg-b"]);
    assert.deepEqual(index.asyncPackageRefsInRange("eip155:84532", 1, 2), [{ coordinator, packageIdHex: asyncPackageId }]);
    const out = join(dir, "out");
    const report = exportReconciliationReport(index, { domainId: "eip155:84532", fromHeight: 1, toHeight: 2, reportId: "report-1", periodStartMs: 1, periodEndMs: 2, outDir: out });
    assert.equal(report.rows.length, 3);
    const asyncRow = report.rows.find((row) => row.packageId === `async:${coordinator.slice(2)}:${asyncPackageId}`);
    assert.equal(asyncRow?.outcome, "FAILED_NO_EFFECT");
    assert.equal(asyncRow?.eventCount, 3);
    const written = parseProtocolJson(readFileSync(join(out, "report.json"), "utf8")) as ReconciliationReport;
    assert.ok(verifyReportHash(written));
    assert.match(readFileSync(join(out, "report.csv"), "utf8"), /pkg-a/);
    assert.match(readFileSync(join(out, "report.csv"), "utf8"), /async:cccc/);
    assert.equal(statSync(join(out, "disclosures.json")).mode & 0o777, 0o600);
    assert.throws(() => exportReconciliationReport(index, { domainId: "eip155:84532", fromHeight: 1, toHeight: 2, reportId: "r", periodStartMs: 1, periodEndMs: 2, outDir: "relative" }), /absolute/);
  } finally {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
