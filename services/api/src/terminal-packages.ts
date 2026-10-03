import type { ExecutionIntentStore } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import type { PackageLifecycleStore } from "./package-lifecycle-store.js";

/**
 * GET /internal/terminal/packages?owner=<wallet>: the packages a wallet created, newest first, from
 * the API's own durable records, so a user sees them on any device. Only public order facts are
 * returned (an order's domain, action, size, and state); on-chain open positions are read by each
 * lane's account route. State is the lifecycle head where a lane records one, otherwise the outcome
 * the API last observed on chain for an EVM attempt, with its transaction and receipt reference.
 */
export type OwnerPackage = Readonly<{
  orderHash: string;
  domainId: string;
  contextId: string;
  action: string;
  quantityAtoms: string;
  quantityDecimals: number;
  createdAtMs: number;
  attemptId: string | null;
  state: string | null;
  transactionHash: string | null;
  blockNumber: string | null;
  receiptHash: string | null;
}>;

/** What the chain proved about an attempt, as the API last observed it. */
export type OwnerPackageOutcome = Readonly<{
  state: string;
  transactionHash: string | null;
  blockNumber: string | null;
  receiptHash: string | null;
}>;

/** Undefined for an attempt the API never observed on chain; no state is guessed for it. */
export type OwnerPackageOutcomeReader = (attemptId: string) => OwnerPackageOutcome | undefined;

const OWNER = /^(?:0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const LIMIT = 50;

export class OwnerPackageQueryError extends Error {
  readonly code = "INVALID_OWNER";
}

export function parseOwnerPackageQuery(params: URLSearchParams): string {
  const keys = [...params.keys()];
  const owner = params.get("owner");
  if (keys.length !== 1 || owner === null || !OWNER.test(owner)) {
    throw new OwnerPackageQueryError("owner must be one EVM address or Solana public key.");
  }
  return owner;
}

export function listOwnerPackages(
  owner: string,
  stores: Readonly<{
    orders: Pick<InternalOrderStore, "listByOwner" | "getCanonicalOrderByHash">;
    intents?: Pick<ExecutionIntentStore, "getAttemptForOrder">;
    lifecycle?: Pick<PackageLifecycleStore, "getAttempt">;
    outcomes?: OwnerPackageOutcomeReader;
  }>,
): readonly OwnerPackage[] {
  const records = stores.orders.listByOwner?.(owner, LIMIT) ?? [];
  return Object.freeze(records.flatMap((record): OwnerPackage[] => {
    const order = stores.orders.getCanonicalOrderByHash(record.orderHashHex);
    if (order === undefined) return [];
    const attempt = stores.intents?.getAttemptForOrder(record.orderHashHex);
    const lifecycle = attempt === undefined ? undefined : stores.lifecycle?.getAttempt(attempt.attemptId);
    const outcome = attempt === undefined || lifecycle !== undefined ? undefined : stores.outcomes?.(attempt.attemptId);
    return [Object.freeze({
      orderHash: record.orderHashHex,
      domainId: record.domainId,
      contextId: record.contextId,
      action: String(order.action),
      quantityAtoms: order.quantity.atoms.toString(),
      quantityDecimals: order.quantity.asset.decimals,
      createdAtMs: record.createdAtMs,
      attemptId: attempt?.attemptId ?? null,
      state: lifecycle !== undefined ? String(lifecycle.state) : outcome?.state ?? null,
      transactionHash: outcome?.transactionHash ?? null,
      blockNumber: outcome?.blockNumber ?? null,
      receiptHash: outcome?.receiptHash ?? null,
    })];
  }));
}
