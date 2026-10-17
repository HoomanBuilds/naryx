import type Database from 'better-sqlite3';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import { openDurableDatabase } from './durable-sqlite.js';
import type { HyperliquidTestnetTerminalExecutionRequest, HyperliquidTestnetTerminalExecutionResult } from './hyperliquid-testnet-terminal.js';
import { parseHyperliquidTestnetTerminalExecutionRequest } from './hyperliquid-testnet-terminal.js';
import type { HyperliquidTestnetAttemptState } from './hyperliquid-testnet-terminal-execution.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;

export interface OwnerCohortBinding {
  readonly owner: string;
  readonly settlementAccount: string;
  readonly orderHash: string;
}

export interface OwnerCohortPort {
  bind(request: HyperliquidTestnetTerminalExecutionRequest): OwnerCohortBinding;
  requireOwnerAuthorization(request: HyperliquidTestnetTerminalExecutionRequest): void;
  execute(request: HyperliquidTestnetTerminalExecutionRequest): Promise<HyperliquidTestnetTerminalExecutionResult>;
  status(request: HyperliquidTestnetTerminalExecutionRequest): Promise<HyperliquidTestnetAttemptState>;
  receiptHash(request: HyperliquidTestnetTerminalExecutionRequest): string | undefined;
}

export interface OwnerCohortMember extends OwnerCohortBinding {
  readonly request: HyperliquidTestnetTerminalExecutionRequest;
  readonly state: 'READY' | 'STARTED' | 'SETTLED' | 'NO_EFFECT' | 'RECOVERY_REQUIRED';
  readonly receiptHash: string | null;
}

export interface OwnerCohort {
  readonly version: 1;
  readonly cohortId: string;
  readonly environment: 'TESTNET';
  readonly domain: 'hypercore:testnet';
  readonly guarantee: 'SEQUENCED_OWNER_ACCOUNT_EXECUTION';
  readonly collateralNetting: false;
  readonly state: 'READY' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'BLOCKED';
  readonly members: readonly OwnerCohortMember[];
}

export class OwnerCohortError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export class HyperliquidOwnerCohorts {
  readonly #db: Database.Database;
  readonly #port: OwnerCohortPort;
  readonly #running = new Map<string, Promise<OwnerCohort>>();

