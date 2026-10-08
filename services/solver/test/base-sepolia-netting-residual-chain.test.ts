import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvmTestPerpNettingResidualPlan } from '@naryx/adapter-evm';
import { assetRef, commitmentHash, domainRef } from '@naryx/protocol-types';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from 'viem';
import {
  observeBaseSepoliaResidualReceipt,
  type BaseSepoliaResidualReceipt,
} from '../src/index.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');
const hash = (value: number): Hex => `0x${id(value)}`;
const address = (value: number): Address => getAddress(`0x${value.toString(16).padStart(40, '0')}`);

function plan(): EvmTestPerpNettingResidualPlan {
  return Object.freeze({
    version: 1,
    guarantee: 'SINGLE_TRANSACTION_BOUNDED_FILL_WITH_EVENT',
    intentHash: commitmentHash(id(1)),
    domain: domainRef('eip155:84532', 2, id(2)),
    instrumentHash: commitmentHash(id(3)),
    quantityAsset: assetRef('weth', id(4), 18),
    quoteAsset: assetRef('tusdc', id(5), 6),
    requestedSignedQuantityAtoms: 1_000_000_000_000_000_000n,
    sizeDeltaWad: 1_000_000_000_000_000_000n,
    balanceDeltaWad: 400_000_000_000_000_000_000n,
    minimumNotionalWad: 1n,
    maximumNotionalWad: 2_100_000_000_000_000_000_000n,
    maximumFeeWad: 2_000_000_000_000_000_000n,
    requestExpirySeconds: 2_000_000_000n,
    executionId: hash(1),
    executionAccount: address(20),
    transaction: Object.freeze({ chainId: 84532, to: address(21), value: 0n, data: '0x1234' }),
  });
}

function receipt(candidate: EvmTestPerpNettingResidualPlan, executionId = candidate.executionId): BaseSepoliaResidualReceipt {
  const topics = encodeEventTopics({
    abi: [{
      type: 'event',
      name: 'BoundedTradeExecuted',
      inputs: [
        { indexed: true, name: 'executionId', type: 'bytes32' },
        { indexed: true, name: 'trader', type: 'address' },
        { indexed: false, name: 'sizeDelta', type: 'int128' },
        { indexed: false, name: 'fillPriceWad', type: 'uint256' },
        { indexed: false, name: 'notionalWad', type: 'uint256' },
        { indexed: false, name: 'feeWad', type: 'uint256' },
      ],
    }] as const,
    eventName: 'BoundedTradeExecuted',
    args: { executionId, trader: candidate.executionAccount },
  });
  return Object.freeze({
    status: 'success',
    transactionHash: hash(30),
    blockHash: hash(31),
    blockNumber: 100n,
    transactionIndex: 2,
    logs: Object.freeze([Object.freeze({
      address: candidate.transaction.to,
      topics: topics as readonly Hex[],
      data: encodeAbiParameters(
        [{ type: 'int128' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
        [candidate.sizeDeltaWad, 2_000_000_000_000_000_000_000n,
          2_000_000_000_000_000_000_000n, 1_000_000_000_000_000_000n],
      ),
      logIndex: 4,
    })]),
  });
}

test('derives a successful residual observation only from the bounded trade event', () => {
  const candidate = plan();
  const observation = observeBaseSepoliaResidualReceipt({
    plan: candidate,
    receipt: receipt(candidate),
    submittedAtSeconds: 1_900_000_000n,
    observedAtSeconds: 1_900_000_002n,
  });
  assert.equal(observation.terminalStatus, 'SUCCEEDED');
  assert.equal(observation.sizeDeltaWad, candidate.sizeDeltaWad);
  assert.equal(observation.notionalWad, 2_000_000_000_000_000_000_000n);
  assert.equal(observation.executionReferenceHash, hash(30));
  assert.match(observation.authoritativeEvidenceHash, /^0x[0-9a-f]{64}$/);
});

test('maps a reverted receipt to a zero-fill terminal observation', () => {
  const candidate = plan();
  const failed = Object.freeze({ ...receipt(candidate), status: 'reverted' as const, logs: Object.freeze([]) });
  const observation = observeBaseSepoliaResidualReceipt({
    plan: candidate,
    receipt: failed,
    submittedAtSeconds: 1_900_000_000n,
    observedAtSeconds: 1_900_000_002n,
  });
  assert.equal(observation.terminalStatus, 'REVERTED');
  assert.equal(observation.sizeDeltaWad, 0n);
  assert.equal(observation.notionalWad, 0n);
  assert.equal(observation.feeWad, 0n);
});

test('rejects a successful receipt for another execution', () => {
  const candidate = plan();
  assert.throws(() => observeBaseSepoliaResidualReceipt({
    plan: candidate,
    receipt: receipt(candidate, hash(99)),
    submittedAtSeconds: 1_900_000_000n,
    observedAtSeconds: 1_900_000_002n,
  }), /differs from the execution binding/);
});
