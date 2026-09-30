import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  domainRef,
  packageQuoteShard,
  packageQuoteShardHash,
  quoteReferenceStateHash,
  toHex,
  type PackageQuoteShardInput,
  type QuoteReferenceStateInput,
  type ShardFillInput,
} from '@naryx/protocol-types';
import { createQuoteAutomation, type QuoteAutomationPolicy } from '../src/index.js';

const { privateKey } = generateKeyPairSync('ed25519');
const signShard = async (hash: Uint8Array) => new Uint8Array(sign(null, hash, privateKey));
const reference = (sequence: bigint, observedAtValue: bigint): QuoteReferenceStateInput => ({
  referenceVersion: 1,
  environment: 'testnet',
  marketGroupId: 'sol-carry',
  referenceKind: 'BASIS',
  referenceSequence: sequence,
  referencePriceTicks: 1_000n + sequence,
  sourceEvidenceHash: '41'.repeat(32),
  observedAtUnit: 'EVM_UNIX_SECONDS',
  observedAtValue,
});
const policy: QuoteAutomationPolicy = { maxReferenceAge: 30n, heartbeatLead: 20n, heartbeatExtension: 120n, maxInventoryUtilizationBps: 8_000 };

/** A stand-in solver API holding one shard, its settled fills, and every published operation. */
function venue(initial: PackageQuoteShardInput) {
  let shard = packageQuoteShard(initial) as PackageQuoteShardInput;
  const fills: { shardHash: string; fill: ShardFillInput }[] = [];
  const operations: string[] = [];
  const publish = (kind: string) => async (next: PackageQuoteShardInput) => {
    if (next.shardSequence <= shard.shardSequence) throw new Error('sequence must advance');
    shard = next;
    operations.push(kind);
    return { accepted: true };
  };
  return {
    client: {
      getShard: async () => ({ shard, shardHash: toHex(packageQuoteShardHash(shard)) }),
      getShardFills: async () => fills.map((entry) => ({ ...entry, fillCommitment: '', settledAtMs: 0 })),
      putShard: publish('put'),
      replaceShard: publish('replace'),
      heartbeat: publish('heartbeat'),
      killSwitch: publish('kill'),
    },
    fill(size: bigint, hash = toHex(packageQuoteShardHash(shard))) {
      fills.push({ shardHash: hash, fill: { shardHash: hash, levelId: 2n, takerSide: 'BUY', size, fee: 0n, priceTicks: 1_005n, orderHash: '61'.repeat(32), quoteHash: '62'.repeat(32), routeHash: '63'.repeat(32) } });
    },
    get shard() {
      return shard;
    },
    operations,
  };
}

const initialShard = (): PackageQuoteShardInput => ({
  shardVersion: 1,
  environment: 'testnet',
  domain: domainRef('svm:testnet', 1, '11'.repeat(32)),
  solverId: 'solver-a',
  templateId: 'cash-and-carry-v1',
  marketGroupId: 'sol-carry',
  referenceStateHash: quoteReferenceStateHash(reference(1n, 990n)),
  referenceSequence: 1n,
  quoteLevels: [
    { levelId: 2n, direction: 'ASK', size: 10n, referenceOffset: 5n, maximumFee: 5n, settlementClass: 'BATCHED_IOC_WITH_RECOVERY', quoteMode: 'EXECUTION_COMMITMENT', validUntilUnit: 'EVM_UNIX_SECONDS', validUntilValue: 5_000n, reservationPolicy: 'RESERVE_ON_ACCEPT' },
  ],
  inventoryCap: 50n,
  reservedCapacity: 0n,
  heartbeatExpiry: 1_100n,
  shardSequence: 1n,
  killSwitchState: 'INACTIVE',
  signature: new Uint8Array(64),
});

describe('quote automation', () => {
  test('reprices to a newer reference, heartbeats when due, and signs every published state', async () => {
    const market = venue(initialShard());
    let now = 1_000n;
    let observed = reference(1n, 995n);
    const automation = createQuoteAutomation({ client: market.client as never, shardId: 'cash-and-carry-v1.sol-carry', policy, readReference: async () => observed, now: () => now, signShard });
    assert.deepEqual(await automation.tick(), []);
    observed = reference(2n, 1_000n);
    assert.deepEqual(await automation.tick(), [{ kind: 'REPRICED', referenceSequence: 2n }]);
    assert.equal(toHex(packageQuoteShard(market.shard).referenceStateHash), toHex(quoteReferenceStateHash(observed)));
    now = 1_085n;
    observed = reference(2n, 1_080n);
    assert.deepEqual(await automation.tick(), [{ kind: 'HEARTBEAT', heartbeatExpiry: 1_205n }]);
    assert.deepEqual(market.operations, ['replace', 'heartbeat']);
    assert.ok(market.shard.signature.some((byte) => byte !== 0), 'published states are signed');
  });

  test('carries settled fills into reserved capacity exactly once, including late fills of a replaced state', async () => {
    const market = venue(initialShard());
    const automation = createQuoteAutomation({ client: market.client as never, shardId: 'cash-and-carry-v1.sol-carry', policy, readReference: async () => reference(1n, 995n), now: () => 1_000n, signShard });
    market.fill(6n);
    const firstState = toHex(packageQuoteShardHash(market.shard));
    assert.deepEqual(await automation.tick(), [{ kind: 'RESERVED', filledSize: 6n, reservedCapacity: 6n }]);
    assert.deepEqual(await automation.tick(), [], 'a fill is folded in once');
    // A fill that settled against the replaced state after the automation read it still counts.
    market.fill(4n, firstState);
    market.fill(3n);
    assert.deepEqual(await automation.tick(), [{ kind: 'RESERVED', filledSize: 7n, reservedCapacity: 13n }]);
  });

  test('stops quoting on an inventory breach or a stale reference, and leaves a killed shard alone', async () => {
    const full = venue(initialShard());
    const automation = createQuoteAutomation({ client: full.client as never, shardId: 'cash-and-carry-v1.sol-carry', policy, readReference: async () => reference(1n, 995n), now: () => 1_000n, signShard });
    full.fill(40n);
    assert.deepEqual(await automation.tick(), [{ kind: 'RESERVED', filledSize: 40n, reservedCapacity: 40n }, { kind: 'KILLED', reason: 'INVENTORY_LIMIT' }]);
    assert.equal(full.shard.killSwitchState, 'ACTIVE');
    assert.deepEqual(await automation.tick(), [{ kind: 'HALTED' }]);

    const stale = venue(initialShard());
    const staleAutomation = createQuoteAutomation({ client: stale.client as never, shardId: 'cash-and-carry-v1.sol-carry', policy, readReference: async () => reference(2n, 950n), now: () => 1_000n, signShard });
    assert.deepEqual(await staleAutomation.tick(), [{ kind: 'KILLED', reason: 'STALE_REFERENCE' }]);
    assert.deepEqual(stale.operations, ['kill'], 'a stale reference never reprices');
    assert.throws(() => createQuoteAutomation({ client: stale.client as never, shardId: 'x.y', policy: { ...policy, heartbeatExtension: 10n }, readReference: async () => reference(1n, 1n), now: () => 1n, signShard }), /extension longer than its lead/);
  });
});
