import { hashTypedData, type Address, type Hex } from "viem";
import {
  validateArbitrumSepoliaExitAuthorization,
  type ArbitrumSepoliaExitAuthorization,
} from "./arbitrum-sepolia-exit.js";
import type {
  EvmTestnetAsyncObservationPort,
  EvmTestnetObserveAsyncRequest,
} from "./evm-testnet-runtime-ports.js";

const EXECUTOR_PATH = "/internal/solver/arbitrum-sepolia/execute";
const PREPARE_PATH = "/internal/solver/arbitrum-sepolia/prepare";
const AUTHORIZE_PATH = "/internal/solver/arbitrum-sepolia/authorize";
const PREPARE_EXIT_PATH = "/internal/solver/arbitrum-sepolia/prepare-exit";
const AUTHORIZE_EXIT_PATH = "/internal/solver/arbitrum-sepolia/authorize-exit";
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const CALLDATA = /^0x(?:[0-9a-f]{2}){4,4096}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/;
const ATTEMPT_ID = /^arbitrum-async-[0-9a-f]{48}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 30_000;
const STATUSES = new Set([
  "AWAITING_OWNER_SIGNATURE", "AWAITING_OWNER_FUNDING", "IN_FLIGHT", "VENUE_PENDING", "SETTLED", "RECOVERY_REQUIRED",
  "FAILED", "CANCELLED",
]);
const STEPS = new Set([
  "APPROVE_COORDINATOR", "RESERVE", "SUBMIT", "MARK_PENDING", "RELAY", "CLOSE",
  "SUBMIT_EXIT", "RECONCILE_EXIT", "PROCESS_RECONCILIATION", "FINALIZE_EXIT",
]);

export type ArbitrumSepoliaExecutionSummary = Readonly<{
  attemptId: string;
  /** CANCELLED: an exit's GMX close was cancelled or recovered, so the package stays open. */
  status:
    | "AWAITING_OWNER_SIGNATURE" | "AWAITING_OWNER_FUNDING"
    | "IN_FLIGHT" | "VENUE_PENDING" | "SETTLED" | "RECOVERY_REQUIRED" | "FAILED" | "CANCELLED";
  packageId: string;
  coordinatorState: string;
  requestKey: string | null;
  transactions: readonly Readonly<{ step: string; txHash: string; status: string }>[];
}>;

/** Advances one selected Arbitrum attempt through the solver-held coordinator steps. */
export interface ArbitrumSepoliaAttemptExecutor {
  advance(attemptId: string): Promise<ArbitrumSepoliaExecutionSummary>;
}

/**
 * The owner's wallet work for one attempt, as prepared by the solver: the EIP-712 reservation to sign
 * and the collateral approval plus `fundRequest` transaction to send. Every integer is a decimal string.
 */
export type ArbitrumSepoliaOwnerAuthorization = Readonly<{
  version: 1;
  attemptId: string;
  packageId: Hex;
  chainId: 421614;
  owner: Address;
  account: Address;
  accountFactory: Address;
  coordinator: Address;
  adapter: Address;
  typedData: Readonly<{
    domain: Readonly<{ name: "Naryx Async Bonded Package"; version: "1"; chainId: 421614; verifyingContract: Address }>;
    types: Readonly<{ ReserveAsyncPackage: readonly [Readonly<{ name: "termsHash"; type: "bytes32" }>] }>;
    primaryType: "ReserveAsyncPackage";
    message: Readonly<{ termsHash: Hex }>;
  }>;
  digest: Hex;
  signed: boolean;
  funding: Readonly<{
    token: Address;
    spender: Address;
    approveAtoms: string;
    collateralAtoms: string;
    spotQuoteAtoms: string;
    executionFeeWei: string;
    fundRequest: Readonly<{ to: Address; data: Hex; value: string }>;
    reclaimAfterUnixSeconds: string;
  }>;
  summary: Readonly<Record<
    | "nonce" | "sizeDeltaUsd" | "acceptablePrice" | "spotBaseAtoms" | "rollbackMinQuoteAtoms" | "bondAtoms"
    | "submissionDeadline" | "venueDeadline" | "recoveryDeadline", string
  > & { solver: Address }>;
}>;

