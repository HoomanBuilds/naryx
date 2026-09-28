import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import bs58 from "bs58";
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  type AuthenticatedConformanceExecution,
  type ConformancePosition,
  type ConformanceReceipt,
} from "@naryx/adapter-solana";
import {
  bytesEqual,
  fromProtocolJson,
  packageOrderHash,
  quoteHash,
  routeHash,
  routePayload,
  solverQuote,
  type PackageAdmission,
  type DomainRef,
  type RoutePayloadInput,
  type SolverQuoteInput,
} from "@naryx/protocol-types";
import type { SolanaLocalEnvironmentManifest } from "@naryx/adapter-core";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";

const ATTEMPT_ID = /^local-atomic-[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export interface SolanaLocalExecutionAuthorization {
  readonly version: 1;
  readonly attemptId: string;
  readonly executionDigest: string;
  readonly solverSignature: string;
}

export interface SolanaLocalExecutionAuthorizationPort {
  authorize(attemptId: string): Promise<SolanaLocalExecutionAuthorization>;
}

export class HttpSolanaLocalExecutionAuthorizationClient
implements SolanaLocalExecutionAuthorizationPort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(origin: string, fetchImplementation: typeof fetch = fetch) {
    const url = new URL(origin);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname.startsWith("127.");
    if (url.protocol !== "http:" || !loopback || url.username !== "" || url.password !== ""
      || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new Error("Solana authorization endpoint must be a loopback HTTP origin.");
    }
    this.#origin = url.origin;
    this.#fetch = fetchImplementation;
  }

  async authorize(attemptId: string): Promise<SolanaLocalExecutionAuthorization> {
    if (!ATTEMPT_ID.test(attemptId)) throw new Error("Solana attempt ID is invalid.");
    const response = await this.#fetch(`${this.#origin}/internal/solana/execution-authorizations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
      throw new Error(`Solana authorization endpoint returned HTTP ${response.status}.`);
    }
    const value = await response.json() as Record<string, unknown>;
    if (value.version !== 1 || value.attemptId !== attemptId
      || typeof value.executionDigest !== "string" || !HASH.test(value.executionDigest)
      || typeof value.solverSignature !== "string" || !/^[0-9a-f]{128}$/.test(value.solverSignature)) {
      throw new Error("Solana authorization response is invalid.");
    }
    return value as unknown as SolanaLocalExecutionAuthorization;
  }
}

export interface SolanaLocalPreparedExecution {
  readonly version: 1;
  readonly attemptId: string;
  readonly action: "ENTRY" | "EXIT";
  readonly lifecycleAttemptId: string;
  readonly status: "PREPARED" | "SIGNED" | "SUBMITTED_UNKNOWN" | "SUBMITTED" | "CONSENSUS_VERIFIED" | "FAILED";
  readonly unsignedTransactionBase64: string;
  readonly messageBase64: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: number;
  readonly trader: string;
  readonly receiptAddress: string;
  readonly nonceMarkerAddress: string;
  readonly signature: string | null;
}

export interface SolanaLocalPreparedExecutionStore {
  savePrepared(record: SolanaLocalPreparedExecution): SolanaLocalPreparedExecution;
  get(attemptId: string): SolanaLocalPreparedExecution | undefined;
  getByReceiptAddress(receiptAddress: string): SolanaLocalPreparedExecution | undefined;
  update(attemptId: string, status: SolanaLocalPreparedExecution["status"], signature: string): SolanaLocalPreparedExecution;
  close(): void;
}

