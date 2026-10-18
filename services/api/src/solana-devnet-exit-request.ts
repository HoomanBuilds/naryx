import { createHash } from "node:crypto";
import { canonicalBytes, hash32, toHex, type DomainRef } from "@naryx/protocol-types";
import { InternalOrderConflictError, type InternalOrderInput, type InternalOrderStore } from "./internal-order-store.js";

export async function persistSolanaDevnetExitRequest(input: {
  readonly orders: InternalOrderStore;
  readonly contextId: string;
  readonly domain: DomainRef;
  readonly owner: string;
  readonly slippageBps: number;
  readonly idempotencyKey: string;
  readonly create: () => Promise<InternalOrderInput>;
}) {
  const bytes = canonicalBytes((writer) => {
    writer.writeString(input.contextId, "contextId");
    writer.writeString(input.domain.domainId, "domainId");
    writer.writeU32(input.domain.domainManifestVersion, "domainManifestVersion");
    writer.writeFixedBytes(input.domain.domainManifestHash, 32, "domainManifestHash");
    writer.writeString(input.owner, "owner");
    writer.writeU32(input.slippageBps, "slippageBps");
    writer.writeString(input.idempotencyKey, "idempotencyKey");
  });
  // Retry identity binds the user request, not the moving oracle used to price its first order.
  const requestCommitment = hash32(createHash("sha256").update("NARYX/solana-exit-request/v2").update(bytes).digest());
  const replay = () => {
    const record = input.orders.getByIdempotencyKey(input.idempotencyKey);
    if (record !== undefined && record.requestCommitmentHex !== toHex(requestCommitment)) {
      throw new InternalOrderConflictError(input.idempotencyKey);
    }
    return record === undefined ? undefined : { record, created: false };
  };
  let result = replay();
  if (result === undefined) {
    let generated: InternalOrderInput | undefined;
    try {
      generated = await input.create();
    } catch (error) {
      result = replay();
      if (result === undefined) throw error;
    }
    if (generated !== undefined) {
      if (generated.order.order.action !== "EXIT" || generated.request.owner !== input.owner
        || generated.request.slippageBps !== input.slippageBps || generated.request.contextId !== input.contextId
        || generated.request.idempotencyKey !== input.idempotencyKey) {
        throw new Error("Exit request does not match its generated order.");
      }
      result = input.orders.createOrGet({ ...generated, order: { ...generated.order, requestCommitment } });
    }
  }
  if (result === undefined) throw new Error("Exit request has no persisted result.");
  const canonical = input.orders.getCanonicalOrderByHash(result.record.orderHashHex);
  if (canonical?.action !== "EXIT" || canonical.owner !== input.owner) {
    throw new Error("Stored exit order is unavailable or mismatched.");
  }
  return Object.freeze({ ...result, quantityAtoms: canonical.quantity.atoms });
}
