import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  crossDomainCompensationActionHash,
  crossDomainExecutionBundle,
  crossDomainPlanHash,
  domainRef,
  replayCrossDomainCoordination,
  manualRecoveryApprovalHash,
  replayManualRecovery,
  toHex,
  type CrossDomainEvent,
  type CrossDomainCompensationActionInput,
  type CrossDomainPlanInput,
  type ManualRecoveryIncidentInput,
} from '../src/index.js';

const compensation = (
  domain: ReturnType<typeof domainRef>,
  legIds: readonly string[],
  inventoryReservationId: string,
  payloadByte: string,
): CrossDomainCompensationActionInput => ({
  actionVersion: 1,
  environment: 'testnet',
  orderHash: '11'.repeat(32),
  quoteHash: '12'.repeat(32),
  routeHash: '13'.repeat(32),
  domain,
  legIds,
  inventoryReservationId,
  actionKind: 'RELEASE_RESERVED_INVENTORY',
  executorClassId: 'testnet-reservation-executor',
  executorClassVersion: 1,
  executorClassManifestHash: '61'.repeat(32),
  actionPayloadHash: payloadByte.repeat(32),
  maximumCostQuoteAtoms: 10n,
  expiryUnit: 'EVM_UNIX_SECONDS',
  expiryValue: 300n,
});

const plan: CrossDomainPlanInput = {
  planVersion: 1,
  environment: 'testnet',
  orderHash: '11'.repeat(32),
  quoteHash: '12'.repeat(32),
  routeHash: '13'.repeat(32),
  timeUnit: 'EVM_UNIX_SECONDS',
  prepareDeadline: 100n,
  commitDeadline: 200n,
  compensationDeadline: 300n,
  maximumInterimExposureQuoteAtoms: 1_000n,
  legs: [
    { domain: domainRef('svm:testnet', 1, '21'.repeat(32)), legIds: ['spot'], inventoryReservationId: '31'.repeat(32), interimExposureQuoteAtoms: 400n, compensationActionHash: '41'.repeat(32) },
    { domain: domainRef('eip155:84532', 1, '22'.repeat(32)), legIds: ['perp'], inventoryReservationId: '32'.repeat(32), interimExposureQuoteAtoms: 500n, compensationActionHash: '42'.repeat(32) },
  ],
};
const ev = (kind: 'PREPARED' | 'COMMITTED' | 'COMPENSATED', domainId: string, atValue: bigint, evidence = '51', finality: 'OBSERVED' | 'FINALIZED' = 'FINALIZED'): CrossDomainEvent => ({ kind, domainId, evidenceHash: evidence.repeat(32), finality, atValue });

