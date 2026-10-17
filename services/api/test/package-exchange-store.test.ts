import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import bs58 from "bs58";
import {
  adapterRef,
  assetRef,
  commitmentHash,
  crossBatchExternalExecutionEvidence,
  domainRef,
  netObligations,
  nettingAllocationExecutionAuthorization,
  nettingAllocationSettlementEvidence,
  nettingExternalExecutionEvidence,
  nettingExternalExecutionIntent,
  nettingExternalExecutionIntentHash,
  packageMatchingPolicy,
  packageMatchingPolicyHash,
  packageSettlementCommitmentHash,
  packageReopeningSnapshotHash,
  seriesExecutionClassHash,
  toHex,
  verifyPackageAllocation,
  versionedManifestRef,
  type NettingPolicyManifestInput,
} from "@naryx/protocol-types";
import {
  PackageExchangeStoreError,
  SqlitePackageExchangeStore,
  prepareNextAuthoritativeCrossBatchClearing,
} from "../src/index.js";
import { MAX_ENTRIES_PER_PARTICIPANT } from "../src/package-exchange-store.js";
import {
  CLASS,
  CLASS_SUPPORT,
  NOW,
  POLICY,
  SERIES,
  SERIES_SUPPORT,
  executionClass,
  id,
  impliedAsk,
  order,
  registerAll,
  settlement,
  withStore,
} from "./exchange-fixtures.js";

test("series, classes, and policies are immutable once registered", () => {
  withStore((store) => {
    assert.throws(() => store.registerExecutionClass(executionClass()), { code: "UNKNOWN_REFERENCE" });
    assert.equal(store.registerSeries(SERIES).created, true);
    assert.throws(() => store.registerExecutionClass(executionClass()), { code: "UNKNOWN_REFERENCE" });
    assert.equal(store.registerMatchingPolicy(POLICY).created, true);
    const registered = store.registerExecutionClass(executionClass());
    assert.equal(registered.created, true);
    assert.equal(store.registerSeries(SERIES).created, false);
    assert.throws(() => store.registerSeries({ ...SERIES, quoteAsset: "usdc" }), { code: "DOCUMENT_CONFLICT" });
    assert.throws(() => store.registerMatchingPolicy({ ...POLICY, quantityIncrement: 5n, minimumExecutionQuantity: 5n }), {
      code: "DOCUMENT_CONFLICT",
    });
    assert.equal(store.getSeries(SERIES.seriesId, SERIES.seriesVersion)?.quoteAsset, "usd");
    assert.equal(store.getExecutionClass(CLASS, 1)?.executionClassId, CLASS);
  });
});

test("a class cannot bind a matching policy written for another class", () => {
  withStore((store) => {
    store.registerSeries(SERIES);
    const other = { ...POLICY, executionClassId: "other-class" };
    store.registerMatchingPolicy(other);
    assert.throws(
      () => store.registerExecutionClass(executionClass({ matchingPolicyHash: packageMatchingPolicyHash(packageMatchingPolicy(other)) })),
      { code: "UNKNOWN_REFERENCE" },
    );
  });
});

test("orders match durably and replay returns the recorded allocation", () => {
  withStore((store) => {
    registerAll(store);
    const maker = order(1);
    const rested = store.submitOrder(CLASS, maker, NOW, settlement(maker));
    assert.equal(rested.accepted && rested.allocation.restedQuantity, 10n);
    const taker = order(2, { side: "BID", timeInForce: "IOC" });
    const filled = store.submitOrder(CLASS, taker, NOW, settlement(taker));
    assert.equal(filled.accepted && filled.replayed, false);
    const replay = store.submitOrder(CLASS, taker, NOW, settlement(taker));
    assert.equal(replay.accepted && replay.replayed, true);
    assert.equal(replay.accepted && replay.allocationHashHex, filled.accepted && filled.allocationHashHex);
    assert.equal(store.getBook(CLASS)?.entries.length, 0);
    const stored = store.getAllocation(id(2));
    assert.ok(stored);
    verifyPackageAllocation(packageMatchingPolicy(POLICY), stored);
    for (const packageOrderId of [maker.orderId, taker.orderId]) {
      const progress = store.settlementProgress(packageOrderId);
      assert.equal(progress?.readiness.status, "READY_FOR_OWNER_AUTHORIZATION");
      assert.deepEqual(
        [progress?.readiness.committedQuantity, progress?.readiness.allocatedQuantity, progress?.readiness.remainingQuantity],
        [10n, 10n, 0n],
      );
      assert.equal(progress?.obligations.length, 1);
    }
    const rejectedOrder = order(3, { side: "BID", timeInForce: "IOC" });
    const rejected = store.submitOrder(CLASS, rejectedOrder, NOW, settlement(rejectedOrder));
    assert.deepEqual(rejected, { accepted: false, rejection: "MINIMUM_QUANTITY_UNFILLABLE" });
  });
});

test("external intents are matched to net residual instruments in byte order", () => {
  withStore((store) => {
    registerAll(store);
    const signature = bs58.encode(new Uint8Array(64).fill(7));
    const maker = order(1);
    const taker = order(2, { side: "BID", timeInForce: "IOC" });
    store.submitOrder(CLASS, maker, NOW, settlement(maker), { scheme: "ED25519", signature });
    store.submitOrder(CLASS, taker, NOW, settlement(taker), { scheme: "ED25519", signature });
    const progress = store.settlementProgress(maker.orderId)!;
    // "Spot" sorts before "perp" by bytes, after it by locale collation.
    const instrument = (instrumentId: string, marketId: string) => ({
      instrumentId,
      domain: domainRef("svm:solana-devnet", 1, id(501)),
      adapter: adapterRef({ adapterId: "spot-adapter", adapterManifestVersion: 1, adapterManifestHash: id(502) }),
      venue: versionedManifestRef("spot-venue", 1, id(503)),
      market: versionedManifestRef(marketId, 1, id(504)),
      quantityAsset: assetRef("sol", id(505), 9),
      quoteAsset: assetRef("usdc", id(506), 6),
      legFamily: "SPOT_SWAP" as const,
      quantityIncrementAtoms: 10n,
      priceTickQuoteAtoms: 1n,
    });
    const policy: NettingPolicyManifestInput = {
      schemaVersion: 1,
      manifestVersion: 1,
      nettingPolicyVersion: 2,
      environment: "local",
      executionClassId: CLASS,
      executionClassVersion: 1,
      executionClassManifestHash: seriesExecutionClassHash(executionClass(), CLASS_SUPPORT),
      settlementClass: "ATOMIC_POSTCONDITION",
      allocationRule: "PRO_RATA_SEQUENCE",
      externalExecutionMode: "EXACT_NET_ONLY",
      clearingRule: "LIMIT_MIDPOINT_BUYER_FAVOR",
      maximumObligations: 4,
      maximumBatchWindowMilliseconds: 1_000n,
      instruments: [instrument("Spot", "sol-usdc"), instrument("perp", "sol-usdc-perp")],
    };
    const result = netObligations(["Spot", "perp"].map((instrumentId, index) => ({
      ownerId: maker.participantId,
      strategyOrderHash: settlement(maker).strategyOrderHash,
      packageOrderId: maker.orderId,
      settlementReadinessHash: progress.readinessHashHex,
      legId: `leg-${index}`,
      instrumentId,
      signedQuantityAtoms: index === 0 ? 10n : -10n,
      limitPriceTicks: index === 0 ? 12n : 8n,
      sequence: BigInt(index + 1),
    })), policy);
    const intents = ["perp", "Spot"].map((instrumentId) => nettingExternalExecutionIntent(result, policy, {
      instrumentId,
      validUntilUnit: "SOLANA_SLOT",
      validUntilValue: 2_000n,
      sourceFeeCaps: result.allocations
        .filter((allocation) => allocation.instrumentId === instrumentId)
        .map((allocation) => ({ obligationId: allocation.obligationId, maximumFeeQuoteAtoms: 2n })),
    }));
    const packages = [{
      packageOrderIdHex: maker.orderId as string,
      strategyOrderHashHex: settlement(maker).strategyOrderHash as string,
      settlementReadinessHashHex: progress.readinessHashHex,
    }];
    assert.throws(
      () => store.recordPreparedNettingBatch({ policy, result, externalIntents: intents.slice(0, 1), packages }),
      { code: "INVALID_INPUT" },
    );
    const { batch } = store.recordPreparedNettingBatch({ policy, result, externalIntents: intents, packages });
    assert.deepEqual(batch.externalExecutions.map((record) => record.intent.instrumentId), ["Spot", "perp"]);
  });
});

