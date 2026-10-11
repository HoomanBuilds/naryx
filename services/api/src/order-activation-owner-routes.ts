import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import bs58 from "bs58";
import { verifyTypedData, type Hex } from "viem";
import { verifyEd25519 } from "./ed25519.js";
import { readInternalBody, sendError, sendJson } from "./internal-http.js";
import { OrderActivationStoreError, type OrderActivationView, type SqliteOrderActivationStore } from "./order-activation-store.js";

export const ORDER_ACTIVATIONS_OWNER_PATH = "/internal/terminal/order-activations";
export const ORDER_ACTIVATION_CANCELLATION_PATH = "/internal/terminal/order-activations/cancellation";
export const ORDER_ACTIVATION_CANCEL_PATH = "/internal/terminal/order-activations/cancel";
export const ORDER_ACTIVATION_READ_CHALLENGE_PATH = "/internal/terminal/order-activations/read-challenge";

const CANCELLATION_DOMAIN = "NARYX/order-activation-cancellation/v1";
const READ_DOMAIN = "NARYX/order-activation-read/v1";
const EVM_OWNER = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const EVM_SIGNATURE = /^0x[0-9a-f]{130}$/;
const HASH = /^[0-9a-f]{64}$/;
/** A signed cancellation is short-lived; its nonce is held durably either way. */
export const MAX_CANCELLATION_LIFETIME_MS = 600_000;
/** A signed read is single-use and expires within five minutes. */
export const MAX_READ_LIFETIME_MS = 300_000;

export type OrderActivationCancellation = Readonly<{
  orderHash: string;
  owner: string;
  nonce: string;
  expiresAtMs: number;
}>;

export type OrderActivationRead = Readonly<{
  owner: string;
  nonce: string;
  expiresAtMs: number;
}>;

