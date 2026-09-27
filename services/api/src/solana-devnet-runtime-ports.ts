import { isAddress } from "@solana/addresses";
import bs58 from "bs58";
import { createPublicKey, verify } from "node:crypto";
import { bytesEqual } from "@naryx/protocol-types";
import type { DomainRef, PackageAdmission } from "@naryx/protocol-types";
import type {
  FirmCashCarryBinding,
  SolanaMaterializationRequest,
  UnsignedSolanaMaterialization,
} from "@naryx/adapter-solana";
import {
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
  lastValidBlockHeight: number;
  boundSignature: string | undefined;
}>;

export interface PreparedSolanaDevnetStore {
  get(idempotencyKey: string): PreparedSolanaDevnetRecord | undefined;
  save(
    request: NormalizedCashCarryExecutionRequest,
    materialization: UnsignedSolanaDevnetMaterializationDto,
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
  lastValidBlockHeight: number;
  boundSignature: string | undefined;
}): PreparedSolanaDevnetRecord {
  return Object.freeze({
    request: copyRequest(record.request),
    materialization: copyDto(record.materialization),
    lastValidBlockHeight: record.lastValidBlockHeight,
    boundSignature: record.boundSignature,
  });
}

function mapToDto(
  materialization: UnsignedSolanaMaterialization,
  request: NormalizedCashCarryExecutionRequest,
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
  ): PreparedSolanaDevnetRecord {
    requireIdempotencyKey(request.idempotencyKey);
    const existing = this.records.get(request.idempotencyKey);
    if (existing !== undefined) {
      if (!requestsEqual(existing.request, request)) {
        throw new Error(`Idempotency key "${request.idempotencyKey}" was already used with different request fields.`);
      }
      return copyRecord(existing);
    }
    const stored = {
      request: copyRequest(request),
      materialization: copyDto(materialization),
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
  const inFlight = new Map<string, {
    request: NormalizedCashCarryExecutionRequest;
    promise: Promise<UnsignedSolanaDevnetMaterializationDto>;
  }>();

  return Object.freeze({
    preparation: Object.freeze({
      prepare: async (request: NormalizedCashCarryExecutionRequest) => {
        requireIdempotencyKey(request.idempotencyKey);
        const cached = store.get(request.idempotencyKey);
        if (cached !== undefined) {
          if (!requestsEqual(cached.request, request)) {
            throw new Error(`Idempotency key "${request.idempotencyKey}" was already used with different request fields.`);
          }
          return copyDto(cached.materialization);
        }
        const ongoing = inFlight.get(request.idempotencyKey);
        if (ongoing !== undefined) {
          if (!requestsEqual(ongoing.request, request)) {
            throw new Error(`Idempotency key "${request.idempotencyKey}" was already used with different request fields.`);
          }
          return copyDto(await ongoing.promise);
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
          const dto = mapToDto(materialization, snapshot);
          store.save(snapshot, dto);
          const stored = store.get(snapshot.idempotencyKey);
          if (stored === undefined) throw new Error("Prepared execution was not stored.");
          return copyDto(stored.materialization);
        })();
        inFlight.set(request.idempotencyKey, { request: snapshot, promise: task });
        try {
          const result = await task;
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
        if (status !== null && status.err !== null && status.err !== undefined) {
          return Object.freeze({
            lifecycle: "FAILED",
            signature,
            failedSlot: status.slot,
            failureCode: SOLANA_FAILURE_CODE,
          });
        }
        if (status !== null && status.confirmationStatus === "finalized" &&
            (status.err === null || status.err === undefined)) {
          if (status.slot === null) throw new Error("Finalized status is missing its slot.");
          return Object.freeze({ lifecycle: "FINALIZED", signature, finalizedSlot: status.slot });
        }
        if (status === null) {
          const observedBlockHeight = await rpc.getBlockHeight();
          if (observedBlockHeight > bound.lastValidBlockHeight) {
            return Object.freeze({
              lifecycle: "EXPIRED",
              signature,
              lastValidBlockHeight: bound.lastValidBlockHeight,
              observedBlockHeight,
            });
          }
          return Object.freeze({ lifecycle: "SUBMITTED", signature, observedSlot: null });
        }
        return Object.freeze({ lifecycle: "SUBMITTED", signature, observedSlot: status.slot });
      },
    }),
  });
}
