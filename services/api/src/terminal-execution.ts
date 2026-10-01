import { isAddress } from "@solana/addresses";
import { getCompiledTransactionMessageDecoder } from "@solana/transaction-messages";
import { getTransactionDecoder, getTransactionEncoder } from "@solana/transactions";
import bs58 from "bs58";
import { formatDecimalAtoms, parseDecimalAtoms } from "./decimal.js";
import { PRIVATE_TERMINAL_PACKAGE_MANIFEST_V1 as manifest } from "./private-terminal-manifest.js";
import {
  isPackageMode,
  isSlippageBps,
  type PackageMode,
  type SlippageBps,
} from "./terminal-types.js";

export const SOLANA_DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const PREPARE_KEYS = [
  "domain",
  "idempotencyKey",
  "mode",
  "quoteMode",
  "size",
  "slippageBps",
  "traderPublicKey",
] as const;
const OBSERVE_KEYS = ["idempotencyKey", "signature"] as const;
const MATERIALIZATION_KEYS = [
  "blockhashContextSlot",
  "domain",
  "domainManifestHash",
  "domainManifestVersion",
  "evidence",
  "genesisHash",
  "lastValidBlockHeight",
  "lifecycleAttemptId",
  "lookupTables",
  "messageBase64",
  "planKind",
  "recentBlockhash",
  "requestCommitment",
  "requiredSignerPubkeys",
  "transactionBase64",
] as const;
const EVIDENCE_KEYS = [
  "computeUnitLimit",
  "computeUnitLimitSource",
  "packetDataLimit",
  "resolvedAddressCount",
  "routeComputeUnitLimit",
  "serializedMessageBytes",
  "serializedTransactionBytes",
] as const;
const LOOKUP_KEYS = ["address", "addresses", "contentCommitment", "contextSlot"] as const;
const SIZE_PATTERN = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const HEX_32_PATTERN = /^[0-9a-f]{64}$/;
const MAX_TRANSACTION_BYTES = 1_232;
const MAX_RESOLVED_ADDRESSES = 64;
const MAX_ROUTE_COMPUTE_UNITS = 1_260_000;
const MAX_LOOKUP_TABLES = 8;
const MAX_REQUIRED_SIGNERS = 8;

export type PrivateTerminalExecutionMode = PackageMode;
export type PrivateTerminalExecutionQuoteMode = "coordinated_limits";

export type NormalizedCashCarryExecutionRequest = Readonly<{
  domain: "svm:devnet";
  mode: PrivateTerminalExecutionMode;
  sizeAtoms: string;
  slippageBps: SlippageBps;
  quoteMode: PrivateTerminalExecutionQuoteMode;
  traderPublicKey: string;
  idempotencyKey: string;
}>;

export type SolanaDevnetPlanKind = "TRADER_ENTRY" | "TRADER_RECOVERY_EXIT";

export type SolanaLookupCommitmentDto = Readonly<{
  address: string;
  addresses: readonly string[];
  contentCommitment: string;
  contextSlot: number;
}>;

export type SolanaMaterializationEvidenceDto = Readonly<{
  resolvedAddressCount: number;
  serializedMessageBytes: number;
  serializedTransactionBytes: number;
  packetDataLimit: 1232;
  computeUnitLimit: number;
  computeUnitLimitSource: "EXPLICIT";
  routeComputeUnitLimit: 1260000;
}>;

export type UnsignedSolanaDevnetMaterializationDto = Readonly<{
  domain: "svm:devnet";
  domainManifestVersion: number;
  domainManifestHash: string;
  planKind: SolanaDevnetPlanKind;
  messageBase64: string;
  transactionBase64: string;
  requiredSignerPubkeys: readonly string[];
  recentBlockhash: string;
  blockhashContextSlot: number;
  lastValidBlockHeight: number;
  lifecycleAttemptId: string;
  genesisHash: typeof SOLANA_DEVNET_GENESIS_HASH;
  lookupTables: readonly SolanaLookupCommitmentDto[];
  evidence: SolanaMaterializationEvidenceDto;
  requestCommitment: string;
}>;

export const SOLANA_DEVNET_LIFECYCLE_ATTEMPT_ID_PATTERN = /^solana-cash-carry-[0-9a-f]{64}$/;

export function isSolanaDevnetLifecycleAttemptId(value: unknown): value is string {
  return typeof value === "string" && SOLANA_DEVNET_LIFECYCLE_ATTEMPT_ID_PATTERN.test(value);
}

