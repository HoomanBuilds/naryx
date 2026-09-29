import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { solverRequestDigest, toHex, type SolverRequestInput } from '../src/index.js';

const request: SolverRequestInput = {
  method: 'PUT',
  pathAndQuery: '/v1/solver/quote-shards/cash-and-carry-v1.sol-carry',
  bodySha256: '11'.repeat(32),
  solverId: 'solver-a',
  keyId: 'q-1',
  timestampMs: 1_700_000_000_000n,
  nonce: '22'.repeat(32),
};

describe('solver request digest', () => {
  test('binds every field so a captured request cannot be redirected or replayed with another body', () => {
    const base = toHex(solverRequestDigest(request));
    for (const change of [
      { method: 'POST' as const },
      { pathAndQuery: '/v1/solver/kill-switch' },
      { bodySha256: '12'.repeat(32) },
      { solverId: 'solver-b' },
      { keyId: 'q-2' },
      { timestampMs: 1_700_000_000_001n },
      { nonce: '23'.repeat(32) },
    ]) {
      assert.notEqual(toHex(solverRequestDigest({ ...request, ...change })), base);
    }
  });

  test('only solver paths and supported methods are signable', () => {
    assert.throws(() => solverRequestDigest({ ...request, pathAndQuery: '/v1/markets' }), /solver/);
    assert.throws(() => solverRequestDigest({ ...request, pathAndQuery: '/v1/solver/a b' }), /printable/);
    assert.throws(() => solverRequestDigest({ ...request, method: 'DELETE' as never }), /unsupported method/);
    assert.throws(() => solverRequestDigest({ ...request, nonce: '22' }), /32/);
  });
});
