import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import bs58 from "bs58";
import {
  authorizeKeeperAction,
  keeperActionAuthorizationBytes,
  keeperActionAuthorizationHash,
  packageCloseCostIndex,
  parseProtocolJson,
  strategyHealthSnapshot,
  strategyHealthSnapshotHash,
  stringifyProtocolJson,
  toHex,
} from "@naryx/protocol-types";
import type {
  ActivationConditionInput,
  KeeperActionAuthorizationInput,
  NormalizedPositionInput,
  StrategyHealthSnapshotInput,
} from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";
import { verifyEd25519 } from "./ed25519.js";
import { internalCaller, readInternalBody, sendError, sendJson } from "./internal-http.js";
import type { SqlitePositionSnapshotStore } from "./position-snapshot-store.js";
import type { SqliteStrategyBookStore } from "./strategy-book-store.js";

export class KeeperExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "KeeperExecutorError";
    this.code = code;
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS health_snapshots (
  snapshot_hash BLOB PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  observed_at_value TEXT NOT NULL,
  authority TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS health_snapshots_by_strategy ON health_snapshots(strategy_id, recorded_at_ms);
CREATE TABLE IF NOT EXISTS keeper_executions (
  authorization_hash BLOB PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  authorization_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL,
  queued_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS keeper_executions_by_status ON keeper_executions(status, queued_at_ms);
CREATE TRIGGER IF NOT EXISTS reject_health_change BEFORE UPDATE ON health_snapshots BEGIN SELECT RAISE(ABORT, 'health snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_health_delete BEFORE DELETE ON health_snapshots BEGIN SELECT RAISE(ABORT, 'health snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_execution_delete BEFORE DELETE ON keeper_executions BEGIN SELECT RAISE(ABORT, 'keeper executions are append-only'); END;
`;

export interface KeeperActionPlan {
  readonly after: StrategyHealthSnapshotInput;
  readonly costQuoteAtoms: bigint;
  readonly rewardQuoteAtoms: bigint;
  readonly grantsAuthority: boolean;
}

const EXIT_KINDS = new Set(["SCHEDULED_EXIT", "RECOVERY", "EMERGENCY_RISK_REDUCTION"]);

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function notional(position: NormalizedPositionInput, quantity: bigint): bigint {
  const price = position.markPrice;
  return (absolute(quantity) * price.quoteAtoms) / price.baseAtoms;
}

/**
 * The executor behind keeper automation. It keeps authority-signed strategy health snapshots,
 * projects the actions it can price from the strategy's signed positions (exit-class actions close
 * every leg; a rebalance trims the leg that carries the excess delta), re-runs the kernel keeper
 * gate itself against current health and the strategy owner's signature, and queues an authorized
 * action exactly once for the domain runtime that executes it. It holds no signing key.
 */
export class SqliteKeeperExecutor {
  private readonly db: Database.Database;
  private readonly clock: () => number;
  private readonly options: {
    readonly authorities: ReadonlyMap<string, Uint8Array>;
    readonly strategies: Pick<SqliteStrategyBookStore, "strategy">;
    readonly positions?: Pick<SqlitePositionSnapshotStore, "latest">;
    readonly clock?: () => number;
  };

  constructor(dbPath: string, options: SqliteKeeperExecutor["options"]) {
    this.options = options;
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new KeeperExecutorError(code, message));
    this.clock = options.clock ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  /** Stores a health snapshot signed by a configured authority over its hash. */
  publishHealth(snapshot: StrategyHealthSnapshotInput, authority: string, signature: Uint8Array): { readonly snapshotHash: string; readonly replayed: boolean } {
    let hash: Uint8Array;
    try {
      strategyHealthSnapshot(snapshot);
      hash = strategyHealthSnapshotHash(snapshot);
    } catch (error) {
      throw new KeeperExecutorError("INVALID_SNAPSHOT", (error as Error).message);
    }
    const key = this.options.authorities.get(authority);
    if (key === undefined) throw new KeeperExecutorError("UNKNOWN_AUTHORITY", "The snapshot authority is not configured.");
    if (!verifyEd25519(key, hash, signature)) throw new KeeperExecutorError("INVALID_SIGNATURE", "The authority did not sign this snapshot.");
    const known = this.db.prepare("SELECT 1 FROM health_snapshots WHERE snapshot_hash = ?").get(hash);
    if (known !== undefined) return { snapshotHash: toHex(hash), replayed: true };
    this.db
      .prepare("INSERT INTO health_snapshots (snapshot_hash, strategy_id, observed_at_value, authority, snapshot_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?)")
      .run(hash, snapshot.strategyId, snapshot.observedAtValue.toString(), authority, stringifyProtocolJson(snapshot), this.clock());
    return { snapshotHash: toHex(hash), replayed: false };
  }

  /**
   * The newest snapshot of the strategy's current state, or nothing when the strategy is unknown,
   * retired, or no snapshot describes its current state hash.
   */
  health(strategyId: string): { readonly before: StrategyHealthSnapshotInput; readonly stateHash: string; readonly manualTakeover: boolean } | undefined {
    const stored = this.options.strategies.strategy(strategyId);
    if (stored === undefined || stored.retiredByCommandHashHex !== undefined || !stored.state.open) return undefined;
    const rows = this.db
      .prepare("SELECT snapshot_json FROM health_snapshots WHERE strategy_id = ? ORDER BY recorded_at_ms DESC, rowid DESC LIMIT 32")
      .all(strategyId) as { snapshot_json: string }[];
    for (const row of rows) {
      const snapshot = parseProtocolJson(row.snapshot_json) as StrategyHealthSnapshotInput;
      const hash = typeof snapshot.strategyStateHash === "string" ? snapshot.strategyStateHash.toLowerCase() : toHex(snapshot.strategyStateHash);
      if (hash === stored.stateHashHex) return { before: snapshot, stateHash: stored.stateHashHex, manualTakeover: false };
    }
    return undefined;
  }

  /** Projects the action from the strategy's signed positions; undefined for actions it cannot price. */
  plan(authorization: KeeperActionAuthorizationInput, before: StrategyHealthSnapshotInput): KeeperActionPlan | undefined {
    const positions = (this.options.positions?.latest(authorization.strategyId) ?? []).flatMap((entry) => entry.record.positions as readonly NormalizedPositionInput[]);
    if (positions.length === 0) return undefined;
    const reward = authorization.rewardQuoteAtoms;
    if (EXIT_KINDS.has(authorization.actionKind)) {
      const cost = packageCloseCostIndex(positions);
      if (!cost.complete) return undefined;
      return {
        after: {
          ...before,
          deltaBaseAtoms: 0n,
          grossNotionalQuoteAtoms: 0n,
          leverageBps: 0n,
          marginHealthBps: 10_000n > before.marginHealthBps ? 10_000n : before.marginHealthBps,
          residualBaseAtoms: 0n,
          maximumLossBoundQuoteAtoms: 0n,
        },
        costQuoteAtoms: cost.costQuoteAtoms,
        rewardQuoteAtoms: reward,
        grantsAuthority: false,
      };
    }
    if (authorization.actionKind === "REBALANCE") {
      const delta = positions.reduce((sum, position) => sum + position.quantityBaseAtoms, 0n);
      if (delta === 0n) return undefined;
      // Trim the legs that carry the excess, largest first, until the package is delta neutral.
      let remaining = absolute(delta);
      const trims: NormalizedPositionInput[] = [];
      let trimmedNotional = 0n;
      for (const position of [...positions].filter((entry) => (entry.quantityBaseAtoms > 0n) === (delta > 0n)).sort((a, b) => (absolute(b.quantityBaseAtoms) > absolute(a.quantityBaseAtoms) ? 1 : -1))) {
        if (remaining === 0n) break;
        const take = absolute(position.quantityBaseAtoms) < remaining ? absolute(position.quantityBaseAtoms) : remaining;
        trims.push({ ...position, quantityBaseAtoms: position.quantityBaseAtoms > 0n ? take : -take });
        trimmedNotional += notional(position, take);
        remaining -= take;
      }
      const cost = packageCloseCostIndex(trims);
      if (!cost.complete || before.grossNotionalQuoteAtoms === 0n) return undefined;
      const afterGross = before.grossNotionalQuoteAtoms > trimmedNotional ? before.grossNotionalQuoteAtoms - trimmedNotional : 0n;
      const scale = (value: bigint) => (value * afterGross) / before.grossNotionalQuoteAtoms;
      return {
        after: {
          ...before,
          deltaBaseAtoms: 0n,
          grossNotionalQuoteAtoms: afterGross,
          leverageBps: scale(before.leverageBps),
          maximumLossBoundQuoteAtoms: scale(before.maximumLossBoundQuoteAtoms),
        },
        costQuoteAtoms: cost.costQuoteAtoms,
        rewardQuoteAtoms: reward,
        grantsAuthority: false,
      };
    }
    // Rolls and funding settlement need venue-specific pricing this executor does not hold.
    return undefined;
  }

  /**
   * Re-authorizes and queues an action. The owner's signature is checked against the strategy's
   * owner key, and the kernel gate runs again on current health; the executor never trusts the
   * keeper's verdict. An authorization is queued at most once.
   */
  execute(input: {
    readonly keeperId: string;
    readonly authorization: KeeperActionAuthorizationInput;
    readonly ownerSignature: Uint8Array;
    readonly condition: ActivationConditionInput;
    readonly lifecycleGraphHash: string;
    readonly atValue: bigint;
  }): { readonly status: "QUEUED" | "REJECTED"; readonly reason?: string } {
    const hash = keeperActionAuthorizationHash(input.authorization);
    const stored = this.options.strategies.strategy(input.authorization.strategyId);
    if (stored === undefined) return { status: "REJECTED", reason: "STRATEGY_NOT_FOUND" };
    let owner: Uint8Array;
    try {
      owner = bs58.decode(stored.state.ownerId);
    } catch {
      return { status: "REJECTED", reason: "OWNER_KEY_INVALID" };
    }
    if (owner.length !== 32 || !verifyEd25519(owner, keeperActionAuthorizationBytes(input.authorization), input.ownerSignature)) {
      return { status: "REJECTED", reason: "OWNER_SIGNATURE_INVALID" };
    }
    const health = this.health(input.authorization.strategyId);
    if (health === undefined) return { status: "REJECTED", reason: "HEALTH_UNAVAILABLE" };
    const plan = this.plan(input.authorization, health.before);
    if (plan === undefined) return { status: "REJECTED", reason: "NO_PLAN" };
    return this.db.transaction(() => {
      const known = this.db.prepare("SELECT status FROM keeper_executions WHERE authorization_hash = ?").get(hash) as { status: string } | undefined;
      const decision = authorizeKeeperAction(input.authorization, {
        keeperId: input.keeperId,
        lifecycleGraphHash: input.lifecycleGraphHash,
        condition: input.condition,
        before: health.before,
        after: plan.after,
        currentStrategyStateHash: health.stateHash,
        costQuoteAtoms: plan.costQuoteAtoms,
        rewardQuoteAtoms: plan.rewardQuoteAtoms,
        grantsAuthority: plan.grantsAuthority,
        manualTakeover: health.manualTakeover,
        nonceConsumed: known !== undefined,
        atValue: input.atValue,
      });
      if (!decision.authorized) return { status: "REJECTED" as const, reason: decision.reason };
      this.db
        .prepare("INSERT INTO keeper_executions (authorization_hash, strategy_id, action_kind, authorization_json, plan_json, status, queued_at_ms) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?)")
        .run(hash, input.authorization.strategyId, input.authorization.actionKind, stringifyProtocolJson(input.authorization), stringifyProtocolJson(plan), this.clock());
      return { status: "QUEUED" as const };
    }).immediate();
  }

  /** Queued actions for the domain runtimes, oldest first. */
  queued(limit = 100): readonly { readonly authorizationHash: string; readonly strategyId: string; readonly actionKind: string; readonly plan: KeeperActionPlan; readonly queuedAtMs: number }[] {
    const rows = this.db
      .prepare("SELECT authorization_hash, strategy_id, action_kind, plan_json, queued_at_ms FROM keeper_executions WHERE status = 'QUEUED' ORDER BY queued_at_ms, rowid LIMIT ?")
      .all(Math.min(Math.max(1, limit), 500)) as { authorization_hash: Uint8Array; strategy_id: string; action_kind: string; plan_json: string; queued_at_ms: number }[];
    return rows.map((row) => Object.freeze({ authorizationHash: toHex(row.authorization_hash), strategyId: row.strategy_id, actionKind: row.action_kind, plan: parseProtocolJson(row.plan_json) as KeeperActionPlan, queuedAtMs: row.queued_at_ms }));
  }
}

/** The executor's clock in an authorization's expiry unit; Solana slots need a slot reader. */
export function keeperClock(clockMs: () => number = Date.now): (unit: string) => bigint | undefined {
  return (unit) => {
    if (unit === "EVM_UNIX_SECONDS") return BigInt(Math.floor(clockMs() / 1_000));
    if (unit === "HYPERLIQUID_UNIX_MILLISECONDS") return BigInt(Math.floor(clockMs()));
    return undefined;
  };
}

/**
 * Loopback routes the keeper calls: `GET /internal/keeper/strategies/{id}/health`,
 * `POST /internal/keeper/plan`, `POST /internal/keeper/execute`, and `GET /internal/keeper/queue`.
 * Mount only on the private server.
 */
export function createKeeperExecutorHandler(options: {
  readonly executor: SqliteKeeperExecutor;
  readonly nowIn: (unit: string) => bigint | undefined;
}): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://internal.local");
    if (!url.pathname.startsWith("/internal/keeper/")) return false;
    const fail = (status: number, code: string, message: string) => sendError(response, status, code, message);
    if (!internalCaller(request)) return fail(403, "FORBIDDEN", "Keeper routes answer loopback callers only.");
    const match = /^\/internal\/keeper\/strategies\/([A-Za-z0-9._:-]{1,128})\/health$/.exec(url.pathname);
    if (request.method === "GET" && match !== null) {
      const health = options.executor.health(match[1] as string);
      return health === undefined ? fail(404, "HEALTH_UNAVAILABLE", "No health snapshot describes the strategy's current state.") : sendJson(response, 200, health);
    }
    if (request.method === "GET" && url.pathname === "/internal/keeper/queue") return sendJson(response, 200, { queued: options.executor.queued() });
    if (request.method !== "POST" || (url.pathname !== "/internal/keeper/plan" && url.pathname !== "/internal/keeper/execute")) return fail(404, "NOT_FOUND", "Unknown keeper route.");
    readInternalBody(request, response, (body) => {
      try {
        if (url.pathname === "/internal/keeper/plan") {
          const plan = options.executor.plan(body.authorization as KeeperActionAuthorizationInput, body.before as StrategyHealthSnapshotInput);
          return plan === undefined ? fail(404, "NO_PLAN", "This executor cannot price that action for the strategy.") : sendJson(response, 200, plan);
        }
        const authorization = body.authorization as KeeperActionAuthorizationInput;
        const atValue = options.nowIn(authorization.expiryUnit);
        if (atValue === undefined) return fail(400, "TIME_UNIT_UNSUPPORTED", "The executor has no clock in the authorization's unit.");
        return sendJson(response, 200, options.executor.execute({
          keeperId: String(body.keeperId),
          authorization,
          ownerSignature: body.ownerSignature as Uint8Array,
          condition: body.condition as ActivationConditionInput,
          lifecycleGraphHash: String(body.lifecycleGraphHash),
          atValue,
        }));
      } catch (error) {
        return fail(400, error instanceof KeeperExecutorError ? error.code : "INVALID_REQUEST", (error as Error).message);
      }
    });
    return true;
  };
}
