import { createHash } from "node:crypto";
import {
  bytesEqual,
  manifestHash,
  packageOrderHash,
  protocolId,
  type PackageLifecycleEventIntentInput,
  type PackageLifecycleReceipt,
  type PackageLifecycleState,
} from "@naryx/protocol-types";
import type { ExecutionIntentStore, SelectedExecutionAttempt } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import type { PackageLifecycleStore } from "./package-lifecycle-store.js";

const LOCAL_DOMAIN_ID = "svm:local";
const EVIDENCE_SOURCE_ID = "local-conformance-execution-v1";
const EVIDENCE_SOURCE_HASH = manifestHash(createHash("sha256")
  .update("NARYX/local-conformance-execution-evidence/v1", "ascii")
  .digest());

export type LocalExecutionAction =
  | "prepare"
  | "open"
  | "observation-ambiguity"
  | "controller-recovery"
  | "close";

export interface LocalExecutionResult {
  readonly action: LocalExecutionAction;
  readonly attempt: SelectedExecutionAttempt;
  readonly state: PackageLifecycleState;
  readonly receipts: readonly PackageLifecycleReceipt[];
}

export interface LocalExecutionCoordinatorPorts {
  readonly intents: ExecutionIntentStore;
  readonly orders: InternalOrderStore;
  readonly lifecycle: PackageLifecycleStore;
}

export class LocalExecutionCoordinatorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalExecutionCoordinatorError";
    this.code = code;
  }
}

interface ExecutionBinding {
  readonly attempt: SelectedExecutionAttempt;
  readonly domain: PackageLifecycleEventIntentInput["domain"];
  readonly settlementClass: PackageLifecycleEventIntentInput["settlementClass"];
  readonly packageCommitment: Uint8Array;
}

function digest(label: string, ...values: readonly Uint8Array[]): Uint8Array {
  const hash = createHash("sha256").update(`NARYX/local-execution/${label}/v1`, "ascii");
  for (const value of values) hash.update(value);
  return hash.digest();
}

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

export class LocalExecutionCoordinator {
  readonly #ports: LocalExecutionCoordinatorPorts;

  constructor(ports: LocalExecutionCoordinatorPorts) {
    this.#ports = ports;
  }

  prepare(attemptId: string): LocalExecutionResult {
    const binding = this.#binding(attemptId);
    this.#ensureInitial(binding, "PACKAGE_CREATED", "package-created");
    this.#ensureTransition(binding, "PACKAGE_CREATED", "ENTRY_PREPARED", "entry-prepared");
    return this.#result("prepare", binding);
  }

  open(attemptId: string): LocalExecutionResult {
    const binding = this.#binding(attemptId);
    this.#ensureInitial(binding, "PACKAGE_CREATED", "package-created");
    this.#ensureTransition(binding, "PACKAGE_CREATED", "ENTRY_PREPARED", "entry-prepared");
    this.#ensureTransition(binding, "ENTRY_PREPARED", "ENTRY_SUBMITTED", "entry-submitted");
    this.#ensureTransition(binding, "ENTRY_SUBMITTED", "ENTRY_CONFIRMED", "entry-confirmed");
    this.#ensureTransition(binding, "ENTRY_CONFIRMED", "OPEN", "entry-open");
    const state = this.#state(binding);
    if (state !== "OPEN" && state !== "EXIT_REQUESTED" && state !== "EXIT_SUBMITTED" && state !== "CLOSED") {
      throw new LocalExecutionCoordinatorError(
        "ATTEMPT_STATE_CONFLICT",
        "Attempt cannot be opened from its current lifecycle state.",
      );
    }
    return this.#result("open", binding);
  }

  recordObservationAmbiguity(attemptId: string): LocalExecutionResult {
    const binding = this.#binding(attemptId);
    const eventId = this.#eventId(binding, "observation-ambiguity");
    const recorded = this.#ports.lifecycle.getReceiptByEventId(eventId);
    if (recorded !== undefined) {
      this.#validateReceipt(binding, recorded, "RECOVERY_PENDING", "observation-ambiguity");
      return this.#result("observation-ambiguity", binding);
    }
    this.#ensureInitial(binding, "PACKAGE_CREATED", "package-created");
    this.#ensureTransition(binding, "PACKAGE_CREATED", "ENTRY_PREPARED", "entry-prepared");
    this.#ensureTransition(binding, "ENTRY_PREPARED", "ENTRY_SUBMITTED", "entry-submitted");
    const head = this.#head(binding);
    if (head.state === "ENTRY_SUBMITTED" || head.state === "OPEN") {
      this.#append(binding, "RECOVERY_PENDING", "observation-ambiguity");
    } else if (head.state !== "RECOVERY_PENDING") {
      throw new LocalExecutionCoordinatorError(
        "ATTEMPT_STATE_CONFLICT",
        "Observation ambiguity can be recorded only after submission or while open.",
      );
    }
    return this.#result("observation-ambiguity", binding);
  }

