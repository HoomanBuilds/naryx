import { isAddress } from "@solana/addresses";
import bs58 from "bs58";
import { createPublicKey, verify } from "node:crypto";
import { bytesEqual, enumDiscriminant, SETTLEMENT_CLASS } from "@naryx/protocol-types";
import type { DomainRef, PackageAdmission, SettlementClass, VersionedManifestRef } from "@naryx/protocol-types";
import type {
  FirmCashCarryBinding,
  SolanaMaterializationRequest,
  UnsignedSolanaMaterialization,
} from "@naryx/adapter-solana";
import {
  isSolanaDevnetLifecycleAttemptId,
  SOLANA_DEVNET_GENESIS_HASH,
  validateUnsignedSolanaDevnetMaterialization,
} from "./terminal-execution.js";
import type {
  NormalizedCashCarryExecutionRequest,
  PrivateTerminalExecutionObservation,
  PrivateTerminalExecutionObservationRequest,
  PrivateTerminalExecutionPorts,
  SolanaDevnetPlanKind,
  UnsignedSolanaDevnetMaterializationDto,
} from "./terminal-execution.js";

export const SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SOLANA_FAILURE_CODE = "SOLANA_TRANSACTION_ERROR";
const HEX_32_PATTERN = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const LIFECYCLE_ID_PREFIX = "solana-cash-carry-";

export type SolanaDevnetLifecycleAction = "ENTRY" | "EXIT";

export type SolanaDevnetLifecycleBinding = Readonly<{
  attemptId: string;
  packageId: string;
  packageCommitmentHex: string;
  action: SolanaDevnetLifecycleAction;
  domain: DomainRef;
  settlementClass: SettlementClass;
  evidenceSource: VersionedManifestRef;
}>;

export interface SolanaDevnetPackageLifecycleRecorder {
  recordPrepared(record: PreparedSolanaDevnetRecord): void | Promise<void>;
  recordObservation(
    record: PreparedSolanaDevnetRecord,
    observation: PrivateTerminalExecutionObservation,
  ): void | Promise<void>;
}

export type SolanaDevnetExecutionContext = Readonly<{
  admission: PackageAdmission;
  binding: FirmCashCarryBinding;
}>;

export type SolanaDevnetContextProvider = (
  request: NormalizedCashCarryExecutionRequest,
) => Promise<SolanaDevnetExecutionContext> | SolanaDevnetExecutionContext;

export interface SolanaDevnetMaterializer {
  materialize(input: SolanaMaterializationRequest): Promise<UnsignedSolanaMaterialization>;
}

export type PreparedSolanaDevnetRecord = Readonly<{
  request: NormalizedCashCarryExecutionRequest;
  materialization: UnsignedSolanaDevnetMaterializationDto;
  lifecycleBinding: SolanaDevnetLifecycleBinding;
  lastValidBlockHeight: number;
  boundSignature: string | undefined;
}>;

export interface PreparedSolanaDevnetStore {
  get(idempotencyKey: string): PreparedSolanaDevnetRecord | undefined;
  save(
    request: NormalizedCashCarryExecutionRequest,
    materialization: UnsignedSolanaDevnetMaterializationDto,
    lifecycleBinding: SolanaDevnetLifecycleBinding,
  ): PreparedSolanaDevnetRecord;
  bindSignature(idempotencyKey: string, signature: string): PreparedSolanaDevnetRecord;
}

export type SolanaSignatureStatus = Readonly<{
  slot: number | null;
  confirmationStatus: string | null;
  err: unknown;
}>;

export interface SolanaDevnetReadOnlyRpc {
  getGenesisHash(): Promise<string>;
  getSignatureStatus(signature: string): Promise<SolanaSignatureStatus | null>;
  getBlockHeight(): Promise<number>;
}

export type SolanaDevnetRuntimePortsOptions = Readonly<{
  contextProvider: SolanaDevnetContextProvider;
  materializer: SolanaDevnetMaterializer;
  store: PreparedSolanaDevnetStore;
  rpc: SolanaDevnetReadOnlyRpc;
  lifecycleRecorder?: SolanaDevnetPackageLifecycleRecorder;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireCanonicalSignature(value: unknown): string {
  if (typeof value !== "string") throw new Error("Signature must be canonical base58.");
  try {
    const bytes = bs58.decode(value);
    if (bytes.length !== 64 || bs58.encode(bytes) !== value) throw new Error("invalid signature");
  } catch {
    throw new Error("Signature must be canonical base58 for 64 bytes.");
  }
  return value;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifyPreparedTraderSignature(
  prepared: PreparedSolanaDevnetRecord,
  signature: string,
): void {
  try {
    const signer = prepared.materialization.requiredSignerPubkeys[0];
    if (typeof signer !== "string") throw new Error("invalid signer");
    const rawPubkey = bs58.decode(signer);
    if (rawPubkey.length !== 32) throw new Error("invalid signer");
    const messageBytes = Buffer.from(prepared.materialization.messageBase64, "base64");
    if (messageBytes.length === 0) throw new Error("invalid message");
    const signatureBytes = bs58.decode(signature);
    if (signatureBytes.length !== 64) throw new Error("invalid signature");
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPubkey)]),
      format: "der",
      type: "spki",
    });
    const ok = verify(null, messageBytes, publicKey, Buffer.from(signatureBytes));
    if (!ok) throw new Error("invalid signature");
  } catch {
    throw new Error("Signature is not a valid trader signature for the prepared message.");
  }
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new Error("Idempotency key must use 16 to 64 URL-safe characters.");
  }
  return value;
}