type OwnerTypedData = Readonly<{
  domain: Readonly<{ name: string; version: string }>;
  types: Readonly<Record<string, readonly Readonly<{ name: string; type: string }>[]>>;
  primaryType: string;
  message: Readonly<Record<string, string>>;
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

/** The 32 bytes a Solana owner signs and an EVM owner's typed data commits to for one full read. */
export function orderActivationReadHash(input: OrderActivationRead): Uint8Array {
  return createHash("sha256").update(JSON.stringify([READ_DOMAIN, input.owner, input.nonce, input.expiresAtMs])).digest();
}

export function orderActivationReadTypedData(input: OrderActivationRead) {
  return Object.freeze({
    domain: Object.freeze({ name: "Naryx Order Activation", version: "1" }),
    types: Object.freeze({
      OrderActivationRead: Object.freeze([
        { name: "readHash", type: "bytes32" },
        { name: "owner", type: "address" },
        { name: "nonce", type: "bytes32" },
        { name: "expiresAtMs", type: "uint256" },
      ]),
    }),
    primaryType: "OrderActivationRead" as const,
    message: Object.freeze({
      readHash: `0x${Buffer.from(orderActivationReadHash(input)).toString("hex")}`,
      owner: input.owner,
      nonce: `0x${input.nonce}`,
      expiresAtMs: input.expiresAtMs.toString(),
    }),
  });
}

/** EVM owners sign the typed data; Solana owners sign the raw hash with ed25519. */
async function verifyOwnerSignature(owner: string, hash: Uint8Array, typed: OwnerTypedData, signature: string): Promise<boolean> {
  if (EVM_OWNER.test(owner)) {
    if (!EVM_SIGNATURE.test(signature)) return false;
    try {
      return await verifyTypedData({
        address: owner as Hex,
        domain: typed.domain,
        types: { [typed.primaryType]: [...typed.types[typed.primaryType]!] },
        primaryType: typed.primaryType,
        message: { ...typed.message, expiresAtMs: BigInt(typed.message.expiresAtMs!) },
        signature: signature as Hex,
      } as Parameters<typeof verifyTypedData>[0]);
    } catch {
      return false;
    }
  }
  const key = solanaOwner(owner);
  if (key === undefined) return false;
  try {
    const bytes = bs58.decode(signature);
    return bs58.encode(bytes) === signature && verifyEd25519(key, hash, bytes);
  } catch {
    return false;
  }
}

export function verifyOrderActivationCancellation(input: OrderActivationCancellation, signature: string): Promise<boolean> {
  return verifyOwnerSignature(input.owner, orderActivationCancellationHash(input), orderActivationCancellationTypedData(input), signature);
}

export function verifyOrderActivationRead(input: OrderActivationRead, signature: string): Promise<boolean> {
  return verifyOwnerSignature(input.owner, orderActivationReadHash(input), orderActivationReadTypedData(input), signature);
}

/**
 * What anyone may read about an owner's activation: its identity, type, state, quantities, times,
 * the earliest next slice window, and the id of a reserved slice so its child can be prepared
 * (attempt ids derive from the order hash and ordinal, so the id itself discloses nothing more).
 * Trigger conditions, schedule terms, the order's limits, and attempt prices are disclosed only
 * under the owner's signed read.
 */
export function orderActivationSummary(view: OrderActivationView) {
  const quantityAtoms = view.schedule?.aggregateQuantityLimit ?? view.order.economicQuantity.atoms;
  const nextSlice = view.progress.lastAttemptedSliceIndex === undefined ? 0 : view.progress.lastAttemptedSliceIndex + 1;
  const schedule = view.schedule;
  return Object.freeze({
    orderHashHex: view.orderHashHex,
    ...(view.sourceOrderHashHex === undefined ? {} : { sourceOrderHashHex: view.sourceOrderHashHex }),
    kind: view.order.packageOrderType,
    status: view.status,
    quantityAtoms,
    executedQuantityAtoms: view.progress.executedQuantity,
    remainingQuantityAtoms: view.status === "WAITING" ? quantityAtoms - view.progress.executedQuantity : 0n,
    nextActivation: view.status === "WAITING" && schedule !== undefined && nextSlice < schedule.sliceCount
      ? Object.freeze({ unit: schedule.timeUnit, value: schedule.startValue + schedule.sliceInterval * BigInt(nextSlice) })
      : null,
    reservedAttemptId: view.attempts.find((attempt) => attempt.status === "RESERVED")?.attemptId ?? null,
    registeredAtMs: view.registeredAtMs,
    updatedAtMs: view.updatedAtMs,
  });
}

function failure(response: ServerResponse, error: unknown): true {
  if (error instanceof OrderActivationStoreError) {
    const status = error.code.endsWith("NOT_FOUND") ? 404
      : error.code === "NOT_OWNER" ? 403
        : error.code === "CORRUPT_ROW" ? 500
          : error.code === "NONCE_REPLAYED" || error.code === "ATTEMPT_OUTSTANDING" || error.code === "ORDER_TERMINAL"
            || error.code === "CANCELLATION_EXPIRED" || error.code === "READ_EXPIRED" ? 409 : 400;
    return sendError(response, status, error.code, error.message);
  }
  return sendError(response, 400, "INVALID_REQUEST", error instanceof Error ? error.message : "Request was rejected.");
}

/**
 * Owner-facing advanced-order routes on the terminal origin: list an owner's conditional,
 * scheduled, and TWAP activations, and cancel one under the owner's signature over the
 * activation, a fresh nonce, and a short expiry. Anyone may list an owner's summaries; full
 * activation documents need the owner's single-use signed read over a fresh nonce.
 */
export function createOrderActivationOwnerHandler(options: Readonly<{
  activations: Pick<SqliteOrderActivationStore, "view" | "ownerViews" | "cancelByOwner" | "spendOwnerRead">;
  clock?: () => number;
}>): (request: IncomingMessage, response: ServerResponse) => boolean {
  const clock = options.clock ?? Date.now;
  const read = (owner: unknown, nonce: unknown, expiresAtMs: unknown): OrderActivationRead => {
    if (typeof nonce !== "string" || !HASH.test(nonce) || typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs)) {
      throw new TypeError("A signed read needs owner, a 32-byte hex nonce, and an integer expiresAtMs.");
    }
    if (typeof owner !== "string" || (!EVM_OWNER.test(owner) && solanaOwner(owner) === undefined)) {
      throw new OrderActivationStoreError("UNSUPPORTED_OWNER", "This owner has no supported signature scheme.");
    }
    const now = clock();
    if (expiresAtMs <= now || expiresAtMs > now + MAX_READ_LIFETIME_MS) {
      throw new OrderActivationStoreError("INVALID_EXPIRY", "A signed read expires within five minutes from now.");
    }
    return Object.freeze({ owner, nonce, expiresAtMs });
  };
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
      && url.pathname !== ORDER_ACTIVATION_CANCEL_PATH && url.pathname !== ORDER_ACTIVATION_READ_CHALLENGE_PATH) return false;
    if (url.pathname === ORDER_ACTIVATIONS_OWNER_PATH) {
      if (request.method !== "GET") return sendError(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
      const owner = url.searchParams.get("owner");
      const keys = [...url.searchParams.keys()].sort().join(",");
      if ((keys !== "owner" && keys !== "expiresAtMs,nonce,owner,signature") || owner === null || owner.length < 1 || owner.length > 128) {
        return sendError(response, 400, "INVALID_REQUEST", "Query must contain only owner, or owner with nonce, expiresAtMs, and signature.");
      }
      if (keys === "owner") {
        try {
          return sendJson(response, 200, {
            version: 1,
            owner,
            disclosure: "SUMMARY",
            activations: options.activations.ownerViews(owner).map(orderActivationSummary),
          });
        } catch (error) {
          return failure(response, error);
        }
      }
      void (async () => {
        try {
          const expiresAtText = url.searchParams.get("expiresAtMs")!;
          const terms = read(owner, url.searchParams.get("nonce"), /^[1-9][0-9]{0,15}$/.test(expiresAtText) ? Number(expiresAtText) : undefined);
          if (!(await verifyOrderActivationRead(terms, url.searchParams.get("signature")!))) {
            return sendError(response, 403, "INVALID_SIGNATURE", "The signature is not the owner's read.");
          }
          options.activations.spendOwnerRead(terms);
          return sendJson(response, 200, { version: 1, owner, disclosure: "FULL", activations: options.activations.ownerViews(owner) });
        } catch (error) {
          return failure(response, error);
        }
      })();
      return true;
    }
    if (request.method !== "POST") return sendError(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
    if (url.search !== "") return sendError(response, 400, "INVALID_REQUEST", "Query parameters are not accepted.");
    readInternalBody(request, response, (body) => {
      void (async () => {
        try {
          if (url.pathname === ORDER_ACTIVATION_READ_CHALLENGE_PATH) {
            if (Object.keys(body).sort().join(",") !== "expiresAtMs,nonce,owner") {
              throw new TypeError("Request must contain only owner, nonce, expiresAtMs.");
            }
            const terms = read(body.owner, body.nonce, body.expiresAtMs);
            const evm = EVM_OWNER.test(terms.owner);
            return sendJson(response, 200, {
              version: 1,
              status: "UNSIGNED_READ",
              ...terms,
              scheme: evm ? "EIP712_SECP256K1" : "ED25519",
              readHash: Buffer.from(orderActivationReadHash(terms)).toString("hex"),
              ...(evm ? { typedData: orderActivationReadTypedData(terms) } : {}),
            });
          }
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