  constructor(path: string, port: OwnerCohortPort) {
    this.#port = port;
    this.#db = openDurableDatabase(path, `
      CREATE TABLE IF NOT EXISTS hyperliquid_owner_cohorts (
        cohort_id TEXT PRIMARY KEY, requests_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS hyperliquid_owner_cohort_members (
        cohort_id TEXT NOT NULL REFERENCES hyperliquid_owner_cohorts(cohort_id),
        ordinal INTEGER NOT NULL, attempt_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL, settlement_account TEXT NOT NULL, order_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('READY','STARTED','SETTLED','NO_EFFECT','RECOVERY_REQUIRED')),
        receipt_hash TEXT UNIQUE, PRIMARY KEY(cohort_id, ordinal)
      ) STRICT;
    `, (code, message) => new OwnerCohortError(code, message));
  }

  prepare(cohortId: string, input: readonly HyperliquidTestnetTerminalExecutionRequest[]): OwnerCohort {
    if (!ID.test(cohortId) || !Array.isArray(input) || input.length < 2 || input.length > 8) {
      throw new OwnerCohortError('INVALID_COHORT', 'A cohort needs an id and two to eight distinct owners.');
    }
    const requests = input.map(parseHyperliquidTestnetTerminalExecutionRequest);
    const json = stringifyProtocolJson(requests);
    const existing = this.#db.prepare('SELECT requests_json FROM hyperliquid_owner_cohorts WHERE cohort_id = ?').get(cohortId) as { requests_json: string } | undefined;
    if (existing !== undefined) {
      if (existing.requests_json !== json) throw new OwnerCohortError('IDEMPOTENCY_CONFLICT', 'Cohort membership cannot change.');
      return this.get(cohortId)!;
    }
    const bindings = requests.map((request) => {
      this.#port.requireOwnerAuthorization(request);
      return this.#binding(request);
    });
    if (new Set(bindings.map((binding) => binding.owner)).size !== requests.length
      || new Set(requests.map((request) => request.attemptId)).size !== requests.length
      || new Set(requests.map((request) => request.idempotencyKey)).size !== requests.length) {
      throw new OwnerCohortError('DUPLICATE_MEMBER', 'Each owner and execution may appear only once.');
    }
    this.#db.transaction(() => {
      for (const request of requests) {
        if (this.#db.prepare('SELECT 1 FROM hyperliquid_owner_cohort_members WHERE attempt_id = ? OR idempotency_key = ?')
          .get(request.attemptId, request.idempotencyKey)) throw new OwnerCohortError('ATTEMPT_ASSIGNED', 'An execution already belongs to a cohort.');
      }
      this.#db.prepare('INSERT INTO hyperliquid_owner_cohorts VALUES (?, ?, ?)').run(cohortId, json, Date.now());
      for (const [ordinal, request] of requests.entries()) {
        const binding = bindings[ordinal]!;
        this.#db.prepare("INSERT INTO hyperliquid_owner_cohort_members VALUES (?, ?, ?, ?, ?, ?, ?, 'READY', NULL)")
          .run(cohortId, ordinal, request.attemptId, request.idempotencyKey, binding.owner, binding.settlementAccount, binding.orderHash);
      }
    }).immediate();
    return this.get(cohortId)!;
  }

  #binding(request: HyperliquidTestnetTerminalExecutionRequest): OwnerCohortBinding {
    const binding = this.#port.bind(request);
    if (!ADDRESS.test(binding.owner) || binding.owner !== binding.settlementAccount || !HASH.test(binding.orderHash)) {
      throw new OwnerCohortError('INVALID_BINDING', 'Each signed order must settle in its own owner account.');
    }
    return binding;
  }

  get(cohortId: string): OwnerCohort | undefined {
    const known = this.#db.prepare('SELECT 1 FROM hyperliquid_owner_cohorts WHERE cohort_id = ?').get(cohortId);
    if (known === undefined) return undefined;
    const rows = this.#db.prepare('SELECT * FROM hyperliquid_owner_cohort_members WHERE cohort_id = ? ORDER BY ordinal').all(cohortId) as {
      attempt_id: string; idempotency_key: string; owner: string; settlement_account: string; order_hash: string;
      state: OwnerCohortMember['state']; receipt_hash: string | null;
    }[];
    const members = rows.map((row): OwnerCohortMember => Object.freeze({ request: Object.freeze({ attemptId: row.attempt_id, idempotencyKey: row.idempotency_key }),
      owner: row.owner, settlementAccount: row.settlement_account, orderHash: row.order_hash, state: row.state, receiptHash: row.receipt_hash }));
    const state = members.every((member) => member.state === 'SETTLED') ? 'SETTLED'
      : members.some((member) => ['STARTED', 'NO_EFFECT', 'RECOVERY_REQUIRED'].includes(member.state)) ? 'BLOCKED'
      : members.some((member) => member.state === 'SETTLED') ? 'PARTIALLY_SETTLED' : 'READY';
    return Object.freeze({ version: 1, cohortId, environment: 'TESTNET', domain: 'hypercore:testnet',
      guarantee: 'SEQUENCED_OWNER_ACCOUNT_EXECUTION', collateralNetting: false, state, members: Object.freeze(members) });
  }

  execute(cohortId: string): Promise<OwnerCohort> {
    const active = this.#running.get(cohortId);
    if (active !== undefined) return active;
    if (this.#running.size >= 8) return Promise.reject(new OwnerCohortError('BUSY', 'Too many active cohorts.'));
    const task = Promise.resolve().then(() => this.#execute(cohortId));
    this.#running.set(cohortId, task);
    return task.finally(() => this.#running.delete(cohortId));
  }

  async #execute(cohortId: string): Promise<OwnerCohort> {
    const cohort = this.get(cohortId);
    if (cohort === undefined) throw new OwnerCohortError('NOT_FOUND', 'Cohort does not exist.');
    if (cohort.state === 'SETTLED') return cohort;
    for (const member of cohort.members.filter((candidate) => candidate.state === 'READY')) {
      this.#port.requireOwnerAuthorization(member.request);
      const binding = this.#binding(member.request);
      if (binding.owner !== member.owner || binding.orderHash !== member.orderHash) throw new OwnerCohortError('BINDING_CHANGED', 'Cohort binding changed.');
    }
    for (const [ordinal, member] of cohort.members.entries()) {
      if (member.state === 'SETTLED') continue;
      if (member.state === 'NO_EFFECT') return this.get(cohortId)!;
      let result: HyperliquidTestnetTerminalExecutionResult;
      if (member.state === 'STARTED' || member.state === 'RECOVERY_REQUIRED') {
        const status = await this.#port.status(member.request);
        if (status.state !== 'COMPLETED') return this.get(cohortId)!;
        result = status.result;
      } else {
        const claimed = this.#db.prepare("UPDATE hyperliquid_owner_cohort_members SET state = 'STARTED' WHERE cohort_id = ? AND ordinal = ? AND state = 'READY'")
          .run(cohortId, ordinal);
        if (claimed.changes !== 1) return this.get(cohortId)!;
        result = await this.#port.execute(member.request);
      }
      if (result.attemptId !== member.request.attemptId || result.idempotencyKey !== member.request.idempotencyKey
        || result.environment !== 'TESTNET' || result.domain !== 'hypercore:testnet') throw new OwnerCohortError('RESULT_MISMATCH', 'Execution result differs from its owner-bound attempt.');
      const completed = (result.status === 'STRATEGY_EXECUTION' && result.packageStatus === 'COMPLETED')
        || (result.status === 'RECONCILED' && ['COMPLETED_EXACT', 'COMPLETED_BOUNDED'].includes(result.packageStatus));
      const noEffect = ['NOT_SUBMITTED', 'CHECKPOINT_FAILED', 'CHECKPOINT_INCOMPLETE'].includes(result.status)
        || ((result.status === 'STRATEGY_EXECUTION' || result.status === 'RECONCILED') && result.packageStatus === 'NO_EFFECT');
      const receiptHash = completed ? this.#port.receiptHash(member.request) : undefined;
      if (completed && (receiptHash === undefined || !HASH.test(receiptHash))) return this.get(cohortId)!;
      const state = completed ? 'SETTLED' : noEffect ? 'NO_EFFECT' : 'RECOVERY_REQUIRED';
      this.#db.prepare('UPDATE hyperliquid_owner_cohort_members SET state = ?, receipt_hash = ? WHERE cohort_id = ? AND ordinal = ?')
        .run(state, receiptHash ?? null, cohortId, ordinal);
      if (state !== 'SETTLED') return this.get(cohortId)!;
    }
    return this.get(cohortId)!;
  }

  close(): void { this.#db.close(); }
}
