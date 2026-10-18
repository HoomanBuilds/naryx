import type { CrossDomainExecutionCoordinator, CrossDomainAdvanceResult } from './cross-domain-execution-coordinator.js';
import type { SqliteCrossDomainJobStore, CrossDomainJob } from './cross-domain-job-store.js';

interface CrossDomainWorkerChecks {
  validate(job: CrossDomainJob): void;
  reconcileTerminal(job: CrossDomainJob, result: CrossDomainAdvanceResult): Promise<boolean>;
}

export class CrossDomainWorker {
  readonly #store: SqliteCrossDomainJobStore;
  readonly #coordinator: Pick<CrossDomainExecutionCoordinator, 'advance'>;
  readonly #checks: CrossDomainWorkerChecks;
  #running: Promise<void> | undefined;

  constructor(store: SqliteCrossDomainJobStore, coordinator: Pick<CrossDomainExecutionCoordinator, 'advance'>,
    checks: CrossDomainWorkerChecks) {
    this.#store = store;
    this.#coordinator = coordinator;
    this.#checks = checks;
  }

  tick(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    const running = this.#tick().finally(() => { this.#running = undefined; });
    this.#running = running;
    return running;
  }

  async drain(): Promise<void> { await this.#running; }

  async #tick(): Promise<void> {
    for (const planHash of this.#store.active()) {
      const job = this.#store.get(planHash);
      if (job === undefined) throw new Error('Active cross-domain job disappeared');
      try {
        this.#checks.validate(job);
        const result = await this.#coordinator.advance(job.bundle, job.execution);
        const terminal = result.status === 'TERMINAL';
        const safeTerminal = terminal && (result.state.terminalState === 'FINALIZED_COMPLETE'
          || result.state.terminalState === 'RECOVERED_FLAT' || result.state.terminalState === 'NO_EFFECT');
        const reconciled = safeTerminal && await this.#checks.reconcileTerminal(job, result);
        this.#store.record(planHash, reconciled ? 'TERMINAL' : safeTerminal ? 'ACTIVE'
          : terminal || result.status === 'ESCALATION_REQUIRED' ? 'ESCALATION_REQUIRED' : 'ACTIVE');
      } catch {
        this.#store.record(planHash, 'ACTIVE', 'Execution advance failed; account remains fenced until reconciliation succeeds.');
      }
    }
  }
}
