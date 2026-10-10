import {
  packageGraphHash,
  sliceStrategyPackageGraph,
  strategyPackageOrder,
  strategyPackageOrderHash,
  toHex,
  type FeeCap,
  type StrategyPackageOrder,
  type StrategySlicePolicy,
  type StrategySlicePolicyCategory,
} from "@naryx/protocol-types";
import type { OrderActivationAttempt, OrderActivationView, SqliteOrderActivationStore } from "./order-activation-store.js";
import type { StoredStrategyPackageOrder } from "./strategy-package-store.js";
import type { StrategyOrderIntakePort, StrategyOrderIntakeResult } from "./strategy-order-intake.js";

export class AdvancedOrderExecutionFactoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AdvancedOrderExecutionFactoryError";
    this.code = code;
  }
}

export interface PreparedAdvancedOrderAttempt {
  readonly attemptId: string;
  readonly parentOrderHashHex: string;
  readonly sourceOrderHashHex: string;
  readonly order: StrategyPackageOrder;
  readonly graph: StoredStrategyPackageOrder["graph"];
  readonly intake: StrategyOrderIntakeResult;
  readonly slicePolicies: Readonly<Record<StrategySlicePolicyCategory, StrategySlicePolicy>>;
  readonly packageBookRequest: Readonly<{
    strategyOrderHash: string;
    side: "BID" | "ASK";
    limitPriceTicks: bigint;
  }>;
  readonly replayed: boolean;
}

type OrderSource = Pick<{ order(orderHashHex: string): StoredStrategyPackageOrder | undefined }, "order">;
type ActivationSource = Pick<SqliteOrderActivationStore, "attempt" | "view" | "bindChild">;

function scale(value: bigint, child: bigint, parent: bigint): bigint {
  return (value * child) / parent;
}

function scaleFeeCaps(values: readonly FeeCap[], child: bigint, parent: bigint): readonly FeeCap[] {
  return Object.freeze(values.map((value) => Object.freeze({
    asset: value.asset,
    maxAtoms: scale(value.maxAtoms, child, parent),
  })));
}

function nonzeroNonce(hex: string, digits: number): bigint {
  const value = BigInt(`0x${hex.slice(0, digits)}`);
  return value === 0n ? 1n : value;
}

function requireReserved(attempt: OrderActivationAttempt | undefined): OrderActivationAttempt {
  if (attempt === undefined) {
    throw new AdvancedOrderExecutionFactoryError("ATTEMPT_NOT_FOUND", "No activation attempt has this id.");
  }
  if (attempt.status !== "RESERVED") {
    throw new AdvancedOrderExecutionFactoryError("ATTEMPT_TERMINAL", "Only a reserved activation attempt can prepare an executable child.");
  }
  return attempt;
}

function requireSource(view: OrderActivationView | undefined): string {
  if (view === undefined) {
    throw new AdvancedOrderExecutionFactoryError("ACTIVATION_NOT_FOUND", "No activation is registered for this attempt.");
  }
  if (view.sourceOrderHashHex === undefined) {
    throw new AdvancedOrderExecutionFactoryError("SOURCE_ORDER_REQUIRED", "The activation has no immutable immediate-order source.");
  }
  return view.sourceOrderHashHex;
}

export class AdvancedOrderExecutionFactory {
  private readonly dependencies: Readonly<{
    orders: OrderSource;
    intake: StrategyOrderIntakePort;
    activations: ActivationSource;
  }>;

  constructor(dependencies: Readonly<{
    orders: OrderSource;
    intake: StrategyOrderIntakePort;
    activations: ActivationSource;
  }>) {
    this.dependencies = dependencies;
  }

