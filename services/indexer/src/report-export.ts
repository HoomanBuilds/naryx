import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { stringifyProtocolJson } from "@naryx/protocol-types";
import { accountingCsv, reconciliationReport, type ReconciliationReport } from "./reconciliation-report.js";
import type { SqliteReceiptIndex } from "./receipt-index.js";

export interface ReportExportOptions {
  readonly domainId: string;
  readonly fromHeight: number;
  readonly toHeight: number;
  readonly reportId: string;
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  /** Absolute directory for report.json, report.csv, and the private disclosures.json. */
  readonly outDir: string;
}

/**
 * Exports the reconciliation report for every package with a canonical event in a height range:
 * the shareable report with its hash, the accounting CSV, and the salts behind every field
 * commitment in a separate owner-only file, from which single rows are disclosed to an auditor.
 * Every field salt is fresh random bytes, so an undisclosed field cannot be guessed from its commitment.
 */
const MAX_REPORT_PACKAGES = 10_000;

export function exportReconciliationReport(index: Pick<SqliteReceiptIndex, "packageIdsInRange" | "packageRecord">, options: ReportExportOptions): ReconciliationReport {
  if (!isAbsolute(options.outDir)) throw new Error("The report directory must be an absolute path.");
  // A report claims every package in the range, so a range too large for one report fails
  // instead of silently leaving packages out.
  const packageIds = index.packageIdsInRange(options.domainId, options.fromHeight, options.toHeight, MAX_REPORT_PACKAGES + 1);
  if (packageIds.length > MAX_REPORT_PACKAGES) throw new Error(`The range holds more than ${MAX_REPORT_PACKAGES} packages; export it in smaller ranges.`);
  const records = packageIds.map((packageId) => index.packageRecord(packageId));
  const { report, disclosures } = reconciliationReport(records, {
    reportId: options.reportId,
    periodStartMs: options.periodStartMs,
    periodEndMs: options.periodEndMs,
    salt: () => new Uint8Array(randomBytes(32)),
  });
  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(join(options.outDir, "report.json"), stringifyProtocolJson(report), { mode: 0o644 });
  writeFileSync(join(options.outDir, "report.csv"), accountingCsv(report), { mode: 0o644 });
  writeFileSync(join(options.outDir, "disclosures.json"), stringifyProtocolJson(Object.fromEntries(disclosures)), { mode: 0o600 });
  return report;
}
