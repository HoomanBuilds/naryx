import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assetRef,
  adapterRef,
  domainRef,
  netObligations,
  nettingExternalExecutionIntent,
  nettingPolicyManifest,
  versionedManifestRef,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';
import {
  compileHyperliquidNettingResidualPlan,
  hyperliquidNettingResidualEvidence,
} from '../src/index.js';

const id = (n: number): string => n.toString(16).padStart(64, '0');
const base = assetRef('btc', id(1), 2);
const quote = assetRef('usdc', id(2), 2);
const adapter = adapterRef({
  adapterId: 'hypercore-perp',
  adapterManifestVersion: 1,
  adapterManifestHash: id(3),
});
const venue = versionedManifestRef('hypercore', 1, id(4));
const market = versionedManifestRef('btc-perp', 1, id(5));
const policyInput: NettingPolicyManifestInput = {
  schemaVersion: 1,
  manifestVersion: 1,
  nettingPolicyVersion: 2,
  environment: 'testnet',
  executionClassId: 'hypercore-netting',
  executionClassVersion: 1,
  executionClassManifestHash: id(6),
  settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
  allocationRule: 'PRO_RATA_SEQUENCE',
  externalExecutionMode: 'EXACT_NET_ONLY',
  clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
  maximumObligations: 8,
  maximumBatchWindowMilliseconds: 1_000n,
  instruments: [{
    instrumentId: 'btc-perp',
    domain: domainRef('hypercore:testnet', 1, id(7)),
    adapter,
    venue,
    market,
    quantityAsset: base,
    quoteAsset: quote,
    legFamily: 'PERP_OPEN',
    quantityIncrementAtoms: 100n,
    priceTickQuoteAtoms: 250n,
  }],
};
const policy = nettingPolicyManifest(policyInput);
const result = netObligations([{
  ownerId: 'buyer',
  strategyOrderHash: id(10),
  packageOrderId: id(11),
  settlementReadinessHash: id(12),
  legId: 'perp',
  instrumentId: 'btc-perp',
  signedQuantityAtoms: 100n,
  limitPriceTicks: 1n,
  sequence: 1n,
}], policy);
const intent = nettingExternalExecutionIntent(result, policy, {
  instrumentId: 'btc-perp',
  validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
  validUntilValue: 2_000_000_000_000n,
  sourceFeeCaps: [{ obligationId: result.allocations[0]!.obligationId, maximumFeeQuoteAtoms: 2n }],
});
const binding = { adapter, venue, market, assetId: 3, sizeDecimals: 2, maximumPriceDecimals: 6 };

test('compiles one exact Hyperliquid Testnet IOC from a residual intent', () => {
  const plan = compileHyperliquidNettingResidualPlan({
    intent,
    instrument: policy.instruments[0]!,
    binding,
  });
  assert.equal(plan.guarantee, 'SINGLE_IOC_WITH_TERMINAL_EVIDENCE');
  assert.equal(plan.requestedSignedQuantityAtoms, 100n);
  assert.equal(plan.order.a, 3);
  assert.equal(plan.order.b, true);
  assert.equal(plan.order.p, '2.5');
  assert.equal(plan.order.s, '1');
  assert.equal(plan.order.t.limit.tif, 'Ioc');
  assert.deepEqual(plan.action.orders, [plan.order]);
});

test('rejects a market binding outside the signed instrument', () => {
  assert.throws(
    () => compileHyperliquidNettingResidualPlan({
      intent,
      instrument: policy.instruments[0]!,
      binding: { ...binding, market: versionedManifestRef('eth-perp', 1, id(8)) },
    }),
    /market binding differs/,
  );
});

test('translates only matching terminal venue evidence', () => {
  const plan = compileHyperliquidNettingResidualPlan({
    intent,
    instrument: policy.instruments[0]!,
    binding,
  });
  const observation = {
    clientOrderId: plan.clientOrderId,
    terminalStatus: 'FILLED' as const,
    filledSignedQuantityAtoms: 100n,
    grossQuoteAtoms: 250n,
    feeQuoteAtoms: 1n,
    submittedAtMs: 1_999_999_999_999n,
    observedAtMs: 2_000_000_000_001n,
    executionReferenceHash: id(20),
    authoritativeEvidenceHash: id(21),
  };
  const evidence = hyperliquidNettingResidualEvidence({ intent, plan, observation });
  assert.equal(evidence.outcome, 'EXACT_FILLED');
  assert.equal(evidence.filledSignedQuantityAtoms, 100n);
  assert.throws(
    () => hyperliquidNettingResidualEvidence({
      intent,
      plan,
      observation: { ...observation, terminalStatus: 'UNKNOWN' },
    }),
    /not terminal evidence/,
  );
  assert.throws(
    () => hyperliquidNettingResidualEvidence({
      intent,
      plan,
      observation: { ...observation, feeQuoteAtoms: 3n },
    }),
    /fee exceeds/,
  );
});
