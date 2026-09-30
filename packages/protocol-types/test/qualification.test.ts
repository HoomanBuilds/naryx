import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  checkQualificationAppend,
  currentQualification,
  domainRef,
  qualificationRecordHash,
  toHex,
  verifyQualificationHistory,
  type QualificationRecordInput,
} from '../src/index.js';

const DELAY = 100n;

function record(overrides: Partial<QualificationRecordInput> = {}): QualificationRecordInput {
  return {
    recordVersion: 1,
    environment: 'testnet',
    objectType: 'VENUE',
    objectId: 'phoenix-sol-usdc',
    domain: domainRef('svm:testnet', 1, '11'.repeat(32)),
    state: 'ACTIVE',
    effectiveLimits: { maximumNotionalQuoteAtoms: 1_000_000n, maximumOpenPackages: 10 },
    evidenceRefs: ['21'.repeat(32)],
    triggerCodes: [],
    timeUnit: 'EVM_UNIX_SECONDS',
    observedAtValue: 1_000n,
    effectiveAtValue: 1_100n,
    authorityKind: 'REVIEWED_ACTIVATION',
    authority: 'qualification-key-1',
    reviewerIds: ['reviewer-a', 'reviewer-b'],
    signature: new Uint8Array(64).fill(7),
    ...overrides,
  };
}

function chain(...records: QualificationRecordInput[]): QualificationRecordInput[] {
  const linked: QualificationRecordInput[] = [];
  for (const next of records) {
    const previous = linked[linked.length - 1];
    linked.push(previous === undefined ? next : { ...next, previousRecordHash: qualificationRecordHash(previous) });
  }
  return linked;
}

