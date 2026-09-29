import { canonicalBytes, domainHash, encodeProtocolId, HASH_DOMAIN, protocolId, toHex } from "@naryx/protocol-types";

export const FINALITY = Object.freeze({ OBSERVED: 1, CONFIRMED: 2, FINALIZED: 3 } as const);
export type Finality = keyof typeof FINALITY;

/** Authenticity of the evidence behind an event, never upgraded by the indexer. */
export const EVIDENCE_GRADE = Object.freeze({
  CONTROLLER_ATTESTED: 1,
  VENUE_API_CORROBORATED: 2,
  CONSENSUS_VERIFIED: 3,
} as const);
export type EvidenceGrade = keyof typeof EVIDENCE_GRADE;

export const INDEXED_EVENT_KIND = Object.freeze({
  SUBMITTED: 1,
  VENUE_FILL: 2,
  SETTLED: 3,
  REVERTED: 4,
  DROPPED: 5,
  EXPIRED_NO_EFFECT: 6,
  RECOVERY_STARTED: 7,
  RECOVERED: 8,
} as const);
export type IndexedEventKind = keyof typeof INDEXED_EVENT_KIND;

export type AttemptOutcome =
  | "PENDING"
  | "SETTLED"
  | "FAILED_NO_EFFECT"
  | "PARTIAL_EXPOSURE"
  | "IN_RECOVERY"
  | "RECOVERED"
  | "CONFLICTING_EVIDENCE";
export type PackageOutcome = "UNKNOWN" | AttemptOutcome;

export interface IndexedEvent {
  readonly domainId: string;
  /** Block or slot height; venue fills use the committed sequence the venue reports. */
  readonly height: number;
  readonly locator: string;
  readonly packageId: string;
  readonly attemptId: string;
  readonly kind: IndexedEventKind;
  readonly evidenceGrade: EvidenceGrade;
  /** Hash of the decoded event fields the adapter derived from chain or venue data. */
  readonly fieldsHashHex: string;
  readonly finality: Finality;
}

export interface AttemptRecord {
  readonly attemptId: string;
  readonly outcome: AttemptOutcome;
  readonly finality: Finality;
}

export interface IndexedPackageRecord {
  readonly packageId: string;
  readonly outcome: PackageOutcome;
  /** The weakest finality of any contributing event; a record is final only when every event is. */
  readonly finality: Finality;
  readonly weakestEvidenceGrade: EvidenceGrade | null;
  readonly attempts: readonly AttemptRecord[];
  readonly events: readonly IndexedEvent[];
  readonly recordHashHex: string;
}

const FAILURES: ReadonlySet<IndexedEventKind> = new Set(["REVERTED", "DROPPED", "EXPIRED_NO_EFFECT"]);

function weakest<Name extends string>(table: Readonly<Record<Name, number>>, values: readonly Name[], fallback: Name): Name {
  return values.reduce((low, value) => (table[value] < table[low] ? value : low), values[0] ?? fallback);
}

/**
 * Derives one attempt's outcome from its canonical events, judging each domain leg separately. Two
 * different terminal results on one domain are conflicting evidence for manual review. A leg that
 * settled beside a leg that failed, with no recovery, is partial exposure, never success.
 */
export function attemptOutcome(events: readonly Pick<IndexedEvent, "domainId" | "kind">[]): AttemptOutcome {
  const kinds = events.map((event) => event.kind);
  const byDomain = new Map<string, Set<IndexedEventKind>>();
  for (const event of events) {
    if (event.kind !== "SETTLED" && !FAILURES.has(event.kind)) continue;
    const set = byDomain.get(event.domainId) ?? new Set<IndexedEventKind>();
    set.add(event.kind);
    byDomain.set(event.domainId, set);
  }
  if ([...byDomain.values()].some((set) => set.size > 1)) return "CONFLICTING_EVIDENCE";
  if (kinds.includes("RECOVERED")) return "RECOVERED";
  if (kinds.includes("RECOVERY_STARTED")) return "IN_RECOVERY";
  const domains = new Set(events.map((event) => event.domainId));
  const terminal = [...byDomain.values()].map((set) => [...set][0] as IndexedEventKind);
  const settled = terminal.filter((kind) => kind === "SETTLED").length;
  const failed = terminal.length - settled;
  if (settled > 0 && failed > 0) return "PARTIAL_EXPOSURE";
  if (byDomain.size < domains.size || terminal.length === 0) return "PENDING";
  return settled > 0 ? "SETTLED" : "FAILED_NO_EFFECT";
}

