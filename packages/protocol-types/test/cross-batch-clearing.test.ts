import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assetRef,
  crossBatchClearingPlan,
  crossBatchClearingPolicy,
  crossBatchClearingReceipt,
  crossBatchExternalExecutionEvidence,
  crossBatchExternalExecutionIntent,
  domainRef,
  netObligations,
  nettingExternalExecutionIntent,
  nettingFinalAllocationReceipt,
  verifyCrossBatchClearingPlan,
  verifyCrossBatchClearingReceipt,
  versionedManifestRef,
  type NettingExternalExecutionIntent,
  type NettingPolicyManifestInput,
  type NettingResult,
} from '../src/index.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');
const sol = assetRef('sol', id(1), 9);
const usdc = assetRef('usdc', id(2), 6);
const domain = domainRef('hypercore:testnet', 1, id(3));
const adapter = { adapterId: 'hyperliquid-perp', adapterManifestVersion: 1, adapterManifestHash: id(4) } as const;

function policy(marketHash = id(7)): NettingPolicyManifestInput {
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    nettingPolicyVersion: 2,
    environment: 'testnet',
    executionClassId: 'hyperliquid-netting',
    executionClassVersion: 1,
    executionClassManifestHash: id(5),
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
    allocationRule: 'PRO_RATA_SEQUENCE',
    externalExecutionMode: 'EXACT_NET_ONLY',
    clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
    maximumObligations: 8,
    maximumBatchWindowMilliseconds: 1_000n,
    instruments: [{
      instrumentId: 'sol-perp',
      domain,
      adapter,
      venue: versionedManifestRef('hyperliquid', 1, id(6)),
      market: versionedManifestRef('sol-perp', 1, marketHash),
      quantityAsset: sol,
      quoteAsset: usdc,
      legFamily: 'PERP_OPEN',
      quantityIncrementAtoms: 10n,
      priceTickQuoteAtoms: 1n,
    }],
  };
}

function residual(
  number: number,
  quantity: bigint,
  limitPriceTicks: bigint,
  policyInput = policy(),
): NettingExternalExecutionIntent {
  return batch(number, quantity, limitPriceTicks, policyInput).intent;
}

function batch(
  number: number,
  quantity: bigint,
  limitPriceTicks: bigint,
  policyInput = policy(),
): Readonly<{
  policy: NettingPolicyManifestInput;
  result: NettingResult;
  intent: NettingExternalExecutionIntent;
}> {
  const result = netObligations([{
    ownerId: `owner-${number}`,
    strategyOrderHash: id(number * 10),
    packageOrderId: id(number * 10 + 1),
    settlementReadinessHash: id(number * 10 + 2),
    legId: `leg-${number}`,
    instrumentId: 'sol-perp',
    signedQuantityAtoms: quantity,
    limitPriceTicks,
    sequence: 1n,
  }], policyInput);
  const allocation = result.allocations[0]!;
  const intent = nettingExternalExecutionIntent(result, policyInput, {
    instrumentId: 'sol-perp',
    validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    validUntilValue: 10_000n + BigInt(number),
    sourceFeeCaps: [{ obligationId: allocation.obligationId, maximumFeeQuoteAtoms: 2n }],
  });
  return Object.freeze({ policy: policyInput, result, intent });
}

const clearingPolicy = crossBatchClearingPolicy({
  version: 1,
  policyId: 'hyperliquid-testnet-cross-batch',
  domain,
  adapter,
  expiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
  maximumSourceIntents: 8,
  maximumSourceBatches: 8,
  maximumExpirySpread: 100n,
});

