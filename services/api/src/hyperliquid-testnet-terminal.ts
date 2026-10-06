export const HYPERLIQUID_TESTNET_DOMAIN = "hypercore:testnet" as const;
export const HYPERLIQUID_TESTNET_ENVIRONMENT = "TESTNET" as const;

const REQUEST_KEYS = ["attemptId", "idempotencyKey"] as const;
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const LEG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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

export type HyperliquidTestnetLegExecutionEvidence = Readonly<{
  legId: string;
  role: "SPOT" | "PERPETUAL";
  clientOrderId: string;
  requestedSignedBaseAtoms: string;
  filledSignedBaseAtoms: string;
  grossQuoteAtoms: string;
  feeAssetId: string;
  feeAssetDecimals: number;
  feeAtoms: string;
  venueFeeQuoteAtoms: string;
  evidenceCommitment: string;
}>;

export type HyperliquidTestnetExecutionEvidence = Readonly<{
  evidenceVersion: string;
  observedAtMs: string;
  terminalResidualBaseAtoms: string;
  terminalResidualQuoteAtoms: string;
  legs: readonly [HyperliquidTestnetLegExecutionEvidence, HyperliquidTestnetLegExecutionEvidence];
}>;

export type HyperliquidTestnetStrategyLegEvidence = Readonly<{
  legId: string;
  clientOrderId: string;
  plannedSignedBaseAtoms: string;
  filledSignedBaseAtoms: string;
  terminalStatus: "FILLED" | "UNFILLED_IOC_CANCELLED"
    | "PARTIALLY_FILLED_IOC_CANCELLED" | "REJECTED" | "UNKNOWN";
  openOrderStatus: "NONE" | "OPEN" | "UNKNOWN";
  orderId: number | null;
  fillCount: number;
  grossQuoteAtoms: string;
  feeAssetId: string;
  feeAssetDecimals: number;
  feeAtoms: string;
  venueFeeQuoteAtoms: string;
  observedAtMs: string | null;
  evidenceCommitment: string;
}>;

export type HyperliquidTestnetStrategyStageEvidence = Readonly<{
  batchStage: number;
  submissionStatus: "NOT_SUBMITTED" | HyperliquidTestnetSubmissionStatus;
  actionCommitment: string | null;
  requestCommitment: string | null;
  evidence: null | Readonly<{
    status: "COMPLETE" | "INCOMPLETE";
    outcome: "COMPLETED" | "NO_EFFECT" | "RECOVERY_REQUIRED" | "MANUAL_INTERVENTION" | null;
    reasons: readonly string[];
    observedAtMs: string | null;
    legs: readonly HyperliquidTestnetStrategyLegEvidence[];
    rawEvidenceCommitments: readonly string[];
  }>;
}>;

