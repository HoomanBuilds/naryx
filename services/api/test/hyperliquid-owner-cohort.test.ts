import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { HyperliquidOwnerCohorts, type OwnerCohortPort } from '../src/hyperliquid-owner-cohort.js';
import { createHyperliquidOwnerCohortHandler } from '../src/hyperliquid-owner-cohort-http.js';
import type { HyperliquidTestnetTerminalExecutionResult } from '../src/hyperliquid-testnet-terminal.js';

const requests = [1, 2].map((id) => ({ attemptId: `strategy-hl-${String(id).repeat(48)}`, idempotencyKey: `owner-cohort-key-${id}` }));
const owner = (id: number) => `0x${String(id).repeat(40)}`;
const cohortId = 'test-owner-cohort-01';

function fixture() {
  const calls: string[] = [];
  const ready = new Set<string>();
  const completed = (request: typeof requests[number]) => ({ ...request, domain: 'hypercore:testnet', environment: 'TESTNET',
    status: 'STRATEGY_EXECUTION', packageStatus: 'COMPLETED' }) as HyperliquidTestnetTerminalExecutionResult;
  const port: OwnerCohortPort = {
    bind: (request) => { const id = requests.findIndex((item) => item.attemptId === request.attemptId) + 1;
      return { owner: owner(id), settlementAccount: owner(id), orderHash: String(id).repeat(64) }; },
    requireOwnerAuthorization: () => {},
    execute: async (request) => { calls.push(request.attemptId); ready.add(request.attemptId); return completed(request); },
    status: async (request) => ready.has(request.attemptId) ? { state: 'COMPLETED', result: completed(request) } : { state: 'UNCERTAIN', lane: null },
    receiptHash: (request) => ready.has(request.attemptId) ? (requests[0]!.attemptId === request.attemptId ? 'a' : 'b').repeat(64) : undefined,
  };
  return { calls, ready, port };
}

test('owner cohorts settle each owner separately, persist receipts and never replay completed members', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-owner-cohort-'));
  const path = join(dir, 'cohorts.sqlite');
  const { port, calls } = fixture();
  let service = new HyperliquidOwnerCohorts(path, port);
  try {
    assert.equal(service.prepare(cohortId, requests).collateralNetting, false);
    assert.throws(() => service.prepare(cohortId, [...requests].reverse()), /membership cannot change/);
    assert.throws(() => service.prepare(`${cohortId}-other`, requests), /already belongs/);
    const [first, concurrent] = await Promise.all([service.execute(cohortId), service.execute(cohortId)]);
    assert.equal(first.state, 'SETTLED');
    assert.deepEqual(first, concurrent);
    assert.equal(first.members.length, 2);
    assert.ok(first.members.every((member) => member.owner === member.settlementAccount && member.receiptHash !== null));
    service.close();
    service = new HyperliquidOwnerCohorts(path, port);
    assert.equal((await service.execute(cohortId)).state, 'SETTLED');
    assert.deepEqual(calls, requests.map((request) => request.attemptId));
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an uncertain first account stops later owners and restart only observes its original attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-owner-cohort-'));
  const { port, calls, ready } = fixture();
  const execute = port.execute;
  let ambiguous = true;
  port.execute = async (request) => {
    if (ambiguous) { ambiguous = false; calls.push(request.attemptId); throw new Error('response lost'); }
    return execute(request);
  };
  const path = join(dir, 'cohorts.sqlite');
  let service = new HyperliquidOwnerCohorts(path, port);
  try {
    service.prepare(cohortId, requests);
    await assert.rejects(service.execute(cohortId), /response lost/);
    service.close();
    service = new HyperliquidOwnerCohorts(path, port);
    assert.equal((await service.execute(cohortId)).state, 'BLOCKED');
    assert.deepEqual(calls, [requests[0]!.attemptId]);
    ready.add(requests[0]!.attemptId);
    assert.equal((await service.execute(cohortId)).state, 'SETTLED');
    assert.deepEqual(calls, requests.map((request) => request.attemptId));
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('cohorts refuse shared accounts, repeated owners and missing owner authorization before execution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-owner-cohort-'));
  const { port, calls } = fixture();
  let service = new HyperliquidOwnerCohorts(join(dir, 'cohorts.sqlite'), { ...port, bind: () => ({ owner: owner(1), settlementAccount: owner(2), orderHash: 'a'.repeat(64) }) });
  try {
    assert.throws(() => service.prepare(cohortId, requests), /own owner account/);
    service.close();
    service = new HyperliquidOwnerCohorts(join(dir, 'cohorts.sqlite'), { ...port, bind: () => ({ owner: owner(1), settlementAccount: owner(1), orderHash: 'a'.repeat(64) }) });
    assert.throws(() => service.prepare(cohortId, requests), /only once/);
    service.close();
    service = new HyperliquidOwnerCohorts(join(dir, 'cohorts.sqlite'), { ...port, requireOwnerAuthorization: () => { throw new Error('unsigned'); } });
    assert.throws(() => service.prepare(cohortId, requests), /unsigned/);
    assert.equal(service.get(cohortId), undefined);
    assert.deepEqual(calls, []);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('recovered owner evidence resumes the cohort without another venue submission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-owner-cohort-'));
  const { port, calls, ready } = fixture();
  const execute = port.execute;
  port.execute = async (request) => {
    if (request.attemptId === requests[0]!.attemptId) {
      calls.push(request.attemptId);
      return { ...request, domain: 'hypercore:testnet', environment: 'TESTNET', status: 'STRATEGY_EXECUTION', packageStatus: 'RECOVERY_REQUIRED' } as HyperliquidTestnetTerminalExecutionResult;
    }
    return execute(request);
  };
  const service = new HyperliquidOwnerCohorts(join(dir, 'cohorts.sqlite'), port);
  try {
    service.prepare(cohortId, requests);
    assert.equal((await service.execute(cohortId)).members[0]!.state, 'RECOVERY_REQUIRED');
    assert.equal((await service.execute(cohortId)).state, 'BLOCKED');
    ready.add(requests[0]!.attemptId);
    assert.equal((await service.execute(cohortId)).state, 'SETTLED');
    assert.deepEqual(calls, requests.map((request) => request.attemptId));
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('owner cohort HTTP refuses proxied callers and settles only admitted membership', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-owner-cohort-'));
  const { port, calls } = fixture();
  const service = new HyperliquidOwnerCohorts(join(dir, 'cohorts.sqlite'), port);
  const handler = createHyperliquidOwnerCohortHandler(service);
  const server = createServer((request, response) => { if (!handler(request, response)) { response.statusCode = 404; response.end(); } });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/hyperliquid-testnet/owner-cohorts`;
    const body = JSON.stringify({ cohortId, requests });
    assert.equal((await fetch(root, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.1' }, body })).status, 403);
    assert.equal(service.get(cohortId), undefined);
    assert.equal((await fetch(root, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 200);
    const executed = await fetch(`${root}/${cohortId}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(executed.status, 200);
    assert.equal(((await executed.json()) as { state: string }).state, 'SETTLED');
    assert.equal((await fetch(`${root}/${cohortId}`)).status, 200);
    assert.equal(calls.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    service.close(); rmSync(dir, { recursive: true, force: true });
  }
});
