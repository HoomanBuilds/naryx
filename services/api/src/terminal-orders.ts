import type { ExactPrice } from "@naryx/protocol-types";
import {
  createCanonicalEntryOrder,
  type ActiveOrderContext,
  type ActiveOrderContextProvider,
  type CanonicalEntryRequest,
} from "./canonical-entry-order.js";
import {
  type InternalOrderCreateResult,
  type InternalOrderRecord,
  type InternalOrderStore,
} from "./internal-order-store.js";

export class TerminalOrderValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TerminalOrderValidationError";
    this.code = code;
  }
}

export interface InternalOrderClockPort {
  currentClock(context: ActiveOrderContext): Promise<bigint>;
}

/**
 * A lane's size-aware entry price: what its venue charges now for exactly this size, per base atom.
 * It replaces the context's reference price for that one order. Undefined keeps the reference price.
 * A size the venue cannot fill within the order's slippage throws INSUFFICIENT_LIQUIDITY.
 */
export interface InternalOrderSpotPricePort {
  entrySpotPrice(context: ActiveOrderContext, sizeAtoms: bigint, slippageBps?: number): Promise<ExactPrice | undefined>;
}

export type InternalOrderPorts = Readonly<{
  contexts: ActiveOrderContextProvider;
  store: InternalOrderStore;
  clock: InternalOrderClockPort;
  spotPrice?: InternalOrderSpotPricePort;
}>;

type TerminalOrderBrowserRequest = Readonly<{
  contextId: string;
  owner: string;
  settlementAccount: string;
  size: string;
  slippageBps: number;
  idempotencyKey: string;
}>;

const BROWSER_KEYS = [
  "contextId",
  "idempotencyKey",
  "owner",
  "settlementAccount",
  "size",
  "slippageBps",
] as const;
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const SIZE_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ORDER_HASH_PATTERN = /^[0-9a-f]{64}$/;
const U64_MAX = 18446744073709551615n;
const U256_MAX = (1n << 256n) - 1n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireOwnerString(value: unknown, code: string, message: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TerminalOrderValidationError(code, message);
  }
  return value;
}

function parseBrowserRequest(value: unknown): TerminalOrderBrowserRequest {
  if (!isRecord(value)) {
    throw new TerminalOrderValidationError("INVALID_BODY", "Request body must be a JSON object.");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== BROWSER_KEYS.length ||
    !BROWSER_KEYS.every((key, index) => keys[index] === key)
  ) {
    throw new TerminalOrderValidationError(
      "INVALID_FIELDS",
      "Request must contain only contextId, owner, settlementAccount, size, slippageBps, and idempotencyKey.",
    );
  }
  const contextId = requireOwnerString(value.contextId, "INVALID_CONTEXT_ID", "Context ID is invalid.");
  if (!CONTEXT_ID_PATTERN.test(contextId)) {
    throw new TerminalOrderValidationError("INVALID_CONTEXT_ID", "Context ID is invalid.");
  }
  const owner = requireOwnerString(value.owner, "INVALID_OWNER", "Owner is invalid.");
  const settlementAccount = requireOwnerString(
    value.settlementAccount,
    "INVALID_SETTLEMENT_ACCOUNT",
    "Settlement account is invalid.",
  );
  if (typeof value.size !== "string" || value.size.length === 0 || value.size.length > 64 ||
      !SIZE_PATTERN.test(value.size)) {
    throw new TerminalOrderValidationError(
      "INVALID_SIZE",
      "Size must be a positive decimal string.",
    );
  }
  if (typeof value.slippageBps !== "number" ||
      !Number.isSafeInteger(value.slippageBps) ||
      value.slippageBps <= 0) {
    throw new TerminalOrderValidationError("INVALID_SLIPPAGE", "Slippage must be a positive integer.");
  }
  if (typeof value.idempotencyKey !== "string" ||
      !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey)) {
    throw new TerminalOrderValidationError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency key must use 16 to 64 URL-safe characters.",
    );
  }
  return Object.freeze({
    contextId,
    owner,
    settlementAccount,
    size: value.size,
    slippageBps: value.slippageBps,
    idempotencyKey: value.idempotencyKey,
  });
}

function parseSizeAtoms(size: string, decimals: number): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Active context base-asset decimals are invalid.");
  }
  const parts = size.split(".");
  const whole = parts[0] as string;
  const fraction = parts[1] ?? "";
  if (fraction.length > decimals) {
    throw new TerminalOrderValidationError("INVALID_SIZE", "Size has more precision than the base asset supports.");
  }
  const scale = 10n ** BigInt(decimals);
  const wholeAtoms = BigInt(whole) * scale;
  const fractionAtoms = fraction.length === 0
    ? 0n
    : BigInt(fraction.padEnd(decimals, "0"));
  const atoms = wholeAtoms + fractionAtoms;
  if (atoms <= 0n || atoms > U256_MAX) {
    throw new TerminalOrderValidationError("INVALID_SIZE", "Size must be positive and within range.");
  }
  return atoms;
}

export class InternalOrderCoordinator {
  private readonly ports: InternalOrderPorts;

  constructor(ports: InternalOrderPorts) {
    this.ports = ports;
  }

  async createOrder(value: unknown): Promise<InternalOrderCreateResult> {
    const parsed = parseBrowserRequest(value);
    const context = this.ports.contexts(parsed.contextId);
    if (context === undefined || context.contextId !== parsed.contextId) {
      throw new TerminalOrderValidationError("UNKNOWN_CONTEXT", "Order context is unknown.");
    }
    const sizeAtoms = parseSizeAtoms(parsed.size, context.baseAsset.decimals);
    const currentClock = await this.ports.clock.currentClock(context);
    if (typeof currentClock !== "bigint" || currentClock <= 0n || currentClock > U64_MAX) {
      throw new Error("Order clock is invalid.");
    }
    const request: CanonicalEntryRequest = Object.freeze({
      contextId: parsed.contextId,
      owner: parsed.owner,
      settlementAccount: parsed.settlementAccount,
      sizeAtoms,
      slippageBps: parsed.slippageBps,
      idempotencyKey: parsed.idempotencyKey,
      currentClock,
    });
    // Validated against the context first, so an invalid request never reaches a venue read.
    let order = createCanonicalEntryOrder(this.ports.contexts, request);
    const spotReferencePrice = await this.ports.spotPrice?.entrySpotPrice(context, sizeAtoms, parsed.slippageBps);
    if (spotReferencePrice !== undefined) {
      order = createCanonicalEntryOrder((contextId) => {
        const live = this.ports.contexts(contextId);
        return live === undefined ? undefined : Object.freeze({ ...live, spotReferencePrice });
      }, request);
    }
    return this.ports.store.createOrGet({ order, request });
  }

  getOrder(orderHash: string): InternalOrderRecord | undefined {
    if (typeof orderHash !== "string" || !ORDER_HASH_PATTERN.test(orderHash)) {
      throw new TerminalOrderValidationError(
        "INVALID_ORDER_HASH",
        "Order hash must be 64 lowercase hex characters.",
      );
    }
    return this.ports.store.getByOrderHash(orderHash);
  }
}
