import {
  COORDINATOR_STATE_LABELS,
  EVM_RUNTIME_IDENTITY,
  VENUE_STATUS_LABELS,
  chainReference as assertEvmChainReference,
  compileEvmAtomicPackage,
  equalAddress as equalEvmAddress,
  equalHash as equalEvmHash,
  hash32 as assertEvmHash32,
  observeAsyncBondedPackage,
  observeEvmAtomicPackage,
  prepareEvmTraderPermitAuthorization,
  requiredEvmAddress as assertEvmAddress,
  validateFinalityPolicy,
} from "@naryx/adapter-evm";
import type {
  EvmAsyncObservationBinding,
  EvmAsyncObservationKeys,
  EvmAtomicExecutionBounds,
  EvmAtomicObservationBinding,
  EvmDeploymentIdentity,
  EvmFinalityPolicy,
  EvmReadPort,
} from "@naryx/adapter-evm";
import { bytesEqual, domainManifest, domainRefFromManifest } from "@naryx/protocol-types";
import type {
  CashCarrySeriesBindingV1Input,
  DomainManifest,
  DomainRef,
  PackageAdmission,
} from "@naryx/protocol-types";
import {
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

export const EVM_TESTNET_ENVIRONMENT = "TESTNET" as const;
export const BASE_SEPOLIA_DOMAIN_ID = "evm:base-sepolia" as const;
export const BASE_SEPOLIA_CHAIN_REFERENCE = "84532" as const;

const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/;
const HASH_0X_PATTERN = /^0x[0-9a-f]{64}$/;
const CHAIN_REFERENCE_PATTERN = /^[1-9][0-9]*$/;
const REASON_MAX_LENGTH = 300;

const PREPARE_KEYS = ["attemptId", "idempotencyKey", "traderSignature"] as const;
const PREPARE_AUTHORIZATION_KEYS = ["attemptId", "idempotencyKey"] as const;
const OBSERVE_ATOMIC_KEYS = ["attemptId", "idempotencyKey", "transactionHash"] as const;
const OBSERVE_ASYNC_KEYS = ["attemptId", "idempotencyKey"] as const;

const ATOMIC_LIFECYCLES = [
  "NOT_FOUND",
  "SUBMITTED",
  "REVERTED",
  "CONFIRMED",
  "FINALIZED",
  "EVIDENCE_MISMATCH",
] as const;
const ASYNC_LIFECYCLES = [
  "NOT_FOUND",
  "RESERVED",
  "REQUEST_SUBMITTED",
  "VENUE_PENDING",
  "EXECUTED",
  "CANCELLED",
  "FROZEN",
  "RECOVERY_PENDING",
  "RECOVERED",
  "MANUAL_INTERVENTION",
  "CLOSED",
  "CONFLICT",
  "EVIDENCE_MISMATCH",
] as const;
const EVIDENCE_GRADES = [
  "none",
  "transaction-receipt",
  "contract-state",
  "authenticated-callback-record",
  "finalized-contract-receipt",
] as const;

export type EvmTestnetPrepareAtomicRequest = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  traderSignature: string;
}>;

export type EvmTestnetPrepareAtomicAuthorizationRequest = Readonly<{
  attemptId: string;
  idempotencyKey: string;
}>;

export type EvmTestnetAtomicAuthorizationDto = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  domainId: typeof BASE_SEPOLIA_DOMAIN_ID;
  domainManifestVersion: number;
  domainManifestHash: string;
  environment: typeof EVM_TESTNET_ENVIRONMENT;
  chainReference: typeof BASE_SEPOLIA_CHAIN_REFERENCE;
  typedData: Readonly<{
    domain: Readonly<{
      name: "Naryx Package Verifier";
      version: "1";
      chainId: typeof BASE_SEPOLIA_CHAIN_REFERENCE;
      verifyingContract: string;
    }>;
    types: Readonly<{
      EIP712Domain: readonly Readonly<{ name: string; type: string }>[];
      TraderPermit: readonly Readonly<{ name: string; type: string }>[];
    }>;
    primaryType: "TraderPermit";
    message: Readonly<{
      packageHash: string;
      accountsHash: string;
      limitsHash: string;
      nonce: string;
      deadline: string;
    }>;
  }>;
  digest: string;
  requestCommitment: string;
}>;

export type EvmTestnetObserveAtomicRequest = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  transactionHash: string;
}>;

export type EvmTestnetObserveAsyncRequest = Readonly<{
  attemptId: string;
  idempotencyKey: string;
}>;

export type EvmTestnetAtomicPreparationDto = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  domainId: string;
  domainManifestVersion: number;
  domainManifestHash: string;
  environment: typeof EVM_TESTNET_ENVIRONMENT;
  chainReference: string;
  to: string;
  value: "0";
  data: string;
  orderHash: string;
  quoteHash: string;
  routeHash: string;
  requestCommitment: string;
}>;

export type EvmTestnetAtomicPackageReceiptDto = Readonly<{
  receiptHash: string;
  domainIdHash: string;
  domainManifestVersion: number;
  domainManifestHash: string;
  orderHash: string;
  quoteHash: string;
  routeHash: string;
  spotFillCommitment: string;
  seriesIdentityKey: string;
  seriesBindingVersion: number;
  seriesBindingHash: string;
  action: number;
  strategyAccount: string;
  solver: string;
  recovery: boolean;
  baseQuantityAtoms: string;
  spotQuoteAtoms: string;
  packageSizeUnits: string;
  nonce: string;
}>;

export type EvmTestnetAtomicOpenPackageDto = Readonly<{
  entryReceiptHash: string;
  routeHash: string;
  baseQuantityAtoms: string;
  packageSizeUnits: string;
}>;

export type EvmTestnetAtomicObservationDto = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  environment: typeof EVM_TESTNET_ENVIRONMENT;
  domainId: string;
  domainManifestVersion: number;
  domainManifestHash: string;
  chainReference: string;
  transactionHash: string;
  lifecycle: (typeof ATOMIC_LIFECYCLES)[number];
  evidenceGrade: (typeof EVIDENCE_GRADES)[number];
  blockNumber: string | null;
  confirmations: number | null;
  receiptHash: string | null;
  packageReceipt: EvmTestnetAtomicPackageReceiptDto | null;
  openPackage: EvmTestnetAtomicOpenPackageDto | null;
  reason: string | null;
}>;

export type EvmTestnetAsyncCoordinatorDto = Readonly<{
  state: (typeof COORDINATOR_STATE_LABELS)[number];
  stateVersion: number;
  requestKey: string;
  outcomeEvidenceHash: string;
  recoveryEvidenceHash: string;
  hasVenueOutcome: boolean;
  lastVenueOutcome: number;
  recoveryDutyActive: boolean;
  recoveryActionSubmitted: boolean;
  recoveryProven: boolean;
  bondSlashed: boolean;
  evidenceConflict: boolean;
}>;

export type EvmTestnetAsyncEntryDto = Readonly<{
  status: (typeof VENUE_STATUS_LABELS)[number];
  evidenceHash: string;
  positionSizeBefore: string;
  positionSizeAfter: string;
  revision: number;
}>;

export type EvmTestnetAsyncExitDto = Readonly<{
  status: (typeof VENUE_STATUS_LABELS)[number];
  evidenceHash: string;
  revision: number;
  reconciling: boolean;
  released: boolean;
}>;

export type EvmTestnetAsyncFinalReceiptDto = Readonly<{
  commitment: string;
  packageId: string;
  entryRequestKey: string;
  exitRequestKey: string;
  recipient: string;
  fullCloseSizeUsd: string;
  spotBaseAtoms: string;
  spotQuoteAtoms: string;
  perpStatus: number;
  terminalState: number;
}>;

export type EvmTestnetAsyncObservationDto = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  environment: typeof EVM_TESTNET_ENVIRONMENT;
  domainId: string;
  domainManifestVersion: number;
  domainManifestHash: string;
  chainReference: string;
  packageId: string;
  lifecycle: (typeof ASYNC_LIFECYCLES)[number];
  evidenceGrade: (typeof EVIDENCE_GRADES)[number];
  coordinator: EvmTestnetAsyncCoordinatorDto | null;
  entry: EvmTestnetAsyncEntryDto | null;
  exit: EvmTestnetAsyncExitDto | null;
  finalReceipt: EvmTestnetAsyncFinalReceiptDto | null;
  exitCompleted: boolean;
  reason: string | null;
}>;

export interface EvmTestnetAtomicPreparationPort {
  prepare(request: EvmTestnetPrepareAtomicRequest): Promise<EvmTestnetAtomicPreparationDto>;
}

export interface EvmTestnetAtomicAuthorizationPort {
  prepare(request: EvmTestnetPrepareAtomicAuthorizationRequest): Promise<EvmTestnetAtomicAuthorizationDto>;
}

export interface EvmTestnetAtomicObservationPort {
  observe(request: EvmTestnetObserveAtomicRequest): Promise<EvmTestnetAtomicObservationDto>;
}

export interface EvmTestnetAsyncObservationPort {
  observe(request: EvmTestnetObserveAsyncRequest): Promise<EvmTestnetAsyncObservationDto>;
}

export type EvmTestnetTerminalPorts = Readonly<{
  authorization?: EvmTestnetAtomicAuthorizationPort;
  preparation?: EvmTestnetAtomicPreparationPort;
  atomicObservation?: EvmTestnetAtomicObservationPort;
  asyncObservation?: EvmTestnetAsyncObservationPort;
}>;

export type EvmTestnetAtomicAttemptContext = Readonly<{
  admission: PackageAdmission;
  deployment: EvmDeploymentIdentity;
  seriesBindingInput: CashCarrySeriesBindingV1Input;
  bounds: Omit<EvmAtomicExecutionBounds, "traderSignature">;
  atomicBinding: EvmAtomicObservationBinding;
  finality: EvmFinalityPolicy;
}>;

export type EvmTestnetAsyncAttemptContext = Readonly<{
  domainManifest: DomainManifest;
  binding: EvmAsyncObservationBinding;
  keys: EvmAsyncObservationKeys;
  requirements?: Readonly<{
    settlementClass: "ASYNC_BONDED_SOLVER";
    executionPlanKind: "EVM_ASYNC_REQUEST";
    seriesIdentityKey: Hex;
    seriesBindingVersion: number;
    seriesBindingHash: Hex;
    maximumRouteExpiryValue: bigint;
    maximumRecoveryDeadlineValue: bigint;
    maximumPackageQuantityAtoms: bigint;
    finality: EvmFinalityPolicy;
    evidenceProfileId: string;
    stateReferenceSchemaHash: Hex;
    receiptSchemaHash: Hex;
    outcomeSchemaHash: Hex;
  }>;
}>;

