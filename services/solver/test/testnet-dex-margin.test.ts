import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTestnetMarginAction, validateTestnetIsolatedLeverageAction } from '../src/testnet-dex-margin.js';

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

test('testnet leverage setup cannot change market, increase leverage or enable cross margin', () => {
  const action = { type: 'updateLeverage', asset: 390000, isCross: false, leverage: 5 };
  assert.doesNotThrow(() => validateTestnetIsolatedLeverageAction({ action, nonce: 1000 }));
  for (const change of [{ asset: 0 }, { leverage: 6 }, { isCross: true }, { type: 'order' }]) {
    assert.throws(() => validateTestnetIsolatedLeverageAction({ action: { ...action, ...change }, nonce: 1000 }));
  }
});
