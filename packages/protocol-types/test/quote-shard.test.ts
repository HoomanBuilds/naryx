import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  admitShardUpdate,
  checkShardSettlement,
  domainRef,
  packageQuoteShard,
  packageQuoteShardHash,
  prepareShardBatch,
  prepareShardHeartbeat,
  prepareShardKillSwitch,
  prepareShardReprice,
  toHex,
  type PackageQuoteLevel,
  type PackageQuoteShardInput,
  type ShardSettlementRequest,
} from '../src/index.js';

const level = (levelId: bigint, direction: 'BID' | 'ASK', referenceOffset: bigint, size = 10n): PackageQuoteLevel => ({
  levelId,
  direction,
  size,
  referenceOffset,
  maximumFee: 5n,
  settlementClass: 'ATOMIC_POSTCONDITION',
  quoteMode: 'FIRM_ONCHAIN',
  validUntilUnit: 'EVM_UNIX_SECONDS',
  validUntilValue: 1_000n,
  reservationPolicy: 'RESERVE_ON_ACCEPT',
});

const shard: PackageQuoteShardInput = {
  shardVersion: 1,
  environment: 'local',
  domain: domainRef('evm:base-sepolia', 1, '22'.repeat(32)),
  solverId: 'solver-a',
  templateId: 'cash-and-carry-v1',
  marketGroupId: 'sol-carry',
  referenceStateHash: '31'.repeat(32),
  referenceSequence: 1n,
  quoteLevels: [level(1n, 'BID', -5n), level(2n, 'ASK', 5n)],
  inventoryCap: 100n,
  reservedCapacity: 80n,
  heartbeatExpiry: 500n,
  shardSequence: 1n,
  killSwitchState: 'INACTIVE',
  signature: new Uint8Array(64).fill(9),
};

const settle = (overrides: Partial<ShardSettlementRequest> = {}): ShardSettlementRequest => ({
  boundShardHash: packageQuoteShardHash(shard),
  referenceStateHash: '31'.repeat(32),
  referenceSequence: 1n,
  referencePriceTicks: 1_000n,
  levelId: 2n,
  takerSide: 'BUY',
  size: 10n,
  fee: 5n,
  atValue: 100n,
  ...overrides,
});

