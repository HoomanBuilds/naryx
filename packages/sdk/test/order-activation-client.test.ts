import assert from "node:assert/strict";
import test from "node:test";
import {
  activationConditionHash,
  adapterRef,
  assetRef,
  domainRef,
  packageGraph,
  packageGraphHash,
  sliceStrategyPackageGraph,
  strategyPackageOrder,
  strategyPackageOrderHash,
  STRATEGY_QUOTE_CONVENTION_ID,
  STRATEGY_RISK_CLASS_ID,
  toHex,
  toProtocolJson,
  versionedManifestRef,
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

test("prepares and verifies an executable child package for an activation attempt", async () => {
  const base = assetRef("sol", "31".repeat(32), 9);
  const quote = assetRef("usdc", "32".repeat(32), 6);
  const parentGraph = packageGraph({
    graphVersion: 1,
    environment: "testnet",
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: "33".repeat(32),
    seriesId: "sol-carry",
    seriesVersion: 1,
    seriesManifestHash: "35".repeat(32),
    executionClassId: "sol-carry-atomic",
    executionClassVersion: 1,
    executionClassManifestHash: "36".repeat(32),
    lifecycleAction: "ENTRY",
    owner: "owner-1",
    strategyAccountRefs: ["strategy-1"],
    legs: [{
      legId: "spot",
      legFamily: "SPOT_SWAP",
      legTypeId: "spot-purchase",
      domain: domainRef("evm:11155111", 1, "41".repeat(32)),
      adapter: adapterRef({ adapterId: "spot-v1", adapterManifestVersion: 1, adapterManifestHash: "42".repeat(32) }),
      venue: versionedManifestRef("venue-1", 1, "43".repeat(32)),
      market: versionedManifestRef("sol-usdc", 1, "44".repeat(32)),
      assets: [base, quote],
      side: "BUY",
      quantityAsset: base,
      quantityAtoms: 100n,
      minimumQuantityAtoms: 100n,
      limitPrice: { baseAsset: base, quoteAsset: quote, quoteAtoms: 100n, baseAtoms: 1n, roundingDirection: "CEIL" },
      maximumFeeQuoteAtoms: 20n,
      preconditionHashes: [],
      postconditionHashes: [],
      timeInForce: "FOK",
      legExpiryValue: 1_900n,
    }],
    dependencyEdges: [],
    executionGroups: [{ groupId: "atomic", kind: "ALL_OR_NONE", legIds: ["spot"] }],
    settlementClass: "ATOMIC_POSTCONDITION",
    policyHashes: {
      netting: "51".repeat(32), privacy: "52".repeat(32), solver: "53".repeat(32),
      delivery: "54".repeat(32), resource: "55".repeat(32), portfolioRiskLimits: "56".repeat(32),
    },
    recoverySlots: [],
    maximumRecoveryCostQuoteAtoms: 0n,
    expiryUnit: "EVM_UNIX_SECONDS",
    packageExpiryValue: 2_000n,
    nonce: 1n,
  });
  const parentOrder = strategyPackageOrder({ ...orderInput, graphHash: packageGraphHash(parentGraph) });
  const parentOrderHash = toHex(strategyPackageOrderHash(parentOrder));
  const attemptId = "61".repeat(32);
  const sliced = sliceStrategyPackageGraph({
    parentGraph,
    parentOrderHash,
    activationAttemptId: attemptId,
    parentEconomicQuantity: 100n,
    childEconomicQuantity: 25n,
    graphNonce: 7n,
  });
  const { activationConditionHash: _activationConditionHash, ...immediateInput } = orderInput;
  const childOrder = strategyPackageOrder({
    ...immediateInput,
    packageOrderType: "LIMIT",
    graphHash: packageGraphHash(sliced.graph),
    economicQuantity: { asset: base, atoms: 25n },
    nonce: 2n,
  });
  const childOrderHash = toHex(strategyPackageOrderHash(childOrder));
  const childGraphHash = toHex(packageGraphHash(sliced.graph));
  const sourceOrderHash = "62".repeat(32);
  const fetch: FetchLike = async () => ({
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(toProtocolJson({
      version: 1,
      attemptId,
      parentOrderHash,
      sourceOrderHash,
      orderHash: childOrderHash,
      graphHash: childGraphHash,
      order: childOrder,
      graph: sliced.graph,
      created: true,
      replayed: false,
      status: "STORED_FOR_QUOTING",
      slicePolicies: sliced.policies,
      packageBookRequest: { strategyOrderHash: childOrderHash, side: "BID", limitPriceTicks: 99n },
    })),
  });
  const prepared = await new NaryxClient({ baseUrl: "https://api.example", fetch })
    .prepareOrderActivationAttempt(attemptId, 10n);
  assert.equal(prepared.orderHash, childOrderHash);
  assert.equal(prepared.graph.legs[0]?.quantityAtoms, 25n);
  assert.equal(prepared.packageBookRequest.limitPriceTicks, 99n);
});
