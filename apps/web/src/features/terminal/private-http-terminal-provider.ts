import type {
  DomainId,
  SolanaExecutionPreparation,
  SolanaExecutionPreparationInput,
  TerminalPreview,
  TerminalPreviewInput,
  TerminalViewModel,
  TerminalViewModelProvider,
} from "./terminal-view-model";
import { getTransactionDecoder } from "@solana/transactions";
import bs58 from "bs58";

const SOLANA_DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MAX_TRANSACTION_BYTES = 1232;
const MAX_RESOLVED_ACCOUNTS = 64;
const MAX_COMPUTE_UNITS = 1_260_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const LIFECYCLE_ATTEMPT_ID_PATTERN = /^solana-cash-carry-[0-9a-f]{64}$/;
const LOCAL_ATTEMPT_ID_PATTERN = /^local-atomic-[0-9a-f]{64}$/;
const LOCAL_CONTEXT_ID = "local:svm:sol-carry-v1";

export type SolanaExecutionObservationRequest = Readonly<{
  idempotencyKey: string;
  signature: string;
}>;

export type RuntimeBoundaryHealth = Readonly<{
  available: boolean;
  reason:
    | "DISABLED_BY_CONFIGURATION"
    | "RUNTIME_FACTORY_NOT_INJECTED"
    | "RUNTIME_INITIALIZATION_FAILED"
    | "REQUIRED_PORTS_MISSING"
    | null;
}>;

export type PrivateTerminalRuntimeHealth = Readonly<{
  solanaDevnet: RuntimeBoundaryHealth;
  baseTestnetAtomic: RuntimeBoundaryHealth;
  arbitrumTestnetAsync: RuntimeBoundaryHealth;
  hyperliquidTestnet: RuntimeBoundaryHealth;
}>;

export type SolanaExecutionObservation =
  | Readonly<{
    lifecycle: "SUBMITTED";
    signature: string;
    observedSlot: number | null;
  }>
  | Readonly<{
    lifecycle: "FINALIZED";
    signature: string;
    finalizedSlot: number;
  }>
  | Readonly<{
    lifecycle: "FAILED";
    signature: string;
    failedSlot: number | null;
    failureCode: string;
  }>
  | Readonly<{
    lifecycle: "EXPIRED";
    signature: string;
    lastValidBlockHeight: number;
    observedBlockHeight: number;
  }>;

export type PackageLifecycleState =
  | "PACKAGE_CREATED"
  | "ENTRY_PREPARED"
  | "ENTRY_SUBMITTED"
  | "ENTRY_CONFIRMED"
  | "OPEN"
  | "EXIT_REQUESTED"
  | "EXIT_SUBMITTED"
  | "RECOVERY_PENDING"
  | "MANUAL_INTERVENTION"
  | "CLOSED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED";

export type PackageEvidenceGrade =
  | "LOCAL_RECORDED"
  | "CONTROLLER_ATTESTED"
  | "VENUE_CORROBORATED"
  | "CONSENSUS_VERIFIED";

export type PackageLifecycleAttempt = Readonly<{
  attemptId: string;
  packageId: string;
  packageCommitmentHex: string;
  revision: string;
  state: PackageLifecycleState;
  receiptHashHex: string;
  eventId: string;
  observedAtUnixMilliseconds: string;
}>;

export type PackageLifecycleReceipt = Readonly<{
  version: 1;
  domain: Readonly<{
    domainId: string;
    domainManifestVersion: number;
    domainManifestHashHex: string;
  }>;
  settlementClass: "ATOMIC_POSTCONDITION" | "BATCHED_IOC_WITH_RECOVERY" | "ASYNC_BONDED_SOLVER";
  packageId: string;
  packageCommitmentHex: string;
  attemptId: string;
  eventId: string;
  revision: string;
  priorState?: PackageLifecycleState;
  previousReceiptHashHex?: string;
  nextState: PackageLifecycleState;
  observedAtUnixMilliseconds: string;
  evidenceGrade: PackageEvidenceGrade;
  onchainEnforced: boolean;
  evidenceSource: Readonly<{
    subjectId: string;
    manifestVersion: number;
    manifestHashHex: string;
  }>;
  evidenceCommitmentHex: string;
  intentCommitmentHex: string;
  receiptHashHex: string;
}>;

export type PackageLifecycleResponse = Readonly<{
  attempt: PackageLifecycleAttempt;
  receipts: readonly PackageLifecycleReceipt[];
}>;

export type LocalOrderRecord = Readonly<{
  idempotencyKey: string;
  requestCommitmentHex: string;
  orderHashHex: string;
  orderBase64: string;
  contextId: typeof LOCAL_CONTEXT_ID;
  domainId: "svm:local";
  domainManifestVersion: number;
  domainManifestHashHex: string;
  owner: string;
  settlementAccount: string;
  nonceDecimal: string;
  status: "UNSIGNED_CREATED";
  createdAtMs: number;
  orderBytes: Uint8Array;
}>;

export type LocalOrderCreateResponse = Readonly<{
  status: "UNSIGNED_CREATED";
  created: boolean;
  order: LocalOrderRecord;
  traderAuthorization: "REQUIRED";
  solverQuoting: "REQUIRED";
  note: string;
}>;

export type LocalAuthorization = Readonly<{
  orderHash: string;
  owner: string;
  signature: string;
  authorizedAtMs: number;
}>;

export type LocalSolverQuote = Readonly<{
  version: 1;
  status: "SIGNED";
  idempotencyKey: string;
  orderHash: string;
  routeHash: string;
  quoteHash: string;
  solverSignatureDigest: string;
  routeBytes: string;
  solverQuoteBytes: string;
  route: Readonly<Record<string, unknown>>;
  quote: Readonly<Record<string, unknown>>;
}>;

export type LocalSelectedAttempt = Readonly<{
  attemptId: string;
  orderHash: string;
  routeHash: string;
  quoteHash: string;
  status: "AUTHORIZED_QUOTE_SELECTED";
  selectedAtMs: number;
}>;

export type LocalExecutionAction =
  | "prepare"
  | "open"
  | "observation-ambiguity"
  | "controller-recovery"
  | "close";

export type LocalExecutionResult = Readonly<{
  action: LocalExecutionAction;
  state: PackageLifecycleState;
  lifecycle: PackageLifecycleResponse;
}>;

const PACKAGE_LIFECYCLE_STATES = new Set<PackageLifecycleState>([
  "PACKAGE_CREATED",
  "ENTRY_PREPARED",
  "ENTRY_SUBMITTED",
  "ENTRY_CONFIRMED",
  "OPEN",
  "EXIT_REQUESTED",
  "EXIT_SUBMITTED",
  "RECOVERY_PENDING",
  "MANUAL_INTERVENTION",
  "CLOSED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
]);
const PACKAGE_EVIDENCE_GRADES = new Set<PackageEvidenceGrade>([
  "LOCAL_RECORDED",
  "CONTROLLER_ATTESTED",
  "VENUE_CORROBORATED",
  "CONSENSUS_VERIFIED",
]);
const SETTLEMENT_CLASSES = new Set<PackageLifecycleReceipt["settlementClass"]>([
  "ATOMIC_POSTCONDITION",
  "BATCHED_IOC_WITH_RECOVERY",
  "ASYNC_BONDED_SOLVER",
]);
const CANONICAL_UNSIGNED_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RUNTIME_HEALTH_REASONS = new Set([
  "DISABLED_BY_CONFIGURATION",
  "RUNTIME_FACTORY_NOT_INJECTED",
  "RUNTIME_INITIALIZATION_FAILED",
  "REQUIRED_PORTS_MISSING",
]);

