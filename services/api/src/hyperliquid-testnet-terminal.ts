export const HYPERLIQUID_TESTNET_DOMAIN = "hypercore:testnet" as const;
export const HYPERLIQUID_TESTNET_ENVIRONMENT = "TESTNET" as const;

const REQUEST_KEYS = ["attemptId", "idempotencyKey"] as const;
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const COMMITMENT_PATTERN = /^0x[0-9a-f]{64}$/;
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SIGNED_ATOMS_PATTERN = /^(?:0|-?[1-9][0-9]{0,77})$/;
const MAX_REASONS = 8;
const MAX_EVIDENCE = 64;

export type HyperliquidTestnetTerminalExecutionRequest = Readonly<{
  attemptId: string;
  idempotencyKey: string;
}>;

export type HyperliquidTestnetSubmissionStatus = "ACKNOWLEDGED" | "REJECTED" | "AMBIGUOUS";
export type HyperliquidTestnetEvidenceStatus = "PRECONDITION_REJECTED" | "JOURNAL_REJECTED";
export type HyperliquidTestnetFinalPackageStatus =
  | "NO_EFFECT"
  | "COMPLETED_EXACT"
  | "COMPLETED_BOUNDED"
  | "RECOVERY_REQUIRED"
  | "MANUAL_INTERVENTION";

export type HyperliquidTestnetTerminalExecutionResult =
  | Readonly<{
    attemptId: string;
    idempotencyKey: string;
    domain: typeof HYPERLIQUID_TESTNET_DOMAIN;
    environment: typeof HYPERLIQUID_TESTNET_ENVIRONMENT;
    status: "CHECKPOINT_INCOMPLETE";
    reasons: readonly string[];
    rawEvidenceCommitments: readonly string[];
  }>
  | Readonly<{
    attemptId: string;
    idempotencyKey: string;
    domain: typeof HYPERLIQUID_TESTNET_DOMAIN;
    environment: typeof HYPERLIQUID_TESTNET_ENVIRONMENT;
    status: "CHECKPOINT_FAILED";
    errorCommitment: string;
  }>
  | Readonly<{
    attemptId: string;
    idempotencyKey: string;
    domain: typeof HYPERLIQUID_TESTNET_DOMAIN;
    environment: typeof HYPERLIQUID_TESTNET_ENVIRONMENT;
    status: "NOT_SUBMITTED";
    evidenceStatus: HyperliquidTestnetEvidenceStatus;
    actionCommitment: string | null;
    requestCommitment: string | null;
    errorCommitment: string;
  }>
  | Readonly<{
    attemptId: string;
    idempotencyKey: string;
    domain: typeof HYPERLIQUID_TESTNET_DOMAIN;
    environment: typeof HYPERLIQUID_TESTNET_ENVIRONMENT;
    status: "SUBMISSION_CALL_FAILED";
    errorCommitment: string;
  }>
  | Readonly<{
    attemptId: string;
    idempotencyKey: string;
    domain: typeof HYPERLIQUID_TESTNET_DOMAIN;
    environment: typeof HYPERLIQUID_TESTNET_ENVIRONMENT;
    status: "SUBMISSION_RESULT_INVALID";
    errorCommitment: string;
  }>
  | Readonly<{
    attemptId: string;
    idempotencyKey: string;
    domain: typeof HYPERLIQUID_TESTNET_DOMAIN;
    environment: typeof HYPERLIQUID_TESTNET_ENVIRONMENT;
    status: "RECONCILIATION_DEFERRED";
    submissionStatus: HyperliquidTestnetSubmissionStatus;
    actionCommitment: string;
    requestCommitment: string;
    errorCommitment: string;
  }>
  | Readonly<{
    attemptId: string;
    idempotencyKey: string;
    domain: typeof HYPERLIQUID_TESTNET_DOMAIN;
    environment: typeof HYPERLIQUID_TESTNET_ENVIRONMENT;
    status: "RECONCILIATION_INCOMPLETE";
    submissionStatus: HyperliquidTestnetSubmissionStatus;
    packageStatus: "RECONCILING";
    reasons: readonly string[];
    actionCommitment: string;
    requestCommitment: string;
    rawEvidenceCommitments: readonly string[];
  }>
  | Readonly<{
    attemptId: string;
    idempotencyKey: string;
    domain: typeof HYPERLIQUID_TESTNET_DOMAIN;
    environment: typeof HYPERLIQUID_TESTNET_ENVIRONMENT;
    status: "RECONCILED";
    submissionStatus: HyperliquidTestnetSubmissionStatus;
    packageStatus: HyperliquidTestnetFinalPackageStatus;
    reasons: readonly string[];
    actionCommitment: string;
    requestCommitment: string;
    rawEvidenceCommitments: readonly string[];
    /** Account-wide deltas over the executor's serialized window: exactly this package's fills. */
    observedNetSpotDeltaAtoms?: string;
    observedPerpetualDeltaAtoms?: string;
  }>
  | Readonly<{
    attemptId: string;
    idempotencyKey: string;
    domain: typeof HYPERLIQUID_TESTNET_DOMAIN;
    environment: typeof HYPERLIQUID_TESTNET_ENVIRONMENT;
    status: "HANDOFF_REJECTED";
    reason: string;
    actionCommitment: string | null;
    requestCommitment: string | null;
  }>;

