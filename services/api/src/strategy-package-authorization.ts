import { verifyTypedData, type Hex } from "viem";
import type {
  SqliteStrategyPackageStore,
  StoredStrategyPackageAuthorization,
  StoredStrategyPackageOrder,
} from "./strategy-package-store.js";

const OWNER = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/;

export class StrategyPackageAuthorizationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StrategyPackageAuthorizationError";
    this.code = code;
  }
}

export function strategyPackageAuthorizationTypedData(stored: StoredStrategyPackageOrder) {
  return Object.freeze({
    domain: Object.freeze({ name: "Naryx Strategy Package Testnet", version: "1" }),
    types: Object.freeze({
      StrategyPackageAuthorization: Object.freeze([
        { name: "orderHash", type: "bytes32" },
        { name: "owner", type: "address" },
        { name: "environment", type: "string" },
        { name: "templateId", type: "string" },
        { name: "lifecycleAction", type: "string" },
        { name: "settlementClass", type: "string" },
        { name: "settlementAccount", type: "string" },
        { name: "expiryUnit", type: "string" },
        { name: "expiryValue", type: "uint256" },
      ]),
    }),
    primaryType: "StrategyPackageAuthorization" as const,
    message: Object.freeze({
      orderHash: `0x${stored.orderHashHex}`,
      owner: stored.order.owner,
      environment: stored.order.environment,
      templateId: stored.order.templateId,
      lifecycleAction: stored.order.lifecycleAction,
      settlementClass: stored.order.settlementClass,
      settlementAccount: stored.order.settlementAccount,
      expiryUnit: stored.order.expiryUnit,
      expiryValue: stored.order.expiryValue.toString(),
    }),
  });
}

export interface StrategyPackageAuthorizationChallenge {
  readonly version: 1;
  readonly status: "UNSIGNED_STRATEGY_ORDER";
  readonly orderHash: string;
  readonly owner: string;
  readonly typedData: ReturnType<typeof strategyPackageAuthorizationTypedData>;
}

export interface StrategyPackageAuthorizationPort {
  prepare(orderHash: string): StrategyPackageAuthorizationChallenge;
  authorize(orderHash: string, signature: string): Promise<Readonly<{
    version: 1;
    status: "OWNER_AUTHORIZED";
    created: boolean;
    authorization: StoredStrategyPackageAuthorization;
  }>>;
}

type Store = Pick<
  SqliteStrategyPackageStore,
  "order" | "ownerAuthorization" | "recordOwnerAuthorization"
>;

function executableTestnetOrder(store: Store, orderHash: string, nowMs: number): StoredStrategyPackageOrder {
  if (!HASH.test(orderHash)) throw new StrategyPackageAuthorizationError("INVALID_HASH", "The strategy package order hash is invalid.");
  const stored = store.order(orderHash);
  if (stored === undefined) throw new StrategyPackageAuthorizationError("ORDER_NOT_FOUND", "The strategy package order is not stored.");
  if (stored.order.environment !== "testnet") {
    throw new StrategyPackageAuthorizationError("UNSUPPORTED_ENVIRONMENT", "Only testnet strategy package orders can be authorized.");
  }
  if (!OWNER.test(stored.order.owner)) {
    throw new StrategyPackageAuthorizationError("UNSUPPORTED_OWNER", "This strategy package does not use an EVM wallet owner.");
  }
  const current = stored.order.expiryUnit === "EVM_UNIX_SECONDS" ? BigInt(Math.floor(nowMs / 1_000))
    : stored.order.expiryUnit === "HYPERLIQUID_UNIX_MILLISECONDS" ? BigInt(nowMs)
      : undefined;
  if (current !== undefined && current >= stored.order.expiryValue) {
    throw new StrategyPackageAuthorizationError("ORDER_EXPIRED", "The strategy package order has expired.");
  }
  return stored;
}

export function createStrategyPackageAuthorizationPort(
  store: Store,
  clock: () => number = Date.now,
): StrategyPackageAuthorizationPort {
  const prepare = (orderHash: string): StrategyPackageAuthorizationChallenge => {
    const stored = executableTestnetOrder(store, orderHash, clock());
    return Object.freeze({
      version: 1,
      status: "UNSIGNED_STRATEGY_ORDER",
      orderHash,
      owner: stored.order.owner,
      typedData: strategyPackageAuthorizationTypedData(stored),
    });
  };
  return Object.freeze({
    prepare,
    async authorize(orderHash: string, signatureInput: string) {
      const challenge = prepare(orderHash);
      const signature = signatureInput.toLowerCase();
      if (!SIGNATURE.test(signature)) {
        throw new StrategyPackageAuthorizationError("INVALID_SIGNATURE", "The strategy package authorization signature is invalid.");
      }
      const typedData = challenge.typedData;
      let valid = false;
      try {
        valid = await verifyTypedData({
          address: challenge.owner as Hex,
          domain: typedData.domain,
          types: { StrategyPackageAuthorization: [...typedData.types.StrategyPackageAuthorization] },
          primaryType: typedData.primaryType,
          message: {
            ...typedData.message,
            orderHash: typedData.message.orderHash as Hex,
            owner: challenge.owner as Hex,
          },
          signature: signature as Hex,
        });
      } catch {
        valid = false;
      }
      if (!valid) {
        throw new StrategyPackageAuthorizationError("INVALID_SIGNATURE", "The signature is not the strategy package owner's authorization.");
      }
      const existing = store.ownerAuthorization(orderHash);
      const recorded = existing === undefined
        ? store.recordOwnerAuthorization(orderHash, challenge.owner, signature)
        : Object.freeze({ created: false, authorization: existing });
      return Object.freeze({
        version: 1,
        status: "OWNER_AUTHORIZED" as const,
        ...recorded,
      });
    },
  });
}