let cachedRoot: string | undefined;
function repositoryRoot(): string | undefined {
  if (cachedRoot !== undefined) return cachedRoot;
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, ".git"))) return cachedRoot = current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export class SqliteSolanaLocalPreparedExecutionStore implements SolanaLocalPreparedExecutionStore {
  readonly #db: Database.Database;

  constructor(value: string) {
    if (!isAbsolute(value) || value === ":memory:") throw new Error("Solana preparation database path must be absolute.");
    const path = resolve(value);
    const root = repositoryRoot();
    if (root !== undefined && (path === root || path.startsWith(root + sep))) {
      throw new Error("Solana preparation database must remain outside the repository.");
    }
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS solana_local_preparations (
        attempt_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      );
    `);
  }

  savePrepared(record: SolanaLocalPreparedExecution): SolanaLocalPreparedExecution {
    const json = JSON.stringify(record);
    this.#db.prepare(`
      INSERT INTO solana_local_preparations (attempt_id, record_json) VALUES (?, ?)
      ON CONFLICT(attempt_id) DO NOTHING
    `).run(record.attemptId, json);
    const stored = this.get(record.attemptId);
    if (stored === undefined || stored.messageBase64 !== record.messageBase64
      || stored.unsignedTransactionBase64 !== record.unsignedTransactionBase64) {
      throw new Error("Solana attempt already has a different durable preparation.");
    }
    return stored;
  }

  get(attemptId: string): SolanaLocalPreparedExecution | undefined {
    if (!ATTEMPT_ID.test(attemptId)) throw new Error("Solana attempt ID is invalid.");
    const row = this.#db.prepare("SELECT record_json FROM solana_local_preparations WHERE attempt_id = ?")
      .get(attemptId) as { record_json?: unknown } | undefined;
    if (row === undefined) return undefined;
    if (typeof row.record_json !== "string") throw new Error("Stored Solana preparation is invalid.");
    const value = JSON.parse(row.record_json) as SolanaLocalPreparedExecution;
    if (value.version !== 1 || value.attemptId !== attemptId || typeof value.messageBase64 !== "string"
      || typeof value.unsignedTransactionBase64 !== "string" || typeof value.trader !== "string"
      || (value.action !== "ENTRY" && value.action !== "EXIT")
      || typeof value.lifecycleAttemptId !== "string" || !ATTEMPT_ID.test(value.lifecycleAttemptId)
      || typeof value.receiptAddress !== "string" || typeof value.nonceMarkerAddress !== "string") {
      throw new Error("Stored Solana preparation is invalid.");
    }
    return Object.freeze(value);
  }

  getByReceiptAddress(receiptAddress: string): SolanaLocalPreparedExecution | undefined {
    new PublicKey(receiptAddress);
    const rows = this.#db.prepare("SELECT record_json FROM solana_local_preparations").all() as { record_json?: unknown }[];
    const matches = rows.map((row) => {
      if (typeof row.record_json !== "string") throw new Error("Stored Solana preparation is invalid.");
      return JSON.parse(row.record_json) as SolanaLocalPreparedExecution;
    }).filter((record) => record.receiptAddress === receiptAddress);
    if (matches.length > 1) throw new Error("Solana receipt address is not unique in durable state.");
    return matches[0] === undefined ? undefined : this.get(matches[0].attemptId);
  }

  update(attemptId: string, status: SolanaLocalPreparedExecution["status"], signature: string): SolanaLocalPreparedExecution {
    const record = this.get(attemptId);
    if (record === undefined) throw new Error("Solana preparation was not found.");
    if (record.signature !== null && record.signature !== signature) throw new Error("Solana signature conflicts with durable state.");
    const next = Object.freeze({ ...record, status, signature });
    this.#db.prepare("UPDATE solana_local_preparations SET record_json = ? WHERE attempt_id = ?")
      .run(JSON.stringify(next), attemptId);
    return next;
  }

  close(): void {
    this.#db.close();
  }
}

export interface SolanaLocalExecutionRpc {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  sendRawTransaction(bytes: Uint8Array): Promise<string>;
  getSignatureStatus(signature: string): Promise<{ confirmationStatus?: string | null; err: unknown } | null>;
  getAccount(address: PublicKey): Promise<{ owner: PublicKey; data: Buffer } | null>;
  getTokenAmount(address: PublicKey): Promise<bigint>;
}

export interface SolanaLocalExecutionLifecyclePort {
  prepare(attemptId: string): unknown;
  submit(attemptId: string): unknown;
  recordConsensusOpen(attemptId: string, evidence: Uint8Array): unknown;
  prepareExit(attemptId: string): unknown;
  submitExit(attemptId: string): unknown;
  recordConsensusClosed(attemptId: string, evidence: Uint8Array): unknown;
}

export interface SolanaLocalConformancePort {
  compileAuthenticated(admission: PackageAdmission, solverSignature: Uint8Array): Promise<{
    readonly payload: AuthenticatedConformanceExecution;
  }>;
  receiptAddress(trader: PublicKey, orderHash: Uint8Array): PublicKey;
  nonceMarkerAddress(trader: PublicKey, nonce: bigint): PublicKey;
  readEvidence(executionReference: string, admission: PackageAdmission): Promise<{
    readonly executionReference: string;
    readonly domain: DomainRef;
    readonly orderHash: Uint8Array;
    readonly quoteHash: Uint8Array;
    readonly routeHash: Uint8Array;
    readonly receipt: ConformanceReceipt;
  } | null>;
  decodePosition(data: Buffer): ConformancePosition;
}

export class ConnectionSolanaLocalExecutionRpc implements SolanaLocalExecutionRpc {
  readonly #connection: Connection;

  constructor(connection: Connection) {
    this.#connection = connection;
  }

  getLatestBlockhash() {
    return this.#connection.getLatestBlockhash("confirmed");
  }

  sendRawTransaction(bytes: Uint8Array): Promise<string> {
    return this.#connection.sendRawTransaction(bytes, { skipPreflight: false, maxRetries: 0 });
  }

  async getSignatureStatus(signature: string) {
    return (await this.#connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0] ?? null;
  }

  getAccount(address: PublicKey) {
    return this.#connection.getAccountInfo(address, "confirmed");
  }

  async getTokenAmount(address: PublicKey): Promise<bigint> {
    return BigInt((await this.#connection.getTokenAccountBalance(address, "confirmed")).value.amount);
  }
}

export interface SolanaLocalExecutionResult {
  readonly attemptId: string;
  readonly status: SolanaLocalPreparedExecution["status"];
  readonly signature: string;
}

export class SolanaLocalExecutionService {
  readonly #manifest: SolanaLocalEnvironmentManifest;
  readonly #intents: ExecutionIntentStore;
  readonly #orders: InternalOrderStore;
  readonly #authorization: SolanaLocalExecutionAuthorizationPort;
  readonly #adapter: SolanaLocalConformancePort;
  readonly #rpc: SolanaLocalExecutionRpc;
  readonly #store: SolanaLocalPreparedExecutionStore;
  readonly #lifecycle: SolanaLocalExecutionLifecyclePort;
  readonly #validateLive: () => Promise<void>;
  readonly #selectedAdmission: ((attemptId: string) => PackageAdmission) | undefined;

  constructor(options: Readonly<{
    manifest: SolanaLocalEnvironmentManifest;
    intents: ExecutionIntentStore;
    orders: InternalOrderStore;
    authorization: SolanaLocalExecutionAuthorizationPort;
    adapter: SolanaLocalConformancePort;
    rpc: SolanaLocalExecutionRpc;
    store: SolanaLocalPreparedExecutionStore;
    lifecycle: SolanaLocalExecutionLifecyclePort;
    validateLive: () => Promise<void>;
    selectedAdmission?: (attemptId: string) => PackageAdmission;
  }>) {
    const rpcUrl = new URL(options.manifest.rpc.url);
    const loopback = rpcUrl.hostname === "localhost" || rpcUrl.hostname === "[::1]" || rpcUrl.hostname.startsWith("127.");
    if (options.manifest.network !== "local-validator" || options.manifest.mainnet !== false
      || options.manifest.runtime.domainManifest.environment !== "local"
      || options.manifest.runtime.domainManifest.chainNamespace !== "solana"
      || rpcUrl.protocol !== "http:" || !loopback || rpcUrl.username !== "" || rpcUrl.password !== "") {
      throw new Error("Solana write runtime requires a manifest-validated loopback local validator.");
    }
    this.#manifest = options.manifest;
    this.#intents = options.intents;
    this.#orders = options.orders;
    this.#authorization = options.authorization;
    this.#adapter = options.adapter;
    this.#rpc = options.rpc;
    this.#store = options.store;
    this.#lifecycle = options.lifecycle;
    this.#validateLive = options.validateLive;
    this.#selectedAdmission = options.selectedAdmission;
  }

  #admission(attemptId: string): PackageAdmission {
    if (this.#selectedAdmission !== undefined) return this.#selectedAdmission(attemptId);
    const attempt = this.#intents.getAttempt(attemptId);
    const response = this.#intents.getSelectedQuote(attemptId);
    const order = attempt === undefined ? undefined : this.#orders.getCanonicalOrderByHash(attempt.orderHash);
    if (attempt === undefined || response === undefined || order === undefined) throw new Error("Selected Solana attempt was not found.");
    const route = routePayload(fromProtocolJson(response.route, "selected.route") as RoutePayloadInput);
    const quote = solverQuote(fromProtocolJson(response.quote, "selected.quote") as SolverQuoteInput);
    const admission = Object.freeze({
      order,
      route,
      quote,
      orderHash: packageOrderHash(order),
      routeHash: routeHash(route),
      quoteHash: quoteHash(quote),
    }) as PackageAdmission;
    if (Buffer.from(admission.orderHash).toString("hex") !== attempt.orderHash
      || Buffer.from(admission.routeHash).toString("hex") !== attempt.routeHash
      || Buffer.from(admission.quoteHash).toString("hex") !== attempt.quoteHash) {
      throw new Error("Selected Solana admission does not match durable attempt evidence.");
    }
    return admission;
  }

  async prepare(attemptId: string): Promise<SolanaLocalPreparedExecution> {
    await this.#validateLive();
    const existing = this.#store.get(attemptId);
    if (existing !== undefined) return existing;
    const admission = this.#admission(attemptId);
    const entryReceiptAddress = admission.order.action === "EXIT"
      ? admission.route.accountBindings.find((binding) => binding.routeBindingId === "entry-receipt")?.accountIdentity
      : undefined;
    const entryPreparation = entryReceiptAddress === undefined ? undefined : this.#store.getByReceiptAddress(entryReceiptAddress);
    if (admission.order.action === "EXIT"
      && (entryPreparation === undefined || entryPreparation.action !== "ENTRY"
        || entryPreparation.status !== "CONSENSUS_VERIFIED")) {
      throw new Error("Solana exit requires a consensus-verified local entry preparation.");
    }
    const authorization = await this.#authorization.authorize(attemptId);
    const compiled = await this.#adapter.compileAuthenticated(
      admission,
      Uint8Array.from(Buffer.from(authorization.solverSignature, "hex")),
    );
    if (Buffer.from(compiled.payload.executionDigest).toString("hex") !== authorization.executionDigest) {
      throw new Error("Solver authorization does not match the compiled Solana execution.");
    }
    const latest = await this.#rpc.getLatestBlockhash();
    const trader = new PublicKey(admission.order.owner);
    const message = new TransactionMessage({
      payerKey: trader,
      recentBlockhash: latest.blockhash,
      instructions: [...compiled.payload.instructions],
    }).compileToV0Message();
    if (message.header.numRequiredSignatures !== 1 || !message.staticAccountKeys[0]?.equals(trader)) {
      throw new Error("Solana entry transaction must require only the trader signature.");
    }
    const transaction = new VersionedTransaction(message);
    const prepared = this.#store.savePrepared(Object.freeze({
      version: 1,
      attemptId,
      action: admission.order.action,
      lifecycleAttemptId: entryPreparation?.attemptId ?? attemptId,
      status: "PREPARED",
      unsignedTransactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
      messageBase64: Buffer.from(message.serialize()).toString("base64"),
      recentBlockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      trader: trader.toBase58(),
      receiptAddress: this.#adapter.receiptAddress(trader, admission.orderHash).toBase58(),
      nonceMarkerAddress: this.#adapter.nonceMarkerAddress(trader, admission.order.nonce).toBase58(),
      signature: null,
    }));
    if (admission.order.action === "ENTRY") this.#lifecycle.prepare(attemptId);
    else this.#lifecycle.prepareExit(prepared.lifecycleAttemptId);
    return prepared;
  }

  async submit(attemptId: string, envelope: Readonly<{ signedTransactionBase64?: string; signature?: string }>): Promise<SolanaLocalExecutionResult> {
    const prepared = this.#store.get(attemptId);
    if (prepared === undefined) throw new Error("Solana execution must be prepared before submission.");
    if (prepared.signature !== null) return this.reconcile(attemptId);
    const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.unsignedTransactionBase64, "base64"));
    if (typeof envelope !== "object" || envelope === null
      || Object.keys(envelope).length !== 1
      || (envelope.signedTransactionBase64 === undefined && envelope.signature === undefined)) {
      throw new Error("Signed Solana envelope must contain exactly one supported field.");
    }
    if (envelope.signedTransactionBase64 !== undefined && envelope.signature !== undefined) {
      throw new Error("Provide either a signed transaction or a trader signature.");
    }
    if (envelope.signedTransactionBase64 !== undefined) {
      const bytes = Buffer.from(envelope.signedTransactionBase64, "base64");
      if (bytes.length === 0 || bytes.toString("base64") !== envelope.signedTransactionBase64) {
        throw new Error("Trader-signed transaction must be canonical base64.");
      }
      const supplied = VersionedTransaction.deserialize(bytes);
      if (!bytesEqual(supplied.message.serialize(), transaction.message.serialize())) {
        throw new Error("Trader-signed transaction message does not match the durable preparation.");
      }
      transaction.signatures = supplied.signatures.map((value) => Uint8Array.from(value));
    } else if (envelope.signature !== undefined && SIGNATURE.test(envelope.signature)) {
      const signature = bs58.decode(envelope.signature);
      if (signature.length !== 64) throw new Error("Trader signature is invalid.");
      transaction.signatures[0] = signature;
    } else {
      throw new Error("A trader-signed transaction or signature is required.");
    }
    const signatureBytes = transaction.signatures[0];
    if (signatureBytes === undefined || signatureBytes.length !== 64
      || !verify(null, Buffer.from(transaction.message.serialize()), createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(new PublicKey(prepared.trader).toBytes())]),
        format: "der",
        type: "spki",
      }), Buffer.from(signatureBytes))) {
      throw new Error("Trader signature does not authorize the prepared Solana message.");
    }
    const signature = bs58.encode(signatureBytes);
    this.#store.update(attemptId, "SIGNED", signature);
    if (prepared.action === "ENTRY") this.#lifecycle.submit(attemptId);
    else this.#lifecycle.submitExit(prepared.lifecycleAttemptId);
    await this.#validateLive();
    try {
      const returned = await this.#rpc.sendRawTransaction(transaction.serialize());
      if (returned !== signature) throw new Error("Validator returned a different transaction signature.");
      this.#store.update(attemptId, "SUBMITTED", signature);
    } catch {
      this.#store.update(attemptId, "SUBMITTED_UNKNOWN", signature);
    }
    return this.reconcile(attemptId);
  }

  async reconcile(attemptId: string): Promise<SolanaLocalExecutionResult> {
    const prepared = this.#store.get(attemptId);
    if (prepared?.signature === null || prepared === undefined) throw new Error("Signed Solana preparation was not found.");
    await this.#validateLive();
    const status = await this.#rpc.getSignatureStatus(prepared.signature);
    if (status?.err !== null && status?.err !== undefined) {
      this.#store.update(attemptId, "FAILED", prepared.signature);
      return Object.freeze({ attemptId, status: "FAILED", signature: prepared.signature });
    }
    if (status === null || (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized")) {
      this.#store.update(attemptId, "SUBMITTED_UNKNOWN", prepared.signature);
      return Object.freeze({ attemptId, status: "SUBMITTED_UNKNOWN", signature: prepared.signature });
    }
    const admission = this.#admission(attemptId);
    const receiptAddress = new PublicKey(prepared.receiptAddress);
    const evidence = await this.#adapter.readEvidence(prepared.receiptAddress, admission);
    const nonce = await this.#rpc.getAccount(new PublicKey(prepared.nonceMarkerAddress));
    const positionAccount = await this.#rpc.getAccount(new PublicKey(this.#manifest.accounts.position));
    if (evidence === null || nonce === null || positionAccount === null
      || nonce.owner.toBase58() !== this.#manifest.programs.core.id
      || positionAccount.owner.toBase58() !== this.#manifest.programs.conformanceVenue.id
      || !evidence.receipt.address.equals(receiptAddress)
      || evidence.receipt.action !== prepared.action) {
      this.#store.update(attemptId, "SUBMITTED_UNKNOWN", prepared.signature);
      return Object.freeze({ attemptId, status: "SUBMITTED_UNKNOWN", signature: prepared.signature });
    }
    await this.#verifyPostconditions(evidence.receipt, positionAccount.data);
    const commitment = createHash("sha256")
      .update("NARYX/solana-local-consensus-evidence/v1", "ascii")
      .update(bs58.decode(prepared.signature))
      .update(receiptAddress.toBytes())
      .update(evidence.receipt.executionDigest)
      .digest();
    if (prepared.action === "ENTRY") this.#lifecycle.recordConsensusOpen(attemptId, commitment);
    else this.#lifecycle.recordConsensusClosed(prepared.lifecycleAttemptId, commitment);
    this.#store.update(attemptId, "CONSENSUS_VERIFIED", prepared.signature);
    return Object.freeze({ attemptId, status: "CONSENSUS_VERIFIED", signature: prepared.signature });
  }

  async #verifyPostconditions(receipt: ConformanceReceipt, positionData: Buffer): Promise<void> {
    const position = this.#adapter.decodePosition(positionData);
    const traderBase = await this.#rpc.getTokenAmount(new PublicKey(this.#manifest.accounts["trader-base"]));
    const traderQuote = await this.#rpc.getTokenAmount(new PublicKey(this.#manifest.accounts["trader-quote"]));
    if (traderBase !== receipt.postBaseBalance || traderQuote !== receipt.postQuoteBalance
      || position.shortBaseAtoms !== receipt.postShortBaseAtoms
      || position.collateralQuoteAtoms !== receipt.postCollateralQuoteAtoms
      || !position.market.equals(new PublicKey(this.#manifest.accounts.market))
      || !position.trader.equals(new PublicKey(this.#manifest.identities.trader))) {
      throw new Error("Confirmed Solana postconditions do not match authoritative accounts.");
    }
    if (receipt.action === "EXIT"
      && (receipt.postShortBaseAtoms !== 0n || receipt.postCollateralQuoteAtoms !== 0n)) {
      throw new Error("Confirmed Solana exit did not reach its signed zero-residual terminal state.");
    }
    for (const address of [
      this.#manifest.accounts["trader-base"],
      this.#manifest.accounts["trader-quote"],
      this.#manifest.accounts.spotBaseVault,
      this.#manifest.accounts.spotQuoteVault,
      this.#manifest.accounts.perpQuoteVault,
    ]) {
      const account = await this.#rpc.getAccount(new PublicKey(address));
      if (account === null || account.owner.toBase58() !== TOKEN_PROGRAM) {
        throw new Error("Solana token postcondition account is missing or has the wrong owner.");
      }
    }
  }
}
