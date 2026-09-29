import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, test } from 'node:test';
import { solverRequestDigest, type SolverRequestMethod } from '@naryx/protocol-types';
import { NaryxApiError, NaryxSolverClient, type FetchLike } from '../src/index.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const signer = async (digest: Uint8Array) => new Uint8Array(sign(null, digest, privateKey));

/** A stand-in server that authenticates exactly as the API does and records what it saw. */
function verifyingFetch(seen: { method: string; path: string; verified: boolean }[]): FetchLike {
  return async (url, init) => {
    const path = url.replace('https://api.example', '');
    const body = init.body ?? '';
    const headers = init.headers;
    const digest = solverRequestDigest({
      method: init.method as SolverRequestMethod,
      pathAndQuery: path,
      bodySha256: new Uint8Array(createHash('sha256').update(body).digest()),
      solverId: headers['X-Naryx-Solver'] ?? '',
      keyId: headers['X-Naryx-Key'] ?? '',
      timestampMs: BigInt(headers['X-Naryx-Timestamp'] ?? '0'),
      nonce: headers['X-Naryx-Nonce'] ?? '',
    });
    const verified = verify(null, digest, publicKey, Buffer.from(headers['X-Naryx-Signature'] ?? '', 'hex'));
    seen.push({ method: init.method, path, verified });
    const status = verified ? 200 : 401;
    const payload = verified ? { accepted: true } : { error: { code: 'INVALID_SIGNATURE', message: 'bad' } };
    return { status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(payload) };
  };
}

describe('solver client', () => {
  test('signs every authenticated request over the exact method, path, and body bytes', async () => {
    const seen: { method: string; path: string; verified: boolean }[] = [];
    const client = new NaryxSolverClient({ baseUrl: 'https://api.example', solverId: 'solver-a', keyId: 'q-1', sign: signer, fetch: verifyingFetch(seen), now: () => 1_900_000_000_000 });
    await client.putCapacity({ solverId: 'solver-a', availableAtoms: 10n } as never);
    await client.cancelQuote('market-1', 'ab'.repeat(32));
    await client.getShard('cash-and-carry-v1.market-1');
    assert.deepEqual(seen.map((entry) => [entry.method, entry.path, entry.verified]), [
      ['PUT', '/v1/solver/capacity', true],
      ['POST', '/v1/solver/quotes/cancel', true],
      ['GET', '/v1/solver/quote-shards/cash-and-carry-v1.market-1', true],
    ]);
  });

  test('a signer for another key is rejected, and a malformed signature never leaves the client', async () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    const client = new NaryxSolverClient({
      baseUrl: 'https://api.example',
      solverId: 'solver-a',
      keyId: 'q-1',
      sign: async (digest) => new Uint8Array(sign(null, digest, other)),
      fetch: verifyingFetch([]),
    });
    await assert.rejects(client.putCapacity({} as never), (error: unknown) => error instanceof NaryxApiError && error.code === 'INVALID_SIGNATURE');
    const short = new NaryxSolverClient({ baseUrl: 'https://api.example', solverId: 'solver-a', keyId: 'q-1', sign: async () => new Uint8Array(10), fetch: verifyingFetch([]) });
    await assert.rejects(short.putCapacity({} as never), /64-byte signature/);
    assert.throws(() => new NaryxSolverClient({ baseUrl: 'http://api.example', solverId: 'a', keyId: 'b', sign: signer }), /HTTPS/);
  });
});
