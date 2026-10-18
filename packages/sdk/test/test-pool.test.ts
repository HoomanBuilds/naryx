import assert from 'node:assert/strict';
import test from 'node:test';
import { testPoolConfig, testPoolRequest, testPoolConsent, testPoolWithdrawal, verifyTestPoolChallenge } from '../src/test-pool.js';

test('pool signing review refuses substituted authority, body, amount and test environment', () => {
  const config = testPoolConfig({ environment: 'TESTNET', custody: 'CUSTODIAL_TESTNET_POOL_V1',
    poolAccount: `0x${'11'.repeat(20)}`, bindingHash: `0x${'22'.repeat(32)}`, policyHash: `0x${'33'.repeat(32)}`,
    maximumTotalQuoteAtoms: 20_000_000n, quoteDecimals: 6 });
  const owner = `0x${'44'.repeat(20)}` as const;
  const read = testPoolRequest(config, owner, 'member', {}, 1_000_000);
  verifyTestPoolChallenge(read, read);
  assert.throws(() => verifyTestPoolChallenge(read, { ...read, domain: { ...read.domain, chainId: 1 } }), /differs/);
  assert.throws(() => verifyTestPoolChallenge(read, testPoolRequest(config, owner, 'withdrawal-submit', { id: 'other' }, 1_000_000)), /differs/);
  const consent = testPoolConsent(config, owner);
  verifyTestPoolChallenge(consent, consent);
  const withdrawal = testPoolWithdrawal(config, { id: 'w1', owner, debitQuoteAtoms: 1_000_000n, expiresAtMs: 1_000_000 });
  verifyTestPoolChallenge(withdrawal, withdrawal);
  assert.throws(() => verifyTestPoolChallenge(withdrawal, { ...withdrawal, message: { ...withdrawal.message, debitQuoteAtoms: 2_000_000n } }), /differs/);
  assert.throws(() => testPoolConfig({ ...config, environment: 'MAINNET' }), /Invalid/);
  assert.equal(testPoolWithdrawal(config, { id: 'w2', owner, debitQuoteAtoms: 20_000_001n, expiresAtMs: 1_000_000 }).message.debitQuoteAtoms, 20_000_001n);
  assert.throws(() => testPoolWithdrawal(config, { id: 'w3', owner, debitQuoteAtoms: 1n << 128n, expiresAtMs: 1_000_000 }), /Invalid/);
});
