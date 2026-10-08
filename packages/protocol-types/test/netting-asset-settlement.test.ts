import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assetRef,
  domainRef,
  netObligations,
  nettingAllocationSettlementEvidence,
  nettingFinalAllocationReceipt,
  nettingSettlementCompletionReceipt,
  verifyNettingAllocationSettlementEvidence,
  verifyNettingSettlementCompletionReceipt,
  versionedManifestRef,
  type NettingPolicyManifestInput,
} from '../src/index.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');
const policy: NettingPolicyManifestInput = {
  schemaVersion: 1,
  manifestVersion: 1,
  nettingPolicyVersion: 2,
  environment: 'testnet',
  executionClassId: 'spot-netting',
  executionClassVersion: 1,
  executionClassManifestHash: id(1),
  settlementClass: 'ATOMIC_POSTCONDITION',
  allocationRule: 'PRO_RATA_SEQUENCE',
  externalExecutionMode: 'EXACT_NET_ONLY',
  clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
  maximumObligations: 4,
  maximumBatchWindowMilliseconds: 1_000n,
  instruments: [{
    instrumentId: 'sol-spot',
    domain: domainRef('svm:solana-devnet', 1, id(2)),
    adapter: { adapterId: 'spot-adapter', adapterManifestVersion: 1, adapterManifestHash: id(3) },
    venue: versionedManifestRef('spot-venue', 1, id(4)),
    market: versionedManifestRef('sol-usdc', 1, id(5)),
    quantityAsset: assetRef('sol', id(6), 9),
    quoteAsset: assetRef('usdc', id(7), 6),
    legFamily: 'SPOT_SWAP',
    quantityIncrementAtoms: 10n,
    priceTickQuoteAtoms: 1n,
  }],
};

const result = netObligations([
  {
    ownerId: 'buyer', strategyOrderHash: id(10), packageOrderId: id(11),
    settlementReadinessHash: id(12), legId: 'buy', instrumentId: 'sol-spot',
    signedQuantityAtoms: 10n, limitPriceTicks: 12n, sequence: 1n,
  },
  {
    ownerId: 'seller', strategyOrderHash: id(20), packageOrderId: id(21),
    settlementReadinessHash: id(22), legId: 'sell', instrumentId: 'sol-spot',
    signedQuantityAtoms: -10n, limitPriceTicks: 8n, sequence: 2n,
  },
], policy);
const finalReceipt = nettingFinalAllocationReceipt(result, policy, [], []);

function evidence(index: number) {
  const allocation = finalReceipt.allocations[index]!;
  return nettingAllocationSettlementEvidence({
    version: 1,
    finalAllocationReceiptHash: finalReceipt.receiptHash,
    allocationReceiptHash: allocation.allocationReceiptHash,
    settlementAccount: `account-${index}`,
    settledQuantityAtoms: allocation.totalQuantityAtoms,
    settledQuoteDeltaAtoms: allocation.totalQuoteDeltaAtoms,
    observedAtUnit: 'SOLANA_SLOT',
    observedAtValue: 100n + BigInt(index),
    settlementReferenceHash: id(30 + index),
    authoritativeEvidenceHash: id(40 + index),
  }, finalReceipt, result, policy, [], []);
}

test('settlement completion requires exact independently observed allocation deltas', () => {
  const first = evidence(0);
  const second = evidence(1);
  verifyNettingAllocationSettlementEvidence(first, finalReceipt, result, policy, [], []);
  const completion = nettingSettlementCompletionReceipt(finalReceipt, [second, first], result, policy, [], []);
  verifyNettingSettlementCompletionReceipt(completion, finalReceipt, [first, second], result, policy, [], []);
  assert.deepEqual(completion.settlementEvidenceHashes, [first.evidenceHash, second.evidenceHash]);
  assert.equal(first.stateKind, 'ASSET_BALANCE');
});

test('a fill allocation cannot be presented as settlement with another observed delta', () => {
  const allocation = finalReceipt.allocations[0]!;
  assert.throws(() => nettingAllocationSettlementEvidence({
    version: 1,
    finalAllocationReceiptHash: finalReceipt.receiptHash,
    allocationReceiptHash: allocation.allocationReceiptHash,
    settlementAccount: 'buyer-account',
    settledQuantityAtoms: allocation.totalQuantityAtoms - 1n,
    settledQuoteDeltaAtoms: allocation.totalQuoteDeltaAtoms,
    observedAtUnit: 'SOLANA_SLOT',
    observedAtValue: 100n,
    settlementReferenceHash: id(50),
    authoritativeEvidenceHash: id(51),
  }, finalReceipt, result, policy, [], []), /observed quantity differs/);
});

test('completion rejects missing or duplicated allocation settlement evidence', () => {
  const first = evidence(0);
  assert.throws(
    () => nettingSettlementCompletionReceipt(finalReceipt, [first], result, policy, [], []),
    /coverage is incomplete/,
  );
  assert.throws(
    () => nettingSettlementCompletionReceipt(finalReceipt, [first, first], result, policy, [], []),
    /allocation repeats/,
  );
});