function requestsEqual(
  left: NormalizedCashCarryExecutionRequest,
  right: NormalizedCashCarryExecutionRequest,
): boolean {
  return left.domain === right.domain &&
    left.mode === right.mode &&
    left.sizeAtoms === right.sizeAtoms &&
    left.slippageBps === right.slippageBps &&
    left.quoteMode === right.quoteMode &&
    left.traderPublicKey === right.traderPublicKey &&
    left.idempotencyKey === right.idempotencyKey;
}

function toCanonicalHex32(value: string | Uint8Array, name: string): string {
  if (value instanceof Uint8Array) {
    if (value.length !== 32 || value.every((byte) => byte === 0)) {
      throw new Error(`${name} must be 32 nonzero bytes.`);
    }
    return Buffer.from(value).toString("hex");
  }
  if (typeof value === "string" && HEX_32_PATTERN.test(value) && !/^0+$/.test(value)) {
    return value;
  }
  throw new Error(`${name} must be canonical lowercase 32-byte hex.`);
}

function asDomainRef(value: unknown, name: string): DomainRef {
  if (!isRecord(value)) throw new Error(`${name} must be an object.`);
  if (typeof value.domainId !== "string" || value.domainId.length === 0) {
    throw new Error(`${name} domain id is invalid.`);
  }
  if (typeof value.domainManifestVersion !== "number" ||
      !Number.isSafeInteger(value.domainManifestVersion) ||
      value.domainManifestVersion <= 0) {
    throw new Error(`${name} manifest version must be a positive integer.`);
  }
  const hash = value.domainManifestHash;
  if (!(hash instanceof Uint8Array) || hash.length !== 32 || hash.every((byte) => byte === 0)) {
    throw new Error(`${name} manifest hash must be 32 nonzero bytes.`);
  }
  return value as unknown as DomainRef;
}

function requireSameDomain(left: DomainRef, right: DomainRef, name: string): void {
  if (left.domainId !== right.domainId ||
      left.domainManifestVersion !== right.domainManifestVersion ||
      !bytesEqual(left.domainManifestHash, right.domainManifestHash)) {
    throw new Error(`${name} domain mismatch.`);
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
    throw new Error("Execution context must carry admission and binding.");
  }
  if (order.environment !== "devnet" ||
      quote.environment !== "devnet" ||
      route.environment !== "devnet") {
    throw new Error("Execution context admission environment must be Devnet.");
  }
  return {
    order: asDomainRef(order.domain, "admission order domain"),
    quote: asDomainRef(quote.domain, "admission quote domain"),
    route: asDomainRef(route.domain, "admission route domain"),
  };
}

function bindingDomain(binding: FirmCashCarryBinding): DomainRef | undefined {
  if (!isRecord(binding as unknown)) {
    throw new Error("Execution context must carry admission and binding.");
  }
  const candidate = binding as unknown as Record<string, unknown>;
  if ("environment" in candidate) {
    if (candidate.environment !== "devnet") {
      throw new Error("Execution context binding environment must be Devnet.");
    }
  }
  if ("domain" in candidate && candidate.domain !== undefined) {
    return asDomainRef(candidate.domain, "binding domain");
  }
  return undefined;
}

function copyDto(
  dto: UnsignedSolanaDevnetMaterializationDto,
): UnsignedSolanaDevnetMaterializationDto {
  if (!isSolanaDevnetLifecycleAttemptId(dto.lifecycleAttemptId)) {
    throw new Error("Materialization lifecycle attempt is invalid.");
  }
  return Object.freeze({
    domain: dto.domain,
    domainManifestVersion: dto.domainManifestVersion,
    domainManifestHash: dto.domainManifestHash,
    planKind: dto.planKind,
    messageBase64: dto.messageBase64,
    transactionBase64: dto.transactionBase64,
    requiredSignerPubkeys: Object.freeze([...dto.requiredSignerPubkeys]),
    recentBlockhash: dto.recentBlockhash,
    blockhashContextSlot: dto.blockhashContextSlot,
    lastValidBlockHeight: dto.lastValidBlockHeight,
    lifecycleAttemptId: dto.lifecycleAttemptId,
    genesisHash: dto.genesisHash,
    lookupTables: Object.freeze(dto.lookupTables.map((table) =>
      Object.freeze({
        address: table.address,
        addresses: Object.freeze([...table.addresses]),
        contentCommitment: table.contentCommitment,
        contextSlot: table.contextSlot,
      })
    )),
    evidence: Object.freeze({ ...dto.evidence }),
    requestCommitment: dto.requestCommitment,
  });
}

function copyDomainRef(domain: DomainRef): DomainRef {
  return Object.freeze({
    domainId: domain.domainId,
    domainManifestVersion: domain.domainManifestVersion,
    domainManifestHash: Uint8Array.from(domain.domainManifestHash),
  }) as unknown as DomainRef;
}

