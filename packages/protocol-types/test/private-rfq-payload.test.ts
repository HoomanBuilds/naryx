import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePrivateRfqQuoteRequest,
  decodePrivateRfqQuoteResponse,
  encodePrivateRfqQuoteRequest,
  encodePrivateRfqQuoteResponse,
  toHex,
} from '../src/index.js';

test('private RFQ quote payloads round trip protocol JSON and bind one order', () => {
  const orderHash = '55'.repeat(32);
  const request = decodePrivateRfqQuoteRequest(encodePrivateRfqQuoteRequest({ version: 1, orderHash }));
  assert.equal(request.version, 1);
  assert.equal(toHex(request.orderHash), orderHash);

  const response = { version: 1, quoteHash: '77'.repeat(32), netOutcomeAtoms: 5n };
  assert.deepEqual(decodePrivateRfqQuoteResponse(encodePrivateRfqQuoteResponse(response)), response);
});

test('private RFQ quote request rejects unknown fields and invalid UTF-8', () => {
  const text = JSON.stringify({ version: 1, orderHash: '55'.repeat(32), extra: true });
  assert.throws(() => decodePrivateRfqQuoteRequest(new TextEncoder().encode(text)), /only version and orderHash/);
  assert.throws(() => decodePrivateRfqQuoteRequest(new Uint8Array([0xff])), /must be UTF-8/);
});
