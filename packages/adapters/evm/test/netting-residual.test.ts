import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adapterRef,
  assetRef,
  crossBatchClearingPlan,
  crossBatchClearingPolicy,
  crossBatchExternalExecutionIntent,
  domainRef,
  netObligations,
  nettingExternalExecutionIntent,
  nettingPolicyManifest,
  versionedManifestRef,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';
import { decodeFunctionData, getAddress } from 'viem';
import {
  compileEvmTestPerpNettingResidualPlan,
  evmTestPerpNettingResidualEvidence,
  NARYX_TEST_PERP_MARKET_ABI,
} from '../src/index.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');
const address = (value: number) => getAddress(`0x${value.toString(16).padStart(40, '0')}`);
const base = assetRef('weth', id(1), 18);
const quote = assetRef('tusdc', id(2), 6);
const domain = domainRef('eip155:84532', 2, id(3));
const adapter = adapterRef({
  adapterId: 'base-test-perp-residual',
  adapterManifestVersion: 1,
  adapterManifestHash: id(4),
});
const venue = versionedManifestRef('base-test-perp', 1, id(5));
const market = versionedManifestRef('weth-perp', 1, id(6));
const policyInput: NettingPolicyManifestInput = {
  schemaVersion: 1,
  manifestVersion: 1,
  nettingPolicyVersion: 2,
  environment: 'testnet',
  executionClassId: 'base-netting',
  executionClassVersion: 1,
  executionClassManifestHash: id(7),
  settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
  allocationRule: 'PRO_RATA_SEQUENCE',
  externalExecutionMode: 'EXACT_NET_ONLY',
  clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
  maximumObligations: 8,
  maximumBatchWindowMilliseconds: 1_000n,
  instruments: [{
    instrumentId: 'weth-perp',
    domain,
    adapter,
    venue,
    market,
    quantityAsset: base,
    quoteAsset: quote,
    legFamily: 'PERP_OPEN',
    quantityIncrementAtoms: 100_000_000_000_000_000n,
    priceTickQuoteAtoms: 10_000_000n,
  }],
};
const policy = nettingPolicyManifest(policyInput);
const result = netObligations([{
  ownerId: 'buyer',
  strategyOrderHash: id(10),
  packageOrderId: id(11),
  settlementReadinessHash: id(12),
  legId: 'perp',
  instrumentId: 'weth-perp',
  signedQuantityAtoms: 1_000_000_000_000_000_000n,
  limitPriceTicks: 21n,
  sequence: 1n,
}], policy);
const intent = nettingExternalExecutionIntent(result, policy, {
  instrumentId: 'weth-perp',
  validUntilUnit: 'EVM_UNIX_SECONDS',
  validUntilValue: 2_000_000_000n,
  sourceFeeCaps: [{ obligationId: result.allocations[0]!.obligationId, maximumFeeQuoteAtoms: 2_000_000n }],
});
const sellResult = netObligations([{
  ownerId: 'seller',
  strategyOrderHash: id(30),
  packageOrderId: id(31),
  settlementReadinessHash: id(32),
  legId: 'perp',
  instrumentId: 'weth-perp',
  signedQuantityAtoms: -2_000_000_000_000_000_000n,
  limitPriceTicks: 19n,
  sequence: 2n,
}], policy);
const sellIntent = nettingExternalExecutionIntent(sellResult, policy, {
  instrumentId: 'weth-perp',
  validUntilUnit: 'EVM_UNIX_SECONDS',
  validUntilValue: 2_000_000_005n,
  sourceFeeCaps: [{ obligationId: sellResult.allocations[0]!.obligationId, maximumFeeQuoteAtoms: 3_000_000n }],
});
const crossBatchIntent = crossBatchExternalExecutionIntent(crossBatchClearingPlan(
  [intent, sellIntent],
  crossBatchClearingPolicy({
    version: 1,
    policyId: 'base-sepolia-cross-batch-v1',
    domain,
    adapter,
    expiryUnit: 'EVM_UNIX_SECONDS',
    maximumSourceIntents: 8,
    maximumSourceBatches: 8,
    maximumExpirySpread: 10n,
  }),
));
const binding = {
  domain,
  adapter,
  venue,
  market,
  chainId: 84532 as const,
  marketAddress: address(20),
  executionAccount: address(21),
  expiry: 4_294_967_295,
};