describe('package quote shard', () => {
  test('rejects self-crossing levels, repeated ids, and over-reserved capacity', () => {
    assert.throws(() => packageQuoteShard({ ...shard, quoteLevels: [level(1n, 'BID', 5n), level(2n, 'ASK', 5n)] }), /crosses itself/);
    assert.throws(() => packageQuoteShard({ ...shard, quoteLevels: [level(1n, 'BID', -5n), level(1n, 'ASK', 5n)] }), /repeat/);
    assert.throws(() => packageQuoteShard({ ...shard, reservedCapacity: 101n }), /exceeds the inventory cap/);
  });

  test('the signature is excluded from the shard hash', () => {
    assert.equal(toHex(packageQuoteShardHash({ ...shard, signature: new Uint8Array(64).fill(1) })), toHex(packageQuoteShardHash(shard)));
    assert.notEqual(toHex(packageQuoteShardHash({ ...shard, heartbeatExpiry: 501n })), toHex(packageQuoteShardHash(shard)));
  });

  test('batch place, replace, cancel, and cancel-all advance the sequence by one', () => {
    const placed = prepareShardBatch(shard, [{ op: 'PLACE', level: level(3n, 'ASK', 8n) }, { op: 'REPLACE', level: level(2n, 'ASK', 6n, 20n) }, { op: 'CANCEL', levelId: 1n }]);
    assert.equal(placed.shardSequence, 2n);
    assert.deepEqual(packageQuoteShard(placed).quoteLevels.map((entry) => [entry.levelId, entry.referenceOffset, entry.size]), [[2n, 6n, 20n], [3n, 8n, 10n]]);
    assert.equal(packageQuoteShard(prepareShardBatch(shard, [{ op: 'CANCEL_ALL' }])).quoteLevels.length, 0);
    assert.throws(() => prepareShardBatch(shard, [{ op: 'PLACE', level: level(1n, 'BID', -9n) }]), /replace it instead/);
    assert.throws(() => prepareShardBatch(shard, [{ op: 'CANCEL', levelId: 9n }]), /no such level/);
    assert.throws(() => prepareShardBatch(shard, [{ op: 'PLACE', level: level(4n, 'BID', 7n) }]), /crosses itself/);
  });

  test('updates are owner-scoped, sequence-monotonic, idempotent, and replay protected', () => {
    const next = { ...prepareShardHeartbeat(shard, 900n), signature: new Uint8Array(64).fill(2) };
    assert.deepEqual(admitShardUpdate(shard, { ...next, solverId: 'solver-b' }), { accepted: false, reason: 'IDENTITY_CHANGED' });
    const admitted = admitShardUpdate(shard, next);
    assert.ok(admitted.accepted && !admitted.duplicate);
    const repeat = admitShardUpdate(next, next);
    assert.ok(repeat.accepted && repeat.duplicate);
    assert.deepEqual(admitShardUpdate(next, { ...next, heartbeatExpiry: 950n }), { accepted: false, reason: 'SEQUENCE_REUSED' });
    assert.deepEqual(admitShardUpdate(next, shard), { accepted: false, reason: 'SEQUENCE_NOT_INCREASING' });
    const repriced = prepareShardReprice(next, '32'.repeat(32), 2n);
    assert.deepEqual(admitShardUpdate(repriced, { ...repriced, shardSequence: 4n, referenceSequence: 1n }), { accepted: false, reason: 'REFERENCE_REGRESSED' });
    assert.throws(() => prepareShardReprice(next, '32'.repeat(32), 1n), /must increase/);
    assert.throws(() => prepareShardHeartbeat(next, 900n), /must extend/);
  });

  test('settlement binds the exact shard, reference, level, fee, heartbeat, kill switch, and capacity', () => {
    assert.deepEqual(checkShardSettlement(shard, settle()), { executable: true, priceTicks: 1_005n, direction: 'ASK', quoteMode: 'FIRM_ONCHAIN' });
    assert.deepEqual(checkShardSettlement(shard, settle({ levelId: 1n, takerSide: 'SELL' })), { executable: true, priceTicks: 995n, direction: 'BID', quoteMode: 'FIRM_ONCHAIN' });
    const cases: [Partial<ShardSettlementRequest>, string][] = [
      [{ boundShardHash: packageQuoteShardHash({ ...shard, heartbeatExpiry: 600n }) }, 'SHARD_CHANGED'],
      [{ atValue: 500n }, 'STALE_HEARTBEAT'],
      [{ referenceSequence: 2n }, 'REFERENCE_CHANGED'],
      [{ referenceStateHash: '33'.repeat(32) }, 'REFERENCE_CHANGED'],
      [{ levelId: 9n }, 'LEVEL_UNKNOWN'],
      [{ levelId: 1n }, 'SIDE_MISMATCH'],
      [{ takerSide: 'SELL' }, 'SIDE_MISMATCH'],
      [{ size: 11n }, 'SIZE_ABOVE_LEVEL'],
      [{ fee: 6n }, 'FEE_ABOVE_MAXIMUM'],
    ];
    for (const [change, reason] of cases) assert.deepEqual(checkShardSettlement(shard, settle(change)), { executable: false, reason }, reason);
    const tight = { ...shard, reservedCapacity: 95n };
    assert.deepEqual(checkShardSettlement(tight, settle({ boundShardHash: packageQuoteShardHash(tight) })), { executable: false, reason: 'CAPACITY_UNAVAILABLE' });
    const expiring = { ...shard, heartbeatExpiry: 2_000n };
    assert.deepEqual(checkShardSettlement(expiring, settle({ boundShardHash: packageQuoteShardHash(expiring), atValue: 1_000n })), { executable: false, reason: 'LEVEL_EXPIRED' });
    const killed = prepareShardKillSwitch(shard, 'ACTIVE');
    assert.deepEqual(checkShardSettlement(killed, settle({ boundShardHash: packageQuoteShardHash(killed) })), { executable: false, reason: 'KILL_SWITCH_ACTIVE' });
  });
});
