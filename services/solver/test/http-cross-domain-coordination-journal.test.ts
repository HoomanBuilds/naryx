import assert from 'node:assert/strict';
import test from 'node:test';
import {
  crossDomainPlanHash,
  domainRef,
  parseProtocolJson,
  stringifyProtocolJson,
  toHex,
  type CrossDomainEvent,
  type CrossDomainPlanInput,
} from '@naryx/protocol-types';
import { HttpCrossDomainCoordinationJournal } from '../src/index.js';

const hash = (byte: string): string => byte.repeat(64);
const plan: CrossDomainPlanInput = {
  planVersion: 1,
  environment: 'testnet',
  orderHash: hash('1'),
  timeUnit: 'EVM_UNIX_SECONDS',
  prepareDeadline: 100n,
  commitDeadline: 200n,
  maximumInterimExposureQuoteAtoms: 1_000n,
  legs: [
    { domain: domainRef('eip155:84532', 1, hash('2')), legIds: ['spot'], inventoryReservationId: hash('3'), interimExposureQuoteAtoms: 400n, compensationActionHash: hash('4') },
    { domain: domainRef('eip155:421614', 1, hash('5')), legIds: ['perp'], inventoryReservationId: hash('6'), interimExposureQuoteAtoms: 500n, compensationActionHash: hash('7') },
  ],
};

function response(value: unknown): Response {
  return new Response(stringifyProtocolJson(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('persists plans and events through loopback while replaying snapshots from evidence locally', async () => {
  const planHash = toHex(crossDomainPlanHash(plan));
  const events: CrossDomainEvent[] = [];
  const requests: string[] = [];
  const fetchImplementation = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/internal/coordination/plans') {
      const body = parseProtocolJson(String(init?.body)) as { plan: CrossDomainPlanInput };
      assert.equal(toHex(crossDomainPlanHash(body.plan)), planHash);
      return response({ planHash, created: true });
    }
    if (url.pathname === '/internal/coordination/events') {
      const body = parseProtocolJson(String(init?.body)) as { event: CrossDomainEvent };
      events.push(body.event);
      return response({ sequence: events.length });
    }
    return response({ planHash, plan, events, state: { phase: 'untrusted' }, timeSource: 'SERVER_CLOCK' });
  };
  const journal = new HttpCrossDomainCoordinationJournal('http://127.0.0.1:8787', {
    fetch: fetchImplementation as typeof fetch,
    clockMs: () => 50_000,
  });
  await journal.registerPlan(plan);
  const event: CrossDomainEvent = {
    kind: 'PREPARED',
    domainId: 'eip155:421614',
    evidenceHash: hash('8'),
    finality: 'FINALIZED',
    atValue: 20n,
  };
  await journal.appendEvent(planHash, event);
  const snapshot = await journal.snapshot(planHash);
  assert.equal(snapshot.state.phase, 'PREPARING');
  assert.deepEqual(snapshot.state.nextActions, [{ kind: 'PREPARE', domainId: 'eip155:84532' }]);
  assert.deepEqual(requests, [
    'POST /internal/coordination/plans',
    'POST /internal/coordination/events',
    `GET /v1/coordinations/${planHash}`,
  ]);
});