test('cross-batch clearing nets compatible residuals and routes the remainder once', () => {
  const buyBatch = batch(1, 30n, 12n);
  const sellBatch = batch(2, -20n, 8n);
  const buy = buyBatch.intent;
  const sell = sellBatch.intent;
  const plan = crossBatchClearingPlan([buy, sell], clearingPolicy);
  verifyCrossBatchClearingPlan(plan, [buy, sell], clearingPolicy);
  assert.equal(plan.internalMatchedQuantityAtoms, 20n);
  assert.equal(plan.internalClearingPriceTicks, 10n);
  assert.equal(plan.externalSide, 'BUY');
  assert.equal(plan.externalQuantityAtoms, 10n);
  assert.equal(plan.externalLimitPriceTicks, 12n);

  const intent = crossBatchExternalExecutionIntent(plan);
  const evidence = crossBatchExternalExecutionEvidence({
    version: 1,
    intentHash: intent.intentHash,
    outcome: 'EXACT_FILLED',
    filledSignedQuantityAtoms: 10n,
    grossQuoteAtoms: 11n,
    feeQuoteAtoms: 1n,
    submittedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    submittedAtValue: 9_999n,
    observedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    observedAtValue: 10_001n,
    executionReferenceHash: id(90),
    authoritativeEvidenceHash: id(91),
  }, intent);
  const receipt = crossBatchClearingReceipt(plan, intent, evidence);
  verifyCrossBatchClearingReceipt(receipt, plan, intent, evidence);
  const buyer = receipt.sources.find((source) => source.side === 'BUY')!;
  const seller = receipt.sources.find((source) => source.side === 'SELL')!;
  assert.equal(buyer.internalQuantityAtoms, 20n);
  assert.equal(buyer.externalQuantityAtoms, 10n);
  assert.equal(buyer.totalQuoteDeltaAtoms, -32n);
  assert.equal(seller.internalQuantityAtoms, 20n);
  assert.equal(seller.externalQuantityAtoms, 0n);
  assert.equal(seller.totalQuoteDeltaAtoms, 20n);
  assert.equal(receipt.sources.reduce((sum, source) => sum + source.externalFeeQuoteAtoms, 0n), 1n);

  const resolution = Object.freeze({
    policy: clearingPolicy,
    sourceIntents: Object.freeze([buy, sell]),
    plan,
    intent,
    evidence,
    receipt,
  });
  const buyerSettlement = nettingFinalAllocationReceipt(
    buyBatch.result,
    buyBatch.policy,
    [buy],
    [],
    [resolution],
  );
  const sellerSettlement = nettingFinalAllocationReceipt(
    sellBatch.result,
    sellBatch.policy,
    [sell],
    [],
    [resolution],
  );
  assert.equal(buyerSettlement.executionEvidenceHashes.length, 1);
  assert.deepEqual(buyerSettlement.executionEvidenceHashes[0], receipt.receiptHash);
  assert.equal(buyerSettlement.allocations[0]!.externalGrossQuoteDeltaAtoms, -31n);
  assert.equal(buyerSettlement.allocations[0]!.externalFeeQuoteAtoms, 1n);
  assert.equal(sellerSettlement.allocations[0]!.externalGrossQuoteDeltaAtoms, 20n);
  assert.equal(sellerSettlement.allocations[0]!.externalFeeQuoteAtoms, 0n);
});

test('fully crossed residuals settle without an external intent', () => {
  const plan = crossBatchClearingPlan([
    residual(3, 20n, 12n),
    residual(4, -20n, 8n),
  ], clearingPolicy);
  assert.equal(plan.externalQuantityAtoms, 0n);
  assert.equal(plan.externalSide, undefined);
  const receipt = crossBatchClearingReceipt(plan);
  assert.equal(receipt.executionEvidenceHash, undefined);
  assert.equal(receipt.sources.reduce((sum, source) => sum + source.totalQuoteDeltaAtoms, 0n), 0n);
  assert.throws(() => crossBatchExternalExecutionIntent(plan), /no external residual/);
});

test('cross-batch clearing rejects incompatible, non-crossing, duplicate, and tampered inputs', () => {
  const buy = residual(5, 20n, 12n);
  const sell = residual(6, -20n, 8n);
  const otherMarket = residual(7, -20n, 8n, policy(id(70)));
  assert.throws(() => crossBatchClearingPlan([buy, otherMarket], clearingPolicy), /routes are incompatible/);
  assert.throws(
    () => crossBatchClearingPlan([residual(8, 20n, 8n), residual(9, -20n, 10n)], clearingPolicy),
    /limits do not overlap/,
  );
  assert.throws(() => crossBatchClearingPlan([buy, buy], clearingPolicy), /intent hashes repeat/);
  const plan = crossBatchClearingPlan([buy, sell], clearingPolicy);
  assert.throws(
    () => verifyCrossBatchClearingPlan({ ...plan, externalQuantityAtoms: 10n }, [buy, sell], clearingPolicy),
    /does not follow/,
  );
});
