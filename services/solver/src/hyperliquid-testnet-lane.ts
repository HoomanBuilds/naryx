import { isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import type { HyperliquidTestnetExecutorResult } from './hyperliquid-testnet-executor-http.js';

/**
 * The single execution lane of the omnibus Hyperliquid Testnet trading account.
 *
 * Every package attempt runs alone, in arrival order, from its authority read to its last
 * reconciliation. Reconciliation measures account-wide deltas, so the serialized window is what
 * makes the observed delta belong to exactly one package. An attempt whose outcome leaves the
 * account in an unresolved state keeps the lane blocked until an operator releases it, so no later
 * package can move the account under a pending recovery. A release is journaled: either fresh
 * authoritative evidence shows the holder's outcome is final, or the operator abandons the holder
 * with a stated reason.
 */

export type HyperliquidLaneState = 'FREE' | 'EXECUTING' | 'BLOCKED';

export type HyperliquidLaneAttemptStatus =
  /** `queuePosition` counts the attempts ahead of this one, including the one executing. */
  | Readonly<{ state: 'QUEUED'; queuePosition: number }>
  | Readonly<{ state: 'EXECUTING' }>
  | Readonly<{ state: 'COMPLETED'; result: HyperliquidTestnetExecutorResult }>
  | Readonly<{ state: 'INTERRUPTED' }>
  | Readonly<{ state: 'UNKNOWN' }>;

export type HyperliquidLaneNotSubmittedReason =
  | 'LANE_BLOCKED'
  | 'LANE_QUEUE_FULL'
  | 'EXECUTOR_RESTARTED_BEFORE_START'
  | 'ATTEMPT_NOT_RECEIVED';

export interface HyperliquidTestnetLaneOptions {
  /** Absolute durable database path; absent keeps the lane in memory for one process. */
  readonly databasePath?: string;
  readonly maxQueueLength?: number;
  /** The not-submitted result for an attempt the lane refused before any venue call. */
  readonly notSubmitted: (
    attemptId: string,
    idempotencyKey: string,
    reason: HyperliquidLaneNotSubmittedReason,
  ) => HyperliquidTestnetExecutorResult;
  readonly currentTimeMs?: () => number;
}

/** Marks the point after which a failure may have reached the venue. */
export type HyperliquidLaneTask = (
  enterSubmission: () => void,
) => Promise<HyperliquidTestnetExecutorResult>;

export type HyperliquidLaneReleaseDisposition = 'FINAL' | 'ABANDONED';

/** FINAL carries the holder's fresh final result; ABANDONED releases on the operator's reason alone. */
export type HyperliquidLaneReleaseInput =
  | Readonly<{
      holderAttemptId: string;
      disposition: 'FINAL';
      reason: string;
      result: HyperliquidTestnetExecutorResult;
    }>
  | Readonly<{ holderAttemptId: string; disposition: 'ABANDONED'; reason: string }>;

export type HyperliquidLaneRelease = Readonly<{
  holderAttemptId: string;
  disposition: HyperliquidLaneReleaseDisposition;
  reason: string;
  blockedReason: string | null;
  resultStatus: string | null;
  releasedAtMs: number;
}>;

export type HyperliquidLaneBlockedHolder = Readonly<{
  attemptId: string;
  blockedReason: string | null;
  /** The holder's stored result; null when it was interrupted before any result. */
  result: HyperliquidTestnetExecutorResult | null;
}>;

/** A journaled operator reason: 8 to 280 printable ASCII characters. */
export const HYPERLIQUID_LANE_RELEASE_REASON = /^[\x20-\x7E]{8,280}$/;

export class HyperliquidTestnetLaneError extends Error {
  readonly code: 'ATTEMPT_IDENTITY_MISMATCH' | 'ATTEMPT_INTERRUPTED' | 'LANE_CORRUPT'
    | 'INVALID_RELEASE' | 'LANE_NOT_BLOCKED_BY_ATTEMPT' | 'HOLDER_NOT_FINAL';

  constructor(code: HyperliquidTestnetLaneError['code'], message: string) {
    super(message);
    this.name = 'HyperliquidTestnetLaneError';
    this.code = code;
  }
}

const DEFAULT_MAX_QUEUE_LENGTH = 32;
const RELEASING_PACKAGE_STATUSES = new Set(['NO_EFFECT', 'COMPLETED_EXACT', 'COMPLETED_BOUNDED']);

/**
 * True when the attempt left nothing pending on the account: nothing reached the venue, or
 * authoritative reconciliation reached a final package outcome without recovery.
 */
export function hyperliquidLaneReleases(result: HyperliquidTestnetExecutorResult): boolean {
  if (result.status === 'CHECKPOINT_INCOMPLETE' || result.status === 'CHECKPOINT_FAILED'
    || result.status === 'NOT_SUBMITTED') return true;
  if (result.status === 'STRATEGY_EXECUTION') {
    return result.packageStatus === 'COMPLETED' || result.packageStatus === 'NO_EFFECT'
      || result.packageStatus === 'SUBMISSION_FAILED';
  }
  if (result.status === 'RECOVERY_RECONCILED') {
    return result.recoveryStatus === 'RECOVERED_COMPLETE'
      || result.recoveryStatus === 'RECOVERED_BOUNDED'
      || result.recoveryStatus === 'RECOVERED_FLAT';
  }
  return result.status === 'RECONCILED' && RELEASING_PACKAGE_STATUSES.has(result.packageStatus);
}

interface AttemptRow {
  readonly attempt_id: string;
  readonly idempotency_key: string;
  readonly state: string;
  readonly result_json: string | null;
}

interface LockRow {
  readonly state: string;
  readonly holder_attempt_id: string | null;
  readonly reason: string | null;
}

export class HyperliquidTestnetLane {
  readonly #db: Database.Database;
  readonly #maxQueueLength: number;
  readonly #notSubmitted: HyperliquidTestnetLaneOptions['notSubmitted'];
  readonly #now: () => number;
  readonly #pending = new Map<string, Promise<HyperliquidTestnetExecutorResult>>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: HyperliquidTestnetLaneOptions) {
    const path = options.databasePath;
    if (path !== undefined && (!isAbsolute(path) || path === ':memory:')) {
      throw new Error('Hyperliquid lane database path must be absolute');
    }
    const maximum = options.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_024) {
      throw new Error('Hyperliquid lane queue length must be between 1 and 1024');
    }
    if (typeof options.notSubmitted !== 'function') {
      throw new Error('Hyperliquid lane needs a not-submitted result builder');
    }
    this.#maxQueueLength = maximum;
    this.#notSubmitted = options.notSubmitted;
    this.#now = options.currentTimeMs ?? Date.now;
    this.#db = new Database(path ?? ':memory:');
    try {
      if (path !== undefined) {
        this.#db.pragma('journal_mode = WAL');
        this.#db.pragma('synchronous = FULL');
      }
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS hyperliquid_lane_lock (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          state TEXT NOT NULL CHECK (state IN ('FREE', 'EXECUTING', 'BLOCKED')),
          holder_attempt_id TEXT,
          reason TEXT,
          updated_at_ms INTEGER NOT NULL,
          CHECK ((state = 'FREE') = (holder_attempt_id IS NULL))
        ) STRICT;
        INSERT OR IGNORE INTO hyperliquid_lane_lock (singleton, state, holder_attempt_id, reason, updated_at_ms)
          VALUES (1, 'FREE', NULL, NULL, 0);
        CREATE TABLE IF NOT EXISTS hyperliquid_lane_attempts (
          attempt_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('QUEUED', 'EXECUTING', 'COMPLETED', 'INTERRUPTED')),
          result_json TEXT,
          updated_at_ms INTEGER NOT NULL,
          CHECK ((state = 'COMPLETED') = (result_json IS NOT NULL))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS hyperliquid_lane_releases (
          holder_attempt_id TEXT PRIMARY KEY,
          disposition TEXT NOT NULL CHECK (disposition IN ('FINAL', 'ABANDONED')),
          reason TEXT NOT NULL,
          blocked_reason TEXT,
          result_status TEXT,
          released_at_ms INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS hyperliquid_lane_reconcile_contexts (
          attempt_id TEXT PRIMARY KEY,
          context_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL
        ) STRICT;
      `);
      this.#recoverAfterRestart();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  laneState(): Readonly<{ state: HyperliquidLaneState; holderAttemptId: string | null; queueLength: number }> {
    const lock = this.#lock();
    return Object.freeze({
      state: lock.state as HyperliquidLaneState,
      holderAttemptId: lock.holder_attempt_id,
      queueLength: this.#pending.size,
    });
  }

  /**
   * Runs the attempt once, after every attempt queued before it. A completed attempt returns its
   * stored result and never runs again; a concurrent call for a queued attempt shares its turn.
   */
  run(attemptId: string, idempotencyKey: string, task: HyperliquidLaneTask): Promise<HyperliquidTestnetExecutorResult> {
    const existing = this.#row(attemptId);
    if (existing !== undefined) {
      this.#requireKey(existing, idempotencyKey);
      if (existing.state === 'COMPLETED') return Promise.resolve(this.#decode(existing));
      const pending = this.#pending.get(attemptId);
      if (pending !== undefined) return pending;
      return Promise.reject(new HyperliquidTestnetLaneError(
        'ATTEMPT_INTERRUPTED',
        'Hyperliquid attempt was interrupted while it held the account and must not be resubmitted',
      ));
    }
    if (this.#pending.size >= this.#maxQueueLength) {
      return Promise.resolve(this.#complete(
        attemptId, idempotencyKey, this.#notSubmitted(attemptId, idempotencyKey, 'LANE_QUEUE_FULL'), true,
      ));
    }
    this.#db.prepare(`
      INSERT INTO hyperliquid_lane_attempts (attempt_id, idempotency_key, state, result_json, updated_at_ms)
      VALUES (?, ?, 'QUEUED', NULL, ?)
    `).run(attemptId, idempotencyKey, this.#now());
    const turn = this.#tail.then(() => this.#turn(attemptId, idempotencyKey, task));
    this.#tail = turn.catch(() => undefined);
    const tracked = turn.finally(() => {
      if (this.#pending.get(attemptId) === tracked) this.#pending.delete(attemptId);
    });
    this.#pending.set(attemptId, tracked);
    return tracked;
  }

  /** Read-only status for polling. */
  status(attemptId: string, idempotencyKey: string): HyperliquidLaneAttemptStatus {
    const row = this.#row(attemptId);
    if (row === undefined) return Object.freeze({ state: 'UNKNOWN' as const });
    this.#requireKey(row, idempotencyKey);
    if (row.state === 'COMPLETED') return Object.freeze({ state: 'COMPLETED' as const, result: this.#decode(row) });
    if (row.state === 'INTERRUPTED') return Object.freeze({ state: 'INTERRUPTED' as const });
    if (row.state === 'EXECUTING') return Object.freeze({ state: 'EXECUTING' as const });
    const position = [...this.#pending.keys()].indexOf(attemptId);
    if (position < 0) return Object.freeze({ state: 'INTERRUPTED' as const });
    return Object.freeze({ state: 'QUEUED' as const, queuePosition: position });
  }

  /**
   * Resolves a caller's uncertain handoff. An attempt the lane never received is fenced with a
   * durable not-submitted result, so a delayed copy of the original request can never run it.
   */
  resolve(attemptId: string, idempotencyKey: string): HyperliquidLaneAttemptStatus {
    const status = this.status(attemptId, idempotencyKey);
    if (status.state !== 'UNKNOWN') return status;
    const result = this.#complete(
      attemptId, idempotencyKey, this.#notSubmitted(attemptId, idempotencyKey, 'ATTEMPT_NOT_RECEIVED'), true,
    );
    return Object.freeze({ state: 'COMPLETED' as const, result });
  }

  /** The attempt blocking the lane, with its stored result, or undefined when the lane is not blocked. */
  blockedHolder(): HyperliquidLaneBlockedHolder | undefined {
    const lock = this.#lock();
    if (lock.state !== 'BLOCKED' || lock.holder_attempt_id === null) return undefined;
    const row = this.#row(lock.holder_attempt_id);
    return Object.freeze({
      attemptId: lock.holder_attempt_id,
      blockedReason: lock.reason,
      result: row?.state === 'COMPLETED' ? this.#decode(row) : null,
    });
  }

  /**
   * Operator release of a blocked lane, journaled. FINAL needs a fresh result for the holder that
   * leaves nothing pending, and it replaces the holder's stored result; ABANDONED needs only the
   * operator's reason and keeps the holder's stored outcome as it was.
   */
  release(input: HyperliquidLaneReleaseInput): HyperliquidLaneRelease {
    if (typeof input?.reason !== 'string' || !HYPERLIQUID_LANE_RELEASE_REASON.test(input.reason)
      || input.reason.trim().length < 8
      || (input.disposition !== 'FINAL' && input.disposition !== 'ABANDONED')) {
      throw new HyperliquidTestnetLaneError(
        'INVALID_RELEASE',
        'a release needs FINAL or ABANDONED and a reason of 8 to 280 printable ASCII characters',
      );
    }
    if (input.disposition === 'FINAL' && !hyperliquidLaneReleases(input.result)) {
      throw new HyperliquidTestnetLaneError('HOLDER_NOT_FINAL', 'the holder outcome is not final');
    }
    return this.#db.transaction(() => {
      const lock = this.#lock();
      if (lock.state !== 'BLOCKED' || lock.holder_attempt_id !== input.holderAttemptId) {
        throw new HyperliquidTestnetLaneError(
          'LANE_NOT_BLOCKED_BY_ATTEMPT',
          'Hyperliquid lane is not blocked by that attempt',
        );
      }
      let resultStatus: string | null = null;
      if (input.disposition === 'FINAL') {
        const row = this.#row(input.holderAttemptId);
        const result = input.result;
        if (row === undefined || result.attemptId !== row.attempt_id
          || result.idempotencyKey !== row.idempotency_key) {
          throw new HyperliquidTestnetLaneError(
            'ATTEMPT_IDENTITY_MISMATCH',
            'the final result does not belong to the attempt holding the lane',
          );
        }
        this.#db.prepare(`
          UPDATE hyperliquid_lane_attempts SET state = 'COMPLETED', result_json = ?, updated_at_ms = ?
          WHERE attempt_id = ?
        `).run(JSON.stringify(result), this.#now(), row.attempt_id);
        resultStatus = result.status === 'RECONCILED'
          ? result.packageStatus
          : result.status === 'RECOVERY_RECONCILED' ? result.recoveryStatus : result.status;
      }
      const release: HyperliquidLaneRelease = Object.freeze({
        holderAttemptId: input.holderAttemptId,
        disposition: input.disposition,
        reason: input.reason,
        blockedReason: lock.reason,
        resultStatus,
        releasedAtMs: this.#now(),
      });
      this.#db.prepare(`
        INSERT INTO hyperliquid_lane_releases
          (holder_attempt_id, disposition, reason, blocked_reason, result_status, released_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        release.holderAttemptId, release.disposition, release.reason,
        release.blockedReason, release.resultStatus, release.releasedAtMs,
      );
      this.#setLock('FREE', null, null);
      return release;
    }).immediate();
  }

  /** Keeps the latest reconcile inputs of an attempt so a later FINAL release can re-read them. */
  recordReconcileContext(attemptId: string, contextJson: string): void {
    this.#db.prepare(`
      INSERT INTO hyperliquid_lane_reconcile_contexts (attempt_id, context_json, updated_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(attempt_id) DO UPDATE SET context_json = excluded.context_json,
        updated_at_ms = excluded.updated_at_ms
    `).run(attemptId, contextJson, this.#now());
  }

  reconcileContext(attemptId: string): string | undefined {
    return this.#db.prepare<[string], { context_json: string }>(`
      SELECT context_json FROM hyperliquid_lane_reconcile_contexts WHERE attempt_id = ?
    `).get(attemptId)?.context_json;
  }

  close(): void {
    this.#db.close();
  }

  async #turn(
    attemptId: string,
    idempotencyKey: string,
    task: HyperliquidLaneTask,
  ): Promise<HyperliquidTestnetExecutorResult> {
    const lock = this.#lock();
    if (lock.state === 'BLOCKED') {
      return this.#complete(
        attemptId, idempotencyKey, this.#notSubmitted(attemptId, idempotencyKey, 'LANE_BLOCKED'), false,
      );
    }
    if (lock.state !== 'FREE') throw new HyperliquidTestnetLaneError('LANE_CORRUPT', 'Hyperliquid lane lock is held');
    this.#db.transaction(() => {
      this.#setLock('EXECUTING', attemptId, null);
      this.#db.prepare(`
        UPDATE hyperliquid_lane_attempts SET state = 'EXECUTING', updated_at_ms = ?
        WHERE attempt_id = ? AND state = 'QUEUED'
      `).run(this.#now(), attemptId);
    }).immediate();
    let submitting = false;
    let result: HyperliquidTestnetExecutorResult;
    try {
      result = await task(() => { submitting = true; });
    } catch (error) {
      if (submitting) {
        this.#db.transaction(() => {
          this.#setLock('BLOCKED', attemptId, 'EXECUTION_OUTCOME_UNKNOWN');
          this.#db.prepare(`
            UPDATE hyperliquid_lane_attempts SET state = 'INTERRUPTED', updated_at_ms = ? WHERE attempt_id = ?
          `).run(this.#now(), attemptId);
        }).immediate();
      } else {
        // Nothing reached the venue: the attempt is forgotten so a later resolve fences it.
        this.#db.transaction(() => {
          this.#setLock('FREE', null, null);
          this.#db.prepare('DELETE FROM hyperliquid_lane_attempts WHERE attempt_id = ?').run(attemptId);
        }).immediate();
      }
      throw error;
    }
    const releases = hyperliquidLaneReleases(result);
    return this.#complete(attemptId, idempotencyKey, result, false, releases ? 'FREE' : 'BLOCKED');
  }

  #complete(
    attemptId: string,
    idempotencyKey: string,
    result: HyperliquidTestnetExecutorResult,
    insert: boolean,
    lock?: 'FREE' | 'BLOCKED',
  ): HyperliquidTestnetExecutorResult {
    if (result.attemptId !== attemptId || result.idempotencyKey !== idempotencyKey) {
      throw new HyperliquidTestnetLaneError('LANE_CORRUPT', 'Hyperliquid lane result identity mismatch');
    }
    const json = JSON.stringify(result);
    this.#db.transaction(() => {
      if (insert) {
        this.#db.prepare(`
          INSERT INTO hyperliquid_lane_attempts (attempt_id, idempotency_key, state, result_json, updated_at_ms)
          VALUES (?, ?, 'COMPLETED', ?, ?)
        `).run(attemptId, idempotencyKey, json, this.#now());
      } else {
        const update = this.#db.prepare(`
          UPDATE hyperliquid_lane_attempts SET state = 'COMPLETED', result_json = ?, updated_at_ms = ?
          WHERE attempt_id = ? AND state IN ('QUEUED', 'EXECUTING')
        `).run(json, this.#now(), attemptId);
        if (update.changes !== 1) {
          throw new HyperliquidTestnetLaneError('LANE_CORRUPT', 'Hyperliquid lane attempt row is missing');
        }
      }
      if (lock === 'FREE') this.#setLock('FREE', null, null);
      if (lock === 'BLOCKED') this.#setLock('BLOCKED', attemptId, result.status);
    }).immediate();
    return result;
  }

  #setLock(state: HyperliquidLaneState, holder: string | null, reason: string | null): void {
    this.#db.prepare(`
      UPDATE hyperliquid_lane_lock SET state = ?, holder_attempt_id = ?, reason = ?, updated_at_ms = ?
      WHERE singleton = 1
    `).run(state, holder, reason, this.#now());
  }

  #lock(): LockRow {
    const row = this.#db.prepare<[], LockRow>(
      'SELECT state, holder_attempt_id, reason FROM hyperliquid_lane_lock WHERE singleton = 1',
    ).get();
    if (row === undefined || (row.state !== 'FREE' && row.state !== 'EXECUTING' && row.state !== 'BLOCKED')) {
      throw new HyperliquidTestnetLaneError('LANE_CORRUPT', 'Hyperliquid lane lock is missing');
    }
    return row;
  }

  #row(attemptId: string): AttemptRow | undefined {
    return this.#db.prepare<[string], AttemptRow>(`
      SELECT attempt_id, idempotency_key, state, result_json FROM hyperliquid_lane_attempts WHERE attempt_id = ?
    `).get(attemptId);
  }

  #requireKey(row: AttemptRow, idempotencyKey: string): void {
    if (row.idempotency_key !== idempotencyKey) {
      throw new HyperliquidTestnetLaneError(
        'ATTEMPT_IDENTITY_MISMATCH',
        'Hyperliquid attempt is bound to a different idempotency key',
      );
    }
  }

  #decode(row: AttemptRow): HyperliquidTestnetExecutorResult {
    try {
      const value = JSON.parse(row.result_json ?? '') as HyperliquidTestnetExecutorResult;
      if (value.attemptId === row.attempt_id && value.idempotencyKey === row.idempotency_key) return value;
    } catch {
      // Falls through to the corrupt-row error.
    }
    throw new HyperliquidTestnetLaneError('LANE_CORRUPT', 'stored Hyperliquid lane result is invalid');
  }

  // A process that stopped mid-attempt cannot know what reached the venue. Attempts that never
  // started are refused durably; the one that held the account keeps the lane blocked.
  #recoverAfterRestart(): void {
    const queued = this.#db.prepare<[], AttemptRow>(`
      SELECT attempt_id, idempotency_key, state, result_json FROM hyperliquid_lane_attempts WHERE state = 'QUEUED'
    `).all();
    this.#db.transaction(() => {
      for (const row of queued) {
        const result = this.#notSubmitted(row.attempt_id, row.idempotency_key, 'EXECUTOR_RESTARTED_BEFORE_START');
        this.#db.prepare(`
          UPDATE hyperliquid_lane_attempts SET state = 'COMPLETED', result_json = ?, updated_at_ms = ?
          WHERE attempt_id = ?
        `).run(JSON.stringify(result), this.#now(), row.attempt_id);
      }
      this.#db.prepare(`
        UPDATE hyperliquid_lane_attempts SET state = 'INTERRUPTED', updated_at_ms = ? WHERE state = 'EXECUTING'
      `).run(this.#now());
      const lock = this.#lock();
      if (lock.state === 'EXECUTING') this.#setLock('BLOCKED', lock.holder_attempt_id, 'EXECUTOR_INTERRUPTED');
    }).immediate();
  }
}
