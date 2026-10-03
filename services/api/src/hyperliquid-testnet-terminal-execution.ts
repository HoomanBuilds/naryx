import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { parseProtocolJson, stringifyProtocolJson } from "@naryx/protocol-types";
import {
  validateHyperliquidTestnetTerminalExecutionResult,
  type HyperliquidTestnetTerminalExecutionPort,
  type HyperliquidTestnetTerminalExecutionRequest,
  type HyperliquidTestnetTerminalExecutionResult,
} from "./hyperliquid-testnet-terminal.js";

const SCHEMA_VERSION = 1;
const EXECUTOR_PATH = "/internal/solver/hyperliquid-testnet/execute";
const EXECUTOR_STATUS_PATH = "/internal/solver/hyperliquid-testnet/attempt-status";
const MAX_RESPONSE_BYTES = 65_536;
// The executor runs one package at a time, so a handoff can wait behind a bounded queue of
// earlier packages before its own authority read, submission, and reconciliation.
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const STATUS_TIMEOUT_MS = 5_000;
let cachedRepositoryRoot: string | undefined;

type StoredExecutionRow = Readonly<{
  attempt_id: unknown;
  status: unknown;
  result_json: unknown;
}>;

export type HyperliquidTestnetAttemptState =
  | Readonly<{ state: "QUEUED"; queuePosition: number; lane: HyperliquidTestnetLaneState }>
  | Readonly<{ state: "EXECUTING" | "UNCERTAIN" | "NOT_STARTED"; lane: HyperliquidTestnetLaneState | null }>
  | Readonly<{ state: "COMPLETED"; result: HyperliquidTestnetTerminalExecutionResult }>;

export type HyperliquidTestnetLaneState = "FREE" | "EXECUTING" | "BLOCKED";

type ExecutorAttemptStatus = Readonly<{
  state: "QUEUED" | "EXECUTING" | "COMPLETED" | "INTERRUPTED" | "UNKNOWN";
  queuePosition: number | null;
  lane: HyperliquidTestnetLaneState;
  result: HyperliquidTestnetTerminalExecutionResult | null;
}>;

export interface TrustedHyperliquidTestnetAttemptExecutor {
  executeAttempt(
    request: HyperliquidTestnetTerminalExecutionRequest,
  ): Promise<HyperliquidTestnetTerminalExecutionResult>;
  /** `resolve` fences an attempt the executor never received, so its outcome becomes definite. */
  attemptStatus?(
    request: HyperliquidTestnetTerminalExecutionRequest & Readonly<{ resolve: boolean }>,
  ): Promise<ExecutorAttemptStatus>;
}

/**
 * Owner-side admission around the trusted handoff: `admit` refuses or reserves before anything
 * is sent, and `settle` records each terminal outcome exactly once.
 */
export interface HyperliquidTestnetExecutionGuard {
  requireOwnerAuthorization(request: HyperliquidTestnetTerminalExecutionRequest): void;
  admit(request: HyperliquidTestnetTerminalExecutionRequest): void;
  settle(request: HyperliquidTestnetTerminalExecutionRequest, result: HyperliquidTestnetTerminalExecutionResult): void;
}

export type HyperliquidTestnetExecutorHttpOptions = Readonly<{
  executorOrigin: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}>;

/**
 * A result that can no longer change: never submitted, or reconciled as completed or as having no
 * effect. Anything else (recovery pending, evidence incomplete) may still be resolved by the
 * executor, for example after its lane is released on fresh authoritative evidence.
 */
export function hyperliquidTerminalResultIsFinal(result: HyperliquidTestnetTerminalExecutionResult): boolean {
  return result.status === "NOT_SUBMITTED" || result.status === "CHECKPOINT_INCOMPLETE" || result.status === "CHECKPOINT_FAILED"
    || (result.status === "RECONCILED" && (result.packageStatus === "NO_EFFECT"
      || result.packageStatus === "COMPLETED_EXACT" || result.packageStatus === "COMPLETED_BOUNDED"));
}

export class HyperliquidTestnetTerminalExecutionStateError extends Error {
  readonly code: "IDEMPOTENCY_CONFLICT" | "EXECUTION_OUTCOME_UNCERTAIN" | "STORE_CORRUPT";

  constructor(code: HyperliquidTestnetTerminalExecutionStateError["code"], message: string) {
    super(message);
    this.name = "HyperliquidTestnetTerminalExecutionStateError";
    this.code = code;
  }
}

