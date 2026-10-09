import assert from 'node:assert/strict';
import test from 'node:test';
import type { HyperliquidStrategyExecutionPlan } from '@naryx/adapter-hyperliquid';
import { assetRef, commitmentHash, domainRef, exactPrice } from '@naryx/protocol-types';
import {
  HYPERCORE_LOCAL_CONFORMANCE_EVIDENCE_CLASS,
  HypercoreLocalConformanceVenue,
  HyperliquidStrategyTestnetRuntime,
} from '../src/index.js';
import { trustedTimePort } from './hyperliquid-trusted-time-fixture.js';

const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'22'.repeat(20)}` as const;
const agentWallet = `0x${'33'.repeat(20)}` as const;
const account = { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' as const };

function hash(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function plan(attempt: number, action: 'ENTRY' | 'EXIT'): HyperliquidStrategyExecutionPlan {
  const spotDelta = action === 'ENTRY' ? 1_000n : -1_000n;
  const perpDelta = -spotDelta;
  const baseAsset = assetRef('SOL', hash(10), 9);
  const quoteAsset = assetRef('USDC', hash(11), 6);
  const price = exactPrice({ baseAsset, quoteAsset, quoteAtoms: 20n, baseAtoms: 1n,
    roundingDirection: 'CEIL' });
  const orders = [
    {
      legId: 'spot', stage: 0, baseAsset, quoteAsset,
      signedBaseDeltaAtoms: spotDelta, limitPrice: price,
      clientOrderId: `0x${attempt.toString(16).padStart(2, '0').repeat(16)}` as `0x${string}`,
      wire: {
        a: 10_007, b: spotDelta > 0n, p: '20', s: '0.000001', r: false,
        t: { limit: { tif: 'Ioc' as const } },
        c: `0x${attempt.toString(16).padStart(2, '0').repeat(16)}` as `0x${string}`,
      },
    },
    {
      legId: 'perp', stage: 0, baseAsset, quoteAsset,
      signedBaseDeltaAtoms: perpDelta, limitPrice: price,
      clientOrderId: `0x${(attempt + 1).toString(16).padStart(2, '0').repeat(16)}` as `0x${string}`,
      wire: {
        a: 3, b: perpDelta > 0n, p: '20', s: '0.000001', r: action === 'EXIT',
        t: { limit: { tif: 'Ioc' as const } },
        c: `0x${(attempt + 1).toString(16).padStart(2, '0').repeat(16)}` as `0x${string}`,
      },
    },
  ] as const;
  return {
    version: 1,
    guarantee: 'BATCHED_IOC_WITH_BOUNDED_RECOVERY',
    domain: domainRef('hypercore:testnet', 1, hash(1)),
    orderHash: commitmentHash(hash(attempt + 20)),
    graphHash: commitmentHash(hash(attempt + 30)),
    quoteHash: commitmentHash(hash(attempt + 40)),
    routeHash: commitmentHash(hash(attempt + 50)),
    requestExpiryMs: 100_000n,
    orders,
    batches: [{ stage: 0, action: { type: 'order', grouping: 'na',
      orders: orders.map((order) => order.wire) }, legIds: orders.map((order) => order.legId) }],
    recoveryAuthorizations: orders.map((order) => ({
      legId: order.legId,
      action: 'COMPLETE' as const,
      maximumQuantityAtoms: 1_000n,
      maximumCostQuoteAtoms: 20_000n,
    })),
    maximumRecoveryCostQuoteAtoms: 40_000n,
  };
}

function runtime(venue: HypercoreLocalConformanceVenue) {
  let nowMs = 1_000;
  return new HyperliquidStrategyTestnetRuntime(venue, venue, venue, {
    account,
    agentWallet,
    signerLeaseId: 'local-conformance-solver',
    maxEvidenceAgeMs: 30_000,
    maxSnapshotSkewMs: 5_000,
    maxFillPages: 4,
    evidenceBinding: {
      spotAssetId: 10_007,
      perpetualAssetId: 3,
      baseFeeToken: 'SOL',
      quoteFeeToken: 'USDC',
    },
    trustedTime: trustedTimePort(1_000),
    currentTimeMs: () => nowMs++,
  });
}

test('executes entry and exit through the local HyperCore conformance venue', async () => {
  const venue = new HypercoreLocalConformanceVenue();
  assert.equal((await runtime(venue).execute('entry-success', plan(1, 'ENTRY'))).status,
    'COMPLETED');
  assert.deepEqual(venue.snapshot().positions, [
    { assetIndex: 3, signedBaseAtoms: -1_000n },
    { assetIndex: 10_007, signedBaseAtoms: 1_000n },
  ]);
  assert.equal((await runtime(venue).execute('exit-success', plan(3, 'EXIT'))).status,
    'COMPLETED');
  assert.deepEqual(venue.snapshot().positions, [
    { assetIndex: 3, signedBaseAtoms: 0n },
    { assetIndex: 10_007, signedBaseAtoms: 0n },
  ]);
  assert.equal(venue.snapshot().evidenceClass, HYPERCORE_LOCAL_CONFORMANCE_EVIDENCE_CLASS);
});

test('forces one-leg failure, enforces recovery caps, completes recovery, and exits', async () => {
  const entry = plan(5, 'ENTRY');
  const cappedVenue = new HypercoreLocalConformanceVenue();
  const cappedEntry = { ...entry, maximumRecoveryCostQuoteAtoms: 19_999n };
  cappedVenue.armOneLegNoFill({ attemptId: 'entry-capped', batchStage: 0, legId: 'perp' });
  assert.equal((await runtime(cappedVenue).execute('entry-capped', cappedEntry)).status,
    'RECOVERY_REQUIRED');
  assert.throws(() => cappedVenue.recover('entry-capped', cappedEntry),
    /aggregate recovery cost exceeds authorization/);
  assert.deepEqual(cappedVenue.snapshot().positions, [
    { assetIndex: 3, signedBaseAtoms: 0n },
    { assetIndex: 10_007, signedBaseAtoms: 1_000n },
  ]);

  const venue = new HypercoreLocalConformanceVenue();
  venue.armOneLegNoFill({ attemptId: 'entry-recovery', batchStage: 0, legId: 'perp' });
  assert.equal((await runtime(venue).execute('entry-recovery', entry)).status,
    'RECOVERY_REQUIRED');
  assert.deepEqual(venue.snapshot().positions, [
    { assetIndex: 3, signedBaseAtoms: 0n },
    { assetIndex: 10_007, signedBaseAtoms: 1_000n },
  ]);
  const recovery = venue.recover('entry-recovery', entry);
  assert.equal(recovery.status, 'COMPLETED');
  assert.equal(recovery.aggregateCostQuoteAtoms, 20_000n);
  assert.equal(recovery.evidenceClass, HYPERCORE_LOCAL_CONFORMANCE_EVIDENCE_CLASS);
  assert.deepEqual(venue.snapshot().positions, [
    { assetIndex: 3, signedBaseAtoms: -1_000n },
    { assetIndex: 10_007, signedBaseAtoms: 1_000n },
  ]);
  assert.equal((await runtime(venue).execute('exit-after-recovery', plan(7, 'EXIT'))).status,
    'COMPLETED');
  assert.ok(venue.snapshot().positions.every((position) => position.signedBaseAtoms === 0n));
  assert.throws(() => venue.recover('entry-recovery', entry), /already recovered/);
});
