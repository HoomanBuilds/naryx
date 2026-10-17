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
import { createQuoteAutomation, runQuoteAutomationWorker, type QuoteAutomationPolicy, type QuoteAutomationCheckpoint } from '../src/index.js';

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
  referenceStateHash: quoteReferenceStateHash(reference(1n, 995n)),
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
  test('source outages, unbacked replacements and slow qualification halt instead of renewing', async () => {
    for (const failure of ['reference', 'backing', 'replacement', 'slow'] as const) {
      const market = venue({ ...initialShard(), heartbeatExpiry: 1010n,
        quoteLevels: initialShard().quoteLevels.map((level) => ({ ...level, validUntilValue: 1010n })) });
      let now = 1000n;
      const automation = createQuoteAutomation({ client: market.client as never, shardId: 'cash-and-carry-v1.sol-carry', policy,
        readReference: async () => { if (failure === 'reference') throw new Error('offline'); return reference(1n, 995n); },
        now: () => now, signShard,
        assertBacking: async (shard) => {
          if (failure === 'backing' && shard.quoteLevels[0]!.size > 10n) throw new Error('insufficient capital');
          if (failure === 'slow') now = 1030n;
        },
        refreshLevels: async (shard) => {
          if (failure === 'replacement') throw new Error('no firm quotes');
          return shard.quoteLevels.map((level) => ({ ...level, size: 20n, validUntilValue: 1200n }));
        } });
      assert.deepEqual(await automation.tick(), [{ kind: 'KILLED', reason: {
        reference: 'REFERENCE_UNAVAILABLE', backing: 'BACKING_UNAVAILABLE', replacement: 'QUOTE_REFRESH_FAILED', slow: 'STALE_REFERENCE',
      }[failure] }]);
      assert.deepEqual(market.operations, ['kill']);
      assert.equal(market.shard.quoteLevels[0]!.size, 10n);
    }
  });

  test('shutdown supersedes an ambiguous update without publishing its active quotes again', async () => {
    for (const applied of [false, true]) {
      const market = venue(initialShard());
      let checkpoint: QuoteAutomationCheckpoint | undefined;
      let interrupt = true;
      const client = { ...market.client, putShard: async (shard: PackageQuoteShardInput) => {
        if (interrupt) {
          interrupt = false;
          if (applied) await market.client.putShard(shard);
          throw new Error('interrupted');
        }
        return market.client.putShard(shard);
      } };
      const options = { client: client as never, shardId: 'cash-and-carry-v1.sol-carry', policy,
        readReference: async () => reference(1n, 995n), now: () => 1000n, signShard,
        checkpointStore: { load: async () => checkpoint, save: async (value: QuoteAutomationCheckpoint) => { checkpoint = structuredClone(value); } } };
      market.fill(6n);
      await assert.rejects(createQuoteAutomation(options).tick(), /interrupted/);
      assert.deepEqual(await createQuoteAutomation(options).halt(), [{ kind: 'KILLED', reason: 'STOP_REQUESTED' }]);
      assert.equal(market.shard.killSwitchState, 'ACTIVE');
      assert.equal(market.shard.reservedCapacity, 6n);
      assert.equal(market.shard.shardSequence, 3n);
      assert.equal(checkpoint?.pending, undefined);
    }
  });

  test('pending active updates are killed if backing is lost before retry', async () => {
    const market = venue(initialShard());
    let checkpoint: QuoteAutomationCheckpoint | undefined;
    const options = { client: market.client as never, shardId: 'cash-and-carry-v1.sol-carry', policy,
      readReference: async () => reference(1n, 995n), now: () => 1000n, signShard,
      checkpointStore: { load: async () => checkpoint, save: async (value: QuoteAutomationCheckpoint) => { checkpoint = structuredClone(value); } } };
    market.fill(6n);
    await assert.rejects(createQuoteAutomation({ ...options,
      client: { ...market.client, putShard: async () => { throw new Error('offline'); } } as never }).tick(), /offline/);
    assert.deepEqual(await createQuoteAutomation({ ...options, assertBacking: async () => { throw new Error('unfunded'); } }).tick(),
      [{ kind: 'KILLED', reason: 'BACKING_UNAVAILABLE' }]);
    assert.equal(market.shard.killSwitchState, 'ACTIVE');
    assert.deepEqual(market.operations, ['put']);
  });

  test('a kill retry accepts the superseded active update without losing its fills', async () => {
    const market = venue(initialShard());
    let checkpoint: QuoteAutomationCheckpoint | undefined;
    let delayed: PackageQuoteShardInput | undefined;
    let calls = 0;
    const options = { client: { ...market.client, putShard: async (next: PackageQuoteShardInput) => {
      calls += 1;
      if (calls === 1) { delayed = next; throw new Error('entry response interrupted'); }
      if (calls === 2) { await market.client.putShard(delayed!); throw new Error('kill response interrupted'); }
      return market.client.putShard(next);
    } } as never, shardId: 'cash-and-carry-v1.sol-carry', policy,
    readReference: async () => reference(1n, 995n), now: () => 1000n, signShard,
    checkpointStore: { load: async () => checkpoint, save: async (value: QuoteAutomationCheckpoint) => { checkpoint = structuredClone(value); } } };
    market.fill(6n);
    await assert.rejects(createQuoteAutomation(options).tick(), /entry response interrupted/);
    await assert.rejects(createQuoteAutomation(options).halt(), /kill response interrupted/);
    assert.equal(market.shard.killSwitchState, 'INACTIVE');
    assert.equal(market.shard.reservedCapacity, 6n);
    assert.deepEqual(await createQuoteAutomation(options).tick(), [{ kind: 'HALTED' }]);
    assert.equal(market.shard.killSwitchState, 'ACTIVE');
    assert.equal(market.shard.reservedCapacity, 6n);
    assert.equal(checkpoint?.pending, undefined);
  });

  test('an acknowledgement without the signed state leaves a durable pending update', async () => {
    const market = venue(initialShard());
    let checkpoint: QuoteAutomationCheckpoint | undefined;
    market.fill(6n);
    await assert.rejects(createQuoteAutomation({ client: { ...market.client, putShard: async () => ({ accepted: true }) } as never,
      shardId: 'cash-and-carry-v1.sol-carry', policy, readReference: async () => reference(1n, 995n), now: () => 1000n, signShard,
      checkpointStore: { load: async () => checkpoint, save: async (value) => { checkpoint = structuredClone(value); } },
    }).tick(), /publication could not be confirmed/);
    assert.ok(checkpoint?.pending);
    assert.equal(checkpoint.accountedFills.length, 0);
    assert.equal(market.shard.reservedCapacity, 0n);
  });

  test('continuous worker serializes ticks, persists state and kills quotes on cancellation', async () => {
    const market = venue(initialShard());
    const controller = new AbortController();
    let checkpoint: QuoteAutomationCheckpoint | undefined;
    let checks = 0;
    const result = await runQuoteAutomationWorker({ environment: 'testnet', client: market.client as never, shardId: 'cash-and-carry-v1.sol-carry', policy,
      readReference: async () => reference(1n, 995n), now: () => 1000n, signShard,
      assertBacking: async () => { checks += 1; }, refreshLevels: async (shard) => shard.quoteLevels,
      checkpointStore: { load: async () => checkpoint, save: async (value) => { checkpoint = structuredClone(value); } },
      intervalMs: 100, signal: controller.signal, onTick: () => { if (checks === 2) controller.abort(); } });
    assert.deepEqual(result, { reason: 'ABORTED', ticks: 2 });
    assert.equal(market.shard.killSwitchState, 'ACTIVE');
    assert.ok(checkpoint?.watchedHashes.includes(toHex(packageQuoteShardHash(market.shard))));
  });

  test('continuous worker stops on failure and reports an unconfirmed halt', async () => {
    for (const failedHalt of [false, true]) {
      const market = venue(initialShard());
      const options = { environment: 'testnet' as const, client: { ...market.client,
        ...(failedHalt ? { killSwitch: async () => { throw new Error('halt offline'); } } : {}) } as never,
        shardId: 'cash-and-carry-v1.sol-carry', policy, readReference: async () => reference(1n, 995n), now: () => 1000n, signShard,
        assertBacking: async () => {}, refreshLevels: async (shard: PackageQuoteShardInput) => shard.quoteLevels,
        checkpointStore: { load: async () => undefined, save: async () => {} }, intervalMs: 100,
        signal: new AbortController().signal, onTick: () => { throw new Error('observer offline'); } };
      await assert.rejects(runQuoteAutomationWorker(options), failedHalt ? /halt could not be confirmed/ : /observer offline/);
      assert.equal(market.shard.killSwitchState, failedHalt ? 'INACTIVE' : 'ACTIVE');
    }
  });

  test('continuous worker interrupts idle waits and rejects mainnet before signing', async () => {
    const market = venue(initialShard());
    const controller = new AbortController();
    const options = { environment: 'testnet' as const, client: market.client as never,
      shardId: 'cash-and-carry-v1.sol-carry', policy, readReference: async () => reference(1n, 995n), now: () => 1000n, signShard,
      assertBacking: async () => {}, refreshLevels: async (shard: PackageQuoteShardInput) => shard.quoteLevels,
      checkpointStore: { load: async () => undefined, save: async () => {} }, intervalMs: 60_000, signal: controller.signal };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assert.deepEqual(await runQuoteAutomationWorker({ ...options, onTick: () => { timer = setTimeout(() => controller.abort(), 1); } }),
        { reason: 'ABORTED', ticks: 1 });
    } finally { clearTimeout(timer); }
    await assert.rejects(runQuoteAutomationWorker({ ...options, environment: 'mainnet' as never }), /non-mainnet environment/);
    const wrongEnvironment = venue({ ...initialShard(), environment: 'mainnet' });
    await assert.rejects(runQuoteAutomationWorker({ ...options, signal: new AbortController().signal,
      client: wrongEnvironment.client as never }), /halt could not be confirmed/);
    assert.deepEqual(wrongEnvironment.operations, []);
    await assert.rejects(runQuoteAutomationWorker({ ...options, checkpointStore: undefined as never }), /durable checkpoints/);
  });

  test('a durable pending publication survives an ambiguous response and preserves late fills after restart', async () => {
    const market = venue(initialShard());
    const originalHash = toHex(packageQuoteShardHash(market.shard));
    let checkpoint: QuoteAutomationCheckpoint | undefined;
    let failResponse = true;
    const client = { ...market.client, putShard: async (shard: PackageQuoteShardInput) => {
      const response = await market.client.putShard(shard);
      if (failResponse) { failResponse = false; throw new Error('response interrupted'); }
      return response;
    } };
    const options = { client: client as never, shardId: 'cash-and-carry-v1.sol-carry', policy,
      readReference: async () => reference(1n, 995n), now: () => 1000n, signShard,
      checkpointStore: { load: async () => checkpoint, save: async (value: QuoteAutomationCheckpoint) => { checkpoint = structuredClone(value); } } };
    market.fill(6n);
    await assert.rejects(createQuoteAutomation(options).tick(), /interrupted/);
    assert.ok(checkpoint?.pending);
    assert.equal(market.shard.reservedCapacity, 6n);
    const restarted = createQuoteAutomation(options);
    assert.deepEqual(await restarted.tick(), []);
    assert.equal(checkpoint?.pending, undefined);
    market.fill(4n, originalHash);
    assert.deepEqual(await restarted.tick(), [{ kind: 'RESERVED', filledSize: 4n, reservedCapacity: 10n }]);
    assert.deepEqual(await restarted.tick(), []);
  });

  test('expired levels are renewed only by fresh maker quotes, never by a heartbeat', async () => {
    const initial = { ...initialShard(), quoteLevels: initialShard().quoteLevels.map((level) => ({ ...level, validUntilValue: 1000n })) };
    const market = venue(initial);
    const options = { shardId: 'cash-and-carry-v1.sol-carry', policy, readReference: async () => reference(1n, 995n), now: () => 1000n, signShard };
    assert.deepEqual(await createQuoteAutomation({ ...options, client: market.client as never }).tick(), [{ kind: 'KILLED', reason: 'EXPIRED_QUOTES' }]);
    const renewed = venue(initial);
    assert.deepEqual(await createQuoteAutomation({ ...options, client: renewed.client as never,
      refreshLevels: async (shard) => shard.quoteLevels.map((level) => ({ ...level, validUntilValue: 1200n })),
    }).tick(), [{ kind: 'QUOTES_RENEWED', levelCount: 1 }]);
    assert.equal(renewed.shard.quoteLevels[0]!.validUntilValue, 1200n);
    assert.deepEqual(renewed.operations, ['put']);
  });

  test('untracked historical fills fail closed instead of offering their inventory again', async () => {
    const market = venue(initialShard());
    market.fill(6n, 'ff'.repeat(32));
    const automation = createQuoteAutomation({ client: market.client as never, shardId: 'cash-and-carry-v1.sol-carry', policy,
      readReference: async () => reference(1n, 995n), now: () => 1000n, signShard });
    assert.deepEqual(await automation.tick(), [{ kind: 'KILLED', reason: 'UNTRACKED_FILLS' }]);
  });

  test('a reference cannot change markets or mutate a signed sequence in place', async () => {
    for (const observed of [{ ...reference(2n, 995n), marketGroupId: 'another-market' }, reference(1n, 996n)]) {
      const market = venue(initialShard());
      const automation = createQuoteAutomation({ client: market.client as never, shardId: 'cash-and-carry-v1.sol-carry', policy,
        readReference: async () => observed, now: () => 1000n, signShard });
      assert.deepEqual(await automation.tick(), [{ kind: 'KILLED', reason: 'REFERENCE_BINDING' }]);
    }
  });

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
    observed = reference(3n, 1_080n);
    assert.deepEqual(await automation.tick(), [{ kind: 'REPRICED', referenceSequence: 3n }, { kind: 'HEARTBEAT', heartbeatExpiry: 1_205n }]);
    assert.deepEqual(market.operations, ['replace', 'replace', 'heartbeat']);
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
