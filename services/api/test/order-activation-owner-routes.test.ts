import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bs58 from "bs58";
import Database from "better-sqlite3";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  assetRef,
  executionScheduleHash,
  parseProtocolJson,
  strategyPackageOrder,
  strategyPackageOrderHash,
  STRATEGY_QUOTE_CONVENTION_ID,
  STRATEGY_RISK_CLASS_ID,
  toHex,
  type ExecutionScheduleInput,
  type StrategyPackageOrder,
} from "@naryx/protocol-types";
import { SqliteOrderActivationStore } from "../src/order-activation-store.js";
import {
  createOrderActivationOwnerHandler,
  orderActivationCancellationHash,
  orderActivationCancellationTypedData,
} from "../src/order-activation-owner-routes.js";

const sol = assetRef("sol", "31".repeat(32), 9);
const usdc = assetRef("usdc", "32".repeat(32), 6);
const NOW = 1_000_000;

const schedule: ExecutionScheduleInput = {
  scheduleVersion: 1,
  kind: "SCHEDULED",
  timeUnit: "EVM_UNIX_SECONDS",
  startValue: 1_000n,
  sliceInterval: 60n,
  sliceCount: 4,
  aggregateQuantityLimit: 100n,
  maximumSliceQuantity: 25n,
  stopRule: "SKIP_FAILED_SLICE",
};

function scheduledOrder(owner: string, nonce: bigint): StrategyPackageOrder {
  return strategyPackageOrder({
    version: 1, environment: "testnet", templateId: "cash-and-carry-v1", templateVersion: 1,
    packageTemplateManifestHash: "33".repeat(32), graphHash: "34".repeat(32), seriesId: "sol-carry", seriesVersion: 1,
    seriesManifestHash: "35".repeat(32), executionClassId: "sol-carry-atomic", executionClassVersion: 1,
    executionClassManifestHash: "36".repeat(32), quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.ANNUALIZED_NET_YIELD,
    riskClassId: STRATEGY_RISK_CLASS_ID.DELTA_NEUTRAL_BASIS, owner, settlementAccount: "strategy-1",
    lifecycleAction: "ENTRY", settlementClass: "ATOMIC_POSTCONDITION", packageOrderType: "SCHEDULED",
    packageTimeInForce: "FOK", economicQuantity: { asset: sol, atoms: 100n }, quoteAsset: usdc, metricLimits: [],
    maximumServiceFeesByAsset: [], maximumVenueFeesByAsset: [], maximumNetworkFeesByAsset: [],
    maximumRecoveryCostByAsset: [], maximumMarginIncrease: { asset: usdc, atoms: 0n },
    maximumResidualValue: { asset: usdc, atoms: 0n }, expiryUnit: "EVM_UNIX_SECONDS", expiryValue: 2_000n, nonce,
    executionScheduleHash: executionScheduleHash(schedule),
  });
}

