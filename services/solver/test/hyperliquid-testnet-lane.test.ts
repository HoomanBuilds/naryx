import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  HyperliquidTestnetLane,
  hyperliquidLaneNotSubmitted,
  type HyperliquidTestnetExecutorResult,
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
  assert.throws(() => subject.release('attempt-later-000001'), /not blocked by that attempt/);
  subject.release('attempt-recover-0001');
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
