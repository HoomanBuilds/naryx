import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assetRef,
  positionSnapshotRecordHash,
  samePositionSnapshot,
  toHex,
  type NormalizedPositionInput,
  type PositionSnapshotRecordInput,
} from '../src/index.js';
import { DOMAIN, USD } from './solver-fixtures.js';

const SOL = assetRef('sol', '55'.repeat(32), 9);
const price = (quoteAtoms: bigint, baseAtoms: bigint) => ({ baseAsset: SOL, quoteAsset: USD, quoteAtoms, baseAtoms, roundingDirection: 'FLOOR' }) as const;

function position(snapshotId: string, overrides: Partial<NormalizedPositionInput> = {}): NormalizedPositionInput {
  return {
    adapterVersion: 1,
    snapshotId,
    domain: DOMAIN,
    observedAtMs: 1_000n,
    owner: 'strategy-1',
    venueId: 'hypercore',
    marketId: 'sol-perp',
    underlyingId: 'sol',
    positionType: 'PERPETUAL',
    quantityBaseAtoms: -10_000_000_000n,
    markPrice: price(3n, 20n),
    liquidationPrice: price(9n, 50n),
    collateralQuoteAtoms: 150_000_000n,
    dependencyIds: ['venue:hypercore'],
    riskDomainId: 'sol-carry',
    closeRoutes: [{ routeId: 'ioc-close', executableQuantityAtoms: 10_000_000_000n, expectedCostQuoteAtoms: 1_000_000n, settlementDelayMs: 1_000n, authorityHeld: true, requiredDependencyIds: ['venue:hypercore'] }],
    ...overrides,
  };
}

function record(overrides: Partial<PositionSnapshotRecordInput> = {}): PositionSnapshotRecordInput {
  return {
    recordVersion: 1,
    environment: 'testnet',
    strategyAccount: 'strategy-1',
    sourceId: 'hypercore-testnet-info',
    observedAtMs: 1_500n,
    positions: [position('b-perp'), position('a-spot', { positionType: 'SPOT', quantityBaseAtoms: 10_000_000_000n, marketId: 'sol-spot' })],
    unmappedInstruments: ['DOGE'],
    sourceEvidenceHash: '61'.repeat(32),
    authority: 'position-key-1',
    signature: new Uint8Array(64).fill(7),
    ...overrides,
  };
}

describe('position snapshot records', () => {
  test('one observation has one hash whatever order its positions arrive in, and the signature is not hashed', () => {
    const base = record();
    const reversed = record({ positions: [...base.positions].reverse(), signature: new Uint8Array(64).fill(9) });
    assert.equal(samePositionSnapshot(base, reversed), true);
    const routed = (routes: NormalizedPositionInput['closeRoutes']) => record({ positions: base.positions.map((entry) => ({ ...entry, closeRoutes: routes })) });
    const first = { routeId: 'ioc-a', executableQuantityAtoms: 1n, expectedCostQuoteAtoms: 1n, settlementDelayMs: 1n, authorityHeld: true, requiredDependencyIds: [] };
    const second = { ...first, routeId: 'ioc-b', expectedCostQuoteAtoms: 2n };
    assert.equal(samePositionSnapshot(routed([first, second]), routed([second, first])), true, 'close route order carries no meaning');
    assert.throws(() => positionSnapshotRecordHash(routed([first, first])), /route ids? repeats?/);
    for (const changed of [
      { positions: [position('b-perp', { quantityBaseAtoms: -9_000_000_000n })] },
      { positions: [position('b-perp', { liquidationPrice: undefined } as never)] },
      { unmappedInstruments: [] },
      { sourceEvidenceHash: '62'.repeat(32) },
      { observedAtMs: 1_501n },
    ]) {
      assert.notEqual(toHex(positionSnapshotRecordHash(record(changed))), toHex(positionSnapshotRecordHash(base)));
    }
  });

  test('a snapshot holds only its own account, observed no later than itself, each position once', () => {
    assert.throws(() => positionSnapshotRecordHash(record({ positions: [position('x', { owner: 'strategy-2' })] })), /belongs to another account/);
    assert.throws(() => positionSnapshotRecordHash(record({ positions: [position('x', { observedAtMs: 1_501n })] })), /observed after the snapshot/);
    assert.throws(() => positionSnapshotRecordHash(record({ positions: [position('x'), position('x')] })), /repeat/);
    assert.throws(() => positionSnapshotRecordHash(record({ unmappedInstruments: ['DOGE', 'DOGE'] })), /repeat/);
  });

  test('an empty snapshot matches its golden vector', () => {
    assert.equal(
      toHex(positionSnapshotRecordHash(record({ positions: [], unmappedInstruments: [] }))),
      '4234a1323a817767f242cd7b77516361c54893a6d0d5e36e00aff66c6e3e4932',
    );
  });
});
