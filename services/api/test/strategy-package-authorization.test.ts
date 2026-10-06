import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  createStrategyPackageAuthorizationPort,
  type StoredStrategyPackageAuthorization,
  type StoredStrategyPackageOrder,
} from "../src/index.js";

const ORDER_HASH = "11".repeat(32);

function storedOrder(owner: string, overrides: Readonly<Record<string, unknown>> = {}): StoredStrategyPackageOrder {
  return {
    orderHashHex: ORDER_HASH,
    graphHashHex: "22".repeat(32),
    recordedAtMs: 1_000,
    graph: {},
    order: {
      owner,
      environment: "testnet",
      templateId: "cash-and-carry-v1",
      lifecycleAction: "ENTRY",
      settlementClass: "BATCHED_IOC_WITH_RECOVERY",
      settlementAccount: "hypercore:testnet:omnibus",
      expiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS",
      expiryValue: 20_000n,
      ...overrides,
    },
  } as unknown as StoredStrategyPackageOrder;
}

test("strategy package authorization verifies the exact owner and order hash", async () => {
  const owner = privateKeyToAccount(`0x${"31".repeat(32)}`);
  const stranger = privateKeyToAccount(`0x${"32".repeat(32)}`);
  let recorded: StoredStrategyPackageAuthorization | undefined;
  const store = {
    order: (orderHash: string) => orderHash === ORDER_HASH ? storedOrder(owner.address.toLowerCase()) : undefined,
    ownerAuthorization: () => recorded,
    recordOwnerAuthorization: (orderHash: string, authorizedOwner: string, signature: string) => {
      recorded = Object.freeze({
        orderHashHex: orderHash,
        owner: authorizedOwner,
        scheme: "EIP712_SECP256K1" as const,
        signature,
        authorizedAtMs: 10_000,
      });
      return Object.freeze({ created: true, authorization: recorded });
    },
  };
  const port = createStrategyPackageAuthorizationPort(store, () => 10_000);
  const challenge = port.prepare(ORDER_HASH);
  assert.equal(challenge.owner, owner.address.toLowerCase());
  assert.equal(challenge.typedData.message.orderHash, `0x${ORDER_HASH}`);
  assert.equal(challenge.typedData.message.expiryValue, "20000");

  const wrongSignature = await stranger.signTypedData(challenge.typedData as never);
  await assert.rejects(() => port.authorize(ORDER_HASH, wrongSignature), { code: "INVALID_SIGNATURE" });
  assert.equal(recorded, undefined);

  const signature = await owner.signTypedData(challenge.typedData as never);
  const result = await port.authorize(ORDER_HASH, signature);
  assert.equal(result.status, "OWNER_AUTHORIZED");
  assert.equal(result.created, true);
  assert.equal(result.authorization.orderHashHex, ORDER_HASH);
  assert.equal(result.authorization.owner, owner.address.toLowerCase());
  assert.equal(result.authorization.signature, signature.toLowerCase());

  const replay = await port.authorize(ORDER_HASH, signature);
  assert.equal(replay.created, false);
  assert.equal(replay.authorization, recorded);
});

test("strategy package authorization refuses expired and non-testnet orders", () => {
  const owner = privateKeyToAccount(`0x${"33".repeat(32)}`).address.toLowerCase();
  const baseStore = {
    ownerAuthorization: () => undefined,
    recordOwnerAuthorization: () => { throw new Error("must not record"); },
  };
  const expired = createStrategyPackageAuthorizationPort({
    ...baseStore,
    order: () => storedOrder(owner, { expiryValue: 10_000n }),
  }, () => 10_000);
  assert.throws(() => expired.prepare(ORDER_HASH), { code: "ORDER_EXPIRED" });

  const mainnet = createStrategyPackageAuthorizationPort({
    ...baseStore,
    order: () => storedOrder(owner, { environment: "mainnet" }),
  }, () => 1_000);
  assert.throws(() => mainnet.prepare(ORDER_HASH), { code: "UNSUPPORTED_ENVIRONMENT" });
});
