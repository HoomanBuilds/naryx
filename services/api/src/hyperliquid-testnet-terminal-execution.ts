import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  validateHyperliquidTestnetTerminalExecutionResult,
  type HyperliquidTestnetTerminalExecutionPort,
  type HyperliquidTestnetTerminalExecutionRequest,
  type HyperliquidTestnetTerminalExecutionResult,
} from "./hyperliquid-testnet-terminal.js";

const SCHEMA_VERSION = 1;
let cachedRepositoryRoot: string | undefined;

type StoredExecutionRow = Readonly<{
  attempt_id: unknown;
  status: unknown;
  result_json: unknown;
}>;

export interface TrustedHyperliquidTestnetAttemptExecutor {
  executeAttempt(
    request: HyperliquidTestnetTerminalExecutionRequest,
  ): Promise<HyperliquidTestnetTerminalExecutionResult>;
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

  constructor(path: string, executor: TrustedHyperliquidTestnetAttemptExecutor) {
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

  close(): void {
    this.#db.close();
  }
}
