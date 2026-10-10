import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  activateStrategyPackageOrder,
  activationCondition,
  activationConditionHash,
  executionSchedule,
  executionScheduleHash,
  parseProtocolJson,
  strategyPackageOrder,
  strategyPackageOrderHash,
  stringifyProtocolJson,
  toHex,
  twapSliceWithinLimit,
} from "@naryx/protocol-types";
import type {
  ActivationConditionInput,
  ExecutionScheduleInput,
  MetricObservation,
  ScheduleProgress,
  StrategyPackageOrder,
} from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";
import type { StoredStrategyPackageOrder } from "./strategy-package-store.js";

export class OrderActivationStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OrderActivationStoreError";
    this.code = code;
  }
}

export type OrderActivationStatus = "WAITING" | "COMPLETED" | "STOPPED" | "CANCELLED" | "EXPIRED";
export type OrderActivationAttemptStatus = "RESERVED" | "SUCCEEDED" | "FAILED";

export interface OrderActivationAttempt {
  readonly attemptId: string;
  readonly orderHashHex: string;
  readonly ordinal: number;
  readonly sliceIndex?: number;
  readonly atValue: bigint;
  readonly maximumQuantityAtoms: bigint;
  readonly side: "BID" | "ASK";
  readonly limitPriceTicks: bigint;
  readonly status: OrderActivationAttemptStatus;
  readonly executedQuantityAtoms?: bigint;
  readonly executionPriceTicks?: bigint;
  readonly failureReason?: string;
  readonly reservedAtMs: number;
  readonly completedAtMs?: number;
}

export interface OrderActivationView {
  readonly orderHashHex: string;
  readonly order: StrategyPackageOrder;
  readonly condition?: ActivationConditionInput;
  readonly schedule?: ExecutionScheduleInput;
  readonly status: OrderActivationStatus;
  readonly progress: ScheduleProgress;
  readonly attempts: readonly OrderActivationAttempt[];
  readonly registeredAtMs: number;
  readonly updatedAtMs: number;
}

export type OrderActivationReservation =
  | { readonly active: true; readonly replayed: boolean; readonly attempt: OrderActivationAttempt }
  | { readonly active: false; readonly reason: string };

type StrategyOrderSource = Pick<{ order(orderHashHex: string): StoredStrategyPackageOrder | undefined }, "order">;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS order_activations (
  order_hash BLOB PRIMARY KEY,
  order_json TEXT NOT NULL,
  condition_json TEXT,
  schedule_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('WAITING', 'COMPLETED', 'STOPPED', 'CANCELLED', 'EXPIRED')),
  registered_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS order_activation_attempts (
  attempt_id TEXT PRIMARY KEY,
  order_hash BLOB NOT NULL REFERENCES order_activations(order_hash),
  ordinal INTEGER NOT NULL,
  slice_index INTEGER,
  at_value TEXT NOT NULL,
  maximum_quantity_atoms TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BID', 'ASK')),
  limit_price_ticks TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'SUCCEEDED', 'FAILED')),
  executed_quantity_atoms TEXT,
  execution_price_ticks TEXT,
  failure_reason TEXT,
  reserved_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  UNIQUE (order_hash, ordinal)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_reserved_activation_attempt
  ON order_activation_attempts(order_hash) WHERE status = 'RESERVED';
CREATE UNIQUE INDEX IF NOT EXISTS one_activation_attempt_per_slice
  ON order_activation_attempts(order_hash, slice_index) WHERE slice_index IS NOT NULL;
CREATE INDEX IF NOT EXISTS activation_attempts_by_order
  ON order_activation_attempts(order_hash, ordinal);
