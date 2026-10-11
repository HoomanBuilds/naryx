import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import bs58 from "bs58";
import { verifyTypedData, type Hex } from "viem";
import { verifyEd25519 } from "./ed25519.js";
import { readInternalBody, sendError, sendJson } from "./internal-http.js";
import { OrderActivationStoreError, type SqliteOrderActivationStore } from "./order-activation-store.js";

export const ORDER_ACTIVATIONS_OWNER_PATH = "/internal/terminal/order-activations";
export const ORDER_ACTIVATION_CANCELLATION_PATH = "/internal/terminal/order-activations/cancellation";
export const ORDER_ACTIVATION_CANCEL_PATH = "/internal/terminal/order-activations/cancel";

const CANCELLATION_DOMAIN = "NARYX/order-activation-cancellation/v1";
const EVM_OWNER = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const EVM_SIGNATURE = /^0x[0-9a-f]{130}$/;
const HASH = /^[0-9a-f]{64}$/;
/** A signed cancellation is short-lived; its nonce is held durably either way. */
export const MAX_CANCELLATION_LIFETIME_MS = 600_000;

export type OrderActivationCancellation = Readonly<{
  orderHash: string;
  owner: string;
  nonce: string;
  expiresAtMs: number;
}>;

function solanaOwner(owner: string): Uint8Array | undefined {
  try {
    const key = bs58.decode(owner);
    return key.length === 32 && bs58.encode(key) === owner ? key : undefined;
  } catch {
    return undefined;
  }
}

/** The 32 bytes a Solana owner signs and an EVM owner's typed data commits to. */
export function orderActivationCancellationHash(input: OrderActivationCancellation): Uint8Array {
  return createHash("sha256")
    .update(JSON.stringify([CANCELLATION_DOMAIN, input.orderHash, input.owner, input.nonce, input.expiresAtMs]))
    .digest();
}

/** Chainless EIP-712 typed data: the owner's wallet may sit on any network. */
export function orderActivationCancellationTypedData(input: OrderActivationCancellation) {
  return Object.freeze({
    domain: Object.freeze({ name: "Naryx Order Activation", version: "1" }),
    types: Object.freeze({
      OrderActivationCancellation: Object.freeze([
        { name: "cancellationHash", type: "bytes32" },
        { name: "orderHash", type: "bytes32" },
        { name: "owner", type: "address" },
        { name: "nonce", type: "bytes32" },
        { name: "expiresAtMs", type: "uint256" },
      ]),
    }),
    primaryType: "OrderActivationCancellation" as const,
    message: Object.freeze({
      cancellationHash: `0x${Buffer.from(orderActivationCancellationHash(input)).toString("hex")}`,
      orderHash: `0x${input.orderHash}`,
      owner: input.owner,
      nonce: `0x${input.nonce}`,
      expiresAtMs: input.expiresAtMs.toString(),
    }),
  });
}

/** EVM owners sign the typed data; Solana owners sign the raw cancellation hash with ed25519. */
export async function verifyOrderActivationCancellation(input: OrderActivationCancellation, signature: string): Promise<boolean> {
  if (EVM_OWNER.test(input.owner)) {
    if (!EVM_SIGNATURE.test(signature)) return false;
    const typed = orderActivationCancellationTypedData(input);
    try {
      return await verifyTypedData({
        address: input.owner as Hex,
        domain: typed.domain,
        types: { OrderActivationCancellation: [...typed.types.OrderActivationCancellation] },
        primaryType: typed.primaryType,
        message: {
          ...typed.message,
          cancellationHash: typed.message.cancellationHash as Hex,
          orderHash: typed.message.orderHash as Hex,
          owner: input.owner as Hex,
          nonce: typed.message.nonce as Hex,
          expiresAtMs: BigInt(input.expiresAtMs),
        },
        signature: signature as Hex,
      });
    } catch {
      return false;
    }
  }
  const key = solanaOwner(input.owner);
  if (key === undefined) return false;
  try {
    const bytes = bs58.decode(signature);
    return bs58.encode(bytes) === signature && verifyEd25519(key, orderActivationCancellationHash(input), bytes);
  } catch {
    return false;
  }
}

function failure(response: ServerResponse, error: unknown): true {
  if (error instanceof OrderActivationStoreError) {
    const status = error.code.endsWith("NOT_FOUND") ? 404
      : error.code === "NOT_OWNER" ? 403
        : error.code === "CORRUPT_ROW" ? 500
          : error.code === "NONCE_REPLAYED" || error.code === "ATTEMPT_OUTSTANDING" || error.code === "ORDER_TERMINAL"
            || error.code === "CANCELLATION_EXPIRED" ? 409 : 400;
    return sendError(response, status, error.code, error.message);
  }
  return sendError(response, 400, "INVALID_REQUEST", error instanceof Error ? error.message : "Request was rejected.");
}

