import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adapterRef,
  assetRef,
  domainRef,
  netObligations,
  nettingExternalExecutionIntent,
  nettingPolicyManifest,
  versionedManifestRef,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';
import { PublicKey } from '@solana/web3.js';
import {
  compileSolanaTestPerpNettingResidualPlan,
  solanaTestPerpNettingResidualEvidence,
} from '../src/index.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');
const key = (value: number): string => new PublicKey(Uint8Array.from({ length: 32 }, (_, index) =>
  index === 31 ? value : 0)).toBase58();
const base = assetRef('wsol', id(1), 9);
const quote = assetRef('tusdc', id(2), 6);
const domain = domainRef('svm:devnet', 2, id(3));
const adapter = adapterRef({
  adapterId: 'solana-test-perp-residual',
  adapterManifestVersion: 1,
  adapterManifestHash: id(4),
});
const venue = versionedManifestRef('solana-test-perp', 1, id(5));
const market = versionedManifestRef('wsol-perp', 1, id(6));
const policyInput: NettingPolicyManifestInput = {
  schemaVersion: 1,
  manifestVersion: 1,
  nettingPolicyVersion: 2,
  environment: 'devnet',
  executionClassId: 'solana-netting',
  executionClassVersion: 1,
  executionClassManifestHash: id(7),
  settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
  allocationRule: 'PRO_RATA_SEQUENCE',
  externalExecutionMode: 'EXACT_NET_ONLY',
  clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
  maximumObligations: 8,
  maximumBatchWindowMilliseconds: 1_000n,
  instruments: [{
    instrumentId: 'wsol-perp',
    domain,
    adapter,
    venue,
    market,
    quantityAsset: base,
    quoteAsset: quote,
    legFamily: 'PERP_OPEN',
    quantityIncrementAtoms: 1_000_000n,
    priceTickQuoteAtoms: 1n,
  }],
};
const policy = nettingPolicyManifest(policyInput);
const result = netObligations([{
  ownerId: 'buyer',
  strategyOrderHash: id(10),
  packageOrderId: id(11),
  settlementReadinessHash: id(12),
  legId: 'perp',
  instrumentId: 'wsol-perp',
  signedQuantityAtoms: 1_000_000_000n,
  limitPriceTicks: 100_500n,
  sequence: 1n,
}], policy);
const intent = nettingExternalExecutionIntent(result, policy, {
  instrumentId: 'wsol-perp',
  validUntilUnit: 'SOLANA_SLOT',
  validUntilValue: 500_000_000n,
  sourceFeeCaps: [{ obligationId: result.allocations[0]!.obligationId, maximumFeeQuoteAtoms: 60_000n }],
});
const binding = {
  domain,
  adapter,
  venue,
  market,
  programId: key(20),
  marketAddress: key(21),
  positionAddress: key(22),
  oracleAddress: key(23),
  collateralVaultAddress: key(24),
  feeVaultAddress: key(25),
  insuranceVaultAddress: key(26),
  executionAccount: key(27),
  baseLotAtoms: 1_000_000n,
  quoteAtomsPerTickPerBaseLot: 1n,
};

test('compiles one bounded Solana Devnet residual instruction', () => {
  const plan = compileSolanaTestPerpNettingResidualPlan({
    intent,
    instrument: policy.instruments[0]!,
    binding,
  });
  assert.equal(plan.guarantee, 'SINGLE_TRANSACTION_BOUNDED_FILL_WITH_RECEIPT');
  assert.equal(plan.baseLots, 1_000n);
  assert.equal(plan.limitPriceTicks, 100_500n);
  assert.equal(plan.executionAccount, binding.executionAccount);
  assert.equal(plan.instruction.programId.toBase58(), binding.programId);
  assert.equal(plan.instruction.keys[0]!.pubkey.toBase58(), binding.executionAccount);
  assert.equal(plan.instruction.keys[7]!.pubkey.toBase58(), plan.receiptAddress);
  assert.equal(plan.instruction.data.subarray(0, 8).toString('hex'), '4820954c32b25f8e');
  assert.deepEqual(plan.instruction.data.subarray(8, 40), Buffer.from(intent.intentHash));
});

test('rejects a Solana residual whose market lattice differs', () => {
  assert.throws(() => compileSolanaTestPerpNettingResidualPlan({
    intent,
    instrument: policy.instruments[0]!,
    binding: { ...binding, baseLotAtoms: 10n },
  }), /lot or tick lattice differs/);
});

test('translates only the matching Solana receipt into terminal evidence', () => {
  const plan = compileSolanaTestPerpNettingResidualPlan({
    intent,
    instrument: policy.instruments[0]!,
    binding,
  });
  const observation = {
    intentHash: intent.intentHash,
    authority: binding.executionAccount,
    market: binding.marketAddress,
    position: binding.positionAddress,
    terminalStatus: 'SUCCEEDED' as const,
    side: 'BUY' as const,
    baseLots: 1_000n,
    fillPricePerLot: 100_000n,
    grossQuoteAtoms: 100_000_000n,
    feeQuoteAtoms: 50_000n,
    executionSlot: 499_999_991n,
    submittedAtSlot: 499_999_990n,
    observedAtSlot: 499_999_992n,
    executionReferenceHash: id(40),
    authoritativeEvidenceHash: id(41),
  };
  const evidence = solanaTestPerpNettingResidualEvidence({ intent, plan, observation });
  assert.equal(evidence.outcome, 'EXACT_FILLED');
  assert.equal(evidence.filledSignedQuantityAtoms, 1_000_000_000n);
  assert.equal(evidence.grossQuoteAtoms, 100_000_000n);
  assert.throws(() => solanaTestPerpNettingResidualEvidence({
    intent,
    plan,
    observation: { ...observation, authority: key(99) },
  }), /another execution account/);
});