function requireRuntimeBoundaryHealth(value: unknown, name: string): RuntimeBoundaryHealth {
  if (!isRecord(value)) throw new Error(`${name} is invalid.`);
  requireExactKeys(value, ["available", "reason"], name);
  if (typeof value.available !== "boolean" ||
      (value.reason !== null &&
        (typeof value.reason !== "string" || !RUNTIME_HEALTH_REASONS.has(value.reason)))) {
    throw new Error(`${name} is invalid.`);
  }
  if (value.available !== (value.reason === null)) throw new Error(`${name} is inconsistent.`);
  return Object.freeze({
    available: value.available,
    reason: value.reason as RuntimeBoundaryHealth["reason"],
  });
}

function requireRuntimeHealth(value: unknown): PrivateTerminalRuntimeHealth {
  if (!isRecord(value)) throw new Error("Private terminal health is invalid.");
  requireExactKeys(
    value,
    ["solanaDevnet", "baseTestnetAtomic", "arbitrumTestnetAsync", "hyperliquidTestnet"],
    "Private terminal health",
  );
  return Object.freeze({
    solanaDevnet: requireRuntimeBoundaryHealth(value.solanaDevnet, "Solana Devnet health"),
    baseTestnetAtomic: requireRuntimeBoundaryHealth(value.baseTestnetAtomic, "Base Testnet health"),
    arbitrumTestnetAsync: requireRuntimeBoundaryHealth(value.arbitrumTestnetAsync, "Arbitrum Testnet health"),
    hyperliquidTestnet: requireRuntimeBoundaryHealth(value.hyperliquidTestnet, "Hyperliquid Testnet health"),
  });
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} fields are invalid.`);
  }
}

function requireKeysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || actual.some((key) => !allowed.has(key))) {
    throw new Error(`${name} fields are invalid.`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requireInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${name} is invalid.`);
  }
  return value as number;
}

function requireHex32(value: unknown, name: string): string {
  const hex = requireString(value, name);
  if (!/^[0-9a-f]{64}$/.test(hex) || /^0{64}$/.test(hex)) {
    throw new Error(`${name} is invalid.`);
  }
  return hex;
}

function requireProtocolId(value: unknown, name: string): string {
  const id = requireString(value, name);
  if (id.length > 128 || !/^[\x00-\x7f]+$/.test(id)) {
    throw new Error(`${name} is invalid.`);
  }
  return id;
}

function requireCanonicalUnsigned(value: unknown, name: string, positive: boolean): string {
  if (typeof value !== "string" || !CANONICAL_UNSIGNED_PATTERN.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_SAFE_INTEGER_BIGINT || (positive && parsed === BigInt(0))) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requireLifecycleState(value: unknown, name: string): PackageLifecycleState {
  if (typeof value !== "string" || !PACKAGE_LIFECYCLE_STATES.has(value as PackageLifecycleState)) {
    throw new Error(`${name} is invalid.`);
  }
  return value as PackageLifecycleState;
}

function requireEvidenceGrade(value: unknown): PackageEvidenceGrade {
  if (typeof value !== "string" || !PACKAGE_EVIDENCE_GRADES.has(value as PackageEvidenceGrade)) {
    throw new Error("Lifecycle evidence grade is invalid.");
  }
  return value as PackageEvidenceGrade;
}

function requireBase58Bytes32(value: unknown, name: string): string {
  const encoded = requireString(value, name);
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(encoded);
  } catch {
    throw new Error(`${name} is invalid.`);
  }
  if (decoded.length !== 32 || bs58.encode(decoded) !== encoded) {
    throw new Error(`${name} is invalid.`);
  }
  return encoded;
}

function decodeCanonicalBase64(value: unknown, name: string): Uint8Array {
  const encoded = requireString(value, name);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`${name} is invalid.`);
  }
  const decoded = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const canonical = btoa(String.fromCharCode(...decoded));
  if (canonical !== encoded) {
    throw new Error(`${name} is not canonical.`);
  }
  return decoded;
}

