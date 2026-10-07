import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  crossDomainPlanHash,
  domainRef,
  replayCrossDomainCoordination,
  manualRecoveryApprovalHash,
  replayManualRecovery,
  toHex,
  type CrossDomainEvent,
  type CrossDomainPlanInput,
  type ManualRecoveryIncidentInput,
} from '../src/index.js';

const plan: CrossDomainPlanInput = {
  planVersion: 1,
  environment: 'testnet',
  orderHash: '11'.repeat(32),
  timeUnit: 'EVM_UNIX_SECONDS',
  prepareDeadline: 100n,
  commitDeadline: 200n,
  maximumInterimExposureQuoteAtoms: 1_000n,
  legs: [
    { domain: domainRef('svm:testnet', 1, '21'.repeat(32)), legIds: ['spot'], inventoryReservationId: '31'.repeat(32), interimExposureQuoteAtoms: 400n, compensationActionHash: '41'.repeat(32) },
    { domain: domainRef('eip155:84532', 1, '22'.repeat(32)), legIds: ['perp'], inventoryReservationId: '32'.repeat(32), interimExposureQuoteAtoms: 500n, compensationActionHash: '42'.repeat(32) },
  ],
};
const ev = (kind: 'PREPARED' | 'COMMITTED' | 'COMPENSATED', domainId: string, atValue: bigint, evidence = '51', finality: 'OBSERVED' | 'FINALIZED' = 'FINALIZED'): CrossDomainEvent => ({ kind, domainId, evidenceHash: evidence.repeat(32), finality, atValue });

describe('cross-domain prepositioned coordination', () => {
  test('commits only after every domain prepared with finalized evidence, then completes', () => {
    assert.throws(() => crossDomainPlanHash({ ...plan, maximumInterimExposureQuoteAtoms: 899n }), /interim exposure bound/);
    assert.throws(() => crossDomainPlanHash({ ...plan, legs: [plan.legs[0]!] }), /2 to 8 domains/);
    assert.equal(toHex(crossDomainPlanHash({ ...plan, legs: [...plan.legs].reverse() })), toHex(crossDomainPlanHash(plan)), 'leg order does not change the plan');
    const start = replayCrossDomainCoordination(plan, [], 10n);
    assert.deepEqual(start.nextActions.map((a) => a.kind), ['PREPARE', 'PREPARE']);
    const half = replayCrossDomainCoordination(plan, [ev('PREPARED', 'svm:testnet', 20n), ev('PREPARED', 'eip155:84532', 30n, '52', 'OBSERVED')], 35n);
    assert.equal(half.phase, 'PREPARING');
    assert.equal(half.interimExposureQuoteAtoms, 900n);
    assert.deepEqual(half.nextActions, [{ kind: 'AWAIT_FINALITY', domainId: 'eip155:84532' }]);
    const decided = replayCrossDomainCoordination(plan, [ev('PREPARED', 'svm:testnet', 20n), ev('PREPARED', 'eip155:84532', 40n, '52')], 45n);
    assert.equal(decided.phase, 'COMMITTING');
    const done = replayCrossDomainCoordination(plan, [ev('PREPARED', 'svm:testnet', 20n), ev('PREPARED', 'eip155:84532', 40n, '52'), ev('COMMITTED', 'eip155:84532', 50n, '53'), ev('COMMITTED', 'svm:testnet', 60n, '54')], 70n);
    assert.equal(done.terminalState, 'FINALIZED_COMPLETE');
    assert.equal(done.interimExposureQuoteAtoms, 0n);
  });

  test('a failure or prepare expiry aborts and compensates every prepared domain', () => {
    const failed: CrossDomainEvent[] = [ev('PREPARED', 'svm:testnet', 20n), { kind: 'PREPARE_FAILED', domainId: 'eip155:84532', evidenceHash: '55'.repeat(32), atValue: 30n }];
    const aborting = replayCrossDomainCoordination(plan, failed, 35n);
    assert.equal(aborting.phase, 'ABORTING');
    assert.deepEqual(aborting.nextActions, [{ kind: 'COMPENSATE', domainId: 'svm:testnet' }]);
    const aborted = replayCrossDomainCoordination(plan, [...failed, ev('COMPENSATED', 'svm:testnet', 40n, '56')], 45n);
    assert.equal(aborted.terminalState, 'RECOVERED_FLAT');
    assert.equal(replayCrossDomainCoordination(plan, [], 101n).terminalState, 'NO_EFFECT', 'nothing prepared before expiry has no effect');
    assert.equal(replayCrossDomainCoordination(plan, [ev('PREPARED', 'svm:testnet', 20n)], 101n).phase, 'ABORTING');
    // A prepare that was only observed is compensated once aborting, never awaited forever.
    assert.deepEqual(replayCrossDomainCoordination(plan, [ev('PREPARED', 'svm:testnet', 20n, '51', 'OBSERVED')], 1_000_000n).nextActions, [{ kind: 'COMPENSATE', domainId: 'svm:testnet' }]);
    // A failure report for a domain already prepared fences instead of skipping its compensation.
    const overwrite = replayCrossDomainCoordination(plan, [ev('PREPARED', 'svm:testnet', 20n), { kind: 'PREPARE_FAILED', domainId: 'svm:testnet', evidenceHash: '58'.repeat(32), atValue: 21n }], 30n);
    assert.equal(overwrite.phase, 'FENCED');
  });

  test('conflicting evidence, commit without decision, a missed commit deadline, or backward time fence the package', () => {
    const prepared = [ev('PREPARED', 'svm:testnet', 20n), ev('PREPARED', 'eip155:84532', 40n, '52')];
    const cases: [CrossDomainEvent[], bigint][] = [
      [[ev('PREPARED', 'svm:testnet', 20n), ev('PREPARED', 'svm:testnet', 25n, '59')], 30n],
      [[ev('COMMITTED', 'svm:testnet', 20n)], 30n],
      [prepared, 201n],
      [[...prepared, ev('COMMITTED', 'eip155:84532', 150n, '53'), ev('COMMITTED', 'svm:testnet', 201n, '54')], 201n],
      [[ev('PREPARED', 'svm:testnet', 20n), ev('PREPARED', 'eip155:84532', 10n, '52')], 30n],
      [[...prepared, ev('COMPENSATED', 'svm:testnet', 50n, '57')], 60n],
    ];
    for (const [events, now] of cases) {
      const state = replayCrossDomainCoordination(plan, events, now);
      assert.equal(state.phase, 'FENCED', state.violations.join('; '));
      assert.equal(state.terminalState, 'MANUAL_INTERVENTION');
      assert.equal(state.nextActions.at(-1)?.kind, 'ESCALATE');
    }
  });
});

