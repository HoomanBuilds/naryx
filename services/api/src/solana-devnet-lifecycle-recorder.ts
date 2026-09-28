import { createHash } from "node:crypto";
import type {
  PackageEvidenceGrade,
  PackageLifecycleState,
} from "@naryx/protocol-types";
import type { PackageLifecycleStore } from "./package-lifecycle-store.js";
import type {
  PreparedSolanaDevnetRecord,
  SolanaDevnetPackageLifecycleRecorder as SolanaDevnetRecorderPort,
} from "./solana-devnet-runtime-ports.js";
import type { PrivateTerminalExecutionObservation } from "./terminal-execution.js";

const EVIDENCE_DOMAIN = "NARYX/solana-devnet-lifecycle-evidence/v1";
const EVENT_ID_PREFIX = "solana-devnet-lifecycle";

function lengthPrefixedAscii(value: string): Buffer {
  const bytes = Buffer.from(value, "ascii");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([prefix, bytes]);
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function computeEvidenceCommitment(fields: readonly string[]): Uint8Array {
  const hash = createHash("sha256");
  hash.update(Buffer.from(EVIDENCE_DOMAIN, "ascii"));
  for (const field of fields) {
    hash.update(lengthPrefixedAscii(field));
  }
  return Uint8Array.from(hash.digest());
}

function stateSlug(state: PackageLifecycleState): string {
  switch (state) {
    case "PACKAGE_CREATED":
      return "package-created";
    case "ENTRY_PREPARED":
      return "entry-prepared";
    case "ENTRY_SUBMITTED":
      return "entry-submitted";
    case "ENTRY_CONFIRMED":
      return "entry-confirmed";
    case "EXIT_REQUESTED":
      return "exit-requested";
    case "EXIT_SUBMITTED":
      return "exit-submitted";
    case "RECOVERY_PENDING":
      return "recovery-pending";
    case "FAILED":
      return "failed";
    case "EXPIRED":
      return "expired";
    default:
      throw new Error(`Unsupported lifecycle state "${state}" for Solana devnet evidence.`);
  }
}

function computeEventId(nextState: PackageLifecycleState, evidenceCommitment: Uint8Array): string {
  const evidenceHex = toHex(evidenceCommitment);
  const eventId = `${EVENT_ID_PREFIX}-${stateSlug(nextState)}-${evidenceHex}`;
  if (eventId.length > 128) {
    throw new Error("Derived lifecycle event id exceeds the protocol bound.");
  }
  return eventId;
}

function commonFields(
  record: PreparedSolanaDevnetRecord,
  nextState: PackageLifecycleState,
  grade: PackageEvidenceGrade,
): readonly string[] {
  const binding = record.lifecycleBinding;
  return [
    binding.attemptId,
    binding.packageId,
    binding.packageCommitmentHex,
    binding.action,
    binding.domain.domainId,
    String(binding.domain.domainManifestVersion),
    toHex(binding.domain.domainManifestHash),
    binding.settlementClass,
    nextState,
    grade,
    "false",
    binding.evidenceSource.subjectId,
    String(binding.evidenceSource.manifestVersion),
    toHex(binding.evidenceSource.manifestHash),
  ];
}

function preparedFields(record: PreparedSolanaDevnetRecord): readonly string[] {
  return [
    record.materialization.requestCommitment,
    record.materialization.messageBase64,
    String(record.materialization.lastValidBlockHeight),
  ];
}

function submittedFields(signature: string, observedSlot: number | null): readonly string[] {
  return [signature, observedSlot === null ? "null" : String(observedSlot)];
}

function finalizedFields(signature: string, finalizedSlot: number): readonly string[] {
  return [signature, String(finalizedSlot)];
}

function failedFields(signature: string, failedSlot: number | null, failureCode: string): readonly string[] {
  return [signature, failedSlot === null ? "null" : String(failedSlot), failureCode];
}

function expiredFields(signature: string, lastValid: number, observed: number): readonly string[] {
  return [signature, String(lastValid), String(observed)];
}

function requireBindingPresent(record: PreparedSolanaDevnetRecord): void {
  const binding = record.lifecycleBinding;
  if (binding === undefined) {
    throw new Error("Prepared record is missing its lifecycle binding.");
  }
  if (record.materialization.lifecycleAttemptId !== binding.attemptId) {
    throw new Error("Materialization lifecycle attempt does not match its binding.");
  }
  if (binding.action === "ENTRY" && record.request.mode !== "entry") {
    throw new Error("Lifecycle binding action does not match the request mode.");
  }
  if (binding.action === "EXIT" && record.request.mode !== "exit") {
    throw new Error("Lifecycle binding action does not match the request mode.");
  }
}

function verifyHeadBinding(
  store: PackageLifecycleStore,
  record: PreparedSolanaDevnetRecord,
): { revision: bigint; state: PackageLifecycleState } | undefined {
  const binding = record.lifecycleBinding;
  const head = store.getAttempt(binding.attemptId);
  if (head === undefined) return undefined;
  if (head.packageId !== binding.packageId ||
      head.packageCommitmentHex.toLowerCase() !== binding.packageCommitmentHex.toLowerCase()) {
    throw new Error("Lifecycle head package binding does not match the prepared record.");
  }
  if (head.attemptId !== binding.attemptId) {
    throw new Error("Lifecycle head attempt does not match the prepared record.");
  }
  return { revision: head.revision, state: head.state };
}

function recordOne(
  store: PackageLifecycleStore,
  record: PreparedSolanaDevnetRecord,
  nextState: PackageLifecycleState,
  grade: PackageEvidenceGrade,
  extra: readonly string[],
): void {
  const binding = record.lifecycleBinding;
  const head = store.getAttempt(binding.attemptId);
  let expectedRevision: bigint;
  if (head === undefined) {
    if (nextState !== "PACKAGE_CREATED") {
      throw new Error("First lifecycle event must create the package.");
    }
    expectedRevision = 0n;
  } else {
    if (head.packageId !== binding.packageId ||
        head.packageCommitmentHex.toLowerCase() !== binding.packageCommitmentHex.toLowerCase()) {
      throw new Error("Lifecycle head package binding does not match the prepared record.");
    }
    expectedRevision = head.revision;
  }
  const evidenceCommitment = computeEvidenceCommitment([...commonFields(record, nextState, grade), ...extra]);
  const eventId = computeEventId(nextState, evidenceCommitment);
  const domainManifestHash = Uint8Array.from(binding.domain.domainManifestHash) as unknown as import("@naryx/protocol-types").ManifestHash;
  const evidenceManifestHash = Uint8Array.from(binding.evidenceSource.manifestHash) as unknown as import("@naryx/protocol-types").ManifestHash;
  const evidenceCommitmentBranded = evidenceCommitment as unknown as import("@naryx/protocol-types").CommitmentHash;
  store.recordEvent({
    version: 1,
    domain: {
      domainId: binding.domain.domainId,
      domainManifestVersion: binding.domain.domainManifestVersion,
      domainManifestHash,
    },
    settlementClass: binding.settlementClass,
    packageId: binding.packageId,
    packageCommitment: binding.packageCommitmentHex,
    attemptId: binding.attemptId,
    eventId,
    expectedRevision,
    nextState,
    evidenceGrade: grade,
    onchainEnforced: false,
    evidenceSource: {
      subjectId: binding.evidenceSource.subjectId,
      manifestVersion: binding.evidenceSource.manifestVersion,
      manifestHash: evidenceManifestHash,
    },
    evidenceCommitment: evidenceCommitmentBranded,
  });
}

function isAtOrBeyondEntryPrepared(state: PackageLifecycleState): boolean {
  return state !== "PACKAGE_CREATED";
}

function isAtOrBeyondEntrySubmitted(state: PackageLifecycleState): boolean {
  return state !== "PACKAGE_CREATED" && state !== "ENTRY_PREPARED";
}

function isAtOrBeyondEntryConfirmed(state: PackageLifecycleState): boolean {
  return isAtOrBeyondEntrySubmitted(state) && state !== "ENTRY_SUBMITTED";
}

function isAtOrBeyondExitRequested(state: PackageLifecycleState): boolean {
  return state === "EXIT_REQUESTED" || state === "EXIT_SUBMITTED" ||
    state === "RECOVERY_PENDING" || state === "MANUAL_INTERVENTION" ||
    state === "CLOSED" || state === "FAILED" || state === "EXPIRED" || state === "CANCELLED";
}

function isAtOrBeyondExitSubmitted(state: PackageLifecycleState): boolean {
  return state === "EXIT_SUBMITTED" || state === "RECOVERY_PENDING" ||
    state === "MANUAL_INTERVENTION" || state === "CLOSED" ||
    state === "FAILED" || state === "EXPIRED" || state === "CANCELLED";
}

export class SolanaDevnetLifecycleStoreRecorder implements SolanaDevnetRecorderPort {
  private readonly store: PackageLifecycleStore;

  constructor(store: PackageLifecycleStore) {
    if (typeof store?.recordEvent !== "function" || typeof store?.getAttempt !== "function") {
      throw new Error("Lifecycle recorder requires a package lifecycle store.");
    }
    this.store = store;
  }

  recordPrepared(record: PreparedSolanaDevnetRecord): void {
    requireBindingPresent(record);
    const binding = record.lifecycleBinding;
    const headInfo = verifyHeadBinding(this.store, record);
    if (binding.action === "ENTRY") {
      if (headInfo === undefined) {
        recordOne(this.store, record, "PACKAGE_CREATED", "LOCAL_RECORDED", []);
        recordOne(this.store, record, "ENTRY_PREPARED", "CONTROLLER_ATTESTED", preparedFields(record));
        return;
      }
      if (headInfo.state === "PACKAGE_CREATED") {
        recordOne(this.store, record, "ENTRY_PREPARED", "CONTROLLER_ATTESTED", preparedFields(record));
        return;
      }
      if (!isAtOrBeyondEntryPrepared(headInfo.state)) {
        throw new Error(`Entry preparation is invalid from "${headInfo.state}".`);
      }
      return;
    }
    if (headInfo === undefined) {
      throw new Error("Exit preparation requires an open package history.");
    }
    if (headInfo.state === "OPEN" || headInfo.state === "RECOVERY_PENDING") {
      recordOne(this.store, record, "EXIT_REQUESTED", "CONTROLLER_ATTESTED", preparedFields(record));
      return;
    }
    if (headInfo.state === "EXIT_REQUESTED" || headInfo.state === "EXIT_SUBMITTED") {
      return;
    }
    throw new Error(`Exit preparation is invalid from "${headInfo.state}".`);
  }

  recordObservation(
    record: PreparedSolanaDevnetRecord,
    observation: PrivateTerminalExecutionObservation,
  ): void {
    requireBindingPresent(record);
    if (record.boundSignature === undefined) {
      throw new Error("Prepared record has no bound signature for observation.");
    }
    if (record.boundSignature !== observation.signature) {
      throw new Error("Observation signature does not match the bound preparation.");
    }
    const binding = record.lifecycleBinding;
    const headInfo = verifyHeadBinding(this.store, record);
    if (headInfo === undefined) {
      throw new Error("Observation requires an existing package history.");
    }
    if (binding.action === "ENTRY") {
      this.recordEntryObservation(record, observation, headInfo.state);
      return;
    }
    this.recordExitObservation(record, observation, headInfo.state);
  }

  private recordEntryObservation(
    record: PreparedSolanaDevnetRecord,
    observation: PrivateTerminalExecutionObservation,
    headState: PackageLifecycleState,
  ): void {
    if (observation.lifecycle === "SUBMITTED") {
      if (headState === "ENTRY_PREPARED") {
        recordOne(
          this.store,
          record,
          "ENTRY_SUBMITTED",
          "CONTROLLER_ATTESTED",
          submittedFields(observation.signature, observation.observedSlot),
        );
        return;
      }
      if (headState === "PACKAGE_CREATED") {
        throw new Error("Submitted observation requires a prepared entry.");
      }
      if (!isAtOrBeyondEntrySubmitted(headState)) {
        throw new Error(`Submitted observation is invalid from "${headState}".`);
      }
      return;
    }
    if (observation.lifecycle === "FINALIZED") {
      let current: PackageLifecycleState = headState;
      if (current === "ENTRY_PREPARED") {
        recordOne(
          this.store,
          record,
          "ENTRY_SUBMITTED",
          "CONTROLLER_ATTESTED",
          submittedFields(observation.signature, observation.finalizedSlot),
        );
        const refreshed = this.store.getAttempt(record.lifecycleBinding.attemptId);
        if (refreshed === undefined) throw new Error("Lifecycle head is missing after submission.");
        if (refreshed.packageId !== record.lifecycleBinding.packageId ||
            refreshed.packageCommitmentHex.toLowerCase() !== record.lifecycleBinding.packageCommitmentHex.toLowerCase()) {
          throw new Error("Lifecycle head package binding does not match the prepared record.");
        }
        current = refreshed.state;
      } else if (current === "PACKAGE_CREATED") {
        throw new Error("Finalized observation requires a prepared entry.");
      } else if (!isAtOrBeyondEntrySubmitted(current)) {
        throw new Error(`Finalized observation is invalid from "${current}".`);
      }
      if (current === "ENTRY_SUBMITTED") {
        recordOne(
          this.store,
          record,
          "ENTRY_CONFIRMED",
          "CONSENSUS_VERIFIED",
          finalizedFields(observation.signature, observation.finalizedSlot),
        );
        return;
      }
      if (!isAtOrBeyondEntryConfirmed(current)) {
        throw new Error(`Finalized observation is invalid from "${current}".`);
      }
      return;
    }
    if (observation.lifecycle === "FAILED") {
      let current: PackageLifecycleState = headState;
      if (current === "ENTRY_PREPARED") {
        recordOne(
          this.store,
          record,
          "ENTRY_SUBMITTED",
          "CONTROLLER_ATTESTED",
          submittedFields(observation.signature, observation.failedSlot),
        );
        const refreshed = this.store.getAttempt(record.lifecycleBinding.attemptId);
        if (refreshed === undefined) throw new Error("Lifecycle head is missing after submission.");
        current = refreshed.state;
      } else if (current === "PACKAGE_CREATED") {
        throw new Error("Failed observation requires a prepared entry.");
      } else if (!isAtOrBeyondEntrySubmitted(current)) {
        throw new Error(`Failed observation is invalid from "${current}".`);
      }
      if (current === "ENTRY_SUBMITTED" || current === "ENTRY_CONFIRMED") {
        recordOne(
          this.store,
          record,
          "FAILED",
          "VENUE_CORROBORATED",
          failedFields(observation.signature, observation.failedSlot, observation.failureCode),
        );
        return;
      }
      if (current === "FAILED" || current === "EXPIRED") {
        return;
      }
      throw new Error(`Failed observation is invalid from "${current}".`);
    }
    let current: PackageLifecycleState = headState;
    if (current === "ENTRY_PREPARED") {
      recordOne(
        this.store,
        record,
        "ENTRY_SUBMITTED",
        "CONTROLLER_ATTESTED",
        submittedFields(observation.signature, null),
      );
      const refreshed = this.store.getAttempt(record.lifecycleBinding.attemptId);
      if (refreshed === undefined) throw new Error("Lifecycle head is missing after submission.");
      current = refreshed.state;
    } else if (current === "PACKAGE_CREATED") {
      throw new Error("Expired observation requires a prepared entry.");
    } else if (!isAtOrBeyondEntrySubmitted(current)) {
      throw new Error(`Expired observation is invalid from "${current}".`);
    }
    if (current === "ENTRY_SUBMITTED") {
      const expired = observation as Extract<PrivateTerminalExecutionObservation, { lifecycle: "EXPIRED" }>;
      recordOne(
        this.store,
        record,
        "EXPIRED",
        "CONTROLLER_ATTESTED",
        expiredFields(expired.signature, expired.lastValidBlockHeight, expired.observedBlockHeight),
      );
      return;
    }
    if (current === "EXPIRED" || current === "FAILED") {
      return;
    }
    throw new Error(`Expired observation is invalid from "${current}".`);
  }

  private recordExitObservation(
    record: PreparedSolanaDevnetRecord,
    observation: PrivateTerminalExecutionObservation,
    headState: PackageLifecycleState,
  ): void {
    const ensureSubmitted = (): PackageLifecycleState => {
      if (headState === "EXIT_REQUESTED") {
        let extra: readonly string[];
        if (observation.lifecycle === "SUBMITTED") {
          extra = submittedFields(observation.signature, observation.observedSlot);
        } else if (observation.lifecycle === "FINALIZED") {
          extra = submittedFields(observation.signature, observation.finalizedSlot);
        } else if (observation.lifecycle === "FAILED") {
          extra = submittedFields(observation.signature, observation.failedSlot);
        } else {
          const expired = observation as Extract<PrivateTerminalExecutionObservation, { lifecycle: "EXPIRED" }>;
          extra = submittedFields(expired.signature, null);
        }
        recordOne(this.store, record, "EXIT_SUBMITTED", "CONTROLLER_ATTESTED", extra);
        const refreshed = this.store.getAttempt(record.lifecycleBinding.attemptId);
        if (refreshed === undefined) throw new Error("Lifecycle head is missing after submission.");
        return refreshed.state;
      }
      if (headState === "OPEN" || headState === "RECOVERY_PENDING") {
        throw new Error("Exit observation requires a requested exit.");
      }
      if (!isAtOrBeyondExitSubmitted(headState) && !isAtOrBeyondExitRequested(headState)) {
        throw new Error(`Exit observation is invalid from "${headState}".`);
      }
      if (!isAtOrBeyondExitSubmitted(headState)) {
        throw new Error("Exit observation requires a requested exit.");
      }
      return headState;
    };
    if (observation.lifecycle === "SUBMITTED" || observation.lifecycle === "FINALIZED") {
      const current = ensureSubmitted();
      if (!isAtOrBeyondExitSubmitted(current)) {
        throw new Error(`Exit observation is invalid from "${current}".`);
      }
      return;
    }
    const current = ensureSubmitted();
    if (current === "EXIT_SUBMITTED") {
      if (observation.lifecycle === "FAILED") {
        recordOne(
          this.store,
          record,
          "RECOVERY_PENDING",
          "VENUE_CORROBORATED",
          failedFields(observation.signature, observation.failedSlot, observation.failureCode),
        );
        return;
      }
      const expired = observation as Extract<PrivateTerminalExecutionObservation, { lifecycle: "EXPIRED" }>;
      recordOne(
        this.store,
        record,
        "RECOVERY_PENDING",
        "CONTROLLER_ATTESTED",
        expiredFields(expired.signature, expired.lastValidBlockHeight, expired.observedBlockHeight),
      );
      return;
    }
    if (current === "RECOVERY_PENDING") {
      return;
    }
    throw new Error(`Exit observation is invalid from "${current}".`);
  }
}
