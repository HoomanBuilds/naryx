import {
  activationCondition,
  activationConditionHash,
  executionSchedule,
  executionScheduleHash,
  strategyPackageOrder,
  type ActivationConditionInput,
  type ExecutionScheduleInput,
  type StrategyPackageOrder,
  type StrategyPackageOrderInput,
} from "@naryx/protocol-types";
import type { SqliteOrderActivationStore, OrderActivationView } from "./order-activation-store.js";
import type { StoredStrategyPackageOrder } from "./strategy-package-store.js";
import type { StrategyOrderIntakePort, StrategyOrderIntakeResult } from "./strategy-order-intake.js";

export class AdvancedOrderFactoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AdvancedOrderFactoryError";
    this.code = code;
  }
}

export interface DerivedAdvancedOrder {
  readonly sourceOrderHashHex: string;
  readonly order: StrategyPackageOrder;
  readonly intake: StrategyOrderIntakeResult;
  readonly activation: OrderActivationView;
}

type OrderSource = Pick<{ order(orderHashHex: string): StoredStrategyPackageOrder | undefined }, "order">;

function supportedEnvironment(environment: string): boolean {
  return environment === "local" || environment === "testnet" || environment === "devnet";
}

export class AdvancedOrderFactory {
  private readonly dependencies: Readonly<{
    orders: OrderSource;
    intake: StrategyOrderIntakePort;
    activations: Pick<SqliteOrderActivationStore, "register">;
  }>;

  constructor(dependencies: Readonly<{
    orders: OrderSource;
    intake: StrategyOrderIntakePort;
    activations: Pick<SqliteOrderActivationStore, "register">;
  }>) {
    this.dependencies = dependencies;
  }

  derive(input: Readonly<{
    sourceOrderHashHex: string;
    condition?: ActivationConditionInput;
    schedule?: ExecutionScheduleInput;
    atSlot?: bigint;
  }>): DerivedAdvancedOrder {
    const source = this.dependencies.orders.order(input.sourceOrderHashHex);
    if (source === undefined) throw new AdvancedOrderFactoryError("ORDER_NOT_FOUND", "No admitted source strategy order has this hash.");
    const sourceOrder = strategyPackageOrder(source.order);
    if (!supportedEnvironment(sourceOrder.environment)) {
      throw new AdvancedOrderFactoryError("UNSUPPORTED_ENVIRONMENT", "Advanced orders are limited to local, devnet, and testnet environments.");
    }
    if (sourceOrder.packageOrderType !== "LIMIT" && sourceOrder.packageOrderType !== "MARKETABLE_LIMIT" && sourceOrder.packageOrderType !== "POST_ONLY") {
      throw new AdvancedOrderFactoryError("SOURCE_ORDER_NOT_IMMEDIATE", "The source must be an immediate strategy order.");
    }
    if (sourceOrder.activationConditionHash !== undefined || sourceOrder.executionScheduleHash !== undefined) {
      throw new AdvancedOrderFactoryError("SOURCE_ORDER_ALREADY_BOUND", "The source order already binds activation documents.");
    }
    const condition = input.condition === undefined ? undefined : activationCondition(input.condition);
    const schedule = input.schedule === undefined ? undefined : executionSchedule(input.schedule);
    if (schedule === undefined && condition === undefined) {
      throw new AdvancedOrderFactoryError("ACTIVATION_REQUIRED", "A condition or execution schedule is required.");
    }
    if (condition !== undefined && condition.observationUnit !== sourceOrder.expiryUnit) {
      throw new AdvancedOrderFactoryError("TIME_UNIT_MISMATCH", "The condition clock must match the order expiry clock.");
    }
    if (schedule !== undefined) {
      if (schedule.timeUnit !== sourceOrder.expiryUnit) {
        throw new AdvancedOrderFactoryError("TIME_UNIT_MISMATCH", "The schedule clock must match the order expiry clock.");
      }
      if (schedule.aggregateQuantityLimit > sourceOrder.economicQuantity.atoms) {
        throw new AdvancedOrderFactoryError("SCHEDULE_ABOVE_ORDER", "The schedule quantity exceeds the source order quantity.");
      }
      const lastSlice = schedule.startValue + schedule.sliceInterval * BigInt(schedule.sliceCount - 1);
      if (lastSlice >= sourceOrder.expiryValue) {
        throw new AdvancedOrderFactoryError("SCHEDULE_OUTLIVES_ORDER", "Every schedule slice must occur before order expiry.");
      }
    }
    if (condition?.metric === "TIME" && condition.threshold >= sourceOrder.expiryValue) {
      throw new AdvancedOrderFactoryError("CONDITION_OUTLIVES_ORDER", "The activation time must occur before order expiry.");
    }
    const packageOrderType = schedule?.kind ?? "CONDITIONAL";
    const orderInput: StrategyPackageOrderInput = {
      ...sourceOrder,
      packageOrderType,
      ...(condition === undefined ? {} : { activationConditionHash: activationConditionHash(condition) }),
      ...(schedule === undefined ? {} : { executionScheduleHash: executionScheduleHash(schedule) }),
    };
    const order = strategyPackageOrder(orderInput);
    const intake = this.dependencies.intake.store(order, source.graph, input.atSlot);
    const activation = this.dependencies.activations.register({
      orderHashHex: intake.orderHashHex,
      ...(condition === undefined ? {} : { condition }),
      ...(schedule === undefined ? {} : { schedule }),
    }).view;
    return Object.freeze({ sourceOrderHashHex: input.sourceOrderHashHex, order, intake, activation });
  }
}
