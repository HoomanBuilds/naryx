import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assetRef,
  domainRef,
  netObligations,
  nettingExternalExecutionEvidence,
  nettingExternalExecutionIntent,
  nettingFinalAllocationReceipt,
  verifyNettingFinalAllocationReceipt,
  versionedManifestRef,
  type NettingPolicyManifestInput,
} from '../src/index.js';

const id = (n: number): string => n.toString(16).padStart(64, '0');
const sol = assetRef('sol', id(1), 9);
const usdc = assetRef('usdc', id(2), 6);
const policy: NettingPolicyManifestInput = {
  schemaVersion: 1,
  manifestVersion: 1,
  nettingPolicyVersion: 2,
  environment: 'testnet',
  executionClassId: 'sol-netting',
  executionClassVersion: 1,
  executionClassManifestHash: id(3),
  settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
  allocationRule: 'PRO_RATA_SEQUENCE',
  externalExecutionMode: 'EXACT_NET_ONLY',
  clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
  maximumObligations: 8,
  maximumBatchWindowMilliseconds: 1_000n,
  instruments: [{
    instrumentId: 'sol-perp',
    domain: domainRef('svm:solana-devnet', 1, id(4)),
    adapter: { adapterId: 'perp-adapter', adapterManifestVersion: 1, adapterManifestHash: id(5) },
    venue: versionedManifestRef('perp-venue', 1, id(6)),
    market: versionedManifestRef('sol-perp', 1, id(7)),
    quantityAsset: sol,
    quoteAsset: usdc,
    legFamily: 'PERP_OPEN',
    quantityIncrementAtoms: 10n,
    priceTickQuoteAtoms: 1n,
  }],
};

const result = netObligations([
  {
    ownerId: 'buyer-a', strategyOrderHash: id(10), packageOrderId: id(11),
    settlementReadinessHash: id(12), legId: 'buy-a', instrumentId: 'sol-perp',
    signedQuantityAtoms: 20n, limitPriceTicks: 12n, sequence: 1n,
  },
  {
    ownerId: 'buyer-b', strategyOrderHash: id(20), packageOrderId: id(21),
    settlementReadinessHash: id(22), legId: 'buy-b', instrumentId: 'sol-perp',
    signedQuantityAtoms: 20n, limitPriceTicks: 12n, sequence: 2n,
  },
  {
    ownerId: 'seller', strategyOrderHash: id(30), packageOrderId: id(31),
    settlementReadinessHash: id(32), legId: 'sell', instrumentId: 'sol-perp',
    signedQuantityAtoms: -20n, limitPriceTicks: 8n, sequence: 3n,
  },
], policy);

const external = result.allocations.filter((value) => value.externalQuantityAtoms !== 0n);
const intent = nettingExternalExecutionIntent(result, policy, {
  instrumentId: 'sol-perp',
  validUntilUnit: 'SOLANA_SLOT',
  validUntilValue: 1_000n,
  sourceFeeCaps: [
    { obligationId: external[0]!.obligationId, maximumFeeQuoteAtoms: 1n },
    { obligationId: external[1]!.obligationId, maximumFeeQuoteAtoms: 3n },
  ],
});

test('final receipt conserves quantity, quote, and source-bounded fees', () => {
  const evidence = nettingExternalExecutionEvidence({
    version: 1,
    intentHash: intent.intentHash,
    outcome: 'EXACT_FILLED',
    filledSignedQuantityAtoms: 20n,
    grossQuoteAtoms: 22n,
    feeQuoteAtoms: 3n,
    submittedAtUnit: 'SOLANA_SLOT',
    submittedAtValue: 999n,
    observedAtUnit: 'SOLANA_SLOT',
    observedAtValue: 1_001n,
    executionReferenceHash: id(40),
    authoritativeEvidenceHash: id(41),
  }, intent);
  const receipt = nettingFinalAllocationReceipt(result, policy, [intent], [evidence]);
  verifyNettingFinalAllocationReceipt(receipt, result, policy, [intent], [evidence]);
  assert.equal(receipt.allocations.length, 3);
  assert.deepEqual(
    receipt.allocations.filter((value) => value.externalQuantityAtoms !== 0n)
      .map((value) => value.externalFeeQuoteAtoms),
    [1n, 2n],
  );
  assert.equal(receipt.allocations.reduce((sum, value) => sum + value.externalGrossQuoteDeltaAtoms, 0n), -22n);
  assert.equal(receipt.allocations.reduce((sum, value) => sum + value.externalFeeQuoteAtoms, 0n), 3n);
  assert.ok(receipt.allocations.every((value) => value.totalQuantityAtoms === value.signedQuantityAtoms));
});

test('final receipt rejects nonterminal external execution', () => {
  const evidence = nettingExternalExecutionEvidence({
    version: 1,
    intentHash: intent.intentHash,
    outcome: 'PARTIAL_FILL',
    filledSignedQuantityAtoms: 10n,
    grossQuoteAtoms: 11n,
    feeQuoteAtoms: 1n,
    submittedAtUnit: 'SOLANA_SLOT',
    submittedAtValue: 999n,
    observedAtUnit: 'SOLANA_SLOT',
    observedAtValue: 1_001n,
    executionReferenceHash: id(42),
    authoritativeEvidenceHash: id(43),
  }, intent);
  assert.throws(
    () => nettingFinalAllocationReceipt(result, policy, [intent], [evidence]),
    /not exactly filled/,
  );
});