function repositoryRoot(): string | undefined {
  if (cachedRepositoryRoot !== undefined) return cachedRepositoryRoot;
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      cachedRepositoryRoot = current;
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function databasePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value === ":memory:" || !isAbsolute(value)) {
    throw new Error("Hyperliquid terminal execution store requires an absolute durable database path.");
  }
  const resolved = resolve(value);
  const root = repositoryRoot();
  if (root !== undefined && (resolved === root || resolved.startsWith(root + sep))) {
    throw new Error("Hyperliquid terminal execution database must remain outside the repository checkout.");
  }
  return resolved;
}

function uncertain(): HyperliquidTestnetTerminalExecutionStateError {
  return new HyperliquidTestnetTerminalExecutionStateError(
    "EXECUTION_OUTCOME_UNCERTAIN",
    "Hyperliquid Testnet execution outcome is uncertain and must not be resubmitted.",
  );
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const parsed = Number(octet);
    return parsed >= 0 && parsed <= 255;
  });
}

function executorOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Hyperliquid executor origin must be an absolute URL.");
  }
  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)
    || url.username !== "" || url.password !== "" || url.pathname !== "/"
    || url.search !== "" || url.hash !== "") {
    throw new Error("Hyperliquid executor origin must be a loopback HTTP origin.");
  }
  return url.origin;
}

function executorTimeout(value: number | undefined): number {
  const checked = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(checked) || checked < 1 || checked > MAX_TIMEOUT_MS) {
    throw new Error("Hyperliquid executor timeout must be a bounded positive integer.");
  }
  return checked;
}

function executorAttemptStatus(
  value: unknown,
  request: HyperliquidTestnetTerminalExecutionRequest,
): ExecutorAttemptStatus {
  const record = value as Record<string, unknown>;
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(record).sort().join(",")
      !== "attemptId,domain,environment,idempotencyKey,lane,queuePosition,result,state"
    || record.attemptId !== request.attemptId || record.idempotencyKey !== request.idempotencyKey
    || record.domain !== "hypercore:testnet" || record.environment !== "TESTNET"
    || (record.lane !== "FREE" && record.lane !== "EXECUTING" && record.lane !== "BLOCKED")
    || !["QUEUED", "EXECUTING", "COMPLETED", "INTERRUPTED", "UNKNOWN"].includes(record.state as string)
    || (record.state === "QUEUED") !== (typeof record.queuePosition === "number"
      && Number.isSafeInteger(record.queuePosition) && record.queuePosition >= 0)
    || (record.state !== "QUEUED" && record.queuePosition !== null)
    || (record.state === "COMPLETED") === (record.result === null)) {
    throw new Error("Hyperliquid executor status response is invalid.");
  }
  return Object.freeze({
    state: record.state as ExecutorAttemptStatus["state"],
    queuePosition: record.queuePosition as number | null,
    lane: record.lane as HyperliquidTestnetLaneState,
    result: record.result === null ? null : validateHyperliquidTestnetTerminalExecutionResult(record.result, request),
  });
}

async function boundedProtocolJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const statedLength = response.headers.get("content-length");
  if (contentType !== "application/json" || response.body === null
    || (statedLength !== null && (!/^\d+$/.test(statedLength)
      || Number(statedLength) > MAX_RESPONSE_BYTES))) {
    throw new Error("Hyperliquid executor response is invalid.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Hyperliquid executor response is too large.");
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return parseProtocolJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      "hyperliquidTestnet.executorResponse",
    );
  } catch {
    throw new Error("Hyperliquid executor response is malformed.");
  }
}

export class HttpHyperliquidTestnetAttemptExecutor
implements TrustedHyperliquidTestnetAttemptExecutor {
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HyperliquidTestnetExecutorHttpOptions) {
    this.#origin = executorOrigin(options.executorOrigin);
    this.#timeoutMs = executorTimeout(options.timeoutMs);
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async executeAttempt(
    request: HyperliquidTestnetTerminalExecutionRequest,
  ): Promise<HyperliquidTestnetTerminalExecutionResult> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}${EXECUTOR_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stringifyProtocolJson(request, "hyperliquidTestnet.executorRequest"),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new Error("Hyperliquid executor request failed.");
    }
    if (!response.ok) {
      throw new Error(`Hyperliquid executor request failed with HTTP ${response.status}.`);
    }
    return validateHyperliquidTestnetTerminalExecutionResult(
      await boundedProtocolJson(response),
      request,
    );
  }

  async attemptStatus(
    request: HyperliquidTestnetTerminalExecutionRequest & Readonly<{ resolve: boolean }>,
  ): Promise<ExecutorAttemptStatus> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}${EXECUTOR_STATUS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stringifyProtocolJson(request, "hyperliquidTestnet.executorStatusRequest"),
        redirect: "error",
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
    } catch {
      throw new Error("Hyperliquid executor status request failed.");
    }
    if (!response.ok) {
      throw new Error(`Hyperliquid executor status request failed with HTTP ${response.status}.`);
    }
    return executorAttemptStatus(await boundedProtocolJson(response), request);
  }
}