/**
 * Owner-facing advanced-order routes on the terminal origin: list an owner's conditional,
 * scheduled, and TWAP activations, and cancel one under the owner's signature over the
 * activation, a fresh nonce, and a short expiry. Listing is a read of public order data.
 */
export function createOrderActivationOwnerHandler(options: Readonly<{
  activations: Pick<SqliteOrderActivationStore, "view" | "ownerViews" | "cancelByOwner">;
  clock?: () => number;
}>): (request: IncomingMessage, response: ServerResponse) => boolean {
  const clock = options.clock ?? Date.now;
  const cancellation = (body: Record<string, unknown>, keys: string): OrderActivationCancellation => {
    if (Object.keys(body).sort().join(",") !== keys || typeof body.orderHash !== "string" || !HASH.test(body.orderHash)
      || typeof body.nonce !== "string" || !HASH.test(body.nonce)
      || typeof body.expiresAtMs !== "number" || !Number.isSafeInteger(body.expiresAtMs)) {
      throw new TypeError(`Request must contain only ${keys.split(",").join(", ")}.`);
    }
    const now = clock();
    if (body.expiresAtMs <= now || body.expiresAtMs > now + MAX_CANCELLATION_LIFETIME_MS) {
      throw new OrderActivationStoreError("INVALID_EXPIRY", "A cancellation expires within ten minutes from now.");
    }
    const view = options.activations.view(body.orderHash);
    if (view === undefined) throw new OrderActivationStoreError("ACTIVATION_NOT_FOUND", "No activation is registered for this order.");
    const owner = view.order.owner;
    if (!EVM_OWNER.test(owner) && solanaOwner(owner) === undefined) {
      throw new OrderActivationStoreError("UNSUPPORTED_OWNER", "This activation's owner has no supported signature scheme.");
    }
    return Object.freeze({ orderHash: body.orderHash, owner, nonce: body.nonce, expiresAtMs: body.expiresAtMs });
  };
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://terminal.local");
    if (url.pathname !== ORDER_ACTIVATIONS_OWNER_PATH && url.pathname !== ORDER_ACTIVATION_CANCELLATION_PATH
      && url.pathname !== ORDER_ACTIVATION_CANCEL_PATH) return false;
    if (url.pathname === ORDER_ACTIVATIONS_OWNER_PATH) {
      if (request.method !== "GET") return sendError(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
      const owner = url.searchParams.get("owner");
      if ([...url.searchParams.keys()].join(",") !== "owner" || owner === null || owner.length < 1 || owner.length > 128) {
        return sendError(response, 400, "INVALID_REQUEST", "Query must contain only owner.");
      }
      try {
        return sendJson(response, 200, { version: 1, owner, activations: options.activations.ownerViews(owner) });
      } catch (error) {
        return failure(response, error);
      }
    }
    if (request.method !== "POST") return sendError(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
    if (url.search !== "") return sendError(response, 400, "INVALID_REQUEST", "Query parameters are not accepted.");
    readInternalBody(request, response, (body) => {
      void (async () => {
        try {
          if (url.pathname === ORDER_ACTIVATION_CANCELLATION_PATH) {
            const terms = cancellation(body, "expiresAtMs,nonce,orderHash");
            const evm = EVM_OWNER.test(terms.owner);
            return sendJson(response, 200, {
              version: 1,
              status: "UNSIGNED_CANCELLATION",
              ...terms,
              scheme: evm ? "EIP712_SECP256K1" : "ED25519",
              cancellationHash: Buffer.from(orderActivationCancellationHash(terms)).toString("hex"),
              ...(evm ? { typedData: orderActivationCancellationTypedData(terms) } : {}),
            });
          }
          const terms = cancellation(body, "expiresAtMs,nonce,orderHash,signature");
          if (typeof body.signature !== "string" || !(await verifyOrderActivationCancellation(terms, body.signature))) {
            return sendError(response, 403, "INVALID_SIGNATURE", "The signature is not the activation owner's cancellation.");
          }
          const view = options.activations.cancelByOwner({ orderHashHex: terms.orderHash, owner: terms.owner, nonce: terms.nonce,
            expiresAtMs: terms.expiresAtMs, signature: body.signature });
          return sendJson(response, 200, { version: 1, ...view });
        } catch (error) {
          return failure(response, error);
        }
      })();
    });
    return true;
  };
}
