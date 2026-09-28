import {
  commitmentHash,
  enumDiscriminant,
  packageLifecycleEventIntentCommitment,
  packageLifecycleReceipt,
  packageLifecycleReceiptHash,
  protocolId,
  toHex,
  PACKAGE_LIFECYCLE_STATE,
} from "@naryx/protocol-types";
import type {
  PackageLifecycleReceipt,
} from "@naryx/protocol-types";
import type {
  PackageLifecycleAttempt,
} from "./package-lifecycle-store.js";

export class LifecycleQueryValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LifecycleQueryValidationError";
    this.code = code;
  }
}

export type LifecycleReadQuery = Readonly<{
  attemptId: string;
  afterRevision: bigint;
  limit: number;
}>;

export type LifecycleAttemptDto = Readonly<{
  attemptId: string;
  packageId: string;
  packageCommitmentHex: string;
  revision: string;
  state: string;
  receiptHashHex: string;
  eventId: string;
  observedAtUnixMilliseconds: string;
}>;

export type LifecycleReceiptDomainDto = Readonly<{
  domainId: string;
  domainManifestVersion: number;
  domainManifestHashHex: string;
}>;

export type LifecycleReceiptEvidenceSourceDto = Readonly<{
  subjectId: string;
  manifestVersion: number;
  manifestHashHex: string;
}>;

export type LifecycleReceiptDto = Readonly<{
  version: number;
  domain: LifecycleReceiptDomainDto;
  settlementClass: string;
  packageId: string;
  packageCommitmentHex: string;
  attemptId: string;
  eventId: string;
  revision: string;
  priorState?: string;
  previousReceiptHashHex?: string;
  nextState: string;
  observedAtUnixMilliseconds: string;
  evidenceGrade: string;
  onchainEnforced: boolean;
  evidenceSource: LifecycleReceiptEvidenceSourceDto;
  evidenceCommitmentHex: string;
  intentCommitmentHex: string;
  receiptHashHex: string;
}>;

export type LifecycleReadResponse = Readonly<{
  attempt: LifecycleAttemptDto;
  receipts: readonly LifecycleReceiptDto[];
}>;

const ALLOWED_QUERY_KEYS = new Set(["attemptId", "afterRevision", "limit"]);
const CANONICAL_UINT_PATTERN = /^(0|[1-9][0-9]*)$/;
const ASCII_PATTERN = /^[\x00-\x7F]*$/;
const MAX_SAFE_REVISION = BigInt(Number.MAX_SAFE_INTEGER);
const DEFAULT_AFTER_REVISION = 0n;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAscii(value: string, context: string): void {
  if (!ASCII_PATTERN.test(value)) {
    throw new Error(`${context} is not plain ASCII.`);
  }
}

export function parseLifecycleQuery(searchParams: URLSearchParams): LifecycleReadQuery {
  for (const key of searchParams.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      throw new LifecycleQueryValidationError(
        "INVALID_QUERY",
        "Only attemptId, afterRevision, and limit query parameters are allowed.",
      );
    }
  }
  const attemptValues = searchParams.getAll("attemptId");
  if (attemptValues.length !== 1) {
    throw new LifecycleQueryValidationError(
      "INVALID_ATTEMPT_ID",
      "Exactly one valid attemptId query parameter is required.",
    );
  }
  const rawAttemptId = attemptValues[0] as string;
  try {
    protocolId(rawAttemptId, "attemptId");
  } catch {
    throw new LifecycleQueryValidationError(
      "INVALID_ATTEMPT_ID",
      "Exactly one valid attemptId query parameter is required.",
    );
  }
  const afterValues = searchParams.getAll("afterRevision");
  let afterRevision = DEFAULT_AFTER_REVISION;
  if (afterValues.length > 1) {
    throw new LifecycleQueryValidationError(
      "INVALID_AFTER_REVISION",
      "afterRevision must be a canonical unsigned decimal within the safe-integer range.",
    );
  }
  if (afterValues.length === 1) {
    const raw = afterValues[0] as string;
    if (!CANONICAL_UINT_PATTERN.test(raw)) {
      throw new LifecycleQueryValidationError(
        "INVALID_AFTER_REVISION",
        "afterRevision must be a canonical unsigned decimal within the safe-integer range.",
      );
    }
    const parsed = BigInt(raw);
    if (parsed < 0n || parsed > MAX_SAFE_REVISION) {
      throw new LifecycleQueryValidationError(
        "INVALID_AFTER_REVISION",
        "afterRevision must be a canonical unsigned decimal within the safe-integer range.",
      );
    }
    afterRevision = parsed;
  }
  const limitValues = searchParams.getAll("limit");
  let limit = DEFAULT_LIMIT;
  if (limitValues.length > 1) {
    throw new LifecycleQueryValidationError(
      "INVALID_LIMIT",
      "limit must be a canonical decimal integer within 1 through 100.",
    );
  }
  if (limitValues.length === 1) {
    const raw = limitValues[0] as string;
    if (!CANONICAL_UINT_PATTERN.test(raw)) {
      throw new LifecycleQueryValidationError(
        "INVALID_LIMIT",
        "limit must be a canonical decimal integer within 1 through 100.",
      );
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      throw new LifecycleQueryValidationError(
        "INVALID_LIMIT",
        "limit must be a canonical decimal integer within 1 through 100.",
      );
    }
    limit = parsed;
  }
  return Object.freeze({ attemptId: rawAttemptId, afterRevision, limit });
}