test("owner authorization and prepared netting evidence are immutable and replayable", () => {
  withStore((store) => {
    registerAll(store);
    const signature = bs58.encode(new Uint8Array(64).fill(7));
    const maker = order(1);
    const taker = order(2, { side: "BID", timeInForce: "IOC" });
    store.submitOrder(CLASS, maker, NOW, settlement(maker), { scheme: "ED25519", signature });
    store.submitOrder(CLASS, taker, NOW, settlement(taker), { scheme: "ED25519", signature });
    assert.equal(store.settlementAuthorization(maker.orderId)?.signature, signature);
    assert.throws(
      () => store.submitOrder(CLASS, taker, NOW, settlement(taker), {
        scheme: "ED25519",
        signature: bs58.encode(new Uint8Array(64).fill(8)),
      }),
      { code: "SETTLEMENT_AUTHORIZATION_CONFLICT" },
    );

    const instrument = {
      instrumentId: "sol-spot",
      domain: domainRef("svm:solana-devnet", 1, id(501)),
      adapter: adapterRef({ adapterId: "spot-adapter", adapterManifestVersion: 1, adapterManifestHash: id(502) }),
      venue: versionedManifestRef("spot-venue", 1, id(503)),
      market: versionedManifestRef("sol-usdc", 1, id(504)),
      quantityAsset: assetRef("sol", id(505), 9),
      quoteAsset: assetRef("usdc", id(506), 6),
      legFamily: "SPOT_SWAP" as const,
      quantityIncrementAtoms: 10n,
      priceTickQuoteAtoms: 1n,
    };
    const policy: NettingPolicyManifestInput = {
      schemaVersion: 1,
      manifestVersion: 1,
      nettingPolicyVersion: 2,
      environment: "local",
      executionClassId: CLASS,
      executionClassVersion: 1,
      executionClassManifestHash: seriesExecutionClassHash(executionClass(), CLASS_SUPPORT),
      settlementClass: "ATOMIC_POSTCONDITION",
      allocationRule: "PRO_RATA_SEQUENCE",
      externalExecutionMode: "EXACT_NET_ONLY",
      clearingRule: "LIMIT_MIDPOINT_BUYER_FAVOR",
      maximumObligations: 4,
      maximumBatchWindowMilliseconds: 1_000n,
      instruments: [instrument],
    };
    const makerProgress = store.settlementProgress(maker.orderId)!;
    const takerProgress = store.settlementProgress(taker.orderId)!;
    const result = netObligations([
      {
        ownerId: maker.participantId,
        strategyOrderHash: settlement(maker).strategyOrderHash,
        packageOrderId: maker.orderId,
        settlementReadinessHash: makerProgress.readinessHashHex,
        legId: "spot-buy",
        instrumentId: instrument.instrumentId,
        signedQuantityAtoms: 10n,
        limitPriceTicks: 12n,
        sequence: 1n,
      },
      {
        ownerId: taker.participantId,
        strategyOrderHash: settlement(taker).strategyOrderHash,
        packageOrderId: taker.orderId,
        settlementReadinessHash: takerProgress.readinessHashHex,
        legId: "spot-sell",
        instrumentId: instrument.instrumentId,
        signedQuantityAtoms: -10n,
        limitPriceTicks: 8n,
        sequence: 2n,
      },
    ], policy);
    const packages = [
      {
        packageOrderIdHex: maker.orderId as string,
        strategyOrderHashHex: settlement(maker).strategyOrderHash as string,
        settlementReadinessHashHex: makerProgress.readinessHashHex,
      },
      {
        packageOrderIdHex: taker.orderId as string,
        strategyOrderHashHex: settlement(taker).strategyOrderHash as string,
        settlementReadinessHashHex: takerProgress.readinessHashHex,
      },
    ];
    assert.deepEqual(
      store.authorizedNettingCandidates(CLASS).map((candidate) => candidate.packageOrderIdHex),
      [maker.orderId, taker.orderId],
    );
    const created = store.recordPreparedNettingBatch({ policy, result, externalIntents: [], packages });
    assert.equal(created.replayed, false);
    assert.equal(created.batch.status, "PREPARED");
    assert.equal(created.batch.result.underlyings[0]?.externalNetAtoms, 0n);
    assert.equal(created.batch.externalExecutionStatus, "NOT_REQUIRED");
    assert.ok(created.batch.finalAllocationReceipt);
    assert.equal(created.batch.settlementStatus, "AWAITING_SETTLEMENT");
    assert.equal(store.recordPreparedNettingBatch({ policy, result, externalIntents: [], packages }).replayed, true);
    assert.deepEqual(store.nettingBatch(created.batch.proofHashHex), created.batch);
    assert.deepEqual(store.nettingBatchForPackage(maker.orderId), created.batch);
    assert.deepEqual(store.nettingBatchForPackage(taker.orderId), created.batch);
    assert.equal(store.nettingBatchForPackage(id(999)), undefined);
    assert.deepEqual(store.authorizedNettingCandidates(CLASS), []);

    const orderByPackage = new Map([
      [toHex(commitmentHash(maker.orderId)), maker],
      [toHex(commitmentHash(taker.orderId)), taker],
    ]);
    const finalAllocationReceipt = created.batch.finalAllocationReceipt!;
    const executionAuthorizations = finalAllocationReceipt.allocations.map((allocation, index) => {
      const packageOrder = orderByPackage.get(toHex(allocation.packageOrderId))!;
      return nettingAllocationExecutionAuthorization({
        version: 1,
        finalAllocationReceiptHash: finalAllocationReceipt.receiptHash,
        allocationReceiptHash: allocation.allocationReceiptHash,
        settlementCommitmentHash: packageSettlementCommitmentHash(settlement(packageOrder)),
        executionPlanHash: id(520 + index),
        solverId: "solver",
        protocolFeeAtoms: 1n,
        solverFeeAtoms: 2n,
        nonce: BigInt(index + 1),
        validUntilUnit: "SOLANA_SLOT",
        validUntilValue: 1_900n,
      }, finalAllocationReceipt, result, policy, [], [], settlement(packageOrder));
    });
    assert.equal(store.recordNettingAllocationExecutionAuthorization(executionAuthorizations[0]!).replayed, false);
    assert.equal(store.recordNettingAllocationExecutionAuthorization(executionAuthorizations[0]!).replayed, true);
    assert.deepEqual(
      store.nettingAllocationExecutionAuthorization(executionAuthorizations[0]!.authorizationHash),
      executionAuthorizations[0],
    );
    const conflictingAuthorization = nettingAllocationExecutionAuthorization({
      ...executionAuthorizations[0]!,
      executionPlanHash: id(540),
    }, finalAllocationReceipt, result, policy, [], [], settlement(
      orderByPackage.get(toHex(executionAuthorizations[0]!.packageOrderId))!,
    ));
    assert.throws(
      () => store.recordNettingAllocationExecutionAuthorization(conflictingAuthorization),
      { code: "NETTING_EXECUTION_AUTHORIZATION_CONFLICT" },
    );
    assert.equal(store.recordNettingAllocationExecutionAuthorization(executionAuthorizations[1]!).replayed, false);
    assert.deepEqual(
      new Set(store.nettingAllocationExecutionAuthorizations(created.batch.proofHashHex)
        .map((authorization) => toHex(authorization.authorizationHash))),
      new Set(executionAuthorizations.map((authorization) => toHex(authorization.authorizationHash))),
    );
    const settlementEvidence = finalAllocationReceipt.allocations.map((allocation, index) => {
      const packageOrder = orderByPackage.get(toHex(allocation.packageOrderId))!;
      return nettingAllocationSettlementEvidence({
        version: 1,
        finalAllocationReceiptHash: finalAllocationReceipt.receiptHash,
        allocationReceiptHash: allocation.allocationReceiptHash,
        settlementAccount: settlement(packageOrder).settlementAccount,
        settledQuantityAtoms: allocation.totalQuantityAtoms,
        settledQuoteDeltaAtoms: allocation.totalQuoteDeltaAtoms,
        observedAtUnit: "SOLANA_SLOT",
        observedAtValue: 1_500n + BigInt(index),
        settlementReferenceHash: id(550 + index),
        authoritativeEvidenceHash: id(560 + index),
      }, finalAllocationReceipt, result, policy, [], []);
    });
    const wrongAccountEvidence = nettingAllocationSettlementEvidence({
      ...settlementEvidence[0]!,
      settlementAccount: "another-account",
    }, finalAllocationReceipt, result, policy, [], []);
    assert.throws(
      () => store.recordVerifiedNettingAllocationSettlementEvidence(wrongAccountEvidence),
      { code: "NETTING_SETTLEMENT_ACCOUNT_MISMATCH" },
    );
    const observations = settlementEvidence.map((evidence, index) => ({
      authorizationHash: executionAuthorizations[index]!.authorizationHash,
      observedAtUnit: evidence.observedAtUnit,
      observedAtValue: evidence.observedAtValue,
      settlementReferenceHash: evidence.settlementReferenceHash,
      authoritativeEvidenceHash: evidence.authoritativeEvidenceHash,
    }));
    assert.equal(store.recordNettingAllocationExecutionObservation(observations[0]!).replayed, false);
    assert.equal(store.nettingBatch(created.batch.proofHashHex)?.settlementStatus, "AWAITING_SETTLEMENT");
    assert.equal(store.recordNettingAllocationExecutionObservation(observations[0]!).replayed, true);
    assert.equal(store.recordNettingAllocationExecutionObservation(observations[1]!).replayed, false);
    const settledBatch = store.nettingBatch(created.batch.proofHashHex);
    assert.equal(settledBatch?.settlementStatus, "SETTLED");
    assert.equal(settledBatch?.settlementEvidence.length, 2);
    assert.ok(settledBatch?.settlementCompletionReceipt);

    const secondMaker = order(3);
    const secondTaker = order(4, { side: "BID", timeInForce: "IOC" });
    store.submitOrder(CLASS, secondMaker, NOW, settlement(secondMaker), { scheme: "ED25519", signature });
    store.submitOrder(CLASS, secondTaker, NOW, settlement(secondTaker), { scheme: "ED25519", signature });
    const secondProgress = store.settlementProgress(secondMaker.orderId)!;
    const residual = netObligations([{
      ownerId: secondMaker.participantId,
      strategyOrderHash: settlement(secondMaker).strategyOrderHash,
      packageOrderId: secondMaker.orderId,
      settlementReadinessHash: secondProgress.readinessHashHex,
      legId: "spot-buy",
      instrumentId: instrument.instrumentId,
      signedQuantityAtoms: 10n,
      limitPriceTicks: 12n,
      sequence: 1n,
    }], policy);
    const intent = nettingExternalExecutionIntent(residual, policy, {
      instrumentId: instrument.instrumentId,
      validUntilUnit: "SOLANA_SLOT",
      validUntilValue: 2_000n,
      sourceFeeCaps: [{
        obligationId: residual.allocations[0]!.obligationId,
        maximumFeeQuoteAtoms: 2n,
      }],
    });
    const residualPackage = [{
      packageOrderIdHex: secondMaker.orderId as string,
      strategyOrderHashHex: settlement(secondMaker).strategyOrderHash as string,
      settlementReadinessHashHex: secondProgress.readinessHashHex,
    }];
    const residualBatch = store.recordPreparedNettingBatch({
      policy,
      result: residual,
      externalIntents: [intent],
      packages: residualPackage,
    }).batch;
    assert.equal(residualBatch.externalExecutionStatus, "PENDING");
    const evidence = nettingExternalExecutionEvidence({
      version: 1,
      intentHash: intent.intentHash,
      outcome: "EXACT_FILLED",
      filledSignedQuantityAtoms: 10n,
      grossQuoteAtoms: 12n,
      feeQuoteAtoms: 1n,
      submittedAtUnit: "SOLANA_SLOT",
      submittedAtValue: 1_999n,
      observedAtUnit: "SOLANA_SLOT",
      observedAtValue: 2_001n,
      executionReferenceHash: id(601),
      authoritativeEvidenceHash: id(602),
    }, intent);
    assert.equal(store.recordVerifiedNettingExternalExecutionEvidence(evidence).replayed, false);
    assert.equal(store.recordVerifiedNettingExternalExecutionEvidence(evidence).replayed, true);
    const finalized = store.nettingBatch(residual.proofHash);
    assert.equal(finalized?.externalExecutionStatus, "EXACT_FILLED");
    assert.ok(finalized?.finalAllocationReceipt);
  });
});