export interface HyperliquidTestnetTerminalExecutionPort {
  execute(
    request: HyperliquidTestnetTerminalExecutionRequest,
  ): Promise<HyperliquidTestnetTerminalExecutionResult>;
  /** Throws a validation error unless the package owner's signature is recorded for the attempt. */
  requireOwnerAuthorization?(request: HyperliquidTestnetTerminalExecutionRequest): void;
}

export class HyperliquidTestnetTerminalValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HyperliquidTestnetTerminalValidationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key, index) => keys[index] === key);
}

function requireBrowserId(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new HyperliquidTestnetTerminalValidationError(
      "INVALID_HYPERLIQUID_ID",
      `${name} must use 16 to 64 URL-safe characters.`,
    );
  }
  return value;
}

export function parseHyperliquidTestnetTerminalExecutionRequest(
  value: unknown,
): HyperliquidTestnetTerminalExecutionRequest {
  if (!isRecord(value)) {
    throw new HyperliquidTestnetTerminalValidationError(
      "INVALID_HYPERLIQUID_BODY",
      "Request body must be a JSON object.",
    );
  }
  if (!hasExactKeys(value, REQUEST_KEYS)) {
    throw new HyperliquidTestnetTerminalValidationError(
      "INVALID_HYPERLIQUID_FIELDS",
      "Request must contain only attemptId and idempotencyKey.",
    );
  }
  return Object.freeze({
    attemptId: requireBrowserId(value.attemptId, "attemptId"),
    idempotencyKey: requireBrowserId(value.idempotencyKey, "idempotencyKey"),
  });
}

function requireCommitment(value: unknown, name: string): string {
  if (typeof value !== "string" || !COMMITMENT_PATTERN.test(value) || /^0x0+$/.test(value)) {
    throw new Error(`${name} must be a nonzero lowercase 0x 32-byte hash`);
  }
  return value;
}

function requireNullableCommitment(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requireCommitment(value, name);
}

function requireReason(value: unknown, name: string): string {
  if (typeof value !== "string" || !REASON_PATTERN.test(value)) {
    throw new Error(`${name} must be a bounded uppercase identifier`);
  }
  return value;
}

function requireReasons(value: unknown, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_REASONS || (!allowEmpty && value.length < 1)) {
    throw new Error(
      allowEmpty ? "reasons must be a bounded array" : "reasons must be a bounded nonempty array",
    );
  }
  const seen = new Set<string>();
  const copied = value.map((entry, index) => {
    const reason = requireReason(entry, `reasons[${index}]`);
    if (seen.has(reason)) throw new Error("reasons must not repeat");
    seen.add(reason);
    return reason;
  });
  return Object.freeze([...copied]);
}

function requireEvidenceCommitments(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) {
    throw new Error("rawEvidenceCommitments must be a bounded array");
  }
  const copied = value.map((entry, index) => requireCommitment(entry, `rawEvidenceCommitments[${index}]`));
  return Object.freeze([...copied]);
}

function requireSubmissionStatus(value: unknown): HyperliquidTestnetSubmissionStatus {
  if (value === "ACKNOWLEDGED" || value === "REJECTED" || value === "AMBIGUOUS") return value;
  throw new Error("submissionStatus is unsupported");
}

const BASE_KEYS = ["attemptId", "domain", "environment", "idempotencyKey", "status"] as const;