type ValidatedAttempt = Readonly<{
  dto: LifecycleAttemptDto;
  revision: bigint;
  packageId: string;
  packageCommitmentHex: string;
}>;

function validateAttempt(value: unknown): ValidatedAttempt {
  if (!isRecord(value)) {
    throw new Error("Stored attempt is not an object.");
  }
  if (typeof value["attemptId"] !== "string" ||
      typeof value["packageId"] !== "string" ||
      typeof value["eventId"] !== "string") {
    throw new Error("Stored attempt identifiers are invalid.");
  }
  const attemptId = protocolId(value["attemptId"], "lifecycleAttempt.attemptId");
  const packageId = protocolId(value["packageId"], "lifecycleAttempt.packageId");
  const eventId = protocolId(value["eventId"], "lifecycleAttempt.eventId");
  if (typeof value["packageCommitmentHex"] !== "string") {
    throw new Error("Stored attempt package commitment is invalid.");
  }
  if (typeof value["receiptHashHex"] !== "string") {
    throw new Error("Stored attempt receipt hash is invalid.");
  }
  const packageCommitmentBytes = commitmentHash(
    value["packageCommitmentHex"],
    "lifecycleAttempt.packageCommitmentHex",
  );
  const receiptHashBytes = commitmentHash(
    value["receiptHashHex"],
    "lifecycleAttempt.receiptHashHex",
  );
  if (typeof value["revision"] !== "bigint" || value["revision"] < 1n || value["revision"] > MAX_SAFE_REVISION) {
    throw new Error("Stored attempt revision is invalid.");
  }
  if (
    typeof value["observedAtUnixMilliseconds"] !== "bigint" ||
    value["observedAtUnixMilliseconds"] <= 0n ||
    value["observedAtUnixMilliseconds"] > MAX_SAFE_REVISION
  ) {
    throw new Error("Stored attempt timestamp is invalid.");
  }
  if (typeof value["state"] !== "string") {
    throw new Error("Stored attempt state is invalid.");
  }
  enumDiscriminant(PACKAGE_LIFECYCLE_STATE, value["state"] as never, "lifecycleAttempt.state");
  const packageCommitmentHex = toHex(packageCommitmentBytes);
  const receiptHashHex = toHex(receiptHashBytes);
  const revisionText = (value["revision"] as bigint).toString(10);
  const observedText = (value["observedAtUnixMilliseconds"] as bigint).toString(10);
  for (const text of [attemptId, packageId, packageCommitmentHex, revisionText, value["state"] as string, receiptHashHex, eventId, observedText]) {
    assertAscii(text, "lifecycleAttempt");
  }
  const dto: LifecycleAttemptDto = Object.freeze({
    attemptId,
    packageId,
    packageCommitmentHex,
    revision: revisionText,
    state: value["state"] as string,
    receiptHashHex,
    eventId,
    observedAtUnixMilliseconds: observedText,
  });
  return Object.freeze({
    dto,
    revision: value["revision"] as bigint,
    packageId,
    packageCommitmentHex,
  });
}

