import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTestnetMarginAction } from '../src/testnet-dex-margin.js';

test('testnet margin setup permits only the exact same-owner bounded transfer', () => {
  const account = '0x1111111111111111111111111111111111111111';
  const action = { type: 'agentSendAsset', destination: account, sourceDex: '', destinationDex: 'sekaw',
    token: 'USDC:0xeb62eee3685fc4c43992febcd9e75443', amount: '20', fromSubAccount: '', nonce: 1000 };
  assert.doesNotThrow(() => validateTestnetMarginAction({ action, nonce: 1000 }, account));
  for (const change of [{ amount: '21' }, { destinationDex: 'spot' }, { sourceDex: 'sekaw' },
    { destination: '0x2222222222222222222222222222222222222222' }, { nonce: 999 }, { type: 'withdraw3' }]) {
    assert.throws(() => validateTestnetMarginAction({ action: { ...action, ...change }, nonce: 1000 }, account));
  }
});
