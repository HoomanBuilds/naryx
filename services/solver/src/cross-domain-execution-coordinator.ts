import {
  bytesEqual,
  crossDomainPlan,
  crossDomainPlanHash,
  replayCrossDomainCoordination,
  toHex,
  type CrossDomainAction,
  type CrossDomainCoordination,
  type CrossDomainEvent,
  type CrossDomainLegInput,
  type CrossDomainPlanInput,
  type DomainRef,
} from '@naryx/protocol-types';
import type {
  PreparedStrategyDomainTransport,
  PreparedStrategyExecutionTransport,
} from './strategy-execution-transport.js';

export interface CrossDomainCoordinationSnapshot {
  readonly plan: CrossDomainPlanInput;
  readonly events: readonly CrossDomainEvent[];
  readonly state: CrossDomainCoordination;
}

export interface CrossDomainCoordinationJournal {
  registerPlan(plan: CrossDomainPlanInput): Promise<void>;
  snapshot(planHash: string): Promise<CrossDomainCoordinationSnapshot>;
  appendEvent(planHash: string, event: CrossDomainEvent): Promise<void>;
}

export interface CrossDomainDriverAdvanceInput {
    planHash: string;
    action: Exclude<CrossDomainAction, Readonly<{ kind: 'ESCALATE' }>>;
    plan: CrossDomainPlanInput;
    planLeg: CrossDomainLegInput;
    execution: PreparedStrategyDomainTransport;
    events: readonly CrossDomainEvent[];
}

export interface CrossDomainExecutionDriver {
  readonly domain: DomainRef;
  advance(input: Readonly<CrossDomainDriverAdvanceInput>): Promise<CrossDomainEvent | undefined>;
}

export interface CrossDomainAdvanceResult {
  readonly planHash: string;
  readonly status: 'ADVANCED' | 'PENDING' | 'TERMINAL' | 'ESCALATION_REQUIRED';
  readonly state: CrossDomainCoordination;
  readonly action?: CrossDomainAction;
  readonly event?: CrossDomainEvent;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function eventAllowed(
  action: Exclude<CrossDomainAction, Readonly<{ kind: 'ESCALATE' }>>,
  state: CrossDomainCoordination,
  event: CrossDomainEvent,
): boolean {
  if (action.kind === 'PREPARE') return event.kind === 'PREPARED' || event.kind === 'PREPARE_FAILED';
  if (action.kind === 'COMMIT') return event.kind === 'COMMITTED';
  if (action.kind === 'COMPENSATE') return event.kind === 'COMPENSATED';
  const domainStatus = state.domains[action.domainId];
  if (domainStatus === 'PREPARING') return event.kind === 'PREPARED' || event.kind === 'PREPARE_FAILED';
  if (domainStatus === 'COMMITTING') return event.kind === 'COMMITTED';
  if (domainStatus === 'COMPENSATING') return event.kind === 'COMPENSATED';
  return false;
}

export class CrossDomainExecutionCoordinator {
  readonly #journal: CrossDomainCoordinationJournal;
  readonly #drivers: readonly CrossDomainExecutionDriver[];
  readonly #pending = new Map<string, Promise<CrossDomainAdvanceResult>>();

  constructor(journal: CrossDomainCoordinationJournal, drivers: readonly CrossDomainExecutionDriver[]) {
    requireCondition(drivers.length >= 2, 'cross-domain execution requires at least two domain drivers');
    for (const [index, driver] of drivers.entries()) {
      requireCondition(drivers.findIndex((candidate) => sameDomain(candidate.domain, driver.domain)) === index,
        `cross-domain execution driver ${driver.domain.domainId} is duplicated`);
    }
    this.#journal = journal;
    this.#drivers = Object.freeze([...drivers]);
  }

  async advance(
    plan: CrossDomainPlanInput,
    execution: PreparedStrategyExecutionTransport,
  ): Promise<CrossDomainAdvanceResult> {
    const planHash = toHex(crossDomainPlanHash(plan));
    const pending = this.#pending.get(planHash);
    if (pending !== undefined) return pending;
    const task = this.#advance(plan, execution, planHash);
    this.#pending.set(planHash, task);
    try {
      return await task;
    } finally {
      this.#pending.delete(planHash);
    }
  }

