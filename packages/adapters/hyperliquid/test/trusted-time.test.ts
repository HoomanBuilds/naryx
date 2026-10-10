import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateHyperliquidTrustedNonce } from '../src/trusted-time.js';

test('trusted nonce allocation never exceeds the trusted future lead', () => {
  assert.equal(allocateHyperliquidTrustedNonce(1_000n, 900n, 100n), 1_000n);
  assert.equal(allocateHyperliquidTrustedNonce(1_000n, 1_099n, 100n), 1_100n);
  assert.throws(() => allocateHyperliquidTrustedNonce(1_000n, 1_100n, 100n), /beyond trusted time policy/);
});