function copyEvidenceSource(source: VersionedManifestRef): VersionedManifestRef {
  return Object.freeze({
    subjectId: source.subjectId,
    manifestVersion: source.manifestVersion,
    manifestHash: Uint8Array.from(source.manifestHash),
  }) as unknown as VersionedManifestRef;
}

function copyLifecycleBinding(binding: SolanaDevnetLifecycleBinding): SolanaDevnetLifecycleBinding {
  return Object.freeze({
    attemptId: binding.attemptId,
    packageId: binding.packageId,
    packageCommitmentHex: binding.packageCommitmentHex,
    action: binding.action,
    domain: copyDomainRef(binding.domain),
    settlementClass: binding.settlementClass,
    evidenceSource: copyEvidenceSource(binding.evidenceSource),
  });
}

function lifecycleBindingsEqual(
  left: SolanaDevnetLifecycleBinding,
  right: SolanaDevnetLifecycleBinding,
): boolean {
  return left.attemptId === right.attemptId &&
    left.packageId === right.packageId &&
    left.packageCommitmentHex === right.packageCommitmentHex &&
    left.action === right.action &&
    left.domain.domainId === right.domain.domainId &&
    left.domain.domainManifestVersion === right.domain.domainManifestVersion &&
    bytesEqual(left.domain.domainManifestHash, right.domain.domainManifestHash) &&
    left.settlementClass === right.settlementClass &&
    left.evidenceSource.subjectId === right.evidenceSource.subjectId &&
    left.evidenceSource.manifestVersion === right.evidenceSource.manifestVersion &&
    bytesEqual(left.evidenceSource.manifestHash, right.evidenceSource.manifestHash);
}

function requireLifecycleBinding(value: unknown): SolanaDevnetLifecycleBinding {
  if (!isRecord(value)) throw new Error("Lifecycle binding must be an object.");
  const candidate = value as Record<string, unknown>;
  if (!isSolanaDevnetLifecycleAttemptId(candidate.attemptId)) {
    throw new Error("Lifecycle binding attempt id is invalid.");
  }
  if (!isSolanaDevnetLifecycleAttemptId(candidate.packageId)) {
    throw new Error("Lifecycle binding package id is invalid.");
  }
  if (typeof candidate.packageCommitmentHex !== "string" ||
      !HEX_32_PATTERN.test(candidate.packageCommitmentHex) ||
      /^0+$/.test(candidate.packageCommitmentHex)) {
    throw new Error("Lifecycle binding package commitment is invalid.");
  }
  if (candidate.action !== "ENTRY" && candidate.action !== "EXIT") {
    throw new Error("Lifecycle binding action must be ENTRY or EXIT.");
  }
  const domain = asDomainRef(candidate.domain, "lifecycle binding domain");
  if (typeof candidate.settlementClass !== "string") {
    throw new Error("Lifecycle binding settlement class is invalid.");
  }
  try {
    enumDiscriminant(SETTLEMENT_CLASS, candidate.settlementClass as SettlementClass, "lifecycle settlementClass");
  } catch {
    throw new Error("Lifecycle binding settlement class is invalid.");
  }
  if (!isRecord(candidate.evidenceSource)) {
    throw new Error("Lifecycle binding evidence source is invalid.");
  }
  const source = candidate.evidenceSource as Record<string, unknown>;
  if (typeof source.subjectId !== "string" || source.subjectId.length === 0) {
    throw new Error("Lifecycle binding evidence source is invalid.");
  }
  if (typeof source.manifestVersion !== "number" ||
      !Number.isSafeInteger(source.manifestVersion) ||
      source.manifestVersion <= 0) {
    throw new Error("Lifecycle binding evidence source is invalid.");
  }
  const manifestHash = source.manifestHash;
  if (!(manifestHash instanceof Uint8Array) || manifestHash.length !== 32 ||
      manifestHash.every((byte) => byte === 0)) {
    throw new Error("Lifecycle binding evidence source is invalid.");
  }
  const expectedPrefix = `${LIFECYCLE_ID_PREFIX}${candidate.packageCommitmentHex as string}`;
  if (candidate.attemptId !== expectedPrefix || candidate.packageId !== expectedPrefix) {
    throw new Error("Lifecycle binding identity does not match its commitment.");
  }
  return Object.freeze({
    attemptId: candidate.attemptId as string,
    packageId: candidate.packageId as string,
    packageCommitmentHex: candidate.packageCommitmentHex as string,
    action: candidate.action as SolanaDevnetLifecycleAction,
    domain: copyDomainRef(domain),
    settlementClass: candidate.settlementClass as SettlementClass,
    evidenceSource: Object.freeze({
      subjectId: source.subjectId as VersionedManifestRef["subjectId"],
      manifestVersion: source.manifestVersion as number,
      manifestHash: Uint8Array.from(manifestHash),
    }) as unknown as VersionedManifestRef,
  });
}

function toEntryOrderHex(value: unknown, name: string): string {
  if (value instanceof Uint8Array) {
    if (value.length !== 32 || value.every((byte) => byte === 0)) {
      throw new Error(`${name} must be 32 nonzero bytes.`);
    }
    return Buffer.from(value).toString("hex");
  }
  if (typeof value === "string" && HEX_32_PATTERN.test(value) && !/^0+$/.test(value)) {
    return value;
  }
  throw new Error(`${name} must be canonical lowercase 32-byte hex.`);
}

