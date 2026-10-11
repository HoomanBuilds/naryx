import assert from "node:assert/strict";
import test from "node:test";
import {
  assetRef,
  packageAllocation,
  strategyPackageOrder,
  strategyPackageOrderHash,
  STRATEGY_QUOTE_CONVENTION_ID,
  STRATEGY_RISK_CLASS_ID,
  toHex,
  type PackageAllocation,
  type StrategyPackageOrderInput,
} from "@naryx/protocol-types";
import { AdvancedOrderReconciliation, type OrderActivationAttempt } from "../src/index.js";

const id = (byte: string) => byte.repeat(64);
const quantityAsset = assetRef("sol", id("1"), 9);
const quoteAsset = assetRef("usdc", id("2"), 6);

function childOrder(): StrategyPackageOrderInput {
  return {
    version: 1,
    environment: "testnet",
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: id("3"),
    graphHash: id("4"),
    seriesId: "sol-carry",
    seriesVersion: 1,
    seriesManifestHash: id("5"),
    executionClassId: "sol-carry-atomic",
    executionClassVersion: 1,
    executionClassManifestHash: id("6"),
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.ANNUALIZED_NET_YIELD,
    riskClassId: STRATEGY_RISK_CLASS_ID.DELTA_NEUTRAL_BASIS,
    owner: "owner-1",
    settlementAccount: "strategy-1",
    lifecycleAction: "ENTRY",
    settlementClass: "ATOMIC_POSTCONDITION",
    packageOrderType: "LIMIT",
    packageTimeInForce: "FOK",
    economicQuantity: { asset: quantityAsset, atoms: 25n },
    quoteAsset,
    metricLimits: [],
    maximumServiceFeesByAsset: [],
    maximumVenueFeesByAsset: [],
    maximumNetworkFeesByAsset: [],
    maximumRecoveryCostByAsset: [],
    maximumMarginIncrease: { asset: quoteAsset, atoms: 0n },
    maximumResidualValue: { asset: quoteAsset, atoms: 0n },
    expiryUnit: "EVM_UNIX_SECONDS",
    expiryValue: 2_000n,
    nonce: 1n,
  };
}

function fixture(receiptFields: Record<string, unknown>, options: { committed?: boolean; expired?: boolean } = {}) {
  const order = strategyPackageOrder(childOrder());
  const childOrderHashHex = toHex(strategyPackageOrderHash(order));
  const packageOrderIdHex = id("7");
  const attempt: OrderActivationAttempt = {
    attemptId: id("8"),
    orderHashHex: id("9"),
    ordinal: 0,
    atValue: 1_000n,
    maximumQuantityAtoms: 25n,
    side: "BID",
    limitPriceTicks: 100n,
    status: "RESERVED",
    reservedAtMs: 1,
    childOrderHashHex,
    childGraphHashHex: toHex(order.graphHash),
  };
  const allocation: PackageAllocation = packageAllocation({
    version: 1,
    environment: "testnet",
    executionClassId: order.executionClassId,
    matchingPolicyHash: id("a"),
    takerOrderId: packageOrderIdHex,
    takerParticipantId: "taker",
    takerCommonControlGroupId: "taker-group",
    takerSide: "BID",
    takerTimeInForce: "FOK",
    takerLimitPriceTicks: 100n,
    requestedQuantity: 25n,
    firstFillSequence: 1n,
    fills: [
      {
        fillSequence: 1n,
        makerEntryId: id("b"),
        makerSource: "DIRECT",
        makerSequence: 1n,
        makerParticipantId: "maker-1",
        makerCommonControlGroupId: "maker-group-1",
        priceTicks: 98n,
        quantity: 10n,
        consumedSourceKeys: [],
      },
      {
        fillSequence: 2n,
        makerEntryId: id("c"),
        makerSource: "DIRECT",
        makerSequence: 2n,
        makerParticipantId: "maker-2",
        makerCommonControlGroupId: "maker-group-2",
        priceTicks: 99n,
        quantity: 15n,
        consumedSourceKeys: [],
      },
    ],
    restedQuantity: 0n,
    cancelledQuantity: 0n,
    selfMatchCancelledEntryIds: [],
    invalidatedEntryIds: [],
    internalMatchedQuantity: 25n,
    externalImpliedQuantity: 0n,
  } as unknown as PackageAllocation);
  let completion: Record<string, unknown> | undefined;
  const completedAttempt = { ...attempt, status: "SUCCEEDED" as const };
  const activation = { attempts: [completedAttempt] } as never;
  const reconciliation = new AdvancedOrderReconciliation({
    activations: {
      attempt: () => attempt,
      completeWithEvidence: (input) => {
        completion = input as unknown as Record<string, unknown>;
        return { replayed: false, view: activation };
      },
      expireReservedAttempt: () => options.expired === true
        ? { replayed: false, view: { attempts: [{ ...attempt, status: "FAILED" as const }] } as never }
        : undefined,
    },
    strategies: {
      order: () => ({
        orderHashHex: childOrderHashHex,
        graphHashHex: toHex(order.graphHash),
        order,
        graph: {} as never,
        recordedAtMs: 1,
      }),
      packageExecutionLock: () => ({ packageOrderIdHex, recordedAtMs: 1 }),
      receiptByOrder: () => ({
        receiptHashHex: id("d"),
        receipt: { orderHash: strategyPackageOrderHash(order), ...receiptFields } as never,
        recordedAtMs: 1,
      }),
    },
    exchange: {
      getAllocation: () => allocation,
      settlementCommitment: () => options.committed === false ? undefined : ({
        packageOrderId: Buffer.from(packageOrderIdHex, "hex"),
        strategyOrderHash: strategyPackageOrderHash(order),
        graphHash: order.graphHash,
        quantity: 25n,
      } as never),
    },
  });

  return { attempt, reconciliation, completion: () => completion };
}