function requireLifecycleAttemptId(value: unknown): string {
  if (!isSolanaDevnetLifecycleAttemptId(value)) {
    throw new Error("lifecycleAttemptId must be a valid Solana devnet lifecycle attempt id");
  }
  return value;
}

export interface PrivateTerminalExecutionPreparationPort {
  prepare(
    request: NormalizedCashCarryExecutionRequest,
  ): Promise<UnsignedSolanaDevnetMaterializationDto>;
}

export type PrivateTerminalExecutionObservationRequest = Readonly<{
  idempotencyKey: string;
  signature: string;
}>;

export type PrivateTerminalExecutionObservation =
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

export interface PrivateTerminalExecutionObservationPort {
  observe(
    request: PrivateTerminalExecutionObservationRequest,
  ): Promise<PrivateTerminalExecutionObservation>;
}

export type PrivateTerminalExecutionPorts = Readonly<{
  preparation?: PrivateTerminalExecutionPreparationPort;
  observation?: PrivateTerminalExecutionObservationPort;
}>;

export class ExecutionValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExecutionValidationError";
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

function canonicalSize(atoms: bigint): string {
  const fixed = formatDecimalAtoms(atoms, manifest.baseDecimals);
  const [whole, fraction = ""] = fixed.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction.length === 0 ? whole! : `${whole}.${trimmedFraction}`;
}

function requireCanonicalSize(value: unknown): string {
  if (typeof value !== "string" || !SIZE_PATTERN.test(value)) {
    throw new ExecutionValidationError(
      "INVALID_SIZE",
      "Size must be a canonical positive decimal string with at most six decimal places.",
    );
  }
  const atoms = parseDecimalAtoms(value, manifest.baseDecimals);
  if (atoms <= 0n || atoms > manifest.maximumSizeAtoms || canonicalSize(atoms) !== value) {
    throw new ExecutionValidationError("INVALID_SIZE", "Size is outside the supported canonical range.");
  }
  return atoms.toString();
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ExecutionValidationError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency key must use 16 to 64 URL-safe characters.",
    );
  }
  return value;
}

function requireAddress(value: unknown, code: string, message: string): string {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new ExecutionValidationError(code, message);
  }
  return value;
}

function requireMaterializedAddress(value: unknown, name: string): string {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`${name} must be a valid Solana address`);
  }
  return value;
}

function requireSignature(value: unknown): string {
  if (typeof value !== "string") {
    throw new ExecutionValidationError("INVALID_SIGNATURE", "Signature must be canonical base58.");
  }
  try {
    const bytes = bs58.decode(value);
    if (bytes.length !== 64 || bs58.encode(bytes) !== value) throw new Error("invalid signature");
  } catch {
    throw new ExecutionValidationError("INVALID_SIGNATURE", "Signature must be canonical base58 for 64 bytes.");
  }
  return value;
}

export function parseExecutionPreparationRequest(value: unknown): NormalizedCashCarryExecutionRequest {
  if (!isRecord(value)) {
    throw new ExecutionValidationError("INVALID_BODY", "Request body must be a JSON object.");
  }
  if (!hasExactKeys(value, PREPARE_KEYS)) {
    throw new ExecutionValidationError(
      "INVALID_FIELDS",
      "Request must contain only domain, mode, size, slippageBps, quoteMode, traderPublicKey, and idempotencyKey.",
    );
  }
  if (value.domain !== "svm:devnet") {
    throw new ExecutionValidationError("INVALID_DOMAIN", "Execution preparation is limited to svm:devnet.");
  }
  if (!isPackageMode(value.mode)) {
    throw new ExecutionValidationError("INVALID_MODE", "Mode must be entry or exit.");
  }
  const sizeAtoms = requireCanonicalSize(value.size);
  if (!isSlippageBps(value.slippageBps)) {
    throw new ExecutionValidationError("INVALID_SLIPPAGE", "Slippage choice is not supported.");
  }
  if (value.quoteMode !== "coordinated_limits") {
    throw new ExecutionValidationError(
      "INVALID_QUOTE_MODE",
      "Execution preparation requires coordinated_limits.",
    );
  }
  return Object.freeze({
    domain: value.domain,
    mode: value.mode,
    sizeAtoms,
    slippageBps: value.slippageBps,
    quoteMode: value.quoteMode,
    traderPublicKey: requireAddress(
      value.traderPublicKey,
      "INVALID_TRADER_PUBLIC_KEY",
      "Trader public key must be a valid Solana address.",
    ),
    idempotencyKey: requireIdempotencyKey(value.idempotencyKey),
  });
}

