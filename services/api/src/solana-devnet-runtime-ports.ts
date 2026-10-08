import { isAddress } from "@solana/addresses";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { createPublicKey, verify } from "node:crypto";
import { bytesEqual, enumDiscriminant, SETTLEMENT_CLASS } from "@naryx/protocol-types";
import type { DomainRef, PackageAdmission, SettlementClass, VersionedManifestRef } from "@naryx/protocol-types";
import type {
  FirmCashCarryBinding,
  SolanaObservedNettingInstruction,
  SolanaMaterializationRequest,
  UnsignedSolanaMaterialization,
} from "@naryx/adapter-solana";
import type {
  SolanaFinalizedNettingTransaction,
  SolanaNettingAllocationReadPort,
} from "./netting-allocation-observation-routes.js";
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

export type SolanaDevnetPostconditionBinding = Readonly<{
  coreProgram: string;
  receiptAccount: string;
  openPackageAccount: string;
  entryReceiptAccount: string;
  orderHashHex: string;
  quoteHashHex: string;
  routeHashHex: string;
  trader: string;
  solver: string;
  nonce: bigint;
  spotQuantityAtoms: bigint;
  perpQuantityAtoms: bigint;
  resourceAdmissionCommitmentHex: string;
  packageFillCommitmentHex: string;
  expectedOpenPackage?: Readonly<{
    quoteIntentCommitmentHex: string;
    routeAccountsCommitmentHex: string;
    economicPackageCommitmentHex: string;
    packageAccountsCommitmentHex: string;
  }>;
  /** Present for the NARYX_TEST_PERP venue: the trader's position must hold the exact short. */
  testPerpPosition?: SolanaDevnetTestPerpPositionBinding;
  recovery: boolean;
}>;

export type SolanaDevnetTestPerpPositionBinding = Readonly<{
  venueProgram: string;
  position: string;
  market: string;
  owner: string;
  delegate: string;
  /** Decimal i64 base lots expected after the action: the negative short after entry, "0" after exit. */
  expectedBaseLots: string;
}>;

export type SolanaDevnetPostconditionProof = Readonly<{
  action: SolanaDevnetLifecycleAction;
  finalizedSlot: number;
  accountContextSlot: number;
  receiptDataHashHex: string;
  openPackageDataHashHex: string | null;
}>;

export interface SolanaDevnetPostconditionVerifier {
  verify(record: PreparedSolanaDevnetRecord, finalizedSlot: number): Promise<SolanaDevnetPostconditionProof>;
}

