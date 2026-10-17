import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef, toHex } from '@naryx/protocol-types';
import { nativeCashPolicy, nativeCashSource, reserveNativeCashOperatorBudget } from '../src/run-native-cash-testnet.mjs';

test('dedicated cash policies fully collateralize the entire recognized range without changing existing series', () => {
  const asset = assetRef('native-test-usdc', '11'.repeat(32), 6);
  const controller = `0x${'22'.repeat(20)}`;
  const source = nativeCashSource(84532);
  const policy = nativeCashPolicy('base-sepolia', asset, controller, source);
  assert.equal(policy.executionClassId, 'evm-native-cash-range-v1');
  assert.equal(policy.initialMarginQuoteAtomsPerIncrement, 4_000_001n);
  assert.equal(policy.maintenanceMarginQuoteAtomsPerIncrement, 4_000_001n);
  assert.equal(policy.maximumPositionAtoms, 5n);
  assert.notEqual(toHex(policy.policyHash), toHex(nativeCashPolicy('arbitrum-sepolia', asset, controller, nativeCashSource(421614)).policyHash));
  assert.throws(() => nativeCashSource(8453), /Sepolia/);
  assert.throws(() => nativeCashPolicy('base', asset, controller, source));
});

test('operator gas cannot consume the oracle worker budget slice', () => {
  assert.equal(reserveNativeCashOperatorBudget(999_999_999_999_899n, 10n, 10n, 1n), 1_000_000_000_000_000n);
  assert.throws(() => reserveNativeCashOperatorBudget(999_999_999_999_899n, 10n, 10n, 2n), /exhausted/);
  assert.throws(() => reserveNativeCashOperatorBudget(-1n, 10n, 10n));
});
