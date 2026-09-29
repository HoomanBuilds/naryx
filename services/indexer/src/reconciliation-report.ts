import {
  canonicalBytes,
  commitDisclosureRecord,
  discloseFields,
  domainHash,
  encodeProtocolId,
  fromHex,
  HASH_DOMAIN,
  protocolId,
  toHex,
  type DisclosureRecord,
  type SelectiveDisclosure,
} from "@naryx/protocol-types";
import type { IndexedPackageRecord, PackageOutcome } from "./package-record.js";

export const REPORT_OUTCOMES: readonly PackageOutcome[] = Object.freeze([
  "UNKNOWN",
  "PENDING",
  "SETTLED",
  "FAILED_NO_EFFECT",
  "PARTIAL_EXPOSURE",
  "IN_RECOVERY",
  "RECOVERED",
  "CONFLICTING_EVIDENCE",
]);

export const REPORT_ROW_FIELDS = Object.freeze(["outcome", "finality", "evidenceGrade", "attemptCount", "eventCount", "recordHash"] as const);
export type ReportRowField = (typeof REPORT_ROW_FIELDS)[number];

const ATTENTION: ReadonlySet<PackageOutcome> = new Set(["PARTIAL_EXPOSURE", "IN_RECOVERY", "CONFLICTING_EVIDENCE"]);
const TERMINAL: ReadonlySet<PackageOutcome> = new Set(["SETTLED", "FAILED_NO_EFFECT", "RECOVERED"]);
const MAX_ROWS = 10_000;

export interface ReportRow {
  readonly packageId: string;
  readonly outcome: PackageOutcome;
  readonly finality: string;
  readonly evidenceGrade: string;
  readonly attemptCount: number;
  readonly eventCount: number;
  readonly recordHash: string;
  /** Salted commitment to this row's fields, verifiable by an auditor given a disclosure. */
  readonly rowRoot: string;
}

export interface ReconciliationReport {
  readonly reportId: string;
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly rows: readonly ReportRow[];
  readonly counts: Readonly<Record<PackageOutcome, number>>;
  /** Partial exposure, recovery in progress, or contradictory evidence: work for an operator now. */
  readonly requiresAttention: readonly string[];
  /** A terminal outcome that is not yet final on every contributing domain. */
  readonly provisional: readonly string[];
  readonly pending: readonly string[];
  /** Commits to the period, counts, and every row root, never to row values directly. */
  readonly reportHash: string;
}

export interface ReportOptions {
  readonly reportId: string;
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  /** Fresh random 32 bytes per package and field; never derived from the row's own content. */
  readonly salt: (packageId: string, field: ReportRowField) => Uint8Array;
}

function text(value: string | number): Uint8Array {
  return new TextEncoder().encode(String(value));
}

/**
 * Builds a reconciliation and audit report from indexed package records. Every record is kept,
 * including failed, partial, conflicting, and unresolved packages. Each row is committed with
 * salted field commitments so the report hash can be shared while an auditor receives only the
 * fields a disclosure reveals.
 */