CREATE TRIGGER IF NOT EXISTS reject_activation_delete BEFORE DELETE ON order_activations BEGIN SELECT RAISE(ABORT, 'order activations cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS reject_activation_attempt_delete BEFORE DELETE ON order_activation_attempts BEGIN SELECT RAISE(ABORT, 'activation attempts cannot be deleted'); END;
`;

function hashBytes(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OrderActivationStoreError("INVALID_HASH", "Order hash must be 32 lowercase hex bytes.");
  return Buffer.from(value, "hex");
}

function supportedEnvironment(environment: string): boolean {
  return environment === "local" || environment === "testnet" || environment === "devnet";
}

function attemptId(orderHashHex: string, ordinal: number): string {
  return createHash("sha256").update(`naryx/activation-attempt/v1:${orderHashHex}:${ordinal}`).digest("hex");
}

function integer(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new OrderActivationStoreError("CORRUPT_ROW", `${context} is not a nonnegative safe integer.`);
  }
  return value;
}

function storedBigint(value: unknown, context: string): bigint {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new OrderActivationStoreError("CORRUPT_ROW", `${context} is not a canonical integer.`);
  }
  return BigInt(value);
}

export class SqliteOrderActivationStore {
  private readonly db: Database.Database;
  private readonly orders: StrategyOrderSource;
  private readonly clock: () => number;

  constructor(dbPath: string, options: { readonly orders: StrategyOrderSource; readonly clock?: () => number }) {
    this.orders = options.orders;
    this.clock = options.clock ?? Date.now;
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new OrderActivationStoreError(code, message));
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(run: () => T): T {
    return this.db.transaction(run).immediate();
  }

  register(input: {
    readonly orderHashHex: string;
    readonly condition?: ActivationConditionInput;
    readonly schedule?: ExecutionScheduleInput;
  }): { readonly created: boolean; readonly view: OrderActivationView } {
    const orderHash = hashBytes(input.orderHashHex);
    const stored = this.orders.order(input.orderHashHex);
    if (stored === undefined) throw new OrderActivationStoreError("ORDER_NOT_FOUND", "No admitted strategy package order has this hash.");
    const order = strategyPackageOrder(stored.order);
    if (toHex(strategyPackageOrderHash(order)) !== input.orderHashHex) {
      throw new OrderActivationStoreError("ORDER_MISMATCH", "The admitted strategy order does not match its hash.");
    }
    if (!supportedEnvironment(order.environment)) {
      throw new OrderActivationStoreError("UNSUPPORTED_ENVIRONMENT", "Order activation is limited to local, devnet, and testnet environments.");
    }
    if (order.packageOrderType !== "CONDITIONAL" && order.packageOrderType !== "SCHEDULED" && order.packageOrderType !== "PACKAGE_TWAP") {
      throw new OrderActivationStoreError("ORDER_NOT_ADVANCED", "Only conditional, scheduled, and package TWAP orders use the activation runtime.");
    }
    const condition = input.condition === undefined ? undefined : activationCondition(input.condition);
    const schedule = input.schedule === undefined ? undefined : executionSchedule(input.schedule);
    if ((order.activationConditionHash === undefined) !== (condition === undefined)) {
      throw new OrderActivationStoreError("CONDITION_MISMATCH", "The activation condition document does not match the order binding.");
    }
    if (condition !== undefined && toHex(activationConditionHash(condition)) !== toHex(order.activationConditionHash!)) {
      throw new OrderActivationStoreError("CONDITION_MISMATCH", "The activation condition document does not match the order binding.");
    }
    if ((order.executionScheduleHash === undefined) !== (schedule === undefined)) {
      throw new OrderActivationStoreError("SCHEDULE_MISMATCH", "The execution schedule document does not match the order binding.");
    }
    if (schedule !== undefined && toHex(executionScheduleHash(schedule)) !== toHex(order.executionScheduleHash!)) {
      throw new OrderActivationStoreError("SCHEDULE_MISMATCH", "The execution schedule document does not match the order binding.");
    }
    const orderJson = stringifyProtocolJson(order);
    const conditionJson = condition === undefined ? null : stringifyProtocolJson(condition);
    const scheduleJson = schedule === undefined ? null : stringifyProtocolJson(schedule);
    const created = this.transaction(() => {
      const known = this.db.prepare("SELECT order_json, condition_json, schedule_json FROM order_activations WHERE order_hash = ?").get(orderHash) as {
        order_json: string;
        condition_json: string | null;
        schedule_json: string | null;
      } | undefined;
      if (known !== undefined) {
        if (known.order_json !== orderJson || known.condition_json !== conditionJson || known.schedule_json !== scheduleJson) {
          throw new OrderActivationStoreError("REGISTRATION_CONFLICT", "This order activation was registered with different documents.");
        }
        return false;
      }
      const now = this.clock();
      this.db.prepare(`
        INSERT INTO order_activations
          (order_hash, order_json, condition_json, schedule_json, status, registered_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, 'WAITING', ?, ?)
      `).run(orderHash, orderJson, conditionJson, scheduleJson, now, now);
      return true;
    });
    return { created, view: this.requireView(input.orderHashHex) };
  }

  view(orderHashHex: string): OrderActivationView | undefined {
    const row = this.db.prepare(`
      SELECT order_json, condition_json, schedule_json, status, registered_at_ms, updated_at_ms
      FROM order_activations WHERE order_hash = ?
    `).get(hashBytes(orderHashHex)) as {
      order_json: string;
      condition_json: string | null;
      schedule_json: string | null;
      status: OrderActivationStatus;
      registered_at_ms: number;
      updated_at_ms: number;
    } | undefined;
    if (row === undefined) return undefined;
    const order = strategyPackageOrder(parseProtocolJson(row.order_json) as StrategyPackageOrder);
    if (toHex(strategyPackageOrderHash(order)) !== orderHashHex) throw new OrderActivationStoreError("CORRUPT_ROW", "Stored activation order does not match its hash.");
    const condition = row.condition_json === null ? undefined : activationCondition(parseProtocolJson(row.condition_json) as ActivationConditionInput);
    const schedule = row.schedule_json === null ? undefined : executionSchedule(parseProtocolJson(row.schedule_json) as ExecutionScheduleInput);
    const attempts = this.attempts(orderHashHex);
    return Object.freeze({
      orderHashHex,
      order,
      ...(condition === undefined ? {} : { condition }),
      ...(schedule === undefined ? {} : { schedule }),
      status: row.status,
      progress: this.progress(attempts),
      attempts,
      registeredAtMs: integer(row.registered_at_ms, "registered_at_ms"),
      updatedAtMs: integer(row.updated_at_ms, "updated_at_ms"),
    });
  }

  reserve(input: {
    readonly orderHashHex: string;
    readonly observations: readonly MetricObservation[];
    readonly atValue: bigint;
    readonly side: "BID" | "ASK";
    readonly limitPriceTicks: bigint;
  }): OrderActivationReservation {
    if (input.side !== "BID" && input.side !== "ASK") throw new OrderActivationStoreError("INVALID_SIDE", "Activation side must be BID or ASK.");
    if (typeof input.atValue !== "bigint" || input.atValue < 0n || typeof input.limitPriceTicks !== "bigint") {
      throw new OrderActivationStoreError("INVALID_ATTEMPT", "Activation time and limit price must be exact integers.");
    }
    return this.transaction(() => {
      const view = this.requireView(input.orderHashHex);
      if (view.status !== "WAITING") return { active: false, reason: view.status };
      const outstanding = view.attempts.find((attempt) => attempt.status === "RESERVED");
      if (outstanding !== undefined) return { active: true, replayed: true, attempt: outstanding };
      const activation = activateStrategyPackageOrder(view.order, {
        ...(view.condition === undefined ? {} : { condition: view.condition }),
        ...(view.schedule === undefined ? {} : { schedule: view.schedule }),
        observations: input.observations,
        progress: view.progress,
        atValue: input.atValue,
      });
      if (!activation.active) {
        if (activation.reason === "ORDER_EXPIRED") this.setStatus(input.orderHashHex, "EXPIRED");
        return { active: false, reason: activation.reason };
      }
      let maximumQuantityAtoms = activation.maximumQuantityAtoms;
      if (view.order.packageOrderType === "CONDITIONAL") {
        const remaining = view.order.economicQuantity.atoms - view.progress.executedQuantity;
        if (remaining <= 0n) {
          this.setStatus(input.orderHashHex, "COMPLETED");
          return { active: false, reason: "COMPLETE" };
        }
        if (remaining < maximumQuantityAtoms) maximumQuantityAtoms = remaining;
      }
      if (view.schedule?.kind === "PACKAGE_TWAP" && !twapSliceWithinLimit(view.schedule, view.progress, input.side, input.limitPriceTicks, maximumQuantityAtoms)) {
        return { active: false, reason: "TWAP_LIMIT_EXCEEDED" };
      }
      const ordinal = view.attempts.length;
      const id = attemptId(input.orderHashHex, ordinal);
      const reservedAtMs = this.clock();
      this.db.prepare(`
        INSERT INTO order_activation_attempts
          (attempt_id, order_hash, ordinal, slice_index, at_value, maximum_quantity_atoms, side,
           limit_price_ticks, status, reserved_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?)
      `).run(
        id,
        hashBytes(input.orderHashHex),
        ordinal,
        activation.sliceIndex ?? null,
        input.atValue.toString(),
        maximumQuantityAtoms.toString(),
        input.side,
        input.limitPriceTicks.toString(),
        reservedAtMs,
      );
      this.touch(input.orderHashHex);
      return {
        active: true,
        replayed: false,
        attempt: Object.freeze({
          attemptId: id,
          orderHashHex: input.orderHashHex,
          ordinal,
          ...(activation.sliceIndex === undefined ? {} : { sliceIndex: activation.sliceIndex }),
          atValue: input.atValue,
          maximumQuantityAtoms,
          side: input.side,
          limitPriceTicks: input.limitPriceTicks,
          status: "RESERVED" as const,
          reservedAtMs,
        }),
      };
    });
  }

  complete(input: {
    readonly attemptId: string;
    readonly outcome: "SUCCEEDED" | "FAILED";
    readonly executedQuantityAtoms: bigint;
    readonly executionPriceTicks?: bigint;
    readonly failureReason?: string;
  }): { readonly replayed: boolean; readonly view: OrderActivationView } {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT order_hash, maximum_quantity_atoms, side, limit_price_ticks, status,
               executed_quantity_atoms, execution_price_ticks, failure_reason
        FROM order_activation_attempts WHERE attempt_id = ?
      `).get(input.attemptId) as {
        order_hash: Uint8Array;
        maximum_quantity_atoms: string;
        side: "BID" | "ASK";
        limit_price_ticks: string;
        status: OrderActivationAttemptStatus;
        executed_quantity_atoms: string | null;
        execution_price_ticks: string | null;
        failure_reason: string | null;
      } | undefined;
      if (row === undefined) throw new OrderActivationStoreError("ATTEMPT_NOT_FOUND", "No activation attempt has this id.");
      const orderHashHex = toHex(row.order_hash);
      const executionPrice = input.executionPriceTicks;
      if (row.status !== "RESERVED") {
        const same = row.status === input.outcome
          && row.executed_quantity_atoms === input.executedQuantityAtoms.toString()
          && row.execution_price_ticks === (executionPrice?.toString() ?? null)
          && row.failure_reason === (input.failureReason ?? null);
        if (!same) throw new OrderActivationStoreError("ATTEMPT_CONFLICT", "The activation attempt already has another outcome.");
        return { replayed: true, view: this.requireView(orderHashHex) };
      }
      const view = this.requireView(orderHashHex);
      const maximum = storedBigint(row.maximum_quantity_atoms, "maximum_quantity_atoms");
      if (input.outcome === "FAILED") {
        if (input.executedQuantityAtoms !== 0n || executionPrice !== undefined || typeof input.failureReason !== "string" || input.failureReason.length < 1 || input.failureReason.length > 280) {
          throw new OrderActivationStoreError("INVALID_FAILURE", "A failed attempt has zero execution and a bounded reason.");
        }
      } else {
        if (input.executedQuantityAtoms !== maximum || executionPrice === undefined || input.failureReason !== undefined) {
          throw new OrderActivationStoreError("INVALID_SUCCESS", "A successful activation must execute its exact reserved quantity and price.");
        }
        const limit = storedBigint(row.limit_price_ticks, "limit_price_ticks");
        if ((row.side === "BID" && executionPrice > limit) || (row.side === "ASK" && executionPrice < limit)) {
          throw new OrderActivationStoreError("PRICE_LIMIT_EXCEEDED", "Execution price violates the reserved exact limit.");
        }
        if (view.schedule?.kind === "PACKAGE_TWAP" && !twapSliceWithinLimit(view.schedule, view.progress, row.side, executionPrice, input.executedQuantityAtoms)) {
          throw new OrderActivationStoreError("TWAP_LIMIT_EXCEEDED", "Execution would violate the signed aggregate TWAP limit.");
        }
      }
      const completedAtMs = this.clock();
      this.db.prepare(`
        UPDATE order_activation_attempts
        SET status = ?, executed_quantity_atoms = ?, execution_price_ticks = ?, failure_reason = ?, completed_at_ms = ?
        WHERE attempt_id = ? AND status = 'RESERVED'
      `).run(
        input.outcome,
        input.executedQuantityAtoms.toString(),
        executionPrice?.toString() ?? null,
        input.failureReason ?? null,
        completedAtMs,
        input.attemptId,
      );
      const updated = this.requireView(orderHashHex);
      let status: OrderActivationStatus = "WAITING";
      if (view.order.packageOrderType === "CONDITIONAL" && input.outcome === "SUCCEEDED") {
        status = "COMPLETED";
      } else if (view.schedule !== undefined) {
        const attempt = updated.attempts.find((candidate) => candidate.attemptId === input.attemptId)!;
        if (input.outcome === "FAILED" && view.schedule.stopRule === "STOP_ON_FIRST_FAILURE") status = "STOPPED";
        else if (updated.progress.executedQuantity >= view.schedule.aggregateQuantityLimit
          || attempt.sliceIndex === view.schedule.sliceCount - 1) status = "COMPLETED";
      }
      this.setStatus(orderHashHex, status);
      return { replayed: false, view: this.requireView(orderHashHex) };
    });
  }

  cancel(orderHashHex: string): OrderActivationView {
    return this.transaction(() => {
      const view = this.requireView(orderHashHex);
      if (view.status === "CANCELLED") return view;
      if (view.status !== "WAITING") throw new OrderActivationStoreError("ORDER_TERMINAL", `Activation status is ${view.status}.`);
      if (view.attempts.some((attempt) => attempt.status === "RESERVED")) {
        throw new OrderActivationStoreError("ATTEMPT_OUTSTANDING", "Resolve the reserved attempt before cancellation.");
      }
      this.setStatus(orderHashHex, "CANCELLED");
      return this.requireView(orderHashHex);
    });
  }

  private requireView(orderHashHex: string): OrderActivationView {
    const view = this.view(orderHashHex);
    if (view === undefined) throw new OrderActivationStoreError("ACTIVATION_NOT_FOUND", "No activation is registered for this order.");
    return view;
  }

  private attempts(orderHashHex: string): readonly OrderActivationAttempt[] {
    const rows = this.db.prepare(`
      SELECT attempt_id, ordinal, slice_index, at_value, maximum_quantity_atoms, side,
             limit_price_ticks, status, executed_quantity_atoms, execution_price_ticks,
             failure_reason, reserved_at_ms, completed_at_ms
      FROM order_activation_attempts WHERE order_hash = ? ORDER BY ordinal
    `).all(hashBytes(orderHashHex)) as Array<{
      attempt_id: string;
      ordinal: number;
      slice_index: number | null;
      at_value: string;
      maximum_quantity_atoms: string;
      side: "BID" | "ASK";
      limit_price_ticks: string;
      status: OrderActivationAttemptStatus;
      executed_quantity_atoms: string | null;
      execution_price_ticks: string | null;
      failure_reason: string | null;
      reserved_at_ms: number;
      completed_at_ms: number | null;
    }>;
    return Object.freeze(rows.map((row) => Object.freeze({
      attemptId: row.attempt_id,
      orderHashHex,
      ordinal: integer(row.ordinal, "ordinal"),
      ...(row.slice_index === null ? {} : { sliceIndex: integer(row.slice_index, "slice_index") }),
      atValue: storedBigint(row.at_value, "at_value"),
      maximumQuantityAtoms: storedBigint(row.maximum_quantity_atoms, "maximum_quantity_atoms"),
      side: row.side,
      limitPriceTicks: storedBigint(row.limit_price_ticks, "limit_price_ticks"),
      status: row.status,
      ...(row.executed_quantity_atoms === null ? {} : { executedQuantityAtoms: storedBigint(row.executed_quantity_atoms, "executed_quantity_atoms") }),
      ...(row.execution_price_ticks === null ? {} : { executionPriceTicks: storedBigint(row.execution_price_ticks, "execution_price_ticks") }),
      ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
      reservedAtMs: integer(row.reserved_at_ms, "reserved_at_ms"),
      ...(row.completed_at_ms === null ? {} : { completedAtMs: integer(row.completed_at_ms, "completed_at_ms") }),
    })));
  }

  private progress(attempts: readonly OrderActivationAttempt[]): ScheduleProgress {
    const completed = attempts.filter((attempt) => attempt.status !== "RESERVED");
    const succeeded = completed.filter((attempt) => attempt.status === "SUCCEEDED");
    const last = completed.reduce<number | undefined>((maximum, attempt) => {
      if (attempt.sliceIndex === undefined) return maximum;
      return maximum === undefined || attempt.sliceIndex > maximum ? attempt.sliceIndex : maximum;
    }, undefined);
    return Object.freeze({
      executedQuantity: succeeded.reduce((sum, attempt) => sum + (attempt.executedQuantityAtoms ?? 0n), 0n),
      executedNotionalTicks: succeeded.reduce((sum, attempt) => sum + (attempt.executedQuantityAtoms ?? 0n) * (attempt.executionPriceTicks ?? 0n), 0n),
      attemptedSlices: completed.length,
      failedSlices: completed.filter((attempt) => attempt.status === "FAILED").length,
      ...(last === undefined ? {} : { lastAttemptedSliceIndex: last }),
    });
  }

  private setStatus(orderHashHex: string, status: OrderActivationStatus): void {
    this.db.prepare("UPDATE order_activations SET status = ?, updated_at_ms = ? WHERE order_hash = ?")
      .run(status, this.clock(), hashBytes(orderHashHex));
  }

  private touch(orderHashHex: string): void {
    this.db.prepare("UPDATE order_activations SET updated_at_ms = ? WHERE order_hash = ?")
      .run(this.clock(), hashBytes(orderHashHex));
  }
}
