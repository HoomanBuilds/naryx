import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTestnetUnwindAction } from '../src/testnet-netting-unwind.js';

test('controlled unwind permits only the exact reduce-only testnet BTC close', () => {
  const expected = { asset: 3, buy: false, price: '80000' };
  const order = { a: 3, b: false, p: '80000', s: '0.0002', r: true, t: { limit: { tif: 'Ioc' } } };
  const payload = { action: { type: 'order', grouping: 'na', orders: [order] }, nonce: 1000 };
  assert.doesNotThrow(() => validateTestnetUnwindAction(payload, expected));
  for (const change of [{ r: false }, { s: '0.0003' }, { b: true }, { a: 0 }, { p: '1' }]) {
    assert.throws(() => validateTestnetUnwindAction({ ...payload, action: { ...payload.action, orders: [{ ...order, ...change }] } }, expected));
  }
  assert.throws(() => validateTestnetUnwindAction({ ...payload, vaultAddress: '0x1111111111111111111111111111111111111111' }, expected));
  assert.throws(() => validateTestnetUnwindAction({ ...payload, nonce: 0 }, expected));
  const passive = { a: 390000, b: true, p: '80000', s: '0.0002', r: true, t: { limit: { tif: 'Gtc' } } };
  assert.doesNotThrow(() => validateTestnetUnwindAction({ ...payload, action: { ...payload.action, orders: [passive] } },
    { asset: 390000, buy: true, price: '80000', tif: 'Gtc' }));
  assert.throws(() => validateTestnetUnwindAction({ ...payload, action: { ...payload.action, orders: [{ ...order, t: passive.t }] } },
    { ...expected, tif: 'Gtc' }));
});
