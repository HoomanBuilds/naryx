import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MalformedInputError,
  RangeViolationError,
  cashCarrySeriesBindingV1,
  cashCarrySeriesBindingV1Bytes,
  cashCarrySeriesBindingV1Hash,
  cashCarrySeriesIdentityKey,
  domainRef,
  domainRefIdentityHash,
  protocolIdIdentityHash,
  settlementClassIdentityHash,
  toHex,
  type CashCarrySeriesBindingV1Input,
} from '../src/index.js';

function binding(
  overrides: Partial<CashCarrySeriesBindingV1Input> = {},
): CashCarrySeriesBindingV1Input {
  return {
    schemaVersion: 1,
    bindingVersion: 9,
    domain: domainRef('eip155:8453', 7, '11'.repeat(32)),
    seriesManifestHash: '22'.repeat(32),
    executionClassManifestHash: '33'.repeat(32),
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    templateManifestHash: '44'.repeat(32),
    settlementClass: 'ATOMIC_POSTCONDITION',
    settlementClassVersion: 1,
    baseAsset: {
      subjectIdentity: '55'.repeat(32),
      manifestVersion: 3,
      manifestHash: '66'.repeat(32),
    },
    quoteAsset: {
      subjectIdentity: '77'.repeat(32),
      manifestVersion: 4,
      manifestHash: '88'.repeat(32),
    },
    quoteConvention: 'annualized-net-yield-v1',
    entrySide: 'ASK',
    spotBaseAtomsPerPackageUnit: 1_000_000_000n,
    perpQuantityAtomsPerPackageUnit: 1_000_000n,
    ...overrides,
  };
}

describe('cash carry series binding v1', () => {
  test('matches the canonical cross-runtime vector', () => {
    const value = binding();
    assert.equal(
      toHex(domainRefIdentityHash(value.domain)),
      '5c3367ef36475ec11ad5b392fc85a349b37d2fdad631c8da833aa0796897c14c',
    );
    assert.equal(
      toHex(protocolIdIdentityHash(value.templateId)),
      'f124d7a5a2309c590f307ea911f59dc36c0dfc4203d081ac2fc05d0ee0a8206e',
    );
    assert.equal(
      toHex(protocolIdIdentityHash(value.quoteConvention)),
      '94f75da5f71975ba08a0bf694c183715be548bdce998210ac5924669c9c701a5',
    );
    assert.equal(
      toHex(settlementClassIdentityHash(value.settlementClass, value.settlementClassVersion)),
      'd859a5e58ad327a34dc770b146a6120cda0a194dd25734f9fec462a18e11e596',
    );
    assert.equal(
      toHex(cashCarrySeriesIdentityKey(value)),
      'f3d7bc7a8c6cb3ac5a0b3ca45dfdd333143cb8af576749057e34cb6383840a5d',
    );
    assert.equal(
      toHex(cashCarrySeriesBindingV1Bytes(value)),
      '0000000100000009' +
        '5c3367ef36475ec11ad5b392fc85a349b37d2fdad631c8da833aa0796897c14c' +
        '22'.repeat(32) +
        '33'.repeat(32) +
        'f124d7a5a2309c590f307ea911f59dc36c0dfc4203d081ac2fc05d0ee0a8206e' +
        '00000001' +
        '44'.repeat(32) +
        'd859a5e58ad327a34dc770b146a6120cda0a194dd25734f9fec462a18e11e596' +
        '55'.repeat(32) +
        '00000003' +
        '66'.repeat(32) +
        '77'.repeat(32) +
        '00000004' +
        '88'.repeat(32) +
        '94f75da5f71975ba08a0bf694c183715be548bdce998210ac5924669c9c701a5' +
        '01' +
        '0000000000000000000000003b9aca00' +
        '000000000000000000000000000f4240',
    );
    assert.equal(
      toHex(cashCarrySeriesBindingV1Hash(value)),
      'e13ea9e6a47163a913f5caacd460b6ab8bc63e9c91ee46610efd30838870711b',
    );
  });

  test('units, asset references, and the exact domain alter their bound identities', () => {
    const original = binding();
    const originalBindingHash = toHex(cashCarrySeriesBindingV1Hash(original));
    assert.notEqual(
      toHex(
        cashCarrySeriesBindingV1Hash(
          binding({ spotBaseAtomsPerPackageUnit: 1_000_000_001n }),
        ),
      ),
      originalBindingHash,
    );
    assert.notEqual(
      toHex(
        cashCarrySeriesBindingV1Hash(
          binding({
            baseAsset: {
              subjectIdentity: '99'.repeat(32),
              manifestVersion: 3,
              manifestHash: '66'.repeat(32),
            },
          }),
        ),
      ),
      originalBindingHash,
    );
    const changedDomain = binding({
      domain: domainRef('eip155:8453', 8, '11'.repeat(32)),
    });
    assert.notEqual(
      toHex(cashCarrySeriesIdentityKey(changedDomain)),
      toHex(cashCarrySeriesIdentityKey(original)),
    );
    assert.notEqual(
      toHex(cashCarrySeriesBindingV1Hash(changedDomain)),
      originalBindingHash,
    );
  });

  test('binds the async bonded class under its own identity and refuses every other class', () => {
    const atomic = binding();
    const async = binding({ settlementClass: 'ASYNC_BONDED_SOLVER' });
    assert.equal(cashCarrySeriesBindingV1(async).settlementClass, 'ASYNC_BONDED_SOLVER');
    assert.notEqual(toHex(cashCarrySeriesBindingV1Hash(async)), toHex(cashCarrySeriesBindingV1Hash(atomic)));
    assert.equal(toHex(cashCarrySeriesIdentityKey(async)), toHex(cashCarrySeriesIdentityKey(atomic)));
    for (const settlementClass of ['BATCHED_IOC_WITH_RECOVERY', 'CROSS_DOMAIN_PREPOSITIONED', 'MANUAL_CONTROLLED_RECOVERY'] as const) {
      assert.throws(() => cashCarrySeriesBindingV1(binding({ settlementClass })), MalformedInputError);
    }
    assert.throws(
      () => cashCarrySeriesBindingV1(binding({ settlementClass: 'ASYNC_BONDED_SOLVER', settlementClassVersion: 2 })),
      MalformedInputError,
    );
  });

  test('unsupported side or quote convention fails closed', () => {
    assert.throws(
      () => cashCarrySeriesBindingV1(binding({ entrySide: 'BID' as never })),
      MalformedInputError,
    );
    assert.throws(
      () => cashCarrySeriesBindingV1(binding({ quoteConvention: 'gross-basis-v1' })),
      MalformedInputError,
    );
  });

  test('zero, overflow, and identical assets fail closed', () => {
    assert.throws(
      () => cashCarrySeriesBindingV1(binding({ spotBaseAtomsPerPackageUnit: 0n })),
      MalformedInputError,
    );
    assert.throws(
      () =>
        cashCarrySeriesBindingV1(
          binding({ perpQuantityAtomsPerPackageUnit: 1n << 128n }),
        ),
      RangeViolationError,
    );
    assert.throws(
      () => cashCarrySeriesBindingV1(binding({ quoteAsset: binding().baseAsset })),
      MalformedInputError,
    );
  });
});