test("cross-batch clearing durably settles source batches without direct double execution", () => {
  withStore((store, path) => {
    registerAll(store);
    const signature = bs58.encode(new Uint8Array(64).fill(9));
    const instrument = {
      instrumentId: "sol-spot",
      domain: domainRef("svm:solana-devnet", 1, id(701)),
      adapter: adapterRef({ adapterId: "spot-adapter", adapterManifestVersion: 1, adapterManifestHash: id(702) }),
      venue: versionedManifestRef("spot-venue", 1, id(703)),
      market: versionedManifestRef("sol-usdc", 1, id(704)),
      quantityAsset: assetRef("sol", id(705), 9),
      quoteAsset: assetRef("usdc", id(706), 6),
      legFamily: "SPOT_SWAP" as const,
      quantityIncrementAtoms: 10n,
      priceTickQuoteAtoms: 1n,
    };
    const policy: NettingPolicyManifestInput = {
      schemaVersion: 1,
      manifestVersion: 1,
      nettingPolicyVersion: 2,
      environment: "local",
      executionClassId: CLASS,
      executionClassVersion: 1,
      executionClassManifestHash: seriesExecutionClassHash(executionClass(), CLASS_SUPPORT),
      settlementClass: "ATOMIC_POSTCONDITION",
      allocationRule: "PRO_RATA_SEQUENCE",
      externalExecutionMode: "EXACT_NET_ONLY",
      clearingRule: "LIMIT_MIDPOINT_BUYER_FAVOR",
      maximumObligations: 4,
      maximumBatchWindowMilliseconds: 1_000n,
      instruments: [instrument],
    };
    const selected = [5, 7, 9].map((orderId) => {
      const maker = order(orderId);
      const taker = order(orderId + 1, { side: "BID", timeInForce: "IOC" });
      store.submitOrder(CLASS, maker, NOW, settlement(maker), { scheme: "ED25519", signature });
      store.submitOrder(CLASS, taker, NOW, settlement(taker), { scheme: "ED25519", signature });
      return { maker, progress: store.settlementProgress(maker.orderId)! };
    });
    const signedQuantities = [10n, 10n, -10n];
    const limits = [12n, 12n, 8n];
    const prepared = selected.map(({ maker, progress }, index) => {
      const result = netObligations([{
        ownerId: maker.participantId,
        strategyOrderHash: settlement(maker).strategyOrderHash,
        packageOrderId: maker.orderId,
        settlementReadinessHash: progress.readinessHashHex,
        legId: `spot-${index}`,
        instrumentId: instrument.instrumentId,
        signedQuantityAtoms: signedQuantities[index]!,
        limitPriceTicks: limits[index]!,
        sequence: BigInt(index + 1),
      }], policy);
      const intent = nettingExternalExecutionIntent(result, policy, {
        instrumentId: instrument.instrumentId,
        validUntilUnit: "SOLANA_SLOT",
        validUntilValue: 2_000n,
        sourceFeeCaps: [{
          obligationId: result.allocations[0]!.obligationId,
          maximumFeeQuoteAtoms: 2n,
        }],
      });
      const batch = store.recordPreparedNettingBatch({
        policy,
        result,
        externalIntents: [intent],
        packages: [{
          packageOrderIdHex: maker.orderId as string,
          strategyOrderHashHex: settlement(maker).strategyOrderHash as string,
          settlementReadinessHashHex: progress.readinessHashHex,
        }],
      }).batch;
      return { result, intent, batch };
    });
    const clearingPolicy = {
      version: 1,
      policyId: "solana-devnet-cross-batch-v1",
      domain: instrument.domain,
      adapter: instrument.adapter,
      expiryUnit: "SOLANA_SLOT" as const,
      maximumSourceIntents: 8,
      maximumSourceBatches: 8,
      maximumExpirySpread: 10n,
    };
    assert.equal(store.pendingCrossBatchSourceIntents(clearingPolicy).length, 3);
    const unixSources = prepared.map(({ intent }) => {
      const source = { ...intent, validUntilUnit: "HYPERLIQUID_UNIX_MILLISECONDS" as const, validUntilValue: 2_000n };
      return { ...source, intentHash: nettingExternalExecutionIntentHash(source) };
    });
    const unixPort = {
      pendingCrossBatchClearing: () => undefined,
      pendingCrossBatchSourceIntents: () => unixSources,
      recordPreparedCrossBatchClearing: (): never => { throw new Error("selected live sources"); },
    };
    const unixPolicy = { ...clearingPolicy, expiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS" as const };
    assert.throws(() => prepareNextAuthoritativeCrossBatchClearing(unixPort, unixPolicy, 1_999), /selected live sources/);
    assert.equal(prepareNextAuthoritativeCrossBatchClearing(unixPort, unixPolicy, 2_000).status, "IDLE");
    assert.throws(() => prepareNextAuthoritativeCrossBatchClearing(store, clearingPolicy, -1));
    const next = prepareNextAuthoritativeCrossBatchClearing(store, clearingPolicy);
    assert.equal(next.status, "PREPARED");
    if (next.status !== "PREPARED") throw new Error("cross-batch clearing was not prepared");
    const created = next;
    assert.equal(created.replayed, false);
    assert.equal(created.clearing.status, "PENDING");
    assert.ok(created.clearing.intent);
    const reopened = new SqlitePackageExchangeStore(path, { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
    try {
      const resumed = prepareNextAuthoritativeCrossBatchClearing(reopened, clearingPolicy);
      assert.equal(resumed.status, "PREPARED");
      if (resumed.status !== "PREPARED") assert.fail("Pending clearing was lost across a new store instance.");
      assert.equal(resumed.replayed, true);
      assert.equal(toHex(resumed.clearing.plan.planHash), toHex(created.clearing.plan.planHash));
      assert.equal(reopened.pendingCrossBatchClearing({ ...clearingPolicy, policyId: "another-policy" }), undefined);
    } finally {
      reopened.close();
    }
    for (const { batch } of prepared) {
      const pooled = store.nettingBatch(batch.result.proofHash)!;
      assert.equal(pooled.externalExecutionStatus, "PENDING");
      assert.equal(pooled.externalExecutions[0]!.crossBatchClearingPlanHashHex, toHex(created.clearing.plan.planHash));
    }
    const directEvidence = nettingExternalExecutionEvidence({
      version: 1,
      intentHash: prepared[0]!.intent.intentHash,
      outcome: "EXACT_FILLED",
      filledSignedQuantityAtoms: 10n,
      grossQuoteAtoms: 12n,
      feeQuoteAtoms: 1n,
      submittedAtUnit: "SOLANA_SLOT",
      submittedAtValue: 1_999n,
      observedAtUnit: "SOLANA_SLOT",
      observedAtValue: 2_001n,
      executionReferenceHash: id(710),
      authoritativeEvidenceHash: id(711),
    }, prepared[0]!.intent);
    assert.throws(
      () => store.recordVerifiedNettingExternalExecutionEvidence(directEvidence),
      { code: "NETTING_INTENT_POOLED" },
    );
    const pooledIntent = created.clearing.intent!;
    const evidence = crossBatchExternalExecutionEvidence({
      version: 1,
      intentHash: pooledIntent.intentHash,
      outcome: "EXACT_FILLED",
      filledSignedQuantityAtoms: 10n,
      grossQuoteAtoms: 12n,
      feeQuoteAtoms: 1n,
      submittedAtUnit: "SOLANA_SLOT",
      submittedAtValue: 1_999n,
      observedAtUnit: "SOLANA_SLOT",
      observedAtValue: 2_001n,
      executionReferenceHash: id(712),
      authoritativeEvidenceHash: id(713),
    }, pooledIntent);
    assert.equal(store.recordVerifiedCrossBatchExternalExecutionEvidence(evidence).replayed, false);
    assert.equal(store.recordVerifiedCrossBatchExternalExecutionEvidence(evidence).replayed, true);
    const clearing = store.crossBatchClearing(created.clearing.plan.planHash)!;
    assert.equal(clearing.status, "EXACT_FILLED");
    assert.equal(store.pendingCrossBatchClearing(clearingPolicy), undefined);
    assert.equal(prepareNextAuthoritativeCrossBatchClearing(store, clearingPolicy).status, "IDLE");
    const recentClearings = store.recentCrossBatchClearings(1);
    assert.equal(recentClearings.length, 1);
    assert.equal(toHex(recentClearings[0]!.plan.planHash), toHex(clearing.plan.planHash));
    assert.throws(() => store.recentCrossBatchClearings(0), { code: "INVALID_INPUT" });
    for (const { batch } of prepared) {
      const settled = store.nettingBatch(batch.result.proofHash)!;
      assert.equal(settled.externalExecutionStatus, "EXACT_FILLED");
      assert.ok(settled.finalAllocationReceipt);
    }
    const firstBatch = store.nettingBatch(prepared[0]!.result.proofHash)!;
    const firstAllocation = firstBatch.finalAllocationReceipt!.allocations[0]!;
    const firstSettlement = settlement(selected[0]!.maker);
    const authorization = nettingAllocationExecutionAuthorization({
      version: 1,
      finalAllocationReceiptHash: firstBatch.finalAllocationReceipt!.receiptHash,
      allocationReceiptHash: firstAllocation.allocationReceiptHash,
      settlementCommitmentHash: packageSettlementCommitmentHash(firstSettlement),
      executionPlanHash: id(714),
      solverId: "solver",
      protocolFeeAtoms: 1n,
      solverFeeAtoms: 1n,
      nonce: 1n,
      validUntilUnit: "SOLANA_SLOT",
      validUntilValue: 1_900n,
    }, firstBatch.finalAllocationReceipt!, prepared[0]!.result, policy, [prepared[0]!.intent], [], firstSettlement, [{
      policy: clearing.policy,
      sourceIntents: clearing.sourceIntents,
      plan: clearing.plan,
      intent: clearing.intent!,
      evidence: clearing.evidence!,
      receipt: clearing.receipt!,
    }]);
    store.recordNettingAllocationExecutionAuthorization(authorization);
    store.recordNettingAllocationExecutionObservation({
      authorizationHash: authorization.authorizationHash,
      observedAtUnit: "SOLANA_SLOT",
      observedAtValue: 1_850n,
      settlementReferenceHash: id(715),
      authoritativeEvidenceHash: id(716),
    });
    assert.equal(store.nettingBatch(prepared[0]!.result.proofHash)?.settlementStatus, "SETTLED");
  });
});

test("a residual claimed for direct execution is never pooled, and a pooled one is never claimed", () => {
  withStore((store) => {
    registerAll(store);
    const signature = bs58.encode(new Uint8Array(64).fill(9));
    const instrument = {
      instrumentId: "sol-spot",
      domain: domainRef("svm:solana-devnet", 1, id(801)),
      adapter: adapterRef({ adapterId: "spot-adapter", adapterManifestVersion: 1, adapterManifestHash: id(802) }),
      venue: versionedManifestRef("spot-venue", 1, id(803)),
      market: versionedManifestRef("sol-usdc", 1, id(804)),
      quantityAsset: assetRef("sol", id(805), 9),
      quoteAsset: assetRef("usdc", id(806), 6),
      legFamily: "SPOT_SWAP" as const,
      quantityIncrementAtoms: 10n,
      priceTickQuoteAtoms: 1n,
    };
    const policy: NettingPolicyManifestInput = {
      schemaVersion: 1,
      manifestVersion: 1,
      nettingPolicyVersion: 2,
      environment: "local",
      executionClassId: CLASS,
      executionClassVersion: 1,
      executionClassManifestHash: seriesExecutionClassHash(executionClass(), CLASS_SUPPORT),
      settlementClass: "ATOMIC_POSTCONDITION",
      allocationRule: "PRO_RATA_SEQUENCE",
      externalExecutionMode: "EXACT_NET_ONLY",
      clearingRule: "LIMIT_MIDPOINT_BUYER_FAVOR",
      maximumObligations: 4,
      maximumBatchWindowMilliseconds: 1_000n,
      instruments: [instrument],
    };
    const intents = [[5, 10n, 12n], [7, 10n, 12n], [9, -10n, 8n]].map(([orderId, quantity, limit], index) => {
      const maker = order(orderId as number);
      const taker = order((orderId as number) + 1, { side: "BID", timeInForce: "IOC" });
      store.submitOrder(CLASS, maker, NOW, settlement(maker), { scheme: "ED25519", signature });
      store.submitOrder(CLASS, taker, NOW, settlement(taker), { scheme: "ED25519", signature });
      const progress = store.settlementProgress(maker.orderId)!;
      const result = netObligations([{
        ownerId: maker.participantId,
        strategyOrderHash: settlement(maker).strategyOrderHash,
        packageOrderId: maker.orderId,
        settlementReadinessHash: progress.readinessHashHex,
        legId: `spot-${index}`,
        instrumentId: instrument.instrumentId,
        signedQuantityAtoms: quantity as bigint,
        limitPriceTicks: limit as bigint,
        sequence: BigInt(index + 1),
      }], policy);
      const intent = nettingExternalExecutionIntent(result, policy, {
        instrumentId: instrument.instrumentId,
        validUntilUnit: "SOLANA_SLOT",
        validUntilValue: 2_000n,
        sourceFeeCaps: [{ obligationId: result.allocations[0]!.obligationId, maximumFeeQuoteAtoms: 2n }],
      });
      store.recordPreparedNettingBatch({
        policy,
        result,
        externalIntents: [intent],
        packages: [{
          packageOrderIdHex: maker.orderId as string,
          strategyOrderHashHex: settlement(maker).strategyOrderHash as string,
          settlementReadinessHashHex: progress.readinessHashHex,
        }],
      });
      return intent;
    });
    const clearingPolicy = {
      version: 1,
      policyId: "solana-devnet-cross-batch-v1",
      domain: instrument.domain,
      adapter: instrument.adapter,
      expiryUnit: "SOLANA_SLOT" as const,
      maximumSourceIntents: 8,
      maximumSourceBatches: 8,
      maximumExpirySpread: 10n,
    };
    store.claimNettingExternalExecution(intents[0]!.intentHash);
    store.claimNettingExternalExecution(intents[0]!.intentHash);
    assert.deepEqual(
      store.pendingCrossBatchSourceIntents(clearingPolicy).map((intent) => toHex(intent.intentHash)),
      [intents[1]!, intents[2]!].map((intent) => toHex(intent.intentHash)),
    );
    assert.throws(
      () => store.recordPreparedCrossBatchClearing({
        policy: clearingPolicy,
        sourceIntentHashes: [intents[0]!.intentHash, intents[2]!.intentHash],
      }),
      { code: "NETTING_INTENT_ALREADY_EXECUTED" },
    );
    const pooled = store.recordPreparedCrossBatchClearing({
      policy: clearingPolicy,
      sourceIntentHashes: [intents[1]!.intentHash, intents[2]!.intentHash],
    });
    assert.equal(pooled.replayed, false);
    assert.throws(() => store.claimNettingExternalExecution(intents[1]!.intentHash), { code: "NETTING_INTENT_POOLED" });
  });
});

test("GTC orders expire with their signed settlement lease", () => {
  withStore((store) => {
    registerAll(store);
    const maker = order(1, { timeInForce: "GTC" });
    const accepted = store.submitOrder(CLASS, maker, NOW, settlement(maker));
    assert.equal(accepted.accepted, true);
    assert.equal(store.getBook(CLASS)?.entries[0]?.expiresAtValue, maker.settlementLeaseUntilValue);

    const mismatched = order(2, { timeInForce: "GTC" });
    assert.throws(
      () => store.submitOrder(CLASS, mismatched, NOW, settlement(mismatched, { validUntilValue: 1_999n })),
      { code: "SETTLEMENT_MISMATCH" },
    );

    const afterLease = order(3, { side: "BID", timeInForce: "IOC" });
    const result = store.submitOrder(CLASS, afterLease, 2_000n, settlement(afterLease, { validUntilValue: 2_001n }));
    assert.deepEqual(result, { accepted: false, rejection: "MINIMUM_QUANTITY_UNFILLABLE" });
    assert.equal(store.getBook(CLASS)?.entries.length, 0);
  });
});

test("halted books queue settlement-backed orders and clear them at one reopening price", () => {
  withStore((store) => {
    registerAll(store);
    const policy = packageMatchingPolicy(POLICY);
    const open = store.getBook(CLASS)!;
    const halt = {
      version: 1,
      executionClassId: CLASS,
      expectedOpenSnapshotHash: packageReopeningSnapshotHash(policy, open),
      incidentEvidenceHash: id(700),
      reasonCode: "oracle-divergence",
    } as const;
    assert.equal(store.haltBook(halt).replayed, false);
    assert.equal(store.haltBook(halt).replayed, true);
    assert.throws(
      () => store.haltBook({ ...halt, incidentEvidenceHash: id(701) }),
      { code: "INVALID_INPUT" },
    );
    const ask = order(1, { side: "ASK", limitPriceTicks: 95n });
    const bid = order(2, { side: "BID", limitPriceTicks: 105n });
    assert.equal(store.queueReopeningOrder(CLASS, ask, NOW, settlement(ask)).replayed, false);
    assert.equal(store.queueReopeningOrder(CLASS, bid, NOW, settlement(bid)).replayed, false);
    assert.equal(store.queueReopeningOrder(CLASS, bid, NOW, settlement(bid)).replayed, true);

    const opening = store.getBook(CLASS)!;
    const openingSnapshotHash = packageReopeningSnapshotHash(policy, opening);
    const cleared = store.clearReopeningAuction(CLASS, id(800), openingSnapshotHash, id(900), 100n, NOW);

    assert.equal(cleared.replayed, false);
    assert.equal(cleared.result.clearingPriceTicks, 100n);
    assert.equal(cleared.result.executedQuantity, 10n);
    assert.equal(cleared.settlementHandoff?.fills.length, 1);
    assert.equal(store.getBook(CLASS)?.halted, false);
    assert.equal(store.getBook(CLASS)?.entries.length, 0);
    for (const [packageOrder, role] of [[ask, "ASK"], [bid, "BID"]] as const) {
      const progress = store.settlementProgress(packageOrder.orderId)!;
      assert.equal(progress.readiness.status, "READY_FOR_OWNER_AUTHORIZATION");
      assert.deepEqual(
        progress.readiness.evidenceRefs.map((reference) => reference.kind),
        ["REOPENING_RESULT"],
      );
      assert.equal(progress.obligations[0]?.role, role);
      assert.equal(progress.obligations[0]?.liquiditySource, "DIRECT");
    }
    assert.equal(
      store.clearReopeningAuction(CLASS, id(800), openingSnapshotHash, id(900), 100n, NOW).replayed,
      true,
    );
  });
});

test("partial settlement obligations require new authorization after the order closes", () => {
  withStore((store) => {
    registerAll(store);
    const maker = order(1, { quantity: 30n });
    store.submitOrder(CLASS, maker, NOW, settlement(maker));
    const taker = order(2, { side: "BID", timeInForce: "IOC" });
    store.submitOrder(CLASS, taker, NOW, settlement(taker));

    let progress = store.settlementProgress(maker.orderId);
    assert.equal(progress?.readiness.status, "PARTIALLY_ALLOCATED");
    assert.deepEqual(
      [progress?.readiness.allocatedQuantity, progress?.readiness.remainingQuantity, progress?.readiness.acceptsFurtherMatches],
      [10n, 20n, true],
    );

    store.cancelEntry(CLASS, maker.orderId, maker.participantId);
    progress = store.settlementProgress(maker.orderId);
    assert.equal(progress?.readiness.status, "PARTIAL_AUTHORIZATION_REQUIRED");
    assert.deepEqual(
      [progress?.readiness.allocatedQuantity, progress?.readiness.remainingQuantity, progress?.readiness.acceptsFurtherMatches],
      [10n, 20n, false],
    );

    const untouched = order(3, { limitPriceTicks: 110n });
    store.submitOrder(CLASS, untouched, NOW, settlement(untouched));
    store.cancelEntry(CLASS, untouched.orderId, untouched.participantId);
    assert.equal(store.settlementProgress(untouched.orderId)?.readiness.status, "CANCELLED_UNFILLED");
  });
});

test("orders that left the book keep their side and limit price, and older stores recover them once", () => {
  withStore((store, path) => {
    registerAll(store);
    const policy = packageMatchingPolicy(POLICY);
    const alice = { participantId: "alice", commonControlGroupId: "group-alice" };
    store.haltBook({
      version: 1,
      executionClassId: CLASS,
      expectedOpenSnapshotHash: packageReopeningSnapshotHash(policy, store.getBook(CLASS)!),
      incidentEvidenceHash: id(703),
      reasonCode: "test-incident",
    });
    const reopeningAsk = order(1, { ...alice, limitPriceTicks: 95n });
    const reopeningBid = order(2, { side: "BID", limitPriceTicks: 105n });
    const reopeningCancelled = order(3, { ...alice, limitPriceTicks: 120n });
    for (const value of [reopeningAsk, reopeningBid, reopeningCancelled]) {
      store.queueReopeningOrder(CLASS, value, NOW, settlement(value));
    }
    store.clearReopeningAuction(CLASS, id(803), packageReopeningSnapshotHash(policy, store.getBook(CLASS)!), id(903), 100n, NOW);
    store.cancelEntry(CLASS, reopeningCancelled.orderId, "alice");
    const filled = order(4, alice);
    const cancelled = order(6, { ...alice, limitPriceTicks: 110n });
    const expired = order(7, { ...alice, limitPriceTicks: 115n, expiresAtValue: 1_500n });
    for (const value of [filled, cancelled, expired]) store.submitOrder(CLASS, value, NOW, settlement(value));
    const taker = order(5, { side: "BID", timeInForce: "IOC" });
    store.submitOrder(CLASS, taker, NOW, settlement(taker));
    store.cancelEntry(CLASS, cancelled.orderId, "alice");
    const sweep = order(8, { side: "BID", timeInForce: "IOC", limitPriceTicks: 90n });
    store.submitOrder(CLASS, sweep, 1_600n, settlement(sweep));
    assert.equal(store.getBook(CLASS)?.entries.length, 0);

    const terms = (listed: ReturnType<typeof store.participantOrders>) =>
      new Map(listed.map((entry) => [entry.packageOrderIdHex, [entry.state, entry.side, entry.priceTicks]]));
    assert.deepEqual(terms(store.participantOrders("alice", 1_600n)), new Map([
      [id(1), ["FILLED", "ASK", 95n]],
      [id(3), ["CANCELLED", "ASK", 120n]],
      [id(4), ["FILLED", "ASK", 100n]],
      [id(6), ["CANCELLED", "ASK", 110n]],
      [id(7), ["CLOSED", "ASK", 115n]],
    ]));
    const raw = new Database(path);
    try {
      raw.exec("DROP TABLE package_book_order_terms");
    } finally {
      raw.close();
    }
    const reopened = new SqlitePackageExchangeStore(path, { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
    try {
      // Continuous orders recover their terms from their own allocation; a reopening order that already
      // left the book keeps only the side its fill proves.
      assert.deepEqual(terms(reopened.participantOrders("alice", 1_600n)), new Map([
        [id(1), ["FILLED", "ASK", null]],
        [id(3), ["CANCELLED", null, null]],
        [id(4), ["FILLED", "ASK", 100n]],
        [id(6), ["CANCELLED", "ASK", 110n]],
        [id(7), ["CLOSED", "ASK", 115n]],
      ]));
    } finally {
      reopened.close();
    }
  });
});

test("only filled allocations are trades, and a store opened before trades were indexed indexes them once", () => {
  withStore((store, path) => {
    registerAll(store);
    const firstMaker = order(1);
    const firstTaker = order(2, { side: "BID", timeInForce: "IOC" });
    const secondMaker = order(3);
    store.submitOrder(CLASS, firstMaker, NOW, settlement(firstMaker));
    store.submitOrder(CLASS, firstTaker, NOW, settlement(firstTaker));
    store.submitOrder(CLASS, secondMaker, NOW, settlement(secondMaker));
    const tape = store.allocationTape(CLASS, 0, 10);
    assert.deepEqual(tape.map((entry) => entry.cursor), [2]);
    assert.equal(store.latestTrade(CLASS)?.cursor, 2);
    const raw = new Database(path);
    try {
      raw.exec("DROP TABLE package_book_trades");
    } finally {
      raw.close();
    }
    const reopened = new SqlitePackageExchangeStore(path, { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
    try {
      assert.deepEqual(reopened.allocationTape(CLASS, 0, 10).map((entry) => entry.allocationHashHex), tape.map((entry) => entry.allocationHashHex));
      assert.equal(reopened.latestTrade(CLASS)?.allocationHashHex, tape[0]?.allocationHashHex);
    } finally {
      reopened.close();
    }
  });
});

test("a consumed source reservation cannot back new implied liquidity", () => {
  withStore((store) => {
    registerAll(store);
    store.addImpliedLiquidity(CLASS, { quote: impliedAsk(1, 1, 501), participantId: "solver-a", commonControlGroupId: "solver", nowValue: NOW });
    const taker = order(9, { side: "BID", quantity: 20n, timeInForce: "IOC" });
    const fill = store.submitOrder(CLASS, taker, NOW, settlement(taker));
    assert.equal(fill.accepted && fill.allocation.externalImpliedQuantity, 20n);
    assert.throws(
      () => store.addImpliedLiquidity(CLASS, { quote: impliedAsk(2, 2, 501), participantId: "solver-a", commonControlGroupId: "solver", nowValue: NOW }),
      { code: "SOURCE_ALREADY_CONSUMED" },
    );
  });
});

test("a newer source version invalidates stale implied liquidity and blocks its return", () => {
  withStore((store) => {
    registerAll(store);
    const quote = impliedAsk(1, 1, 501);
    store.addImpliedLiquidity(CLASS, { quote, participantId: "solver-a", commonControlGroupId: "solver", nowValue: NOW });
    assert.deepEqual(store.observeSourceVersion("spot-1", 2n).map(toHex), [toHex(quote.entryId)]);
    assert.equal(store.getBook(CLASS)?.entries.length, 0);
    assert.throws(
      () => store.addImpliedLiquidity(CLASS, { quote, participantId: "solver-a", commonControlGroupId: "solver", nowValue: NOW }),
      { code: "STALE_SOURCE" },
    );
    assert.throws(() => store.observeSourceVersion("spot-1", 1n), { code: "STALE_SOURCE" });
  });
});

test("cancellation authority, halts, and amendments persist", () => {
  withStore((store) => {
    registerAll(store);
    const maker = order(1, { quantity: 30n });
    store.submitOrder(CLASS, maker, NOW, settlement(maker));
    assert.throws(() => store.cancelEntry(CLASS, id(1), "intruder"), { code: "INVALID_INPUT" });
    const amendment = {
      version: 1,
      executionClassId: CLASS,
      entryId: id(1),
      participantId: "maker-1",
      expectedQuantity: 30n,
      expectedPriceTicks: 100n,
      quantity: 20n,
    } as const;
    assert.equal(store.amendEntry(amendment).replayed, false);
    assert.equal(store.amendEntry(amendment).replayed, true);
    assert.equal(store.getBook(CLASS)?.entries[0]?.quantity, 20n);
    assert.throws(() => store.amendEntry({ ...amendment, quantity: 10n }), { code: "INVALID_INPUT" });
    assert.throws(() => store.amendEntry({
      ...amendment,
      expectedQuantity: 20n,
      quantity: 40n,
    }), { code: "INVALID_INPUT" });
    const policy = packageMatchingPolicy(POLICY);
    const open = store.getBook(CLASS)!;
    store.haltBook({
      version: 1,
      executionClassId: CLASS,
      expectedOpenSnapshotHash: packageReopeningSnapshotHash(policy, open),
      incidentEvidenceHash: id(702),
      reasonCode: "test-incident",
    });
    const blocked = order(2, { side: "BID" });
    assert.deepEqual(store.submitOrder(CLASS, blocked, NOW, settlement(blocked)), { accepted: false, rejection: "HALTED" });
    const halted = store.getBook(CLASS)!;
    store.clearReopeningAuction(
      CLASS,
      id(802),
      packageReopeningSnapshotHash(policy, halted),
      id(902),
      100n,
      NOW,
    );
    const cancellation = store.cancelEntry(CLASS, id(1), "maker-1");
    assert.equal(cancellation.replayed, false);
    assert.equal(store.cancelEntry(CLASS, id(1), "maker-1").replayed, true);
    assert.equal(store.getBook(CLASS)?.entries.length, 0);

    const partialMaker = order(3, { quantity: 30n });
    const partialTaker = order(4, { side: "BID", timeInForce: "IOC" });
    store.submitOrder(CLASS, partialMaker, NOW, settlement(partialMaker));
    store.submitOrder(CLASS, partialTaker, NOW, settlement(partialTaker));
    assert.equal(store.getBook(CLASS)?.entries[0]?.quantity, 20n);
    assert.throws(() => store.amendEntry({
      version: 1,
      executionClassId: CLASS,
      entryId: partialMaker.orderId,
      participantId: partialMaker.participantId,
      expectedQuantity: 20n,
      expectedPriceTicks: partialMaker.limitPriceTicks,
      quantity: 30n,
    }), { code: "INVALID_INPUT" });
  });
});

test("tampered stored state fails closed", () => {
  withStore((store, path) => {
    registerAll(store);
    const maker = order(1);
    store.submitOrder(CLASS, maker, NOW, settlement(maker));
    const raw = new Database(path);
    try {
      raw.prepare("UPDATE package_book_entries SET entry_json = replace(entry_json, '\"10\"', '\"15\"')").run();
      assert.throws(() => raw.prepare("DELETE FROM exchange_documents").run(), /immutable/);
    } finally {
      raw.close();
    }
    assert.throws(() => store.getBook(CLASS), (error: unknown) => error instanceof PackageExchangeStoreError && error.code === "CORRUPT_ROW");
  });
});

test("database paths must be absolute and outside the repository", () => {
  const options = { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT };
  assert.throws(() => new SqlitePackageExchangeStore(":memory:", options), { code: "INVALID_PATH" });
  assert.throws(() => new SqlitePackageExchangeStore("relative.sqlite", options), { code: "INVALID_PATH" });
  assert.throws(() => new SqlitePackageExchangeStore(join(process.cwd(), "exchange.sqlite"), options), { code: "INVALID_PATH" });
});

test("one participant cannot grow a book past its entry cap, but can always cancel", () => {
  withStore((store) => {
    registerAll(store);
    const resting = (n: number) => order(n, { participantId: "flooder", commonControlGroupId: "flood", limitPriceTicks: 100n + BigInt(n) });
    for (let n = 1; n <= MAX_ENTRIES_PER_PARTICIPANT; n += 1) {
      const packageOrder = resting(n);
      const result = store.submitOrder(CLASS, packageOrder, NOW, settlement(packageOrder));
      assert.equal(result.accepted, true);
    }
    const overflow = resting(MAX_ENTRIES_PER_PARTICIPANT + 1);
    assert.throws(() => store.submitOrder(CLASS, overflow, NOW, settlement(overflow)), { code: "PARTICIPANT_BOOK_LIMIT" });
    assert.equal(store.getBook(CLASS)?.entries.length, MAX_ENTRIES_PER_PARTICIPANT);
    store.cancelEntry(CLASS, id(1), "flooder");
    assert.equal(store.getBook(CLASS)?.entries.length, MAX_ENTRIES_PER_PARTICIPANT - 1);
    const replacement = order(9_999, { limitPriceTicks: 100n });
    assert.equal(store.submitOrder(CLASS, replacement, NOW, settlement(replacement)).accepted, true);
  });
});

test("a participant's package-book orders list every resting order and the recent closed ones with their state", () => {
  withStore((store) => {
    registerAll(store);
    const alice = { participantId: "alice", commonControlGroupId: "group-alice" };
    const resting = order(1, { ...alice, quantity: 30n });
    const cancelled = order(2, { ...alice, limitPriceTicks: 105n });
    const expiring = order(3, { ...alice, limitPriceTicks: 110n, expiresAtValue: 1_500n });
    for (const value of [resting, cancelled, expiring]) store.submitOrder(CLASS, value, NOW, settlement(value));
    const taker = order(4, { side: "BID", timeInForce: "IOC", participantId: "bob", commonControlGroupId: "group-bob" });
    store.submitOrder(CLASS, taker, NOW, settlement(taker));
    store.cancelEntry(CLASS, cancelled.orderId, "alice");

    const listed = store.participantOrders("alice", 1_600n);
    const byId = new Map(listed.map((entry) => [entry.packageOrderIdHex, entry]));
    assert.deepEqual(
      [byId.get(id(1))?.state, byId.get(id(1))?.filledQuantity, byId.get(id(1))?.remainingQuantity, byId.get(id(1))?.priceTicks],
      ["OPEN", 10n, 20n, 100n],
    );
    assert.equal(byId.get(id(2))?.state, "CANCELLED");
    assert.deepEqual([byId.get(id(3))?.state, byId.get(id(3))?.remainingQuantity], ["EXPIRED", 0n]);
    assert.equal(byId.has(id(4)), false);
    assert.deepEqual(store.participantOrders("bob", NOW).map((entry) => [entry.state, entry.side, entry.filledQuantity]), [["FILLED", "BID", 10n]]);
    // A resting order is listed however many later orders push it out of the recent window.
    assert.deepEqual(store.participantOrders("alice", NOW, 0).map((entry) => entry.packageOrderIdHex).sort(), [id(1), id(3)]);
    assert.deepEqual(store.participantOrders("nobody", NOW), []);
  });
});