function validateReceipt(value: unknown, expectedAttemptId: string): {
  dto: LifecycleReceiptDto;
  checked: PackageLifecycleReceipt;
} {
  const checked: PackageLifecycleReceipt = packageLifecycleReceipt(
    value as unknown as Parameters<typeof packageLifecycleReceipt>[0],
    "lifecycleReceipt",
  );
  if (checked.attemptId !== expectedAttemptId) {
    throw new Error("Stored receipt attempt does not match.");
  }
  const receiptHash = packageLifecycleReceiptHash(checked);
  const expectedRevision = checked.revision - 1n;
  const intentCommitment = packageLifecycleEventIntentCommitment({
    version: 1,
    domain: checked.domain,
    settlementClass: checked.settlementClass,
    packageId: checked.packageId,
    packageCommitment: checked.packageCommitment,
    attemptId: checked.attemptId,
    eventId: checked.eventId,
    expectedRevision,
    nextState: checked.nextState,
    evidenceGrade: checked.evidenceGrade,
    onchainEnforced: checked.onchainEnforced,
    evidenceSource: checked.evidenceSource,
    evidenceCommitment: checked.evidenceCommitment,
  });
  const domainManifestHashHex = toHex(checked.domain.domainManifestHash);
  const packageCommitmentHex = toHex(checked.packageCommitment);
  const evidenceSourceHashHex = toHex(checked.evidenceSource.manifestHash);
  const evidenceCommitmentHex = toHex(checked.evidenceCommitment);
  const intentCommitmentHex = toHex(intentCommitment);
  const receiptHashHex = toHex(receiptHash);
  const revisionText = checked.revision.toString(10);
  const observedText = checked.observedAtUnixMilliseconds.toString(10);
  const base: Record<string, unknown> = {
    version: checked.version,
    domain: Object.freeze({
      domainId: checked.domain.domainId,
      domainManifestVersion: checked.domain.domainManifestVersion,
      domainManifestHashHex,
    }),
    settlementClass: checked.settlementClass,
    packageId: checked.packageId,
    packageCommitmentHex,
    attemptId: checked.attemptId,
    eventId: checked.eventId,
    revision: revisionText,
    nextState: checked.nextState,
    observedAtUnixMilliseconds: observedText,
    evidenceGrade: checked.evidenceGrade,
    onchainEnforced: checked.onchainEnforced,
    evidenceSource: Object.freeze({
      subjectId: checked.evidenceSource.subjectId,
      manifestVersion: checked.evidenceSource.manifestVersion,
      manifestHashHex: evidenceSourceHashHex,
    }),
    evidenceCommitmentHex,
    intentCommitmentHex,
    receiptHashHex,
  };
  if (checked.priorState !== undefined) {
    base["priorState"] = checked.priorState;
  }
  if (checked.previousReceiptHash !== undefined) {
    base["previousReceiptHashHex"] = toHex(checked.previousReceiptHash);
  }
  for (const text of [
    checked.domain.domainId,
    domainManifestHashHex,
    checked.settlementClass,
    checked.packageId,
    packageCommitmentHex,
    checked.attemptId,
    checked.eventId,
    revisionText,
    checked.nextState,
    observedText,
    checked.evidenceGrade,
    checked.evidenceSource.subjectId,
    evidenceSourceHashHex,
    evidenceCommitmentHex,
    intentCommitmentHex,
    receiptHashHex,
  ]) {
    assertAscii(text, "lifecycleReceipt");
  }
  if (checked.priorState !== undefined) {
    assertAscii(checked.priorState, "lifecycleReceipt.priorState");
  }
  if (base["previousReceiptHashHex"] !== undefined) {
    assertAscii(base["previousReceiptHashHex"] as string, "lifecycleReceipt.previousReceiptHash");
  }
  if (typeof checked.domain.domainManifestVersion !== "number" ||
      !Number.isSafeInteger(checked.domain.domainManifestVersion) ||
      typeof checked.evidenceSource.manifestVersion !== "number" ||
      !Number.isSafeInteger(checked.evidenceSource.manifestVersion)) {
    throw new Error("Stored receipt version is invalid.");
  }
  return {
    dto: Object.freeze(base) as LifecycleReceiptDto,
    checked,
  };
}

