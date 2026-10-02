import type { ExecutionIntentStore } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import type { PackageLifecycleStore } from "./package-lifecycle-store.js";

/**
 * GET /internal/terminal/packages?owner=<wallet>: the packages a wallet created, newest first, from
 * the API's own durable records, so a user sees them on any device. Only public order facts are
 * returned (an order's domain, action, size, and lifecycle state); on-chain open positions are read
 * by each lane's account route.
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
}>;

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
  }>,
): readonly OwnerPackage[] {
  const records = stores.orders.listByOwner?.(owner, LIMIT) ?? [];
  return Object.freeze(records.flatMap((record): OwnerPackage[] => {
    const order = stores.orders.getCanonicalOrderByHash(record.orderHashHex);
    if (order === undefined) return [];
    const attempt = stores.intents?.getAttemptForOrder(record.orderHashHex);
    const lifecycle = attempt === undefined ? undefined : stores.lifecycle?.getAttempt(attempt.attemptId);
    return [Object.freeze({
      orderHash: record.orderHashHex,
      domainId: record.domainId,
      contextId: record.contextId,
      action: String(order.action),
      quantityAtoms: order.quantity.atoms.toString(),
      quantityDecimals: order.quantity.asset.decimals,
      createdAtMs: record.createdAtMs,
      attemptId: attempt?.attemptId ?? null,
      state: lifecycle === undefined ? null : String(lifecycle.state),
    })];
  }));
}