describe('manual controlled recovery', () => {
  const incident: ManualRecoveryIncidentInput = {
    incidentVersion: 1,
    environment: 'testnet',
    incidentId: 'incident-1',
    orderHash: '11'.repeat(32),
    timeUnit: 'EVM_UNIX_SECONDS',
    fencedAtValue: 100n,
    approverIds: ['ops-a', 'ops-b', 'risk-c'],
    approvalQuorum: 2,
    baselineTargetHash: '77'.repeat(32),
  };

  test('only quorum-approved actions run, automation is refused, and the exact baseline restores', () => {
    assert.throws(() => replayManualRecovery({ ...incident, approvalQuorum: 1 }, []), /quorum must be between 2/);
    const state = replayManualRecovery(incident, [
      { kind: 'AUTOMATED_ACTION_ATTEMPTED', actionHash: '61'.repeat(32), atValue: 101n },
      { kind: 'ACTION_APPROVED', actionHash: '62'.repeat(32), approverId: 'ops-a', atValue: 102n },
      { kind: 'ACTION_APPROVED', actionHash: '62'.repeat(32), approverId: 'ops-a', atValue: 103n },
      { kind: 'ACTION_APPROVED', actionHash: '62'.repeat(32), approverId: 'risk-c', atValue: 104n },
      { kind: 'ACTION_EXECUTED', actionHash: '62'.repeat(32), evidenceHash: '63'.repeat(32), atValue: 105n },
      { kind: 'BASELINE_VERIFIED', baselineHash: '77'.repeat(32), evidenceHash: '64'.repeat(32), atValue: 106n },
    ]);
    assert.equal(state.phase, 'RESTORED');
    assert.equal(state.refusedAutomatedActions, 1);
    assert.deepEqual(state.approvedActions[0]?.approvers, ['ops-a', 'risk-c']);
    const unapproved = replayManualRecovery(incident, [
      { kind: 'ACTION_APPROVED', actionHash: '62'.repeat(32), approverId: 'ops-a', atValue: 102n },
      { kind: 'ACTION_APPROVED', actionHash: '62'.repeat(32), approverId: 'outsider', atValue: 103n },
      { kind: 'ACTION_EXECUTED', actionHash: '62'.repeat(32), evidenceHash: '63'.repeat(32), atValue: 104n },
      { kind: 'BASELINE_VERIFIED', baselineHash: '77'.repeat(32), evidenceHash: '64'.repeat(32), atValue: 106n },
    ]);
    assert.equal(unapproved.phase, 'FENCED');
    assert.match(unapproved.violations.join('\n'), /not an approver[\s\S]*without quorum/);
    const wrongBaseline = replayManualRecovery(incident, [{ kind: 'BASELINE_VERIFIED', baselineHash: '78'.repeat(32), evidenceHash: '64'.repeat(32), atValue: 106n }]);
    assert.equal(wrongBaseline.phase, 'FENCED');
  });
  test('an approval hash binds the incident, action, approver, and time', () => {
    const approval = { incidentHash: '71'.repeat(32), actionHash: '72'.repeat(32), approverId: 'approver-1', atValue: 5n };
    const base = toHex(manualRecoveryApprovalHash(approval));
    for (const change of [{ incidentHash: '73'.repeat(32) }, { actionHash: '74'.repeat(32) }, { approverId: 'approver-2' }, { atValue: 6n }]) {
      assert.notEqual(toHex(manualRecoveryApprovalHash({ ...approval, ...change })), base);
    }
  });
});
