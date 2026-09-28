import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MalformedInputError,
  parseProtocolJson,
  stringifyProtocolJson,
} from '../src/index.js';

test('protocol JSON round-trips exact integers and bytes', () => {
  const value = Object.freeze({
    version: 1,
    nonce: (1n << 255n) + 7n,
    hash: Uint8Array.from([0, 1, 254, 255]),
    nested: Object.freeze([Object.freeze({ amount: 0n })]),
  });
  const text = stringifyProtocolJson(value);
  assert.equal(text, '{"hash":{"$naryxType":"bytes","value":"0001feff"},"nested":[{"amount":{"$naryxType":"bigint","value":"0"}}],"nonce":{"$naryxType":"bigint","value":"57896044618658097711785492504343953926634992332820282019728792003956564819975"},"version":1}');
  const decoded = parseProtocolJson(text) as typeof value;
  assert.equal(decoded.version, 1);
  assert.equal(decoded.nonce, value.nonce);
  assert.deepEqual(decoded.hash, value.hash);
  assert.equal(decoded.nested[0]?.amount, 0n);
});

test('protocol JSON rejects malformed and ambiguous scalar tags', () => {
  for (const text of [
    '{"$naryxType":"bigint","value":"01"}',
    '{"$naryxType":"bytes","value":"0A"}',
    '{"$naryxType":"future","value":"1"}',
    '{"$naryxType":"bigint","value":"1","extra":true}',
  ]) {
    assert.throws(
      () => parseProtocolJson(text),
      (error: unknown) => error instanceof MalformedInputError,
    );
  }
});
