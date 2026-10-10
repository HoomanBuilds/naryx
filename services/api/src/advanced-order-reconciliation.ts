import {
  packageAllocationHash,
  requiresSuccessfulReceipt,
  strategyPackageOrderHash,
  toHex,
  type PackageAllocation,
  type PackageSettlementCommitment,
} from "@naryx/protocol-types";
import type {
  OrderActivationAttempt,
  OrderActivationView,
  SqliteOrderActivationStore,
} from "./order-activation-store.js";
import type {
  SqliteStrategyPackageStore,
  StoredStrategyPackageOrder,
  StoredStrategyPackageReceipt,
} from "./strategy-package-store.js";

export class AdvancedOrderReconciliationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AdvancedOrderReconciliationError";
    this.code = code;
  }
}

export type AdvancedOrderReconciliationResult =
  | Readonly<{
    status: "PENDING";
    stage: "CHILD_NOT_PREPARED" | "PACKAGE_ORDER_NOT_SUBMITTED" | "ALLOCATION_NOT_AVAILABLE" | "RECEIPT_NOT_AVAILABLE" | "RECEIPT_NOT_FINAL";
    attempt: OrderActivationAttempt;
  }>
  | Readonly<{
    status: "COMPLETED";
    replayed: boolean;
    outcome: "SUCCEEDED" | "FAILED";
    attempt: OrderActivationAttempt;
    activation: OrderActivationView;
  }>;

type ActivationPort = Pick<SqliteOrderActivationStore, "attempt" | "completeWithEvidence">;
type StrategyPort = Pick<SqliteStrategyPackageStore, "order" | "packageExecutionLock" | "receiptByOrder">;
type ExchangePort = Readonly<{
  getAllocation(packageOrderId: string): PackageAllocation | undefined;
  settlementCommitment(packageOrderId: string): PackageSettlementCommitment | undefined;
}>;

function pending(
  stage: Extract<AdvancedOrderReconciliationResult, { status: "PENDING" }>["stage"],
  attempt: OrderActivationAttempt,
): AdvancedOrderReconciliationResult {
  return Object.freeze({ status: "PENDING", stage, attempt });
}

function requireAttempt(attempt: OrderActivationAttempt | undefined): OrderActivationAttempt {
  if (attempt === undefined) {
    throw new AdvancedOrderReconciliationError("ATTEMPT_NOT_FOUND", "No activation attempt has this id.");
  }
  return attempt;
}

function requireChildOrder(stored: StoredStrategyPackageOrder | undefined, attempt: OrderActivationAttempt): StoredStrategyPackageOrder {
  if (stored === undefined || attempt.childOrderHashHex === undefined || attempt.childGraphHashHex === undefined
    || stored.orderHashHex !== attempt.childOrderHashHex || stored.graphHashHex !== attempt.childGraphHashHex
    || toHex(strategyPackageOrderHash(stored.order)) !== attempt.childOrderHashHex) {
    throw new AdvancedOrderReconciliationError("CHILD_ORDER_MISMATCH", "The prepared child order is unavailable or does not match the activation attempt.");
  }
  if (stored.order.packageTimeInForce !== "FOK" || stored.order.economicQuantity.atoms !== attempt.maximumQuantityAtoms) {
    throw new AdvancedOrderReconciliationError("CHILD_ORDER_MISMATCH", "The executable child must be FOK for the exact reserved quantity.");
  }
  return stored;
}

function requireAllocation(
  allocation: PackageAllocation,
  commitment: PackageSettlementCommitment,
  child: StoredStrategyPackageOrder,
  attempt: OrderActivationAttempt,
): { readonly quantity: bigint; readonly notional: bigint } {
  if (toHex(allocation.takerOrderId) !== toHex(commitment.packageOrderId)
    || allocation.takerSide !== attempt.side
    || allocation.takerLimitPriceTicks !== attempt.limitPriceTicks
    || allocation.requestedQuantity !== attempt.maximumQuantityAtoms
    || allocation.restedQuantity !== 0n
    || allocation.cancelledQuantity !== 0n) {
    throw new AdvancedOrderReconciliationError("ALLOCATION_MISMATCH", "The package allocation does not exactly fill the reserved child order.");
  }
  const quantity = allocation.fills.reduce((sum, fill) => sum + fill.quantity, 0n);
  if (quantity !== attempt.maximumQuantityAtoms) {
    throw new AdvancedOrderReconciliationError("ALLOCATION_MISMATCH", "The package allocation fill quantity differs from the reserved child quantity.");
  }
  if (toHex(commitment.strategyOrderHash) !== child.orderHashHex
    || toHex(commitment.graphHash) !== child.graphHashHex
    || commitment.quantity !== attempt.maximumQuantityAtoms) {
    throw new AdvancedOrderReconciliationError("SETTLEMENT_COMMITMENT_MISMATCH", "The package settlement commitment does not bind the reserved child order.");
  }
  return Object.freeze({
    quantity,
    notional: allocation.fills.reduce((sum, fill) => sum + fill.quantity * fill.priceTicks, 0n),
  });
}

