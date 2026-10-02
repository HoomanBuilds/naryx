import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  HyperliquidTestnetLane,
  SOLVER_TESTNET_RELEASE_LANE_PATH,
  createHyperliquidTestnetExecutorRequestHandler,
  hyperliquidLaneNotSubmitted,
  hyperliquidTestnetAlignedEvidence,
  type HyperliquidTestnetExecutorResult,
  type HyperliquidTestnetLaneOperator,
  type HyperliquidTestnetRuntimeEvidenceWindow,
} from '../src/index.js';

const KEY = 'idem-0123456789ABCD';
const HASH = `0x${'aa'.repeat(32)}`;

function reconciled(attemptId: string, packageStatus: 'COMPLETED_EXACT' | 'RECOVERY_REQUIRED'):
HyperliquidTestnetExecutorResult {
  return {
    attemptId,
    idempotencyKey: KEY,
    domain: 'hypercore:testnet',
    environment: 'TESTNET',
    status: 'RECONCILED',
    submissionStatus: 'ACKNOWLEDGED',
    packageStatus,
    reasons: packageStatus === 'COMPLETED_EXACT' ? [] : ['ONE_LEG_FILLED'],
    actionCommitment: HASH,
    requestCommitment: HASH,
    rawEvidenceCommitments: [],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function lane(databasePath?: string): HyperliquidTestnetLane {
  return new HyperliquidTestnetLane({
    ...(databasePath === undefined ? {} : { databasePath }),
    notSubmitted: hyperliquidLaneNotSubmitted,
  });
}

test('serializes concurrent attempts in arrival order and queues instead of rejecting', async () => {
  const subject = lane();
  const gate = deferred();
  const order: string[] = [];
  let active = 0;
  let maximum = 0;
  const task = (id: string, wait?: Promise<void>) => async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    order.push(`start:${id}`);
    await wait;
    order.push(`end:${id}`);
    active -= 1;
    return reconciled(id, 'COMPLETED_EXACT');
  };
  const first = subject.run('attempt-first-000001', KEY, task('attempt-first-000001', gate.promise));
  const second = subject.run('attempt-second-00001', KEY, task('attempt-second-00001'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(subject.status('attempt-first-000001', KEY), { state: 'EXECUTING' });
  assert.deepEqual(subject.status('attempt-second-00001', KEY), { state: 'QUEUED', queuePosition: 1 });
  assert.equal(subject.laneState().state, 'EXECUTING');
  gate.resolve();
  assert.equal((await first).status, 'RECONCILED');
  assert.equal((await second).status, 'RECONCILED');
  assert.equal(maximum, 1);
  assert.deepEqual(order, [
    'start:attempt-first-000001', 'end:attempt-first-000001',
    'start:attempt-second-00001', 'end:attempt-second-00001',
  ]);
  assert.equal(subject.laneState().state, 'FREE');
  subject.close();
});

test('blocks the lane after an unresolved outcome and refuses later attempts without running them', async () => {
  const subject = lane();
  await subject.run('attempt-recover-0001', KEY, async () => reconciled('attempt-recover-0001', 'RECOVERY_REQUIRED'));
  assert.deepEqual(subject.laneState(), { state: 'BLOCKED', holderAttemptId: 'attempt-recover-0001', queueLength: 0 });
  let calls = 0;
  const refused = await subject.run('attempt-later-000001', KEY, async () => {
    calls += 1;
    return reconciled('attempt-later-000001', 'COMPLETED_EXACT');
  });
  assert.equal(refused.status, 'NOT_SUBMITTED');
  assert.equal(calls, 0);
  const reason = 'recovery completed out of band and reviewed';
  assert.throws(
    () => subject.release({ holderAttemptId: 'attempt-later-000001', disposition: 'ABANDONED', reason }),
    /not blocked by that attempt/,
  );
  subject.release({ holderAttemptId: 'attempt-recover-0001', disposition: 'ABANDONED', reason });
  const resumed = await subject.run('attempt-resume-00001', KEY, async () => {
    calls += 1;
    return reconciled('attempt-resume-00001', 'COMPLETED_EXACT');
  });
  assert.equal(resumed.status, 'RECONCILED');
  assert.equal(calls, 1);
  subject.close();
});

test('replays a completed attempt and fences an attempt the lane never received', async () => {
  const subject = lane();
  let calls = 0;
  const first = await subject.run('attempt-replay-00001', KEY, async () => {
    calls += 1;
    return reconciled('attempt-replay-00001', 'COMPLETED_EXACT');
  });
  const replay = await subject.run('attempt-replay-00001', KEY, async () => {
    calls += 1;
    throw new Error('must not run twice');
  });
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  assert.deepEqual(subject.status('attempt-replay-00001', KEY), { state: 'COMPLETED', result: first });
  assert.throws(() => subject.status('attempt-replay-00001', 'idem-OTHER-KEY-000'), /different idempotency key/);

  assert.deepEqual(subject.status('attempt-missing-0001', KEY), { state: 'UNKNOWN' });
  const fenced = subject.resolve('attempt-missing-0001', KEY);
  assert.equal(fenced.state, 'COMPLETED');
  // A delayed copy of the original request now returns the refusal and never executes.
  const late = await subject.run('attempt-missing-0001', KEY, async () => {
    calls += 1;
    return reconciled('attempt-missing-0001', 'COMPLETED_EXACT');
  });
  assert.equal(late.status, 'NOT_SUBMITTED');
  assert.equal(calls, 1);
  subject.close();
});

test('forgets pre-submission failures and blocks on failures after submission began', async () => {
  const subject = lane();
  await assert.rejects(subject.run('attempt-preflight-01', KEY, async () => {
    throw new Error('authority preflight failed');
  }), /authority preflight failed/);
  assert.deepEqual(subject.status('attempt-preflight-01', KEY), { state: 'UNKNOWN' });
  assert.equal(subject.laneState().state, 'FREE');

  await assert.rejects(subject.run('attempt-submitted-01', KEY, async (enterSubmission) => {
    enterSubmission();
    throw new Error('result failed validation after submission');
  }), /after submission/);
  assert.deepEqual(subject.status('attempt-submitted-01', KEY), { state: 'INTERRUPTED' });
  assert.equal(subject.laneState().state, 'BLOCKED');
  await assert.rejects(
    subject.run('attempt-submitted-01', KEY, async () => reconciled('attempt-submitted-01', 'COMPLETED_EXACT')),
    /must not be resubmitted/,
  );
  subject.close();
});

test('a restarted executor refuses queued attempts and keeps the interrupted holder blocking', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naryx-hyperliquid-lane-'));
  const databasePath = join(directory, 'journal.sqlite');
  const before = lane(databasePath);
  const never = deferred();
  try {
    void before.run('attempt-holder-00001', KEY, async (enterSubmission) => {
      enterSubmission();
      await never.promise;
      return reconciled('attempt-holder-00001', 'COMPLETED_EXACT');
    });
    void before.run('attempt-waiting-0001', KEY, async () => reconciled('attempt-waiting-0001', 'COMPLETED_EXACT'));
    await new Promise((resolve) => setImmediate(resolve));

    const after = lane(databasePath);
    try {
      assert.deepEqual(after.laneState(), { state: 'BLOCKED', holderAttemptId: 'attempt-holder-00001', queueLength: 0 });
      assert.deepEqual(after.status('attempt-holder-00001', KEY), { state: 'INTERRUPTED' });
      const waiting = after.status('attempt-waiting-0001', KEY);
      assert.equal(waiting.state, 'COMPLETED');
      assert.equal(waiting.state === 'COMPLETED' && waiting.result.status, 'NOT_SUBMITTED');
    } finally {
      after.close();
    }
  } finally {
    before.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('releases a blocked lane only as FINAL with a final result or as ABANDONED with a journaled reason', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naryx-hyperliquid-lane-release-'));
  const databasePath = join(directory, 'journal.sqlite');
  const subject = lane(databasePath);
  try {
    const holder = 'attempt-holder-00002';
    await subject.run(holder, KEY, async () => reconciled(holder, 'RECOVERY_REQUIRED'));
    assert.equal(subject.blockedHolder()?.result?.status, 'RECONCILED');
    assert.throws(() => subject.release({ holderAttemptId: holder, disposition: 'ABANDONED', reason: 'short' }),
      /reason of 8 to 280/);
    assert.throws(() => subject.release({ holderAttemptId: holder, disposition: 'ABANDONED', reason: 'bad\nreason text' }),
      /reason of 8 to 280/);
    // A FINAL release needs a result that leaves nothing pending, for this attempt and key.
    assert.throws(() => subject.release({
      holderAttemptId: holder, disposition: 'FINAL', reason: 'fresh evidence shows completion',
      result: reconciled(holder, 'RECOVERY_REQUIRED'),
    }), /not final/);
    assert.throws(() => subject.release({
      holderAttemptId: holder, disposition: 'FINAL', reason: 'fresh evidence shows completion',
      result: { ...reconciled(holder, 'COMPLETED_EXACT'), idempotencyKey: 'idem-OTHER-KEY-000' },
    }), /does not belong/);
    assert.equal(subject.laneState().state, 'BLOCKED');
    const release = subject.release({
      holderAttemptId: holder, disposition: 'FINAL', reason: 'fresh evidence shows completion',
      result: reconciled(holder, 'COMPLETED_EXACT'),
    });
    assert.deepEqual([release.disposition, release.blockedReason, release.resultStatus],
      ['FINAL', 'RECONCILED', 'COMPLETED_EXACT']);
    assert.equal(subject.laneState().state, 'FREE');
    const stored = subject.status(holder, KEY);
    assert.equal(stored.state === 'COMPLETED' && stored.result.status === 'RECONCILED'
      && stored.result.packageStatus, 'COMPLETED_EXACT');
    assert.throws(() => subject.release({ holderAttemptId: holder, disposition: 'ABANDONED', reason: 'second release attempt' }),
      /not blocked by that attempt/);
  } finally {
    subject.close();
  }
  // The release journal survives a restart.
  const reopened = new Database(databasePath, { readonly: true });
  try {
    const rows = reopened.prepare('SELECT holder_attempt_id, disposition, reason FROM hyperliquid_lane_releases').all();
    assert.deepEqual(rows, [{ holder_attempt_id: 'attempt-holder-00002', disposition: 'FINAL',
      reason: 'fresh evidence shows completion' }]);
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function operatorRequest(
  body: unknown,
  headers: Record<string, string> = {},
  remoteAddress = '127.0.0.1',
): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(request, {
    method: 'POST',
    url: SOLVER_TESTNET_RELEASE_LANE_PATH,
    headers: { 'content-type': 'application/json', ...headers },
    socket: { remoteAddress },
  });
  return request;
}

function capturedResponse() {
  const captured = { status: 0, body: '' };
  const response = {
    statusCode: 0,
    headersSent: false,
    setHeader() {},
    end(text: string) {
      captured.status = response.statusCode;
      captured.body = text;
    },
  };
  return { captured, response: response as unknown as ServerResponse };
}

test('exposes lane release only to direct loopback operators and maps refusals', async () => {
  const subject = lane();
  const holder = 'attempt-holder-00003';
  await subject.run(holder, KEY, async () => reconciled(holder, 'RECOVERY_REQUIRED'));
  const operator: HyperliquidTestnetLaneOperator = {
    async releaseLane(request) {
      if (request.disposition === 'FINAL') {
        return subject.release({ holderAttemptId: request.attemptId, disposition: 'FINAL', reason: request.reason,
          result: reconciled(request.attemptId, 'RECOVERY_REQUIRED') });
      }
      return subject.release({ holderAttemptId: request.attemptId, disposition: 'ABANDONED', reason: request.reason });
    },
  };
  const handler = createHyperliquidTestnetExecutorRequestHandler(undefined, operator);
  const body = { attemptId: holder, disposition: 'ABANDONED', reason: 'manual recovery reviewed by operator' };
  for (const [headers, remote] of [
    [{ 'x-forwarded-for': '203.0.113.9' }, '127.0.0.1'],
    [{ origin: 'https://naryx.example' }, '127.0.0.1'],
    [{}, '10.0.0.8'],
  ] as const) {
    const { captured, response } = capturedResponse();
    await handler(operatorRequest(body, headers, remote), response);
    assert.equal(captured.status, 403);
  }
  assert.equal(subject.laneState().state, 'BLOCKED');

  const notFinal = capturedResponse();
  await handler(operatorRequest({ ...body, disposition: 'FINAL' }), notFinal.response);
  assert.equal(notFinal.captured.status, 409);
  assert.match(notFinal.captured.body, /HOLDER_NOT_FINAL/);

  const invalid = capturedResponse();
  await handler(operatorRequest({ ...body, reason: 'tiny' }), invalid.response);
  assert.equal(invalid.captured.status, 400);

  const released = capturedResponse();
  await handler(operatorRequest(body), released.response);
  assert.equal(released.captured.status, 200);
  assert.match(released.captured.body, /"disposition":"ABANDONED"/);
  assert.equal(subject.laneState().state, 'FREE');

  const again = capturedResponse();
  await handler(operatorRequest(body), again.response);
  assert.equal(again.captured.status, 409);
  assert.match(again.captured.body, /LANE_NOT_BLOCKED_BY_ATTEMPT/);
  subject.close();
});

test('aligns keeper windows to the checkpoint read and re-reads incomplete evidence within the age bound', async () => {
  let now = 10_000;
  const windows: HyperliquidTestnetRuntimeEvidenceWindow[] = [];
  const contexts = new Map<string, string>();
  const results = ['EVIDENCE_INCOMPLETE', 'RECONCILED', 'RECONCILED'];
  const evidence = hyperliquidTestnetAlignedEvidence({
    async prepare(input) {
      windows.push(input.window);
      return { status: 'PREPARED' as const, state: { attemptId: input.attemptId,
        checkpoint: { observedAtMs: 10_040, perpetualPositionAtoms: input.plan.prePerpPositionAtoms } } };
    },
    async reconcile(_prepared, _handoff, _binding, window) {
      windows.push(window);
      now += 300;
      return { status: results.shift() };
    },
  }, {
    currentTimeMs: () => now,
    recordContext: (attemptId, context) => contexts.set(attemptId, context),
    sleep: async (milliseconds) => { now += milliseconds; },
  });
  const limits = { maxEvidenceAgeMs: 20_000, maxSnapshotSkewMs: 500, maxFillPages: 2 };
  const prepared = await evidence.prepare({
    attemptId: 'attempt-aligned-0001',
    plan: { prePerpPositionAtoms: -5n } as never,
    account: {} as never,
    binding: {} as never,
    window: { startTimeMs: 0, endTimeMs: now, nowMs: now, ...limits },
  });
  assert.equal(prepared.status, 'PREPARED');
  // Keeper reads must land before the window's now, so it closes at a read deadline.
  assert.deepEqual([windows[0]!.endTimeMs, windows[0]!.nowMs], [15_000, 15_000]);
  now = 11_000;
  const state = prepared.status === 'PREPARED' ? prepared.state : undefined;
  const result = await evidence.reconcile(state, {} as never, {} as never,
    { startTimeMs: 10_000, endTimeMs: 10_000, nowMs: 10_000, ...limits });
  assert.deepEqual(result, { status: 'RECONCILED' });
  // The first read was incomplete; both reads start exactly at the checkpoint read.
  assert.deepEqual(windows.slice(1).map((window) => [window.startTimeMs, window.nowMs]),
    [[10_040, 16_000], [10_040, 17_300]]);
  assert.ok(contexts.has('attempt-aligned-0001'));
  assert.deepEqual(await evidence.reconcileStored(contexts.get('attempt-aligned-0001')!), { status: 'RECONCILED' });
  assert.equal(windows.at(-1)!.startTimeMs, 10_040);
});
