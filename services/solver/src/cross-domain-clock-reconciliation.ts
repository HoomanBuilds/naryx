import { createHash } from 'node:crypto';
import { commitmentHash, crossDomainPlanHash, replayCrossDomainCoordination, stringifyProtocolJson, toHex,
  type CrossDomainEvent, type CrossDomainPlanInput } from '@naryx/protocol-types';

export interface FinalizedClockSkewResolution {
  readonly kind: 'FINALIZED_CLOCK_SKEW';
  readonly planHash: string;
  readonly historyHash: string;
  readonly observedAtMs: number;
  readonly receipts: readonly { domainId: string; evidenceHash: string; transactionHash: string }[];
}

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Clock reconciliation refused: ${message}`);
}

export function finalizedClockSkewHistory(plan: CrossDomainPlanInput, events: readonly CrossDomainEvent[], now: bigint) {
  requireCondition(plan.environment === 'testnet' && plan.planVersion === 2 && plan.timeUnit === 'EVM_UNIX_SECONDS'
    && plan.legs.length === 2 && new Set(plan.legs.map(leg => leg.domain.domainId)).size === 2
    && plan.legs.every(leg => ['eip155:84532', 'eip155:421614'].includes(leg.domain.domainId)), 'unsupported plan');
  const original = replayCrossDomainCoordination(plan, events, now);
  requireCondition(original.phase === 'FENCED' && original.violations.length === 1
    && original.violations[0] === 'event time is backward or in the future', 'not an isolated clock-order fence');
  const perDomain = new Map<string, bigint>();
  let previous = 0n;
  let skewed = false;
  const projected = events.map(event => {
    requireCondition((event.kind === 'PREPARED' || event.kind === 'COMMITTED') && event.atValue <= now,
      'failure, compensation or future evidence requires manual recovery');
    requireCondition(event.atValue >= (perDomain.get(event.domainId) ?? 0n), 'one domain clock runs backward');
    perDomain.set(event.domainId, event.atValue);
    if (event.atValue < previous) skewed = true;
    else previous = event.atValue;
    return { ...event, atValue: previous };
  });
  const checked = replayCrossDomainCoordination(plan, projected, now);
  requireCondition(skewed && checked.terminalState === 'FINALIZED_COMPLETE' && checked.violations.length === 0,
    'complete, timely finality evidence is missing or conflicting');
  const expected = plan.legs.map(leg => {
    const last = [...events].reverse().find(event => event.domainId === leg.domain.domainId && event.kind === 'COMMITTED');
    requireCondition(last?.kind === 'COMMITTED' && last.finality === 'FINALIZED', 'domain has no finalized commit');
    return { domainId: leg.domain.domainId, evidenceHash: toHex(commitmentHash(last.evidenceHash)) };
  });
  return { planHash: toHex(crossDomainPlanHash(plan)),
    historyHash: createHash('sha256').update('NARYX/clock-reconciliation/v1\0').update(stringifyProtocolJson({ plan, events })).digest('hex'), expected };
}

export async function verifyFinalizedClockSkew(plan: CrossDomainPlanInput, events: readonly CrossDomainEvent[], nowMs: number,
  observe: (domainId: string) => Promise<{ status: string; evidenceHash: string; transactionHash: string }>): Promise<FinalizedClockSkewResolution> {
  requireCondition(Number.isSafeInteger(nowMs) && nowMs >= 0, 'invalid observation time');
  const history = finalizedClockSkewHistory(plan, events, BigInt(Math.floor(nowMs / 1000)));
  const receipts = [];
  for (const expected of history.expected) {
    const proof = await observe(expected.domainId);
    requireCondition(proof.status === 'FINALIZED' && proof.evidenceHash === expected.evidenceHash
      && /^0x[0-9a-f]{64}$/.test(proof.transactionHash) && !/^0x0{64}$/.test(proof.transactionHash),
    'fresh finalized receipt does not match journal evidence');
    receipts.push({ ...expected, transactionHash: proof.transactionHash });
  }
  return { kind: 'FINALIZED_CLOCK_SKEW', planHash: history.planHash, historyHash: history.historyHash, observedAtMs: nowMs, receipts };
}