describe('cross-domain prepositioned coordination', () => {
  test('binds one exact compensation action to every planned domain', () => {
    const actions = [
      compensation(plan.legs[0]!.domain, plan.legs[0]!.legIds, '31'.repeat(32), '71'),
      compensation(plan.legs[1]!.domain, plan.legs[1]!.legIds, '32'.repeat(32), '72'),
    ];
    const boundPlan: CrossDomainPlanInput = {
      ...plan,
      legs: plan.legs.map((leg, index) => ({
        ...leg,
        compensationActionHash: crossDomainCompensationActionHash(actions[index]!),
      })),
    };
    const bundle = crossDomainExecutionBundle({ plan: boundPlan, compensations: actions });
    assert.equal(bundle.compensations.length, 2);
    assert.throws(
      () => crossDomainExecutionBundle({
        plan: boundPlan,
        compensations: [{ ...actions[0]!, actionPayloadHash: '73'.repeat(32) }, actions[1]!],
      }),
      /does not match its plan commitment/,
    );
    assert.throws(
      () => crossDomainExecutionBundle({
        plan: boundPlan,
        compensations: [{ ...actions[0]!, inventoryReservationId: '74'.repeat(32) }, actions[1]!],
      }),
      /another reservation or leg set/,
    );
  });

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
    assert.deepEqual(replayCrossDomainCoordination(plan, [ev('PREPARED', 'svm:testnet', 20n, '51', 'OBSERVED')], 101n).nextActions, [{ kind: 'COMPENSATE', domainId: 'svm:testnet' }]);
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
      [[ev('PREPARED', 'svm:testnet', 20n), { kind: 'PREPARE_FAILED', domainId: 'eip155:84532', evidenceHash: '55'.repeat(32), atValue: 30n }], 301n],
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

describe('versioned filled-position recovery', () => {
  const recoverable = { ...plan, planVersion: 2 };
  const prepared = [ev('PREPARED', 'svm:testnet', 20n), ev('PREPARED', 'eip155:84532', 40n, '52')];
  const committed = ev('COMMITTED', 'svm:testnet', 50n, '53');
  const failed: CrossDomainEvent = { kind: 'COMMIT_FAILED', domainId: 'eip155:84532', evidenceHash: '54'.repeat(32), atValue: 201n };

  test('preserves v1 commitments and requires reverse-filled actions for v2', () => {
    assert.equal(toHex(crossDomainPlanHash(plan)), '0475eff38a3898222f143d75300479118d52e69bbf349fd5ebdddc567da404db');
    assert.notEqual(toHex(crossDomainPlanHash(recoverable)), toHex(crossDomainPlanHash(plan)));
    assert.throws(() => crossDomainPlanHash({ ...plan, planVersion: 3 }), /version/);
    const actions = plan.legs.map((leg, i) => compensation(leg.domain, leg.legIds, toHex(typeof leg.inventoryReservationId === 'string'
      ? Buffer.from(leg.inventoryReservationId, 'hex') : leg.inventoryReservationId), i === 0 ? '71' : '72'));
    const bundle = (items: CrossDomainCompensationActionInput[]) => ({
      plan: { ...recoverable, legs: plan.legs.map((leg, i) => ({ ...leg, compensationActionHash: crossDomainCompensationActionHash(items[i]!) })) },
      compensations: items,
    });
    assert.throws(() => crossDomainExecutionBundle(bundle(actions)), /filled-position recovery/);
    assert.equal(crossDomainExecutionBundle(bundle(actions.map(action => ({ ...action, actionKind: 'REVERSE_FILLED_LEGS' })))).plan.planVersion, 2);
  });

  test('replays filled-side reversal and failed-side release to a verified flat outcome', () => {
    const events = [...prepared, committed, failed];
    const aborting = replayCrossDomainCoordination(recoverable, events, 202n);
    assert.equal(aborting.phase, 'ABORTING');
    assert.equal(aborting.interimExposureQuoteAtoms, 900n);
    assert.deepEqual(aborting.nextActions.map(action => action.kind), ['COMPENSATE', 'COMPENSATE']);
    const recovered = [...events, ev('COMPENSATED', 'svm:testnet', 210n, '55'), ev('COMPENSATED', 'eip155:84532', 220n, '56')];
    assert.equal(replayCrossDomainCoordination(recoverable, recovered, 221n).terminalState, 'RECOVERED_FLAT');
    const restarted = replayCrossDomainCoordination(recoverable, recovered, 400n);
    assert.equal(restarted.terminalState, 'RECOVERED_FLAT');
    assert.equal(restarted.interimExposureQuoteAtoms, 0n);
    assert.equal(replayCrossDomainCoordination(plan, events, 202n).terminalState, 'MANUAL_INTERVENTION');
  });

  test('reconciles unknown outcomes without treating expiry or missing receipts as no effect', () => {
    const state = replayCrossDomainCoordination(recoverable, [...prepared, committed], 201n);
    assert.deepEqual(state.nextActions, [{ kind: 'RECONCILE_COMMIT', domainId: 'eip155:84532' }, { kind: 'COMPENSATE', domainId: 'svm:testnet' }]);
    const unsafe = replayCrossDomainCoordination(recoverable, [...prepared, committed, ev('COMPENSATED', 'eip155:84532', 202n, '59')], 203n);
    assert.equal(unsafe.terminalState, 'MANUAL_INTERVENTION');
    const late = replayCrossDomainCoordination(recoverable, [...prepared, committed, ev('COMMITTED', 'eip155:84532', 202n, '58')], 203n);
    assert.equal(late.phase, 'ABORTING');
    assert.deepEqual(late.nextActions.map(action => action.kind), ['COMPENSATE', 'COMPENSATE']);
    assert.equal(replayCrossDomainCoordination(recoverable, [...prepared, committed], 301n).terminalState, 'MANUAL_INTERVENTION');
  });

  test('only final evidence completes; failures cannot erase executed positions', () => {
    const observed = ev('COMMITTED', 'svm:testnet', 50n, '53', 'OBSERVED');
    assert.equal(replayCrossDomainCoordination(recoverable, [...prepared, observed], 60n).domains['svm:testnet'], 'COMMITTING');
    const finalEvents = [...prepared, observed, { ...committed, atValue: 51n }, ev('COMMITTED', 'eip155:84532', 60n, '54')];
    assert.equal(replayCrossDomainCoordination(recoverable, finalEvents, 400n).terminalState, 'FINALIZED_COMPLETE');
    const cases: CrossDomainEvent[][] = [
      [...prepared, committed, { ...failed, domainId: 'svm:testnet' }],
      [...prepared, committed, { ...committed, atValue: 55n, evidenceHash: '59'.repeat(32) }],
      [...prepared, committed, { ...observed, atValue: 55n }],
      [...prepared, { ...committed, atValue: 39n }],
      [...prepared, { ...committed, atValue: 202n }],
      [...prepared, { kind: 'COMMITTED', domainId: 'svm:testnet', evidenceHash: '53'.repeat(32), atValue: 50n } as CrossDomainEvent],
    ];
    for (const events of cases) assert.equal(replayCrossDomainCoordination(recoverable, events, 201n).phase, 'FENCED');
    assert.equal(replayCrossDomainCoordination(recoverable, [], 400n).terminalState, 'NO_EFFECT');
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