export function serializeLifecycleResponse(
  attempt: unknown,
  receipts: unknown,
  query: LifecycleReadQuery,
  anchorPage?: unknown,
): LifecycleReadResponse {
  const validated = validateAttempt(attempt as PackageLifecycleAttempt);
  if (validated.dto.attemptId !== query.attemptId) {
    throw new Error("Stored attempt does not match the requested attempt.");
  }
  if (!Array.isArray(receipts)) {
    throw new Error("Stored receipts are not an array.");
  }
  if (receipts.length > query.limit) {
    throw new Error("Stored receipts exceed the requested limit.");
  }
  const headRevision = validated.revision;
  if (query.afterRevision >= headRevision) {
    if (receipts.length !== 0) {
      throw new Error("Stored receipts must be empty at or above the attempt head.");
    }
    return Object.freeze({ attempt: validated.dto, receipts: Object.freeze([]) });
  }
  if (receipts.length === 0) {
    throw new Error("Stored receipts must not be empty below the attempt head.");
  }
  const dtos: LifecycleReceiptDto[] = [];
  const checkedList: PackageLifecycleReceipt[] = [];
  for (const entry of receipts) {
    const validatedReceipt = validateReceipt(entry as PackageLifecycleReceipt, query.attemptId);
    const revision = validatedReceipt.checked.revision;
    if (revision <= query.afterRevision) {
      throw new Error("Stored receipt revision does not satisfy the cursor.");
    }
    if (revision > headRevision) {
      throw new Error("Stored receipt revision exceeds the attempt head.");
    }
    if (validatedReceipt.dto.packageId !== validated.packageId ||
        validatedReceipt.dto.packageCommitmentHex !== validated.packageCommitmentHex) {
      throw new Error("Stored receipt package binding does not match the attempt.");
    }
    checkedList.push(validatedReceipt.checked);
    dtos.push(validatedReceipt.dto);
  }
  const first = checkedList[0] as PackageLifecycleReceipt;
  if (first.revision !== query.afterRevision + 1n) {
    throw new Error("Stored receipts are not a contiguous segment of the receipt chain.");
  }
  if (query.afterRevision === 0n) {
    if (first.revision !== 1n) {
      throw new Error("Stored receipts must start at revision 1.");
    }
    if (first.priorState !== undefined || first.previousReceiptHash !== undefined) {
      throw new Error("Initial receipt must not carry chain linkage.");
    }
  } else {
    if (!Array.isArray(anchorPage) || anchorPage.length !== 1) {
      throw new Error("Stored cursor anchor is missing or malformed.");
    }
    const anchor = validateReceipt(
      anchorPage[0] as PackageLifecycleReceipt,
      query.attemptId,
    );
    if (anchor.checked.revision !== query.afterRevision) {
      throw new Error("Stored cursor anchor does not match the requested cursor.");
    }
    if (anchor.dto.packageId !== validated.packageId ||
        anchor.dto.packageCommitmentHex !== validated.packageCommitmentHex) {
      throw new Error("Stored cursor anchor package binding does not match the attempt.");
    }
    if (first.priorState !== anchor.checked.nextState) {
      throw new Error("Stored receipt prior state does not match the cursor anchor.");
    }
    if (first.previousReceiptHash === undefined) {
      throw new Error("Stored receipt is missing its hash link.");
    }
    if (toHex(first.previousReceiptHash) !== toHex(packageLifecycleReceiptHash(anchor.checked))) {
      throw new Error("Stored receipt hash link does not match the cursor anchor.");
    }
  }
  for (let index = 1; index < checkedList.length; index += 1) {
    const previous = checkedList[index - 1] as PackageLifecycleReceipt;
    const current = checkedList[index] as PackageLifecycleReceipt;
    if (current.revision !== previous.revision + 1n) {
      throw new Error("Stored receipts are not a contiguous segment of the receipt chain.");
    }
    if (current.priorState !== previous.nextState) {
      throw new Error("Stored receipt prior state does not match the preceding receipt.");
    }
    if (current.previousReceiptHash === undefined) {
      throw new Error("Stored receipt is missing its hash link.");
    }
    if (toHex(current.previousReceiptHash) !== toHex(packageLifecycleReceiptHash(previous))) {
      throw new Error("Stored receipt hash link does not match the preceding receipt.");
    }
  }
  const lastDto = dtos[dtos.length - 1] as LifecycleReceiptDto;
  const lastChecked = checkedList[checkedList.length - 1] as PackageLifecycleReceipt;
  if (lastChecked.revision === headRevision) {
    if (lastDto.eventId !== validated.dto.eventId ||
        lastDto.nextState !== validated.dto.state ||
        lastDto.receiptHashHex !== validated.dto.receiptHashHex ||
        lastDto.packageId !== validated.dto.packageId ||
        lastDto.packageCommitmentHex !== validated.dto.packageCommitmentHex ||
        lastDto.revision !== validated.dto.revision ||
        lastDto.observedAtUnixMilliseconds !== validated.dto.observedAtUnixMilliseconds) {
      throw new Error("Stored head receipt does not match the attempt head.");
    }
  }
  return Object.freeze({ attempt: validated.dto, receipts: Object.freeze(dtos) });
}
