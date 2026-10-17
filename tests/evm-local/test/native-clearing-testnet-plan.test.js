import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef, parseProtocolJson, stringifyProtocolJson, toHex } from '@naryx/protocol-types';
import { buildClearingPolicy, reserveTestnetBudget, finalizedTransactionEvidence } from '../src/run-native-clearing-testnet.mjs';

test('finalized evidence replaces provisional hashes only with the canonical successful receipt', () => {
  const hash = `0x${'11'.repeat(32)}`;
  const blockHash = `0x${'22'.repeat(32)}`;
  const transaction = { hash, blockNumber: 40n, blockHash: `0x${'00'.repeat(32)}` };
  const receipt = { transactionHash: hash, status: 'success', blockNumber: 42n, blockHash };
  const block = { number: 42n, hash: blockHash };
  assert.deepEqual(finalizedTransactionEvidence(transaction, receipt, block, 42n), { number: 42n, hash: blockHash });
  assert.throws(() => finalizedTransactionEvidence(transaction, receipt, block, 41n), /not finalized/);
  assert.throws(() => finalizedTransactionEvidence(transaction, { ...receipt, transactionHash: blockHash }, block, 42n), /differs/);
  assert.throws(() => finalizedTransactionEvidence(transaction, { ...receipt, status: 'reverted' }, block, 42n), /reverted/);
  assert.throws(() => finalizedTransactionEvidence(transaction, receipt, { ...block, hash }, 42n), /not canonical/);
});

test('the per-network cap includes ETH transfers and worst-case gas without rounding', () => {
  const maximum = 10_000_000_000_000_000n;
  assert.equal(reserveTestnetBudget(maximum - 101n, 10n, 10n, 1n), maximum);
  assert.throws(() => reserveTestnetBudget(maximum - 101n, 10n, 10n, 2n), /cap exceeded/);
  assert.throws(() => reserveTestnetBudget(0n, 1n, 1n, -1n), /Invalid/);
});

test('resumed evidence is mutable without changing immutable protocol documents', () => {
  const parsed = parseProtocolJson(stringifyProtocolJson({ transactions: {}, budgetReservedWei: 0n }));
  const record = structuredClone(parsed);
  record.transactions.deposit = { hash: '11'.repeat(32) };
  record.budgetReservedWei = 1n;
  assert.equal(Object.keys(parsed.transactions).length, 0);
  assert.equal(record.budgetReservedWei, 1n);
});

test('clearing testnet plan binds live matching and series identities with bounded collateral units', () => {
  const hash = '11'.repeat(32);
  const profile = { chainId: 84532, profileId: 'test-option-spread', executionClassId: 'test-options',
    seriesId: 'test-series', seriesVersion: 2, seriesManifestHash: hash, quoteAsset: assetRef('test-usdc', hash, 6) };
  const matching = { matchingPolicyVersion: 1, environment: 'testnet', executionClassId: 'test-options',
    allocationRule: 'PRICE_TIME', directVersusImpliedPriority: 'DIRECT_FIRST', selfMatchPolicy: 'CANCEL_INCOMING',
    commonControlAsSelf: true, amendmentPriorityRule: 'RETAIN_ON_SIZE_REDUCTION', quantityIncrement: 1000n,
    minimumExecutionQuantity: 1000n, maximumImplicationDepth: 2 };
  const authority = '0x1111111111111111111111111111111111111111';
  const policy = buildClearingPolicy(profile, matching, authority);
  assert.equal(policy.accountingAsset.decimals, 6);
  assert.equal(policy.packageQuantityIncrementAtoms, 1_000_000_000_000_000n);
  assert.equal(policy.strategySeries.manifestVersion, 2);
  assert.equal(toHex(policy.strategySeries.manifestHash), hash);
  assert.equal(policy.markAuthorityId, authority);
  assert.ok(policy.maintenanceMarginQuoteAtomsPerIncrement <= policy.initialMarginQuoteAtomsPerIncrement);
  assert.throws(() => buildClearingPolicy({ ...profile, chainId: 1 }, matching, authority), /Sepolia only/);
  assert.throws(() => buildClearingPolicy(profile, { ...matching, executionClassId: 'other' }, authority));
});
