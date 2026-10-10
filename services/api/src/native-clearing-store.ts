import type Database from 'better-sqlite3';
import {
  adjustNativeClearingCollateral,
  adjustNativeClearingRecoveryReserve,
  applyNativeClearingMatch,
  bytesEqual,
  commitmentHash,
  nativeClearingAccount,
  nativeClearingDomainState,
  nativeClearingPolicy,
  parseProtocolJson,
  protocolId,
  resolveNativeClearingDefault,
  stringifyProtocolJson,
  toHex,
  type NativeClearingAccount,
  type NativeClearingAccountInput,
  type NativeClearingDefaultResolution,
  type NativeClearingDomainState,
  type NativeClearingDomainStateInput,
  type NativeClearingMatchReceipt,
  type NativeClearingPolicy,
  type NativeClearingPolicyInput,
} from '@naryx/protocol-types';
import { openDurableDatabase } from './durable-sqlite.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS native_clearing_policies (
  policy_hash BLOB PRIMARY KEY,
  clearing_domain_id TEXT NOT NULL UNIQUE,
  policy_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS native_clearing_domains (
  policy_hash BLOB PRIMARY KEY REFERENCES native_clearing_policies(policy_hash),
  state_hash BLOB NOT NULL UNIQUE,
  state_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS native_clearing_accounts (
  account_id TEXT PRIMARY KEY,
  policy_hash BLOB NOT NULL REFERENCES native_clearing_policies(policy_hash),
  account_hash BLOB NOT NULL UNIQUE,
  account_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS native_clearing_accounts_by_policy
  ON native_clearing_accounts (policy_hash, account_id);
CREATE TABLE IF NOT EXISTS native_clearing_events (
  event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('RESERVE', 'COLLATERAL', 'MATCH', 'DEFAULT')),
  event_hash BLOB NOT NULL,
  policy_hash BLOB NOT NULL REFERENCES native_clearing_policies(policy_hash),
  source_sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE (event_kind, event_hash)
) STRICT;
CREATE TRIGGER IF NOT EXISTS reject_native_clearing_policy_update
  BEFORE UPDATE ON native_clearing_policies
  BEGIN SELECT RAISE(ABORT, 'native clearing policies are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_native_clearing_policy_delete
  BEFORE DELETE ON native_clearing_policies
  BEGIN SELECT RAISE(ABORT, 'native clearing policies are durable'); END;
CREATE TRIGGER IF NOT EXISTS reject_native_clearing_event_update
  BEFORE UPDATE ON native_clearing_events
  BEGIN SELECT RAISE(ABORT, 'native clearing events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_native_clearing_event_delete
  BEFORE DELETE ON native_clearing_events
  BEGIN SELECT RAISE(ABORT, 'native clearing events are durable'); END;
`;

type PolicyRow = { policy_hash: unknown; clearing_domain_id: unknown; policy_json: unknown };
type DomainRow = { policy_hash: unknown; state_hash: unknown; state_json: unknown };
type AccountRow = { account_id: unknown; policy_hash: unknown; account_hash: unknown; account_json: unknown };
type EventRow = {
  event_kind: unknown;
  event_hash: unknown;
  policy_hash: unknown;
  event_sequence: unknown;
  source_sequence: unknown;
  event_json: unknown;
  recorded_at_ms: unknown;
};

export type NativeClearingEventKind = 'RESERVE' | 'COLLATERAL' | 'MATCH' | 'DEFAULT';

export interface NativeClearingEvent {
  readonly kind: NativeClearingEventKind;
  readonly eventHashHex: string;
  readonly policyHashHex: string;
  readonly sequence: number;
  readonly sourceSequence: number;
  readonly payload: unknown;
  readonly recordedAtMs: number;
}

export class NativeClearingStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NativeClearingStoreError';
    this.code = code;
  }
}

function hash(value: unknown, context: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error(`${context} is invalid`);
  return commitmentHash(value, context);
}

function json(value: unknown, context: string): string {
  const result = stringifyProtocolJson(value);
  if (result.length > 1_048_576) throw new Error(`${context} exceeds the storage limit`);
  return result;
}

function clock(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('native clearing clock is invalid');
  return value;
}

function expected(actual: Uint8Array, value: Uint8Array | string, context: string): void {
  if (!bytesEqual(actual, commitmentHash(value, context))) {
    throw new NativeClearingStoreError('STALE_STATE', `${context} does not match durable state.`);
  }
}

export class SqliteNativeClearingStore {
  readonly #db: Database.Database;
  readonly #clock: () => number;

  constructor(dbPath: string, now: () => number = Date.now) {
    this.#db = openDurableDatabase(
      dbPath,
      SCHEMA_SQL,
      (code, message) => new NativeClearingStoreError(code, message),
    );
    this.#clock = now;
  }

  close(): void {
    this.#db.close();
  }

  registerDomain(
    policyInput: NativeClearingPolicyInput | NativeClearingPolicy,
    stateInput: NativeClearingDomainStateInput | NativeClearingDomainState,
  ): Readonly<{ policy: NativeClearingPolicy; state: NativeClearingDomainState }> {
    const policy = nativeClearingPolicy(policyInput);
    const state = nativeClearingDomainState(stateInput, policy);
    if (state.openInterestAtoms !== 0n || state.sequence !== 0n) {
      throw new NativeClearingStoreError('INVALID_GENESIS', 'A new clearing domain must begin with zero open interest and sequence zero.');
    }
    return this.#db.transaction(() => {
      const existing = this.domain(policy.clearingDomainId);
      if (existing !== undefined) {
        if (!bytesEqual(existing.policy.policyHash, policy.policyHash)
          || !bytesEqual(existing.state.stateHash, state.stateHash)) {
          throw new NativeClearingStoreError('DOMAIN_CONFLICT', 'Clearing domain is already registered with different state.');
        }
        return existing;
      }
      this.#db.prepare(`INSERT INTO native_clearing_policies VALUES (?, ?, ?)`)
        .run(policy.policyHash, policy.clearingDomainId, json(policy, 'native clearing policy'));
      this.#db.prepare(`INSERT INTO native_clearing_domains VALUES (?, ?, ?)`)
        .run(policy.policyHash, state.stateHash, json(state, 'native clearing domain state'));
      return Object.freeze({ policy, state });
    }).immediate();
  }

  domain(clearingDomainId: string): Readonly<{ policy: NativeClearingPolicy; state: NativeClearingDomainState }> | undefined {
    const id = protocolId(clearingDomainId, 'native clearing domain id');
    const row = this.#db.prepare('SELECT * FROM native_clearing_policies WHERE clearing_domain_id = ?')
      .get(id) as PolicyRow | undefined;
    if (row === undefined) return undefined;
    const policy = this.#decodePolicy(row);
    return Object.freeze({ policy, state: this.#state(policy) });
  }

  openAccount(clearingDomainId: string, input: NativeClearingAccountInput | NativeClearingAccount): NativeClearingAccount {
    return this.#db.transaction(() => {
      const { policy } = this.#requiredDomain(clearingDomainId);
      const account = nativeClearingAccount(input, policy);
      if (account.positionAtoms !== 0n || account.cashBalanceQuoteAtoms !== 0n || account.sequence !== 0n) {
        throw new NativeClearingStoreError('INVALID_GENESIS', 'A new clearing account must begin flat at sequence zero.');
      }
      const existing = this.account(account.accountId);
      if (existing !== undefined) {
        if (!bytesEqual(existing.accountHash, account.accountHash)) {
          throw new NativeClearingStoreError('ACCOUNT_CONFLICT', 'Clearing account already exists with different state.');
        }
        return existing;
      }
      this.#db.prepare(`INSERT INTO native_clearing_accounts VALUES (?, ?, ?, ?)`)
        .run(account.accountId, policy.policyHash, account.accountHash, json(account, 'native clearing account'));
      return account;
    }).immediate();
  }

  account(accountId: string): NativeClearingAccount | undefined {
    const id = protocolId(accountId, 'native clearing account id');
    const row = this.#db.prepare('SELECT * FROM native_clearing_accounts WHERE account_id = ?')
      .get(id) as AccountRow | undefined;
    if (row === undefined) return undefined;
    return this.#decodeAccount(row, this.#policy(hash(row.policy_hash, 'stored account policy hash')));
  }

  adjustReserve(input: Readonly<{
    clearingDomainId: string;
    expectedStateHash: Uint8Array | string;
    reserveDeltaQuoteAtoms: bigint;
  }>): NativeClearingDomainState {
    return this.#db.transaction(() => {
      const { policy, state } = this.#requiredDomain(input.clearingDomainId);
      expected(state.stateHash, input.expectedStateHash, 'expected domain state hash');
      const next = adjustNativeClearingRecoveryReserve(state, policy, input.reserveDeltaQuoteAtoms);
      this.#updateState(state, next);
      this.#event('RESERVE', next.stateHash, policy, next.sequence, {
        previousStateHash: state.stateHash,
        reserveDeltaQuoteAtoms: input.reserveDeltaQuoteAtoms,
        resultingState: next,
      });
      return next;
    }).immediate();
  }

  adjustCollateral(input: Readonly<{
    accountId: string;
    expectedAccountHash: Uint8Array | string;
    collateralDeltaQuoteAtoms: bigint;
    markPriceTicks: bigint;
    observedAtMs: bigint;
    nowMs: bigint;
  }>): NativeClearingAccount {
    return this.#db.transaction(() => {
      const current = this.account(input.accountId);
      if (current === undefined) throw new NativeClearingStoreError('ACCOUNT_NOT_FOUND', 'Native clearing account was not found.');
      const policy = this.#policy(current.policyHash);
      expected(current.accountHash, input.expectedAccountHash, 'expected account hash');
      const next = adjustNativeClearingCollateral(
        current,
        policy,
        input.collateralDeltaQuoteAtoms,
        input.markPriceTicks,
        input.observedAtMs,
        input.nowMs,
      );
      this.#updateAccount(current, next);
      this.#event('COLLATERAL', next.accountHash, policy, next.sequence, {
        previousAccountHash: current.accountHash,
        collateralDeltaQuoteAtoms: input.collateralDeltaQuoteAtoms,
        resultingAccount: next,
      });
      return next;
    }).immediate();
  }

  match(input: Readonly<{
    clearingDomainId: string;
    expectedStateHash: Uint8Array | string;
    longAccountId: string;
    expectedLongAccountHash: Uint8Array | string;
    shortAccountId: string;
    expectedShortAccountHash: Uint8Array | string;
    executionId: string;
    quantityAtoms: bigint;
    priceTicks: bigint;
    markPriceTicks: bigint;
    observedAtMs: bigint;
    nowMs: bigint;
  }>): NativeClearingMatchReceipt {
    return this.#db.transaction(() => {
      const { policy, state } = this.#requiredDomain(input.clearingDomainId);
      const long = this.#requiredAccount(input.longAccountId, policy);
      const short = this.#requiredAccount(input.shortAccountId, policy);
      expected(state.stateHash, input.expectedStateHash, 'expected domain state hash');
      expected(long.accountHash, input.expectedLongAccountHash, 'expected long account hash');
      expected(short.accountHash, input.expectedShortAccountHash, 'expected short account hash');
      const result = applyNativeClearingMatch({ ...input, policy, domainState: state, longAccount: long, shortAccount: short });
      this.#updateState(state, result.domainState);
      this.#updateAccount(long, result.longAccount);
      this.#updateAccount(short, result.shortAccount);
      this.#event('MATCH', result.receipt.receiptHash, policy, result.domainState.sequence, result.receipt);
      return result.receipt;
    }).immediate();
  }

  resolveDefault(input: Readonly<{
    clearingDomainId: string;
    expectedStateHash: Uint8Array | string;
    defaultedAccountId: string;
    expectedDefaultedAccountHash: Uint8Array | string;
    backstopAccountId: string;
    expectedBackstopAccountHash: Uint8Array | string;
    resolutionId: string;
    transferPriceTicks: bigint;
    markPriceTicks: bigint;
    observedAtMs: bigint;
    nowMs: bigint;
  }>): NativeClearingDefaultResolution {
    return this.#db.transaction(() => {
      const { policy, state } = this.#requiredDomain(input.clearingDomainId);
      const defaulter = this.#requiredAccount(input.defaultedAccountId, policy);
      const backstop = this.#requiredAccount(input.backstopAccountId, policy);
      expected(state.stateHash, input.expectedStateHash, 'expected domain state hash');
      expected(defaulter.accountHash, input.expectedDefaultedAccountHash, 'expected defaulted account hash');
      expected(backstop.accountHash, input.expectedBackstopAccountHash, 'expected backstop account hash');
      const result = resolveNativeClearingDefault({
        ...input,
        policy,
        domainState: state,
        defaultedAccount: defaulter,
        backstopAccount: backstop,
      });
      this.#updateState(state, result.domainState);
      this.#updateAccount(defaulter, result.defaultedAccount);
      this.#updateAccount(backstop, result.backstopAccount);
      this.#event('DEFAULT', result.resolution.resolutionHash, policy, result.domainState.sequence, result.resolution);
      return result.resolution;
    }).immediate();
  }

  events(clearingDomainId: string): readonly NativeClearingEvent[] {
    const { policy } = this.#requiredDomain(clearingDomainId);
    const rows = this.#db.prepare('SELECT * FROM native_clearing_events WHERE policy_hash = ? ORDER BY event_sequence')
      .all(policy.policyHash) as EventRow[];
    return Object.freeze(rows.map((row) => this.#decodeEvent(row, policy)));
  }

  #requiredDomain(id: string): Readonly<{ policy: NativeClearingPolicy; state: NativeClearingDomainState }> {
    const result = this.domain(id);
    if (result === undefined) throw new NativeClearingStoreError('DOMAIN_NOT_FOUND', 'Native clearing domain was not found.');
    return result;
  }

  #requiredAccount(id: string, policy: NativeClearingPolicy): NativeClearingAccount {
    const result = this.account(id);
    if (result === undefined) throw new NativeClearingStoreError('ACCOUNT_NOT_FOUND', 'Native clearing account was not found.');
    if (!bytesEqual(result.policyHash, policy.policyHash)) {
      throw new NativeClearingStoreError('POLICY_MISMATCH', 'Native clearing accounts belong to different domains.');
    }
    return result;
  }

  #decodePolicy(row: PolicyRow): NativeClearingPolicy {
    try {
      if (typeof row.clearing_domain_id !== 'string' || typeof row.policy_json !== 'string') throw new Error('malformed row');
      const policy = nativeClearingPolicy(parseProtocolJson(row.policy_json) as NativeClearingPolicy);
      if (policy.clearingDomainId !== row.clearing_domain_id
        || !bytesEqual(policy.policyHash, hash(row.policy_hash, 'stored policy hash'))
        || json(policy, 'stored policy') !== row.policy_json) throw new Error('identity mismatch');
      return policy;
    } catch (cause) {
      throw this.#corrupt('Stored native clearing policy failed revalidation.', cause);
    }
  }

  #policy(policyHash: Uint8Array): NativeClearingPolicy {
    const row = this.#db.prepare('SELECT * FROM native_clearing_policies WHERE policy_hash = ?')
      .get(policyHash) as PolicyRow | undefined;
    if (row === undefined) throw new NativeClearingStoreError('CORRUPT_ROW', 'Stored state cites an unknown policy.');
    return this.#decodePolicy(row);
  }

  #state(policy: NativeClearingPolicy): NativeClearingDomainState {
    const row = this.#db.prepare('SELECT * FROM native_clearing_domains WHERE policy_hash = ?')
      .get(policy.policyHash) as DomainRow | undefined;
    if (row === undefined) throw new NativeClearingStoreError('CORRUPT_ROW', 'Native clearing domain state is missing.');
    try {
      if (typeof row.state_json !== 'string') throw new Error('malformed row');
      const state = nativeClearingDomainState(parseProtocolJson(row.state_json) as NativeClearingDomainState, policy);
      if (!bytesEqual(state.stateHash, hash(row.state_hash, 'stored state hash'))
        || json(state, 'stored state') !== row.state_json) throw new Error('identity mismatch');
      return state;
    } catch (cause) {
      throw this.#corrupt('Stored native clearing state failed revalidation.', cause);
    }
  }

  #decodeAccount(row: AccountRow, policy: NativeClearingPolicy): NativeClearingAccount {
    try {
      if (typeof row.account_id !== 'string' || typeof row.account_json !== 'string') throw new Error('malformed row');
      const account = nativeClearingAccount(parseProtocolJson(row.account_json) as NativeClearingAccount, policy);
      if (account.accountId !== row.account_id
        || !bytesEqual(account.accountHash, hash(row.account_hash, 'stored account hash'))
        || json(account, 'stored account') !== row.account_json) throw new Error('identity mismatch');
      return account;
    } catch (cause) {
      throw this.#corrupt('Stored native clearing account failed revalidation.', cause);
    }
  }

  #updateState(previous: NativeClearingDomainState, next: NativeClearingDomainState): void {
    const result = this.#db.prepare(`
      UPDATE native_clearing_domains SET state_hash = ?, state_json = ?
      WHERE policy_hash = ? AND state_hash = ?
    `).run(next.stateHash, json(next, 'native clearing state'), next.policyHash, previous.stateHash);
    if (result.changes !== 1) throw new NativeClearingStoreError('STALE_STATE', 'Native clearing domain changed concurrently.');
  }

  #updateAccount(previous: NativeClearingAccount, next: NativeClearingAccount): void {
    const result = this.#db.prepare(`
      UPDATE native_clearing_accounts SET account_hash = ?, account_json = ?
      WHERE account_id = ? AND account_hash = ?
    `).run(next.accountHash, json(next, 'native clearing account'), previous.accountId, previous.accountHash);
    if (result.changes !== 1) throw new NativeClearingStoreError('STALE_STATE', 'Native clearing account changed concurrently.');
  }

  #event(kind: NativeClearingEventKind, eventHash: Uint8Array, policy: NativeClearingPolicy, sequence: bigint, payload: unknown): void {
    const number = Number(sequence);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error('native clearing event sequence is invalid');
    this.#db.prepare(`
      INSERT INTO native_clearing_events
        (event_kind, event_hash, policy_hash, source_sequence, event_json, recorded_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(kind, eventHash, policy.policyHash, number, json(payload, 'native clearing event'), clock(this.#clock()));
  }

  #decodeEvent(row: EventRow, policy: NativeClearingPolicy): NativeClearingEvent {
    try {
      if ((row.event_kind !== 'RESERVE' && row.event_kind !== 'COLLATERAL'
          && row.event_kind !== 'MATCH' && row.event_kind !== 'DEFAULT')
        || typeof row.event_sequence !== 'number' || !Number.isSafeInteger(row.event_sequence) || row.event_sequence < 1
        || typeof row.source_sequence !== 'number' || !Number.isSafeInteger(row.source_sequence) || row.source_sequence < 0
        || typeof row.event_json !== 'string' || typeof row.recorded_at_ms !== 'number') throw new Error('malformed row');
      const policyHash = hash(row.policy_hash, 'stored event policy hash');
      if (!bytesEqual(policyHash, policy.policyHash)) throw new Error('policy mismatch');
      const payload = parseProtocolJson(row.event_json);
      if (json(payload, 'stored event') !== row.event_json) throw new Error('noncanonical event');
      return Object.freeze({
        kind: row.event_kind,
        eventHashHex: toHex(hash(row.event_hash, 'stored event hash')),
        policyHashHex: toHex(policyHash),
        sequence: row.event_sequence,
        sourceSequence: row.source_sequence,
        payload,
        recordedAtMs: clock(row.recorded_at_ms),
      });
    } catch (cause) {
      throw this.#corrupt('Stored native clearing event failed revalidation.', cause);
    }
  }

  #corrupt(message: string, cause: unknown): NativeClearingStoreError {
    return new NativeClearingStoreError('CORRUPT_ROW', `${message}${cause instanceof Error ? ` ${cause.message}` : ''}`);
  }
}
