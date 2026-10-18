import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { assetRef, domainRef } from '@naryx/protocol-types';
import { HyperliquidPooledCollateralStore } from '../src/hyperliquid-pooled-collateral-store.js';
import { HyperliquidPoolFundingService } from '../src/hyperliquid-pool-funding.js';
import { HyperliquidPoolWithdrawalService } from '../src/hyperliquid-pool-withdrawal.js';
import { createPoolBrowserCommands, poolBrowserTypedData } from '../src/hyperliquid-pool-browser.js';

test('browser pool requests bind wallet, action, payload, expiry and dedicated pool identity', async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const owner = wallet.address.toLowerCase() as `0x${string}`;
  const hash = `0x${'11'.repeat(32)}` as const;
  let now = 1_000_000;
  const store = new HyperliquidPooledCollateralStore(':memory:', { version: 1, environment: 'TESTNET',
    domain: domainRef('hypercore:testnet', 1, hash), poolAccount: '0x1111111111111111111111111111111111111111',
    policyHash: hash, maximumTotalQuoteAtoms: 20_000_000n, quoteAsset: assetRef('test-usdc', hash, 6),
    collateralTokenId: `0x${'11'.repeat(16)}`, dedicatedTestOwners: [owner] });
  const reads = { async flat(): Promise<never> { throw new Error('Unexpected venue read'); },
    async transfer(): Promise<never> { throw new Error('Unexpected venue read'); } };
  const commands = createPoolBrowserCommands({ store, funding: new HyperliquidPoolFundingService(store, reads, () => now),
    withdrawals: new HyperliquidPoolWithdrawalService(store, reads, { async send() { throw new Error('Unexpected transfer'); } }) }, () => now);
  try {
    const request = { owner, action: 'member' as const, payload: {}, expiresAtMs: now + 120_000 };
    const signature = await wallet.signTypedData(poolBrowserTypedData(store, owner, request.action, request.payload, request.expiresAtMs));
    const response = await commands('execute', { ...request, signature });
    assert.deepEqual(response, { owner, enrolled: false, balanceQuoteAtoms: 0n, poolBusy: false, observedAtMs: now, operations: [] });
    assert.equal('members' in (response as object), false);
    await assert.rejects(commands('execute', { ...request, signature: await other.signTypedData(
      poolBrowserTypedData(store, owner, request.action, request.payload, request.expiresAtMs)) }), /signature/);
    await assert.rejects(commands('execute', { ...request, action: 'withdrawal-submit', payload: { id: 'other' }, signature }), /signature/);
    await assert.rejects(commands('execute', { ...request, payload: { id: 'unexpected' }, signature }), /Invalid/);
    await assert.rejects(commands('execute', { ...request, owner: other.address.toLowerCase(), signature }), /Dedicated/);
    const withdrawal = { owner, action: 'withdrawal-submit' as const, payload: { id: 'missing' }, expiresAtMs: request.expiresAtMs };
    await assert.rejects(commands('execute', { ...withdrawal, signature: await wallet.signTypedData(poolBrowserTypedData(
      store, owner, withdrawal.action, withdrawal.payload, withdrawal.expiresAtMs)) }), /does not belong/);
    now = request.expiresAtMs;
    await assert.rejects(commands('execute', { ...request, signature }), /expired/);
    assert.equal(store.pending(), undefined);
  } finally { store.close(); }
});