export function parseExecutionObservationRequest(value: unknown): PrivateTerminalExecutionObservationRequest {
  if (!isRecord(value)) {
    throw new ExecutionValidationError("INVALID_BODY", "Request body must be a JSON object.");
  }
  if (!hasExactKeys(value, OBSERVE_KEYS)) {
    throw new ExecutionValidationError(
      "INVALID_FIELDS",
      "Request must contain only idempotencyKey and signature.",
    );
  }
  return Object.freeze({
    idempotencyKey: requireIdempotencyKey(value.idempotencyKey),
    signature: requireSignature(value.signature),
  });
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireNonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function requireNonzeroCommitment(value: unknown, name: string): string {
  if (typeof value !== "string" || !HEX_32_PATTERN.test(value) || /^0+$/.test(value)) {
    throw new Error(`${name} must be a nonzero lowercase 32-byte hex commitment`);
  }
  return value;
}

function decodeCanonicalBase64(value: unknown, name: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000 ||
      value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${name} must be canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`${name} must be canonical base64`);
  return bytes;
}

function validateLookupTables(value: unknown): readonly SolanaLookupCommitmentDto[] {
  if (!Array.isArray(value) || value.length > MAX_LOOKUP_TABLES) {
    throw new Error("lookupTables must be a bounded array");
  }
  const seen = new Set<string>();
  return Object.freeze(value.map((item, tableIndex) => {
    if (!isRecord(item) || !hasExactKeys(item, LOOKUP_KEYS)) {
      throw new Error(`lookupTables[${tableIndex}] has invalid fields`);
    }
    const address = requireMaterializedAddress(item.address, `lookupTables[${tableIndex}].address`);
    if (seen.has(address)) throw new Error("lookup table address is duplicated");
    seen.add(address);
    if (!Array.isArray(item.addresses) || item.addresses.length > 256) {
      throw new Error(`lookupTables[${tableIndex}].addresses is invalid`);
    }
    const addresses = Object.freeze(item.addresses.map((entry, addressIndex) => requireMaterializedAddress(
      entry,
      `lookupTables[${tableIndex}].addresses[${addressIndex}]`,
    )));
    if (new Set(addresses).size !== addresses.length) {
      throw new Error(`lookupTables[${tableIndex}].addresses contains duplicates`);
    }
    return Object.freeze({
      address,
      addresses,
      contentCommitment: requireNonzeroCommitment(
        item.contentCommitment,
        `lookupTables[${tableIndex}].contentCommitment`,
      ),
      contextSlot: requirePositiveInteger(item.contextSlot, `lookupTables[${tableIndex}].contextSlot`),
    });
  }));
}

function validateEvidence(value: unknown): SolanaMaterializationEvidenceDto {
  if (!isRecord(value) || !hasExactKeys(value, EVIDENCE_KEYS)) {
    throw new Error("materialization evidence has invalid fields");
  }
  const resolvedAddressCount = requirePositiveInteger(value.resolvedAddressCount, "resolvedAddressCount");
  const serializedMessageBytes = requirePositiveInteger(value.serializedMessageBytes, "serializedMessageBytes");
  const serializedTransactionBytes = requirePositiveInteger(
    value.serializedTransactionBytes,
    "serializedTransactionBytes",
  );
  const computeUnitLimit = requirePositiveInteger(value.computeUnitLimit, "computeUnitLimit");
  if (resolvedAddressCount > MAX_RESOLVED_ADDRESSES || serializedMessageBytes > MAX_TRANSACTION_BYTES ||
      serializedTransactionBytes > MAX_TRANSACTION_BYTES || value.packetDataLimit !== MAX_TRANSACTION_BYTES ||
      computeUnitLimit > MAX_ROUTE_COMPUTE_UNITS || value.computeUnitLimitSource !== "EXPLICIT" ||
      value.routeComputeUnitLimit !== MAX_ROUTE_COMPUTE_UNITS) {
    throw new Error("materialization evidence exceeds protocol limits");
  }
  return Object.freeze({
    resolvedAddressCount,
    serializedMessageBytes,
    serializedTransactionBytes,
    packetDataLimit: MAX_TRANSACTION_BYTES,
    computeUnitLimit,
    computeUnitLimitSource: "EXPLICIT",
    routeComputeUnitLimit: MAX_ROUTE_COMPUTE_UNITS,
  });
}

