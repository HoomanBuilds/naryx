import assert from 'node:assert/strict';
import test from 'node:test';
import { domainRef, stringifyProtocolJson, type CrossDomainEvent, type CrossDomainPlanInput } from '@naryx/protocol-types';
import { finalizedClockSkewHistory, verifyFinalizedClockSkew } from '../src/cross-domain-clock-reconciliation.js';

const hash = (byte: string) => byte.repeat(64);
const base = 'eip155:84532', arb = 'eip155:421614';
const plan: CrossDomainPlanInput = { planVersion: 2, environment: 'testnet', timeUnit: 'EVM_UNIX_SECONDS',
  orderHash: hash('1'), quoteHash: hash('2'), routeHash: hash('3'), prepareDeadline: 100n, commitDeadline: 200n,
  compensationDeadline: 300n, maximumInterimExposureQuoteAtoms: 200n,
  legs: [base, arb].map((id, index) => ({ domain: domainRef(id, 1, hash(String(index + 4))), legIds: [`leg-${index}`],
    inventoryReservationId: hash(String(index + 6)), interimExposureQuoteAtoms: 100n, compensationActionHash: hash(String(index + 8)) })) };
const event = (domainId: string, kind: 'PREPARED' | 'COMMITTED', atValue: bigint, finality: 'OBSERVED' | 'FINALIZED'): CrossDomainEvent =>
  ({ domainId, kind, atValue, finality, evidenceHash: hash(domainId === base ? 'a' : 'b') });
const events = [event(base, 'PREPARED', 20n, 'FINALIZED'), event(arb, 'PREPARED', 30n, 'FINALIZED'),
  event(base, 'COMMITTED', 40n, 'OBSERVED'), event(arb, 'COMMITTED', 45n, 'OBSERVED'),
  event(arb, 'COMMITTED', 70n, 'FINALIZED'), event(base, 'COMMITTED', 60n, 'FINALIZED')];
const observe = async (domainId: string) => ({ status: 'FINALIZED', evidenceHash: hash(domainId === base ? 'a' : 'b'), transactionHash: '0x' + hash('c') });

test('isolated cross-chain clock skew requires fresh receipts and preserves the original journal', async () => {
  const before = stringifyProtocolJson(events);
  const result = await verifyFinalizedClockSkew(plan, events, 350000, observe);
  assert.equal(result.receipts.length, 2);
  assert.equal(result.kind, 'FINALIZED_CLOCK_SKEW');
  assert.equal(stringifyProtocolJson(events), before);
  for (const status of ['PENDING', 'ABSENT', 'REVERTED']) await assert.rejects(() => verifyFinalizedClockSkew(plan, events, 350000,
    async id => ({ ...await observe(id), status })), /fresh finalized receipt/);
  await assert.rejects(() => verifyFinalizedClockSkew(plan, events, 350000,
    async id => ({ ...await observe(id), evidenceHash: hash('d') })), /fresh finalized receipt/);
});

test('clock resolution cannot erase failed, conflicting, late, missing or same-domain-backward evidence', () => {
  assert.throws(() => finalizedClockSkewHistory({ ...plan, environment: 'mainnet' }, events, 350n), /unsupported plan/);
  assert.throws(() => finalizedClockSkewHistory(plan, events, 65n), /future evidence/);
  assert.throws(() => finalizedClockSkewHistory(plan, events.slice(0, -1), 350n), /not an isolated/);
  assert.throws(() => finalizedClockSkewHistory(plan, [...events.slice(0, -1), { ...events[5]!, evidenceHash: hash('f') }], 350n), /conflicting/);
  assert.throws(() => finalizedClockSkewHistory(plan, [...events.slice(0, -1), { ...events[5]!, atValue: 39n }], 350n), /one domain clock/);
  assert.throws(() => finalizedClockSkewHistory(plan, [...events, { kind: 'COMMIT_FAILED', domainId: base, atValue: 90n, evidenceHash: hash('c') }], 350n), /failure, compensation/);
  const late = events.map(value => value.kind === 'COMMITTED' ? { ...value, atValue: value.atValue + 200n } : value);
  assert.throws(() => finalizedClockSkewHistory(plan, late, 400n), /not an isolated|complete, timely/);
});