export type HyperliquidTestnetStrategyPackageStatus =
  | "COMPLETED"
  | "NO_EFFECT"
  | "RECOVERY_REQUIRED"
  | "MANUAL_INTERVENTION"
  | "EVIDENCE_INCOMPLETE"
  | "SUBMISSION_FAILED";

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
    executionEvidence?: HyperliquidTestnetExecutionEvidence;
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
  }>
  | Readonly<{
    attemptId: string;
    idempotencyKey: string;
    domain: typeof HYPERLIQUID_TESTNET_DOMAIN;
    environment: typeof HYPERLIQUID_TESTNET_ENVIRONMENT;
    status: "STRATEGY_EXECUTION";
    packageStatus: HyperliquidTestnetStrategyPackageStatus;
    completedStages: readonly number[];
    stages: readonly HyperliquidTestnetStrategyStageEvidence[];
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
  const required = [...expected].sort();
  return keys.length === required.length && required.every((key, index) => keys[index] === key);
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

function requireLegId(value: unknown, name: string): string {
  if (typeof value !== "string" || !LEG_ID_PATTERN.test(value)) {
    throw new Error(`${name} must be a bounded protocol identifier`);
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

function requireSignedAtoms(value: unknown, name: string): string {
  if (typeof value !== "string" || !SIGNED_ATOMS_PATTERN.test(value)) {
    throw new Error(`${name} must be signed integer atoms`);
  }
  return value;
}

function requireUnsignedAtoms(value: unknown, name: string, nonzero = false): string {
  const checked = requireSignedAtoms(value, name);
  if (checked.startsWith("-") || (nonzero && checked === "0")) {
    throw new Error(`${name} must be ${nonzero ? "positive" : "nonnegative"} integer atoms`);
  }
  return checked;
}

function requireNonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function requireStrategyLegEvidence(value: unknown, index: number): HyperliquidTestnetStrategyLegEvidence {
  const name = `strategy.legs[${index}]`;
  if (!isRecord(value) || !hasExactKeys(value, [
    "clientOrderId", "evidenceCommitment", "feeAssetDecimals", "feeAssetId", "feeAtoms",
    "filledSignedBaseAtoms", "fillCount", "grossQuoteAtoms", "legId", "observedAtMs",
    "openOrderStatus", "orderId", "plannedSignedBaseAtoms", "terminalStatus",
    "venueFeeQuoteAtoms",
  ])) throw new Error(`${name} has invalid fields`);
  if (typeof value.clientOrderId !== "string" || !/^0x[0-9a-f]{32}$/.test(value.clientOrderId)) {
    throw new Error(`${name}.clientOrderId is invalid`);
  }
  if (typeof value.feeAssetId !== "string" || value.feeAssetId.length < 1
    || value.feeAssetId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value.feeAssetId)) {
    throw new Error(`${name}.feeAssetId is invalid`);
  }
  const feeAssetDecimals = requireNonnegativeInteger(value.feeAssetDecimals, `${name}.feeAssetDecimals`);
  if (feeAssetDecimals > 30) throw new Error(`${name}.feeAssetDecimals is invalid`);
  if (value.terminalStatus !== "FILLED" && value.terminalStatus !== "UNFILLED_IOC_CANCELLED"
    && value.terminalStatus !== "PARTIALLY_FILLED_IOC_CANCELLED"
    && value.terminalStatus !== "REJECTED" && value.terminalStatus !== "UNKNOWN") {
    throw new Error(`${name}.terminalStatus is invalid`);
  }
  if (value.openOrderStatus !== "NONE" && value.openOrderStatus !== "OPEN"
    && value.openOrderStatus !== "UNKNOWN") throw new Error(`${name}.openOrderStatus is invalid`);
  const orderId = value.orderId === null ? null : requireNonnegativeInteger(value.orderId, `${name}.orderId`);
  if (orderId === 0) throw new Error(`${name}.orderId is invalid`);
  const fillCount = requireNonnegativeInteger(value.fillCount, `${name}.fillCount`);
  const observedAtMs = value.observedAtMs === null
    ? null : requireUnsignedAtoms(value.observedAtMs, `${name}.observedAtMs`, true);
  const grossQuoteAtoms = requireUnsignedAtoms(value.grossQuoteAtoms, `${name}.grossQuoteAtoms`);
  const feeAtoms = requireUnsignedAtoms(value.feeAtoms, `${name}.feeAtoms`);
  const venueFeeQuoteAtoms = requireUnsignedAtoms(
    value.venueFeeQuoteAtoms, `${name}.venueFeeQuoteAtoms`,
  );
  if ((fillCount === 0 && (observedAtMs !== null || grossQuoteAtoms !== "0"
      || feeAtoms !== "0" || venueFeeQuoteAtoms !== "0"))
    || (fillCount > 0 && observedAtMs === null)) {
    throw new Error(`${name} economics are inconsistent`);
  }
  return Object.freeze({
    legId: requireLegId(value.legId, `${name}.legId`),
    clientOrderId: value.clientOrderId,
    plannedSignedBaseAtoms: requireSignedAtoms(value.plannedSignedBaseAtoms, `${name}.plannedSignedBaseAtoms`),
    filledSignedBaseAtoms: requireSignedAtoms(value.filledSignedBaseAtoms, `${name}.filledSignedBaseAtoms`),
    terminalStatus: value.terminalStatus,
    openOrderStatus: value.openOrderStatus,
    orderId,
    fillCount,
    grossQuoteAtoms,
    feeAssetId: value.feeAssetId,
    feeAssetDecimals,
    feeAtoms,
    venueFeeQuoteAtoms,
    observedAtMs,
    evidenceCommitment: requireCommitment(value.evidenceCommitment, `${name}.evidenceCommitment`),
  });
}

function requireStrategyStageEvidence(value: unknown, index: number): HyperliquidTestnetStrategyStageEvidence {
  const name = `stages[${index}]`;
  if (!isRecord(value) || !hasExactKeys(value, [
    "actionCommitment", "batchStage", "evidence", "requestCommitment", "submissionStatus",
  ])) throw new Error(`${name} has invalid fields`);
  const batchStage = requireNonnegativeInteger(value.batchStage, `${name}.batchStage`);
  const submissionStatus = value.submissionStatus === "NOT_SUBMITTED"
    ? "NOT_SUBMITTED" as const : requireSubmissionStatus(value.submissionStatus);
  const actionCommitment = requireNullableCommitment(value.actionCommitment, `${name}.actionCommitment`);
  const requestCommitment = requireNullableCommitment(value.requestCommitment, `${name}.requestCommitment`);
  if (value.evidence === null) {
    if (submissionStatus !== "NOT_SUBMITTED") throw new Error(`${name} is missing evidence`);
    return Object.freeze({ batchStage, submissionStatus, actionCommitment, requestCommitment, evidence: null });
  }
  if (submissionStatus === "NOT_SUBMITTED" || actionCommitment === null || requestCommitment === null
    || !isRecord(value.evidence) || !hasExactKeys(value.evidence, [
      "legs", "observedAtMs", "outcome", "rawEvidenceCommitments", "reasons", "status",
    ])) throw new Error(`${name}.evidence has invalid fields`);
  const evidence = value.evidence;
  if (evidence.status !== "COMPLETE" && evidence.status !== "INCOMPLETE") {
    throw new Error(`${name}.evidence.status is invalid`);
  }
  const evidenceStatus: "COMPLETE" | "INCOMPLETE" = evidence.status;
  const completeOutcome = evidence.outcome === "COMPLETED" || evidence.outcome === "NO_EFFECT"
    || evidence.outcome === "RECOVERY_REQUIRED" || evidence.outcome === "MANUAL_INTERVENTION";
  if ((evidence.status === "COMPLETE" && !completeOutcome)
    || (evidence.status === "INCOMPLETE" && evidence.outcome !== null)) {
    throw new Error(`${name}.evidence.outcome is invalid`);
  }
  const evidenceOutcome = completeOutcome
    ? evidence.outcome as "COMPLETED" | "NO_EFFECT" | "RECOVERY_REQUIRED" | "MANUAL_INTERVENTION"
    : null;
  const observedAtMs = evidence.observedAtMs === null
    ? null : requireUnsignedAtoms(evidence.observedAtMs, `${name}.evidence.observedAtMs`, true);
  if (evidence.status === "COMPLETE" && observedAtMs === null) {
    throw new Error(`${name}.evidence.observedAtMs is required`);
  }
  if (!Array.isArray(evidence.legs) || evidence.legs.length < 1 || evidence.legs.length > 16) {
    throw new Error(`${name}.evidence.legs must be bounded`);
  }
  const legs = evidence.legs.map((leg, legIndex) => requireStrategyLegEvidence(leg, legIndex));
  if (new Set(legs.map((leg) => leg.legId)).size !== legs.length
    || new Set(legs.map((leg) => leg.clientOrderId)).size !== legs.length) {
    throw new Error(`${name}.evidence leg identities must be unique`);
  }
  const allowEmptyReasons = evidence.status === "COMPLETE"
    && (evidence.outcome === "COMPLETED" || evidence.outcome === "NO_EFFECT");
  return Object.freeze({
    batchStage,
    submissionStatus,
    actionCommitment,
    requestCommitment,
    evidence: Object.freeze({
      status: evidenceStatus,
      outcome: evidenceOutcome,
      reasons: requireReasons(evidence.reasons, allowEmptyReasons),
      observedAtMs,
      legs: Object.freeze(legs),
      rawEvidenceCommitments: requireEvidenceCommitments(evidence.rawEvidenceCommitments),
    }),
  });
}

function requireLegExecutionEvidence(
  value: unknown,
  role: "SPOT" | "PERPETUAL",
): HyperliquidTestnetLegExecutionEvidence {
  if (!isRecord(value) || !hasExactKeys(value, [
    "clientOrderId", "evidenceCommitment", "feeAssetDecimals", "feeAssetId", "feeAtoms",
    "filledSignedBaseAtoms", "grossQuoteAtoms", "legId", "requestedSignedBaseAtoms", "role",
    "venueFeeQuoteAtoms",
  ])) throw new Error(`${role} execution evidence has invalid fields`);
  if (value.role !== role) throw new Error(`${role} execution evidence role is invalid`);
  if (typeof value.clientOrderId !== "string" || !/^0x[0-9a-f]{32}$/.test(value.clientOrderId)) {
    throw new Error(`${role} clientOrderId is invalid`);
  }
  if (typeof value.feeAssetId !== "string" || value.feeAssetId.length < 1
    || value.feeAssetId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value.feeAssetId)) {
    throw new Error(`${role} feeAssetId is invalid`);
  }
  if (typeof value.feeAssetDecimals !== "number" || !Number.isInteger(value.feeAssetDecimals)
    || value.feeAssetDecimals < 0 || value.feeAssetDecimals > 30) {
    throw new Error(`${role} feeAssetDecimals is invalid`);
  }
  return Object.freeze({
    legId: requireLegId(value.legId, `${role}.legId`),
    role,
    clientOrderId: value.clientOrderId,
    requestedSignedBaseAtoms: requireSignedAtoms(
      value.requestedSignedBaseAtoms, `${role}.requestedSignedBaseAtoms`,
    ),
    filledSignedBaseAtoms: requireSignedAtoms(
      value.filledSignedBaseAtoms, `${role}.filledSignedBaseAtoms`,
    ),
    grossQuoteAtoms: requireUnsignedAtoms(value.grossQuoteAtoms, `${role}.grossQuoteAtoms`),
    feeAssetId: value.feeAssetId,
    feeAssetDecimals: value.feeAssetDecimals,
    feeAtoms: requireUnsignedAtoms(value.feeAtoms, `${role}.feeAtoms`),
    venueFeeQuoteAtoms: requireUnsignedAtoms(
      value.venueFeeQuoteAtoms, `${role}.venueFeeQuoteAtoms`,
    ),
    evidenceCommitment: requireCommitment(value.evidenceCommitment, `${role}.evidenceCommitment`),
  });
}

function requireExecutionEvidence(value: unknown): HyperliquidTestnetExecutionEvidence {
  if (!isRecord(value) || !hasExactKeys(value, [
    "evidenceVersion", "legs", "observedAtMs", "terminalResidualBaseAtoms",
    "terminalResidualQuoteAtoms",
  ])) throw new Error("executionEvidence has invalid fields");
  if (!Array.isArray(value.legs) || value.legs.length !== 2) {
    throw new Error("executionEvidence must contain the spot and perpetual legs");
  }
  const legs: readonly [
    HyperliquidTestnetLegExecutionEvidence,
    HyperliquidTestnetLegExecutionEvidence,
  ] = Object.freeze([
    requireLegExecutionEvidence(value.legs[0], "SPOT"),
    requireLegExecutionEvidence(value.legs[1], "PERPETUAL"),
  ]);
  return Object.freeze({
    evidenceVersion: requireUnsignedAtoms(value.evidenceVersion, "evidenceVersion", true),
    observedAtMs: requireUnsignedAtoms(value.observedAtMs, "observedAtMs", true),
    terminalResidualBaseAtoms: requireUnsignedAtoms(
      value.terminalResidualBaseAtoms, "terminalResidualBaseAtoms",
    ),
    terminalResidualQuoteAtoms: requireUnsignedAtoms(
      value.terminalResidualQuoteAtoms, "terminalResidualQuoteAtoms",
    ),
    legs,
  });
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
      const hasExecutionEvidence = "executionEvidence" in value;
      if (hasExecutionEvidence && !observed) {
        throw new Error("executionEvidence requires observed package deltas");
      }
      const expectedKeys = [...reconciledKeys];
      if (observed) expectedKeys.push("observedNetSpotDeltaAtoms", "observedPerpetualDeltaAtoms");
      if (hasExecutionEvidence) expectedKeys.push("executionEvidence");
      if (!hasExactKeys(value, expectedKeys.sort())) {
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
        ...(hasExecutionEvidence ? {
          executionEvidence: requireExecutionEvidence(value.executionEvidence),
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
    case "STRATEGY_EXECUTION": {
      if (!hasExactKeys(value, [...BASE_KEYS, "completedStages", "packageStatus", "stages"].sort())) {
        throw new Error("STRATEGY_EXECUTION has invalid fields");
      }
      if (value.packageStatus !== "COMPLETED" && value.packageStatus !== "NO_EFFECT"
        && value.packageStatus !== "RECOVERY_REQUIRED"
        && value.packageStatus !== "MANUAL_INTERVENTION"
        && value.packageStatus !== "EVIDENCE_INCOMPLETE"
        && value.packageStatus !== "SUBMISSION_FAILED") {
        throw new Error("strategy packageStatus is unsupported");
      }
      if (!Array.isArray(value.completedStages) || !Array.isArray(value.stages)
        || value.stages.length < 1 || value.stages.length > 16) {
        throw new Error("strategy stage progression is invalid");
      }
      const completedStages = value.completedStages.map((stage, index) =>
        requireNonnegativeInteger(stage, `completedStages[${index}]`));
      const stages = value.stages.map((stage, index) => requireStrategyStageEvidence(stage, index));
      if (new Set(completedStages).size !== completedStages.length
        || new Set(stages.map((stage) => stage.batchStage)).size !== stages.length
        || stages.some((stage, index) => index > 0 && stages[index - 1]!.batchStage >= stage.batchStage)
        || completedStages.some((stage, index) => stage !== stages[index]?.batchStage
          || stages[index]?.evidence?.status !== "COMPLETE"
          || stages[index]?.evidence?.outcome !== "COMPLETED")) {
        throw new Error("strategy stage progression is invalid");
      }
      if (value.packageStatus === "COMPLETED"
        && (completedStages.length !== stages.length
          || stages.some((stage) => stage.evidence?.outcome !== "COMPLETED"))) {
        throw new Error("completed strategy evidence is inconsistent");
      }
      if (value.packageStatus === "NO_EFFECT"
        && (completedStages.length !== 0 || stages.length !== 1
          || stages[0]?.evidence?.outcome !== "NO_EFFECT")) {
        throw new Error("no-effect strategy evidence is inconsistent");
      }
      if (value.packageStatus === "SUBMISSION_FAILED"
        && (completedStages.length !== 0 || stages.length !== 1
          || stages[0]?.submissionStatus !== "NOT_SUBMITTED" || stages[0].evidence !== null)) {
        throw new Error("failed strategy submission is inconsistent");
      }
      return Object.freeze({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        domain: HYPERLIQUID_TESTNET_DOMAIN,
        environment: HYPERLIQUID_TESTNET_ENVIRONMENT,
        status,
        packageStatus: value.packageStatus,
        completedStages: Object.freeze(completedStages),
        stages: Object.freeze(stages),
      });
    }
    default:
      throw new Error("Hyperliquid result status is unsupported");
  }
}