/** Prepares and records the owner's own reservation signature; the service never holds the owner key. */
export interface ArbitrumSepoliaOwnerAuthorizationExecutor {
  prepare(attemptId: string): Promise<ArbitrumSepoliaOwnerAuthorization>;
  authorize(attemptId: string, ownerSignature: string): Promise<ArbitrumSepoliaOwnerAuthorization>;
}

/** Prepares and records the owner's own exit authorization signature; the service never holds the owner key. */
export interface ArbitrumSepoliaExitAuthorizationExecutor {
  prepareExit(attemptId: string): Promise<ArbitrumSepoliaExitAuthorization>;
  authorizeExit(attemptId: string, ownerSignature: string): Promise<ArbitrumSepoliaExitAuthorization>;
}

export class ArbitrumSepoliaHandoffError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArbitrumSepoliaHandoffError";
    this.code = code;
  }
}

function loopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Arbitrum executor origin must be an absolute URL.");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Arbitrum executor origin must be a loopback HTTP origin.");
  }
  return url.origin;
}

function validateSummary(value: unknown, attemptId: string): ArbitrumSepoliaExecutionSummary {
  const record = value as Record<string, unknown>;
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(record).sort().join(",") !== "attemptId,coordinatorState,packageId,requestKey,status,transactions,version"
    || record.version !== 1 || record.attemptId !== attemptId
    || typeof record.status !== "string" || !STATUSES.has(record.status)
    || typeof record.packageId !== "string" || !HASH.test(record.packageId)
    || typeof record.coordinatorState !== "string" || !/^[A-Z_]{1,32}$/.test(record.coordinatorState)
    || (record.requestKey !== null && (typeof record.requestKey !== "string" || !HASH.test(record.requestKey)))
    || !Array.isArray(record.transactions) || record.transactions.length > STEPS.size
    || record.transactions.some((entry: unknown) => {
      const tx = entry as Record<string, unknown>;
      return typeof entry !== "object" || entry === null || typeof tx.step !== "string" || !STEPS.has(tx.step)
        || typeof tx.txHash !== "string" || !HASH.test(tx.txHash)
        || !["SENT", "CONFIRMED", "REVERTED"].includes(tx.status as string);
    })) {
    throw new ArbitrumSepoliaHandoffError("INVALID_EXECUTOR_RESPONSE", "Arbitrum executor response is invalid.");
  }
  const { version: _version, ...summary } = record;
  return Object.freeze(summary) as unknown as ArbitrumSepoliaExecutionSummary;
}

function invalidAuthorization(): never {
  throw new ArbitrumSepoliaHandoffError("INVALID_EXECUTOR_RESPONSE", "Arbitrum owner authorization response is invalid.");
}

function exactKeys(value: unknown, keys: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== keys) invalidAuthorization();
  return value as Record<string, unknown>;
}

function addressField(value: unknown): Address {
  if (typeof value !== "string" || !ADDRESS.test(value)) invalidAuthorization();
  return value as Address;
}

function decimalField(value: unknown): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) invalidAuthorization();
  return value;
}

