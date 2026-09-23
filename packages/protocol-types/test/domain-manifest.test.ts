import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  DuplicateElementError,
  MalformedInputError,
  RangeViolationError,
  domainManifest,
  domainManifestBytes,
  domainManifestHash,
  domainRefFromManifest,
  encodeDomainManifest,
  fromHex,
  toHex,
  type DomainManifest,
  type DomainManifestInput,
  type SettlementClass,
} from '../src/index.js';
import { loadFixture, type DomainManifestFixture } from './fixtures.js';

const fixture = loadFixture<DomainManifestFixture>('domain-manifest.json');

function fixtureInput(overrides: Partial<DomainManifestInput> = {}): DomainManifestInput {
  return {
    ...fixture,
    manifestVersion: Number(fixture.manifestVersion),
    runtimeClassVersion: Number(fixture.runtimeClassVersion),
    supportedSettlementClasses: fixture.supportedSettlementClasses as SettlementClass[],
    ...overrides,
  };
}

describe('domain manifest canonical identity', () => {
  test('canonical bytes and domain-separated digest match the golden vector', () => {
    const value = fixtureInput();
    const manifest = domainManifest(value);

    assert.deepEqual(manifest.supportedSettlementClasses, [
      'ATOMIC_POSTCONDITION',
      'BATCHED_IOC_WITH_RECOVERY',
    ]);
    assert.equal(toHex(domainManifestBytes(value)), fixture.canonicalHex);
    assert.equal(toHex(domainManifestHash(value)), fixture.digestHex);
  });

  test('the derived reference binds the manifest domain, version, and computed digest', () => {
    const reference = domainRefFromManifest(fixtureInput());
    assert.equal(reference.domainId, fixture.domainId);
    assert.equal(reference.domainManifestVersion, Number(fixture.manifestVersion));
    assert.equal(toHex(reference.domainManifestHash), fixture.digestHex);
  });

  test('a single field mutation produces a different identity', () => {
    const original = toHex(domainManifestHash(fixtureInput()));
    const changed = toHex(
      domainManifestHash(fixtureInput({ chainReference: 'test-domain-2' })),
    );
    assert.notEqual(changed, original);
  });
});

describe('domain manifest validation', () => {
  test('versions, identifiers, hashes, and settlement classes fail closed', () => {
    assert.throws(() => domainManifest(fixtureInput({ manifestVersion: 0 })), MalformedInputError);
    assert.throws(
      () => domainManifest(fixtureInput({ runtimeClassVersion: 0 })),
      MalformedInputError,
    );
    assert.throws(
      () => domainManifest(fixtureInput({ runtimeClassVersion: 0x1_0000_0000 })),
      RangeViolationError,
    );
    assert.throws(() => domainManifest(fixtureInput({ environment: '' })), MalformedInputError);
    assert.throws(
      () => domainManifest(fixtureInput({ chainReference: 'test-π' })),
      MalformedInputError,
    );
    assert.throws(
      () => domainManifest(fixtureInput({ executionVerifierCodeHash: new Uint8Array(32) })),
      MalformedInputError,
    );
    assert.throws(
      () => domainManifest(fixtureInput({ finalityPolicyHash: new Uint8Array(31) })),
      MalformedInputError,
    );
    assert.throws(
      () => domainManifest(fixtureInput({ supportedSettlementClasses: [] })),
      MalformedInputError,
    );
    assert.throws(
      () =>
        domainManifest(
          fixtureInput({
            supportedSettlementClasses: ['UNKNOWN'] as unknown as SettlementClass[],
          }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        domainManifest(
          fixtureInput({
            supportedSettlementClasses: [
              'ATOMIC_POSTCONDITION',
              'ATOMIC_POSTCONDITION',
            ],
          }),
        ),
      DuplicateElementError,
    );
  });

  test('caller mutation cannot change later encoding', () => {
    const verifierHash = fromHex(fixture.executionVerifierCodeHash);
    const finalityHash = fromHex(fixture.finalityPolicyHash);
    const settlementClasses: SettlementClass[] = [
      'BATCHED_IOC_WITH_RECOVERY',
      'ATOMIC_POSTCONDITION',
    ];
    const manifest = domainManifest(
      fixtureInput({
        executionVerifierCodeHash: verifierHash,
        finalityPolicyHash: finalityHash,
        supportedSettlementClasses: settlementClasses,
      }),
    );
    const before = toHex(domainManifestBytes(manifest));

    verifierHash[0] = 0xff;
    finalityHash[0] = 0xff;
    settlementClasses[0] = 'ATOMIC_POSTCONDITION';
    manifest.executionVerifierCodeHash[0] = 0xff;
    manifest.finalityPolicyHash[0] = 0xff;

    assert.equal(toHex(domainManifestBytes(manifest)), before);
    assert.equal(before, fixture.canonicalHex);
    assert.throws(
      () => (manifest.supportedSettlementClasses as SettlementClass[]).push('ATOMIC_POSTCONDITION'),
      TypeError,
    );
  });

  test('the encoder rejects a forged string hash before writing bytes', () => {
    const writer = new CanonicalWriter();
    const forged = {
      ...domainManifest(fixtureInput()),
      executionVerifierCodeHash: fixture.executionVerifierCodeHash,
    } as unknown as DomainManifest;

    assert.throws(() => encodeDomainManifest(writer, forged), MalformedInputError);
    assert.equal(writer.bytes().length, 0);
  });
});