export class DurableHyperliquidTestnetTerminalExecutionPort
implements HyperliquidTestnetTerminalExecutionPort {
  readonly #db: Database.Database;
  readonly #executor: TrustedHyperliquidTestnetAttemptExecutor;
  readonly #inFlight = new Map<string, Readonly<{
    attemptId: string;
    promise: Promise<HyperliquidTestnetTerminalExecutionResult>;
  }>>();
  readonly #select: Database.Statement;
  readonly #insertPending: Database.Statement;
  readonly #complete: Database.Statement;
  readonly #markUncertain: Database.Statement;
  readonly #resolveUncertain: Database.Statement;
  readonly #replaceUnresolved: Database.Statement;
  readonly #selectUnresolved: Database.Statement;
  readonly #guard: HyperliquidTestnetExecutionGuard | undefined;

  constructor(
    path: string,
    executor: TrustedHyperliquidTestnetAttemptExecutor,
    guard?: HyperliquidTestnetExecutionGuard,
  ) {
    if (executor === null || typeof executor !== "object" ||
        typeof executor.executeAttempt !== "function") {
      throw new Error("A trusted Hyperliquid Testnet attempt executor is required.");
    }
    const resolved = databasePath(path);
    mkdirSync(dirname(resolved), { recursive: true });
    this.#db = new Database(resolved);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS hyperliquid_terminal_schema_meta (
        version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO hyperliquid_terminal_schema_meta(version)
        SELECT ${SCHEMA_VERSION}
        WHERE NOT EXISTS (SELECT 1 FROM hyperliquid_terminal_schema_meta);
      CREATE TABLE IF NOT EXISTS hyperliquid_terminal_executions (
        idempotency_key TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'UNCERTAIN')),
        result_json TEXT,
        CHECK ((status = 'COMPLETED') = (result_json IS NOT NULL))
      ) STRICT;
    `);
    const version = this.#db.prepare(
      "SELECT version FROM hyperliquid_terminal_schema_meta",
    ).pluck().get();
    if (version !== SCHEMA_VERSION) {
      this.#db.close();
      throw new Error("Hyperliquid terminal execution store schema version is unsupported.");
    }
    this.#executor = executor;
    this.#guard = guard;
    this.#select = this.#db.prepare(`
      SELECT attempt_id, status, result_json
      FROM hyperliquid_terminal_executions
      WHERE idempotency_key = ?
    `);
    this.#insertPending = this.#db.prepare(`
      INSERT INTO hyperliquid_terminal_executions
        (idempotency_key, attempt_id, status, result_json)
      VALUES (?, ?, 'PENDING', NULL)
    `);
    this.#complete = this.#db.prepare(`
      UPDATE hyperliquid_terminal_executions
      SET status = 'COMPLETED', result_json = ?
      WHERE idempotency_key = ? AND attempt_id = ? AND status = 'PENDING'
    `);
    this.#markUncertain = this.#db.prepare(`
      UPDATE hyperliquid_terminal_executions
      SET status = 'UNCERTAIN', result_json = NULL
      WHERE idempotency_key = ? AND attempt_id = ? AND status = 'PENDING'
    `);
    // A stored non-final result is replaced only by the executor's later final one, compared and
    // swapped in one statement so a concurrent replacement cannot be overwritten.
    this.#replaceUnresolved = this.#db.prepare(`
      UPDATE hyperliquid_terminal_executions SET result_json = ?
      WHERE idempotency_key = ? AND attempt_id = ? AND status = 'COMPLETED' AND result_json = ?
    `);
    this.#selectUnresolved = this.#db.prepare(`
      SELECT idempotency_key, attempt_id, result_json FROM hyperliquid_terminal_executions
      WHERE status = 'COMPLETED' AND CASE WHEN json_valid(result_json) THEN NOT (
        json_extract(result_json, '$.status') IN ('NOT_SUBMITTED', 'CHECKPOINT_INCOMPLETE', 'CHECKPOINT_FAILED')
        OR (json_extract(result_json, '$.status') = 'RECONCILED'
          AND json_extract(result_json, '$.packageStatus') IN ('NO_EFFECT', 'COMPLETED_EXACT', 'COMPLETED_BOUNDED')))
        ELSE 0 END
      ORDER BY rowid LIMIT ? OFFSET ?
    `);
    this.#resolveUncertain = this.#db.prepare(`
      UPDATE hyperliquid_terminal_executions
      SET status = 'COMPLETED', result_json = ?
      WHERE idempotency_key = ? AND attempt_id = ? AND status IN ('PENDING', 'UNCERTAIN')
    `);
  }

  #stored(
    request: HyperliquidTestnetTerminalExecutionRequest,
  ): HyperliquidTestnetTerminalExecutionResult | undefined {
    const row = this.#select.get(request.idempotencyKey) as StoredExecutionRow | undefined;
    if (row === undefined) return undefined;
    if (row.attempt_id !== request.attemptId) {
      throw new HyperliquidTestnetTerminalExecutionStateError(
        "IDEMPOTENCY_CONFLICT",
        "Hyperliquid idempotency key is already bound to a different attempt.",
      );
    }
    if (row.status === "PENDING" || row.status === "UNCERTAIN") throw uncertain();
    if (row.status !== "COMPLETED" || typeof row.result_json !== "string") {
      throw new HyperliquidTestnetTerminalExecutionStateError(
        "STORE_CORRUPT",
        "Stored Hyperliquid terminal execution is invalid.",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(row.result_json) as unknown;
    } catch {
      throw new HyperliquidTestnetTerminalExecutionStateError(
        "STORE_CORRUPT",
        "Stored Hyperliquid terminal execution is not valid JSON.",
      );
    }
    try {
      return validateHyperliquidTestnetTerminalExecutionResult(value, request);
    } catch {
      throw new HyperliquidTestnetTerminalExecutionStateError(
        "STORE_CORRUPT",
        "Stored Hyperliquid terminal execution failed validation.",
      );
    }
  }

  async #execute(
    request: HyperliquidTestnetTerminalExecutionRequest,
  ): Promise<HyperliquidTestnetTerminalExecutionResult> {
    const stored = this.#stored(request);
    if (stored !== undefined) return stored;
    this.#guard?.admit(request);
    try {
      this.#insertPending.run(request.idempotencyKey, request.attemptId);
    } catch {
      const raced = this.#stored(request);
      if (raced !== undefined) return raced;
      throw new HyperliquidTestnetTerminalExecutionStateError(
        "IDEMPOTENCY_CONFLICT",
        "Hyperliquid attempt is already bound to a different idempotency key.",
      );
    }

    try {
      const result = validateHyperliquidTestnetTerminalExecutionResult(
        await this.#executor.executeAttempt(request),
        request,
      );
      const serialized = JSON.stringify(result);
      const update = this.#complete.run(serialized, request.idempotencyKey, request.attemptId);
      if (update.changes !== 1) throw uncertain();
      this.#guard?.settle(request, result);
      return result;
    } catch (error) {
      try {
        this.#markUncertain.run(request.idempotencyKey, request.attemptId);
      } catch {
        throw uncertain();
      }
      throw error;
    }
  }

  /** The stored result, or the executor's later final result for a stored non-final one. */
  async #latest(
    request: HyperliquidTestnetTerminalExecutionRequest,
    stored: HyperliquidTestnetTerminalExecutionResult,
    storedJson: string,
  ): Promise<HyperliquidTestnetTerminalExecutionResult> {
    if (hyperliquidTerminalResultIsFinal(stored) || this.#executor.attemptStatus === undefined) return stored;
    let status: ExecutorAttemptStatus;
    try {
      status = await this.#executor.attemptStatus({ ...request, resolve: false });
    } catch {
      return stored;
    }
    if (status.state !== "COMPLETED" || status.result === null || status.result === undefined) return stored;
    let fresh: HyperliquidTestnetTerminalExecutionResult;
    try {
      fresh = validateHyperliquidTestnetTerminalExecutionResult(status.result, request);
    } catch {
      return stored;
    }
    if (!hyperliquidTerminalResultIsFinal(fresh)) return stored;
    // The owner ledger is settled first: if this process stops, or settling fails, before the stored
    // result is replaced, the attempt stays non-final and the next read or sweep settles it again
    // (settling is idempotent). The other order could leave a final result with an unsettled ledger.
    this.#guard?.settle(request, fresh);
    const update = this.#replaceUnresolved.run(JSON.stringify(fresh), request.idempotencyKey, request.attemptId, storedJson);
    return update.changes === 1 ? fresh : this.#stored(request)!;
  }

  /**
   * Server-side reconciliation: re-reads up to `limit` stored non-final attempts from the executor
   * and records any that became final, so owners' packages leave UNRESOLVED without anyone polling.
   * Returns how many were resolved.
   */
  async reconcileUnresolved(limit = 20, cursor: { offset: number } = { offset: 0 }): Promise<number> {
    type Row = { idempotency_key: string; attempt_id: string; result_json: string };
    // Pages through every non-final attempt across sweeps, so attempts that never become final
    // (abandoned holders, unknown outcomes) cannot starve newer ones.
    let rows = this.#selectUnresolved.all(limit, cursor.offset) as Row[];
    if (rows.length === 0 && cursor.offset > 0) {
      cursor.offset = 0;
      rows = this.#selectUnresolved.all(limit, 0) as Row[];
    }
    cursor.offset = rows.length < limit ? 0 : cursor.offset + limit;
    let resolved = 0;
    for (const row of rows) {
      const request = { attemptId: row.attempt_id, idempotencyKey: row.idempotency_key } as HyperliquidTestnetTerminalExecutionRequest;
      try {
        const stored = this.#stored(request)!;
        const result = await this.#latest(request, stored, row.result_json);
        if (result !== stored) resolved += 1;
      } catch {
        // One unreadable attempt never stops the sweep.
      }
    }
    return resolved;
  }

  execute(
    request: HyperliquidTestnetTerminalExecutionRequest,
  ): Promise<HyperliquidTestnetTerminalExecutionResult> {
    const current = this.#inFlight.get(request.idempotencyKey);
    if (current !== undefined) {
      if (current.attemptId !== request.attemptId) {
        return Promise.reject(new HyperliquidTestnetTerminalExecutionStateError(
          "IDEMPOTENCY_CONFLICT",
          "Hyperliquid idempotency key is already bound to a different attempt.",
        ));
      }
      return current.promise;
    }
    const promise = this.#execute(request).finally(() => {
      const entry = this.#inFlight.get(request.idempotencyKey);
      if (entry?.promise === promise) this.#inFlight.delete(request.idempotencyKey);
    });
    this.#inFlight.set(request.idempotencyKey, { attemptId: request.attemptId, promise });
    return promise;
  }

  requireOwnerAuthorization(request: HyperliquidTestnetTerminalExecutionRequest): void {
    this.#guard?.requireOwnerAuthorization(request);
  }

  /**
   * Where the attempt stands. Polling while this process waits on the executor only reads; an
   * uncertain handoff is resolved by the executor's durable record, fencing an attempt it never
   * received, so the stored outcome becomes definite without resubmission.
   */
  async status(request: HyperliquidTestnetTerminalExecutionRequest): Promise<HyperliquidTestnetAttemptState> {
    const row = this.#select.get(request.idempotencyKey) as StoredExecutionRow | undefined;
    if (row === undefined) return Object.freeze({ state: "NOT_STARTED" as const, lane: null });
    if (row.attempt_id !== request.attemptId) {
      throw new HyperliquidTestnetTerminalExecutionStateError(
        "IDEMPOTENCY_CONFLICT",
        "Hyperliquid idempotency key is already bound to a different attempt.",
      );
    }
    if (row.status === "COMPLETED") {
      const result = await this.#latest(request, this.#stored(request)!, row.result_json as string);
      this.#guard?.settle(request, result);
      return Object.freeze({ state: "COMPLETED" as const, result });
    }
    if (this.#executor.attemptStatus === undefined) {
      return Object.freeze({ state: "UNCERTAIN" as const, lane: null });
    }
    const inFlight = this.#inFlight.get(request.idempotencyKey)?.attemptId === request.attemptId;
    const status = await this.#executor.attemptStatus({ ...request, resolve: !inFlight });
    if (status.state === "COMPLETED" && status.result !== null) {
      if (!inFlight) {
        const update = this.#resolveUncertain.run(JSON.stringify(status.result), request.idempotencyKey, request.attemptId);
        if (update.changes === 1) this.#guard?.settle(request, status.result);
      }
      return Object.freeze({ state: "COMPLETED" as const, result: status.result });
    }
    if (status.state === "QUEUED") {
      return Object.freeze({ state: "QUEUED" as const, queuePosition: status.queuePosition ?? 0, lane: status.lane });
    }
    return Object.freeze({
      state: status.state === "EXECUTING" ? "EXECUTING" as const : "UNCERTAIN" as const,
      lane: status.lane,
    });
  }

  close(): void {
    this.#db.close();
  }
}
