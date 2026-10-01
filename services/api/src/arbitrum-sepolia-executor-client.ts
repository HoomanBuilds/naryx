import type {
  EvmTestnetAsyncObservationPort,
  EvmTestnetObserveAsyncRequest,
} from "./evm-testnet-runtime-ports.js";

const EXECUTOR_PATH = "/internal/solver/arbitrum-sepolia/execute";
const ATTEMPT_ID = /^arbitrum-async-[0-9a-f]{48}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 30_000;
const STATUSES = new Set(["IN_FLIGHT", "VENUE_PENDING", "SETTLED", "RECOVERY_REQUIRED", "FAILED"]);
const STEPS = new Set(["APPROVE_ADAPTER", "FUND", "APPROVE_COORDINATOR", "RESERVE", "SUBMIT", "MARK_PENDING", "RELAY", "CLOSE"]);

export type ArbitrumSepoliaExecutionSummary = Readonly<{
  attemptId: string;
  status: "IN_FLIGHT" | "VENUE_PENDING" | "SETTLED" | "RECOVERY_REQUIRED" | "FAILED";
  packageId: string;
  coordinatorState: string;
  requestKey: string | null;
  transactions: readonly Readonly<{ step: string; txHash: string; status: string }>[];
}>;

/** Advances one selected Arbitrum attempt through the solver-held coordinator steps. */
export interface ArbitrumSepoliaAttemptExecutor {
  advance(attemptId: string): Promise<ArbitrumSepoliaExecutionSummary>;
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

export class HttpArbitrumSepoliaAttemptExecutor implements ArbitrumSepoliaAttemptExecutor {
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
