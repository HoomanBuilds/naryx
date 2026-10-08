import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MalformedInputError,
  assetRef,
  domainRef,
  nettingInstrumentHash,
  nettingPolicyManifest,
  nettingPolicyManifestHash,
  toHex,
  versionedManifestRef,
  type NettingInstrumentPolicyInput,
  type NettingPolicyManifestInput,
} from '../src/index.js';

const id = (n: number): string => n.toString(16).padStart(64, '0');

function instrument(instrumentId: string, seed: number): NettingInstrumentPolicyInput {
  return {
    instrumentId,
    domain: domainRef(`svm:${instrumentId}`, 1, id(seed)),
    adapter: { adapterId: `adapter-${instrumentId}`, adapterManifestVersion: 1, adapterManifestHash: id(seed + 1) },
    venue: versionedManifestRef(`venue-${instrumentId}`, 1, id(seed + 2)),
    market: versionedManifestRef(`market-${instrumentId}`, 1, id(seed + 3)),
    quantityAsset: assetRef(`asset-${instrumentId}`, id(seed + 4), 6),
    quoteAsset: assetRef('usdc', id(99), 6),
    legFamily: 'PERP_OPEN',
    quantityIncrementAtoms: 10n,
    priceTickQuoteAtoms: 1n,
  };
}

function policy(overrides: Partial<NettingPolicyManifestInput> = {}): NettingPolicyManifestInput {
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    nettingPolicyVersion: 2,
    environment: 'testnet',
    executionClassId: 'cross-user-netting-v1',
    executionClassVersion: 1,
    executionClassManifestHash: id(40),
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
    allocationRule: 'PRO_RATA_SEQUENCE',
    externalExecutionMode: 'EXACT_NET_ONLY',
    clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
    maximumObligations: 32,
    maximumBatchWindowMilliseconds: 500n,
    instruments: [instrument('sol', 1), instrument('eth', 10)],
    ...overrides,
  };
}

describe('netting policy manifest', () => {
  test('canonicalizes instrument order and binds exact executable identity', () => {
    const input = policy();
    const reversed = policy({ instruments: [...input.instruments].reverse() });
    assert.equal(toHex(nettingPolicyManifestHash(input)), toHex(nettingPolicyManifestHash(reversed)));
    assert.deepEqual(nettingPolicyManifest(reversed).instruments.map((value) => value.instrumentId), ['eth', 'sol']);
    assert.notEqual(
      toHex(nettingInstrumentHash(input.instruments[0]!)),
      toHex(nettingInstrumentHash({ ...input.instruments[0]!, market: versionedManifestRef('other-market', 1, id(99)) })),
    );
  });

  test('economic and operational bounds change the policy identity', () => {
    const input = policy();
    for (const changed of [
      policy({ maximumObligations: 31 }),
      policy({ maximumBatchWindowMilliseconds: 750n }),
      policy({ settlementClass: 'ASYNC_BONDED_SOLVER' }),
      policy({ clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR', instruments: input.instruments.map((value, index) => index === 0 ? { ...value, priceTickQuoteAtoms: 2n } : value) }),
    ]) {
      assert.notEqual(toHex(nettingPolicyManifestHash(input)), toHex(nettingPolicyManifestHash(changed)));
    }
  });

  test('rejects unimplemented versions, empty bounds, and ambiguous instruments', () => {
    assert.throws(() => nettingPolicyManifest(policy({ schemaVersion: 2 })), MalformedInputError);
    assert.throws(() => nettingPolicyManifest(policy({ nettingPolicyVersion: 1 })), MalformedInputError);
    assert.throws(() => nettingPolicyManifest(policy({ maximumObligations: 0 })), MalformedInputError);
    assert.throws(() => nettingPolicyManifest(policy({ maximumBatchWindowMilliseconds: 0n })), MalformedInputError);
    assert.throws(() => nettingPolicyManifest(policy({ instruments: [] })), MalformedInputError);
    assert.throws(
      () => nettingPolicyManifest(policy({ instruments: [instrument('sol', 1), instrument('sol', 20)] })),
      /instrument ids repeat/,
    );
  });
});
