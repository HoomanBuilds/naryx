import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assetRef,
  domainRef,
  netObligations,
  nettingAllocationExecutionAuthorization,
  nettingAllocationExecutionAuthorizationBytes,
  nettingFinalAllocationReceipt,
  packageSettlementCommitment,
  packageSettlementCommitmentHash,
  verifyNettingAllocationExecutionAuthorization,
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
    domain: domainRef('svm:devnet', 1, id(2)),
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
const receipt = nettingFinalAllocationReceipt(result, policy, [], []);
const selected = receipt.allocations[0]!;
const settlement = packageSettlementCommitment({
  version: 1,
  environment: policy.environment,
  executionClassId: policy.executionClassId,
  packageOrderId: selected.packageOrderId,
  strategyOrderHash: selected.strategyOrderHash,
  graphHash: id(30),
  participantId: selected.ownerId,
  settlementAccount: 'buyer-account',
  quantity: 10n,
  validUntilUnit: 'SOLANA_SLOT',
  validUntilValue: 1_000n,
});

const input = () => ({
  version: 1,
  finalAllocationReceiptHash: receipt.receiptHash,
  allocationReceiptHash: selected.allocationReceiptHash,
  settlementCommitmentHash: packageSettlementCommitmentHash(settlement),
  executionPlanHash: id(31),
  solverId: 'solver',
  protocolFeeAtoms: 1n,
  solverFeeAtoms: 2n,
  nonce: 3n,
  validUntilUnit: 'SOLANA_SLOT' as const,
  validUntilValue: 900n,
});

test('binds one final allocation to an exact account execution plan', () => {
  const authorization = nettingAllocationExecutionAuthorization(
    input(), receipt, result, policy, [], [], settlement,
  );
  verifyNettingAllocationExecutionAuthorization(
    authorization, receipt, result, policy, [], [], settlement,
  );
  assert.equal(authorization.ownerId, 'buyer');
  assert.equal(authorization.settlementAccount, 'buyer-account');
  assert.equal(authorization.settledQuantityAtoms, selected.totalQuantityAtoms);
  assert.equal(authorization.settledQuoteDeltaAtoms, selected.totalQuoteDeltaAtoms);
  assert.equal(authorization.stateKind, 'ASSET_BALANCE');
  assert.ok(nettingAllocationExecutionAuthorizationBytes(
    authorization, receipt, result, policy, [], [], settlement,
  ).length > 0);
});

test('rejects another commitment or an authorization that outlives the order', () => {
  assert.throws(() => nettingAllocationExecutionAuthorization(
    { ...input(), settlementCommitmentHash: id(99) },
    receipt,
    result,
    policy,
    [],
    [],
    settlement,
  ), /another settlement commitment/);
  assert.throws(() => nettingAllocationExecutionAuthorization(
    { ...input(), validUntilValue: 1_001n },
    receipt,
    result,
    policy,
    [],
    [],
    settlement,
  ), /outlives its settlement commitment/);
});

test('verification rejects an authorization whose signed plan fields changed', () => {
  const authorization = nettingAllocationExecutionAuthorization(
    input(), receipt, result, policy, [], [], settlement,
  );
  assert.throws(() => verifyNettingAllocationExecutionAuthorization(
    { ...authorization, solverFeeAtoms: authorization.solverFeeAtoms + 1n },
    receipt,
    result,
    policy,
    [],
    [],
    settlement,
  ), /authorization hash does not match/);
});