export type EvmTestnetAtomicContextProvider = (
  attemptId: string,
) => Promise<EvmTestnetAtomicAttemptContext> | EvmTestnetAtomicAttemptContext;

export type EvmTestnetAsyncContextProvider = (
  attemptId: string,
) => Promise<EvmTestnetAsyncAttemptContext> | EvmTestnetAsyncAttemptContext;

export type PreparedEvmTestnetAtomicRecord = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  traderSignature: string;
  preparation: EvmTestnetAtomicPreparationDto;
  boundTransactionHash: string | undefined;
}>;

export interface PreparedEvmTestnetAtomicStore {
  get(idempotencyKey: string): PreparedEvmTestnetAtomicRecord | undefined;
  save(
    attemptId: string,
    idempotencyKey: string,
    traderSignature: string,
    preparation: EvmTestnetAtomicPreparationDto,
  ): PreparedEvmTestnetAtomicRecord;
  bindTransactionHash(idempotencyKey: string, transactionHash: string): PreparedEvmTestnetAtomicRecord;
}

export type EvmTestnetRuntimePortsOptions = Readonly<{
  atomicContextProvider: EvmTestnetAtomicContextProvider;
  asyncContextProvider: EvmTestnetAsyncContextProvider;
  atomicReadPort: EvmReadPort;
  asyncReadPort: EvmReadPort;
  store: PreparedEvmTestnetAtomicStore;
}>;

export type EvmTestnetAsyncObservationPortOptions = Readonly<{
  contextProvider: EvmTestnetAsyncContextProvider;
  readPort: EvmReadPort;
}>;

export class EvmTestnetTerminalValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EvmTestnetTerminalValidationError";
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
    throw new EvmTestnetTerminalValidationError(
      "INVALID_EVM_ID",
      `${name} must use 16 to 64 URL-safe characters.`,
    );
  }
  return value;
}

function requireTraderSignature(value: unknown): string {
  if (typeof value !== "string" || !SIGNATURE_PATTERN.test(value)) {
    throw new EvmTestnetTerminalValidationError(
      "INVALID_EVM_SIGNATURE",
      "traderSignature must be canonical 65-byte 0x hex.",
    );
  }
  return value.toLowerCase();
}

function requireTransactionHash(value: unknown): string {
  if (typeof value !== "string" || !HASH_0X_PATTERN.test(value) || /^0x0+$/.test(value)) {
    throw new EvmTestnetTerminalValidationError(
      "INVALID_EVM_TRANSACTION_HASH",
      "transactionHash must be a nonzero lowercase 0x 32-byte hash.",
    );
  }
  return value;
}

export function parseEvmTestnetPrepareAtomicRequest(value: unknown): EvmTestnetPrepareAtomicRequest {
  if (!isRecord(value)) {
    throw new EvmTestnetTerminalValidationError("INVALID_EVM_BODY", "Request body must be a JSON object.");
  }
  if (!hasExactKeys(value, [...PREPARE_KEYS].sort())) {
    throw new EvmTestnetTerminalValidationError(
      "INVALID_EVM_FIELDS",
      "Request must contain only attemptId, idempotencyKey, and traderSignature.",
    );
  }
  return Object.freeze({
    attemptId: requireBrowserId(value.attemptId, "attemptId"),
    idempotencyKey: requireBrowserId(value.idempotencyKey, "idempotencyKey"),
    traderSignature: requireTraderSignature(value.traderSignature),
  });
}

export function parseEvmTestnetPrepareAtomicAuthorizationRequest(
  value: unknown,
): EvmTestnetPrepareAtomicAuthorizationRequest {
  if (!isRecord(value)) {
    throw new EvmTestnetTerminalValidationError("INVALID_EVM_BODY", "Request body must be a JSON object.");
  }
  if (!hasExactKeys(value, [...PREPARE_AUTHORIZATION_KEYS].sort())) {
    throw new EvmTestnetTerminalValidationError(
      "INVALID_EVM_FIELDS",
      "Request must contain only attemptId and idempotencyKey.",
    );
  }
  return Object.freeze({
    attemptId: requireBrowserId(value.attemptId, "attemptId"),
    idempotencyKey: requireBrowserId(value.idempotencyKey, "idempotencyKey"),
  });
}

export function parseEvmTestnetObserveAtomicRequest(value: unknown): EvmTestnetObserveAtomicRequest {
  if (!isRecord(value)) {
    throw new EvmTestnetTerminalValidationError("INVALID_EVM_BODY", "Request body must be a JSON object.");
  }
  if (!hasExactKeys(value, [...OBSERVE_ATOMIC_KEYS].sort())) {
    throw new EvmTestnetTerminalValidationError(
      "INVALID_EVM_FIELDS",
      "Request must contain only attemptId, idempotencyKey, and transactionHash.",
    );
  }
  return Object.freeze({
    attemptId: requireBrowserId(value.attemptId, "attemptId"),
    idempotencyKey: requireBrowserId(value.idempotencyKey, "idempotencyKey"),
    transactionHash: requireTransactionHash(value.transactionHash),
  });
}

export function parseEvmTestnetObserveAsyncRequest(value: unknown): EvmTestnetObserveAsyncRequest {
  if (!isRecord(value)) {
    throw new EvmTestnetTerminalValidationError("INVALID_EVM_BODY", "Request body must be a JSON object.");
  }
  if (!hasExactKeys(value, [...OBSERVE_ASYNC_KEYS].sort())) {
    throw new EvmTestnetTerminalValidationError(
      "INVALID_EVM_FIELDS",
      "Request must contain only attemptId and idempotencyKey.",
    );
  }
  return Object.freeze({
    attemptId: requireBrowserId(value.attemptId, "attemptId"),
    idempotencyKey: requireBrowserId(value.idempotencyKey, "idempotencyKey"),
  });
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new Error("Idempotency key must use 16 to 64 URL-safe characters.");
  }
  return value;
}

function requireCommitment(value: unknown, name: string): string {
  if (typeof value !== "string" || !HASH_0X_PATTERN.test(value) || /^0x0+$/.test(value)) {
    throw new Error(`${name} must be a nonzero lowercase 0x 32-byte hash.`);
  }
  return value;
}