  recoverController(attemptId: string): LocalExecutionResult {
    const binding = this.#binding(attemptId);
    const ambiguity = this.#ports.lifecycle.getReceiptByEventId(this.#eventId(binding, "observation-ambiguity"));
    const recovered = this.#ports.lifecycle.getReceiptByEventId(this.#eventId(binding, "controller-recovered"));
    if (recovered !== undefined) {
      this.#validateReceipt(binding, recovered, "OPEN", "controller-recovered");
      return this.#result("controller-recovery", binding);
    }
    const head = this.#head(binding);
    if (head.state !== "RECOVERY_PENDING" || ambiguity === undefined) {
      throw new LocalExecutionCoordinatorError(
        "ATTEMPT_STATE_CONFLICT",
        "Controller recovery requires a recorded local observation ambiguity.",
      );
    }
    this.#append(binding, "OPEN", "controller-recovered");
    return this.#result("controller-recovery", binding);
  }

  close(attemptId: string): LocalExecutionResult {
    const binding = this.#binding(attemptId);
    this.#ensureTransition(binding, "OPEN", "EXIT_REQUESTED", "exit-requested");
    this.#ensureTransition(binding, "EXIT_REQUESTED", "EXIT_SUBMITTED", "exit-submitted");
    this.#ensureTransition(binding, "EXIT_SUBMITTED", "CLOSED", "closed");
    if (this.#state(binding) !== "CLOSED") {
      throw new LocalExecutionCoordinatorError(
        "ATTEMPT_STATE_CONFLICT",
        "Attempt cannot be closed from its current lifecycle state.",
      );
    }
    return this.#result("close", binding);
  }