  async #advance(
    planInput: CrossDomainPlanInput,
    execution: PreparedStrategyExecutionTransport,
    planHash: string,
  ): Promise<CrossDomainAdvanceResult> {
    const plan = crossDomainPlan(planInput);
    requireCondition(execution.coordination === 'CROSS_DOMAIN_PREPOSITIONED'
      && execution.settlementClass === 'CROSS_DOMAIN_PREPOSITIONED', 'prepared execution is not cross-domain prepositioned');
    requireCondition(execution.crossDomainPlanHash !== undefined
      && toHex(execution.crossDomainPlanHash) === planHash, 'prepared execution binds another cross-domain plan');
    requireCondition(bytesEqual(execution.orderHash, plan.orderHash), 'prepared execution binds another order');
    requireCondition(bytesEqual(execution.quoteHash, plan.quoteHash), 'prepared execution binds another quote');
    requireCondition(bytesEqual(execution.routeHash, plan.routeHash), 'prepared execution binds another route');
    requireCondition(execution.domains.length === plan.legs.length, 'prepared execution does not cover every planned domain');
    for (const leg of plan.legs) {
      requireCondition(execution.domains.filter((candidate) => sameDomain(candidate.domain, leg.domain)).length === 1,
        `prepared execution must cover ${leg.domain.domainId} exactly once`);
      requireCondition(this.#drivers.filter((candidate) => sameDomain(candidate.domain, leg.domain)).length === 1,
        `execution driver must cover ${leg.domain.domainId} exactly once`);
    }

    await this.#journal.registerPlan(planInput);
    const snapshot = await this.#checkedSnapshot(planHash, planInput);
    if (snapshot.state.terminalState !== undefined) {
      return Object.freeze({ planHash, status: 'TERMINAL', state: snapshot.state });
    }
    const action = snapshot.state.nextActions[0];
    requireCondition(action !== undefined, 'cross-domain coordination has no terminal state or next action');
    if (action.kind === 'ESCALATE') {
      return Object.freeze({ planHash, status: 'ESCALATION_REQUIRED', state: snapshot.state, action });
    }
    const driver = this.#drivers.find((candidate) => candidate.domain.domainId === action.domainId)!;
    const planLeg = planInput.legs.find((candidate) => candidate.domain.domainId === action.domainId)!;
    const domainExecution = execution.domains.find((candidate) => candidate.domain.domainId === action.domainId)!;
    const event = await driver.advance({
      planHash,
      action,
      plan: planInput,
      planLeg,
      execution: domainExecution,
      events: snapshot.events,
    });
    if (event === undefined) {
      return Object.freeze({ planHash, status: 'PENDING', state: snapshot.state, action });
    }
    requireCondition(event.domainId === action.domainId, 'domain driver returned evidence for another domain');
    requireCondition(eventAllowed(action, snapshot.state, event), `domain driver returned ${event.kind} evidence for ${action.kind}`);
    replayCrossDomainCoordination(planInput, [...snapshot.events, event], event.atValue);
    await this.#journal.appendEvent(planHash, event);
    const after = await this.#checkedSnapshot(planHash, planInput);
    return Object.freeze({ planHash, status: 'ADVANCED', state: after.state, action, event });
  }

  async #checkedSnapshot(
    planHash: string,
    expectedPlan: CrossDomainPlanInput,
  ): Promise<CrossDomainCoordinationSnapshot> {
    const snapshot = await this.#journal.snapshot(planHash);
    requireCondition(toHex(crossDomainPlanHash(snapshot.plan)) === planHash
      && toHex(crossDomainPlanHash(expectedPlan)) === planHash, 'coordination journal returned another plan');
    requireCondition(snapshot.state.planHash === planHash, 'coordination journal returned another state');
    return snapshot;
  }
}
