import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assetRef,
  metricObservationAttestationHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  STRATEGY_QUOTE_CONVENTION_ID,
  STRATEGY_RISK_CLASS_ID,
  toHex,
  type MetricObservationAttestationInput,
  type StrategyPackageOrderInput,
} from "@naryx/protocol-types";
import { SqliteMetricObservationStore } from "../src/index.js";

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
  return { raw, sign: (bytes: Uint8Array) => new Uint8Array(sign(null, bytes, privateKey)) };
}

function orderInput(): StrategyPackageOrderInput {
  const quote = assetRef("usdc", "32".repeat(32), 6);
  return {
    version: 1, environment: "testnet", templateId: "cash-and-carry-v1", templateVersion: 1,
    packageTemplateManifestHash: "33".repeat(32), graphHash: "34".repeat(32), seriesId: "sol-carry", seriesVersion: 1,
    seriesManifestHash: "35".repeat(32), executionClassId: "sol-carry-atomic", executionClassVersion: 1,
    executionClassManifestHash: "36".repeat(32), quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.ANNUALIZED_NET_YIELD,
    riskClassId: STRATEGY_RISK_CLASS_ID.DELTA_NEUTRAL_BASIS, owner: "owner-1", settlementAccount: "strategy-1",
    lifecycleAction: "ENTRY", settlementClass: "ATOMIC_POSTCONDITION", packageOrderType: "CONDITIONAL", packageTimeInForce: "FOK",
    economicQuantity: { asset: assetRef("sol", "31".repeat(32), 9), atoms: 100n }, quoteAsset: quote, metricLimits: [],
    maximumServiceFeesByAsset: [], maximumVenueFeesByAsset: [], maximumNetworkFeesByAsset: [], maximumRecoveryCostByAsset: [],
    maximumMarginIncrease: { asset: quote, atoms: 0n }, maximumResidualValue: { asset: quote, atoms: 0n },
    activationConditionHash: "37".repeat(32), expiryUnit: "EVM_UNIX_SECONDS", expiryValue: 2_000n, nonce: 1n,
  };
}

test("signed metric observations are order-bound, replay-safe, and selected only inside validity", () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-metric-observations-"));
  const keys = keyPair();
  const order = strategyPackageOrder(orderInput());
  const orderHashHex = toHex(strategyPackageOrderHash(order));
  const stored = { orderHashHex, graphHashHex: toHex(order.graphHash), order, graph: {} as never, recordedAtMs: 1 };
  const store = new SqliteMetricObservationStore(join(dir, "observations.sqlite"), {
    environment: "testnet",
    orders: { order: (hash) => hash === orderHashHex ? stored : undefined },
    sourcesByMetric: new Map([["BASIS", { sourceId: "basis-source", manifestHashHex: "41".repeat(32), verificationKey: keys.raw }]]),
    clock: () => 1,
  });
  const observation = (overrides: Partial<MetricObservationAttestationInput> = {}): MetricObservationAttestationInput => ({
    observationVersion: 1, environment: "testnet", orderHash: orderHashHex, sourceId: "basis-source",
    sourceManifestHash: "41".repeat(32), metric: "BASIS", value: 50n, timeUnit: "EVM_UNIX_SECONDS",
    observedAtValue: 1_000n, validUntilValue: 1_030n, sequence: 1n, evidenceHash: "42".repeat(32), ...overrides,
  });
  try {
    const first = observation();
    const signature = keys.sign(metricObservationAttestationHash(first));
    assert.equal(store.publish(first, signature).replayed, false);
    assert.equal(store.publish(first, signature).replayed, true);
    assert.deepEqual(store.observations(orderHashHex, 1_010n), [{ metric: "BASIS", value: 50n, observedAtValue: 1_000n }]);
    assert.deepEqual(store.observations(orderHashHex, 1_031n), []);

    const next = observation({ value: 60n, observedAtValue: 1_020n, validUntilValue: 1_050n, sequence: 2n });
    store.publish(next, keys.sign(metricObservationAttestationHash(next)));
    assert.deepEqual(store.observations(orderHashHex, 1_025n), [{ metric: "BASIS", value: 60n, observedAtValue: 1_020n }]);
    const replayedSequence = observation({ value: 70n, sequence: 2n });
    assert.throws(() => store.publish(replayedSequence, keys.sign(metricObservationAttestationHash(replayedSequence))), { code: "SEQUENCE_REPLAY" });
    assert.throws(() => store.publish(observation({ sequence: 3n }), new Uint8Array(64)), { code: "INVALID_SIGNATURE" });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
