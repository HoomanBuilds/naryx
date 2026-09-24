import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  HASH_DOMAIN,
  MalformedInputError,
  domainHash,
  fromHex,
  toHex,
  type HashDomain,
} from '../src/index.js';
import { loadFixture, type EncodingFixture, type HashingFixture } from './fixtures.js';

const fixture = loadFixture<HashingFixture>('hashing.json');
const encodingFixture = loadFixture<EncodingFixture>('encoding.json');

describe('domain-separated hashing golden vectors', () => {
  for (const vector of fixture.vectors) {
    test(vector.name, () => {
      const digest = domainHash(vector.domain as HashDomain, fromHex(vector.payloadHex));
      assert.equal(toHex(digest), vector.digestHex);
      assert.equal(digest.length, 32);
    });
  }

  test('every registered domain carries a committed digest vector', () => {
    const covered = new Set(fixture.vectors.map((vector) => vector.domain));
    for (const domain of Object.values(HASH_DOMAIN)) {
      assert.equal(covered.has(domain), true, `${domain} has no golden vector`);
    }
  });

  test('the asset-amount payloads are the committed canonical asset-amount bytes', () => {
    const assetAmountHex = encodingFixture.vectors.find(
      (vector) => vector.name === 'asset-amount-negative-atoms',
    )?.hex;
    assert.equal(typeof assetAmountHex, 'string');
    for (const name of ['order-canonical-asset-amount-payload', 'quote-canonical-asset-amount-payload']) {
      const vector = fixture.vectors.find((candidate) => candidate.name === name);
      assert.equal(vector?.payloadHex, assetAmountHex, `${name} payload is stale`);
    }
  });
});

describe('every frozen v1 domain is separated', () => {
  const payload = fromHex(fixture.domainSeparationPayloadHex);

  test('the same payload produces a distinct digest per domain', () => {
    const digests = new Map<string, string>();
    for (const domain of Object.values(HASH_DOMAIN)) {
      const digest = toHex(domainHash(domain, payload));
      const collision = [...digests.entries()].find(([, value]) => value === digest);
      assert.equal(collision, undefined, `${domain} collided with ${collision?.[0]}`);
      digests.set(domain, digest);
    }
    assert.equal(digests.size, Object.keys(HASH_DOMAIN).length);
  });

  test('the frozen v1 prefixes are unchanged', () => {
    assert.deepEqual(
      Object.values(HASH_DOMAIN),
      [
        'CON/v1/order',
        'CON/v1/route',
        'CON/v1/route-accounts',
        'CON/v1/quote',
        'CON/v1/reservation-id',
        'CON/v1/solver-signature',
        'CON/v1/outcome',
        'CON/v1/receipt',
        'CON/v1/evidence-manifest',
        'CON/v1/benchmark-manifest',
        'CON/v1/benchmark-arm',
        'CON/v1/benchmark-pair',
        'CON/v1/package-template',
        'CON/v1/economic-strategy-series',
        'CON/v1/series-execution-class',
        'CON/v1/package-template-registry-record',
        'CON/v1/domain-manifest',
        'CON/v1/asset-manifest',
        'CON/v1/venue-manifest',
        'CON/v1/market-manifest',
        'CON/v1/adapter-manifest',
        'CON/v1/price-source-manifest',
        'CON/v1/domain-registry-record',
        'CON/v1/fee-policy',
        'CON/v1/solver-capability',
        'CON/v1/private-rfq-envelope',
      ],
    );
  });
});

describe('hashing fails closed', () => {
  test('an unregistered domain is rejected', () => {
    assert.throws(
      () => domainHash('CON/v1/not-a-domain' as HashDomain, new Uint8Array()),
      MalformedInputError,
    );
  });

  test('a non-byte payload is rejected', () => {
    assert.throws(
      () => domainHash(HASH_DOMAIN.ORDER, 'deadbeef' as unknown as Uint8Array),
      MalformedInputError,
    );
  });

  test('an empty payload still hashes the domain bytes', () => {
    assert.notEqual(
      toHex(domainHash(HASH_DOMAIN.ORDER, new Uint8Array())),
      toHex(domainHash(HASH_DOMAIN.RECEIPT, new Uint8Array())),
    );
  });
});