test('compiles one bounded Base Sepolia residual transaction', () => {
  const plan = compileEvmTestPerpNettingResidualPlan({
    intent,
    instrument: policy.instruments[0]!,
    binding,
    marginQuoteAtoms: 400_000_000n,
  });
  assert.equal(plan.guarantee, 'SINGLE_TRANSACTION_BOUNDED_FILL_WITH_EVENT');
  assert.equal(plan.requestedSignedQuantityAtoms, 1_000_000_000_000_000_000n);
  assert.equal(plan.sizeDeltaWad, 1_000_000_000_000_000_000n);
  assert.equal(plan.balanceDeltaWad, 400_000_000_000_000_000_000n);
  assert.equal(plan.minimumNotionalWad, 1n);
  assert.equal(plan.maximumNotionalWad, 2_100_000_000_000_000_000_000n);
  assert.equal(plan.maximumFeeWad, 2_000_000_000_000_000_000n);
  assert.equal(plan.transaction.to, binding.marketAddress);
  const decoded = decodeFunctionData({ abi: NARYX_TEST_PERP_MARKET_ABI, data: plan.transaction.data });
  assert.equal(decoded.functionName, 'tradeBounded');
  assert.equal(decoded.args[0], plan.executionId);
  assert.equal(decoded.args[2], plan.minimumNotionalWad);
  assert.equal(decoded.args[3], plan.maximumNotionalWad);
  assert.equal(decoded.args[4], plan.maximumFeeWad);
});

test('rejects wrong bindings and margin shapes before calldata exists', () => {
  assert.throws(() => compileEvmTestPerpNettingResidualPlan({
    intent,
    instrument: policy.instruments[0]!,
    binding: { ...binding, market: versionedManifestRef('other-market', 1, id(30)) },
    marginQuoteAtoms: 400_000_000n,
  }), /market binding differs/);
  assert.throws(() => compileEvmTestPerpNettingResidualPlan({
    intent,
    instrument: policy.instruments[0]!,
    binding,
    marginQuoteAtoms: 0n,
  }), /requires solver margin/);
});

test('translates only the matching bounded event into terminal evidence', () => {
  const plan = compileEvmTestPerpNettingResidualPlan({
    intent,
    instrument: policy.instruments[0]!,
    binding,
    marginQuoteAtoms: 400_000_000n,
  });
  const observation = {
    executionId: plan.executionId,
    trader: binding.executionAccount,
    terminalStatus: 'SUCCEEDED' as const,
    sizeDeltaWad: plan.sizeDeltaWad,
    notionalWad: 2_000_420_000_000_000_000_000n,
    feeWad: 1_000_210_000_000_000_000n,
    submittedAtSeconds: 1_999_999_999n,
    observedAtSeconds: 2_000_000_001n,
    executionReferenceHash: id(40),
    authoritativeEvidenceHash: id(41),
  };
  const evidence = evmTestPerpNettingResidualEvidence({ intent, plan, observation });
  assert.equal(evidence.outcome, 'EXACT_FILLED');
  assert.equal(evidence.grossQuoteAtoms, 2_000_420_000n);
  assert.equal(evidence.feeQuoteAtoms, 1_000_210n);
  assert.throws(() => evmTestPerpNettingResidualEvidence({
    intent,
    plan,
    observation: { ...observation, trader: address(99) },
  }), /another execution account/);
  assert.throws(() => evmTestPerpNettingResidualEvidence({
    intent,
    plan,
    observation: { ...observation, notionalWad: plan.maximumNotionalWad + 1n },
  }), /violates the bounded trade/);
});

test('compiles and proves a pooled Base Sepolia residual', () => {
  const plan = compileEvmTestPerpNettingResidualPlan({
    intent: crossBatchIntent,
    instrument: policy.instruments[0]!,
    binding,
    marginQuoteAtoms: 400_000_000n,
  });
  assert.equal(plan.requestedSignedQuantityAtoms, -1_000_000_000_000_000_000n);
  const evidence = evmTestPerpNettingResidualEvidence({
    intent: crossBatchIntent,
    plan,
    observation: {
      executionId: plan.executionId,
      trader: binding.executionAccount,
      terminalStatus: 'SUCCEEDED',
      sizeDeltaWad: plan.sizeDeltaWad,
      notionalWad: 1_900_000_000_000_000_000_000n,
      feeWad: 1_000_000_000_000_000_000n,
      submittedAtSeconds: 1_999_999_999n,
      observedAtSeconds: 2_000_000_001n,
      executionReferenceHash: id(42),
      authoritativeEvidenceHash: id(43),
    },
  });
  assert.equal(evidence.outcome, 'EXACT_FILLED');
  assert.deepEqual(evidence.intentHash, crossBatchIntent.intentHash);
});
