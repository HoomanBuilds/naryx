import assert from 'node:assert/strict';
import test from 'node:test';
import {
  crossDomainCompensationActionHash,
  crossDomainPlanHash,
  domainRef,
  hash32,
  replayCrossDomainCoordination,
  toHex,
  type CrossDomainEvent,
  type CrossDomainCompensationActionInput,
  type CrossDomainExecutionBundleInput,
  type CrossDomainPlanInput,
  type DomainRef,
} from '@naryx/protocol-types';
import type { Address, Hex } from 'viem';
import {
  CrossDomainExecutionCoordinator,
  type CrossDomainCoordinationJournal,
  type CrossDomainCoordinationSnapshot,
  type CrossDomainDriverAdvanceInput,
  type CrossDomainExecutionDriver,
  type PreparedStrategyDomainTransport,
  type PreparedStrategyExecutionTransport,
} from '../src/index.js';

const hash = (byte: string): string => byte.repeat(64);
const base = domainRef('eip155:84532', 1, hash('1'));
const arbitrum = domainRef('eip155:421614', 1, hash('2'));
const orderHash = hash('3');
const quoteHash = hash('b');
const routeHash = hash('c');

function compensation(
  domain: DomainRef,
  legIds: readonly string[],
  inventoryReservationId: string,
  payloadByte: string,
): CrossDomainCompensationActionInput {
  return Object.freeze({
    actionVersion: 1,
    environment: 'testnet',
    orderHash,
    quoteHash,
    routeHash,
    domain,
    legIds,
    inventoryReservationId,
    actionKind: 'RELEASE_RESERVED_INVENTORY' as const,
    executorClassId: 'evm-reservation-executor',
    executorClassVersion: 1,
    executorClassManifestHash: hash('d'),
    actionPayloadHash: payloadByte.repeat(64),
    maximumCostQuoteAtoms: 10n,
    expiryUnit: 'EVM_UNIX_SECONDS' as const,
    expiryValue: 300n,
  });
}

const compensations = Object.freeze([
  compensation(base, ['spot'], hash('4'), 'e'),
  compensation(arbitrum, ['perp'], hash('6'), 'f'),
]);

const plan: CrossDomainPlanInput = {
  planVersion: 1,
  environment: 'testnet',
  orderHash,
  quoteHash,
  routeHash,
  timeUnit: 'EVM_UNIX_SECONDS',
  prepareDeadline: 100n,
  commitDeadline: 200n,
  compensationDeadline: 300n,
  maximumInterimExposureQuoteAtoms: 1_000n,
  legs: [
    { domain: base, legIds: ['spot'], inventoryReservationId: hash('4'), interimExposureQuoteAtoms: 400n, compensationActionHash: crossDomainCompensationActionHash(compensations[0]!) },
    { domain: arbitrum, legIds: ['perp'], inventoryReservationId: hash('6'), interimExposureQuoteAtoms: 500n, compensationActionHash: crossDomainCompensationActionHash(compensations[1]!) },
  ],
};
const bundle: CrossDomainExecutionBundleInput = Object.freeze({ plan, compensations });

function domainExecution(domain: DomainRef): PreparedStrategyDomainTransport {
  return Object.freeze({
    kind: 'EVM_ASYNC_EXECUTOR' as const,
    domain,
    routeSettlementClass: 'CROSS_DOMAIN_PREPOSITIONED' as const,
    localGuarantee: 'BONDED_ASYNCHRONOUS' as const,
    plan: Object.freeze({
      version: 1 as const,
      planKind: 'EVM_ASYNC_REQUEST' as const,
      guarantee: 'BONDED_ASYNCHRONOUS' as const,
      domain,
      strategyAccount: '0x1111111111111111111111111111111111111111' as Address,
      packageId: `0x${hash('8')}` as Hex,
      stages: Object.freeze([]),
      totalGasLimit: 0n,
    }),
  });
}