function bytesEqual(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function requireStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${name} is invalid.`);
  }
  return Object.freeze([...value]);
}

function requireLifecycleAttemptId(value: unknown): string {
  if (typeof value !== "string" ||
      (!LIFECYCLE_ATTEMPT_ID_PATTERN.test(value) && !LOCAL_ATTEMPT_ID_PATTERN.test(value))) {
    throw new Error("Lifecycle attempt id is invalid.");
  }
  return value;
}

function requireLocalAttemptId(value: unknown): string {
  if (typeof value !== "string" || !LOCAL_ATTEMPT_ID_PATTERN.test(value)) {
    throw new Error("Local execution attempt id is invalid.");
  }
  return value;
}

function requireCanonicalBase58Signature(value: unknown, name: string): string {
  const signature = requireString(value, name);
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(signature);
  } catch {
    throw new Error(`${name} is invalid.`);
  }
  if (decoded.length !== 64 || bs58.encode(decoded) !== signature) {
    throw new Error(`${name} is invalid.`);
  }
  return signature;
}

function requireLocalOrderRecord(
  value: unknown,
  expected: { owner: string; settlementAccount: string; idempotencyKey: string },
): LocalOrderRecord {
  if (!isRecord(value)) throw new Error("Canonical order response is invalid.");
  requireExactKeys(value, [
    "idempotencyKey",
    "requestCommitmentHex",
    "orderHashHex",
    "orderBase64",
    "contextId",
    "domainId",
    "domainManifestVersion",
    "domainManifestHashHex",
    "owner",
    "settlementAccount",
    "nonceDecimal",
    "status",
    "createdAtMs",
  ], "Canonical order");
  if (value.idempotencyKey !== expected.idempotencyKey || value.owner !== expected.owner ||
      value.settlementAccount !== expected.settlementAccount || value.contextId !== LOCAL_CONTEXT_ID ||
      value.domainId !== "svm:local" || value.status !== "UNSIGNED_CREATED") {
    throw new Error("Canonical order response does not match the request.");
  }
  const orderBytes = decodeCanonicalBase64(value.orderBase64, "Canonical order bytes");
  if (orderBytes.length === 0) throw new Error("Canonical order bytes are empty.");
  const domainManifestVersion = requireInteger(value.domainManifestVersion, "Order domain manifest version");
  const createdAtMs = requireInteger(value.createdAtMs, "Order creation time");
  if (domainManifestVersion === 0 || createdAtMs === 0) {
    throw new Error("Canonical order metadata is invalid.");
  }
  return Object.freeze({
    idempotencyKey: value.idempotencyKey,
    requestCommitmentHex: requireHex32(value.requestCommitmentHex, "Order request commitment"),
    orderHashHex: requireHex32(value.orderHashHex, "Order hash"),
    orderBase64: value.orderBase64 as string,
    contextId: LOCAL_CONTEXT_ID,
    domainId: "svm:local",
    domainManifestVersion,
    domainManifestHashHex: requireHex32(value.domainManifestHashHex, "Order domain manifest hash"),
    owner: value.owner as string,
    settlementAccount: value.settlementAccount as string,
    nonceDecimal: requireCanonicalUnsigned(value.nonceDecimal, "Order nonce", true),
    status: "UNSIGNED_CREATED",
    createdAtMs,
    orderBytes,
  });
}

function requireLocalOrderCreateResponse(
  value: unknown,
  expected: { owner: string; settlementAccount: string; idempotencyKey: string },
): LocalOrderCreateResponse {
  if (!isRecord(value)) throw new Error("Canonical order response is invalid.");
  requireExactKeys(value, [
    "status", "created", "order", "traderAuthorization", "solverQuoting", "note",
  ], "Canonical order response");
  if (value.status !== "UNSIGNED_CREATED" || typeof value.created !== "boolean" ||
      value.traderAuthorization !== "REQUIRED" || value.solverQuoting !== "REQUIRED") {
    throw new Error("Canonical order response status is invalid.");
  }
  return Object.freeze({
    status: "UNSIGNED_CREATED",
    created: value.created,
    order: requireLocalOrderRecord(value.order, expected),
    traderAuthorization: "REQUIRED",
    solverQuoting: "REQUIRED",
    note: requireString(value.note, "Canonical order note"),
  });
}

function requireLocalAuthorization(
  value: unknown,
  order: LocalOrderRecord,
  signature: string,
): LocalAuthorization {
  if (!isRecord(value)) throw new Error("Order authorization response is invalid.");
  requireExactKeys(value, ["status", "authorization"], "Order authorization response");
  if (value.status !== "TRADER_AUTHORIZED" || !isRecord(value.authorization)) {
    throw new Error("Order authorization status is invalid.");
  }
  requireExactKeys(
    value.authorization,
    ["orderHash", "owner", "signature", "authorizedAtMs"],
    "Order authorization",
  );
  const authorization = value.authorization;
  if (authorization.orderHash !== order.orderHashHex || authorization.owner !== order.owner ||
      authorization.signature !== signature) {
    throw new Error("Order authorization does not match the canonical order.");
  }
  const authorizedAtMs = requireInteger(authorization.authorizedAtMs, "Authorization time");
  if (authorizedAtMs === 0) throw new Error("Authorization time is invalid.");
  return Object.freeze({
    orderHash: order.orderHashHex,
    owner: order.owner,
    signature: requireCanonicalBase58Signature(signature, "Authorization signature"),
    authorizedAtMs,
  });
}

function requireLocalSolverQuote(
  value: unknown,
  orderHash: string,
  idempotencyKey: string,
): LocalSolverQuote {
  if (!isRecord(value)) throw new Error("Solver quote response is invalid.");
  requireExactKeys(value, [
    "version", "status", "idempotencyKey", "orderHash", "routeHash", "quoteHash",
    "solverSignatureDigest", "routeBytes", "solverQuoteBytes", "route", "quote",
  ], "Solver quote response");
  if (value.version !== 1 || value.status !== "SIGNED" || value.orderHash !== orderHash ||
      value.idempotencyKey !== idempotencyKey || !isRecord(value.route) || !isRecord(value.quote)) {
    throw new Error("Solver quote binding is invalid.");
  }
  requireKeysWithOptional(value.route, [
    "version", "environment", "domain", "orderHash", "templateId", "templateVersion",
    "packageTemplateManifestHash", "templateRegistryRecordHash", "owner", "settlementAccount",
    "solver", "direction", "action", "quantityPolicyClass", "partialFillPolicy",
    "settlementClass", "executionPlanKind", "routeExpiryUnit", "routeExpiryValue",
    "feePolicyVersion", "feePolicyManifestHash", "accountBindings", "serviceCharges",
    "preconditions", "legs", "actions", "postconditions", "evidenceRequirements",
  ], ["recoveryPlan"], "Solver route");
  requireKeysWithOptional(value.quote, [
    "version", "environment", "domain", "orderHash", "solverId",
    "solverCapabilityManifestHash", "solverSignatureScheme", "solverVerificationKey",
    "quoteMode", "routeHash", "quotedOutcome", "expectedSpotNotional",
    "expectedPerpNotional", "expectedGrossSpotQuantity", "expectedNetSpotQuantity",
    "expectedBaseAssetFee", "expectedMarginDelta", "expectedRawFillFeesByAsset",
    "expectedBuilderFeesByAsset", "expectedNormalizedVenueFeesByAsset", "solverFee",
    "protocolFee", "expectedPriorityFee", "maxRecoveryCostAtomsByAsset", "feePolicyVersion",
    "feePolicyManifestHash", "validUntilUnit", "validUntilValue", "quoteNonce", "signature",
  ], ["expectedTerminalResidualBaseQuantity", "expectedTerminalResidualQuoteValue", "reservationId"], "Solver quote");
  if (value.route.version !== 1 || value.route.environment !== "local" ||
      value.route.settlementClass !== "ATOMIC_POSTCONDITION" ||
      value.quote.version !== 1 || value.quote.environment !== "local" ||
      value.quote.solverSignatureScheme !== "ED25519" ||
      value.quote.quoteMode !== "EXECUTION_COMMITMENT" ||
      typeof value.quote.solverId !== "string" || value.quote.solverId.length === 0 ||
      !isRecord(value.quote.quotedOutcome)) {
    throw new Error("Solver quote semantics are invalid.");
  }
  requireTaggedBytes32(value.route.orderHash, "Solver route order hash");
  requireTaggedBytes32(value.quote.orderHash, "Solver quote order hash");
  requireTaggedBytes32(value.quote.routeHash, "Solver quote route hash");
  requireTaggedScalar(value.route.routeExpiryValue, "bigint", "Solver route expiry");
  requireTaggedScalar(value.quote.validUntilValue, "bigint", "Solver quote expiry");
  requireTaggedScalar(value.quote.quoteNonce, "bigint", "Solver quote nonce");
  const signatureBytes = requireTaggedScalar(value.quote.signature, "bytes", "Solver quote signature");
  if (signatureBytes.length !== 128) throw new Error("Solver quote signature is invalid.");
  for (const key of [
    "expectedRawFillFeesByAsset", "expectedBuilderFeesByAsset",
    "expectedNormalizedVenueFeesByAsset", "maxRecoveryCostAtomsByAsset",
  ]) {
    if (!Array.isArray(value.quote[key])) throw new Error("Solver quote fee evidence is invalid.");
  }
  for (const key of ["solverFee", "protocolFee", "expectedPriorityFee"]) {
    const amount = value.quote[key];
    if (!isRecord(amount)) throw new Error("Solver quote fee amount is invalid.");
    requireExactKeys(amount, ["asset", "atoms"], "Solver quote fee amount");
    requireTaggedScalar(amount.atoms, "bigint", "Solver quote fee atoms");
  }
  for (const [field, raw] of [["Route bytes", value.routeBytes], ["Solver quote bytes", value.solverQuoteBytes]] as const) {
    if (typeof raw !== "string" || raw.length === 0 || !/^(?:[0-9a-f]{2})+$/.test(raw)) {
      throw new Error(`${field} are invalid.`);
    }
  }
  return Object.freeze({
    version: 1,
    status: "SIGNED",
    idempotencyKey,
    orderHash,
    routeHash: requireHex32(value.routeHash, "Route hash"),
    quoteHash: requireHex32(value.quoteHash, "Quote hash"),
    solverSignatureDigest: requireHex32(value.solverSignatureDigest, "Solver signature digest"),
    routeBytes: value.routeBytes as string,
    solverQuoteBytes: value.solverQuoteBytes as string,
    route: Object.freeze({ ...value.route }),
    quote: Object.freeze({ ...value.quote }),
  });
}

function requireLocalSelectedAttempt(value: unknown, quote: LocalSolverQuote): LocalSelectedAttempt {
  if (!isRecord(value)) throw new Error("Quote selection response is invalid.");
  requireExactKeys(value, ["status", "attempt"], "Quote selection response");
  if (value.status !== "AUTHORIZED_QUOTE_SELECTED" || !isRecord(value.attempt)) {
    throw new Error("Quote selection status is invalid.");
  }
  requireExactKeys(
    value.attempt,
    ["attemptId", "orderHash", "routeHash", "quoteHash", "status", "selectedAtMs"],
    "Selected attempt",
  );
  const attempt = value.attempt;
  if (attempt.orderHash !== quote.orderHash || attempt.routeHash !== quote.routeHash ||
      attempt.quoteHash !== quote.quoteHash || attempt.status !== "AUTHORIZED_QUOTE_SELECTED") {
    throw new Error("Selected attempt does not match the reviewed quote.");
  }
  const selectedAtMs = requireInteger(attempt.selectedAtMs, "Selection time");
  if (selectedAtMs === 0) throw new Error("Selection time is invalid.");
  return Object.freeze({
    attemptId: requireLocalAttemptId(attempt.attemptId),
    orderHash: quote.orderHash,
    routeHash: quote.routeHash,
    quoteHash: quote.quoteHash,
    status: "AUTHORIZED_QUOTE_SELECTED",
    selectedAtMs,
  });
}

function requireTaggedScalar(value: unknown, type: "bigint" | "bytes", name: string): string {
  if (!isRecord(value)) throw new Error(`${name} is invalid.`);
  requireExactKeys(value, ["$naryxType", "value"], name);
  if (value.$naryxType !== type || typeof value.value !== "string") {
    throw new Error(`${name} is invalid.`);
  }
  if (type === "bigint" && !/^(?:0|[1-9][0-9]*)$/.test(value.value)) {
    throw new Error(`${name} is invalid.`);
  }
  if (type === "bytes" && !/^(?:[0-9a-f]{2})+$/.test(value.value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value.value;
}

function requireTaggedBytes32(value: unknown, name: string): string {
  const hex = requireTaggedScalar(value, "bytes", name);
  if (hex.length !== 64 || /^0{64}$/.test(hex)) throw new Error(`${name} is invalid.`);
  return hex;
}

function requireLocalActionResponse(
  value: unknown,
  action: LocalExecutionAction,
  attempt: LocalSelectedAttempt,
): PackageLifecycleState {
  if (!isRecord(value)) throw new Error("Local execution response is invalid.");
  requireExactKeys(value, ["action", "attempt", "receipts", "state"], "Local execution response");
  if (value.action !== action || !isRecord(value.attempt) || !Array.isArray(value.receipts) ||
      value.receipts.length === 0 || value.receipts.length > 100) {
    throw new Error("Local execution response is invalid.");
  }
  requireExactKeys(
    value.attempt,
    ["attemptId", "orderHash", "routeHash", "quoteHash", "status", "selectedAtMs"],
    "Local execution attempt",
  );
  if (value.attempt.attemptId !== attempt.attemptId || value.attempt.orderHash !== attempt.orderHash ||
      value.attempt.routeHash !== attempt.routeHash || value.attempt.quoteHash !== attempt.quoteHash ||
      value.attempt.status !== attempt.status || value.attempt.selectedAtMs !== attempt.selectedAtMs) {
    throw new Error("Local execution attempt binding is invalid.");
  }
  const state = requireLifecycleState(value.state, "Local execution state");
  let previousState: PackageLifecycleState | undefined;
  for (const [index, raw] of value.receipts.entries()) {
    if (!isRecord(raw)) throw new Error("Local lifecycle receipt is invalid.");
    requireKeysWithOptional(raw, [
      "version", "domain", "settlementClass", "packageId", "packageCommitment", "attemptId",
      "eventId", "revision", "nextState", "observedAtUnixMilliseconds", "evidenceGrade",
      "onchainEnforced", "evidenceSource", "evidenceCommitment",
    ], ["priorState", "previousReceiptHash"], "Local lifecycle receipt");
    if (raw.version !== 1 || raw.settlementClass !== "ATOMIC_POSTCONDITION" ||
        raw.packageId !== attempt.attemptId || raw.attemptId !== attempt.attemptId ||
        typeof raw.eventId !== "string" || raw.onchainEnforced !== false ||
        raw.evidenceGrade !== "LOCAL_RECORDED" || !isRecord(raw.domain) ||
        !isRecord(raw.evidenceSource)) {
      throw new Error("Local lifecycle receipt binding is invalid.");
    }
    requireExactKeys(raw.domain, ["domainId", "domainManifestVersion", "domainManifestHash"], "Local lifecycle domain");
    requireExactKeys(raw.evidenceSource, ["subjectId", "manifestVersion", "manifestHash"], "Local lifecycle evidence source");
    if (raw.domain.domainId !== "svm:local" || raw.domain.domainManifestVersion !== 1 ||
        raw.evidenceSource.subjectId !== "local-conformance-execution-v1" ||
        raw.evidenceSource.manifestVersion !== 1) {
      throw new Error("Local lifecycle evidence source is invalid.");
    }
    const revision = requireTaggedScalar(raw.revision, "bigint", "Local lifecycle revision");
    if (revision !== String(index + 1)) throw new Error("Local lifecycle receipt revision is invalid.");
    if (requireTaggedScalar(raw.observedAtUnixMilliseconds, "bigint", "Local lifecycle observed time") === "0") {
      throw new Error("Local lifecycle observed time is invalid.");
    }
    requireTaggedBytes32(raw.domain.domainManifestHash, "Local domain manifest hash");
    requireTaggedBytes32(raw.evidenceSource.manifestHash, "Local evidence manifest hash");
    requireTaggedBytes32(raw.packageCommitment, "Local lifecycle package commitment");
    requireTaggedBytes32(raw.evidenceCommitment, "Local lifecycle evidence commitment");
    const nextState = requireLifecycleState(raw.nextState, "Local lifecycle next state");
    if (index === 0 ? raw.priorState !== undefined || nextState !== "PACKAGE_CREATED"
      : raw.priorState !== previousState || raw.previousReceiptHash === undefined) {
      throw new Error("Local lifecycle receipt chain is invalid.");
    }
    if (raw.previousReceiptHash !== undefined) {
      requireTaggedBytes32(raw.previousReceiptHash, "Local previous receipt hash");
    }
    previousState = nextState;
  }
  if (previousState !== state) throw new Error("Local execution state does not match its receipts.");
  return state;
}

function requirePreparation(
  value: unknown,
  input: SolanaExecutionPreparationInput,
): SolanaExecutionPreparation {
  if (!isRecord(value)) {
    throw new Error("Execution preparation response is invalid.");
  }
  requireExactKeys(value, [
    "status",
    "environment",
    "idempotencyKey",
    "domain",
    "domainManifestVersion",
    "domainManifestHash",
    "planKind",
    "messageBase64",
    "transactionBase64",
    "requiredSignerPubkeys",
    "recentBlockhash",
    "blockhashContextSlot",
    "lastValidBlockHeight",
    "lifecycleAttemptId",
    "genesisHash",
    "lookupTables",
    "evidence",
    "requestCommitment",
  ], "Execution preparation response");
  if (value.status !== "DEVNET_UNSIGNED_REVIEW_REQUIRED" ||
      value.domain !== "svm:devnet" ||
      value.environment !== "DEVNET" ||
      value.genesisHash !== SOLANA_DEVNET_GENESIS_HASH) {
    throw new Error("Execution preparation is not bound to Solana Devnet.");
  }
  if (value.idempotencyKey !== input.idempotencyKey) {
    throw new Error("Execution preparation idempotency key does not match the request.");
  }
  const domainManifestVersion = requireInteger(
    value.domainManifestVersion,
    "Domain manifest version",
  );
  if (domainManifestVersion === 0) {
    throw new Error("Domain manifest version must be positive.");
  }
  const domainManifestHash = requireHex32(value.domainManifestHash, "Domain manifest hash");
  const expectedPlanKind = input.mode === "entry" ? "TRADER_ENTRY" : "TRADER_RECOVERY_EXIT";
  if (value.planKind !== "TRADER_ENTRY" && value.planKind !== "TRADER_RECOVERY_EXIT") {
    throw new Error("Execution preparation plan kind is invalid.");
  }
  if (value.planKind !== expectedPlanKind) {
    throw new Error("Execution preparation plan kind does not match the reviewed mode.");
  }

  const transactionBytes = decodeCanonicalBase64(value.transactionBase64, "Transaction");
  const messageBytes = decodeCanonicalBase64(value.messageBase64, "Transaction message");
  if (transactionBytes.length === 0 || transactionBytes.length > MAX_TRANSACTION_BYTES) {
    throw new Error("Execution transaction exceeds the Solana packet limit.");
  }
  let decoded: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
  try {
    decoded = getTransactionDecoder().decode(transactionBytes);
  } catch {
    throw new Error("Execution transaction cannot be decoded.");
  }
  if (!bytesEqual(decoded.messageBytes, messageBytes)) {
    throw new Error("Execution transaction and message bytes do not match.");
  }
  if (Object.values(decoded.signatures).some((signature) => signature !== null)) {
    throw new Error("Execution transaction already contains a signature.");
  }
  const requiredSignerPubkeys = requireStringArray(value.requiredSignerPubkeys, "Required signers");
  const decodedSignerPubkeys = Object.keys(decoded.signatures);
  if (requiredSignerPubkeys.length !== 1 ||
      decodedSignerPubkeys.length !== 1 ||
      decodedSignerPubkeys[0] !== requiredSignerPubkeys[0] ||
      requiredSignerPubkeys[0] !== input.traderPublicKey) {
    throw new Error("Execution transaction signer does not match the connected account.");
  }

  if (!Array.isArray(value.lookupTables)) {
    throw new Error("Execution lookup tables are invalid.");
  }
  const lookupTables = value.lookupTables.map((table, index) => {
    if (!isRecord(table)) {
      throw new Error(`Execution lookup table ${index} is invalid.`);
    }
    requireExactKeys(
      table,
      ["address", "addresses", "contentCommitment", "contextSlot"],
      `Execution lookup table ${index}`,
    );
    return Object.freeze({
      address: requireString(table.address, `Execution lookup table ${index} address`),
      addresses: requireStringArray(table.addresses, `Execution lookup table ${index} addresses`),
      contentCommitment: requireHex32(
        table.contentCommitment,
        `Execution lookup table ${index} commitment`,
      ),
      contextSlot: requireInteger(table.contextSlot, `Execution lookup table ${index} slot`),
    });
  });

  if (!isRecord(value.evidence)) {
    throw new Error("Execution evidence is invalid.");
  }
  requireExactKeys(value.evidence, [
    "resolvedAddressCount",
    "serializedMessageBytes",
    "serializedTransactionBytes",
    "packetDataLimit",
    "computeUnitLimit",
    "computeUnitLimitSource",
    "routeComputeUnitLimit",
  ], "Execution evidence");
  const resolvedAddressCount = requireInteger(
    value.evidence.resolvedAddressCount,
    "Resolved address count",
    MAX_RESOLVED_ACCOUNTS,
  );
  const serializedMessageBytes = requireInteger(
    value.evidence.serializedMessageBytes,
    "Serialized message size",
    MAX_TRANSACTION_BYTES,
  );
  const serializedTransactionBytes = requireInteger(
    value.evidence.serializedTransactionBytes,
    "Serialized transaction size",
    MAX_TRANSACTION_BYTES,
  );
  if (serializedMessageBytes !== messageBytes.length ||
      serializedTransactionBytes !== transactionBytes.length ||
      value.evidence.packetDataLimit !== MAX_TRANSACTION_BYTES) {
    throw new Error("Execution byte evidence does not match the transaction.");
  }
  const computeUnitLimit = requireInteger(
    value.evidence.computeUnitLimit,
    "Compute unit limit",
    MAX_COMPUTE_UNITS,
  );
  if (value.evidence.computeUnitLimitSource !== "EXPLICIT") {
    throw new Error("Compute unit evidence source is invalid.");
  }
  const routeComputeUnitLimit = requireInteger(
    value.evidence.routeComputeUnitLimit,
    "Route compute unit limit",
    MAX_COMPUTE_UNITS,
  );
  if (routeComputeUnitLimit !== MAX_COMPUTE_UNITS || computeUnitLimit === 0) {
    throw new Error("Execution compute unit evidence is invalid.");
  }
  if (computeUnitLimit > routeComputeUnitLimit) {
    throw new Error("Execution compute unit evidence is inconsistent.");
  }

  return Object.freeze({
    status: value.status,
    domain: value.domain,
    environment: value.environment,
    idempotencyKey: value.idempotencyKey,
    domainManifestVersion,
    domainManifestHash,
    genesisHash: value.genesisHash,
    planKind: value.planKind,
    transactionBase64: value.transactionBase64 as string,
    messageBase64: value.messageBase64 as string,
    requiredSignerPubkeys,
    recentBlockhash: requireBase58Bytes32(value.recentBlockhash, "Recent blockhash"),
    blockhashContextSlot: requireInteger(value.blockhashContextSlot, "Blockhash context slot"),
    lastValidBlockHeight: requireInteger(value.lastValidBlockHeight, "Last valid block height"),
    lifecycleAttemptId: requireLifecycleAttemptId(value.lifecycleAttemptId),
    lookupTables: Object.freeze(lookupTables),
    evidence: Object.freeze({
      resolvedAddressCount,
      serializedMessageBytes,
      serializedTransactionBytes,
      packetDataLimit: 1232,
      computeUnitLimit,
      computeUnitLimitSource: value.evidence.computeUnitLimitSource,
      routeComputeUnitLimit,
    }),
    requestCommitment: requireHex32(value.requestCommitment, "Request commitment"),
    transactionBytes,
  });
}

function requireSnapshot(value: unknown): TerminalViewModel {
  if (!isRecord(value) || !isRecord(value.environment) ||
      value.environment.source !== "PRIVATE_TERMINAL_BFF" ||
      value.environment.executionEnabled !== false ||
      !Array.isArray(value.domains) || !isRecord(value.market) ||
      !isRecord(value.chart) || !Array.isArray(value.plans) ||
      !isRecord(value.ticket) || !Array.isArray(value.workspaces)) {
    throw new Error("Private terminal snapshot response is invalid.");
  }
  return value as TerminalViewModel;
}

function requirePreview(value: unknown): TerminalPreview {
  if (!isRecord(value) || value.source !== "PRIVATE_TERMINAL_BFF" ||
      value.executionAvailable !== false || !isRecord(value.size) ||
      !isRecord(value.bound) || !Array.isArray(value.fees) ||
      !Array.isArray(value.legs) || !isRecord(value.totalFee) ||
      !isRecord(value.action)) {
    throw new Error("Private terminal preview response is invalid.");
  }
  return value as TerminalPreview;
}

function requireObservationIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new Error("Observation idempotency key is invalid.");
  }
  return value;
}

function requireCanonicalSignature(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Observation signature is invalid.");
  }
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new Error("Observation signature is invalid.");
  }
  if (decoded.length !== 64 || bs58.encode(decoded) !== value) {
    throw new Error("Observation signature is invalid.");
  }
  return value;
}

function requireNonnegativeSlot(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requirePositiveHeight(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requireFailureCode(value: unknown): string {
  if (typeof value !== "string" || !FAILURE_CODE_PATTERN.test(value)) {
    throw new Error("Observation failure code is invalid.");
  }
  return value;
}

function requireObservation(
  value: unknown,
  request: SolanaExecutionObservationRequest,
): SolanaExecutionObservation {
  if (!isRecord(value)) {
    throw new Error("Devnet observation response is invalid.");
  }
  if (value.environment !== "DEVNET" || value.domain !== "svm:devnet") {
    throw new Error("Devnet observation is not bound to Solana Devnet.");
  }
  if (value.idempotencyKey !== request.idempotencyKey) {
    throw new Error("Devnet observation idempotency key does not match the request.");
  }
  if (value.signature !== request.signature) {
    throw new Error("Devnet observation signature does not match the request.");
  }
  if (value.lifecycle === "SUBMITTED") {
    requireExactKeys(value, [
      "domain",
      "environment",
      "idempotencyKey",
      "lifecycle",
      "observedSlot",
      "signature",
    ], "Devnet observation");
    const observedSlotRaw = value.observedSlot;
    const observedSlot = observedSlotRaw === null
      ? null
      : requireNonnegativeSlot(observedSlotRaw, "Observed slot");
    return Object.freeze({
      lifecycle: "SUBMITTED",
      signature: request.signature,
      observedSlot,
    });
  }
  if (value.lifecycle === "FINALIZED") {
    requireExactKeys(value, [
      "domain",
      "environment",
      "finalizedSlot",
      "idempotencyKey",
      "lifecycle",
      "signature",
    ], "Devnet observation");
    return Object.freeze({
      lifecycle: "FINALIZED",
      signature: request.signature,
      finalizedSlot: requireNonnegativeSlot(value.finalizedSlot, "Finalized slot"),
    });
  }
  if (value.lifecycle === "FAILED") {
    requireExactKeys(value, [
      "domain",
      "environment",
      "failedSlot",
      "failureCode",
      "idempotencyKey",
      "lifecycle",
      "signature",
    ], "Devnet observation");
    const failedSlotRaw = value.failedSlot;
    const failedSlot = failedSlotRaw === null
      ? null
      : requireNonnegativeSlot(failedSlotRaw, "Failed slot");
    return Object.freeze({
      lifecycle: "FAILED",
      signature: request.signature,
      failedSlot,
      failureCode: requireFailureCode(value.failureCode),
    });
  }
  if (value.lifecycle === "EXPIRED") {
    requireExactKeys(value, [
      "domain",
      "environment",
      "idempotencyKey",
      "lastValidBlockHeight",
      "lifecycle",
      "observedBlockHeight",
      "signature",
    ], "Devnet observation");
    const lastValidBlockHeight = requirePositiveHeight(
      value.lastValidBlockHeight,
      "Last valid block height",
    );
    const observedBlockHeight = requirePositiveHeight(
      value.observedBlockHeight,
      "Observed block height",
    );
    if (observedBlockHeight <= lastValidBlockHeight) {
      throw new Error("Devnet expired observation has not crossed last valid block height.");
    }
    return Object.freeze({
      lifecycle: "EXPIRED",
      signature: request.signature,
      lastValidBlockHeight,
      observedBlockHeight,
    });
  }
  throw new Error("Devnet observation lifecycle is unsupported.");
}

function requireLifecycleAttempt(value: unknown, requestedAttemptId: string): PackageLifecycleAttempt {
  if (!isRecord(value)) throw new Error("Lifecycle attempt is invalid.");
  requireExactKeys(value, [
    "attemptId",
    "packageId",
    "packageCommitmentHex",
    "revision",
    "state",
    "receiptHashHex",
    "eventId",
    "observedAtUnixMilliseconds",
  ], "Lifecycle attempt");
  const attemptId = requireLifecycleAttemptId(value.attemptId);
  if (attemptId !== requestedAttemptId) throw new Error("Lifecycle attempt does not match the request.");
  return Object.freeze({
    attemptId,
    packageId: requireProtocolId(value.packageId, "Lifecycle package id"),
    packageCommitmentHex: requireHex32(value.packageCommitmentHex, "Lifecycle package commitment"),
    revision: requireCanonicalUnsigned(value.revision, "Lifecycle revision", true),
    state: requireLifecycleState(value.state, "Lifecycle state"),
    receiptHashHex: requireHex32(value.receiptHashHex, "Lifecycle receipt hash"),
    eventId: requireProtocolId(value.eventId, "Lifecycle event id"),
    observedAtUnixMilliseconds: requireCanonicalUnsigned(
      value.observedAtUnixMilliseconds,
      "Lifecycle observed time",
      true,
    ),
  });
}

function requireLifecycleReceipt(value: unknown): PackageLifecycleReceipt {
  if (!isRecord(value)) throw new Error("Lifecycle receipt is invalid.");
  requireKeysWithOptional(value, [
    "version",
    "domain",
    "settlementClass",
    "packageId",
    "packageCommitmentHex",
    "attemptId",
    "eventId",
    "revision",
    "nextState",
    "observedAtUnixMilliseconds",
    "evidenceGrade",
    "onchainEnforced",
    "evidenceSource",
    "evidenceCommitmentHex",
    "intentCommitmentHex",
    "receiptHashHex",
  ], ["priorState", "previousReceiptHashHex"], "Lifecycle receipt");
  if (value.version !== 1) throw new Error("Lifecycle receipt version is invalid.");
  if (!isRecord(value.domain)) throw new Error("Lifecycle receipt domain is invalid.");
  requireExactKeys(
    value.domain,
    ["domainId", "domainManifestVersion", "domainManifestHashHex"],
    "Lifecycle receipt domain",
  );
  if (!isRecord(value.evidenceSource)) throw new Error("Lifecycle evidence source is invalid.");
  requireExactKeys(
    value.evidenceSource,
    ["subjectId", "manifestVersion", "manifestHashHex"],
    "Lifecycle evidence source",
  );
  if (typeof value.settlementClass !== "string" ||
      !SETTLEMENT_CLASSES.has(value.settlementClass as PackageLifecycleReceipt["settlementClass"])) {
    throw new Error("Lifecycle settlement class is invalid.");
  }
  if (typeof value.onchainEnforced !== "boolean") {
    throw new Error("Lifecycle enforcement flag is invalid.");
  }
  const priorState = value.priorState === undefined
    ? undefined
    : requireLifecycleState(value.priorState, "Lifecycle prior state");
  const previousReceiptHashHex = value.previousReceiptHashHex === undefined
    ? undefined
    : requireHex32(value.previousReceiptHashHex, "Lifecycle previous receipt hash");
  if ((priorState === undefined) !== (previousReceiptHashHex === undefined)) {
    throw new Error("Lifecycle receipt linkage is incomplete.");
  }
  const receipt: PackageLifecycleReceipt = {
    version: 1,
    domain: Object.freeze({
      domainId: requireProtocolId(value.domain.domainId, "Lifecycle domain id"),
      domainManifestVersion: requireInteger(
        value.domain.domainManifestVersion,
        "Lifecycle domain manifest version",
      ),
      domainManifestHashHex: requireHex32(
        value.domain.domainManifestHashHex,
        "Lifecycle domain manifest hash",
      ),
    }),
    settlementClass: value.settlementClass as PackageLifecycleReceipt["settlementClass"],
    packageId: requireProtocolId(value.packageId, "Lifecycle receipt package id"),
    packageCommitmentHex: requireHex32(
      value.packageCommitmentHex,
      "Lifecycle receipt package commitment",
    ),
    attemptId: requireLifecycleAttemptId(value.attemptId),
    eventId: requireProtocolId(value.eventId, "Lifecycle receipt event id"),
    revision: requireCanonicalUnsigned(value.revision, "Lifecycle receipt revision", true),
    nextState: requireLifecycleState(value.nextState, "Lifecycle next state"),
    observedAtUnixMilliseconds: requireCanonicalUnsigned(
      value.observedAtUnixMilliseconds,
      "Lifecycle receipt observed time",
      true,
    ),
    evidenceGrade: requireEvidenceGrade(value.evidenceGrade),
    onchainEnforced: value.onchainEnforced,
    evidenceSource: Object.freeze({
      subjectId: requireProtocolId(value.evidenceSource.subjectId, "Lifecycle evidence subject"),
      manifestVersion: requireInteger(
        value.evidenceSource.manifestVersion,
        "Lifecycle evidence manifest version",
      ),
      manifestHashHex: requireHex32(
        value.evidenceSource.manifestHashHex,
        "Lifecycle evidence manifest hash",
      ),
    }),
    evidenceCommitmentHex: requireHex32(
      value.evidenceCommitmentHex,
      "Lifecycle evidence commitment",
    ),
    intentCommitmentHex: requireHex32(
      value.intentCommitmentHex,
      "Lifecycle intent commitment",
    ),
    receiptHashHex: requireHex32(value.receiptHashHex, "Lifecycle receipt hash"),
    ...(priorState === undefined ? {} : { priorState }),
    ...(previousReceiptHashHex === undefined ? {} : { previousReceiptHashHex }),
  };
  if (receipt.domain.domainManifestVersion === 0 || receipt.evidenceSource.manifestVersion === 0) {
    throw new Error("Lifecycle manifest version must be positive.");
  }
  return Object.freeze(receipt);
}

function requireLifecycleResponse(value: unknown, requestedAttemptId: string): PackageLifecycleResponse {
  if (!isRecord(value)) throw new Error("Lifecycle response is invalid.");
  requireExactKeys(value, ["attempt", "receipts"], "Lifecycle response");
  const attempt = requireLifecycleAttempt(value.attempt, requestedAttemptId);
  if (!Array.isArray(value.receipts) || value.receipts.length === 0 || value.receipts.length > 100) {
    throw new Error("Lifecycle receipt history is invalid.");
  }
  const receipts = value.receipts.map(requireLifecycleReceipt);
  for (const [index, receipt] of receipts.entries()) {
    const expectedRevision = String(index + 1);
    if (receipt.revision !== expectedRevision ||
        receipt.attemptId !== attempt.attemptId ||
        receipt.packageId !== attempt.packageId ||
        receipt.packageCommitmentHex !== attempt.packageCommitmentHex) {
      throw new Error("Lifecycle receipt history does not match its attempt.");
    }
    if (index === 0) {
      if (receipt.priorState !== undefined || receipt.previousReceiptHashHex !== undefined ||
          receipt.nextState !== "PACKAGE_CREATED") {
        throw new Error("Lifecycle receipt history has an invalid initial receipt.");
      }
      continue;
    }
    const previous = receipts[index - 1];
    if (!previous || receipt.priorState !== previous.nextState ||
        receipt.previousReceiptHashHex !== previous.receiptHashHex) {
      throw new Error("Lifecycle receipt history has a broken chain.");
    }
  }
  const latest = receipts.at(-1);
  if (!latest || latest.revision !== attempt.revision || latest.nextState !== attempt.state ||
      latest.receiptHashHex !== attempt.receiptHashHex || latest.eventId !== attempt.eventId ||
      latest.observedAtUnixMilliseconds !== attempt.observedAtUnixMilliseconds) {
    throw new Error("Lifecycle receipt history does not match the attempt head.");
  }
  return Object.freeze({ attempt, receipts: Object.freeze(receipts) });
}

function toSafeObservationError(status: number, code: string | null): Error {
  if (status === 503 || code === "EXECUTION_UNAVAILABLE" ||
      status === 502 || code === "EXECUTION_OBSERVATION_FAILED") {
    return new Error("Devnet observation is temporarily unavailable.");
  }
  if (status === 400 || status === 405 || status === 404) {
    return new Error("Devnet observation rejected the request.");
  }
  return new Error("Devnet observation is temporarily unavailable.");
}

export class PrivateHttpTerminalProvider implements TerminalViewModelProvider {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    const parsed = new URL(baseUrl);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username !== "" || parsed.password !== "" ||
        parsed.search !== "" || parsed.hash !== "") {
      throw new Error("Private terminal base URL must be an HTTP or HTTPS URL.");
    }
    this.#baseUrl = parsed.href.replace(/\/$/, "");
  }

  async getRuntimeHealth(signal?: AbortSignal): Promise<PrivateTerminalRuntimeHealth> {
    const response = await fetch(`${this.#baseUrl}/internal/healthz`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) throw new Error("Private terminal health is unavailable.");
    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      throw new Error("Private terminal health response is invalid.");
    }
    if (!isRecord(payload) || !("runtime" in payload)) {
      throw new Error("Private terminal runtime health is unavailable.");
    }
    return requireRuntimeHealth(payload.runtime);
  }

  async getSnapshot(domain: DomainId, signal?: AbortSignal): Promise<TerminalViewModel> {
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/snapshot?domain=${encodeURIComponent(domain)}`,
      {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal,
      },
    );
    if (!response.ok) throw new Error(`Private terminal snapshot failed with ${response.status}.`);
    return requireSnapshot(await response.json() as unknown);
  }

  async getPreview(
    input: TerminalPreviewInput,
    signal?: AbortSignal,
  ): Promise<TerminalPreview> {
    const response = await fetch(`${this.#baseUrl}/internal/terminal/preview`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok) throw new Error(`Private terminal preview failed with ${response.status}.`);
    return requirePreview(await response.json() as unknown);
  }

  async createLocalOrder(
    input: Readonly<{
      owner: string;
      settlementAccount: string;
      size: string;
      slippageBps: number;
      idempotencyKey: string;
    }>,
    signal?: AbortSignal,
  ): Promise<LocalOrderCreateResponse> {
    const request = {
      contextId: LOCAL_CONTEXT_ID,
      owner: requireBase58Bytes32(input.owner, "Order owner"),
      settlementAccount: requireString(input.settlementAccount, "Settlement account"),
      size: requireString(input.size, "Order size"),
      slippageBps: requireInteger(input.slippageBps, "Order slippage"),
      idempotencyKey: requireObservationIdempotencyKey(input.idempotencyKey),
    };
    if (request.slippageBps === 0) throw new Error("Order slippage is invalid.");
    const response = await fetch(`${this.#baseUrl}/internal/terminal/orders`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw new Error(`Canonical order creation failed with ${response.status}.`);
    return requireLocalOrderCreateResponse(await response.json() as unknown, request);
  }

  async authorizeLocalOrder(
    order: LocalOrderRecord,
    signature: string,
    signal?: AbortSignal,
  ): Promise<LocalAuthorization> {
    const checkedSignature = requireCanonicalBase58Signature(signature, "Authorization signature");
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/orders/${order.orderHashHex}/authorize`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: checkedSignature }),
        signal,
      },
    );
    if (!response.ok) throw new Error(`Order authorization failed with ${response.status}.`);
    return requireLocalAuthorization(await response.json() as unknown, order, checkedSignature);
  }

  async requestLocalQuote(
    order: LocalOrderRecord,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<LocalSolverQuote> {
    const key = requireObservationIdempotencyKey(idempotencyKey);
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/orders/${order.orderHashHex}/quote`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: key }),
        signal,
      },
    );
    if (!response.ok) throw new Error(`Solver quote request failed with ${response.status}.`);
    return requireLocalSolverQuote(await response.json() as unknown, order.orderHashHex, key);
  }

  async selectLocalQuote(
    quote: LocalSolverQuote,
    signal?: AbortSignal,
  ): Promise<LocalSelectedAttempt> {
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/orders/${quote.orderHash}/select`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteHash: quote.quoteHash }),
        signal,
      },
    );
    if (!response.ok) throw new Error(`Quote selection failed with ${response.status}.`);
    return requireLocalSelectedAttempt(await response.json() as unknown, quote);
  }

  async runLocalExecutionAction(
    attempt: LocalSelectedAttempt,
    action: LocalExecutionAction,
    signal?: AbortSignal,
  ): Promise<LocalExecutionResult> {
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/attempts/${attempt.attemptId}/${action}`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal,
      },
    );
    if (!response.ok) throw new Error(`Local ${action} action failed with ${response.status}.`);
    const state = requireLocalActionResponse(await response.json() as unknown, action, attempt);
    const lifecycle = await this.getPackageLifecycle(attempt.attemptId, signal);
    if (lifecycle.attempt.state !== state) {
      throw new Error("Local action response does not match the authoritative lifecycle head.");
    }
    return Object.freeze({ action, state, lifecycle });
  }

  async prepareSolanaExecution(
    input: SolanaExecutionPreparationInput,
    signal?: AbortSignal,
  ): Promise<SolanaExecutionPreparation> {
    const response = await fetch(`${this.#baseUrl}/internal/terminal/execution/prepare`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Execution preparation failed with ${response.status}.`);
    }
    return requirePreparation(await response.json() as unknown, input);
  }

  async getPackageLifecycle(
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<PackageLifecycleResponse> {
    const checkedAttemptId = requireLifecycleAttemptId(attemptId);
    const query = new URLSearchParams({
      attemptId: checkedAttemptId,
      afterRevision: "0",
      limit: "100",
    });
    const response = await fetch(`${this.#baseUrl}/internal/terminal/lifecycle?${query.toString()}`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) throw new Error("Package lifecycle is temporarily unavailable.");
    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      throw new Error("Package lifecycle response is invalid.");
    }
    return requireLifecycleResponse(payload, checkedAttemptId);
  }

  async observeSolanaExecution(
    request: SolanaExecutionObservationRequest,
    signal?: AbortSignal,
  ): Promise<SolanaExecutionObservation> {
    const idempotencyKey = requireObservationIdempotencyKey(request.idempotencyKey);
    const signature = requireCanonicalSignature(request.signature);
    const response = await fetch(`${this.#baseUrl}/internal/terminal/execution/observe`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey, signature }),
      signal,
    });
    if (!response.ok) {
      let code: string | null = null;
      try {
        const body = await response.json() as unknown;
        if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string") {
          code = body.error.code;
        }
      } catch {
        code = null;
      }
      throw toSafeObservationError(response.status, code);
    }
    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      throw new Error("Devnet observation response is invalid.");
    }
    return requireObservation(payload, { idempotencyKey, signature });
  }
}