function publicExitAdmissionDomains(admission: unknown): {
  order: DomainRef;
  quote: DomainRef;
  route: DomainRef;
} {
  if (!isRecord(admission)) {
    throw new Error("Exit preparation requires public exit admission.");
  }
  const order = (admission as Record<string, unknown>).order;
  const quote = (admission as Record<string, unknown>).quote;
  const route = (admission as Record<string, unknown>).route;
  if (!isRecord(order) || !isRecord(quote) || !isRecord(route)) {
    throw new Error("Exit preparation requires public exit admission.");
  }
  if (order.environment !== "devnet" ||
      quote.environment !== "devnet" ||
      route.environment !== "devnet") {
    throw new Error("Public exit admission environment must be Devnet.");
  }
  return {
    order: asDomainRef(order.domain, "public exit admission order domain"),
    quote: asDomainRef(quote.domain, "public exit admission quote domain"),
    route: asDomainRef(route.domain, "public exit admission route domain"),
  };
}

export function deriveSolanaDevnetLifecycleBinding(args: Readonly<{
  request: NormalizedCashCarryExecutionRequest;
  admission: PackageAdmission;
  binding: FirmCashCarryBinding;
}>): SolanaDevnetLifecycleBinding {
  const request = args.request;
  const admission = args.admission;
  const binding = args.binding;
  if (!isRecord(admission as unknown) || !isRecord(binding as unknown)) {
    throw new Error("Execution context must carry admission and binding.");
  }
  const order = (admission as unknown as Record<string, unknown>).order;
  if (!isRecord(order)) throw new Error("Execution context admission order is invalid.");
  const orderAction = (order as Record<string, unknown>).action;
  let entryOrderHex: string;
  let action: SolanaDevnetLifecycleAction;
  let lifecycleDomain: DomainRef;
  let settlementClass: SettlementClass;
  if (request.mode === "entry") {
    action = "ENTRY";
    if (orderAction !== undefined && orderAction !== "ENTRY") {
      throw new Error("Admission order action does not match entry request.");
    }
    lifecycleDomain = asDomainRef(
      (order as Record<string, unknown>).domain,
      "admission order domain",
    );
    const settlementRaw = (order as Record<string, unknown>).settlementClass;
    if (typeof settlementRaw !== "string") {
      throw new Error("Admission order settlement class is invalid.");
    }
    try {
      enumDiscriminant(SETTLEMENT_CLASS, settlementRaw as SettlementClass, "admission settlementClass");
    } catch {
      throw new Error("Admission order settlement class is invalid.");
    }
    settlementClass = settlementRaw as SettlementClass;
    const orderHash = (admission as unknown as Record<string, unknown>).orderHash;
    entryOrderHex = toEntryOrderHex(orderHash, "admission orderHash");
  } else {
    action = "EXIT";
    // Top-level admission is historical entry evidence; effective exit order is publicExit.admission.order.
    if (orderAction !== undefined && orderAction !== "ENTRY") {
      throw new Error("Admission order action does not match exit request.");
    }
    const publicExit = (binding as unknown as Record<string, unknown>).publicExit;
    if (!isRecord(publicExit)) {
      throw new Error("Exit preparation requires public exit evidence.");
    }
    const entryReceipt = (publicExit as Record<string, unknown>).entryReceipt;
    if (!isRecord(entryReceipt)) {
      throw new Error("Exit preparation requires public exit evidence.");
    }
    entryOrderHex = toEntryOrderHex(
      (entryReceipt as Record<string, unknown>).orderHash,
      "public exit entry receipt orderHash",
    );
    const exitAdmission = (publicExit as Record<string, unknown>).admission;
    const exitDomains = publicExitAdmissionDomains(exitAdmission);
    requireSameDomain(exitDomains.quote, exitDomains.order, "Public exit admission quote");
    requireSameDomain(exitDomains.route, exitDomains.order, "Public exit admission route");
    const exitOrder = (exitAdmission as Record<string, unknown>).order as Record<string, unknown>;
    if (exitOrder.action !== "EXIT") {
      throw new Error("Public exit admission order action does not match exit request.");
    }
    const exitSettlementRaw = exitOrder.settlementClass;
    if (typeof exitSettlementRaw !== "string") {
      throw new Error("Public exit admission order settlement class is invalid.");
    }
    try {
      enumDiscriminant(SETTLEMENT_CLASS, exitSettlementRaw as SettlementClass, "public exit admission settlementClass");
    } catch {
      throw new Error("Public exit admission order settlement class is invalid.");
    }
    settlementClass = exitSettlementRaw as SettlementClass;
    lifecycleDomain = exitDomains.order;
    const activeDomain = asDomainRef(
      (publicExit as Record<string, unknown>).activeDomain,
      "public exit active domain",
    );
    if (activeDomain.domainId !== lifecycleDomain.domainId) {
      throw new Error("public exit active domain identity mismatch");
    }
  }
  const identity = `${LIFECYCLE_ID_PREFIX}${entryOrderHex}`;
  if (!isSolanaDevnetLifecycleAttemptId(identity)) {
    throw new Error("Derived lifecycle identity is invalid.");
  }
  return Object.freeze({
    attemptId: identity,
    packageId: identity,
    packageCommitmentHex: entryOrderHex,
    action,
    domain: copyDomainRef(lifecycleDomain),
    settlementClass,
    evidenceSource: Object.freeze({
      subjectId: lifecycleDomain.domainId,
      manifestVersion: lifecycleDomain.domainManifestVersion,
      manifestHash: Uint8Array.from(lifecycleDomain.domainManifestHash),
    }) as unknown as VersionedManifestRef,
  });
}

