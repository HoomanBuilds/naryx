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
  strategySlicePolicy,
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
  StrategySlicePolicy,
  StrategySlicePolicyCategory,
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
  readonly childOrderHashHex?: string;
  readonly childGraphHashHex?: string;
  readonly slicePolicies?: Readonly<Record<StrategySlicePolicyCategory, StrategySlicePolicy>>;
  readonly preparedAtMs?: number;
  readonly settlementEvidence?: OrderActivationSettlementEvidence;
}

export interface OrderActivationSettlementEvidence {
  readonly childOrderHashHex: string;
  readonly packageOrderIdHex: string;
  readonly allocationHashHex: string;
  readonly receiptHashHex: string;
  readonly allocatedQuantityAtoms: bigint;
  readonly allocatedNotionalTicks: bigint;
  readonly recordedAtMs: number;
}

export interface OrderActivationView {
  readonly orderHashHex: string;
  readonly sourceOrderHashHex?: string;
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
CREATE TABLE IF NOT EXISTS order_activation_sources (
  order_hash BLOB PRIMARY KEY REFERENCES order_activations(order_hash),
  source_order_hash BLOB NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS order_activation_children (
  attempt_id TEXT PRIMARY KEY REFERENCES order_activation_attempts(attempt_id),
  child_order_hash BLOB NOT NULL UNIQUE,
  child_graph_hash BLOB NOT NULL,
  policies_json TEXT NOT NULL,
  prepared_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS order_activation_completion_evidence (
  attempt_id TEXT PRIMARY KEY REFERENCES order_activation_attempts(attempt_id),
  child_order_hash BLOB NOT NULL UNIQUE,
  package_order_id BLOB NOT NULL UNIQUE,
  allocation_hash BLOB NOT NULL UNIQUE,
  receipt_hash BLOB NOT NULL UNIQUE,
  allocated_quantity_atoms TEXT NOT NULL,
  allocated_notional_ticks TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_reserved_activation_attempt
  ON order_activation_attempts(order_hash) WHERE status = 'RESERVED';
CREATE UNIQUE INDEX IF NOT EXISTS one_activation_attempt_per_slice
  ON order_activation_attempts(order_hash, slice_index) WHERE slice_index IS NOT NULL;
CREATE INDEX IF NOT EXISTS activation_attempts_by_order
  ON order_activation_attempts(order_hash, ordinal);
CREATE TRIGGER IF NOT EXISTS reject_activation_delete BEFORE DELETE ON order_activations BEGIN SELECT RAISE(ABORT, 'order activations cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS reject_activation_attempt_delete BEFORE DELETE ON order_activation_attempts BEGIN SELECT RAISE(ABORT, 'activation attempts cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS reject_activation_source_update BEFORE UPDATE ON order_activation_sources BEGIN SELECT RAISE(ABORT, 'activation sources cannot be updated'); END;
CREATE TRIGGER IF NOT EXISTS reject_activation_source_delete BEFORE DELETE ON order_activation_sources BEGIN SELECT RAISE(ABORT, 'activation sources cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS reject_activation_child_update BEFORE UPDATE ON order_activation_children BEGIN SELECT RAISE(ABORT, 'activation children cannot be updated'); END;
CREATE TRIGGER IF NOT EXISTS reject_activation_child_delete BEFORE DELETE ON order_activation_children BEGIN SELECT RAISE(ABORT, 'activation children cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS reject_activation_completion_evidence_update BEFORE UPDATE ON order_activation_completion_evidence BEGIN SELECT RAISE(ABORT, 'activation completion evidence cannot be updated'); END;
CREATE TRIGGER IF NOT EXISTS reject_activation_completion_evidence_delete BEFORE DELETE ON order_activation_completion_evidence BEGIN SELECT RAISE(ABORT, 'activation completion evidence cannot be deleted'); END;
`;

const SLICE_POLICY_CATEGORIES = Object.freeze([
  "NETTING",
  "PRIVACY",
  "SOLVER",
  "DELIVERY",
  "RESOURCE",
  "PORTFOLIO_RISK_LIMITS",
] as const satisfies readonly StrategySlicePolicyCategory[]);

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
    readonly sourceOrderHashHex?: string;
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
    const sourceHash = input.sourceOrderHashHex === undefined ? undefined : hashBytes(input.sourceOrderHashHex);
    if (input.sourceOrderHashHex !== undefined) {
      const source = this.orders.order(input.sourceOrderHashHex);
      if (source === undefined) throw new OrderActivationStoreError("SOURCE_ORDER_NOT_FOUND", "No admitted source strategy order has this hash.");
      const sourceOrder = strategyPackageOrder(source.order);
      if (toHex(strategyPackageOrderHash(sourceOrder)) !== input.sourceOrderHashHex) {
        throw new OrderActivationStoreError("SOURCE_ORDER_MISMATCH", "The admitted source order does not match its hash.");
      }
      if (sourceOrder.packageOrderType !== "LIMIT" && sourceOrder.packageOrderType !== "MARKETABLE_LIMIT" && sourceOrder.packageOrderType !== "POST_ONLY") {
        throw new OrderActivationStoreError("SOURCE_ORDER_NOT_IMMEDIATE", "The activation source must be an immediate strategy order.");
      }
      if (source.graphHashHex !== stored.graphHashHex
        || sourceOrder.environment !== order.environment
        || sourceOrder.owner !== order.owner
        || sourceOrder.settlementAccount !== order.settlementAccount
        || sourceOrder.economicQuantity.atoms !== order.economicQuantity.atoms
        || sourceOrder.economicQuantity.asset.assetId !== order.economicQuantity.asset.assetId
        || sourceOrder.templateId !== order.templateId
        || sourceOrder.seriesId !== order.seriesId
        || sourceOrder.executionClassId !== order.executionClassId
        || sourceOrder.lifecycleAction !== order.lifecycleAction
        || sourceOrder.settlementClass !== order.settlementClass
        || sourceOrder.packageTimeInForce !== order.packageTimeInForce
        || sourceOrder.expiryUnit !== order.expiryUnit
        || sourceOrder.expiryValue !== order.expiryValue) {
        throw new OrderActivationStoreError("SOURCE_ORDER_MISMATCH", "The source and advanced orders do not describe the same strategy package.");
      }
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
      const known = this.db.prepare(`
        SELECT a.order_json, a.condition_json, a.schedule_json, s.source_order_hash
        FROM order_activations a
        LEFT JOIN order_activation_sources s ON s.order_hash = a.order_hash
        WHERE a.order_hash = ?
      `).get(orderHash) as {
        order_json: string;
        condition_json: string | null;
        schedule_json: string | null;
        source_order_hash: Uint8Array | null;
      } | undefined;
      if (known !== undefined) {
        const knownSource = known.source_order_hash === null ? undefined : toHex(known.source_order_hash);
        if (known.order_json !== orderJson || known.condition_json !== conditionJson || known.schedule_json !== scheduleJson
          || knownSource !== input.sourceOrderHashHex) {
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
      if (sourceHash !== undefined) {
        this.db.prepare(`
          INSERT INTO order_activation_sources (order_hash, source_order_hash, recorded_at_ms)
          VALUES (?, ?, ?)
        `).run(orderHash, sourceHash, now);
      }
      return true;
    });
    return { created, view: this.requireView(input.orderHashHex) };
  }

  view(orderHashHex: string): OrderActivationView | undefined {
    const row = this.db.prepare(`
      SELECT a.order_json, a.condition_json, a.schedule_json, a.status, a.registered_at_ms,
             a.updated_at_ms, s.source_order_hash
      FROM order_activations a
      LEFT JOIN order_activation_sources s ON s.order_hash = a.order_hash
      WHERE a.order_hash = ?
    `).get(hashBytes(orderHashHex)) as {
      order_json: string;
      condition_json: string | null;
      schedule_json: string | null;
      status: OrderActivationStatus;
      registered_at_ms: number;
      updated_at_ms: number;
      source_order_hash: Uint8Array | null;
    } | undefined;
    if (row === undefined) return undefined;
    const order = strategyPackageOrder(parseProtocolJson(row.order_json) as StrategyPackageOrder);
    if (toHex(strategyPackageOrderHash(order)) !== orderHashHex) throw new OrderActivationStoreError("CORRUPT_ROW", "Stored activation order does not match its hash.");
    const condition = row.condition_json === null ? undefined : activationCondition(parseProtocolJson(row.condition_json) as ActivationConditionInput);
    const schedule = row.schedule_json === null ? undefined : executionSchedule(parseProtocolJson(row.schedule_json) as ExecutionScheduleInput);
    const attempts = this.attempts(orderHashHex);
    return Object.freeze({
      orderHashHex,
      ...(row.source_order_hash === null ? {} : { sourceOrderHashHex: toHex(row.source_order_hash) }),
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

  attempt(attemptIdValue: string): OrderActivationAttempt | undefined {
    if (!/^[0-9a-f]{64}$/.test(attemptIdValue)) {
      throw new OrderActivationStoreError("INVALID_ATTEMPT_ID", "Activation attempt id must be 32 lowercase hex bytes.");
    }
    const row = this.db.prepare("SELECT order_hash FROM order_activation_attempts WHERE attempt_id = ?")
      .get(attemptIdValue) as { order_hash: Uint8Array } | undefined;
    if (row === undefined) return undefined;
    return this.attempts(toHex(row.order_hash)).find((attempt) => attempt.attemptId === attemptIdValue);
  }

  bindChild(input: Readonly<{
    attemptId: string;
    childOrderHashHex: string;
    childGraphHashHex: string;
    slicePolicies: Readonly<Record<StrategySlicePolicyCategory, StrategySlicePolicy>>;
  }>): { readonly replayed: boolean; readonly attempt: OrderActivationAttempt } {
    if (!/^[0-9a-f]{64}$/.test(input.attemptId)) {
      throw new OrderActivationStoreError("INVALID_ATTEMPT_ID", "Activation attempt id must be 32 lowercase hex bytes.");
    }
    const childOrderHash = hashBytes(input.childOrderHashHex);
    const childGraphHash = hashBytes(input.childGraphHashHex);
    const policies = Object.fromEntries(SLICE_POLICY_CATEGORIES.map((category) => [
      category,
      strategySlicePolicy(input.slicePolicies[category], `slicePolicies.${category}`),
    ])) as unknown as Readonly<Record<StrategySlicePolicyCategory, StrategySlicePolicy>>;
    const policiesJson = stringifyProtocolJson(policies);
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT a.order_hash, a.maximum_quantity_atoms, a.status, p.order_json, s.source_order_hash,
               c.child_order_hash, c.child_graph_hash, c.policies_json
        FROM order_activation_attempts a
        JOIN order_activations p ON p.order_hash = a.order_hash
        LEFT JOIN order_activation_sources s ON s.order_hash = a.order_hash
        LEFT JOIN order_activation_children c ON c.attempt_id = a.attempt_id
        WHERE a.attempt_id = ?
      `).get(input.attemptId) as {
        order_hash: Uint8Array;
        maximum_quantity_atoms: string;
        status: OrderActivationAttemptStatus;
        order_json: string;
        source_order_hash: Uint8Array | null;
        child_order_hash: Uint8Array | null;
        child_graph_hash: Uint8Array | null;
        policies_json: string | null;
      } | undefined;
      if (row === undefined) throw new OrderActivationStoreError("ATTEMPT_NOT_FOUND", "No activation attempt has this id.");
      if (row.source_order_hash === null) {
        throw new OrderActivationStoreError("SOURCE_ORDER_REQUIRED", "The activation attempt has no immutable immediate-order source.");
      }
      if (row.child_order_hash !== null) {
        const same = toHex(row.child_order_hash) === input.childOrderHashHex
          && row.child_graph_hash !== null && toHex(row.child_graph_hash) === input.childGraphHashHex
          && row.policies_json === policiesJson;
        if (!same) throw new OrderActivationStoreError("CHILD_CONFLICT", "The activation attempt already binds another executable child.");
        return { replayed: true, attempt: this.attempt(input.attemptId)! };
      }
      const parentOrderHashHex = toHex(row.order_hash);
      const parentOrder = strategyPackageOrder(parseProtocolJson(row.order_json) as StrategyPackageOrder);
      const childOrder = this.orders.order(input.childOrderHashHex);
      if (childOrder === undefined || childOrder.graphHashHex !== input.childGraphHashHex
        || toHex(strategyPackageOrderHash(childOrder.order)) !== input.childOrderHashHex
        || (childOrder.order.packageOrderType !== "LIMIT"
          && childOrder.order.packageOrderType !== "MARKETABLE_LIMIT"
          && childOrder.order.packageOrderType !== "POST_ONLY")) {
        throw new OrderActivationStoreError("CHILD_ORDER_MISMATCH", "The child must be an admitted immediate strategy order with the supplied graph.");
      }
      const maximumQuantityAtoms = storedBigint(row.maximum_quantity_atoms, "maximum_quantity_atoms");
      if (childOrder.order.economicQuantity.atoms !== maximumQuantityAtoms) {
        throw new OrderActivationStoreError("CHILD_QUANTITY_MISMATCH", "The child quantity must equal the reserved activation quantity.");
      }
      if (SLICE_POLICY_CATEGORIES.some((category) => (
        toHex(policies[category].parentOrderHash) !== parentOrderHashHex
        || toHex(policies[category].activationAttemptId) !== input.attemptId
        || toHex(policies[category].parentGraphHash) !== toHex(parentOrder.graphHash)
        || policies[category].parentEconomicQuantity !== parentOrder.economicQuantity.atoms
        || policies[category].childEconomicQuantity !== maximumQuantityAtoms
        || policies[category].graphNonce !== childOrder.graph.nonce
      ))) {
        throw new OrderActivationStoreError("CHILD_POLICY_MISMATCH", "Slice policies must bind this parent order and activation attempt.");
      }
      if (row.status !== "RESERVED") {
        throw new OrderActivationStoreError("ATTEMPT_TERMINAL", "Only a reserved activation attempt can bind an executable child.");
      }
      this.db.prepare(`
        INSERT INTO order_activation_children
          (attempt_id, child_order_hash, child_graph_hash, policies_json, prepared_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.attemptId, childOrderHash, childGraphHash, policiesJson, this.clock());
      return { replayed: false, attempt: this.attempt(input.attemptId)! };
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

  completeWithEvidence(input: {
    readonly attemptId: string;
    readonly outcome: "SUCCEEDED" | "FAILED";
    readonly childOrderHashHex: string;
    readonly packageOrderIdHex: string;
    readonly allocationHashHex: string;
    readonly receiptHashHex: string;
    readonly allocatedQuantityAtoms: bigint;
    readonly allocatedNotionalTicks: bigint;
    readonly failureReason?: string;
  }): { readonly replayed: boolean; readonly view: OrderActivationView } {
    const childOrderHash = hashBytes(input.childOrderHashHex);
    const packageOrderId = hashBytes(input.packageOrderIdHex);
    const allocationHash = hashBytes(input.allocationHashHex);
    const receiptHash = hashBytes(input.receiptHashHex);
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT a.order_hash, a.maximum_quantity_atoms, a.side, a.limit_price_ticks, a.status,
               a.executed_quantity_atoms, a.execution_price_ticks, a.failure_reason,
               c.child_order_hash, e.package_order_id, e.allocation_hash, e.receipt_hash,
               e.allocated_quantity_atoms, e.allocated_notional_ticks
        FROM order_activation_attempts a
        LEFT JOIN order_activation_children c ON c.attempt_id = a.attempt_id
        LEFT JOIN order_activation_completion_evidence e ON e.attempt_id = a.attempt_id
        WHERE a.attempt_id = ?
      `).get(input.attemptId) as {
        order_hash: Uint8Array;
        maximum_quantity_atoms: string;
        side: "BID" | "ASK";
        limit_price_ticks: string;
        status: OrderActivationAttemptStatus;
        executed_quantity_atoms: string | null;
        execution_price_ticks: string | null;
        failure_reason: string | null;
        child_order_hash: Uint8Array | null;
        package_order_id: Uint8Array | null;
        allocation_hash: Uint8Array | null;
        receipt_hash: Uint8Array | null;
        allocated_quantity_atoms: string | null;
        allocated_notional_ticks: string | null;
      } | undefined;
      if (row === undefined) throw new OrderActivationStoreError("ATTEMPT_NOT_FOUND", "No activation attempt has this id.");
      if (row.child_order_hash === null || toHex(row.child_order_hash) !== input.childOrderHashHex) {
        throw new OrderActivationStoreError("CHILD_ORDER_MISMATCH", "Settlement evidence must bind the attempt's executable child.");
      }
      const evidenceMatches = row.package_order_id !== null
        && toHex(row.package_order_id) === input.packageOrderIdHex
        && row.allocation_hash !== null && toHex(row.allocation_hash) === input.allocationHashHex
        && row.receipt_hash !== null && toHex(row.receipt_hash) === input.receiptHashHex
        && row.allocated_quantity_atoms === input.allocatedQuantityAtoms.toString()
        && row.allocated_notional_ticks === input.allocatedNotionalTicks.toString();
      const creditedQuantity = input.outcome === "SUCCEEDED" ? input.allocatedQuantityAtoms : 0n;
      if (row.status !== "RESERVED") {
        const same = row.status === input.outcome
          && row.executed_quantity_atoms === creditedQuantity.toString()
          && row.execution_price_ticks === null
          && row.failure_reason === (input.failureReason ?? null)
          && evidenceMatches;
        if (!same) throw new OrderActivationStoreError("ATTEMPT_CONFLICT", "The activation attempt already has another outcome or evidence.");
        return { replayed: true, view: this.requireView(toHex(row.order_hash)) };
      }
      if (row.package_order_id !== null) {
        throw new OrderActivationStoreError("ATTEMPT_CONFLICT", "The activation attempt already has different completion evidence.");
      }
      if (input.allocatedQuantityAtoms <= 0n) {
        throw new OrderActivationStoreError("INVALID_EVIDENCE", "Settlement evidence must contain positive allocated quantity.");
      }
      const maximum = storedBigint(row.maximum_quantity_atoms, "maximum_quantity_atoms");
      if (input.allocatedQuantityAtoms !== maximum) {
        throw new OrderActivationStoreError("INVALID_EVIDENCE", "Settlement evidence must allocate the exact reserved quantity.");
      }
      if (input.outcome === "FAILED") {
        if (typeof input.failureReason !== "string" || input.failureReason.length < 1 || input.failureReason.length > 280) {
          throw new OrderActivationStoreError("INVALID_FAILURE", "Failed settlement evidence requires a bounded reason.");
        }
      } else if (input.failureReason !== undefined) {
        throw new OrderActivationStoreError("INVALID_SUCCESS", "Successful settlement evidence cannot include a failure reason.");
      }
      const limitNotional = storedBigint(row.limit_price_ticks, "limit_price_ticks") * input.allocatedQuantityAtoms;
      if ((row.side === "BID" && input.allocatedNotionalTicks > limitNotional)
        || (row.side === "ASK" && input.allocatedNotionalTicks < limitNotional)) {
        throw new OrderActivationStoreError("PRICE_LIMIT_EXCEEDED", "Allocated fill notional violates the reserved exact limit.");
      }
      const orderHashHex = toHex(row.order_hash);
      const view = this.requireView(orderHashHex);
      if (input.outcome === "SUCCEEDED" && view.schedule?.kind === "PACKAGE_TWAP") {
        const aggregateQuantity = view.progress.executedQuantity + input.allocatedQuantityAtoms;
        const aggregateNotional = view.progress.executedNotionalTicks + input.allocatedNotionalTicks;
        const aggregateLimit = view.schedule.aggregateLimitPriceTicks! * aggregateQuantity;
        if ((row.side === "BID" && aggregateNotional > aggregateLimit)
          || (row.side === "ASK" && aggregateNotional < aggregateLimit)) {
          throw new OrderActivationStoreError("TWAP_LIMIT_EXCEEDED", "Allocated fills would violate the signed aggregate TWAP limit.");
        }
      }
      const completedAtMs = this.clock();
      this.db.prepare(`
        INSERT INTO order_activation_completion_evidence
          (attempt_id, child_order_hash, package_order_id, allocation_hash, receipt_hash,
           allocated_quantity_atoms, allocated_notional_ticks, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.attemptId,
        childOrderHash,
        packageOrderId,
        allocationHash,
        receiptHash,
        input.allocatedQuantityAtoms.toString(),
        input.allocatedNotionalTicks.toString(),
        completedAtMs,
      );
      this.db.prepare(`
        UPDATE order_activation_attempts
        SET status = ?, executed_quantity_atoms = ?, execution_price_ticks = NULL,
            failure_reason = ?, completed_at_ms = ?
        WHERE attempt_id = ? AND status = 'RESERVED'
      `).run(input.outcome, creditedQuantity.toString(), input.failureReason ?? null, completedAtMs, input.attemptId);
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
      SELECT a.attempt_id, a.ordinal, a.slice_index, a.at_value, a.maximum_quantity_atoms, a.side,
             a.limit_price_ticks, a.status, a.executed_quantity_atoms, a.execution_price_ticks,
             a.failure_reason, a.reserved_at_ms, a.completed_at_ms, c.child_order_hash,
             c.child_graph_hash, c.policies_json, c.prepared_at_ms, e.package_order_id,
             e.allocation_hash, e.receipt_hash, e.allocated_quantity_atoms,
             e.allocated_notional_ticks, e.recorded_at_ms AS evidence_recorded_at_ms
      FROM order_activation_attempts a
      LEFT JOIN order_activation_children c ON c.attempt_id = a.attempt_id
      LEFT JOIN order_activation_completion_evidence e ON e.attempt_id = a.attempt_id
      WHERE a.order_hash = ? ORDER BY a.ordinal
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
      child_order_hash: Uint8Array | null;
      child_graph_hash: Uint8Array | null;
      policies_json: string | null;
      prepared_at_ms: number | null;
      package_order_id: Uint8Array | null;
      allocation_hash: Uint8Array | null;
      receipt_hash: Uint8Array | null;
      allocated_quantity_atoms: string | null;
      allocated_notional_ticks: string | null;
      evidence_recorded_at_ms: number | null;
    }>;
    return Object.freeze(rows.map((row) => {
      const policies = row.policies_json === null ? undefined : Object.fromEntries(
        SLICE_POLICY_CATEGORIES.map((category) => [
          category,
          strategySlicePolicy(
            (parseProtocolJson(row.policies_json!) as Record<string, StrategySlicePolicy>)[category]!,
            `slicePolicies.${category}`,
          ),
        ]),
      ) as unknown as Readonly<Record<StrategySlicePolicyCategory, StrategySlicePolicy>>;
      return Object.freeze({
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
      ...(row.child_order_hash === null ? {} : { childOrderHashHex: toHex(row.child_order_hash) }),
      ...(row.child_graph_hash === null ? {} : { childGraphHashHex: toHex(row.child_graph_hash) }),
      ...(policies === undefined ? {} : { slicePolicies: Object.freeze(policies) }),
      ...(row.prepared_at_ms === null ? {} : { preparedAtMs: integer(row.prepared_at_ms, "prepared_at_ms") }),
      ...(row.package_order_id === null ? {} : { settlementEvidence: Object.freeze({
        childOrderHashHex: toHex(row.child_order_hash!),
        packageOrderIdHex: toHex(row.package_order_id),
        allocationHashHex: toHex(row.allocation_hash!),
        receiptHashHex: toHex(row.receipt_hash!),
        allocatedQuantityAtoms: storedBigint(row.allocated_quantity_atoms, "allocated_quantity_atoms"),
        allocatedNotionalTicks: storedBigint(row.allocated_notional_ticks, "allocated_notional_ticks"),
        recordedAtMs: integer(row.evidence_recorded_at_ms, "evidence_recorded_at_ms"),
      }) }),
      });
    }));
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
      executedNotionalTicks: succeeded.reduce((sum, attempt) => sum + (
        attempt.settlementEvidence?.allocatedNotionalTicks
          ?? (attempt.executedQuantityAtoms ?? 0n) * (attempt.executionPriceTicks ?? 0n)
      ), 0n),
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