test("advanced reconciliation credits exact allocation notional only after a final receipt", () => {
  const { attempt, reconciliation, completion } = fixture({ finalityStatus: "FINALIZED", terminalState: "FINALIZED_COMPLETE" });
  const result = reconciliation.reconcile(attempt.attemptId);
  assert.equal(result.status, "COMPLETED");
  assert.equal(completion()?.allocatedQuantityAtoms, 25n);
  assert.equal(completion()?.allocatedNotionalTicks, 2_465n);
  assert.equal(completion()?.outcome, "SUCCEEDED");
});

const hypercore = { domainId: "hypercore:testnet", domainManifestVersion: 1, domainManifestHash: Buffer.from(id("e"), "hex") };
const baseSepolia = { domainId: "eip155:84532", domainManifestVersion: 1, domainManifestHash: Buffer.from(id("f"), "hex") };
function venueCommitted(legDomains: readonly (typeof hypercore)[], evidenceGrade = "VENUE_API_CORROBORATED") {
  return {
    finalityStatus: "VENUE_COMMITTED",
    terminalState: "FINALIZED_COMPLETE",
    domains: [...new Map(legDomains.map((domain) => [domain.domainId, domain])).values()],
    legOutcomes: legDomains.map((domain) => ({ domain, evidenceGrade })),
  };
}

test("advanced reconciliation settles a corroborated HyperCore venue-committed receipt and refuses weaker ones", () => {
  const accepted = fixture(venueCommitted([hypercore, hypercore]));
  const result = accepted.reconciliation.reconcile(accepted.attempt.attemptId);
  assert.equal(result.status, "COMPLETED");
  assert.equal(accepted.completion()?.outcome, "SUCCEEDED");

  for (const receipt of [
    venueCommitted([hypercore, baseSepolia]),
    venueCommitted([hypercore, hypercore], "CONTROLLER_ATTESTED"),
    { ...venueCommitted([hypercore]), terminalState: "RECOVERED_COMPLETE" },
    venueCommitted([baseSepolia]),
  ]) {
    const refused = fixture(receipt);
    const pendingResult = refused.reconciliation.reconcile(refused.attempt.attemptId);
    assert.equal(pendingResult.status, "PENDING");
    assert.equal(pendingResult.status === "PENDING" ? pendingResult.stage : undefined, "RECEIPT_NOT_FINAL");
    assert.equal(refused.completion(), undefined);
  }
});

test("advanced reconciliation fails an unfillable child only after the order expires", () => {
  const waiting = fixture({}, { committed: false });
  const pendingResult = waiting.reconciliation.reconcile(waiting.attempt.attemptId);
  assert.equal(pendingResult.status === "PENDING" ? pendingResult.stage : undefined, "PACKAGE_ORDER_NOT_SUBMITTED");
  const expired = fixture({}, { committed: false, expired: true });
  const result = expired.reconciliation.reconcile(expired.attempt.attemptId);
  assert.deepEqual([result.status, result.status === "COMPLETED" ? result.outcome : undefined], ["COMPLETED", "FAILED"]);
  assert.equal(expired.completion(), undefined);
});