function copyRequest(
  request: NormalizedCashCarryExecutionRequest,
): NormalizedCashCarryExecutionRequest {
  return Object.freeze({
    domain: request.domain,
    mode: request.mode,
    sizeAtoms: request.sizeAtoms,
    slippageBps: request.slippageBps,
    quoteMode: request.quoteMode,
    traderPublicKey: request.traderPublicKey,
    idempotencyKey: request.idempotencyKey,
  });
}

function copyRecord(record: {
  request: NormalizedCashCarryExecutionRequest;
  materialization: UnsignedSolanaDevnetMaterializationDto;
  lifecycleBinding: SolanaDevnetLifecycleBinding;
  lastValidBlockHeight: number;
  boundSignature: string | undefined;
}): PreparedSolanaDevnetRecord {
  return Object.freeze({
    request: copyRequest(record.request),
    materialization: copyDto(record.materialization),
    lifecycleBinding: copyLifecycleBinding(record.lifecycleBinding),
    lastValidBlockHeight: record.lastValidBlockHeight,
    boundSignature: record.boundSignature,
  });
}

function mapToDto(
  materialization: UnsignedSolanaMaterialization,
  request: NormalizedCashCarryExecutionRequest,
  lifecycleBinding: SolanaDevnetLifecycleBinding,
): UnsignedSolanaDevnetMaterializationDto {
  if (!isRecord(materialization as unknown)) {
    throw new Error("Materialization must be an object.");
  }
  const domain = asDomainRef(
    (materialization as unknown as Record<string, unknown>).domain,
    "materialization domain",
  );
  if (domain.domainId !== "svm:devnet") {
    throw new Error("Materialization domain must be svm:devnet.");
  }
  if (materialization.genesisHash === SOLANA_MAINNET_GENESIS_HASH) {
    throw new Error("Materialization rejects mainnet-beta genesis.");
  }
  if (materialization.genesisHash !== SOLANA_DEVNET_GENESIS_HASH) {
    throw new Error("Materialization genesis must be Solana Devnet.");
  }
  const expectedPlanKind: SolanaDevnetPlanKind = request.mode === "entry"
    ? "TRADER_ENTRY"
    : "TRADER_RECOVERY_EXIT";
  if (materialization.planKind !== expectedPlanKind) {
    throw new Error("Materialization plan kind does not match request mode.");
  }
  if (!isAddress(request.traderPublicKey)) {
    throw new Error("Trader public key must be a valid Solana address.");
  }
  if (!Array.isArray(materialization.requiredSignerPubkeys) ||
      materialization.requiredSignerPubkeys.length === 0) {
    throw new Error("Materialization must carry required signers.");
  }
  const firstSigner = materialization.requiredSignerPubkeys[0];
  if (firstSigner !== request.traderPublicKey ||
      !materialization.requiredSignerPubkeys.includes(request.traderPublicKey)) {
    throw new Error("Trader must be the required transaction payer and signer.");
  }
  const domainManifestHash = toCanonicalHex32(domain.domainManifestHash, "domainManifestHash");
  const requestCommitment = toCanonicalHex32(materialization.requestCommitment, "requestCommitment");
  const evidence = materialization.evidence;
  if (!isRecord(evidence as unknown)) {
    throw new Error("Materialization evidence must be an object.");
  }
  if (evidence.computeUnitLimitSource !== "EXPLICIT") {
    throw new Error("Materialization compute units must be explicit.");
  }
  if (evidence.packetDataLimit !== 1232 || evidence.routeComputeUnitLimit !== 1260000) {
    throw new Error("Materialization evidence exceeds protocol limits.");
  }
  if (typeof evidence.computeUnitLimit !== "number" ||
      !Number.isSafeInteger(evidence.computeUnitLimit) ||
      evidence.computeUnitLimit <= 0 ||
      evidence.computeUnitLimit > 1260000) {
    throw new Error("Materialization compute unit limit is out of range.");
  }
  if (!Array.isArray(materialization.lookupTables)) {
    throw new Error("Materialization lookup tables must be an array.");
  }
  const lookupTables = materialization.lookupTables.map((table) => ({
    address: table.address,
    addresses: [...table.addresses],
    contentCommitment: toCanonicalHex32(table.contentCommitment, "lookup contentCommitment"),
    contextSlot: table.contextSlot,
  }));
  const candidate = {
    domain: domain.domainId,
    domainManifestVersion: domain.domainManifestVersion,
    domainManifestHash,
    planKind: materialization.planKind,
    messageBase64: materialization.messageBase64,
    transactionBase64: materialization.transactionBase64,
    requiredSignerPubkeys: [...materialization.requiredSignerPubkeys],
    recentBlockhash: materialization.recentBlockhash,
    blockhashContextSlot: materialization.blockhashContextSlot,
    lastValidBlockHeight: materialization.lastValidBlockHeight,
    lifecycleAttemptId: lifecycleBinding.attemptId,
    genesisHash: materialization.genesisHash,
    lookupTables,
    evidence: {
      resolvedAddressCount: evidence.resolvedAddressCount,
      serializedMessageBytes: evidence.serializedMessageBytes,
      serializedTransactionBytes: evidence.serializedTransactionBytes,
      packetDataLimit: evidence.packetDataLimit,
      computeUnitLimit: evidence.computeUnitLimit,
      computeUnitLimitSource: evidence.computeUnitLimitSource,
      routeComputeUnitLimit: evidence.routeComputeUnitLimit,
    },
    requestCommitment,
  };
  return validateUnsignedSolanaDevnetMaterialization(candidate, request);
}