test("an owner lists only their own advanced orders and cancels one only under their fresh signature", async () => {
  const alice = privateKeyToAccount(generatePrivateKey());
  const mallory = privateKeyToAccount(generatePrivateKey());
  const aliceOwner = alice.address.toLowerCase();
  const solanaKeys = generateKeyPairSync("ed25519");
  const solanaOwner = bs58.encode(solanaKeys.publicKey.export({ format: "der", type: "spki" }).subarray(12));
  const orders = new Map<string, StrategyPackageOrder>();
  for (const [owner, nonce] of [[aliceOwner, 1n], [aliceOwner, 2n], [mallory.address.toLowerCase(), 3n], [solanaOwner, 4n]] as const) {
    const order = scheduledOrder(owner, nonce);
    orders.set(toHex(strategyPackageOrderHash(order)), order);
  }
  const [aliceFirst, aliceSecond, malloryOrder, solanaOrder] = [...orders.keys()] as [string, string, string, string];
  const dir = mkdtempSync(join(tmpdir(), "naryx-activation-owner-"));
  const store = new SqliteOrderActivationStore(join(dir, "activation.sqlite"), {
    orders: { order: (hash) => {
      const order = orders.get(hash);
      return order === undefined ? undefined : { orderHashHex: hash, graphHashHex: toHex(order.graphHash), order, graph: {} as never, recordedAtMs: 1 };
    } },
    clock: () => NOW,
  });
  for (const hash of orders.keys()) store.register({ orderHashHex: hash, schedule });
  const handler = createOrderActivationOwnerHandler({ activations: store, clock: () => NOW });
  const server = createServer((request, response) => {
    if (!handler(request, response)) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/terminal/order-activations`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: parseProtocolJson(await response.text()) as Record<string, any> };
  };
  const evmCancel = async (orderHash: string, signer = alice, nonce = randomBytes(32).toString("hex")) => {
    const terms = { orderHash, owner: aliceOwner, nonce, expiresAtMs: NOW + 60_000 };
    const typed = orderActivationCancellationTypedData(terms);
    const signature = await signer.signTypedData({
      domain: typed.domain,
      types: { OrderActivationCancellation: [...typed.types.OrderActivationCancellation] },
      primaryType: typed.primaryType,
      message: { ...typed.message, cancellationHash: typed.message.cancellationHash as `0x${string}`,
        orderHash: typed.message.orderHash as `0x${string}`, owner: aliceOwner as `0x${string}`,
        nonce: typed.message.nonce as `0x${string}`, expiresAtMs: BigInt(terms.expiresAtMs) },
    });
    return { orderHash, nonce, expiresAtMs: terms.expiresAtMs, signature };
  };
  try {
    const listed = parseProtocolJson(await (await fetch(`${base}?owner=${aliceOwner}`)).text()) as { activations: { orderHashHex: string }[] };
    assert.deepEqual(listed.activations.map((view) => view.orderHashHex).sort(), [aliceFirst, aliceSecond].sort());

    const challenge = await post("/cancellation", { orderHash: aliceFirst, nonce: "ab".repeat(32), expiresAtMs: NOW + 60_000 });
    assert.equal(challenge.status, 200);
    assert.equal(challenge.body.owner, aliceOwner);
    assert.equal(challenge.body.scheme, "EIP712_SECP256K1");
    assert.equal((await post("/cancellation", { orderHash: aliceFirst, nonce: "ab".repeat(32), expiresAtMs: NOW + 600_001 })).status, 400);

    // Another wallet's signature over Alice's order cancels nothing and spends no nonce.
    const forged = await evmCancel(aliceFirst, mallory);
    assert.equal((await post("/cancel", forged)).status, 403);
    assert.equal(store.view(aliceFirst)?.status, "WAITING");

    const signed = await evmCancel(aliceFirst, alice, forged.nonce);
    const cancelled = await post("/cancel", signed);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "CANCELLED");
    const replay = await post("/cancel", signed);
    assert.deepEqual([replay.status, replay.body.error.code], [409, "NONCE_REPLAYED"]);
    // A signature over one activation does not cancel another.
    assert.equal((await post("/cancel", { ...signed, orderHash: aliceSecond })).status, 403);

    // A reserved attempt (an executable child may be in flight) holds cancellation; the nonce stays unspent.
    const attempt = store.reserve({ orderHashHex: aliceSecond, observations: [], atValue: 1_000n, side: "BID", limitPriceTicks: 100n });
    assert.equal(attempt.active, true);
    const held = await evmCancel(aliceSecond);
    const outstanding = await post("/cancel", held);
    assert.deepEqual([outstanding.status, outstanding.body.error.code], [409, "ATTEMPT_OUTSTANDING"]);
    assert.equal(store.view(aliceSecond)?.status, "WAITING");
    assert.equal(store.view(malloryOrder)?.status, "WAITING");

    const solanaTerms = { orderHash: solanaOrder, owner: solanaOwner, nonce: "cd".repeat(32), expiresAtMs: NOW + 60_000 };
    const solanaSignature = bs58.encode(sign(null, orderActivationCancellationHash(solanaTerms), solanaKeys.privateKey));
    const { owner: _owner, ...solanaBody } = solanaTerms;
    assert.equal((await post("/cancel", { ...solanaBody, signature: bs58.encode(randomBytes(64)) })).status, 403);
    assert.equal((await post("/cancel", { ...solanaBody, signature: solanaSignature })).body.status, "CANCELLED");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activations registered before the owner index existed are listed after reopening", () => {
  const order = scheduledOrder("owner-1", 9n);
  const hash = toHex(strategyPackageOrderHash(order));
  const orders = { order: (value: string) => value === hash
    ? { orderHashHex: hash, graphHashHex: toHex(order.graphHash), order, graph: {} as never, recordedAtMs: 1 }
    : undefined };
  const dir = mkdtempSync(join(tmpdir(), "naryx-activation-owner-"));
  const path = join(dir, "activation.sqlite");
  try {
    const first = new SqliteOrderActivationStore(path, { orders });
    first.register({ orderHashHex: hash, schedule });
    first.close();
    const raw = new Database(path);
    raw.exec("DROP TABLE order_activation_owners");
    raw.close();
    const reopened = new SqliteOrderActivationStore(path, { orders });
    try {
      assert.deepEqual(reopened.ownerViews("owner-1").map((view) => view.orderHashHex), [hash]);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
