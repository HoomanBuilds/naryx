import { isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import {
  bytesEqual, crossDomainExecutionBundle, crossDomainPlanHash, parseProtocolJson, stringifyProtocolJson, toHex,
  type CrossDomainExecutionBundleInput,
} from '@naryx/protocol-types';
import { getAddress } from 'viem';
import type { AuthorizedEvmStrategyExecution } from './evm-strategy-execution-authorization.js';
import type { EvmCrossDomainRecoveryAuthorization } from './evm-recoverable-cross-domain-lane.js';
import type { PreparedStrategyExecutionTransport } from './strategy-execution-transport.js';

export interface CrossDomainJob {
  readonly version: 1;
  readonly bundle: CrossDomainExecutionBundleInput;
  readonly execution: PreparedStrategyExecutionTransport;
  readonly authorizations: readonly Readonly<{
    domainId: string;
    entry: AuthorizedEvmStrategyExecution;
    recovery: EvmCrossDomainRecoveryAuthorization;
  }>[];
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Cross-domain job refused: ${message}`);
}

export function validateCrossDomainJob(job: CrossDomainJob): string {
  requireCondition(job.version === 1, 'unknown job version');
  const bundle = crossDomainExecutionBundle(job.bundle);
  const planHash = toHex(crossDomainPlanHash(bundle.plan));
  requireCondition(bundle.plan.planVersion === 2 && bundle.plan.environment === 'testnet'
    && bundle.plan.timeUnit === 'EVM_UNIX_SECONDS' && bundle.plan.legs.length === 2,
  'only two-domain recoverable testnet jobs are enabled');
  requireCondition(bundle.plan.legs.every(l => l.domain.domainId === 'eip155:84532' || l.domain.domainId === 'eip155:421614')
    && bundle.compensations.every(c => c.actionKind === 'REVERSE_FILLED_LEGS'), 'unsupported execution or recovery domain');
  const prepared = job.execution;
  requireCondition(prepared.version === 1 && prepared.coordination === 'CROSS_DOMAIN_PREPOSITIONED'
    && prepared.settlementClass === 'CROSS_DOMAIN_PREPOSITIONED'
    && prepared.crossDomainPlanHash !== undefined && toHex(prepared.crossDomainPlanHash) === planHash
    && bytesEqual(prepared.orderHash, bundle.plan.orderHash) && bytesEqual(prepared.quoteHash, bundle.plan.quoteHash)
    && bytesEqual(prepared.routeHash, bundle.plan.routeHash), 'prepared execution binds another plan');
  requireCondition(prepared.domains.length === 2 && job.authorizations.length === 2, 'every domain needs both signatures');
  for (const leg of bundle.plan.legs) {
    const domains = prepared.domains.filter(d => d.domain.domainId === leg.domain.domainId);
    const signed = job.authorizations.filter(a => a.domainId === leg.domain.domainId);
    requireCondition(domains.length === 1 && domains[0]!.kind === 'EVM_MULTI_STRATEGY_ACCOUNT' && signed.length === 1,
      'domain execution or authorization is missing or repeated');
    const domain = domains[0]!;
    requireCondition(domain.kind === 'EVM_MULTI_STRATEGY_ACCOUNT', 'unsupported execution');
    requireCondition(domain.domain.domainManifestVersion === leg.domain.domainManifestVersion
      && bytesEqual(domain.domain.domainManifestHash, leg.domain.domainManifestHash), 'domain manifest changed');
    requireCondition(getAddress(signed[0]!.entry.to) === getAddress(domain.envelope.account)
      && getAddress(signed[0]!.recovery.envelope.account) === getAddress(domain.envelope.account), 'authorization account differs');
  }
  return planHash;
}

export class SqliteCrossDomainJobStore {
  readonly #db: Database.Database;

  constructor(path: string) {
    requireCondition(isAbsolute(path) && path !== ':memory:', 'a durable absolute database path is required');
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = FULL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS cross_domain_jobs (
        plan_hash TEXT PRIMARY KEY, job_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','TERMINAL','ESCALATION_REQUIRED')),
        last_error TEXT, updated_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS cross_domain_account_locks (
        account_key TEXT PRIMARY KEY, plan_hash TEXT NOT NULL
      ) STRICT;
    `);
  }

  close() { this.#db.close(); }

  admit(job: CrossDomainJob): string {
    const planHash = validateCrossDomainJob(job);
    const json = stringifyProtocolJson(job);
    requireCondition(Buffer.byteLength(json) <= 1_048_576, 'job exceeds size limit');
    this.#db.transaction(() => {
      const existing = this.#db.prepare('SELECT job_json FROM cross_domain_jobs WHERE plan_hash = ?').get(planHash) as { job_json: string } | undefined;
      if (existing !== undefined) {
        requireCondition(existing.job_json === json, 'plan already has different immutable authorizations');
        return;
      }
      const count = this.#db.prepare("SELECT count(*) AS total FROM cross_domain_jobs WHERE status != 'TERMINAL'").get() as { total: number };
      requireCondition(count.total < 32, 'active job capacity reached');
      for (const domain of job.execution.domains) {
        requireCondition(domain.kind === 'EVM_MULTI_STRATEGY_ACCOUNT', 'unsupported account');
        const key = `${domain.domain.domainId}:${getAddress(domain.envelope.account)}`;
        const lock = this.#db.prepare('SELECT plan_hash FROM cross_domain_account_locks WHERE account_key = ?').get(key);
        requireCondition(lock === undefined, 'strategy account is fenced by another job');
        this.#db.prepare('INSERT INTO cross_domain_account_locks VALUES (?, ?)').run(key, planHash);
      }
      this.#db.prepare("INSERT INTO cross_domain_jobs VALUES (?, ?, 'ACTIVE', NULL, ?)").run(planHash, json, Date.now());
    })();
    return planHash;
  }

  get(planHash: string): CrossDomainJob | undefined {
    const row = this.#db.prepare('SELECT job_json FROM cross_domain_jobs WHERE plan_hash = ?').get(planHash) as { job_json: string } | undefined;
    if (row === undefined) return undefined;
    const job = parseProtocolJson(row.job_json) as CrossDomainJob;
    requireCondition(validateCrossDomainJob(job) === planHash, 'stored plan identity changed');
    return job;
  }

  active(): readonly string[] {
    return (this.#db.prepare("SELECT plan_hash FROM cross_domain_jobs WHERE status = 'ACTIVE' ORDER BY updated_at_ms, plan_hash LIMIT 32").all() as { plan_hash: string }[])
      .map(row => row.plan_hash);
  }

  status(planHash: string): Readonly<{ planHash: string; status: string; updatedAtMs: number }> | undefined {
    requireCondition(/^[0-9a-f]{64}$/.test(planHash), 'invalid plan hash');
    const row = this.#db.prepare('SELECT status, updated_at_ms FROM cross_domain_jobs WHERE plan_hash = ?').get(planHash) as
      { status: string; updated_at_ms: number } | undefined;
    return row === undefined ? undefined : { planHash, status: row.status, updatedAtMs: row.updated_at_ms };
  }

  record(planHash: string, status: 'ACTIVE' | 'TERMINAL' | 'ESCALATION_REQUIRED', error?: string): void {
    this.#db.transaction(() => {
      const update = this.#db.prepare('UPDATE cross_domain_jobs SET status = ?, last_error = ?, updated_at_ms = ? WHERE plan_hash = ? AND status = ?')
        .run(status, error?.slice(0, 1_024) ?? null, Date.now(), planHash, 'ACTIVE');
      requireCondition(update.changes === 1, 'only active jobs can advance');
      if (status === 'TERMINAL') this.#db.prepare('DELETE FROM cross_domain_account_locks WHERE plan_hash = ?').run(planHash);
    })();
  }
}