export function reconciliationReport(
  records: readonly IndexedPackageRecord[],
  options: ReportOptions,
): { readonly report: ReconciliationReport; readonly disclosures: ReadonlyMap<string, DisclosureRecord> } {
  const reportId = protocolId(options.reportId, "reconciliationReport.reportId");
  const { periodStartMs, periodEndMs } = options;
  if (!Number.isSafeInteger(periodStartMs) || !Number.isSafeInteger(periodEndMs) || periodStartMs < 0 || periodEndMs <= periodStartMs) {
    throw new Error("Report period must be a nonempty interval of nonnegative milliseconds.");
  }
  if (!Array.isArray(records) || records.length > MAX_ROWS) throw new Error(`A report holds at most ${MAX_ROWS} packages.`);
  const sorted = [...records].sort((a, b) => (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0));
  for (let index = 1; index < sorted.length; index += 1) {
    if ((sorted[index - 1] as IndexedPackageRecord).packageId === (sorted[index] as IndexedPackageRecord).packageId) {
      throw new Error("A package appears twice in the report.");
    }
  }
  const disclosures = new Map<string, DisclosureRecord>();
  const rows = sorted.map((record) => {
    const values: Record<ReportRowField, string | number> = {
      outcome: record.outcome,
      finality: record.finality,
      evidenceGrade: record.weakestEvidenceGrade ?? "NONE",
      attemptCount: record.attempts.length,
      eventCount: record.events.length,
      recordHash: record.recordHashHex,
    };
    const committed = commitDisclosureRecord(
      record.packageId,
      REPORT_ROW_FIELDS.map((field) => ({ name: field, value: text(values[field]), salt: options.salt(record.packageId, field) })),
    );
    disclosures.set(record.packageId, committed);
    return Object.freeze({
      packageId: record.packageId,
      outcome: record.outcome,
      finality: record.finality,
      evidenceGrade: String(values.evidenceGrade),
      attemptCount: record.attempts.length,
      eventCount: record.events.length,
      recordHash: record.recordHashHex,
      rowRoot: toHex(committed.root),
    });
  });
  const counts = Object.fromEntries(REPORT_OUTCOMES.map((outcome) => [outcome, rows.filter((row) => row.outcome === outcome).length])) as Record<PackageOutcome, number>;
  const requiresAttention = rows.filter((row) => ATTENTION.has(row.outcome)).map((row) => row.packageId);
  const provisional = rows.filter((row) => TERMINAL.has(row.outcome) && row.finality !== "FINALIZED").map((row) => row.packageId);
  const pending = rows.filter((row) => row.outcome === "PENDING" || row.outcome === "UNKNOWN").map((row) => row.packageId);
  const bytes = canonicalBytes((writer) => {
    encodeProtocolId(writer, reportId, "reportId");
    writer.writeU64(BigInt(periodStartMs), "periodStartMs");
    writer.writeU64(BigInt(periodEndMs), "periodEndMs");
    writer.writeArray(REPORT_OUTCOMES, (element, outcome) => {
      element.writeString(outcome, "outcome");
      element.writeU32(counts[outcome], "count");
    });
    writer.writeArray(rows, (element, row) => {
      encodeProtocolId(element, protocolId(row.packageId), "packageId");
      element.writeFixedBytes(fromHex(row.rowRoot), 32, "rowRoot");
    });
  });
  const report = Object.freeze({
    reportId,
    periodStartMs,
    periodEndMs,
    rows: Object.freeze(rows),
    counts: Object.freeze(counts),
    requiresAttention: Object.freeze(requiresAttention),
    provisional: Object.freeze(provisional),
    pending: Object.freeze(pending),
    reportHash: toHex(domainHash(HASH_DOMAIN.RECONCILIATION_REPORT, bytes)),
  });
  return Object.freeze({ report, disclosures });
}

/** Recomputes a report hash from its period, counts, and row roots, as an auditor holding the report would. */
export function verifyReportHash(report: ReconciliationReport): boolean {
  const bytes = canonicalBytes((writer) => {
    encodeProtocolId(writer, protocolId(report.reportId), "reportId");
    writer.writeU64(BigInt(report.periodStartMs), "periodStartMs");
    writer.writeU64(BigInt(report.periodEndMs), "periodEndMs");
    writer.writeArray(REPORT_OUTCOMES, (element, outcome) => {
      element.writeString(outcome, "outcome");
      element.writeU32(report.counts[outcome] ?? 0, "count");
    });
    writer.writeArray(report.rows, (element, row) => {
      encodeProtocolId(element, protocolId(row.packageId), "packageId");
      element.writeFixedBytes(fromHex(row.rowRoot), 32, "rowRoot");
    });
  });
  const counted = REPORT_OUTCOMES.reduce((sum, outcome) => sum + (report.counts[outcome] ?? 0), 0);
  return counted === report.rows.length && toHex(domainHash(HASH_DOMAIN.RECONCILIATION_REPORT, bytes)) === report.reportHash;
}

/** Reveals the named fields of one row for an auditor; the rest stay as salted commitments. */
export function discloseReportRow(
  disclosures: ReadonlyMap<string, DisclosureRecord>,
  packageId: string,
  fields: readonly ReportRowField[],
): SelectiveDisclosure {
  const record = disclosures.get(packageId);
  if (record === undefined) throw new Error("No such package in the report.");
  return discloseFields(record, fields);
}

function csvCell(value: string | number): string {
  const cell = String(value);
  if (!/^[\x20-\x7e]*$/.test(cell)) throw new Error("Accounting export cells must be printable ASCII.");
  return /[",]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/** A deterministic accounting export: fixed columns, rows in package order, CRLF line endings. */
export function accountingCsv(report: ReconciliationReport): string {
  const header = ["package_id", "outcome", "finality", "evidence_grade", "attempt_count", "event_count", "record_hash", "row_root"];
  const lines = [
    header.join(","),
    ...report.rows.map((row) =>
      [row.packageId, row.outcome, row.finality, row.evidenceGrade, row.attemptCount, row.eventCount, row.recordHash, row.rowRoot].map(csvCell).join(","),
    ),
  ];
  return `${lines.join("\r\n")}\r\n`;
}
