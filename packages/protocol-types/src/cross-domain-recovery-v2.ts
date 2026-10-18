import { checkedUnsigned } from './arithmetic.js';
import { toHex } from './bytes.js';
import { MalformedInputError } from './errors.js';
import { commitmentHash } from './package-order-primitives.js';
import type {
  CrossDomainAction, CrossDomainCoordination, CrossDomainDomainStatus, CrossDomainEvent,
  CrossDomainPhase, CrossDomainPlan,
} from './cross-domain-coordination.js';

export function replayRecoverableCrossDomainCoordination(
  plan: CrossDomainPlan,
  planHash: string,
  events: readonly CrossDomainEvent[],
  now: bigint,
): CrossDomainCoordination {
  if (!Array.isArray(events) || events.length > 128) throw new MalformedInputError('events', 'too many events');
  const states = new Map<string, CrossDomainDomainStatus>(plan.legs.map(leg => [leg.domain.domainId, 'PENDING']));
  const seen = new Map<string, { hash: string; rank: number }>();
  const violations: string[] = [];
  let phase: CrossDomainPhase = 'PREPARING';
  let lastAt = 0n;
  let anyPrepared = false;
  let commitDecided = false;
  const fence = (reason: string) => { violations.push(reason); phase = 'FENCED'; };
  const flat = () => [...states.values()].every(value => value === 'PENDING' || value === 'FAILED' || value === 'COMPENSATED');
  const deadlines = (at: bigint) => {
    if (phase === 'PREPARING' && at > plan.prepareDeadline) phase = 'ABORTING';
    if (phase === 'COMMITTING' && at > plan.commitDeadline) phase = 'ABORTING';
    if (phase === 'ABORTING' && !flat() && at > plan.compensationDeadline) fence('recovery deadline passed before every domain was reconciled');
  };
  for (const [index, event] of events.entries()) {
    if (violations.length > 0) break;
    const at = checkedUnsigned(event.atValue, 64, `events[${index}].atValue`);
    if (at < lastAt || at > now) { fence('event time is backward or in the future'); break; }
    lastAt = at;
    deadlines(at);
    if (violations.length > 0) break;
    const current = states.get(event.domainId);
    if (current === undefined) { fence('event names a domain outside the plan'); break; }
    const hash = toHex(commitmentHash(event.evidenceHash, 'event.evidenceHash'));
    const rank = event.kind === 'PREPARE_FAILED' || event.kind === 'COMMIT_FAILED' ? 2
      : event.finality === 'OBSERVED' ? 0 : event.finality === 'CONFIRMED' ? 1 : event.finality === 'FINALIZED' ? 2 : -1;
    if (rank < 0) { fence('event finality is unknown'); break; }
    const key = `${event.kind}/${event.domainId}`;
    const previous = seen.get(key);
    if (previous && (previous.hash !== hash || rank < previous.rank)) { fence('conflicting or regressing domain evidence'); break; }
    if (previous?.rank === rank) continue;
    seen.set(key, { hash, rank });
    const final = rank === 2;
    switch (event.kind) {
      case 'PREPARED':
        if ((phase !== 'PREPARING' && phase !== 'ABORTING') || (current !== 'PENDING' && current !== 'PREPARING') || commitDecided) {
          fence('prepare evidence conflicts with the decision'); break;
        }
        states.set(event.domainId, final ? 'PREPARED' : 'PREPARING');
        anyPrepared = true;
        break;
      case 'PREPARE_FAILED':
        if (current !== 'PENDING' || commitDecided) { fence('prepare failure cannot erase held inventory'); break; }
        states.set(event.domainId, 'FAILED');
        phase = 'ABORTING';
        break;
      case 'COMMITTED':
        if (!commitDecided || (phase !== 'COMMITTING' && phase !== 'ABORTING')
          || (current !== 'PREPARED' && current !== 'COMMITTING')) {
          fence('commit evidence conflicts with the domain state'); break;
        }
        states.set(event.domainId, final ? 'COMMITTED' : 'COMMITTING');
        break;
      case 'COMMIT_FAILED':
        if (!commitDecided || (phase !== 'COMMITTING' && phase !== 'ABORTING')
          || (current !== 'PREPARED' && current !== 'COMMITTING')) {
          fence('commit failure cannot erase an executed position'); break;
        }
        // The driver must prove the entry has no effect and cannot execute later.
        states.set(event.domainId, 'COMMIT_FAILED');
        phase = 'ABORTING';
        break;
      case 'COMPENSATED':
        if (phase !== 'ABORTING' || !(current === 'COMPENSATING' || current === 'COMMITTED'
          || current === 'COMMIT_FAILED' || (!commitDecided && (current === 'PREPARED' || current === 'PREPARING')))) {
          fence('compensation cannot bypass an unknown commit outcome'); break;
        }
        states.set(event.domainId, final ? 'COMPENSATED' : 'COMPENSATING');
        break;
      default: fence('unknown coordination event');
    }
    if (phase === 'PREPARING' && [...states.values()].every(value => value === 'PREPARED')) {
      commitDecided = true;
      phase = 'COMMITTING';
    }
    if (phase === 'COMMITTING' && [...states.values()].every(value => value === 'COMMITTED')) phase = 'COMMITTED';
    if (phase === 'ABORTING' && flat()) phase = 'ABORTED';
  }
  deadlines(now);
  if (phase === 'ABORTING' && flat()) phase = 'ABORTED';
  const nextActions: CrossDomainAction[] = [];
  for (const [domainId, state] of states) {
    if (phase === 'PREPARING' && state === 'PENDING') nextActions.push({ kind: 'PREPARE', domainId });
    else if (phase === 'COMMITTING' && state === 'PREPARED') nextActions.push({ kind: 'COMMIT', domainId });
    else if (phase === 'ABORTING' && commitDecided && (state === 'PREPARED' || state === 'COMMITTING')) {
      nextActions.push({ kind: 'RECONCILE_COMMIT', domainId });
    } else if (phase === 'ABORTING' && (state === 'COMMITTED' || state === 'COMMIT_FAILED'
      || (!commitDecided && (state === 'PREPARED' || state === 'PREPARING')))) {
      nextActions.push({ kind: 'COMPENSATE', domainId });
    } else if ((phase === 'PREPARING' || phase === 'COMMITTING' || phase === 'ABORTING')
      && (state === 'PREPARING' || state === 'COMMITTING' || state === 'COMPENSATING')) {
      nextActions.push({ kind: 'AWAIT_FINALITY', domainId });
    }
  }
  const finalPhase: CrossDomainPhase = violations.length > 0 ? 'FENCED' : phase;
  if (finalPhase === 'FENCED') nextActions.push({ kind: 'ESCALATE', reason: violations.at(-1)! });
  const terminalState = finalPhase === 'FENCED' ? 'MANUAL_INTERVENTION' : phase === 'COMMITTED' ? 'FINALIZED_COMPLETE'
    : phase === 'ABORTED' ? anyPrepared ? 'RECOVERED_FLAT' : 'NO_EFFECT' : undefined;
  const interimExposureQuoteAtoms = terminalState === 'FINALIZED_COMPLETE' ? 0n : plan.legs
    .filter(leg => !['PENDING', 'FAILED', 'COMPENSATED'].includes(states.get(leg.domain.domainId)!))
    .reduce((sum, leg) => sum + leg.interimExposureQuoteAtoms, 0n);
  return Object.freeze({ planHash, phase: finalPhase, domains: Object.freeze(Object.fromEntries(states)), interimExposureQuoteAtoms,
    ...(terminalState === undefined ? {} : { terminalState }), nextActions: Object.freeze(nextActions), violations: Object.freeze(violations) });
}