describe('qualification records', () => {
  test('the signature is not hashed, and every other field is', () => {
    const base = toHex(qualificationRecordHash(record()));
    assert.equal(toHex(qualificationRecordHash(record({ signature: new Uint8Array(64).fill(8) }))), base);
    for (const changed of [{ state: 'RESTRICTED' as const }, { objectId: 'phoenix-sol-usdt' }, { effectiveAtValue: 1_101n }, { triggerCodes: ['ORACLE_STALE'] }]) {
      assert.notEqual(toHex(qualificationRecordHash(record(changed))), base);
    }
    // Evidence and reviewer order do not change the record.
    assert.equal(
      toHex(qualificationRecordHash(record({ evidenceRefs: ['22'.repeat(32), '21'.repeat(32)], reviewerIds: ['reviewer-b', 'reviewer-a'] }))),
      toHex(qualificationRecordHash(record({ evidenceRefs: ['21'.repeat(32), '22'.repeat(32)] }))),
    );
  });

  test('a reviewed activation needs two reviewers, and a monitor names none', () => {
    assert.throws(() => qualificationRecordHash(record({ reviewerIds: ['reviewer-a'] })), /two distinct reviewers/);
    assert.throws(() => qualificationRecordHash(record({ authorityKind: 'AUTOMATED_MONITOR' })), /two distinct reviewers/);
    assert.throws(() => qualificationRecordHash(record({ effectiveAtValue: 999n })), /before it was observed/);
    assert.throws(() => qualificationRecordHash(record({ expiresAtValue: 1_100n })), /expire after/);
    assert.throws(() => qualificationRecordHash(record({ authorityKind: 'ADMINISTRATOR' as never })));
  });

  test('the first record and every loosening are delayed reviewed activations', () => {
    assert.deepEqual(checkQualificationAppend([], record({ effectiveAtValue: 1_099n }), DELAY), { accepted: false, reason: 'ACTIVATION_TOO_EARLY' });
    assert.equal(checkQualificationAppend([], record(), DELAY).accepted, true);
    assert.deepEqual(
      checkQualificationAppend([], record({ authorityKind: 'AUTOMATED_MONITOR', reviewerIds: [] }), DELAY),
      { accepted: false, reason: 'MONITOR_CANNOT_LOOSEN' },
    );

    const [first] = chain(record());
    const downgrade = chain(first as QualificationRecordInput, record({
      state: 'REDUCE_ONLY',
      triggerCodes: ['ORACLE_STALE'],
      observedAtValue: 2_000n,
      effectiveAtValue: 2_000n,
      authorityKind: 'AUTOMATED_MONITOR',
      reviewerIds: [],
    }));
    // A monitor tightens at once.
    assert.equal(checkQualificationAppend(downgrade.slice(0, 1), downgrade[1] as QualificationRecordInput, DELAY).accepted, true);

    const loosenByMonitor = chain(...downgrade, record({ state: 'ACTIVE', observedAtValue: 3_000n, effectiveAtValue: 3_000n, authorityKind: 'AUTOMATED_MONITOR', reviewerIds: [] }));
    assert.deepEqual(checkQualificationAppend(downgrade, loosenByMonitor[2] as QualificationRecordInput, DELAY), { accepted: false, reason: 'MONITOR_CANNOT_LOOSEN' });
    const raiseCap = chain(...downgrade, record({
      state: 'REDUCE_ONLY',
      effectiveLimits: { maximumNotionalQuoteAtoms: 2_000_000n, maximumOpenPackages: 10 },
      observedAtValue: 3_000n,
      effectiveAtValue: 3_000n,
      authorityKind: 'AUTOMATED_MONITOR',
      reviewerIds: [],
    }));
    assert.deepEqual(checkQualificationAppend(downgrade, raiseCap[2] as QualificationRecordInput, DELAY), { accepted: false, reason: 'MONITOR_CANNOT_LOOSEN' });
    const reviewed = chain(...downgrade, record({ observedAtValue: 3_000n, effectiveAtValue: 3_100n }));
    assert.equal(checkQualificationAppend(downgrade, reviewed[2] as QualificationRecordInput, DELAY).accepted, true);
    assert.deepEqual(verifyQualificationHistory(reviewed, DELAY), { valid: true });
  });

  test('records chain by hash, stay on one object, and never move back in time', () => {
    const history = chain(record());
    const unlinked = record({ observedAtValue: 2_000n, effectiveAtValue: 2_100n });
    assert.deepEqual(checkQualificationAppend(history, unlinked, DELAY), { accepted: false, reason: 'CHAIN_BROKEN' });
    const otherObject = chain(...history, record({ objectId: 'orca-sol-usdc', observedAtValue: 2_000n, effectiveAtValue: 2_100n }));
    assert.deepEqual(checkQualificationAppend(history, otherObject[1] as QualificationRecordInput, DELAY), { accepted: false, reason: 'OBJECT_MISMATCH' });
    const earlier = chain(...history, record({ observedAtValue: 900n, effectiveAtValue: 1_000n }));
    assert.deepEqual(checkQualificationAppend(history, earlier[1] as QualificationRecordInput, DELAY), { accepted: false, reason: 'TIME_REGRESSED' });
    assert.deepEqual(verifyQualificationHistory([...history, unlinked], DELAY), { valid: false, index: 1, reason: 'CHAIN_BROKEN' });
  });

  test('a monitor tightens ahead of a pending reviewed loosening and keeps governing after it', () => {
    const restricted = { state: 'RESTRICTED' as const, effectiveLimits: { maximumNotionalQuoteAtoms: 500_000n, maximumOpenPackages: 5 } };
    const monitor = { authorityKind: 'AUTOMATED_MONITOR' as const, reviewerIds: [] };
    // Active from 1100; a reviewed raise observed at 2000 is pending until 5000.
    const pending = chain(record(), record({ observedAtValue: 2_000n, effectiveAtValue: 5_000n, effectiveLimits: { maximumNotionalQuoteAtoms: 2_000_000n, maximumOpenPackages: 10 } }));
    const quarantine = chain(...pending, record({ ...monitor, state: 'QUARANTINED', observedAtValue: 2_500n, effectiveAtValue: 2_500n, triggerCodes: ['CODE_DRIFT'] }));
    assert.equal(checkQualificationAppend(pending, quarantine[2] as QualificationRecordInput, DELAY).accepted, true);
    for (const at of [2_500n, 5_000n, 9_000n]) {
      const verdict = currentQualification(quarantine, at);
      assert.ok('current' in verdict && verdict.current.state === 'QUARANTINED', `quarantined at ${at}`);
    }
    // A monitor may not use an early effective time to loosen against the record governing then.
    const looser = chain(...pending, record({ ...monitor, observedAtValue: 2_500n, effectiveAtValue: 2_500n, effectiveLimits: { maximumNotionalQuoteAtoms: 1_500_000n, maximumOpenPackages: 10 } }));
    assert.deepEqual(checkQualificationAppend(pending, looser[2] as QualificationRecordInput, DELAY), { accepted: false, reason: 'MONITOR_CANNOT_LOOSEN' });
    // Nor loosen against a pending tightening it would override.
    const pendingTighter = chain(record(), record({ ...restricted, observedAtValue: 2_000n, effectiveAtValue: 5_000n }));
    const undo = chain(...pendingTighter, record({ ...monitor, state: 'REDUCE_ONLY', observedAtValue: 2_500n, effectiveAtValue: 2_500n, effectiveLimits: { maximumNotionalQuoteAtoms: 900_000n, maximumOpenPackages: 5 } }));
    assert.deepEqual(checkQualificationAppend(pendingTighter, undo[2] as QualificationRecordInput, DELAY), { accepted: false, reason: 'MONITOR_CANNOT_LOOSEN' });
    // Before any record governs, a monitor cannot qualify the object early.
    const beforeFirst = chain(record({ observedAtValue: 1_000n, effectiveAtValue: 3_000n }), record({ ...monitor, ...restricted, observedAtValue: 1_500n, effectiveAtValue: 1_500n }));
    assert.deepEqual(checkQualificationAppend(beforeFirst.slice(0, 1), beforeFirst[1] as QualificationRecordInput, DELAY), { accepted: false, reason: 'MONITOR_CANNOT_LOOSEN' });
    assert.deepEqual(verifyQualificationHistory(quarantine, DELAY), { valid: true });
  });

  test('the current record is the latest in effect, and an expired one governs nothing', () => {
    const history = chain(
      record({ expiresAtValue: 5_000n }),
      record({ state: 'EXIT_ONLY', observedAtValue: 2_000n, effectiveAtValue: 2_000n, authorityKind: 'AUTOMATED_MONITOR', reviewerIds: [], expiresAtValue: 4_000n }),
    );
    assert.deepEqual(currentQualification([], 1_500n), { unavailable: 'NO_RECORD' });
    assert.deepEqual(currentQualification(history, 1_099n), { unavailable: 'NOT_YET_EFFECTIVE' });
    const early = currentQualification(history, 1_500n);
    assert.ok('current' in early && early.current.state === 'ACTIVE');
    const later = currentQualification(history, 2_000n);
    assert.ok('current' in later && later.current.state === 'EXIT_ONLY' && later.index === 1);
    assert.deepEqual(currentQualification(history, 4_000n), { unavailable: 'EXPIRED' });
  });
});