export function validateUnsignedSolanaDevnetMaterialization(
  value: unknown,
  request: NormalizedCashCarryExecutionRequest,
): UnsignedSolanaDevnetMaterializationDto {
  if (!isRecord(value) || !hasExactKeys(value, MATERIALIZATION_KEYS)) {
    throw new Error("materialization has invalid fields");
  }
  if (value.domain !== "svm:devnet" || value.genesisHash !== SOLANA_DEVNET_GENESIS_HASH) {
    throw new Error("materialization is not bound to Solana Devnet");
  }
  const expectedPlanKind: SolanaDevnetPlanKind = request.mode === "entry"
    ? "TRADER_ENTRY"
    : "TRADER_RECOVERY_EXIT";
  if (value.planKind !== expectedPlanKind) throw new Error("materialization plan kind does not match request mode");
  const domainManifestVersion = requirePositiveInteger(value.domainManifestVersion, "domainManifestVersion");
  const domainManifestHash = requireNonzeroCommitment(value.domainManifestHash, "domainManifestHash");
  const messageBytes = decodeCanonicalBase64(value.messageBase64, "messageBase64");
  const transactionBytes = decodeCanonicalBase64(value.transactionBase64, "transactionBase64");
  if (transactionBytes.length > MAX_TRANSACTION_BYTES) {
    throw new Error("materialized transaction exceeds the wire limit");
  }

  let transaction: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
  let compiledMessage: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    transaction = getTransactionDecoder().decode(transactionBytes);
    if (!Buffer.from(getTransactionEncoder().encode(transaction)).equals(transactionBytes)) {
      throw new Error("transaction encoding is not canonical");
    }
    if (!Buffer.from(transaction.messageBytes).equals(messageBytes)) {
      throw new Error("message bytes do not match transaction");
    }
    compiledMessage = getCompiledTransactionMessageDecoder().decode(messageBytes);
  } catch {
    throw new Error("materialized transaction encoding is invalid");
  }
  if (compiledMessage.version !== 0) throw new Error("materialized transaction must use a v0 message");

  const signerEntries = Object.entries(transaction.signatures);
  if (signerEntries.length === 0 || signerEntries.length > MAX_REQUIRED_SIGNERS ||
      signerEntries.some(([, signature]) => signature !== null)) {
    throw new Error("materialized transaction must contain only zero signatures");
  }
  if (!Array.isArray(value.requiredSignerPubkeys) ||
      value.requiredSignerPubkeys.length !== signerEntries.length) {
    throw new Error("required signer list does not match transaction");
  }
  const requiredSignerPubkeys = Object.freeze(value.requiredSignerPubkeys.map((entry, index) => {
    const signer = requireMaterializedAddress(entry, `requiredSignerPubkeys[${index}]`);
    if (signer !== signerEntries[index]?.[0]) throw new Error("required signer order does not match transaction");
    return signer;
  }));
  if (requiredSignerPubkeys[0] !== request.traderPublicKey ||
      !requiredSignerPubkeys.includes(request.traderPublicKey)) {
    throw new Error("trader must be the required transaction payer and signer");
  }
  if (compiledMessage.header.numSignerAccounts !== requiredSignerPubkeys.length ||
      compiledMessage.staticAccounts.slice(0, requiredSignerPubkeys.length)
        .some((address, index) => address !== requiredSignerPubkeys[index])) {
    throw new Error("compiled signer accounts do not match required signers");
  }

  const recentBlockhash = requireMaterializedAddress(value.recentBlockhash, "recentBlockhash");
  if (compiledMessage.lifetimeToken !== recentBlockhash) {
    throw new Error("recent blockhash does not match compiled message");
  }
  const lookupTables = validateLookupTables(value.lookupTables);
  const compiledLookups = compiledMessage.addressTableLookups ?? [];
  if (compiledLookups.length !== lookupTables.length) {
    throw new Error("lookup commitments do not match compiled message");
  }
  let resolvedAddressCount = compiledMessage.staticAccounts.length;
  for (const [index, lookup] of compiledLookups.entries()) {
    const commitment = lookupTables[index];
    if (commitment === undefined || commitment.address !== lookup.lookupTableAddress) {
      throw new Error("lookup commitment order does not match compiled message");
    }
    const selectedIndexes = [...lookup.writableIndexes, ...lookup.readonlyIndexes];
    if (selectedIndexes.some((selectedIndex) => selectedIndex >= commitment.addresses.length)) {
      throw new Error("compiled lookup index exceeds committed table contents");
    }
    resolvedAddressCount += selectedIndexes.length;
  }
  if (resolvedAddressCount > MAX_RESOLVED_ADDRESSES) {
    throw new Error("materialized transaction exceeds the account limit");
  }

  const evidence = validateEvidence(value.evidence);
  if (evidence.resolvedAddressCount !== resolvedAddressCount ||
      evidence.serializedMessageBytes !== messageBytes.length ||
      evidence.serializedTransactionBytes !== transactionBytes.length) {
    throw new Error("materialization evidence does not match transaction bytes");
  }
  const base = {
    domain: "svm:devnet",
    domainManifestVersion,
    domainManifestHash,
    planKind: expectedPlanKind,
    messageBase64: value.messageBase64 as string,
    transactionBase64: value.transactionBase64 as string,
    requiredSignerPubkeys,
    recentBlockhash,
    blockhashContextSlot: requirePositiveInteger(value.blockhashContextSlot, "blockhashContextSlot"),
    lastValidBlockHeight: requirePositiveInteger(value.lastValidBlockHeight, "lastValidBlockHeight"),
    lifecycleAttemptId: requireLifecycleAttemptId(value.lifecycleAttemptId),
    genesisHash: SOLANA_DEVNET_GENESIS_HASH,
    lookupTables,
    evidence,
    requestCommitment: requireNonzeroCommitment(value.requestCommitment, "requestCommitment"),
  } as const;
  return Object.freeze(base);
}