function execution(): PreparedStrategyExecutionTransport {
  return Object.freeze({
    version: 1 as const,
    identity: Object.freeze({
      packageId: hash32(hash('8')),
      templateId: 'cash-and-carry-v1',
      templateVersion: 1,
      templateManifestHash: hash32(hash('9')),
      operation: 'ENTRY' as const,
    }),
    settlementClass: 'CROSS_DOMAIN_PREPOSITIONED' as const,
    coordination: 'CROSS_DOMAIN_PREPOSITIONED' as const,
    orderHash: hash32(plan.orderHash),
    graphHash: hash32(hash('a')),
    quoteHash: hash32(plan.quoteHash),
    routeHash: hash32(plan.routeHash),
    crossDomainPlanHash: crossDomainPlanHash(plan),
    domains: Object.freeze([domainExecution(base), domainExecution(arbitrum)]),
  });
}

class MemoryJournal implements CrossDomainCoordinationJournal {
  readonly #plans = new Map<string, CrossDomainPlanInput>();
  readonly #events = new Map<string, CrossDomainEvent[]>();
  now = 10n;

  async registerPlan(value: CrossDomainPlanInput): Promise<void> {
    const id = toHex(crossDomainPlanHash(value));
    this.#plans.set(id, value);
    if (!this.#events.has(id)) this.#events.set(id, []);
  }

  async snapshot(planHash: string): Promise<CrossDomainCoordinationSnapshot> {
    const stored = this.#plans.get(planHash);
    if (stored === undefined) throw new Error('plan not found');
    const events = Object.freeze([...(this.#events.get(planHash) ?? [])]);
    return Object.freeze({ plan: stored, events, state: replayCrossDomainCoordination(stored, events, this.now) });
  }

  async appendEvent(planHash: string, event: CrossDomainEvent): Promise<void> {
    this.#events.get(planHash)!.push(event);
    this.now = event.atValue;
  }
}

function driver(domain: DomainRef, events: CrossDomainEvent[]): CrossDomainExecutionDriver {
  return Object.freeze({
    domain,
    async advance(input: CrossDomainDriverAdvanceInput) {
      assert.equal(input.compensation.domain.domainId, domain.domainId);
      const event = events.shift();
      assert.ok(event, `missing event for ${input.action.kind} ${domain.domainId}`);
      return event;
    },
  });
}

const event = (kind: 'PREPARED' | 'COMMITTED' | 'COMPENSATED', domainId: string, atValue: bigint): CrossDomainEvent => ({
  kind,
  domainId,
  evidenceHash: hash(kind === 'PREPARED' ? 'd' : kind === 'COMMITTED' ? 'e' : 'f'),
  finality: 'FINALIZED',
  atValue,
});

test('drives a prepositioned package from prepare through finalized commit one action at a time', async () => {
  const journal = new MemoryJournal();
  const coordinator = new CrossDomainExecutionCoordinator(journal, [
    driver(arbitrum, [event('PREPARED', arbitrum.domainId, 20n), event('COMMITTED', arbitrum.domainId, 40n)]),
    driver(base, [event('PREPARED', base.domainId, 30n), event('COMMITTED', base.domainId, 50n)]),
  ]);

  for (let count = 0; count < 4; count += 1) {
    const result = await coordinator.advance(bundle, execution());
    assert.equal(result.status, 'ADVANCED');
  }
  const done = await coordinator.advance(bundle, execution());
  assert.equal(done.status, 'TERMINAL');
  assert.equal(done.state.terminalState, 'FINALIZED_COMPLETE');
});

test('compensates prepared inventory after another domain reports a definitive prepare failure', async () => {
  const journal = new MemoryJournal();
  const failed: CrossDomainEvent = {
    kind: 'PREPARE_FAILED',
    domainId: base.domainId,
    evidenceHash: hash('a'),
    atValue: 30n,
  };
  const coordinator = new CrossDomainExecutionCoordinator(journal, [
    driver(arbitrum, [event('PREPARED', arbitrum.domainId, 20n), event('COMPENSATED', arbitrum.domainId, 40n)]),
    driver(base, [failed]),
  ]);

  await coordinator.advance(bundle, execution());
  await coordinator.advance(bundle, execution());
  await coordinator.advance(bundle, execution());
  const done = await coordinator.advance(bundle, execution());
  assert.equal(done.status, 'TERMINAL');
  assert.equal(done.state.terminalState, 'RECOVERED_FLAT');
});
