import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commitmentHash,
  crossDomainCompensationAction,
  crossDomainPlanHash,
  domainRef,
  toHex,
  type CrossDomainPlanInput,
} from '@naryx/protocol-types';
import type { Address, Hex } from 'viem';
import {
  ArbitrumAsyncCrossDomainLane,
  arbitrumAsyncCancellationPayloadHash,
  type ArbitrumAsyncCrossDomainExecutor,
  type ArbitrumSepoliaExecutionBinding,
  type ArbitrumSepoliaExecutionResult,
  type EvmCrossDomainLaneInput,
  type PreparedStrategyDomainTransport,
} from '../src/index.js';

const hash = (byte: string) => byte.repeat(64);
const hex = (byte: string) => `0x${hash(byte)}` as Hex;
const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const domain = domainRef('eip155:421614', 1, hash('1'));
const packageId = hex('6');
const owner = address('1');
const account = address('2');
const coordinator = address('3');
const adapter = address('4');
const attemptId = `arbitrum-async-${'5'.repeat(48)}`;

const binding: ArbitrumSepoliaExecutionBinding = {
  attemptId,
  packageId,
  account,
  owner,
  orderHash: hex('a'),
  quoteHash: hex('b'),
  routeHash: hex('c'),
};

const plan: CrossDomainPlanInput = {
  planVersion: 1,
  environment: 'testnet',
  orderHash: binding.orderHash,
  quoteHash: binding.quoteHash,
  routeHash: binding.routeHash,
  timeUnit: 'EVM_UNIX_SECONDS',
  prepareDeadline: 100n,
  commitDeadline: 200n,
  compensationDeadline: 300n,
  maximumInterimExposureQuoteAtoms: 1_000n,
  legs: [{
    domain,
    legIds: ['perp'],
    inventoryReservationId: packageId,
    interimExposureQuoteAtoms: 500n,
    compensationActionHash: hash('7'),
  }, {
    domain: domainRef('eip155:84532', 1, hash('8')),
    legIds: ['spot'],
    inventoryReservationId: hash('9'),
    interimExposureQuoteAtoms: 500n,
    compensationActionHash: hash('d'),
  }],
};

const execution: PreparedStrategyDomainTransport = Object.freeze({
  kind: 'EVM_ASYNC_EXECUTOR' as const,
  domain,
  routeSettlementClass: 'CROSS_DOMAIN_PREPOSITIONED' as const,
  localGuarantee: 'BONDED_ASYNCHRONOUS' as const,
  plan: Object.freeze({
    version: 1 as const,
    planKind: 'EVM_ASYNC_REQUEST' as const,
    guarantee: 'BONDED_ASYNCHRONOUS' as const,
    domain,
    strategyAccount: account,
    packageId: hex('e'),
    stages: Object.freeze([Object.freeze({
      stage: 0,
      calls: Object.freeze([Object.freeze({
        legId: 'perp',
        stage: 0,
        materializationClassId: 'gmx-v2-entry',
        adapter,
        adapterCodeHash: hex('f'),
        gasLimit: 1n,
        value: 0n as const,
        data: '0x12345678' as Hex,
        dataHash: hex('1'),
      })]),
    })]),
    totalGasLimit: 1n,
  }),
});

function result(status: ArbitrumSepoliaExecutionResult['status']): ArbitrumSepoliaExecutionResult {
  return {
    version: 1,
    attemptId,
    status,
    packageId,
    coordinatorState: status === 'COMPENSATED' || status === 'SETTLED' ? 'CLOSED' : 'RESERVED',
    requestKey: status === 'SETTLED' ? hex('2') : null,
    transactions: [],
  };
}

class Executor implements ArbitrumAsyncCrossDomainExecutor {
  reserveStatus: ArbitrumSepoliaExecutionResult['status'] = 'RESERVED';
  advanceStatus: ArbitrumSepoliaExecutionResult['status'] = 'VENUE_PENDING';
  observedStatus: ArbitrumSepoliaExecutionResult['status'] = 'RESERVED';
  cancelStatus: ArbitrumSepoliaExecutionResult['status'] = 'COMPENSATED';

  async binding() { return binding; }
  async reserve() { return result(this.reserveStatus); }
  async advance() { return result(this.advanceStatus); }
  async observe() { return result(this.observedStatus); }
  async cancelReserved() { return result(this.cancelStatus); }
}

function lane(executor: Executor) {
  return new ArbitrumAsyncCrossDomainLane({
    config: { domain, coordinator, adapter, maximumCompensationCostQuoteAtoms: 10n },
    attempts: { resolve: async () => attemptId },
    executor,
    clock: { chainId: async () => 421_614n, currentTime: async () => 50n },
  });
}

function input(
  phase: EvmCrossDomainLaneInput['phase'],
  payloadHash = arbitrumAsyncCancellationPayloadHash({ coordinator, adapter, packageId, owner }),
): EvmCrossDomainLaneInput {
  return {
    planHash: toHex(crossDomainPlanHash(plan)),
    action: { kind: phase, domainId: domain.domainId },
    phase,
    plan,
    planLeg: plan.legs[0]!,
    compensation: crossDomainCompensationAction({
      actionVersion: 1,
      environment: 'testnet',
      orderHash: plan.orderHash,
      quoteHash: plan.quoteHash,
      routeHash: plan.routeHash,
      domain,
      legIds: ['perp'],
      inventoryReservationId: packageId,
      actionKind: 'CANCEL_PENDING_EXECUTION',
      executorClassId: 'arbitrum-async-v1',
      executorClassVersion: 1,
      executorClassManifestHash: hash('3'),
      actionPayloadHash: payloadHash,
      maximumCostQuoteAtoms: 10n,
      expiryUnit: 'EVM_UNIX_SECONDS',
      expiryValue: plan.compensationDeadline,
    }),
    execution,
    events: [],
  };
}

test('Arbitrum cross-domain lane reserves, commits, compensates, and waits for finalized package state', async () => {
  const executor = new Executor();
  const subject = lane(executor);
  await subject.currentTime();

  assert.equal((await subject.start(input('PREPARE'))).status, 'OBSERVED');
  assert.equal((await subject.awaitFinality({ ...input('PREPARE'), evidenceHash: commitmentHash(packageId) })).status, 'FINALIZED');

  assert.equal((await subject.start(input('COMMIT'))).status, 'PENDING');
  executor.advanceStatus = 'SETTLED';
  assert.equal((await subject.start(input('COMMIT'))).status, 'OBSERVED');
  executor.observedStatus = 'SETTLED';
  assert.equal((await subject.awaitFinality({ ...input('COMMIT'), evidenceHash: commitmentHash(packageId) })).status, 'FINALIZED');

  assert.equal((await subject.start(input('COMPENSATE'))).status, 'OBSERVED');
  executor.observedStatus = 'COMPENSATED';
  assert.equal((await subject.awaitFinality({ ...input('COMPENSATE'), evidenceHash: commitmentHash(packageId) })).status, 'FINALIZED');
});

test('Arbitrum cross-domain lane rejects compensation not bound to the exact cancellation calls', async () => {
  const subject = lane(new Executor());
  await subject.currentTime();
  await assert.rejects(
    subject.start(input('COMPENSATE', hex('4'))),
    /payload differs from the exact cancel and funding-release calls/,
  );
});