export function validateExecutionObservation(
  value: unknown,
  request: PrivateTerminalExecutionObservationRequest,
): PrivateTerminalExecutionObservation {
  if (!isRecord(value) || value.signature !== request.signature) {
    throw new Error("observation does not match requested signature");
  }
  if (value.lifecycle === "SUBMITTED") {
    if (!hasExactKeys(value, ["lifecycle", "observedSlot", "signature"]) ||
        (value.observedSlot !== null &&
          (typeof value.observedSlot !== "number" || !Number.isSafeInteger(value.observedSlot) || value.observedSlot < 0))) {
      throw new Error("submitted observation is invalid");
    }
    return Object.freeze({
      lifecycle: "SUBMITTED",
      signature: request.signature,
      observedSlot: value.observedSlot,
    });
  }
  if (value.lifecycle === "FINALIZED") {
    if (!hasExactKeys(value, ["finalizedSlot", "lifecycle", "signature"])) {
      throw new Error("finalized observation is invalid");
    }
    return Object.freeze({
      lifecycle: "FINALIZED",
      signature: request.signature,
      finalizedSlot: requireNonnegativeInteger(value.finalizedSlot, "finalizedSlot"),
    });
  }
  if (value.lifecycle === "FAILED") {
    if (!hasExactKeys(value, ["failedSlot", "failureCode", "lifecycle", "signature"]) ||
        (value.failedSlot !== null &&
          (typeof value.failedSlot !== "number" || !Number.isSafeInteger(value.failedSlot) || value.failedSlot < 0)) ||
        typeof value.failureCode !== "string" || !FAILURE_CODE_PATTERN.test(value.failureCode)) {
      throw new Error("failed observation is invalid");
    }
    return Object.freeze({
      lifecycle: "FAILED",
      signature: request.signature,
      failedSlot: value.failedSlot,
      failureCode: value.failureCode,
    });
  }
  if (value.lifecycle === "EXPIRED") {
    if (!hasExactKeys(value, ["lastValidBlockHeight", "lifecycle", "observedBlockHeight", "signature"])) {
      throw new Error("expired observation is invalid");
    }
    const lastValidBlockHeight = requirePositiveInteger(
      value.lastValidBlockHeight,
      "lastValidBlockHeight",
    );
    const observedBlockHeight = requirePositiveInteger(value.observedBlockHeight, "observedBlockHeight");
    if (observedBlockHeight <= lastValidBlockHeight) {
      throw new Error("expired observation has not crossed last valid block height");
    }
    return Object.freeze({
      lifecycle: "EXPIRED",
      signature: request.signature,
      lastValidBlockHeight,
      observedBlockHeight,
    });
  }
  throw new Error("observation lifecycle is unsupported");
}