  #binding(attemptId: string): ExecutionBinding {
    const attempt = this.#ports.intents.getAttempt(attemptId);
    if (attempt === undefined) {
      throw new LocalExecutionCoordinatorError("ATTEMPT_NOT_FOUND", "Selected execution attempt was not found.");
    }
    const authorization = this.#ports.intents.getAuthorization(attempt.orderHash);
    const quote = this.#ports.intents.getSelectedQuote(attemptId);
    const orderRecord = this.#ports.orders.getByOrderHash(attempt.orderHash);
    const order = this.#ports.orders.getCanonicalOrderByHash(attempt.orderHash);
    if (authorization === undefined || quote === undefined || orderRecord === undefined || order === undefined) {
      throw new LocalExecutionCoordinatorError(
        "ATTEMPT_EVIDENCE_UNAVAILABLE",
        "Authorized selected attempt evidence is incomplete.",
      );
    }
    if (authorization.orderHash !== attempt.orderHash || authorization.owner !== orderRecord.owner
      || quote.orderHash !== attempt.orderHash || quote.routeHash !== attempt.routeHash
      || quote.quoteHash !== attempt.quoteHash
      || !bytesEqual(packageOrderHash(order), bytes(attempt.orderHash))) {
      throw new LocalExecutionCoordinatorError(
        "ATTEMPT_BINDING_MISMATCH",
        "Authorized selected attempt evidence does not match the canonical order.",
      );
    }
    if (order.environment !== "local" || order.domain.domainId !== LOCAL_DOMAIN_ID
      || order.settlementClass !== "ATOMIC_POSTCONDITION") {
      throw new LocalExecutionCoordinatorError(
        "LOCAL_CONFORMANCE_REQUIRED",
        "Local execution coordination is restricted to the local conformance domain.",
      );
    }
    return Object.freeze({
      attempt,
      domain: order.domain,
      settlementClass: order.settlementClass,
      packageCommitment: digest(
        "package",
        bytes(attempt.orderHash),
        bytes(attempt.routeHash),
        bytes(attempt.quoteHash),
      ),
    });
  }

  #ensureInitial(
    binding: ExecutionBinding,
    state: "PACKAGE_CREATED",
    event: string,
  ): void {
    if (this.#ports.lifecycle.getAttempt(binding.attempt.attemptId) === undefined) {
      this.#append(binding, state, event);
      return;
    }
    this.#requireRecordedEvent(binding, state, event);
  }

  #ensureTransition(
    binding: ExecutionBinding,
    prior: PackageLifecycleState,
    next: PackageLifecycleState,
    event: string,
  ): void {
    const recorded = this.#ports.lifecycle.getReceiptByEventId(this.#eventId(binding, event));
    if (recorded !== undefined) {
      this.#validateReceipt(binding, recorded, next, event);
      return;
    }
    const head = this.#head(binding);
    if (head.state === prior) this.#append(binding, next, event);
  }

  #requireRecordedEvent(
    binding: ExecutionBinding,
    state: PackageLifecycleState,
    event: string,
  ): void {
    const receipt = this.#ports.lifecycle.getReceiptByEventId(this.#eventId(binding, event));
    if (receipt === undefined) {
      throw new LocalExecutionCoordinatorError(
        "ATTEMPT_BINDING_MISMATCH",
        "Lifecycle head is missing its deterministic local execution event.",
      );
    }
    this.#validateReceipt(binding, receipt, state, event);
  }

  #append(binding: ExecutionBinding, nextState: PackageLifecycleState, event: string): void {
    const head = this.#ports.lifecycle.getAttempt(binding.attempt.attemptId);
    const eventId = this.#eventId(binding, event);
    const existing = this.#ports.lifecycle.getReceiptByEventId(eventId);
    if (existing !== undefined) {
      this.#validateReceipt(binding, existing, nextState, event);
      return;
    }
    this.#ports.lifecycle.recordEvent({
      version: 1,
      domain: binding.domain,
      settlementClass: binding.settlementClass,
      packageId: binding.attempt.attemptId,
      packageCommitment: binding.packageCommitment,
      attemptId: binding.attempt.attemptId,
      eventId,
      expectedRevision: head?.revision ?? 0n,
      nextState,
      evidenceGrade: "LOCAL_RECORDED",
      onchainEnforced: false,
      evidenceSource: {
        subjectId: protocolId(EVIDENCE_SOURCE_ID),
        manifestVersion: 1,
        manifestHash: EVIDENCE_SOURCE_HASH,
      },
      evidenceCommitment: digest("evidence", binding.packageCommitment, Buffer.from(event, "ascii")),
    });
  }

  #validateReceipt(
    binding: ExecutionBinding,
    receipt: PackageLifecycleReceipt,
    state: PackageLifecycleState,
    event: string,
  ): void {
    if (receipt.attemptId !== binding.attempt.attemptId
      || receipt.packageId !== binding.attempt.attemptId
      || !bytesEqual(receipt.packageCommitment, binding.packageCommitment)
      || receipt.eventId !== this.#eventId(binding, event)
      || receipt.nextState !== state
      || receipt.domain.domainId !== binding.domain.domainId
      || receipt.domain.domainManifestVersion !== binding.domain.domainManifestVersion
      || !bytesEqual(receipt.domain.domainManifestHash, binding.domain.domainManifestHash)
      || receipt.settlementClass !== binding.settlementClass
      || receipt.evidenceGrade !== "LOCAL_RECORDED"
      || receipt.onchainEnforced
      || receipt.evidenceSource.subjectId !== EVIDENCE_SOURCE_ID
      || receipt.evidenceSource.manifestVersion !== 1
      || !bytesEqual(receipt.evidenceSource.manifestHash, EVIDENCE_SOURCE_HASH)
      || !bytesEqual(
        receipt.evidenceCommitment,
        digest("evidence", binding.packageCommitment, Buffer.from(event, "ascii")),
      )) {
      throw new LocalExecutionCoordinatorError(
        "ATTEMPT_BINDING_MISMATCH",
        "Stored lifecycle event does not match the selected execution attempt.",
      );
    }
  }

  #eventId(binding: ExecutionBinding, event: string): string {
    return `${binding.attempt.attemptId}.${event}`;
  }

  #head(binding: ExecutionBinding) {
    const head = this.#ports.lifecycle.getAttempt(binding.attempt.attemptId);
    if (head === undefined) {
      throw new LocalExecutionCoordinatorError("ATTEMPT_STATE_CONFLICT", "Attempt lifecycle has not been prepared.");
    }
    return head;
  }

  #state(binding: ExecutionBinding): PackageLifecycleState {
    return this.#head(binding).state;
  }

  #result(action: LocalExecutionAction, binding: ExecutionBinding): LocalExecutionResult {
    const head = this.#head(binding);
    return Object.freeze({
      action,
      attempt: binding.attempt,
      state: head.state,
      receipts: this.#ports.lifecycle.listReceipts(binding.attempt.attemptId, 0n, 100),
    });
  }
}
