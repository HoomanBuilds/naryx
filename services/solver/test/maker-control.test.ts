import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  domainRef,
  packageQuoteShard,
  packageQuoteShardHash,
  toHex,
  type PackageQuoteShardInput,
} from '@naryx/protocol-types';
import {
  MakerControlError,
  MakerControlService,
  type MakerShardGateway,
} from '../src/maker-control.js';

const initialShard = (): PackageQuoteShardInput => ({
  shardVersion: 1,
  environment: 'testnet',
  domain: domainRef('eip155:84532', 1, '11'.repeat(32)),
  solverId: 'solver-a',
  templateId: 'cash-and-carry-v1',
  marketGroupId: 'weth-carry',
  referenceStateHash: '22'.repeat(32),
  referenceSequence: 1n,
  quoteLevels: [{
    levelId: 1n,
    direction: 'ASK',
    size: 10n,
    referenceOffset: 2n,
    maximumFee: 1n,
    settlementClass: 'ATOMIC_POSTCONDITION',
    quoteMode: 'EXECUTION_COMMITMENT',
    validUntilUnit: 'EVM_UNIX_SECONDS',
    validUntilValue: 2_000n,
    reservationPolicy: 'RESERVE_ON_ACCEPT',
  }],
  inventoryCap: 100n,
  reservedCapacity: 0n,
  heartbeatExpiry: 2_000n,
  shardSequence: 1n,
  killSwitchState: 'INACTIVE',
  signature: new Uint8Array(64),
});

function gateway(initial: PackageQuoteShardInput) {
  let current = packageQuoteShard(initial);
  const publish = async (next: PackageQuoteShardInput) => {
    current = packageQuoteShard(next);
    return {
      shardHash: toHex(packageQuoteShardHash(current)),
      shardSequence: current.shardSequence,
    };
  };
  const port: MakerShardGateway = {
    getShard: async () => ({ shard: current, shardHash: toHex(packageQuoteShardHash(current)) }),
    cancelAll: async (_shardId, next) => publish(next),
    activateKillSwitch: async (_shardId, next) => publish(next),
  };
  return { port, current: () => current };
}

test('maker controls bind emergency actions to the observed shard state', async () => {
  const market = gateway(initialShard());
  const service = new MakerControlService({
    gateway: market.port,
    signer: { signDigest: () => new Uint8Array(64).fill(7) },
  });
  const shardId = 'cash-and-carry-v1.weth-carry';
  const firstHash = toHex(packageQuoteShardHash(market.current()));
  const cancelled = await service.cancelAll({
    shardId,
    expectedShardHash: firstHash,
    expectedShardSequence: 1n,
  });
  assert.equal(cancelled.changed, true);
  assert.equal(cancelled.previousShardHash, firstHash);
  assert.equal(cancelled.shardSequence, 2n);
  assert.equal(market.current().quoteLevels.length, 0);

  await assert.rejects(
    service.activateKillSwitch({
      shardId,
      expectedShardHash: firstHash,
      expectedShardSequence: 1n,
    }),
    (error: unknown) => error instanceof MakerControlError && error.code === 'STALE_SHARD',
  );

  const secondHash = toHex(packageQuoteShardHash(market.current()));
  const killed = await service.activateKillSwitch({
    shardId,
    expectedShardHash: secondHash,
    expectedShardSequence: 2n,
  });
  assert.equal(killed.changed, true);
  assert.equal(killed.shardSequence, 3n);
  assert.equal(market.current().killSwitchState, 'ACTIVE');

  const repeated = await service.activateKillSwitch({
    shardId,
    expectedShardHash: killed.shardHash,
    expectedShardSequence: 3n,
  });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.shardSequence, 3n);
});
