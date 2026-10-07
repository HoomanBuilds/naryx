import assert from 'node:assert/strict';
import test from 'node:test';
import {
  crossDomainCompensationAction,
  crossDomainPlanHash,
  domainRef,
  toHex,
  type CrossDomainEvent,
  type CrossDomainPlanInput,
  type DomainRef,
} from '@naryx/protocol-types';
import {
  EvmCrossDomainExecutionDriver,
  type CrossDomainDriverAdvanceInput,
  type EvmCrossDomainExecutionLane,
  type EvmCrossDomainPhaseResult,
  type PreparedStrategyDomainTransport,
} from '../src/index.js';

const hash = (byte: string): string => byte.repeat(64);
const domain = domainRef('eip155:84532', 1, hash('1'));
const executorManifestHash = hash('2');
const plan: CrossDomainPlanInput = {
  planVersion: 1,
  environment: 'testnet',
  orderHash: hash('3'),
  quoteHash: hash('4'),
  routeHash: hash('5'),
  timeUnit: 'EVM_UNIX_SECONDS',
  prepareDeadline: 100n,
  commitDeadline: 200n,
  compensationDeadline: 300n,
  maximumInterimExposureQuoteAtoms: 1_000n,
  legs: [{
    domain,
    legIds: ['spot'],
    inventoryReservationId: hash('6'),
    interimExposureQuoteAtoms: 500n,
    compensationActionHash: hash('7'),
  }, {
    domain: domainRef('eip155:421614', 1, hash('8')),
    legIds: ['perp'],
    inventoryReservationId: hash('9'),
    interimExposureQuoteAtoms: 500n,
    compensationActionHash: hash('a'),
  }],
};
const compensation = crossDomainCompensationAction({
  actionVersion: 1,
  environment: 'testnet',
  orderHash: plan.orderHash,
  quoteHash: plan.quoteHash,
  routeHash: plan.routeHash,
  domain,
  legIds: ['spot'],
  inventoryReservationId: plan.legs[0]!.inventoryReservationId,
  actionKind: 'RELEASE_RESERVED_INVENTORY',
  executorClassId: 'evm-firm-reservation-v1',
  executorClassVersion: 1,
  executorClassManifestHash: executorManifestHash,
  actionPayloadHash: hash('b'),
  maximumCostQuoteAtoms: 10n,
  expiryUnit: 'EVM_UNIX_SECONDS',
  expiryValue: plan.compensationDeadline,
});
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
    strategyAccount: '0x1111111111111111111111111111111111111111',
    packageId: `0x${hash('c')}`,
    stages: Object.freeze([Object.freeze({
      stage: 0,
      calls: Object.freeze([Object.freeze({
        legId: 'spot',
        stage: 0,
        materializationClassId: 'test',
        adapter: '0x2222222222222222222222222222222222222222',
        adapterCodeHash: `0x${hash('d')}`,
        gasLimit: 1n,
        value: 0n as const,
        data: '0x12345678',
        dataHash: `0x${hash('e')}`,
      })]),
    })]),
    totalGasLimit: 1n,
  }),
});

class Lane implements EvmCrossDomainExecutionLane {
  readonly environment = 'testnet' as const;
  readonly domain: DomainRef;
  readonly chainReference: bigint;
  observedChain: bigint;
  now = 50n;
  startResult: EvmCrossDomainPhaseResult = {
    status: 'OBSERVED',
    evidenceHash: hash('f'),
    atValue: 50n,
  };
  finalityResult: EvmCrossDomainPhaseResult = {
    status: 'FINALIZED',
    evidenceHash: hash('f'),
    atValue: 51n,
  };

  constructor(value = domain) {
    this.domain = value;
    this.chainReference = BigInt(value.domainId.split(':')[1]!);
    this.observedChain = this.chainReference;
  }

  async chainId(): Promise<bigint> { return this.observedChain; }
  async currentTime(): Promise<bigint> { return this.now; }
  async start(): Promise<EvmCrossDomainPhaseResult> { return this.startResult; }
  async awaitFinality(): Promise<EvmCrossDomainPhaseResult> { return this.finalityResult; }
}

function input(action: CrossDomainDriverAdvanceInput['action'], events: readonly CrossDomainEvent[] = []): CrossDomainDriverAdvanceInput {
  return {
    planHash: toHex(crossDomainPlanHash(plan)),
    action,
    plan,
    planLeg: plan.legs[0]!,
    compensation,
    execution,
    events,
  };
}

function driver(lane: Lane): EvmCrossDomainExecutionDriver {
  return new EvmCrossDomainExecutionDriver(lane, {
    executorClassId: 'evm-firm-reservation-v1',
    executorClassVersion: 1,
    executorClassManifestHash: executorManifestHash,
    allowedActionKinds: ['RELEASE_RESERVED_INVENTORY'],
  });
}

test('maps a testnet EVM lane submission and its exact finality evidence into coordination events', async () => {
  const lane = new Lane();
  const first = await driver(lane).advance(input({ kind: 'PREPARE', domainId: domain.domainId }));
  assert.equal(first?.kind, 'PREPARED');
  assert.equal(first?.finality, 'OBSERVED');
  lane.now = 51n;
  const finalized = await driver(lane).advance(input(
    { kind: 'AWAIT_FINALITY', domainId: domain.domainId },
    [first as CrossDomainEvent],
  ));
  assert.equal(finalized?.kind, 'PREPARED');
  assert.equal(finalized?.finality, 'FINALIZED');
});

test('rejects mainnet lanes, wrong RPC chains, and changed finality evidence', async () => {
  assert.throws(
    () => driver(new Lane(domainRef('eip155:8453', 1, hash('1')))),
    /only Base Sepolia and Arbitrum Sepolia/,
  );
  const wrongChain = new Lane();
  wrongChain.observedChain = 421_614n;
  await assert.rejects(
    () => driver(wrongChain).advance(input({ kind: 'PREPARE', domainId: domain.domainId })),
    /RPC chain identity differs/,
  );
  const changed = new Lane();
  changed.now = 51n;
  changed.finalityResult = { status: 'FINALIZED', evidenceHash: hash('1'), atValue: 51n };
  const observed: CrossDomainEvent = {
    kind: 'PREPARED',
    domainId: domain.domainId,
    evidenceHash: hash('f'),
    finality: 'OBSERVED',
    atValue: 50n,
  };
  await assert.rejects(
    () => driver(changed).advance(input({ kind: 'AWAIT_FINALITY', domainId: domain.domainId }, [observed])),
    /finality evidence differs/,
  );
});