function requireReceipt(receipt: StoredStrategyPackageReceipt, childOrderHashHex: string): void {
  if (toHex(receipt.receipt.orderHash) !== childOrderHashHex) {
    throw new AdvancedOrderReconciliationError("RECEIPT_MISMATCH", "The terminal receipt does not bind the reserved child order.");
  }
}

export class AdvancedOrderReconciliation {
  private readonly dependencies: Readonly<{
    activations: ActivationPort;
    strategies: StrategyPort;
    exchange: ExchangePort;
  }>;

  constructor(dependencies: Readonly<{
    activations: ActivationPort;
    strategies: StrategyPort;
    exchange: ExchangePort;
  }>) {
    this.dependencies = dependencies;
  }

  reconcile(attemptId: string): AdvancedOrderReconciliationResult {
    const attempt = requireAttempt(this.dependencies.activations.attempt(attemptId));
    if (attempt.status !== "RESERVED") {
      if (attempt.settlementEvidence === undefined) {
        throw new AdvancedOrderReconciliationError("ATTEMPT_TERMINAL", "The activation attempt is terminal without settlement evidence.");
      }
      const activation = this.dependencies.activations.completeWithEvidence({
        attemptId,
        outcome: attempt.status,
        childOrderHashHex: attempt.settlementEvidence.childOrderHashHex,
        packageOrderIdHex: attempt.settlementEvidence.packageOrderIdHex,
        allocationHashHex: attempt.settlementEvidence.allocationHashHex,
        receiptHashHex: attempt.settlementEvidence.receiptHashHex,
        allocatedQuantityAtoms: attempt.settlementEvidence.allocatedQuantityAtoms,
        allocatedNotionalTicks: attempt.settlementEvidence.allocatedNotionalTicks,
        ...(attempt.failureReason === undefined ? {} : { failureReason: attempt.failureReason }),
      });
      return Object.freeze({
        status: "COMPLETED",
        replayed: true,
        outcome: attempt.status,
        attempt,
        activation: activation.view,
      });
    }
    if (attempt.childOrderHashHex === undefined) return pending("CHILD_NOT_PREPARED", attempt);
    const child = requireChildOrder(this.dependencies.strategies.order(attempt.childOrderHashHex), attempt);
    const lock = this.dependencies.strategies.packageExecutionLock(attempt.childOrderHashHex);
    if (lock === undefined) return pending("PACKAGE_ORDER_NOT_SUBMITTED", attempt);
    const commitment = this.dependencies.exchange.settlementCommitment(lock.packageOrderIdHex);
    if (commitment === undefined) return pending("PACKAGE_ORDER_NOT_SUBMITTED", attempt);
    const allocation = this.dependencies.exchange.getAllocation(lock.packageOrderIdHex);
    if (allocation === undefined) return pending("ALLOCATION_NOT_AVAILABLE", attempt);
    const totals = requireAllocation(allocation, commitment, child, attempt);
    const receipt = this.dependencies.strategies.receiptByOrder(attempt.childOrderHashHex);
    if (receipt === undefined) return pending("RECEIPT_NOT_AVAILABLE", attempt);
    requireReceipt(receipt, attempt.childOrderHashHex);
    if (receipt.receipt.finalityStatus !== "FINALIZED") return pending("RECEIPT_NOT_FINAL", attempt);
    const outcome = requiresSuccessfulReceipt(receipt.receipt.terminalState) ? "SUCCEEDED" : "FAILED";
    const completed = this.dependencies.activations.completeWithEvidence({
      attemptId,
      outcome,
      childOrderHashHex: attempt.childOrderHashHex,
      packageOrderIdHex: lock.packageOrderIdHex,
      allocationHashHex: toHex(packageAllocationHash(allocation)),
      receiptHashHex: receipt.receiptHashHex,
      allocatedQuantityAtoms: totals.quantity,
      allocatedNotionalTicks: totals.notional,
      ...(outcome === "FAILED" ? { failureReason: `TERMINAL_STATE:${receipt.receipt.terminalState}` } : {}),
    });
    const updated = completed.view.attempts.find((candidate) => candidate.attemptId === attemptId)!;
    return Object.freeze({
      status: "COMPLETED",
      replayed: completed.replayed,
      outcome,
      attempt: updated,
      activation: completed.view,
    });
  }
}