function requireDevnetGenesis(genesis: string): void {
  if (genesis === SOLANA_MAINNET_GENESIS_HASH) {
    throw new Error("RPC genesis is mainnet-beta and is rejected.");
  }
  if (genesis !== SOLANA_DEVNET_GENESIS_HASH) {
    throw new Error("RPC genesis is not Solana Devnet.");
  }
}

export class InMemoryPreparedSolanaDevnetStore implements PreparedSolanaDevnetStore {
  private readonly records = new Map<string, {
    request: NormalizedCashCarryExecutionRequest;
    materialization: UnsignedSolanaDevnetMaterializationDto;
    lifecycleBinding: SolanaDevnetLifecycleBinding;
    lastValidBlockHeight: number;
    boundSignature: string | undefined;
  }>();

  get(idempotencyKey: string): PreparedSolanaDevnetRecord | undefined {
    requireIdempotencyKey(idempotencyKey);
    const record = this.records.get(idempotencyKey);
    return record === undefined ? undefined : copyRecord(record);
  }

  save(
    request: NormalizedCashCarryExecutionRequest,
    materialization: UnsignedSolanaDevnetMaterializationDto,
    lifecycleBinding: SolanaDevnetLifecycleBinding,
  ): PreparedSolanaDevnetRecord {
    requireIdempotencyKey(request.idempotencyKey);
    const checkedBinding = requireLifecycleBinding(lifecycleBinding);
    const checkedMaterialization = copyDto(materialization);
    if (checkedMaterialization.lifecycleAttemptId !== checkedBinding.attemptId) {
      throw new Error("Materialization lifecycle attempt does not match its binding.");
    }
    const existing = this.records.get(request.idempotencyKey);
    if (existing !== undefined) {
      if (!requestsEqual(existing.request, request)) {
        throw new Error(`Idempotency key "${request.idempotencyKey}" was already used with different request fields.`);
      }
      if (!lifecycleBindingsEqual(existing.lifecycleBinding, checkedBinding)) {
        throw new Error(`Idempotency key "${request.idempotencyKey}" was already used with different lifecycle binding.`);
      }
      return copyRecord(existing);
    }
    const stored = {
      request: copyRequest(request),
      materialization: checkedMaterialization,
      lifecycleBinding: copyLifecycleBinding(checkedBinding),
      lastValidBlockHeight: materialization.lastValidBlockHeight,
      boundSignature: undefined as string | undefined,
    };
    this.records.set(request.idempotencyKey, stored);
    return copyRecord(stored);
  }

  bindSignature(idempotencyKey: string, signature: string): PreparedSolanaDevnetRecord {
    requireIdempotencyKey(idempotencyKey);
    const canonical = requireCanonicalSignature(signature);
    const record = this.records.get(idempotencyKey);
    if (record === undefined) throw new Error(`Unknown idempotency key "${idempotencyKey}".`);
    if (record.boundSignature === undefined) {
      record.boundSignature = canonical;
      return copyRecord(record);
    }
    if (record.boundSignature !== canonical) {
      throw new Error(`Idempotency key "${idempotencyKey}" is already bound to a different signature.`);
    }
    return copyRecord(record);
  }
}

export class HttpSolanaDevnetReadOnlyRpc implements SolanaDevnetReadOnlyRpc {
  private readonly endpoint: string;
  private nextId = 1;

