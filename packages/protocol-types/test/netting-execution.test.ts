import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assetRef,
  domainRef,
  netObligations,
  nettingExternalExecutionEvidence,
  nettingExternalExecutionIntent,
  verifyNettingExternalExecutionEvidence,
  verifyNettingExternalExecutionIntent,
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
    ownerId: 'buyer',
    strategyOrderHash: id(10),
    packageOrderId: id(11),
    settlementReadinessHash: id(12),
    legId: 'buy',
    instrumentId: 'sol-perp',
    signedQuantityAtoms: 30n,
    limitPriceTicks: 12n,
    sequence: 1n,
  },
  {
    ownerId: 'seller',
    strategyOrderHash: id(20),
    packageOrderId: id(21),
    settlementReadinessHash: id(22),
    legId: 'sell',
    instrumentId: 'sol-perp',
    signedQuantityAtoms: -20n,
    limitPriceTicks: 8n,
    sequence: 2n,
  },
], policy);

test('external intent binds the exact residual, venue identity, expiry, and fee cap', () => {
  const intent = nettingExternalExecutionIntent(result, policy, {
    instrumentId: 'sol-perp',
    validUntilUnit: 'SOLANA_SLOT',
    validUntilValue: 1_000n,
    maximumFeeQuoteAtoms: 2n,
  });
  assert.equal(intent.side, 'BUY');
  assert.equal(intent.quantityAtoms, 10n);
  assert.equal(intent.limitPriceTicks, 12n);
  assert.equal(intent.sourceObligationIds.length, 1);
  verifyNettingExternalExecutionIntent(intent, result, policy);
  assert.throws(
    () => verifyNettingExternalExecutionIntent({ ...intent, maximumFeeQuoteAtoms: 3n }, result, policy),
    /does not follow/,
  );
});

test('terminal evidence enforces fill quantity, price, fee, and pre-expiry submission', () => {
  const intent = nettingExternalExecutionIntent(result, policy, {
    instrumentId: 'sol-perp',
    validUntilUnit: 'SOLANA_SLOT',
    validUntilValue: 1_000n,
    maximumFeeQuoteAtoms: 2n,
  });
  const evidence = nettingExternalExecutionEvidence({
    version: 1,
    intentHash: intent.intentHash,
    outcome: 'EXACT_FILLED',
    filledSignedQuantityAtoms: 10n,
    grossQuoteAtoms: 12n,
    feeQuoteAtoms: 2n,
    submittedAtUnit: 'SOLANA_SLOT',
    submittedAtValue: 999n,
    observedAtUnit: 'SOLANA_SLOT',
    observedAtValue: 1_001n,
    executionReferenceHash: id(30),
    authoritativeEvidenceHash: id(31),
  }, intent);
  verifyNettingExternalExecutionEvidence(evidence, intent);
  assert.throws(
    () => nettingExternalExecutionEvidence({ ...evidence, grossQuoteAtoms: 13n }, intent),
    /price limit/,
  );
  assert.throws(
    () => nettingExternalExecutionEvidence({ ...evidence, feeQuoteAtoms: 3n }, intent),
    /fee exceeds/,
  );
  assert.throws(
    () => nettingExternalExecutionEvidence({ ...evidence, submittedAtValue: 1_000n }, intent),
    /after expiry/,
  );
});