/** Structural and cryptographic check of the solver's prepared owner authorization. */
export function validateArbitrumSepoliaOwnerAuthorization(
  value: unknown,
  attemptId: string,
): ArbitrumSepoliaOwnerAuthorization {
  const record = exactKeys(value,
    "account,accountFactory,adapter,attemptId,chainId,coordinator,digest,funding,owner,packageId,signed,summary,typedData,version");
  const typedData = exactKeys(record.typedData, "domain,message,primaryType,types");
  const domain = exactKeys(typedData.domain, "chainId,name,verifyingContract,version");
  const types = exactKeys(typedData.types, "ReserveAsyncPackage");
  const fields = types.ReserveAsyncPackage as unknown[];
  const message = exactKeys(typedData.message, "termsHash");
  const funding = exactKeys(record.funding,
    "approveAtoms,collateralAtoms,executionFeeWei,fundRequest,reclaimAfterUnixSeconds,spender,spotQuoteAtoms,token");
  const fundRequest = exactKeys(funding.fundRequest, "data,to,value");
  const summary = exactKeys(record.summary,
    "acceptablePrice,bondAtoms,nonce,recoveryDeadline,rollbackMinQuoteAtoms,sizeDeltaUsd,solver,spotBaseAtoms,submissionDeadline,venueDeadline");
  if (record.version !== 1 || record.attemptId !== attemptId || record.chainId !== 421614
    || typeof record.packageId !== "string" || !HASH.test(record.packageId)
    || typeof record.digest !== "string" || !HASH.test(record.digest) || typeof record.signed !== "boolean"
    || domain.name !== "Naryx Async Bonded Package" || domain.version !== "1" || domain.chainId !== 421614
    || addressField(domain.verifyingContract) !== addressField(record.coordinator)
    || typedData.primaryType !== "ReserveAsyncPackage" || !Array.isArray(fields) || fields.length !== 1
    || (fields[0] as Record<string, unknown>)?.name !== "termsHash" || (fields[0] as Record<string, unknown>)?.type !== "bytes32"
    || Object.keys(fields[0] as object).length !== 2
    || typeof message.termsHash !== "string" || !HASH.test(message.termsHash)
    || typeof fundRequest.data !== "string" || !CALLDATA.test(fundRequest.data)
    || addressField(fundRequest.to) !== addressField(funding.spender)
    || decimalField(fundRequest.value) !== decimalField(funding.executionFeeWei)
    || BigInt(decimalField(funding.approveAtoms))
      !== BigInt(decimalField(funding.collateralAtoms)) + BigInt(decimalField(funding.spotQuoteAtoms))) {
    invalidAuthorization();
  }
  addressField(record.owner);
  addressField(record.account);
  addressField(record.accountFactory);
  addressField(record.adapter);
  addressField(funding.token);
  addressField(summary.solver);
  decimalField(funding.reclaimAfterUnixSeconds);
  for (const key of Object.keys(summary)) if (key !== "solver") decimalField(summary[key]);
  if (hashTypedData(typedData as never) !== record.digest) invalidAuthorization();
  return Object.freeze(record) as unknown as ArbitrumSepoliaOwnerAuthorization;
}

function exitAuthorization(value: unknown, attemptId: string): ArbitrumSepoliaExitAuthorization {
  try {
    return validateArbitrumSepoliaExitAuthorization(value, attemptId);
  } catch {
    invalidAuthorization();
  }
}