export function validateHyperliquidTestnetTerminalExecutionResult(
  value: unknown,
  request: HyperliquidTestnetTerminalExecutionRequest,
): HyperliquidTestnetTerminalExecutionResult {
  if (!isRecord(value)) throw new Error("Hyperliquid result must be an object");
  const status = value.status;
  if (typeof status !== "string") throw new Error("Hyperliquid result status is invalid");
  if (value.attemptId !== request.attemptId || value.idempotencyKey !== request.idempotencyKey) {
    throw new Error("Hyperliquid result identity does not match the request");
  }
  if (value.domain !== HYPERLIQUID_TESTNET_DOMAIN ||
      value.environment !== HYPERLIQUID_TESTNET_ENVIRONMENT) {
    throw new Error("Hyperliquid result is not bound to hypercore:testnet TESTNET");
  }

  switch (status) {
    case "CHECKPOINT_INCOMPLETE": {
      if (!hasExactKeys(value, [...BASE_KEYS, "rawEvidenceCommitments", "reasons"].sort())) {
        throw new Error("CHECKPOINT_INCOMPLETE has invalid fields");
      }
      return Object.freeze({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        domain: HYPERLIQUID_TESTNET_DOMAIN,
        environment: HYPERLIQUID_TESTNET_ENVIRONMENT,
        status,
        reasons: requireReasons(value.reasons, false),
        rawEvidenceCommitments: requireEvidenceCommitments(value.rawEvidenceCommitments),
      });
    }
    case "CHECKPOINT_FAILED": {
      if (!hasExactKeys(value, [...BASE_KEYS, "errorCommitment"].sort())) {
        throw new Error("CHECKPOINT_FAILED has invalid fields");
      }
      return Object.freeze({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        domain: HYPERLIQUID_TESTNET_DOMAIN,
        environment: HYPERLIQUID_TESTNET_ENVIRONMENT,
        status,
        errorCommitment: requireCommitment(value.errorCommitment, "errorCommitment"),
      });
    }
    case "NOT_SUBMITTED": {
      if (!hasExactKeys(value, [...BASE_KEYS, "actionCommitment", "errorCommitment", "evidenceStatus", "requestCommitment"].sort())) {
        throw new Error("NOT_SUBMITTED has invalid fields");
      }
      if (value.evidenceStatus !== "PRECONDITION_REJECTED" && value.evidenceStatus !== "JOURNAL_REJECTED") {
        throw new Error("evidenceStatus is unsupported");
      }
      return Object.freeze({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        domain: HYPERLIQUID_TESTNET_DOMAIN,
        environment: HYPERLIQUID_TESTNET_ENVIRONMENT,
        status,
        evidenceStatus: value.evidenceStatus,
        actionCommitment: requireNullableCommitment(value.actionCommitment, "actionCommitment"),
        requestCommitment: requireNullableCommitment(value.requestCommitment, "requestCommitment"),
        errorCommitment: requireCommitment(value.errorCommitment, "errorCommitment"),
      });
    }
    case "SUBMISSION_CALL_FAILED": {
      if (!hasExactKeys(value, [...BASE_KEYS, "errorCommitment"].sort())) {
        throw new Error("SUBMISSION_CALL_FAILED has invalid fields");
      }
      return Object.freeze({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        domain: HYPERLIQUID_TESTNET_DOMAIN,
        environment: HYPERLIQUID_TESTNET_ENVIRONMENT,
        status,
        errorCommitment: requireCommitment(value.errorCommitment, "errorCommitment"),
      });
    }
    case "SUBMISSION_RESULT_INVALID": {
      if (!hasExactKeys(value, [...BASE_KEYS, "errorCommitment"].sort())) {
        throw new Error("SUBMISSION_RESULT_INVALID has invalid fields");
      }
      return Object.freeze({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        domain: HYPERLIQUID_TESTNET_DOMAIN,
        environment: HYPERLIQUID_TESTNET_ENVIRONMENT,
        status,
        errorCommitment: requireCommitment(value.errorCommitment, "errorCommitment"),
      });
    }
    case "RECONCILIATION_DEFERRED": {
      if (!hasExactKeys(value, [...BASE_KEYS, "actionCommitment", "errorCommitment", "requestCommitment", "submissionStatus"].sort())) {
        throw new Error("RECONCILIATION_DEFERRED has invalid fields");
      }
      return Object.freeze({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        domain: HYPERLIQUID_TESTNET_DOMAIN,
        environment: HYPERLIQUID_TESTNET_ENVIRONMENT,
        status,
        submissionStatus: requireSubmissionStatus(value.submissionStatus),
        actionCommitment: requireCommitment(value.actionCommitment, "actionCommitment"),
        requestCommitment: requireCommitment(value.requestCommitment, "requestCommitment"),
        errorCommitment: requireCommitment(value.errorCommitment, "errorCommitment"),
      });
    }
    case "RECONCILIATION_INCOMPLETE": {
      if (!hasExactKeys(value, [...BASE_KEYS, "actionCommitment", "packageStatus", "rawEvidenceCommitments", "reasons", "requestCommitment", "submissionStatus"].sort())) {
        throw new Error("RECONCILIATION_INCOMPLETE has invalid fields");
      }
      if (value.packageStatus !== "RECONCILING") throw new Error("packageStatus is unsupported");
      return Object.freeze({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        domain: HYPERLIQUID_TESTNET_DOMAIN,
        environment: HYPERLIQUID_TESTNET_ENVIRONMENT,
        status,
        submissionStatus: requireSubmissionStatus(value.submissionStatus),
        packageStatus: value.packageStatus,
        reasons: requireReasons(value.reasons, false),
        actionCommitment: requireCommitment(value.actionCommitment, "actionCommitment"),
        requestCommitment: requireCommitment(value.requestCommitment, "requestCommitment"),
        rawEvidenceCommitments: requireEvidenceCommitments(value.rawEvidenceCommitments),
      });
    }
    case "RECONCILED": {
      const reconciledKeys = [...BASE_KEYS, "actionCommitment", "packageStatus", "rawEvidenceCommitments", "reasons", "requestCommitment", "submissionStatus"];
      const observed = "observedNetSpotDeltaAtoms" in value;
      if (!hasExactKeys(value, (observed
        ? [...reconciledKeys, "observedNetSpotDeltaAtoms", "observedPerpetualDeltaAtoms"]
        : reconciledKeys).sort())) {
        throw new Error("RECONCILED has invalid fields");
      }
      if (observed && (typeof value.observedNetSpotDeltaAtoms !== "string"
        || !SIGNED_ATOMS_PATTERN.test(value.observedNetSpotDeltaAtoms)
        || typeof value.observedPerpetualDeltaAtoms !== "string"
        || !SIGNED_ATOMS_PATTERN.test(value.observedPerpetualDeltaAtoms))) {
        throw new Error("observed package deltas must be signed integer atoms");
      }
      if (value.packageStatus !== "NO_EFFECT" && value.packageStatus !== "COMPLETED_EXACT" &&
          value.packageStatus !== "COMPLETED_BOUNDED" && value.packageStatus !== "RECOVERY_REQUIRED" &&
          value.packageStatus !== "MANUAL_INTERVENTION") {
        throw new Error("packageStatus is unsupported");
      }
      const allowEmptyReasons =
        value.packageStatus === "NO_EFFECT" ||
        value.packageStatus === "COMPLETED_EXACT" ||
        value.packageStatus === "COMPLETED_BOUNDED";
      return Object.freeze({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        domain: HYPERLIQUID_TESTNET_DOMAIN,
        environment: HYPERLIQUID_TESTNET_ENVIRONMENT,
        status,
        submissionStatus: requireSubmissionStatus(value.submissionStatus),
        packageStatus: value.packageStatus,
        reasons: requireReasons(value.reasons, allowEmptyReasons),
        actionCommitment: requireCommitment(value.actionCommitment, "actionCommitment"),
        requestCommitment: requireCommitment(value.requestCommitment, "requestCommitment"),
        rawEvidenceCommitments: requireEvidenceCommitments(value.rawEvidenceCommitments),
        ...(observed ? {
          observedNetSpotDeltaAtoms: value.observedNetSpotDeltaAtoms as string,
          observedPerpetualDeltaAtoms: value.observedPerpetualDeltaAtoms as string,
        } : {}),
      });
    }
    case "HANDOFF_REJECTED": {
      if (!hasExactKeys(value, [...BASE_KEYS, "actionCommitment", "reason", "requestCommitment"].sort())) {
        throw new Error("HANDOFF_REJECTED has invalid fields");
      }
      return Object.freeze({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        domain: HYPERLIQUID_TESTNET_DOMAIN,
        environment: HYPERLIQUID_TESTNET_ENVIRONMENT,
        status,
        reason: requireReason(value.reason, "reason"),
        actionCommitment: requireNullableCommitment(value.actionCommitment, "actionCommitment"),
        requestCommitment: requireNullableCommitment(value.requestCommitment, "requestCommitment"),
      });
    }
    default:
      throw new Error("Hyperliquid result status is unsupported");
  }
}
