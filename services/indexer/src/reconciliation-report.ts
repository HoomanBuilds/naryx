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
import type { CoordinatorState, ObservedAsyncPackage } from "./async-coordinator.js";

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
const ASYNC_RECOVERY_STATES: ReadonlySet<CoordinatorState> = new Set(["FROZEN", "RECOVERY_PENDING", "RECOVERED", "MANUAL_INTERVENTION"]);
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

export interface ReconciliationSourceRecord {
  readonly packageId: string;
  readonly outcome: PackageOutcome;
  readonly finality: string;
  readonly evidenceGrade: string | null;
  readonly attemptCount: number;
  readonly eventCount: number;
  readonly recordHashHex: string;
}

function text(value: string | number): Uint8Array {
  return new TextEncoder().encode(String(value));
}

function asyncOutcome(observed: ObservedAsyncPackage): PackageOutcome {
  if (observed.status === "INCONSISTENT") return "CONFLICTING_EVIDENCE";
  const states = new Set(observed.transitions.map((transition) => transition.state));
  if (observed.status === "RELEASED") {
    if ([...states].some((state) => ASYNC_RECOVERY_STATES.has(state))) return "RECOVERED";
    return states.has("EXECUTED") ? "SETTLED" : "FAILED_NO_EFFECT";
  }
  return observed.state !== null && ASYNC_RECOVERY_STATES.has(observed.state)
    ? "IN_RECOVERY"
    : "PENDING";
}

/** Normalizes one independently replayed async coordinator lifecycle without calling it atomic. */
export function asyncPackageReconciliationRecord(
  domainIdInput: string,
  observed: ObservedAsyncPackage,
): ReconciliationSourceRecord {
  const domainId = protocolId(domainIdInput, "asyncPackageReconciliationRecord.domainId");
  if (!/^0x[0-9a-f]{40}$/.test(observed.coordinator) || !/^[0-9a-f]{64}$/.test(observed.packageIdHex)) {
    throw new Error("Async package identity is malformed.");
  }
  const packageId = protocolId(`async:${observed.coordinator.slice(2)}:${observed.packageIdHex}`, "asyncPackageReconciliationRecord.packageId");
  const bytes = canonicalBytes((writer) => {
    writer.writeString("ASYNC_COORDINATOR", "sourceKind");
    encodeProtocolId(writer, domainId, "domainId");
    writer.writeString(observed.coordinator, "coordinator");
    writer.writeFixedBytes(fromHex(observed.packageIdHex), 32, "packageId");
    writer.writeString(observed.status, "status");
    writer.writeOptional(observed.state ?? undefined, (element, value) => element.writeString(value, "state"), "state");
    writer.writeOptional(observed.stateVersion ?? undefined, (element, value) => element.writeU64(BigInt(value), "stateVersion"), "stateVersion");
    writer.writeOptional(observed.evidenceHash ?? undefined, (element, value) => element.writeFixedBytes(fromHex(value), 32, "evidenceHash"), "evidenceHash");
    writer.writeBool(observed.observedFromReservation, "observedFromReservation");
    writer.writeArray(observed.transitions, (element, transition) => {
      element.writeString(transition.locator, "locator");
      element.writeU64(BigInt(transition.height), "height");
      element.writeString(transition.state, "state");
      element.writeU64(BigInt(transition.stateVersion), "stateVersion");
      element.writeFixedBytes(fromHex(transition.evidenceHash), 32, "evidenceHash");
    });
    writer.writeOptional(observed.slashedBondAtoms ?? undefined, (element, value) => element.writeU256(BigInt(value), "slashedBondAtoms"), "slashedBondAtoms");
    writer.writeOptional(observed.release ?? undefined, (element, release) => {
      element.writeString(release.bondRecipient, "bondRecipient");
      element.writeString(release.reserveRecipient, "reserveRecipient");
      element.writeU256(BigInt(release.reserveAtoms), "reserveAtoms");
      element.writeString(release.lossRecipient, "lossRecipient");
      element.writeU256(BigInt(release.lossAtoms), "lossAtoms");
    }, "release");
    writer.writeU64(BigInt(observed.lastHeight), "lastHeight");
    writer.writeString(observed.finality, "finality");
    writer.writeString(observed.evidenceGrade, "evidenceGrade");
    writer.writeArray(observed.violations, (element, violation) => element.writeString(violation, "violation"));
  });
  return Object.freeze({
    packageId,
    outcome: asyncOutcome(observed),
    finality: observed.finality,
    evidenceGrade: observed.evidenceGrade,
    attemptCount: 1,
    eventCount: observed.transitions.length + (observed.slashedBondAtoms === null ? 0 : 1) + (observed.release === null ? 0 : 1),
    recordHashHex: toHex(domainHash(HASH_DOMAIN.INDEXED_PACKAGE_RECORD, bytes)),
  });
}

function sourceRecord(record: IndexedPackageRecord | ReconciliationSourceRecord): ReconciliationSourceRecord {
  if ("attempts" in record) {
    return Object.freeze({
      packageId: record.packageId,
      outcome: record.outcome,
      finality: record.finality,
      evidenceGrade: record.weakestEvidenceGrade,
      attemptCount: record.attempts.length,
      eventCount: record.events.length,
      recordHashHex: record.recordHashHex,
    });
  }
  return record;
}

/**
 * Builds a reconciliation and audit report from indexed package records. Every record is kept,
 * including failed, partial, conflicting, and unresolved packages. Each row is committed with
 * salted field commitments so the report hash can be shared while an auditor receives only the
 * fields a disclosure reveals.
 */
export function reconciliationReport(
  records: readonly (IndexedPackageRecord | ReconciliationSourceRecord)[],
  options: ReportOptions,
): { readonly report: ReconciliationReport; readonly disclosures: ReadonlyMap<string, DisclosureRecord> } {
  const reportId = protocolId(options.reportId, "reconciliationReport.reportId");
  const { periodStartMs, periodEndMs } = options;
  if (!Number.isSafeInteger(periodStartMs) || !Number.isSafeInteger(periodEndMs) || periodStartMs < 0 || periodEndMs <= periodStartMs) {
    throw new Error("Report period must be a nonempty interval of nonnegative milliseconds.");
  }
  if (!Array.isArray(records) || records.length > MAX_ROWS) throw new Error(`A report holds at most ${MAX_ROWS} packages.`);
  const sorted = records.map(sourceRecord).sort((a, b) => (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0));
  for (let index = 1; index < sorted.length; index += 1) {
    if ((sorted[index - 1] as ReconciliationSourceRecord).packageId === (sorted[index] as ReconciliationSourceRecord).packageId) {
      throw new Error("A package appears twice in the report.");
    }
  }
  const disclosures = new Map<string, DisclosureRecord>();
  const rows = sorted.map((record) => {
    const values: Record<ReportRowField, string | number> = {
      outcome: record.outcome,
      finality: record.finality,
      evidenceGrade: record.evidenceGrade ?? "NONE",
      attemptCount: record.attemptCount,
      eventCount: record.eventCount,
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
      attemptCount: record.attemptCount,
      eventCount: record.eventCount,
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
