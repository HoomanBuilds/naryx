import { exportReconciliationReport } from "./report-export.js";
import { SqliteReceiptIndex } from "./receipt-index.js";

/**
 * Writes one reconciliation report from the durable index: NARYX_INDEXER_DB, NARYX_REPORT_DOMAIN,
 * NARYX_REPORT_FROM_HEIGHT, NARYX_REPORT_TO_HEIGHT, NARYX_REPORT_ID, NARYX_REPORT_PERIOD_START_MS,
 * NARYX_REPORT_PERIOD_END_MS, and NARYX_REPORT_OUT_DIR. It reads only; nothing is sent anywhere.
 */
const environment = process.env;
const integer = (name: string): number => {
  const value = Number(environment[name] ?? "");
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  return value;
};
const dbPath = environment.NARYX_INDEXER_DB ?? "";
if (!dbPath.startsWith("/")) throw new Error("NARYX_INDEXER_DB must be an absolute path");
const index = new SqliteReceiptIndex(dbPath);
try {
  const report = exportReconciliationReport(index, {
    domainId: environment.NARYX_REPORT_DOMAIN ?? "",
    fromHeight: integer("NARYX_REPORT_FROM_HEIGHT"),
    toHeight: integer("NARYX_REPORT_TO_HEIGHT"),
    reportId: environment.NARYX_REPORT_ID ?? "",
    periodStartMs: integer("NARYX_REPORT_PERIOD_START_MS"),
    periodEndMs: integer("NARYX_REPORT_PERIOD_END_MS"),
    outDir: environment.NARYX_REPORT_OUT_DIR ?? "",
  });
  process.stdout.write(`Report ${report.reportId}: ${report.rows.length} packages, hash ${report.reportHash}\n`);
} finally {
  index.close();
}