export interface SolanaDevnetPackageLifecycleRecorder {
  recordPrepared(record: PreparedSolanaDevnetRecord): void | Promise<void>;
  recordObservation(
    record: PreparedSolanaDevnetRecord,
    observation: PrivateTerminalExecutionObservation,
  ): void | Promise<void>;
  recordPostcondition?(
    record: PreparedSolanaDevnetRecord,
    proof: SolanaDevnetPostconditionProof,
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
  postconditionBinding?: SolanaDevnetPostconditionBinding;
  lastValidBlockHeight: number;
  boundSignature: string | undefined;
}>;

export interface PreparedSolanaDevnetStore {
  get(idempotencyKey: string): PreparedSolanaDevnetRecord | undefined;
  save(
    request: NormalizedCashCarryExecutionRequest,
    materialization: UnsignedSolanaDevnetMaterializationDto,
    lifecycleBinding: SolanaDevnetLifecycleBinding,
    postconditionBinding?: SolanaDevnetPostconditionBinding,
  ): PreparedSolanaDevnetRecord;
  bindSignature(idempotencyKey: string, signature: string): PreparedSolanaDevnetRecord;
}

export type SolanaSignatureStatus = Readonly<{
  slot: number | null;
  confirmationStatus: string | null;
  err: unknown;
}>;

export type SolanaReadOnlyAccount = Readonly<{
  owner: string;
  data: Uint8Array;
}>;

export type SolanaReadOnlyAccountSnapshot = Readonly<{
  contextSlot: number;
  accounts: readonly (SolanaReadOnlyAccount | null)[];
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
  postconditionVerifier?: SolanaDevnetPostconditionVerifier;
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

function copyPostconditionBinding(value: SolanaDevnetPostconditionBinding): SolanaDevnetPostconditionBinding {
  const addresses = [value.coreProgram, value.receiptAccount, value.openPackageAccount, value.entryReceiptAccount, value.trader, value.solver];
  if (addresses.some((address) => !isAddress(address))) throw new Error("Postcondition binding contains an invalid Solana address.");
  const isExit = value.receiptAccount !== value.entryReceiptAccount;
  for (const [name, candidate, allowZero] of [
    ["orderHashHex", value.orderHashHex, false],
    ["quoteHashHex", value.quoteHashHex, false],
    ["routeHashHex", value.routeHashHex, false],
    ["resourceAdmissionCommitmentHex", value.resourceAdmissionCommitmentHex, false],
    ["packageFillCommitmentHex", value.packageFillCommitmentHex, isExit],
  ] as const) {
    if (!HEX_32_PATTERN.test(candidate) || (!allowZero && /^0+$/.test(candidate))) {
      throw new Error(`Postcondition binding ${name} is invalid.`);
    }
  }
  const u64Max = (1n << 64n) - 1n;
  for (const [name, candidate] of [
    ["nonce", value.nonce],
    ["spotQuantityAtoms", value.spotQuantityAtoms],
    ["perpQuantityAtoms", value.perpQuantityAtoms],
  ] as const) {
    if (typeof candidate !== "bigint" || candidate < 0n || candidate > u64Max) {
      throw new Error(`Postcondition binding ${name} is invalid.`);
    }
  }
  let expectedOpenPackage: SolanaDevnetPostconditionBinding["expectedOpenPackage"];
  if (value.expectedOpenPackage !== undefined) {
    for (const [name, candidate] of Object.entries(value.expectedOpenPackage)) {
      if (!HEX_32_PATTERN.test(candidate) || /^0+$/.test(candidate)) {
        throw new Error(`Postcondition binding ${name} is invalid.`);
      }
    }
    expectedOpenPackage = Object.freeze({ ...value.expectedOpenPackage });
  }
  let testPerpPosition: SolanaDevnetTestPerpPositionBinding | undefined;
  if (value.testPerpPosition !== undefined) {
    const position = value.testPerpPosition;
    if ([position.venueProgram, position.position, position.market, position.owner, position.delegate].some((address) => !isAddress(address))
      || !/^(?:0|-[1-9][0-9]{0,18})$/.test(position.expectedBaseLots)) {
      throw new Error("Postcondition binding test perp position is invalid.");
    }
    testPerpPosition = Object.freeze({ ...position });
  }
  return Object.freeze({
    ...value,
    ...(expectedOpenPackage === undefined ? {} : { expectedOpenPackage }),
    ...(testPerpPosition === undefined ? {} : { testPerpPosition }),
  });
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
  } else if (isFirmExit(binding)) {
    // A firm exit is its own admitted EXIT order; on Solana its entry receipt commitment is the
    // entry order hash, which keys the package lifecycle.
    action = "EXIT";
    if (orderAction !== "EXIT") throw new Error("Admission order action does not match exit request.");
    lifecycleDomain = asDomainRef((order as Record<string, unknown>).domain, "admission order domain");
    const settlementRaw = (order as Record<string, unknown>).settlementClass;
    if (settlementRaw !== "ATOMIC_POSTCONDITION") throw new Error("Firm exit settlement class is invalid.");
    settlementClass = settlementRaw;
    entryOrderHex = toEntryOrderHex((order as Record<string, unknown>).entryReceiptHash, "exit order entryReceiptHash");
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

function solanaAddress(value: unknown, name: string): string {
  const candidate = typeof value === "string"
    ? value
    : typeof value === "object" && value !== null && typeof (value as { toString?: unknown }).toString === "function"
      ? String(value)
      : "";
  if (!isAddress(candidate)) throw new Error(`${name} must be a valid Solana address.`);
  return candidate;
}

function testPerpPositionBinding(
  binding: FirmCashCarryBinding,
  accounts: Record<string, { address: unknown }>,
  trader: string,
  perpQuantityAtoms: bigint,
): { testPerpPosition?: SolanaDevnetTestPerpPositionBinding } {
  if ((binding as unknown as { perpVenueKind?: string }).perpVenueKind !== "NARYX_TEST_PERP") return {};
  const lot = binding.resources.perpBaseLotAtoms;
  if (typeof lot !== "bigint" || lot <= 0n || perpQuantityAtoms % lot !== 0n) {
    throw new Error("Postcondition test perp quantity is not an exact market lot.");
  }
  return {
    testPerpPosition: Object.freeze({
      venueProgram: solanaAddress(binding.deployments.perpVenue.programId, "postcondition perp venue program"),
      position: solanaAddress(accounts.testPerpPosition?.address, "postcondition test perp position"),
      market: solanaAddress(accounts.testPerpMarket?.address, "postcondition test perp market"),
      owner: trader,
      delegate: solanaAddress(accounts.riseStrategy?.address, "postcondition test perp strategy"),
      expectedBaseLots: (-(perpQuantityAtoms / lot)).toString(),
    }),
  };
}

/**
 * Firm exit evidence: the exit receipt at the exit order's receipt PDA naming the entry receipt
 * PDA of (trader, entry order hash), the open package closed, and the test perp position flat.
 */
function firmExitPostconditionBinding(
  admission: PackageAdmission,
  binding: FirmCashCarryBinding,
): SolanaDevnetPostconditionBinding {
  const accounts = binding.accounts as unknown as Record<string, { address: unknown }>;
  const trader = solanaAddress(accounts.trader?.address, "postcondition trader");
  const coreProgram = solanaAddress(binding.deployments.core.programId, "postcondition core program");
  const entryOrderHex = toEntryOrderHex(admission.order.entryReceiptHash, "exit order entryReceiptHash");
  const entryReceiptAccount = PublicKey.findProgramAddressSync(
    [Buffer.from("cash-carry-receipt"), new PublicKey(trader).toBuffer(), Buffer.from(entryOrderHex, "hex")],
    new PublicKey(coreProgram),
  )[0].toBase58();
  return Object.freeze({
    coreProgram,
    receiptAccount: solanaAddress(accounts.receipt?.address, "postcondition receipt account"),
    openPackageAccount: solanaAddress(accounts.openPackage?.address, "postcondition open package account"),
    entryReceiptAccount,
    orderHashHex: toCanonicalHex32(admission.orderHash, "postcondition order hash"),
    quoteHashHex: toCanonicalHex32(admission.quoteHash, "postcondition quote hash"),
    routeHashHex: toCanonicalHex32(admission.routeHash, "postcondition route hash"),
    trader,
    solver: solanaAddress(accounts.solver?.address, "postcondition solver"),
    nonce: binding.executionArgs.nonce,
    spotQuantityAtoms: binding.executionArgs.spotQuantityAtoms,
    perpQuantityAtoms: binding.executionArgs.perpQuantityAtoms,
    resourceAdmissionCommitmentHex: toCanonicalHex32(binding.resourceAdmissionCommitment, "postcondition resource admission"),
    packageFillCommitmentHex: toCanonicalHex32(binding.quoteArgs.expectedFillCommitment, "postcondition package fill"),
    ...testPerpPositionBinding(binding, accounts, trader, 0n),
    recovery: false,
  });
}

function deriveSolanaDevnetPostconditionBinding(args: Readonly<{
  request: NormalizedCashCarryExecutionRequest;
  admission: PackageAdmission;
  binding: FirmCashCarryBinding;
}>): SolanaDevnetPostconditionBinding {
  const { request, admission, binding } = args;
  if (request.mode === "exit" && isFirmExit(binding)) return firmExitPostconditionBinding(admission, binding);
  const exitSource = binding.publicExit;
  if (request.mode === "exit" && exitSource === undefined) throw new Error("Postcondition verification requires public exit evidence.");
  const source = request.mode === "entry" ? binding : exitSource!;
  const effectiveAdmission = request.mode === "entry" ? admission : exitSource!.admission;
  const accounts = source.accounts as unknown as Record<string, { address: unknown }>;
  const receiptAccount = solanaAddress(accounts.receipt?.address, "postcondition receipt account");
  const openPackageAccount = solanaAddress(accounts.openPackage?.address, "postcondition open package account");
  const trader = solanaAddress(accounts.trader?.address, "postcondition trader");
  const orderHashHex = toCanonicalHex32(effectiveAdmission.orderHash, "postcondition order hash");
  const quoteHashHex = toCanonicalHex32(effectiveAdmission.quoteHash, "postcondition quote hash");
  const routeHashHex = toCanonicalHex32(effectiveAdmission.routeHash, "postcondition route hash");
  if (request.mode === "entry") {
    const publicExit = binding.publicExit;
    const expectedOpenPackage = publicExit === undefined ? undefined : Object.freeze({
      quoteIntentCommitmentHex: toCanonicalHex32(publicExit.openPackage.quoteIntentCommitment, "open package quote intent"),
      routeAccountsCommitmentHex: toCanonicalHex32(publicExit.openPackage.entryRouteAccountsCommitment, "open package route accounts"),
      economicPackageCommitmentHex: toCanonicalHex32(publicExit.openPackage.economicPackageCommitment, "open package economic commitment"),
      packageAccountsCommitmentHex: toCanonicalHex32(publicExit.openPackage.packageAccountsCommitment, "open package accounts commitment"),
    });
    return Object.freeze({
      coreProgram: solanaAddress(binding.deployments.core.programId, "postcondition core program"),
      receiptAccount,
      openPackageAccount,
      entryReceiptAccount: receiptAccount,
      orderHashHex,
      quoteHashHex,
      routeHashHex,
      trader,
      solver: solanaAddress(accounts.solver?.address, "postcondition solver"),
      nonce: binding.executionArgs.nonce,
      spotQuantityAtoms: binding.executionArgs.spotQuantityAtoms,
      perpQuantityAtoms: binding.executionArgs.perpQuantityAtoms,
      resourceAdmissionCommitmentHex: toCanonicalHex32(binding.resourceAdmissionCommitment, "postcondition resource admission"),
      packageFillCommitmentHex: toCanonicalHex32(binding.quoteArgs.expectedFillCommitment, "postcondition package fill"),
      ...(expectedOpenPackage === undefined ? {} : { expectedOpenPackage }),
      ...testPerpPositionBinding(binding, accounts, trader, binding.executionArgs.perpQuantityAtoms),
      recovery: false,
    });
  }
  const exit = binding.publicExit!;
  const solver = exit.authorization.mode === "TRADER_RECOVERY"
    ? "11111111111111111111111111111111"
    : solanaAddress(exit.authorization.activeSolver, "postcondition solver");
  return Object.freeze({
    coreProgram: solanaAddress(exit.deployments.core.programId, "postcondition core program"),
    receiptAccount,
    openPackageAccount,
    entryReceiptAccount: solanaAddress(accounts.entryReceipt?.address, "postcondition entry receipt account"),
    orderHashHex,
    quoteHashHex,
    routeHashHex,
    trader,
    solver,
    nonce: exit.executionArgs.nonce,
    spotQuantityAtoms: exit.executionArgs.spotQuantityAtoms,
    perpQuantityAtoms: exit.executionArgs.perpQuantityAtoms,
    resourceAdmissionCommitmentHex: toCanonicalHex32(exit.resourceAdmissionCommitment, "postcondition resource admission"),
    packageFillCommitmentHex: "0".repeat(64),
    ...((exit as unknown as { perpVenueKind?: string }).perpVenueKind === "NARYX_TEST_PERP"
      ? testPerpPositionBinding(binding, accounts, trader, 0n)
      : {}),
    recovery: exit.authorization.mode === "TRADER_RECOVERY",
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
  postconditionBinding?: SolanaDevnetPostconditionBinding;
  lastValidBlockHeight: number;
  boundSignature: string | undefined;
}): PreparedSolanaDevnetRecord {
  return Object.freeze({
    request: copyRequest(record.request),
    materialization: copyDto(record.materialization),
    lifecycleBinding: copyLifecycleBinding(record.lifecycleBinding),
    ...(record.postconditionBinding === undefined ? {} : {
      postconditionBinding: copyPostconditionBinding(record.postconditionBinding),
    }),
    lastValidBlockHeight: record.lastValidBlockHeight,
    boundSignature: record.boundSignature,
  });
}

/** A firm exit binding carries action EXIT on the top-level binding; a public exit carries publicExit. */
function isFirmExit(binding: FirmCashCarryBinding): boolean {
  return (binding as unknown as { action?: unknown }).action === "EXIT";
}

function solanaDevnetPlanKind(
  request: NormalizedCashCarryExecutionRequest,
  binding: FirmCashCarryBinding,
): SolanaDevnetPlanKind {
  if (request.mode === "entry") {
    if (isFirmExit(binding)) throw new Error("Entry preparation received an exit binding.");
    return "TRADER_ENTRY";
  }
  return isFirmExit(binding) ? "TRADER_FIRM_EXIT" : "TRADER_RECOVERY_EXIT";
}

function mapToDto(
  materialization: UnsignedSolanaMaterialization,
  request: NormalizedCashCarryExecutionRequest,
  lifecycleBinding: SolanaDevnetLifecycleBinding,
  binding: FirmCashCarryBinding,
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
  const expectedPlanKind = solanaDevnetPlanKind(request, binding);
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
    postconditionBinding?: SolanaDevnetPostconditionBinding;
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
    postconditionBinding?: SolanaDevnetPostconditionBinding,
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
      if (JSON.stringify(existing.postconditionBinding, (_key, value) => typeof value === "bigint" ? value.toString() : value) !==
          JSON.stringify(postconditionBinding, (_key, value) => typeof value === "bigint" ? value.toString() : value)) {
        throw new Error(`Idempotency key "${request.idempotencyKey}" was already used with different postcondition binding.`);
      }
      return copyRecord(existing);
    }
    const stored = {
      request: copyRequest(request),
      materialization: checkedMaterialization,
      lifecycleBinding: copyLifecycleBinding(checkedBinding),
      ...(postconditionBinding === undefined ? {} : {
        postconditionBinding: copyPostconditionBinding(postconditionBinding),
      }),
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

export class HttpSolanaDevnetReadOnlyRpc implements SolanaDevnetReadOnlyRpc, SolanaNettingAllocationReadPort {
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

  async genesisHash(): Promise<string> {
    return this.getGenesisHash();
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

  async getMultipleAccounts(addresses: readonly string[], minContextSlot: number): Promise<SolanaReadOnlyAccountSnapshot> {
    if (addresses.length === 0 || addresses.some((address) => !isAddress(address))) {
      throw new Error("Solana account query contains an invalid address.");
    }
    if (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0) {
      throw new Error("Solana account query minContextSlot is invalid.");
    }
    const result = await this.call("getMultipleAccounts", [
      addresses,
      { commitment: "finalized", encoding: "base64", minContextSlot },
    ]);
    if (!isRecord(result)) throw new Error("Solana RPC getMultipleAccounts returned malformed result.");
    if (typeof result.context !== "object" || result.context === null || Array.isArray(result.context)) {
      throw new Error("Solana RPC getMultipleAccounts returned malformed context.");
    }
    const contextSlot = (result.context as Record<string, unknown>).slot;
    if (typeof contextSlot !== "number" || !Number.isSafeInteger(contextSlot) || contextSlot < minContextSlot) {
      throw new Error("Solana RPC getMultipleAccounts returned stale context.");
    }
    if (!Array.isArray(result.value) || result.value.length !== addresses.length) {
      throw new Error("Solana RPC getMultipleAccounts returned malformed accounts.");
    }
    const accounts = result.value.map((entry, index): SolanaReadOnlyAccount | null => {
      if (entry === null) return null;
      if (!isRecord(entry) || typeof entry.owner !== "string" || !isAddress(entry.owner) || entry.executable !== false) {
        throw new Error(`Solana RPC account ${index} is malformed.`);
      }
      if (!Array.isArray(entry.data) || entry.data.length !== 2 || entry.data[1] !== "base64" || typeof entry.data[0] !== "string") {
        throw new Error(`Solana RPC account ${index} data is malformed.`);
      }
      const data = Buffer.from(entry.data[0], "base64");
      if (data.length === 0 || data.toString("base64") !== entry.data[0]) {
        throw new Error(`Solana RPC account ${index} data is not canonical base64.`);
      }
      return Object.freeze({ owner: entry.owner, data: Uint8Array.from(data) });
    });
    return Object.freeze({ contextSlot, accounts: Object.freeze(accounts) });
  }

  async finalizedTransaction(signature: string): Promise<SolanaFinalizedNettingTransaction | null> {
    requireCanonicalSignature(signature);
    const result = await this.call("getTransaction", [
      signature,
      { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 },
    ]);
    if (result === null) return null;
    if (!isRecord(result) || typeof result.slot !== "number" || !Number.isSafeInteger(result.slot) || result.slot <= 0
      || !isRecord(result.transaction) || !isRecord(result.transaction.message) || !isRecord(result.meta)) {
      throw new Error("Solana RPC getTransaction returned malformed result.");
    }
    const message = result.transaction.message;
    const meta = result.meta;
    if (!Array.isArray(message.accountKeys) || message.accountKeys.some((key) => typeof key !== "string" || !isAddress(key))) {
      throw new Error("Solana RPC getTransaction returned malformed account keys.");
    }
    const loaded = meta.loadedAddresses;
    const loadedWritable: unknown[] = loaded === undefined || loaded === null
      ? []
      : isRecord(loaded) && Array.isArray(loaded.writable) ? loaded.writable : [];
    const loadedReadonly: unknown[] = loaded === undefined || loaded === null
      ? []
      : isRecord(loaded) && Array.isArray(loaded.readonly) ? loaded.readonly : [];
    if (loaded !== undefined && loaded !== null && (!isRecord(loaded)
      || !Array.isArray(loaded.writable) || !Array.isArray(loaded.readonly))) {
      throw new Error("Solana RPC getTransaction returned malformed loaded addresses.");
    }
    const allKeys = [...message.accountKeys, ...loadedWritable, ...loadedReadonly];
    if (allKeys.some((key) => typeof key !== "string" || !isAddress(key))) {
      throw new Error("Solana RPC getTransaction returned invalid loaded addresses.");
    }
    const decodeInstruction = (value: unknown): SolanaObservedNettingInstruction => {
      if (!isRecord(value)
        || typeof value.programIdIndex !== "number" || !Number.isSafeInteger(value.programIdIndex)
        || value.programIdIndex < 0 || value.programIdIndex >= allKeys.length
        || !Array.isArray(value.accounts)
        || value.accounts.some((index) => typeof index !== "number" || !Number.isSafeInteger(index)
          || index < 0 || index >= allKeys.length)
        || typeof value.data !== "string") {
        throw new Error("Solana RPC getTransaction returned malformed compiled instruction.");
      }
      let data: Uint8Array;
      try {
        data = bs58.decode(value.data);
        if (bs58.encode(data) !== value.data) throw new Error("noncanonical base58");
      } catch {
        throw new Error("Solana RPC getTransaction returned invalid instruction data.");
      }
      return Object.freeze({
        programId: allKeys[value.programIdIndex] as string,
        accounts: Object.freeze(value.accounts.map((index) => allKeys[index as number] as string)),
        data: Uint8Array.from(data),
      });
    };
    if (!Array.isArray(message.instructions)) {
      throw new Error("Solana RPC getTransaction returned malformed instructions.");
    }
    const instructions = message.instructions.map(decodeInstruction);
    if (meta.innerInstructions !== null && meta.innerInstructions !== undefined) {
      if (!Array.isArray(meta.innerInstructions)) {
        throw new Error("Solana RPC getTransaction returned malformed inner instructions.");
      }
      for (const group of meta.innerInstructions) {
        if (!isRecord(group) || !Array.isArray(group.instructions)) {
          throw new Error("Solana RPC getTransaction returned malformed inner instruction group.");
        }
        instructions.push(...group.instructions.map(decodeInstruction));
      }
    }
    return Object.freeze({
      slot: BigInt(result.slot),
      successful: meta.err === null,
      instructions: Object.freeze(instructions),
    });
  }

  async finalizedAccount(address: string): Promise<Readonly<{
    address: string;
    owner: string;
    data: Uint8Array;
  }> | null> {
    if (!isAddress(address)) throw new Error("Solana receipt address is invalid.");
    const result = await this.call("getAccountInfo", [
      address,
      { commitment: "finalized", encoding: "base64" },
    ]);
    if (!isRecord(result) || !("value" in result)) {
      throw new Error("Solana RPC getAccountInfo returned malformed result.");
    }
    if (result.value === null) return null;
    if (!isRecord(result.value) || typeof result.value.owner !== "string" || !isAddress(result.value.owner)
      || !Array.isArray(result.value.data) || result.value.data.length !== 2
      || result.value.data[1] !== "base64" || typeof result.value.data[0] !== "string") {
      throw new Error("Solana RPC getAccountInfo returned malformed account.");
    }
    const data = Buffer.from(result.value.data[0], "base64");
    if (data.toString("base64") !== result.value.data[0]) {
      throw new Error("Solana RPC getAccountInfo returned noncanonical account data.");
    }
    return Object.freeze({ address, owner: result.value.owner, data: Uint8Array.from(data) });
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
        // A stalled RPC endpoint fails the read instead of hanging a user's request.
        signal: AbortSignal.timeout(20_000),
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
  const postconditionVerifier = options.postconditionVerifier;
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
  if (postconditionVerifier !== undefined) {
    if (typeof postconditionVerifier.verify !== "function") {
      throw new Error("Postcondition verifier must expose verify.");
    }
    if (lifecycleRecorder === undefined || typeof lifecycleRecorder.recordPostcondition !== "function") {
      throw new Error("Postcondition verification requires a lifecycle recorder with recordPostcondition.");
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
          const expectedPlanKind = solanaDevnetPlanKind(snapshot, binding);
          const lifecycleBinding = deriveSolanaDevnetLifecycleBinding({
            request: snapshot,
            admission,
            binding,
          });
          const postconditionBinding = postconditionVerifier === undefined
            ? undefined
            : deriveSolanaDevnetPostconditionBinding({ request: snapshot, admission, binding });
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
          const dto = mapToDto(materialization, snapshot, lifecycleBinding, binding);
          store.save(snapshot, dto, lifecycleBinding, postconditionBinding);
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
        if (observation.lifecycle === "FINALIZED" && postconditionVerifier !== undefined) {
          const proof = await postconditionVerifier.verify(bound, observation.finalizedSlot);
          await lifecycleRecorder!.recordPostcondition!(bound, proof);
        }
        return observation;
      },
    }),
  });
}