  constructor(endpoint: string) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error("Solana RPC endpoint must be a valid URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Solana RPC endpoint must use HTTP or HTTPS.");
    }
    if (url.username !== "" || url.password !== "") {
      throw new Error("Solana RPC endpoint must not embed credentials.");
    }
    this.endpoint = url.toString();
  }

  async getGenesisHash(): Promise<string> {
    const result = await this.call("getGenesisHash", []);
    if (typeof result !== "string" || result.length === 0) {
      throw new Error("Solana RPC getGenesisHash returned malformed result.");
    }
    return result;
  }

  async getSignatureStatus(signature: string): Promise<SolanaSignatureStatus | null> {
    requireCanonicalSignature(signature);
    const result = await this.call("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
    if (!isRecord(result as unknown as Record<string, unknown>)) {
      throw new Error("Solana RPC getSignatureStatuses returned malformed result.");
    }
    const candidate = result as unknown as Record<string, unknown>;
    if (!Array.isArray(candidate.value) || candidate.value.length !== 1) {
      throw new Error("Solana RPC getSignatureStatuses returned malformed result.");
    }
    const entry = candidate.value[0];
    if (entry === null) return null;
    if (!isRecord(entry as unknown as Record<string, unknown>)) {
      throw new Error("Solana RPC getSignatureStatuses returned malformed result.");
    }
    const status = entry as unknown as Record<string, unknown>;
    let slot: number | null = null;
    if (status.slot !== null) {
      if (typeof status.slot !== "number" || !Number.isSafeInteger(status.slot) || status.slot < 0) {
        throw new Error("Solana RPC getSignatureStatuses returned malformed slot.");
      }
      slot = status.slot;
    }
    let confirmationStatus: string | null = null;
    if (status.confirmationStatus !== null && status.confirmationStatus !== undefined) {
      if (typeof status.confirmationStatus !== "string") {
        throw new Error("Solana RPC getSignatureStatuses returned malformed confirmation.");
      }
      confirmationStatus = status.confirmationStatus;
    }
    return Object.freeze({ slot, confirmationStatus, err: status.err ?? null });
  }

  async getBlockHeight(): Promise<number> {
    const result = await this.call("getBlockHeight", [{ commitment: "finalized" }]);
    if (typeof result === "number") {
      if (!Number.isSafeInteger(result) || result < 0) {
        throw new Error("Solana RPC getBlockHeight returned malformed result.");
      }
      return result;
    }
    if (isRecord(result as unknown as Record<string, unknown>)) {
      const candidate = result as unknown as Record<string, unknown>;
      if (typeof candidate.value === "number" &&
          Number.isSafeInteger(candidate.value) &&
          candidate.value >= 0) {
        return candidate.value;
      }
    }
    throw new Error("Solana RPC getBlockHeight returned malformed result.");
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
    } catch {
      throw new Error(`Solana RPC ${method} request failed.`);
    }
    if (!response.ok) throw new Error(`Solana RPC ${method} failed with status ${response.status}.`);
    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      throw new Error(`Solana RPC ${method} returned invalid JSON.`);
    }
    if (!isRecord(payload)) throw new Error(`Solana RPC ${method} returned malformed envelope.`);
    if (payload.jsonrpc !== "2.0" || payload.id !== id) {
      throw new Error(`Solana RPC ${method} returned malformed id.`);
    }
    if ("error" in payload && payload.error !== null && payload.error !== undefined) {
      throw new Error(`Solana RPC ${method} returned an error.`);
    }
    if (!("result" in payload) || payload.result === undefined) {
      throw new Error(`Solana RPC ${method} returned malformed result.`);
    }
    return payload.result;
  }
}

