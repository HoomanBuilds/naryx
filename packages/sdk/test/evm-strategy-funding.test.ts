import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, erc20Abi } from 'viem';
import { reviewEvmStrategyFunding } from '../src/index.js';

const quoteHash = 'ab'.repeat(32);
const strategyAccount = '0x1111111111111111111111111111111111111111';
const funding = {
  version: 1, quoteHash, chainId: 84532, strategyAccount,
  token: '0x2222222222222222222222222222222222222222',
  balanceAtoms: '1999999', requiredAtoms: '2000000', deficitAtoms: '1',
};
const expected = { quoteHash, chainId: 84532, strategyAccount, maximumRequiredAtoms: 2000000n };

test('funding review compiles only the exact shortfall as a token transfer', () => {
  const result = reviewEvmStrategyFunding(funding, expected);
  assert.equal(result.deficitAtoms, 1n);
  assert.equal(result.transaction.to, funding.token);
  assert.equal(result.transaction.value, '0');
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: result.transaction.data }), {
    functionName: 'transfer', args: [strategyAccount, 1n],
  });
});

test('funding review refuses mismatched identities, over-budget amounts, zero deficits and u256 overflow', () => {
  for (const changed of [
    { quoteHash: 'cd'.repeat(32) }, { chainId: 1 }, { strategyAccount: funding.token },
    { token: '0x0000000000000000000000000000000000000000' }, { token: strategyAccount },
    { requiredAtoms: '2000001', deficitAtoms: '2' }, { deficitAtoms: '0' },
    { balanceAtoms: '2000000', deficitAtoms: '0' },
    { requiredAtoms: (1n << 256n).toString() }, { deficitAtoms: '01' }, { data: '0x1234' },
  ]) assert.throws(() => reviewEvmStrategyFunding({ ...funding, ...changed }, expected));
});

test('input-token funding requires exact asset and decimal bindings', () => {
  const f = { ...funding, assetId: 'base-test-token', decimals: 18, balanceAtoms: '0', requiredAtoms: '10000000000000000', deficitAtoms: '10000000000000000' };
  const e = { ...expected, assetId: 'base-test-token', decimals: 18, maximumRequiredAtoms: 10000000000000000n };
  assert.equal(reviewEvmStrategyFunding(f, e).decimals, 18);
  assert.throws(() => reviewEvmStrategyFunding(f, { ...e, decimals: 6 }));
  assert.throws(() => reviewEvmStrategyFunding(f, { ...e, assetId: 'other-token' }));
});