function packageOutcome(attempts: readonly AttemptRecord[]): PackageOutcome {
  if (attempts.length === 0) return "UNKNOWN";
  if (attempts.some((attempt) => attempt.outcome === "CONFLICTING_EVIDENCE")) return "CONFLICTING_EVIDENCE";
  const effective = attempts.filter((attempt) => ["SETTLED", "RECOVERED", "PARTIAL_EXPOSURE", "IN_RECOVERY"].includes(attempt.outcome));
  // More than one attempt with effect means the package executed twice; that is never normal.
  if (effective.length > 1) return "CONFLICTING_EVIDENCE";
  if (effective.length === 1) return (effective[0] as AttemptRecord).outcome;
  if (attempts.some((attempt) => attempt.outcome === "PENDING")) return "PENDING";
  return "FAILED_NO_EFFECT";
}

function compareEvents(left: IndexedEvent, right: IndexedEvent): number {
  const keys: [string | number, string | number][] = [
    [left.domainId, right.domainId],
    [left.height, right.height],
    [left.locator, right.locator],
  ];
  for (const [a, b] of keys) if (a !== b) return a < b ? -1 : 1;
  return 0;
}

/**
 * Builds the normalized package record from canonical events only. Orphaned events never
 * contribute, so the record depends on the canonical chain alone and rebuilds identically after
 * the index is deleted and re-ingested.
 */
export function buildPackageRecord(packageId: string, input: readonly IndexedEvent[]): IndexedPackageRecord {
  const id = protocolId(packageId, "packageRecord.packageId");
  const events = Object.freeze([...input].sort(compareEvents));
  for (const event of events) {
    if (event.packageId !== id) throw new Error("An event for another package was supplied.");
  }
  const attemptIds = [...new Set(events.map((event) => event.attemptId))].sort();
  const attempts = Object.freeze(
    attemptIds.map((attemptId) => {
      const own = events.filter((event) => event.attemptId === attemptId);
      return Object.freeze({
        attemptId,
        outcome: attemptOutcome(own),
        finality: weakest(FINALITY, own.map((event) => event.finality), "OBSERVED"),
      });
    }),
  );
  const outcome = packageOutcome(attempts);
  const finality = events.length === 0 ? "OBSERVED" : weakest(FINALITY, events.map((event) => event.finality), "OBSERVED");
  const weakestEvidenceGrade = events.length === 0 ? null : weakest(EVIDENCE_GRADE, events.map((event) => event.evidenceGrade), "CONTROLLER_ATTESTED");
  const bytes = canonicalBytes((writer) => {
    encodeProtocolId(writer, id, "packageId");
    writer.writeString(outcome, "outcome");
    writer.writeEnum(FINALITY, finality, "finality");
    writer.writeArray(attempts, (element, attempt) => {
      encodeProtocolId(element, protocolId(attempt.attemptId), "attemptId");
      element.writeString(attempt.outcome, "outcome");
      element.writeEnum(FINALITY, attempt.finality, "finality");
    });
    writer.writeArray(events, (element, event) => {
      encodeProtocolId(element, protocolId(event.domainId), "domainId");
      element.writeU64(BigInt(event.height), "height");
      element.writeString(event.locator, "locator");
      encodeProtocolId(element, protocolId(event.attemptId), "attemptId");
      element.writeEnum(INDEXED_EVENT_KIND, event.kind, "kind");
      element.writeEnum(EVIDENCE_GRADE, event.evidenceGrade, "evidenceGrade");
      element.writeString(event.fieldsHashHex, "fieldsHash");
      element.writeEnum(FINALITY, event.finality, "finality");
    });
  });
  return Object.freeze({
    packageId: id,
    outcome,
    finality,
    weakestEvidenceGrade,
    attempts,
    events,
    recordHashHex: toHex(domainHash(HASH_DOMAIN.INDEXED_PACKAGE_RECORD, bytes)),
  });
}