export function createSolanaDevnetExecutionPorts(
  options: SolanaDevnetRuntimePortsOptions,
): PrivateTerminalExecutionPorts {
  const contextProvider = options.contextProvider;
  const materializer = options.materializer;
  const store = options.store;
  const rpc = options.rpc;
  const lifecycleRecorder = options.lifecycleRecorder;
  if (typeof contextProvider !== "function") throw new Error("Context provider must be a function.");
  if (typeof materializer?.materialize !== "function") throw new Error("Materializer must expose materialize.");
  if (typeof store?.get !== "function" || typeof store?.save !== "function" ||
      typeof store?.bindSignature !== "function") {
    throw new Error("Prepared store must expose get, save, and bindSignature.");
  }
  if (typeof rpc?.getGenesisHash !== "function" || typeof rpc?.getSignatureStatus !== "function" ||
      typeof rpc?.getBlockHeight !== "function") {
    throw new Error("Read-only RPC must expose genesis, status, and block height.");
  }
  if (lifecycleRecorder !== undefined) {
    if (typeof (lifecycleRecorder as SolanaDevnetPackageLifecycleRecorder).recordPrepared !== "function" ||
        typeof (lifecycleRecorder as SolanaDevnetPackageLifecycleRecorder).recordObservation !== "function") {
      throw new Error("Lifecycle recorder must expose recordPrepared and recordObservation.");
    }
  }
  const inFlight = new Map<string, {
    request: NormalizedCashCarryExecutionRequest;
    promise: Promise<UnsignedSolanaDevnetMaterializationDto>;
  }>();

  async function recordPreparedOrFail(record: PreparedSolanaDevnetRecord): Promise<void> {
    if (lifecycleRecorder === undefined) return;
    await lifecycleRecorder.recordPrepared(record);
  }

  async function recordObservationOrFail(
    record: PreparedSolanaDevnetRecord,
    observation: PrivateTerminalExecutionObservation,
  ): Promise<void> {
    if (lifecycleRecorder === undefined) return;
    await lifecycleRecorder.recordObservation(record, observation);
  }

  return Object.freeze({
    preparation: Object.freeze({
      prepare: async (request: NormalizedCashCarryExecutionRequest) => {
        requireIdempotencyKey(request.idempotencyKey);
        const cached = store.get(request.idempotencyKey);
        if (cached !== undefined) {
          if (!requestsEqual(cached.request, request)) {
            throw new Error(`Idempotency key "${request.idempotencyKey}" was already used with different request fields.`);
          }
          await recordPreparedOrFail(cached);
          return copyDto(cached.materialization);
        }
        const ongoing = inFlight.get(request.idempotencyKey);
        if (ongoing !== undefined) {
          if (!requestsEqual(ongoing.request, request)) {
            throw new Error(`Idempotency key "${request.idempotencyKey}" was already used with different request fields.`);
          }
          const awaited = copyDto(await ongoing.promise);
          const replayed = store.get(request.idempotencyKey);
          if (replayed === undefined) throw new Error("Prepared execution was not stored.");
          await recordPreparedOrFail(replayed);
          return awaited;
        }
        const snapshot = copyRequest(request);
        const task: Promise<UnsignedSolanaDevnetMaterializationDto> = (async () => {
          const expectedPlanKind: SolanaDevnetPlanKind = snapshot.mode === "entry"
            ? "TRADER_ENTRY"
            : "TRADER_RECOVERY_EXIT";
          const context = await contextProvider(snapshot);
          if (!isRecord(context as unknown)) {
            throw new Error("Execution context provider returned an invalid context.");
          }
          const admission = (context as SolanaDevnetExecutionContext).admission;
          const binding = (context as SolanaDevnetExecutionContext).binding;
          if (!isRecord(admission as unknown) || !isRecord(binding as unknown)) {
            throw new Error("Execution context must carry admission and binding.");
          }
          const domains = admissionDomains(admission);
          const boundDomain = bindingDomain(binding);
          if (boundDomain !== undefined) {
            requireSameDomain(domains.order, boundDomain, "Admission order");
            requireSameDomain(domains.quote, boundDomain, "Admission quote");
            requireSameDomain(domains.route, boundDomain, "Admission route");
          } else {
            requireSameDomain(domains.quote, domains.order, "Admission quote");
            requireSameDomain(domains.route, domains.order, "Admission route");
          }
          const lifecycleBinding = deriveSolanaDevnetLifecycleBinding({
            request: snapshot,
            admission,
            binding,
          });
          const materialization = await materializer.materialize({
            planKind: expectedPlanKind,
            admission,
            binding,
          });
          if (!isRecord(materialization as unknown)) {
            throw new Error("Materialization must be an object.");
          }
          const materialDomain = asDomainRef(
            (materialization as unknown as Record<string, unknown>).domain,
            "materialization domain",
          );
          requireSameDomain(domains.order, materialDomain, "Admission order");
          requireSameDomain(domains.quote, materialDomain, "Admission quote");
          requireSameDomain(domains.route, materialDomain, "Admission route");
          if (boundDomain !== undefined) {
            requireSameDomain(boundDomain, materialDomain, "Binding");
          }
          const dto = mapToDto(materialization, snapshot, lifecycleBinding);
          store.save(snapshot, dto, lifecycleBinding);
          const stored = store.get(snapshot.idempotencyKey);
          if (stored === undefined) throw new Error("Prepared execution was not stored.");
          return copyDto(stored.materialization);
        })();
        inFlight.set(request.idempotencyKey, { request: snapshot, promise: task });
        try {
          const result = await task;
          const stored = store.get(request.idempotencyKey);
          if (stored === undefined) throw new Error("Prepared execution was not stored.");
          await recordPreparedOrFail(stored);
          return copyDto(result);
        } finally {
          inFlight.delete(request.idempotencyKey);
        }
      },
    }),
    observation: Object.freeze({
      observe: async (
        request: PrivateTerminalExecutionObservationRequest,
      ): Promise<PrivateTerminalExecutionObservation> => {
        requireIdempotencyKey(request.idempotencyKey);
        const signature = requireCanonicalSignature(request.signature);
        const prepared = store.get(request.idempotencyKey);
        if (prepared === undefined) throw new Error(`Unknown idempotency key "${request.idempotencyKey}".`);
        verifyPreparedTraderSignature(prepared, signature);
        const bound = store.bindSignature(request.idempotencyKey, signature);
        requireDevnetGenesis(await rpc.getGenesisHash());
        const status = await rpc.getSignatureStatus(signature);
        let observation: PrivateTerminalExecutionObservation;
        if (status !== null && status.err !== null && status.err !== undefined) {
          observation = Object.freeze({
            lifecycle: "FAILED",
            signature,
            failedSlot: status.slot,
            failureCode: SOLANA_FAILURE_CODE,
          });
        } else if (status !== null && status.confirmationStatus === "finalized" &&
            (status.err === null || status.err === undefined)) {
          if (status.slot === null) throw new Error("Finalized status is missing its slot.");
          observation = Object.freeze({ lifecycle: "FINALIZED", signature, finalizedSlot: status.slot });
        } else if (status === null) {
          const observedBlockHeight = await rpc.getBlockHeight();
          if (observedBlockHeight > bound.lastValidBlockHeight) {
            observation = Object.freeze({
              lifecycle: "EXPIRED",
              signature,
              lastValidBlockHeight: bound.lastValidBlockHeight,
              observedBlockHeight,
            });
          } else {
            observation = Object.freeze({ lifecycle: "SUBMITTED", signature, observedSlot: null });
          }
        } else {
          observation = Object.freeze({ lifecycle: "SUBMITTED", signature, observedSlot: status.slot });
        }
        await recordObservationOrFail(bound, observation);
        return observation;
      },
    }),
  });
}
