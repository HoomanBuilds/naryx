import assert from "node:assert/strict";
import test from "node:test";
import {
  activationConditionHash,
  assetRef,
  strategyPackageOrder,
  strategyPackageOrderHash,
  STRATEGY_QUOTE_CONVENTION_ID,
  STRATEGY_RISK_CLASS_ID,
  toHex,
  toProtocolJson,
  type ActivationConditionInput,
  type StrategyPackageOrderInput,
} from "@naryx/protocol-types";
import { NaryxClient, type FetchLike } from "../src/index.js";

const condition: ActivationConditionInput = {
  conditionVersion: 1,
  metric: "BASIS",
  comparator: "AT_OR_ABOVE",
  threshold: 50n,
  observationUnit: "EVM_UNIX_SECONDS",
  maximumObservationAge: 30n,
};

const orderInput: StrategyPackageOrderInput = {
  version: 1,
  environment: "testnet",
  templateId: "cash-and-carry-v1",
  templateVersion: 1,
  packageTemplateManifestHash: "33".repeat(32),
  graphHash: "34".repeat(32),
  seriesId: "sol-carry",
  seriesVersion: 1,
  seriesManifestHash: "35".repeat(32),
  executionClassId: "sol-carry-atomic",
  executionClassVersion: 1,
  executionClassManifestHash: "36".repeat(32),
  quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.ANNUALIZED_NET_YIELD,
  riskClassId: STRATEGY_RISK_CLASS_ID.DELTA_NEUTRAL_BASIS,
  owner: "owner-1",
  settlementAccount: "strategy-1",
  lifecycleAction: "ENTRY",
  settlementClass: "ATOMIC_POSTCONDITION",
  packageOrderType: "CONDITIONAL",
  packageTimeInForce: "FOK",
  economicQuantity: { asset: assetRef("sol", "31".repeat(32), 9), atoms: 100n },
  quoteAsset: assetRef("usdc", "32".repeat(32), 6),
  metricLimits: [],
  maximumServiceFeesByAsset: [],
  maximumVenueFeesByAsset: [],
  maximumNetworkFeesByAsset: [],
  maximumRecoveryCostByAsset: [],
  maximumMarginIncrease: { asset: assetRef("usdc", "32".repeat(32), 6), atoms: 0n },
  maximumResidualValue: { asset: assetRef("usdc", "32".repeat(32), 6), atoms: 0n },
  expiryUnit: "EVM_UNIX_SECONDS",
  expiryValue: 2_000n,
  nonce: 1n,
  activationConditionHash: activationConditionHash(condition),
};

test("registers and verifies a bound advanced order activation", async () => {
  const order = strategyPackageOrder(orderInput);
  const orderHash = toHex(strategyPackageOrderHash(order));
  const view = {
    orderHashHex: orderHash,
    order,
    condition,
    status: "WAITING",
    progress: { attemptedSlices: 0, failedSlices: 0, executedQuantity: 0n, executedNotionalTicks: 0n },
    attempts: [],
    registeredAtMs: 1,
    updatedAtMs: 1,
  };
  const seen: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push(`${init.method} ${url}`);
    return {
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(toProtocolJson({ version: 1, created: true, ...view })),
    };
  };
  const client = new NaryxClient({ baseUrl: "https://api.example", fetch });

  const registered = await client.registerOrderActivation(orderInput, { condition });
  assert.equal(registered.created, true);
  assert.equal(registered.activation.orderHashHex, orderHash);
  assert.equal(registered.activation.status, "WAITING");
  assert.equal((await client.getOrderActivation(orderHash)).condition?.metric, "BASIS");
  assert.deepEqual(seen, [
    "POST https://api.example/v1/order-activations",
    `GET https://api.example/v1/order-activations/${orderHash}`,
  ]);
});

test("derives an advanced order and verifies its returned activation", async () => {
  const order = strategyPackageOrder(orderInput);
  const orderHash = toHex(strategyPackageOrderHash(order));
  const sourceOrderHash = "91".repeat(32);
  const fetch: FetchLike = async () => ({
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(toProtocolJson({
      version: 1,
      sourceOrderHash,
      orderHash,
      graphHash: toHex(order.graphHash),
      created: true,
      status: "STORED_FOR_QUOTING",
      activation: {
        orderHashHex: orderHash,
        order,
        condition,
        status: "WAITING",
        progress: { attemptedSlices: 0, failedSlices: 0, executedQuantity: 0n, executedNotionalTicks: 0n },
        attempts: [],
        registeredAtMs: 1,
        updatedAtMs: 1,
      },
    })),
  });

  const derived = await new NaryxClient({ baseUrl: "https://api.example", fetch })
    .deriveAdvancedOrder({ sourceOrderHash, condition });
  assert.equal(derived.orderHash, orderHash);
  assert.equal(derived.activation.order.packageOrderType, "CONDITIONAL");
});