function requireHashAllowingZero(value: unknown, name: string): string {
  if (typeof value !== "string" || !HASH_0X_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase 0x 32-byte hash.`);
  }
  return value;
}

function requireAddress(value: unknown, name: string): string {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new Error(`${name} must be an EVM address.`);
  }
  const checked = getAddress(value);
  if (checked === "0x0000000000000000000000000000000000000000") {
    throw new Error(`${name} must be nonzero.`);
  }
  return checked;
}

function requireData(value: unknown): string {
  if (typeof value !== "string" || value.length < 4 || !/^0x[0-9a-f]+$/.test(value)) {
    throw new Error("data must be nonempty even-length canonical 0x hex.");
  }
  const body = value.slice(2);
  if (body.length === 0 || body.length % 2 !== 0) {
    throw new Error("data must be nonempty even-length canonical 0x hex.");
  }
  return value.toLowerCase();
}

function requireChainReference(value: unknown): string {
  if (typeof value !== "string" || !CHAIN_REFERENCE_PATTERN.test(value)) {
    throw new Error("chainReference must be a positive decimal EIP-155 chain ID.");
  }
  return value;
}

function requireDecimalString(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value) || value.length === 0) {
    throw new Error(`${name} must be a canonical decimal string.`);
  }
  if (value.length > 1 && value.startsWith("0")) {
    throw new Error(`${name} must be canonical without leading zeros.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function requireNonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer.`);
  }
  return value;
}

function requireReason(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > REASON_MAX_LENGTH) {
    throw new Error("reason must be null or a bounded string.");
  }
  return value;
}

function toHex0x(value: Uint8Array, name: string): string {
  if (!(value instanceof Uint8Array) || value.length !== 32 || value.every((byte) => byte === 0)) {
    throw new Error(`${name} must be 32 nonzero bytes.`);
  }
  return `0x${Buffer.from(value).toString("hex")}`;
}

function asDomainRef(value: unknown, name: string): DomainRef {
  if (!isRecord(value)) throw new Error(`${name} must be an object.`);
  if (typeof value.domainId !== "string" || value.domainId.length === 0) {
    throw new Error(`${name} domain id is invalid.`);
  }
  if (
    typeof value.domainManifestVersion !== "number" ||
    !Number.isSafeInteger(value.domainManifestVersion) ||
    value.domainManifestVersion <= 0
  ) {
    throw new Error(`${name} manifest version must be a positive integer.`);
  }
  const hash = value.domainManifestHash;
  if (!(hash instanceof Uint8Array) || hash.length !== 32 || hash.every((byte) => byte === 0)) {
    throw new Error(`${name} manifest hash must be 32 nonzero bytes.`);
  }
  return value as unknown as DomainRef;
}

function requireSameDomain(left: DomainRef, right: DomainRef, name: string): void {
  if (
    left.domainId !== right.domainId ||
    left.domainManifestVersion !== right.domainManifestVersion ||
    !bytesEqual(left.domainManifestHash, right.domainManifestHash)
  ) {
    throw new Error(`${name} domain mismatch.`);
  }
}

function computeRequestCommitment(args: Readonly<{
  attemptId: string;
  idempotencyKey: string;
  traderSignature: string;
  domainId: string;
  domainManifestVersion: number;
  domainManifestHash: string;
  chainReference: string;
  to: string;
  data: string;
  orderHash: string;
  quoteHash: string;
  routeHash: string;
}>): string {
  const encoded = encodeAbiParameters(
    [
      { type: "string" },
      { type: "string" },
      { type: "bytes" },
      { type: "string" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "address" },
      { type: "uint256" },
      { type: "bytes" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      args.attemptId,
      args.idempotencyKey,
      args.traderSignature as Hex,
      args.domainId,
      BigInt(args.domainManifestVersion),
      args.domainManifestHash as Hex,
      BigInt(args.chainReference),
      args.to as Address,
      0n,
      args.data as Hex,
      args.orderHash as Hex,
      args.quoteHash as Hex,
      args.routeHash as Hex,
    ],
  );
  const commitment = keccak256(encoded);
  if (/^0x0+$/.test(commitment)) throw new Error("requestCommitment must be nonzero.");
  return commitment;
}

const EIP712_DOMAIN_FIELDS = Object.freeze([
  Object.freeze({ name: "name", type: "string" }),
  Object.freeze({ name: "version", type: "string" }),
  Object.freeze({ name: "chainId", type: "uint256" }),
  Object.freeze({ name: "verifyingContract", type: "address" }),
]);
const TRADER_PERMIT_FIELDS = Object.freeze([
  Object.freeze({ name: "packageHash", type: "bytes32" }),
  Object.freeze({ name: "accountsHash", type: "bytes32" }),
  Object.freeze({ name: "limitsHash", type: "bytes32" }),
  Object.freeze({ name: "nonce", type: "uint256" }),
  Object.freeze({ name: "deadline", type: "uint256" }),
]);

function computeAuthorizationRequestCommitment(args: Readonly<{
  request: EvmTestnetPrepareAtomicAuthorizationRequest;
  domainManifestVersion: number;
  domainManifestHash: string;
  verifyingContract: string;
  digest: string;
}>): string {
  return keccak256(encodeAbiParameters(
    [
      { type: "string" }, { type: "string" }, { type: "string" }, { type: "uint32" },
      { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" },
    ],
    [
      args.request.attemptId,
      args.request.idempotencyKey,
      BASE_SEPOLIA_DOMAIN_ID,
      args.domainManifestVersion,
      args.domainManifestHash as Hex,
      BigInt(BASE_SEPOLIA_CHAIN_REFERENCE),
      args.verifyingContract as Address,
      args.digest as Hex,
    ],
  ));
}

export function validateEvmTestnetAtomicAuthorization(
  value: unknown,
  request: EvmTestnetPrepareAtomicAuthorizationRequest,
): EvmTestnetAtomicAuthorizationDto {
  const keys = [
    "attemptId", "chainReference", "digest", "domainId", "domainManifestHash",
    "domainManifestVersion", "environment", "idempotencyKey", "requestCommitment", "typedData",
  ].sort();
  if (!isRecord(value) || !hasExactKeys(value, keys) || !isRecord(value.typedData)) {
    throw new Error("EVM atomic authorization has invalid fields.");
  }
  if (value.attemptId !== request.attemptId || value.idempotencyKey !== request.idempotencyKey) {
    throw new Error("EVM atomic authorization identity does not match the request.");
  }
  if (value.environment !== EVM_TESTNET_ENVIRONMENT || value.domainId !== BASE_SEPOLIA_DOMAIN_ID ||
      value.chainReference !== BASE_SEPOLIA_CHAIN_REFERENCE) {
    throw new Error("EVM atomic authorization is not bound to Base Sepolia testnet.");
  }
  const domainManifestVersion = requirePositiveInteger(value.domainManifestVersion, "domainManifestVersion");
  const domainManifestHash = requireCommitment(value.domainManifestHash, "domainManifestHash");
  const typedData = value.typedData;
  if (!hasExactKeys(typedData, ["domain", "message", "primaryType", "types"]) ||
      !isRecord(typedData.domain) || !isRecord(typedData.message) || !isRecord(typedData.types)) {
    throw new Error("EVM trader permit typed data has invalid fields.");
  }
  if (!hasExactKeys(typedData.domain, ["chainId", "name", "verifyingContract", "version"]) ||
      typedData.domain.name !== "Naryx Package Verifier" || typedData.domain.version !== "1" ||
      typedData.domain.chainId !== BASE_SEPOLIA_CHAIN_REFERENCE || typedData.primaryType !== "TraderPermit") {
    throw new Error("EVM trader permit domain is invalid.");
  }
  const verifyingContract = requireAddress(typedData.domain.verifyingContract, "typedData.domain.verifyingContract");
  if (!hasExactKeys(typedData.types, ["EIP712Domain", "TraderPermit"]) ||
      JSON.stringify(typedData.types.EIP712Domain) !== JSON.stringify(EIP712_DOMAIN_FIELDS) ||
      JSON.stringify(typedData.types.TraderPermit) !== JSON.stringify(TRADER_PERMIT_FIELDS)) {
    throw new Error("EVM trader permit types are invalid.");
  }
  if (!hasExactKeys(typedData.message, ["accountsHash", "deadline", "limitsHash", "nonce", "packageHash"])) {
    throw new Error("EVM trader permit message has invalid fields.");
  }
  const message = Object.freeze({
    packageHash: requireCommitment(typedData.message.packageHash, "typedData.message.packageHash"),
    accountsHash: requireCommitment(typedData.message.accountsHash, "typedData.message.accountsHash"),
    limitsHash: requireCommitment(typedData.message.limitsHash, "typedData.message.limitsHash"),
    nonce: requireDecimalString(typedData.message.nonce, "typedData.message.nonce"),
    deadline: requireDecimalString(typedData.message.deadline, "typedData.message.deadline"),
  });
  const domain = Object.freeze({
    name: "Naryx Package Verifier" as const,
    version: "1" as const,
    chainId: BASE_SEPOLIA_CHAIN_REFERENCE,
    verifyingContract,
  });
  const digest = requireCommitment(value.digest, "digest");
  const expectedDigest = hashTypedData({
    domain: { ...domain, chainId: BigInt(domain.chainId), verifyingContract: verifyingContract as Address },
    types: { TraderPermit: TRADER_PERMIT_FIELDS },
    primaryType: "TraderPermit",
    message: {
      packageHash: message.packageHash as Hex,
      accountsHash: message.accountsHash as Hex,
      limitsHash: message.limitsHash as Hex,
      nonce: BigInt(message.nonce),
      deadline: BigInt(message.deadline),
    },
  });
  if (digest !== expectedDigest) throw new Error("EVM trader permit digest does not match its typed data.");
  const requestCommitment = requireCommitment(value.requestCommitment, "requestCommitment");
  const expectedCommitment = computeAuthorizationRequestCommitment({
    request,
    domainManifestVersion,
    domainManifestHash,
    verifyingContract,
    digest,
  });
  if (requestCommitment !== expectedCommitment) {
    throw new Error("EVM atomic authorization commitment does not bind the request.");
  }
  return Object.freeze({
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    domainId: BASE_SEPOLIA_DOMAIN_ID,
    domainManifestVersion,
    domainManifestHash,
    environment: EVM_TESTNET_ENVIRONMENT,
    chainReference: BASE_SEPOLIA_CHAIN_REFERENCE,
    typedData: Object.freeze({
      domain,
      types: Object.freeze({ EIP712Domain: EIP712_DOMAIN_FIELDS, TraderPermit: TRADER_PERMIT_FIELDS }),
      primaryType: "TraderPermit" as const,
      message,
    }),
    digest,
    requestCommitment,
  });
}

const PREPARATION_KEYS = [
  "attemptId",
  "chainReference",
  "data",
  "domainId",
  "domainManifestHash",
  "domainManifestVersion",
  "environment",
  "idempotencyKey",
  "orderHash",
  "quoteHash",
  "requestCommitment",
  "routeHash",
  "to",
  "value",
].sort();

export function validateEvmTestnetAtomicPreparation(
  value: unknown,
  request: EvmTestnetPrepareAtomicRequest,
): EvmTestnetAtomicPreparationDto {
  if (!isRecord(value) || !hasExactKeys(value, PREPARATION_KEYS)) {
    throw new Error("EVM preparation has invalid fields.");
  }
  if (value.attemptId !== request.attemptId || value.idempotencyKey !== request.idempotencyKey) {
    throw new Error("EVM preparation identity does not match the request.");
  }
  if (value.environment !== EVM_TESTNET_ENVIRONMENT) {
    throw new Error("EVM preparation is not bound to TESTNET.");
  }
  if (typeof value.domainId !== "string" || value.domainId.length === 0) {
    throw new Error("EVM preparation domain id is invalid.");
  }
  const domainManifestVersion = requirePositiveInteger(value.domainManifestVersion, "domainManifestVersion");
  const domainManifestHash = requireCommitment(value.domainManifestHash, "domainManifestHash");
  const chainReference = requireChainReference(value.chainReference);
  const to = requireAddress(value.to, "to");
  if (value.value !== "0") throw new Error("EVM atomic value must be exactly 0.");
  const data = requireData(value.data);
  const orderHash = requireCommitment(value.orderHash, "orderHash");
  const quoteHash = requireCommitment(value.quoteHash, "quoteHash");
  const routeHash = requireCommitment(value.routeHash, "routeHash");
  const requestCommitment = requireCommitment(value.requestCommitment, "requestCommitment");
  const expected = computeRequestCommitment({
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    traderSignature: request.traderSignature,
    domainId: value.domainId as string,
    domainManifestVersion,
    domainManifestHash,
    chainReference,
    to,
    data,
    orderHash,
    quoteHash,
    routeHash,
  });
  if (expected.toLowerCase() !== (requestCommitment as string).toLowerCase()) {
    throw new Error("EVM preparation request commitment does not bind the request.");
  }
  return Object.freeze({
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    domainId: value.domainId as string,
    domainManifestVersion,
    domainManifestHash,
    environment: EVM_TESTNET_ENVIRONMENT,
    chainReference,
    to,
    value: "0" as const,
    data,
    orderHash,
    quoteHash,
    routeHash,
    requestCommitment,
  });
}

function validateAtomicReceipt(value: unknown): EvmTestnetAtomicPackageReceiptDto {
  const keys = [
    "action",
    "baseQuantityAtoms",
    "domainIdHash",
    "domainManifestHash",
    "domainManifestVersion",
    "nonce",
    "orderHash",
    "packageSizeUnits",
    "quoteHash",
    "receiptHash",
    "recovery",
    "routeHash",
    "seriesBindingHash",
    "seriesBindingVersion",
    "seriesIdentityKey",
    "solver",
    "spotFillCommitment",
    "spotQuoteAtoms",
    "strategyAccount",
  ].sort();
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error("package receipt has invalid fields.");
  return Object.freeze({
    receiptHash: requireCommitment(value.receiptHash, "receipt.receiptHash"),
    domainIdHash: requireCommitment(value.domainIdHash, "receipt.domainIdHash"),
    domainManifestVersion: requirePositiveInteger(value.domainManifestVersion, "receipt.domainManifestVersion"),
    domainManifestHash: requireCommitment(value.domainManifestHash, "receipt.domainManifestHash"),
    orderHash: requireCommitment(value.orderHash, "receipt.orderHash"),
    quoteHash: requireCommitment(value.quoteHash, "receipt.quoteHash"),
    routeHash: requireCommitment(value.routeHash, "receipt.routeHash"),
    spotFillCommitment: requireCommitment(value.spotFillCommitment, "receipt.spotFillCommitment"),
    seriesIdentityKey: requireCommitment(value.seriesIdentityKey, "receipt.seriesIdentityKey"),
    seriesBindingVersion: requirePositiveInteger(value.seriesBindingVersion, "receipt.seriesBindingVersion"),
    seriesBindingHash: requireCommitment(value.seriesBindingHash, "receipt.seriesBindingHash"),
    action: requireNonnegativeInteger(value.action, "receipt.action"),
    strategyAccount: requireAddress(value.strategyAccount, "receipt.strategyAccount"),
    solver: requireAddress(value.solver, "receipt.solver"),
    recovery: (() => {
      if (typeof value.recovery !== "boolean") throw new Error("receipt.recovery must be a boolean.");
      return value.recovery;
    })(),
    baseQuantityAtoms: requireDecimalString(value.baseQuantityAtoms, "receipt.baseQuantityAtoms"),
    spotQuoteAtoms: requireDecimalString(value.spotQuoteAtoms, "receipt.spotQuoteAtoms"),
    packageSizeUnits: requireDecimalString(value.packageSizeUnits, "receipt.packageSizeUnits"),
    nonce: requireDecimalString(value.nonce, "receipt.nonce"),
  });
}

function validateAtomicOpenPackage(value: unknown): EvmTestnetAtomicOpenPackageDto {
  const keys = ["baseQuantityAtoms", "entryReceiptHash", "packageSizeUnits", "routeHash"].sort();
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error("open package has invalid fields.");
  return Object.freeze({
    entryReceiptHash: requireCommitment(value.entryReceiptHash, "openPackage.entryReceiptHash"),
    routeHash: requireCommitment(value.routeHash, "openPackage.routeHash"),
    baseQuantityAtoms: requireDecimalString(value.baseQuantityAtoms, "openPackage.baseQuantityAtoms"),
    packageSizeUnits: requireDecimalString(value.packageSizeUnits, "openPackage.packageSizeUnits"),
  });
}

const ATOMIC_OBSERVATION_KEYS = [
  "attemptId",
  "blockNumber",
  "chainReference",
  "confirmations",
  "domainId",
  "domainManifestHash",
  "domainManifestVersion",
  "environment",
  "evidenceGrade",
  "idempotencyKey",
  "lifecycle",
  "openPackage",
  "packageReceipt",
  "reason",
  "receiptHash",
  "transactionHash",
].sort();

export function validateEvmTestnetAtomicObservation(
  value: unknown,
  request: EvmTestnetObserveAtomicRequest,
): EvmTestnetAtomicObservationDto {
  if (!isRecord(value) || !hasExactKeys(value, ATOMIC_OBSERVATION_KEYS)) {
    throw new Error("EVM atomic observation has invalid fields.");
  }
  if (value.attemptId !== request.attemptId || value.idempotencyKey !== request.idempotencyKey) {
    throw new Error("EVM atomic observation identity does not match the request.");
  }
  if (value.environment !== EVM_TESTNET_ENVIRONMENT) throw new Error("EVM observation is not bound to TESTNET.");
  if (typeof value.domainId !== "string" || value.domainId.length === 0) {
    throw new Error("EVM observation domain id is invalid.");
  }
  const domainId = value.domainId as string;
  const domainManifestVersion = requirePositiveInteger(value.domainManifestVersion, "domainManifestVersion");
  const domainManifestHash = requireCommitment(value.domainManifestHash, "domainManifestHash");
  const chainReference = requireChainReference(value.chainReference);
  if (value.transactionHash !== request.transactionHash) {
    throw new Error("EVM atomic observation does not match the requested transaction.");
  }
  requireCommitment(value.transactionHash, "transactionHash");
  const lifecycle = value.lifecycle;
  if (typeof lifecycle !== "string" || !(ATOMIC_LIFECYCLES as readonly string[]).includes(lifecycle)) {
    throw new Error("EVM atomic lifecycle is unsupported.");
  }
  const evidenceGrade = value.evidenceGrade;
  if (typeof evidenceGrade !== "string" || !(EVIDENCE_GRADES as readonly string[]).includes(evidenceGrade)) {
    throw new Error("EVM evidence grade is unsupported.");
  }
  let blockNumber: string | null = null;
  if (value.blockNumber !== null) blockNumber = requireDecimalString(value.blockNumber, "blockNumber");
  let confirmations: number | null = null;
  if (value.confirmations !== null) {
    if (typeof value.confirmations !== "number" || !Number.isSafeInteger(value.confirmations) || value.confirmations < 0) {
      throw new Error("confirmations must be a nonnegative safe integer or null.");
    }
    confirmations = value.confirmations;
  }
  let receiptHash: string | null = null;
  if (value.receiptHash !== null) receiptHash = requireCommitment(value.receiptHash, "receiptHash");
  let packageReceipt: EvmTestnetAtomicPackageReceiptDto | null = null;
  if (value.packageReceipt !== null) packageReceipt = validateAtomicReceipt(value.packageReceipt);
  let openPackage: EvmTestnetAtomicOpenPackageDto | null = null;
  if (value.openPackage !== null) openPackage = validateAtomicOpenPackage(value.openPackage);
  const reason = requireReason(value.reason);
  if (lifecycle === "NOT_FOUND") {
    if (evidenceGrade !== "none" || blockNumber !== null || confirmations !== null || receiptHash !== null || packageReceipt !== null || openPackage !== null) {
      throw new Error("EVM atomic NOT_FOUND carries impossible evidence.");
    }
  } else if (lifecycle === "REVERTED") {
    if (evidenceGrade !== "transaction-receipt" || blockNumber === null || confirmations === null || packageReceipt !== null || openPackage !== null) {
      throw new Error("EVM atomic REVERTED carries impossible evidence.");
    }
  } else if (lifecycle === "SUBMITTED" || lifecycle === "CONFIRMED") {
    if (evidenceGrade !== "contract-state" || blockNumber === null || confirmations === null || (packageReceipt === null && openPackage === null)) {
      throw new Error(`EVM atomic ${lifecycle} carries impossible evidence.`);
    }
  } else if (lifecycle === "FINALIZED") {
    if (evidenceGrade !== "finalized-contract-receipt" || blockNumber === null || confirmations === null || (packageReceipt === null && openPackage === null) || reason !== null) {
      throw new Error("EVM atomic FINALIZED carries impossible evidence.");
    }
  }
  if (packageReceipt !== null) {
    const expectedDomainIdHash = keccak256(stringToHex(domainId)).toLowerCase();
    if (packageReceipt.domainIdHash.toLowerCase() !== expectedDomainIdHash) {
      throw new Error("EVM atomic receipt domain id does not match the observation domain.");
    }
    if (packageReceipt.domainManifestVersion !== domainManifestVersion) {
      throw new Error("EVM atomic receipt domain version does not match the observation domain.");
    }
    if (packageReceipt.domainManifestHash.toLowerCase() !== (domainManifestHash as string).toLowerCase()) {
      throw new Error("EVM atomic receipt domain hash does not match the observation domain.");
    }
    if (receiptHash === null) {
      throw new Error("EVM atomic receipt requires a nonnull receipt hash.");
    }
    if (receiptHash.toLowerCase() !== packageReceipt.receiptHash.toLowerCase()) {
      throw new Error("EVM atomic receipt hash does not match the package receipt.");
    }
  }
  return Object.freeze({
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    environment: EVM_TESTNET_ENVIRONMENT,
    domainId,
    domainManifestVersion,
    domainManifestHash,
    chainReference,
    transactionHash: request.transactionHash,
    lifecycle: lifecycle as (typeof ATOMIC_LIFECYCLES)[number],
    evidenceGrade: evidenceGrade as (typeof EVIDENCE_GRADES)[number],
    blockNumber,
    confirmations,
    receiptHash,
    packageReceipt,
    openPackage,
    reason,
  });
}

function validateAsyncCoordinator(value: unknown): EvmTestnetAsyncCoordinatorDto {
  const keys = [
    "bondSlashed",
    "evidenceConflict",
    "hasVenueOutcome",
    "lastVenueOutcome",
    "outcomeEvidenceHash",
    "recoveryActionSubmitted",
    "recoveryDutyActive",
    "recoveryEvidenceHash",
    "recoveryProven",
    "requestKey",
    "state",
    "stateVersion",
  ].sort();
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error("coordinator has invalid fields.");
  if (typeof value.state !== "string" || !(COORDINATOR_STATE_LABELS as readonly string[]).includes(value.state)) {
    throw new Error("coordinator state is invalid.");
  }
  const bool = (field: string): boolean => {
    if (typeof value[field] !== "boolean") throw new Error(`coordinator ${field} must be a boolean.`);
    return value[field] as boolean;
  };
  return Object.freeze({
    state: value.state as (typeof COORDINATOR_STATE_LABELS)[number],
    stateVersion: requireNonnegativeInteger(value.stateVersion, "coordinator.stateVersion"),
    requestKey: requireHashAllowingZero(value.requestKey, "coordinator.requestKey"),
    outcomeEvidenceHash: requireHashAllowingZero(value.outcomeEvidenceHash, "coordinator.outcomeEvidenceHash"),
    recoveryEvidenceHash: requireHashAllowingZero(value.recoveryEvidenceHash, "coordinator.recoveryEvidenceHash"),
    hasVenueOutcome: bool("hasVenueOutcome"),
    lastVenueOutcome: requireNonnegativeInteger(value.lastVenueOutcome, "coordinator.lastVenueOutcome"),
    recoveryDutyActive: bool("recoveryDutyActive"),
    recoveryActionSubmitted: bool("recoveryActionSubmitted"),
    recoveryProven: bool("recoveryProven"),
    bondSlashed: bool("bondSlashed"),
    evidenceConflict: bool("evidenceConflict"),
  });
}

function validateAsyncEntry(value: unknown): EvmTestnetAsyncEntryDto {
  const keys = ["evidenceHash", "positionSizeAfter", "positionSizeBefore", "revision", "status"].sort();
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error("entry has invalid fields.");
  if (typeof value.status !== "string" || !(VENUE_STATUS_LABELS as readonly string[]).includes(value.status)) {
    throw new Error("entry status is invalid.");
  }
  return Object.freeze({
    status: value.status as (typeof VENUE_STATUS_LABELS)[number],
    evidenceHash: requireHashAllowingZero(value.evidenceHash, "entry.evidenceHash"),
    positionSizeBefore: requireDecimalString(value.positionSizeBefore, "entry.positionSizeBefore"),
    positionSizeAfter: requireDecimalString(value.positionSizeAfter, "entry.positionSizeAfter"),
    revision: requireNonnegativeInteger(value.revision, "entry.revision"),
  });
}

function validateAsyncExit(value: unknown): EvmTestnetAsyncExitDto {
  const keys = ["evidenceHash", "reconciling", "released", "revision", "status"].sort();
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error("exit has invalid fields.");
  if (typeof value.status !== "string" || !(VENUE_STATUS_LABELS as readonly string[]).includes(value.status)) {
    throw new Error("exit status is invalid.");
  }
  if (typeof value.reconciling !== "boolean" || typeof value.released !== "boolean") {
    throw new Error("exit flags must be booleans.");
  }
  return Object.freeze({
    status: value.status as (typeof VENUE_STATUS_LABELS)[number],
    evidenceHash: requireHashAllowingZero(value.evidenceHash, "exit.evidenceHash"),
    revision: requireNonnegativeInteger(value.revision, "exit.revision"),
    reconciling: value.reconciling as boolean,
    released: value.released as boolean,
  });
}

function validateAsyncFinalReceipt(value: unknown): EvmTestnetAsyncFinalReceiptDto {
  const keys = [
    "commitment",
    "entryRequestKey",
    "exitRequestKey",
    "fullCloseSizeUsd",
    "packageId",
    "perpStatus",
    "recipient",
    "spotBaseAtoms",
    "spotQuoteAtoms",
    "terminalState",
  ].sort();
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error("final receipt has invalid fields.");
  return Object.freeze({
    commitment: requireCommitment(value.commitment, "finalReceipt.commitment"),
    packageId: requireCommitment(value.packageId, "finalReceipt.packageId"),
    entryRequestKey: requireHashAllowingZero(value.entryRequestKey, "finalReceipt.entryRequestKey"),
    exitRequestKey: requireHashAllowingZero(value.exitRequestKey, "finalReceipt.exitRequestKey"),
    recipient: requireAddress(value.recipient, "finalReceipt.recipient"),
    fullCloseSizeUsd: requireDecimalString(value.fullCloseSizeUsd, "finalReceipt.fullCloseSizeUsd"),
    spotBaseAtoms: requireDecimalString(value.spotBaseAtoms, "finalReceipt.spotBaseAtoms"),
    spotQuoteAtoms: requireDecimalString(value.spotQuoteAtoms, "finalReceipt.spotQuoteAtoms"),
    perpStatus: requireNonnegativeInteger(value.perpStatus, "finalReceipt.perpStatus"),
    terminalState: requireNonnegativeInteger(value.terminalState, "finalReceipt.terminalState"),
  });
}

const ASYNC_OBSERVATION_KEYS = [
  "attemptId",
  "chainReference",
  "coordinator",
  "domainId",
  "domainManifestHash",
  "domainManifestVersion",
  "entry",
  "environment",
  "evidenceGrade",
  "exit",
  "exitCompleted",
  "finalReceipt",
  "idempotencyKey",
  "lifecycle",
  "packageId",
  "reason",
].sort();

export function validateEvmTestnetAsyncObservation(
  value: unknown,
  request: EvmTestnetObserveAsyncRequest,
): EvmTestnetAsyncObservationDto {
  if (!isRecord(value) || !hasExactKeys(value, ASYNC_OBSERVATION_KEYS)) {
    throw new Error("EVM async observation has invalid fields.");
  }
  if (value.attemptId !== request.attemptId || value.idempotencyKey !== request.idempotencyKey) {
    throw new Error("EVM async observation identity does not match the request.");
  }
  if (value.environment !== EVM_TESTNET_ENVIRONMENT) throw new Error("EVM observation is not bound to TESTNET.");
  if (typeof value.domainId !== "string" || value.domainId.length === 0) {
    throw new Error("EVM observation domain id is invalid.");
  }
  const lifecycle = value.lifecycle;
  if (typeof lifecycle !== "string" || !(ASYNC_LIFECYCLES as readonly string[]).includes(lifecycle)) {
    throw new Error("EVM async lifecycle is unsupported.");
  }
  if (
    lifecycle === "CONFIRMED" ||
    lifecycle === "FINALIZED" ||
    lifecycle === "SUBMITTED" ||
    lifecycle === "REVERTED"
  ) {
    throw new Error("EVM async observation must not carry an atomic label.");
  }
  const evidenceGrade = value.evidenceGrade;
  if (typeof evidenceGrade !== "string" || !(EVIDENCE_GRADES as readonly string[]).includes(evidenceGrade)) {
    throw new Error("EVM evidence grade is unsupported.");
  }
  if (typeof value.exitCompleted !== "boolean") throw new Error("exitCompleted must be a boolean.");
  let coordinator: EvmTestnetAsyncCoordinatorDto | null = null;
  if (value.coordinator !== null) coordinator = validateAsyncCoordinator(value.coordinator);
  let entry: EvmTestnetAsyncEntryDto | null = null;
  if (value.entry !== null) entry = validateAsyncEntry(value.entry);
  let exit: EvmTestnetAsyncExitDto | null = null;
  if (value.exit !== null) exit = validateAsyncExit(value.exit);
  let finalReceipt: EvmTestnetAsyncFinalReceiptDto | null = null;
  if (value.finalReceipt !== null) finalReceipt = validateAsyncFinalReceipt(value.finalReceipt);
  const domainManifestVersion = requirePositiveInteger(value.domainManifestVersion, "domainManifestVersion");
  const domainManifestHash = requireCommitment(value.domainManifestHash, "domainManifestHash");
  const chainReference = requireChainReference(value.chainReference);
  const packageId = requireCommitment(value.packageId, "packageId");
  const exitCompleted = value.exitCompleted as boolean;
  const reason = requireReason(value.reason);
  const zeroHash = `0x${"0".repeat(64)}`;
  if (lifecycle === "NOT_FOUND") {
    if (evidenceGrade !== "none" || coordinator !== null || entry !== null || exit !== null || finalReceipt !== null || exitCompleted !== false) {
      throw new Error("EVM async NOT_FOUND carries impossible evidence.");
    }
  } else if (lifecycle === "CONFLICT") {
    if (coordinator === null) {
      throw new Error("EVM async CONFLICT requires a nonnull coordinator.");
    }
    const hasConflictSignal =
      coordinator.evidenceConflict === true || entry?.status === "CONFLICT" || exit?.status === "CONFLICT";
    if (!hasConflictSignal) {
      throw new Error("EVM async CONFLICT carries no conflict signal.");
    }
  } else if (lifecycle !== "EVIDENCE_MISMATCH") {
    if (coordinator === null) {
      throw new Error("EVM async observation requires a nonnull coordinator.");
    }
    if (lifecycle !== coordinator.state) {
      throw new Error("EVM async lifecycle does not match coordinator state.");
    }
  }
  for (const record of [entry, exit]) {
    if (record !== null && record.status !== "NONE" && record.status !== "PENDING" && record.evidenceHash.toLowerCase() === zeroHash) {
      throw new Error("EVM async terminal status carries no evidence commitment.");
    }
  }
  if (finalReceipt !== null) {
    if (exit === null) throw new Error("EVM async final receipt requires a nonnull exit.");
    if (finalReceipt.packageId.toLowerCase() !== (packageId as string).toLowerCase()) {
      throw new Error("EVM async final receipt package id does not match the observation.");
    }
  }
  if (exitCompleted) {
    if (entry === null || entry.status !== "EXECUTED") {
      throw new Error("EVM async exit completion requires an executed entry.");
    }
    if (exit === null || exit.status !== "EXECUTED" || exit.released !== true || exit.evidenceHash.toLowerCase() === zeroHash) {
      throw new Error("EVM async exit completion requires an executed and released exit with evidence.");
    }
    if (finalReceipt === null || finalReceipt.packageId.toLowerCase() !== (packageId as string).toLowerCase()) {
      throw new Error("EVM async exit completion requires a matching final receipt.");
    }
    if (finalReceipt.perpStatus !== (VENUE_STATUS_LABELS as readonly string[]).indexOf("EXECUTED")) {
      throw new Error("EVM async exit completion requires the EXECUTED status discriminant.");
    }
    if (finalReceipt.terminalState !== 1) throw new Error("EVM async exit completion requires terminal state 1.");
    if (evidenceGrade !== "finalized-contract-receipt") {
      throw new Error("EVM async exit completion requires finalized-contract-receipt evidence.");
    }
  }
  return Object.freeze({
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    environment: EVM_TESTNET_ENVIRONMENT,
    domainId: value.domainId as string,
    domainManifestVersion,
    domainManifestHash,
    chainReference,
    packageId,
    lifecycle: lifecycle as (typeof ASYNC_LIFECYCLES)[number],
    evidenceGrade: evidenceGrade as (typeof EVIDENCE_GRADES)[number],
    coordinator,
    entry,
    exit,
    finalReceipt,
    exitCompleted,
    reason,
  });
}

function copyPreparation(dto: EvmTestnetAtomicPreparationDto): EvmTestnetAtomicPreparationDto {
  return Object.freeze({ ...dto });
}

function copyPreparationRecord(record: {
  attemptId: string;
  idempotencyKey: string;
  traderSignature: string;
  preparation: EvmTestnetAtomicPreparationDto;
  boundTransactionHash: string | undefined;
}): PreparedEvmTestnetAtomicRecord {
  return Object.freeze({
    attemptId: record.attemptId,
    idempotencyKey: record.idempotencyKey,
    traderSignature: record.traderSignature,
    preparation: copyPreparation(record.preparation),
    boundTransactionHash: record.boundTransactionHash,
  });
}

export class InMemoryPreparedEvmTestnetAtomicStore implements PreparedEvmTestnetAtomicStore {
  private readonly records = new Map<
    string,
    {
      attemptId: string;
      idempotencyKey: string;
      traderSignature: string;
      preparation: EvmTestnetAtomicPreparationDto;
      boundTransactionHash: string | undefined;
    }
  >();

  get(idempotencyKey: string): PreparedEvmTestnetAtomicRecord | undefined {
    requireIdempotencyKey(idempotencyKey);
    const record = this.records.get(idempotencyKey);
    return record === undefined ? undefined : copyPreparationRecord(record);
  }

  save(
    attemptId: string,
    idempotencyKey: string,
    traderSignature: string,
    preparation: EvmTestnetAtomicPreparationDto,
  ): PreparedEvmTestnetAtomicRecord {
    requireBrowserId(attemptId, "attemptId");
    requireIdempotencyKey(idempotencyKey);
    requireTraderSignature(traderSignature);
    const normalizedSignature = traderSignature.toLowerCase();
    const existing = this.records.get(idempotencyKey);
    if (existing !== undefined) {
      if (existing.attemptId !== attemptId || existing.traderSignature !== normalizedSignature) {
        throw new Error(`Idempotency key "${idempotencyKey}" was already used with different attempt fields.`);
      }
      return copyPreparationRecord(existing);
    }
    const stored = {
      attemptId,
      idempotencyKey,
      traderSignature: normalizedSignature,
      preparation: copyPreparation(preparation),
      boundTransactionHash: undefined as string | undefined,
    };
    this.records.set(idempotencyKey, stored);
    return copyPreparationRecord(stored);
  }

  bindTransactionHash(idempotencyKey: string, transactionHash: string): PreparedEvmTestnetAtomicRecord {
    requireIdempotencyKey(idempotencyKey);
    const canonical = requireTransactionHash(transactionHash);
    const record = this.records.get(idempotencyKey);
    if (record === undefined) throw new Error(`Unknown idempotency key "${idempotencyKey}".`);
    if (record.boundTransactionHash === undefined) {
      record.boundTransactionHash = canonical;
      return copyPreparationRecord(record);
    }
    if (record.boundTransactionHash !== canonical) {
      throw new Error(`Idempotency key "${idempotencyKey}" is already bound to a different transaction.`);
    }
    return copyPreparationRecord(record);
  }
}

function admissionDomains(admission: PackageAdmission): {
  order: DomainRef;
  quote: DomainRef;
  route: DomainRef;
} {
  const candidate = admission as unknown as Record<string, unknown>;
  const order = candidate.order;
  const quote = candidate.quote;
  const route = candidate.route;
  if (!isRecord(order) || !isRecord(quote) || !isRecord(route)) {
    throw new Error("Atomic context must carry admission and deployment.");
  }
  if (order.environment !== "testnet" || quote.environment !== "testnet" || route.environment !== "testnet") {
    throw new Error("Atomic context admission environment must be testnet.");
  }
  const orderDomain = asDomainRef(order.domain, "admission order domain");
  const quoteDomain = asDomainRef(quote.domain, "admission quote domain");
  const routeDomain = asDomainRef(route.domain, "admission route domain");
  requireSameDomain(quoteDomain, orderDomain, "Admission quote");
  requireSameDomain(routeDomain, orderDomain, "Admission route");
  return { order: orderDomain, quote: quoteDomain, route: routeDomain };
}

function requireTestnetDeployment(deployment: EvmDeploymentIdentity): void {
  const environment = (deployment as unknown as Record<string, unknown>).domainManifest as
    | Record<string, unknown>
    | undefined;
  if (!isRecord(deployment as unknown) || !isRecord(environment)) {
    throw new Error("Atomic context deployment is invalid.");
  }
  if (environment.environment !== "testnet") {
    throw new Error("Atomic context deployment environment must be testnet.");
  }
}

function requireAtomicBindingCoherence(args: Readonly<{
  binding: EvmAtomicObservationBinding;
  admission: PackageAdmission;
  deployment: EvmDeploymentIdentity;
  orderHash: string;
  quoteHash: string;
  routeHash: string;
}>): void {
  const binding = args.binding;
  if (!isRecord(binding as unknown)) throw new Error("Atomic observation binding is invalid.");
  if (binding.executionPlanKind !== "EVM_ATOMIC_BATCH") {
    throw new Error("Atomic observation requires the atomic execution plan.");
  }
  const boundChain = assertEvmChainReference(binding.chainReference, "binding.chainReference");
  const deploymentChain = assertEvmChainReference(
    args.deployment.deploymentChainReference,
    "deployment.deploymentChainReference",
  );
  if (boundChain !== deploymentChain) {
    throw new Error("Atomic binding chain reference does not match deployment.");
  }
  const boundVerifier = assertEvmAddress(binding.packageVerifier, "binding.packageVerifier");
  const deploymentVerifier = assertEvmAddress(
    args.deployment.packageVerifier.address,
    "deployment.packageVerifier",
  );
  if (!equalEvmAddress(boundVerifier, deploymentVerifier)) {
    throw new Error("Atomic binding verifier does not match deployment.");
  }
  const boundStrategy = assertEvmAddress(binding.strategyAccount, "binding.strategyAccount");
  const deploymentStrategy = assertEvmAddress(
    args.deployment.strategyAccount.address,
    "deployment.strategyAccount",
  );
  if (!equalEvmAddress(boundStrategy, deploymentStrategy)) {
    throw new Error("Atomic binding strategy account does not match deployment.");
  }
  const boundOrder = assertEvmHash32(binding.orderHash, "binding.orderHash");
  const boundQuote = assertEvmHash32(binding.quoteHash, "binding.quoteHash");
  const boundRoute = assertEvmHash32(binding.routeHash, "binding.routeHash");
  const admissionHashes = args.admission as unknown as {
    orderHash: Uint8Array;
    quoteHash: Uint8Array;
    routeHash: Uint8Array;
  };
  const admittedOrder = toHex0x(admissionHashes.orderHash, "orderHash");
  const admittedQuote = toHex0x(admissionHashes.quoteHash, "quoteHash");
  const admittedRoute = toHex0x(admissionHashes.routeHash, "routeHash");
  const expectedOrder = assertEvmHash32(args.orderHash, "expected.orderHash");
  const expectedQuote = assertEvmHash32(args.quoteHash, "expected.quoteHash");
  const expectedRoute = assertEvmHash32(args.routeHash, "expected.routeHash");
  if (!equalEvmHash(boundOrder, admittedOrder as Hex) || !equalEvmHash(boundOrder, expectedOrder)) {
    throw new Error("Atomic binding order hash does not match admission.");
  }
  if (!equalEvmHash(boundQuote, admittedQuote as Hex) || !equalEvmHash(boundQuote, expectedQuote)) {
    throw new Error("Atomic binding quote hash does not match admission.");
  }
  if (!equalEvmHash(boundRoute, admittedRoute as Hex) || !equalEvmHash(boundRoute, expectedRoute)) {
    throw new Error("Atomic binding route hash does not match admission.");
  }
}

function requireAsyncDomainManifest(manifest: unknown): { manifest: DomainManifest; domain: DomainRef } {
  const checked = domainManifest(manifest as unknown as DomainManifest, "async domainManifest");
  if (checked.environment !== "testnet") {
    throw new Error("Async context environment must be testnet.");
  }
  if (checked.chainNamespace !== "eip155") {
    throw new Error("Async context chain namespace must be eip155.");
  }
  if (!CHAIN_REFERENCE_PATTERN.test(checked.chainReference)) {
    throw new Error("Async context chain reference must be a positive canonical decimal value.");
  }
  if (checked.runtimeClassId !== EVM_RUNTIME_IDENTITY.runtimeClassId) {
    throw new Error("Async context runtime class is unsupported.");
  }
  if (checked.runtimeClassVersion !== EVM_RUNTIME_IDENTITY.runtimeClassVersion) {
    throw new Error("Async context runtime class version is unsupported.");
  }
  if (checked.executionVerifierId !== EVM_RUNTIME_IDENTITY.executionVerifierId) {
    throw new Error("Async context execution verifier is unsupported.");
  }
  if (checked.clockModelId !== EVM_RUNTIME_IDENTITY.clockModelId) {
    throw new Error("Async context clock model is unsupported.");
  }
  if (checked.addressCodecId !== EVM_RUNTIME_IDENTITY.addressCodecId) {
    throw new Error("Async context address codec is unsupported.");
  }
  if (!checked.supportedSettlementClasses.includes("ASYNC_BONDED_SOLVER")) {
    throw new Error("Async context settlement class is unsupported.");
  }
  const domain = domainRefFromManifest(checked);
  return { manifest: checked, domain };
}

function sanitizeAtomicObservation(
  raw: {
    lifecycle: string;
    evidenceGrade: string;
    chainReference: bigint;
    transactionHash: Hex | null;
    blockNumber: bigint | null;
    confirmations: number | null;
    receiptHash: Hex | null;
    packageReceipt: Record<string, unknown> | null;
    openPackage: Record<string, unknown> | null;
    reason: string | null;
  },
  request: EvmTestnetObserveAtomicRequest,
  domain: DomainRef,
): EvmTestnetAtomicObservationDto {
  if (!(ATOMIC_LIFECYCLES as readonly string[]).includes(raw.lifecycle)) {
    throw new Error("Atomic observation lifecycle is unsupported.");
  }
  if (!(EVIDENCE_GRADES as readonly string[]).includes(raw.evidenceGrade)) {
    throw new Error("Atomic observation evidence grade is unsupported.");
  }
  if (typeof raw.chainReference !== "bigint" || raw.chainReference <= 0n) {
    throw new Error("Atomic observation chain reference is invalid.");
  }
  if (raw.transactionHash === null || raw.transactionHash.toLowerCase() !== request.transactionHash) {
    throw new Error("Atomic observation transaction does not match the request.");
  }
  const candidate = {
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    environment: EVM_TESTNET_ENVIRONMENT,
    domainId: domain.domainId,
    domainManifestVersion: domain.domainManifestVersion,
    domainManifestHash: toHex0x(domain.domainManifestHash, "domainManifestHash"),
    chainReference: raw.chainReference.toString(),
    transactionHash: (raw.transactionHash as string).toLowerCase(),
    lifecycle: raw.lifecycle,
    evidenceGrade: raw.evidenceGrade,
    blockNumber: raw.blockNumber === null ? null : raw.blockNumber.toString(),
    confirmations: raw.confirmations,
    receiptHash: raw.receiptHash === null ? null : (raw.receiptHash as string).toLowerCase(),
    packageReceipt: raw.packageReceipt === null
      ? null
      : {
        receiptHash: (raw.packageReceipt.receiptHash as string).toLowerCase(),
        domainIdHash: (raw.packageReceipt.domainIdHash as string).toLowerCase(),
        domainManifestVersion: raw.packageReceipt.domainManifestVersion as number,
        domainManifestHash: (raw.packageReceipt.domainManifestHash as string).toLowerCase(),
        orderHash: (raw.packageReceipt.orderHash as string).toLowerCase(),
        quoteHash: (raw.packageReceipt.quoteHash as string).toLowerCase(),
        routeHash: (raw.packageReceipt.routeHash as string).toLowerCase(),
        spotFillCommitment: (raw.packageReceipt.spotFillCommitment as string).toLowerCase(),
        seriesIdentityKey: (raw.packageReceipt.seriesIdentityKey as string).toLowerCase(),
        seriesBindingVersion: raw.packageReceipt.seriesBindingVersion as number,
        seriesBindingHash: (raw.packageReceipt.seriesBindingHash as string).toLowerCase(),
        action: raw.packageReceipt.action as number,
        strategyAccount: getAddress(String(raw.packageReceipt.strategyAccount)),
        solver: getAddress(String(raw.packageReceipt.solver)),
        recovery: raw.packageReceipt.recovery as boolean,
        baseQuantityAtoms: (raw.packageReceipt.baseQuantityAtoms as bigint).toString(),
        spotQuoteAtoms: (raw.packageReceipt.spotQuoteAtoms as bigint).toString(),
        packageSizeUnits: (raw.packageReceipt.packageSizeUnits as bigint).toString(),
        nonce: (raw.packageReceipt.nonce as bigint).toString(),
      },
    openPackage: raw.openPackage === null
      ? null
      : {
        entryReceiptHash: (raw.openPackage.entryReceiptHash as string).toLowerCase(),
        routeHash: (raw.openPackage.routeHash as string).toLowerCase(),
        baseQuantityAtoms: (raw.openPackage.baseQuantityAtoms as bigint).toString(),
        packageSizeUnits: (raw.openPackage.packageSizeUnits as bigint).toString(),
      },
    reason: raw.reason,
  };
  return validateEvmTestnetAtomicObservation(candidate, request);
}

function sanitizeAsyncObservation(
  raw: {
    lifecycle: string;
    evidenceGrade: string;
    chainReference: bigint;
    packageId: Hex;
    coordinator: Record<string, unknown> | null;
    entry: Record<string, unknown> | null;
    exit: Record<string, unknown> | null;
    finalReceipt: Record<string, unknown> | null;
    exitCompleted: boolean;
    reason: string | null;
  },
  request: EvmTestnetObserveAsyncRequest,
  domain: DomainRef,
): EvmTestnetAsyncObservationDto {
  if (!(ASYNC_LIFECYCLES as readonly string[]).includes(raw.lifecycle)) {
    throw new Error("Async observation lifecycle is unsupported.");
  }
  if (!(EVIDENCE_GRADES as readonly string[]).includes(raw.evidenceGrade)) {
    throw new Error("Async observation evidence grade is unsupported.");
  }
  const candidate = {
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    environment: EVM_TESTNET_ENVIRONMENT,
    domainId: domain.domainId,
    domainManifestVersion: domain.domainManifestVersion,
    domainManifestHash: toHex0x(domain.domainManifestHash, "domainManifestHash"),
    chainReference: (() => {
      if (typeof raw.chainReference !== "bigint" || raw.chainReference <= 0n) {
        throw new Error("Async observation chain reference is invalid.");
      }
      return raw.chainReference.toString();
    })(),
    packageId: (raw.packageId as string).toLowerCase(),
    lifecycle: raw.lifecycle,
    evidenceGrade: raw.evidenceGrade,
    coordinator: raw.coordinator === null
      ? null
      : {
        state: String(raw.coordinator.state),
        stateVersion: raw.coordinator.stateVersion as number,
        requestKey: String(raw.coordinator.requestKey).toLowerCase(),
        outcomeEvidenceHash: String(raw.coordinator.outcomeEvidenceHash).toLowerCase(),
        recoveryEvidenceHash: String(raw.coordinator.recoveryEvidenceHash).toLowerCase(),
        hasVenueOutcome: raw.coordinator.hasVenueOutcome as boolean,
        lastVenueOutcome: raw.coordinator.lastVenueOutcome as number,
        recoveryDutyActive: raw.coordinator.recoveryDutyActive as boolean,
        recoveryActionSubmitted: raw.coordinator.recoveryActionSubmitted as boolean,
        recoveryProven: raw.coordinator.recoveryProven as boolean,
        bondSlashed: raw.coordinator.bondSlashed as boolean,
        evidenceConflict: raw.coordinator.evidenceConflict as boolean,
      },
    entry: raw.entry === null
      ? null
      : {
        status: String(raw.entry.status),
        evidenceHash: String(raw.entry.evidenceHash).toLowerCase(),
        positionSizeBefore: (raw.entry.positionSizeBefore as bigint).toString(),
        positionSizeAfter: (raw.entry.positionSizeAfter as bigint).toString(),
        revision: raw.entry.revision as number,
      },
    exit: raw.exit === null
      ? null
      : {
        status: String(raw.exit.status),
        evidenceHash: String(raw.exit.evidenceHash).toLowerCase(),
        revision: raw.exit.revision as number,
        reconciling: raw.exit.reconciling as boolean,
        released: raw.exit.released as boolean,
      },
    finalReceipt: raw.finalReceipt === null
      ? null
      : {
        commitment: String(raw.finalReceipt.commitment).toLowerCase(),
        packageId: String(raw.finalReceipt.packageId).toLowerCase(),
        entryRequestKey: String(raw.finalReceipt.entryRequestKey).toLowerCase(),
        exitRequestKey: String(raw.finalReceipt.exitRequestKey).toLowerCase(),
        recipient: getAddress(String(raw.finalReceipt.recipient)),
        fullCloseSizeUsd: (raw.finalReceipt.fullCloseSizeUsd as bigint).toString(),
        spotBaseAtoms: (raw.finalReceipt.spotBaseAtoms as bigint).toString(),
        spotQuoteAtoms: (raw.finalReceipt.spotQuoteAtoms as bigint).toString(),
        perpStatus: raw.finalReceipt.perpStatus as number,
        terminalState: raw.finalReceipt.terminalState as number,
      },
    exitCompleted: raw.exitCompleted,
    reason: raw.reason,
  };
  return validateEvmTestnetAsyncObservation(candidate, request);
}

export function createEvmTestnetAsyncObservationPort(
  options: EvmTestnetAsyncObservationPortOptions,
): EvmTestnetAsyncObservationPort {
  const asyncContextProvider = options.contextProvider;
  const asyncReadPort = options.readPort;
  if (typeof asyncContextProvider !== "function") throw new Error("Async context provider must be a function.");
  if (typeof asyncReadPort?.chainId !== "function" || typeof asyncReadPort?.readContract !== "function") {
    throw new Error("Async read port must expose chainId and contract reads.");
  }
  return Object.freeze({
    observe: async (request: EvmTestnetObserveAsyncRequest) => {
      const attemptId = requireBrowserId(request.attemptId, "attemptId");
      const idempotencyKey = requireIdempotencyKey(request.idempotencyKey);
      const context = await asyncContextProvider(attemptId);
      if (!isRecord(context as unknown)) throw new Error("Async context provider returned an invalid context.");
      const asyncContext = context as EvmTestnetAsyncAttemptContext;
      const checked = requireAsyncDomainManifest(
        (asyncContext as unknown as { domainManifest: unknown }).domainManifest,
      );
      const domain = checked.domain;
      const binding = asyncContext.binding;
      const keys = asyncContext.keys;
      if (!isRecord(binding as unknown) || !isRecord(keys as unknown)) {
        throw new Error("Async context must carry binding and keys.");
      }
      const boundChain = assertEvmChainReference(binding.chainReference, "binding.chainReference");
      if (boundChain !== BigInt(checked.manifest.chainReference)) {
        throw new Error("Async binding chain reference does not match server context.");
      }
      const boundDomainIdHash = assertEvmHash32(binding.domainIdHash, "binding.domainIdHash");
      const expectedDomainIdHash = keccak256(stringToHex(domain.domainId));
      if (!equalEvmHash(boundDomainIdHash, expectedDomainIdHash as Hex)) {
        throw new Error("Async binding domain does not match server context.");
      }
      if (binding.domainManifestVersion !== domain.domainManifestVersion) {
        throw new Error("Async binding domain version mismatch.");
      }
      const boundManifestHash = assertEvmHash32(binding.domainManifestHash, "binding.domainManifestHash");
      const expectedManifestHash = toHex0x(domain.domainManifestHash, "domainManifestHash") as Hex;
      if (!equalEvmHash(boundManifestHash, expectedManifestHash)) {
        throw new Error("Async binding domain hash mismatch.");
      }
      for (const field of ["orderHash", "quoteHash", "routeHash"] as const) {
        const checkedHash = assertEvmHash32(binding[field], `binding.${field}`);
        if (/^0x0+$/.test(checkedHash)) throw new Error(`Async binding ${field} must be nonzero.`);
      }
      const observed = await observeAsyncBondedPackage(asyncReadPort, binding, keys);
      return sanitizeAsyncObservation(
        observed as unknown as {
          lifecycle: string;
          evidenceGrade: string;
          chainReference: bigint;
          packageId: Hex;
          coordinator: Record<string, unknown> | null;
          entry: Record<string, unknown> | null;
          exit: Record<string, unknown> | null;
          finalReceipt: Record<string, unknown> | null;
          exitCompleted: boolean;
          reason: string | null;
        },
        { attemptId, idempotencyKey },
        domain,
      );
    },
  });
}

export function createEvmTestnetTerminalPorts(options: EvmTestnetRuntimePortsOptions): EvmTestnetTerminalPorts {
  const atomicContextProvider = options.atomicContextProvider;
  const asyncContextProvider = options.asyncContextProvider;
  const atomicReadPort = options.atomicReadPort;
  const asyncReadPort = options.asyncReadPort;
  const store = options.store;
  if (typeof atomicContextProvider !== "function") throw new Error("Atomic context provider must be a function.");
  if (typeof asyncContextProvider !== "function") throw new Error("Async context provider must be a function.");
  if (
    typeof atomicReadPort?.chainId !== "function" ||
    typeof atomicReadPort?.transactionReceipt !== "function" ||
    typeof atomicReadPort?.readContract !== "function" ||
    typeof atomicReadPort?.chainHead !== "function"
  ) {
    throw new Error("Atomic read port must expose chainId, receipt, contract, and head.");
  }
  if (typeof asyncReadPort?.chainId !== "function" || typeof asyncReadPort?.readContract !== "function") {
    throw new Error("Async read port must expose chainId and contract reads.");
  }
  if (typeof store?.get !== "function" || typeof store?.save !== "function" || typeof store?.bindTransactionHash !== "function") {
    throw new Error("Prepared store must expose get, save, and bindTransactionHash.");
  }
  const inFlight = new Map<
    string,
    { attemptId: string; traderSignature: string; promise: Promise<EvmTestnetAtomicPreparationDto> }
  >();

  return Object.freeze({
    authorization: Object.freeze({
      prepare: async (request: EvmTestnetPrepareAtomicAuthorizationRequest) => {
        const attemptId = requireBrowserId(request.attemptId, "attemptId");
        const idempotencyKey = requireIdempotencyKey(request.idempotencyKey);
        const context = await atomicContextProvider(attemptId);
        if (!isRecord(context as unknown)) throw new Error("Atomic context provider returned an invalid context.");
        const atomicContext = context as EvmTestnetAtomicAttemptContext;
        const admission = atomicContext.admission;
        const deployment = atomicContext.deployment;
        const domains = admissionDomains(admission);
        requireTestnetDeployment(deployment);
        if (domains.order.domainId !== BASE_SEPOLIA_DOMAIN_ID ||
            deployment.domainManifest.domainId !== BASE_SEPOLIA_DOMAIN_ID ||
            deployment.deploymentChainReference !== BigInt(BASE_SEPOLIA_CHAIN_REFERENCE) ||
            deployment.domainManifest.chainReference !== BASE_SEPOLIA_CHAIN_REFERENCE) {
          throw new Error("Atomic authorization context must be bound to Base Sepolia.");
        }
        const authorization = prepareEvmTraderPermitAuthorization(
          admission,
          deployment,
          atomicContext.seriesBindingInput,
          atomicContext.bounds,
        );
        const domainManifestHash = toHex0x(domains.order.domainManifestHash, "domainManifestHash");
        const verifyingContract = getAddress(authorization.domain.verifyingContract);
        const digest = requireCommitment(authorization.digest, "digest");
        const normalizedRequest = { attemptId, idempotencyKey };
        return validateEvmTestnetAtomicAuthorization({
          ...normalizedRequest,
          domainId: BASE_SEPOLIA_DOMAIN_ID,
          domainManifestVersion: domains.order.domainManifestVersion,
          domainManifestHash,
          environment: EVM_TESTNET_ENVIRONMENT,
          chainReference: BASE_SEPOLIA_CHAIN_REFERENCE,
          typedData: {
            domain: {
              name: authorization.domain.name,
              version: authorization.domain.version,
              chainId: BASE_SEPOLIA_CHAIN_REFERENCE,
              verifyingContract,
            },
            types: {
              EIP712Domain: EIP712_DOMAIN_FIELDS,
              TraderPermit: TRADER_PERMIT_FIELDS,
            },
            primaryType: authorization.primaryType,
            message: {
              packageHash: authorization.message.packageHash,
              accountsHash: authorization.message.accountsHash,
              limitsHash: authorization.message.limitsHash,
              nonce: authorization.message.nonce.toString(),
              deadline: authorization.message.deadline.toString(),
            },
          },
          digest,
          requestCommitment: computeAuthorizationRequestCommitment({
            request: normalizedRequest,
            domainManifestVersion: domains.order.domainManifestVersion,
            domainManifestHash,
            verifyingContract,
            digest,
          }),
        }, normalizedRequest);
      },
    }),
    preparation: Object.freeze({
      prepare: async (request: EvmTestnetPrepareAtomicRequest) => {
        const attemptId = requireBrowserId(request.attemptId, "attemptId");
        const idempotencyKey = requireIdempotencyKey(request.idempotencyKey);
        const traderSignature = requireTraderSignature(request.traderSignature);
        const cached = store.get(idempotencyKey);
        if (cached !== undefined) {
          if (cached.attemptId !== attemptId || cached.traderSignature !== traderSignature) {
            throw new Error(`Idempotency key "${idempotencyKey}" was already used with different attempt fields.`);
          }
          return copyPreparation(validateEvmTestnetAtomicPreparation(cached.preparation, request));
        }
        const ongoing = inFlight.get(idempotencyKey);
        if (ongoing !== undefined) {
          if (ongoing.attemptId !== attemptId || ongoing.traderSignature !== traderSignature) {
            throw new Error(`Idempotency key "${idempotencyKey}" was already used with different attempt fields.`);
          }
          return copyPreparation(await ongoing.promise);
        }
        const task: Promise<EvmTestnetAtomicPreparationDto> = (async () => {
          const context = await atomicContextProvider(attemptId);
          if (!isRecord(context as unknown)) throw new Error("Atomic context provider returned an invalid context.");
          const admission = (context as EvmTestnetAtomicAttemptContext).admission;
          const deployment = (context as EvmTestnetAtomicAttemptContext).deployment;
          const seriesBindingInput = (context as EvmTestnetAtomicAttemptContext).seriesBindingInput;
          const boundsBase = (context as EvmTestnetAtomicAttemptContext).bounds;
          const atomicBinding = (context as EvmTestnetAtomicAttemptContext).atomicBinding;
          const finality = (context as EvmTestnetAtomicAttemptContext).finality;
          if (!isRecord(admission as unknown) || !isRecord(deployment as unknown)) {
            throw new Error("Atomic context must carry admission and deployment.");
          }
          const domains = admissionDomains(admission);
          requireTestnetDeployment(deployment);
          validateFinalityPolicy(finality as unknown as Parameters<typeof validateFinalityPolicy>[0]);
          const fullBounds = {
            ...(boundsBase as unknown as Record<string, unknown>),
            traderSignature: traderSignature as Hex,
          } as unknown as EvmAtomicExecutionBounds;
          const compiled = compileEvmAtomicPackage(admission, deployment, seriesBindingInput, fullBounds);
          if (!isRecord(compiled as unknown)) throw new Error("Compiler returned an invalid package.");
          const compiledDomain = asDomainRef(
            (compiled as unknown as Record<string, unknown>).domain,
            "compiled domain",
          );
          requireSameDomain(domains.order, compiledDomain, "Compiled order");
          const admissionRecord = admission as unknown as {
            orderHash: Uint8Array;
            quoteHash: Uint8Array;
            routeHash: Uint8Array;
          };
          const compiledRecord = compiled as unknown as {
            orderHash: Uint8Array;
            quoteHash: Uint8Array;
            routeHash: Uint8Array;
            payload: { chainReference: bigint; to: string; value: bigint; data: string };
          };
          if (
            !bytesEqual(admissionRecord.orderHash, compiledRecord.orderHash) ||
            !bytesEqual(admissionRecord.quoteHash, compiledRecord.quoteHash) ||
            !bytesEqual(admissionRecord.routeHash, compiledRecord.routeHash)
          ) {
            throw new Error("Compiled package hashes do not match server context.");
          }
          const deploymentRecord = deployment as unknown as {
            deploymentChainReference: bigint;
            strategyAccount: { address: string };
          };
          if (compiledRecord.payload.chainReference !== deploymentRecord.deploymentChainReference) {
            throw new Error("Compiled chain reference does not match server context.");
          }
          if (getAddress(compiledRecord.payload.to) !== getAddress(deploymentRecord.strategyAccount.address)) {
            throw new Error("Compiled target does not match server context.");
          }
          if (compiledRecord.payload.value !== 0n) throw new Error("Compiled value must be zero.");
          const data = requireData(compiledRecord.payload.data);
          const domainManifestHash = toHex0x(compiledDomain.domainManifestHash, "domainManifestHash");
          const orderHash = toHex0x(compiledRecord.orderHash, "orderHash");
          const quoteHash = toHex0x(compiledRecord.quoteHash, "quoteHash");
          const routeHash = toHex0x(compiledRecord.routeHash, "routeHash");
          const chainReference = compiledRecord.payload.chainReference.toString();
          if (!CHAIN_REFERENCE_PATTERN.test(chainReference)) throw new Error("Compiled chain reference is invalid.");
          const to = getAddress(compiledRecord.payload.to);
          const requestCommitment = computeRequestCommitment({
            attemptId,
            idempotencyKey,
            traderSignature,
            domainId: compiledDomain.domainId,
            domainManifestVersion: compiledDomain.domainManifestVersion,
            domainManifestHash,
            chainReference,
            to,
            data,
            orderHash,
            quoteHash,
            routeHash,
          });
          const candidate = {
            attemptId,
            idempotencyKey,
            domainId: compiledDomain.domainId,
            domainManifestVersion: compiledDomain.domainManifestVersion,
            domainManifestHash,
            environment: EVM_TESTNET_ENVIRONMENT,
            chainReference,
            to,
            value: "0",
            data,
            orderHash,
            quoteHash,
            routeHash,
            requestCommitment,
          };
          const dto = validateEvmTestnetAtomicPreparation(candidate, { attemptId, idempotencyKey, traderSignature });
          requireAtomicBindingCoherence({
            binding: atomicBinding,
            admission,
            deployment,
            orderHash,
            quoteHash,
            routeHash,
          });
          store.save(attemptId, idempotencyKey, traderSignature, dto);
          const stored = store.get(idempotencyKey);
          if (stored === undefined) throw new Error("Prepared attempt was not stored.");
          return copyPreparation(stored.preparation);
        })();
        inFlight.set(idempotencyKey, { attemptId, traderSignature, promise: task });
        try {
          return copyPreparation(await task);
        } finally {
          inFlight.delete(idempotencyKey);
        }
      },
    }),
    atomicObservation: Object.freeze({
      observe: async (request: EvmTestnetObserveAtomicRequest) => {
        const attemptId = requireBrowserId(request.attemptId, "attemptId");
        const idempotencyKey = requireIdempotencyKey(request.idempotencyKey);
        const transactionHash = requireTransactionHash(request.transactionHash);
        const prepared = store.get(idempotencyKey);
        if (prepared === undefined || prepared.attemptId !== attemptId) {
          throw new Error(`Unknown prepared attempt for idempotency key "${idempotencyKey}".`);
        }
        const context = await atomicContextProvider(attemptId);
        if (!isRecord(context as unknown)) throw new Error("Atomic context provider returned an invalid context.");
        const atomicContext = context as EvmTestnetAtomicAttemptContext;
        const domains = admissionDomains(atomicContext.admission);
        requireTestnetDeployment(atomicContext.deployment);
        validateFinalityPolicy(atomicContext.finality as unknown as Parameters<typeof validateFinalityPolicy>[0]);
        if (
          domains.order.domainId !== prepared.preparation.domainId ||
          domains.order.domainManifestVersion !== prepared.preparation.domainManifestVersion ||
          toHex0x(domains.order.domainManifestHash, "domainManifestHash") !== prepared.preparation.domainManifestHash
        ) {
          throw new Error("Atomic observation context does not match the prepared attempt.");
        }
        const admissionHashes = atomicContext.admission as unknown as {
          orderHash: Uint8Array;
          quoteHash: Uint8Array;
          routeHash: Uint8Array;
        };
        if (
          toHex0x(admissionHashes.orderHash, "orderHash") !== prepared.preparation.orderHash ||
          toHex0x(admissionHashes.quoteHash, "quoteHash") !== prepared.preparation.quoteHash ||
          toHex0x(admissionHashes.routeHash, "routeHash") !== prepared.preparation.routeHash
        ) {
          throw new Error("Atomic observation context does not match the prepared attempt.");
        }
        requireAtomicBindingCoherence({
          binding: atomicContext.atomicBinding,
          admission: atomicContext.admission,
          deployment: atomicContext.deployment,
          orderHash: prepared.preparation.orderHash,
          quoteHash: prepared.preparation.quoteHash,
          routeHash: prepared.preparation.routeHash,
        });
        store.bindTransactionHash(idempotencyKey, transactionHash);
        const binding = atomicContext.atomicBinding;
        const observed = await observeEvmAtomicPackage(
          atomicReadPort,
          binding,
          transactionHash as Hex,
          atomicContext.finality,
        );
        return sanitizeAtomicObservation(
          observed as unknown as {
            lifecycle: string;
            evidenceGrade: string;
            chainReference: bigint;
            transactionHash: Hex | null;
            blockNumber: bigint | null;
            confirmations: number | null;
            receiptHash: Hex | null;
            packageReceipt: Record<string, unknown> | null;
            openPackage: Record<string, unknown> | null;
            reason: string | null;
          },
          { attemptId, idempotencyKey, transactionHash },
          domains.order,
        );
      },
    }),
    asyncObservation: createEvmTestnetAsyncObservationPort({
      contextProvider: asyncContextProvider,
      readPort: asyncReadPort,
    }),
  });
}