export class HttpArbitrumSepoliaAttemptExecutor
implements ArbitrumSepoliaAttemptExecutor, ArbitrumSepoliaOwnerAuthorizationExecutor, ArbitrumSepoliaExitAuthorizationExecutor {
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: Readonly<{ executorOrigin: string; timeoutMs?: number; fetchImplementation?: typeof fetch }>) {
    this.#origin = loopbackOrigin(options.executorOrigin);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) {
      throw new Error("Arbitrum executor timeout must be a bounded positive integer.");
    }
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async advance(attemptId: string): Promise<ArbitrumSepoliaExecutionSummary> {
    if (!ATTEMPT_ID.test(attemptId)) throw new ArbitrumSepoliaHandoffError("INVALID_ATTEMPT", "Attempt ID is invalid.");
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}${EXECUTOR_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId }),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new ArbitrumSepoliaHandoffError("EXECUTOR_UNREACHABLE", "Arbitrum executor request failed.");
    }
    const text = await response.text();
    if (!response.ok || text.length > MAX_RESPONSE_BYTES) {
      throw new ArbitrumSepoliaHandoffError("EXECUTOR_REJECTED", `Arbitrum executor failed with HTTP ${response.status}.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ArbitrumSepoliaHandoffError("INVALID_EXECUTOR_RESPONSE", "Arbitrum executor response is malformed.");
    }
    return validateSummary(parsed, attemptId);
  }

  async prepare(attemptId: string): Promise<ArbitrumSepoliaOwnerAuthorization> {
    if (!ATTEMPT_ID.test(attemptId)) throw new ArbitrumSepoliaHandoffError("INVALID_ATTEMPT", "Attempt ID is invalid.");
    return validateArbitrumSepoliaOwnerAuthorization(await this.#post(PREPARE_PATH, { attemptId }), attemptId);
  }

  async authorize(attemptId: string, ownerSignature: string): Promise<ArbitrumSepoliaOwnerAuthorization> {
    if (!ATTEMPT_ID.test(attemptId)) throw new ArbitrumSepoliaHandoffError("INVALID_ATTEMPT", "Attempt ID is invalid.");
    if (typeof ownerSignature !== "string" || !SIGNATURE.test(ownerSignature)) {
      throw new ArbitrumSepoliaHandoffError("INVALID_SIGNATURE", "Owner signature must be a lowercase 65-byte hex string.");
    }
    const authorization = validateArbitrumSepoliaOwnerAuthorization(
      await this.#post(AUTHORIZE_PATH, { attemptId, ownerSignature }),
      attemptId,
    );
    if (!authorization.signed) invalidAuthorization();
    return authorization;
  }

  async prepareExit(attemptId: string): Promise<ArbitrumSepoliaExitAuthorization> {
    if (!ATTEMPT_ID.test(attemptId)) throw new ArbitrumSepoliaHandoffError("INVALID_ATTEMPT", "Attempt ID is invalid.");
    return exitAuthorization(await this.#post(PREPARE_EXIT_PATH, { attemptId }), attemptId);
  }

  async authorizeExit(attemptId: string, ownerSignature: string): Promise<ArbitrumSepoliaExitAuthorization> {
    if (!ATTEMPT_ID.test(attemptId)) throw new ArbitrumSepoliaHandoffError("INVALID_ATTEMPT", "Attempt ID is invalid.");
    if (typeof ownerSignature !== "string" || !SIGNATURE.test(ownerSignature)) {
      throw new ArbitrumSepoliaHandoffError("INVALID_SIGNATURE", "Owner signature must be a lowercase 65-byte hex string.");
    }
    const authorization = exitAuthorization(
      await this.#post(AUTHORIZE_EXIT_PATH, { attemptId, ownerSignature }),
      attemptId,
    );
    if (!authorization.signed) invalidAuthorization();
    return authorization;
  }

  /** Posts to a solver owner route; a solver 4xx keeps its error code so the browser sees why. */
  async #post(path: string, body: Readonly<Record<string, string>>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new ArbitrumSepoliaHandoffError("EXECUTOR_UNREACHABLE", "Arbitrum executor request failed.");
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new ArbitrumSepoliaHandoffError("INVALID_EXECUTOR_RESPONSE", "Arbitrum executor response is too large.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ArbitrumSepoliaHandoffError("INVALID_EXECUTOR_RESPONSE", "Arbitrum executor response is malformed.");
    }
    if (!response.ok) {
      const code = (parsed as { error?: { code?: unknown } })?.error?.code;
      throw new ArbitrumSepoliaHandoffError(
        response.status >= 400 && response.status < 500 && typeof code === "string" && /^[A-Z_]{1,48}$/.test(code)
          ? code
          : "EXECUTOR_REJECTED",
        `Arbitrum executor failed with HTTP ${response.status}.`,
      );
    }
    return parsed;
  }
}

/**
 * The readiness gate has already approved ARBITRUM_TESTNET_ASYNC_HANDOFF when observe runs, so the
 * solver advances the attempt first (idempotent per attempt), then the signerless observation reports
 * chain status. A failed attempt fails the handoff closed.
 */
export function withArbitrumSepoliaExecutionHandoff(
  observation: EvmTestnetAsyncObservationPort,
  executor: ArbitrumSepoliaAttemptExecutor,
): EvmTestnetAsyncObservationPort {
  if (typeof observation?.observe !== "function" || typeof executor?.advance !== "function") {
    throw new Error("Arbitrum handoff requires an observation port and an executor.");
  }
  return Object.freeze({
    observe: async (request: EvmTestnetObserveAsyncRequest) => {
      const summary = await executor.advance(request.attemptId);
      if (summary.status === "FAILED") {
        throw new ArbitrumSepoliaHandoffError("EXECUTION_FAILED", "Arbitrum Sepolia execution failed closed.");
      }
      return observation.observe(request);
    },
  });
}