  prepare(input: Readonly<{ attemptId: string; atSlot?: bigint }>): PreparedAdvancedOrderAttempt {
    if (!/^[0-9a-f]{64}$/.test(input.attemptId)) {
      throw new AdvancedOrderExecutionFactoryError("INVALID_ATTEMPT_ID", "Activation attempt id must be 32 lowercase hex bytes.");
    }
    const attempt = requireReserved(this.dependencies.activations.attempt(input.attemptId));
    const activation = this.dependencies.activations.view(attempt.orderHashHex);
    const sourceOrderHashHex = requireSource(activation);
    const stored = this.dependencies.orders.order(sourceOrderHashHex);
    if (stored === undefined) {
      throw new AdvancedOrderExecutionFactoryError("SOURCE_ORDER_NOT_FOUND", "The activation source order is unavailable.");
    }
    const source = strategyPackageOrder(stored.order);
    if (source.packageOrderType !== "LIMIT" && source.packageOrderType !== "MARKETABLE_LIMIT" && source.packageOrderType !== "POST_ONLY") {
      throw new AdvancedOrderExecutionFactoryError("SOURCE_ORDER_NOT_IMMEDIATE", "The activation source is not an immediate strategy order.");
    }
    if (activation === undefined || toHex(strategyPackageOrderHash(activation.order)) !== attempt.orderHashHex
      || source.economicQuantity.atoms !== activation.order.economicQuantity.atoms
      || stored.graphHashHex !== toHex(activation.order.graphHash)) {
      throw new AdvancedOrderExecutionFactoryError("SOURCE_ORDER_MISMATCH", "The activation source no longer matches its advanced parent.");
    }
    const parentQuantity = source.economicQuantity.atoms;
    const childQuantity = attempt.maximumQuantityAtoms;
    const sliced = sliceStrategyPackageGraph({
      parentGraph: stored.graph,
      parentOrderHash: attempt.orderHashHex,
      activationAttemptId: attempt.attemptId,
      parentEconomicQuantity: parentQuantity,
      childEconomicQuantity: childQuantity,
      graphNonce: nonzeroNonce(attempt.attemptId, 16),
    });
    const childGraphHash = packageGraphHash(sliced.graph);
    const order = strategyPackageOrder({
      ...source,
      graphHash: childGraphHash,
      economicQuantity: { asset: source.economicQuantity.asset, atoms: childQuantity },
      maximumServiceFeesByAsset: scaleFeeCaps(source.maximumServiceFeesByAsset, childQuantity, parentQuantity),
      maximumVenueFeesByAsset: scaleFeeCaps(source.maximumVenueFeesByAsset, childQuantity, parentQuantity),
      maximumNetworkFeesByAsset: scaleFeeCaps(source.maximumNetworkFeesByAsset, childQuantity, parentQuantity),
      maximumRecoveryCostByAsset: scaleFeeCaps(source.maximumRecoveryCostByAsset, childQuantity, parentQuantity),
      maximumMarginIncrease: {
        asset: source.maximumMarginIncrease.asset,
        atoms: scale(source.maximumMarginIncrease.atoms, childQuantity, parentQuantity),
      },
      maximumResidualValue: {
        asset: source.maximumResidualValue.asset,
        atoms: scale(source.maximumResidualValue.atoms, childQuantity, parentQuantity),
      },
      nonce: nonzeroNonce(attempt.attemptId, 64),
    });
    const intake = this.dependencies.intake.store(order, sliced.graph, input.atSlot);
    if (intake.orderHashHex !== toHex(strategyPackageOrderHash(order))
      || intake.graphHashHex !== toHex(childGraphHash)) {
      throw new AdvancedOrderExecutionFactoryError("INTAKE_MISMATCH", "Executable child intake changed its canonical identity.");
    }
    const binding = this.dependencies.activations.bindChild({
      attemptId: attempt.attemptId,
      childOrderHashHex: intake.orderHashHex,
      childGraphHashHex: intake.graphHashHex,
      slicePolicies: sliced.policies,
    });
    return Object.freeze({
      attemptId: attempt.attemptId,
      parentOrderHashHex: attempt.orderHashHex,
      sourceOrderHashHex,
      order,
      graph: sliced.graph,
      intake,
      slicePolicies: sliced.policies,
      packageBookRequest: Object.freeze({
        strategyOrderHash: intake.orderHashHex,
        side: attempt.side,
        limitPriceTicks: attempt.limitPriceTicks,
      }),
      replayed: binding.replayed,
    });
  }
}
