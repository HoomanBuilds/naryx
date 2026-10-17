import type Database from 'better-sqlite3';
import type { EvmNativeClearingBackingVerifier, EvmNativeClearingTransition } from '@naryx/adapter-evm';
import {
  adjustNativeClearingCollateral,
  adjustNativeClearingRecoveryReserve,
  applyNativeClearingMatch,
  bytesEqual,
  commitmentHash,
  nativeClearingCollateralAuthorization,
  nativeClearingDefaultAuction,
  nativeClearingDefaultAuctionHash,
  nativeClearingDefaultBid,
  nativeClearingDefaultBidHash,
  nativeClearingAccount,
  nativeClearingDomainState,
  nativeClearingExecutionId,
  nativeClearingMatchAuthorization,
  nativeClearingMarkObservation,
  nativeClearingPolicy,
  parseProtocolJson,
  protocolId,
  resolveNativeClearingDefault,
  selectNativeClearingDefaultBid,
  stringifyProtocolJson,
  toHex,
  type NativeClearingAccount,
  type NativeClearingAccountInput,
  type NativeClearingDefaultResolution,
  type NativeClearingDefaultAuction,
  type NativeClearingDefaultBid,
  type NativeClearingDefaultBidInput,
  type NativeClearingDomainState,
  type NativeClearingDomainStateInput,
  type NativeClearingMatchReceipt,
  type NativeClearingMatchAuthorizationInput,
  type NativeClearingCollateralAuthorizationInput,
  type NativeClearingMarkObservation,
  type NativeClearingMarkObservationInput,
  type NativeClearingPolicy,
  type NativeClearingPolicyInput,
  type ExpiryUnit,
  verifyNativeClearingCollateralAuthorization,
} from '@naryx/protocol-types';
import { openDurableDatabase } from './durable-sqlite.js';
import {
  verifyNativeClearingControlSignature,
  type NativeClearingControlSignature,
} from './native-clearing-authorization.js';

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
CREATE TABLE IF NOT EXISTS native_clearing_marks (
  observation_hash BLOB PRIMARY KEY,
  policy_hash BLOB NOT NULL REFERENCES native_clearing_policies(policy_hash),
  source_sequence INTEGER NOT NULL,
  observation_json TEXT NOT NULL,
  authorization_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE (policy_hash, source_sequence)
) STRICT;
CREATE TABLE IF NOT EXISTS native_clearing_default_auctions (
  auction_hash BLOB PRIMARY KEY,
  auction_id TEXT NOT NULL UNIQUE,
  policy_hash BLOB NOT NULL REFERENCES native_clearing_policies(policy_hash),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'SETTLED')),
  auction_json TEXT NOT NULL,
  resolution_hash BLOB,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS native_clearing_default_bids (
  bid_hash BLOB PRIMARY KEY,
  auction_hash BLOB NOT NULL REFERENCES native_clearing_default_auctions(auction_hash),
  backstop_account_id TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  bid_json TEXT NOT NULL,
  authorization_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE (auction_hash, backstop_account_id, nonce)
) STRICT;
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
CREATE TABLE IF NOT EXISTS native_clearing_match_settlements (
  authorization_hash BLOB PRIMARY KEY,
  policy_hash BLOB NOT NULL REFERENCES native_clearing_policies(policy_hash),
  receipt_hash BLOB NOT NULL UNIQUE,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO native_clearing_match_settlements (authorization_hash, policy_hash, receipt_hash, recorded_at_ms)
  SELECT unhex(json_extract(event_json, '$.authorizationHash.value')), policy_hash, event_hash, recorded_at_ms
  FROM native_clearing_events
  WHERE event_kind = 'MATCH' AND event_hash NOT IN (SELECT receipt_hash FROM native_clearing_match_settlements);
CREATE TRIGGER IF NOT EXISTS reject_native_clearing_match_settlement_update
  BEFORE UPDATE ON native_clearing_match_settlements
  BEGIN SELECT RAISE(ABORT, 'native clearing match settlements are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_native_clearing_match_settlement_delete
  BEFORE DELETE ON native_clearing_match_settlements
  BEGIN SELECT RAISE(ABORT, 'native clearing match settlements are durable'); END;
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
CREATE TABLE IF NOT EXISTS native_clearing_backing_receipts (
  receipt_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_hash BLOB NOT NULL REFERENCES native_clearing_policies(policy_hash),
  action TEXT NOT NULL,
  before_snapshot TEXT NOT NULL,
  after_snapshot TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS native_clearing_backing_receipts_by_policy
  ON native_clearing_backing_receipts (policy_hash, receipt_sequence);
CREATE TRIGGER IF NOT EXISTS reject_native_clearing_backing_receipt_update
  BEFORE UPDATE ON native_clearing_backing_receipts
  BEGIN SELECT RAISE(ABORT, 'native clearing backing receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_native_clearing_backing_receipt_delete
  BEFORE DELETE ON native_clearing_backing_receipts
  BEGIN SELECT RAISE(ABORT, 'native clearing backing receipts are durable'); END;
CREATE TABLE IF NOT EXISTS native_clearing_contract_transitions (
  transaction_hash TEXT PRIMARY KEY,
  policy_hash BLOB NOT NULL REFERENCES native_clearing_policies(policy_hash),
  transition_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS reject_native_clearing_contract_transition_update
  BEFORE UPDATE ON native_clearing_contract_transitions
  BEGIN SELECT RAISE(ABORT, 'native clearing contract transitions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_native_clearing_contract_transition_delete
  BEFORE DELETE ON native_clearing_contract_transitions
  BEGIN SELECT RAISE(ABORT, 'native clearing contract transitions are durable'); END;
`;

export interface NativeClearingBackingCheck {
  readonly clearingDomainId: string;
  readonly action: string;
  readonly beforeSnapshot: string;
  readonly afterSnapshot: string;
  readonly proof: Awaited<ReturnType<EvmNativeClearingBackingVerifier['verify']>>;
}

export function nativeClearingBackingSnapshot(
  domain: Readonly<{ policy: NativeClearingPolicy; state: NativeClearingDomainState }> | undefined,
  accounts: readonly NativeClearingAccount[],
  mark: NativeClearingMarkObservation | undefined,
): string {
  return json(domain === undefined ? null : {
    policyHash: domain.policy.policyHash,
    stateHash: domain.state.stateHash,
    accounts: [...accounts].sort((a, b) => a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0)
      .map((account) => ({ accountId: account.accountId, accountHash: account.accountHash })),
    markHash: mark?.observationHash ?? null,
  }, 'native clearing backing snapshot');
}

type PolicyRow = { policy_hash: unknown; clearing_domain_id: unknown; policy_json: unknown };
type DomainRow = { policy_hash: unknown; state_hash: unknown; state_json: unknown };
type AccountRow = { account_id: unknown; policy_hash: unknown; account_hash: unknown; account_json: unknown };
type MarkRow = { observation_hash: unknown; policy_hash: unknown; observation_json: unknown };
type AuctionRow = { auction_hash: unknown; auction_id: unknown; policy_hash: unknown; status: unknown; auction_json: unknown };
type BidRow = { bid_hash: unknown; auction_hash: unknown; bid_json: unknown };
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

function expiryNow(unit: ExpiryUnit, nowMs: bigint): bigint {
  if (unit === 'EVM_UNIX_SECONDS') return nowMs / 1_000n;
  if (unit === 'HYPERLIQUID_UNIX_MILLISECONDS') return nowMs;
  throw new NativeClearingStoreError('UNSUPPORTED_CLOCK', 'Native clearing has no verified chain read for this expiry clock.');
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
    backing?: NativeClearingBackingCheck,
  ): Readonly<{ policy: NativeClearingPolicy; state: NativeClearingDomainState }> {
    const policy = nativeClearingPolicy(policyInput);
    const state = nativeClearingDomainState(stateInput, policy);
    if (state.openInterestAtoms !== 0n || state.sequence !== 0n) {
      throw new NativeClearingStoreError('INVALID_GENESIS', 'A new clearing domain must begin with zero open interest and sequence zero.');
    }
    return this.#backedTransaction(backing, () => {
      this.#requireBacking(backing, policy, 'domains');
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
    });
  }

  domain(clearingDomainId: string): Readonly<{ policy: NativeClearingPolicy; state: NativeClearingDomainState }> | undefined {
    const id = protocolId(clearingDomainId, 'native clearing domain id');
    const row = this.#db.prepare('SELECT * FROM native_clearing_policies WHERE clearing_domain_id = ?')
      .get(id) as PolicyRow | undefined;
    if (row === undefined) return undefined;
    const policy = this.#decodePolicy(row);
    return Object.freeze({ policy, state: this.#state(policy) });
  }

  domains(): readonly Readonly<{ policy: NativeClearingPolicy; state: NativeClearingDomainState }>[] {
    const rows = this.#db.prepare('SELECT * FROM native_clearing_policies ORDER BY clearing_domain_id')
      .all() as PolicyRow[];
    return Object.freeze(rows.map((row) => {
      const policy = this.#decodePolicy(row);
      return Object.freeze({ policy, state: this.#state(policy) });
    }));
  }

  openAccount(clearingDomainId: string, input: NativeClearingAccountInput | NativeClearingAccount, backing?: NativeClearingBackingCheck): NativeClearingAccount {
    return this.#backedTransaction(backing, () => {
      const { policy } = this.#requiredDomain(clearingDomainId);
      this.#requireBacking(backing, policy, 'accounts');
      const account = nativeClearingAccount(input, policy);
      if (account.positionAtoms !== 0n || account.cashBalanceQuoteAtoms !== 0n || account.collateralQuoteAtoms !== 0n
        || account.sequence !== 0n) {
        throw new NativeClearingStoreError('INVALID_GENESIS', 'A new clearing account must begin flat and unfunded at sequence zero.');
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
    });
  }

  account(accountId: string): NativeClearingAccount | undefined {
    const id = protocolId(accountId, 'native clearing account id');
    const row = this.#db.prepare('SELECT * FROM native_clearing_accounts WHERE account_id = ?')
      .get(id) as AccountRow | undefined;
    if (row === undefined) return undefined;
    return this.#decodeAccount(row, this.#policy(hash(row.policy_hash, 'stored account policy hash')));
  }

  accounts(clearingDomainId: string): readonly NativeClearingAccount[] {
    const { policy } = this.#requiredDomain(clearingDomainId);
    const rows = this.#db.prepare(`
      SELECT * FROM native_clearing_accounts
      WHERE policy_hash = ?
      ORDER BY account_id
    `).all(policy.policyHash) as AccountRow[];
    return Object.freeze(rows.map((row) => this.#decodeAccount(row, policy)));
  }

  adjustReserve(input: Readonly<{
    clearingDomainId: string;
    expectedStateHash: Uint8Array | string;
    reserveDeltaQuoteAtoms: bigint;
  }>, backing?: NativeClearingBackingCheck): NativeClearingDomainState {
    return this.#backedTransaction(backing, () => {
      const { policy, state } = this.#requiredDomain(input.clearingDomainId);
      this.#requireBacking(backing, policy, 'reserve');
      expected(state.stateHash, input.expectedStateHash, 'expected domain state hash');
      const next = adjustNativeClearingRecoveryReserve(state, policy, input.reserveDeltaQuoteAtoms);
      this.#updateState(state, next);
      this.#event('RESERVE', next.stateHash, policy, next.sequence, {
        previousStateHash: state.stateHash,
        reserveDeltaQuoteAtoms: input.reserveDeltaQuoteAtoms,
        resultingState: next,
      });
      return next;
    });
  }

  async recordMark(input: Readonly<{
    clearingDomainId: string;
    observation: NativeClearingMarkObservationInput;
    authorization: NativeClearingControlSignature;
  }>, backing?: NativeClearingBackingCheck): Promise<NativeClearingMarkObservation> {
    const { policy } = this.#requiredDomain(input.clearingDomainId);
    const observation = nativeClearingMarkObservation(input.observation, policy);
    if (!await verifyNativeClearingControlSignature(
      observation.authorityId,
      observation.observationHash,
      input.authorization,
    )) {
      throw new NativeClearingStoreError('INVALID_SIGNATURE', 'Mark authority did not sign the observation.');
    }
    return this.#backedTransaction(backing, () => {
      this.#requireBacking(backing, policy, 'marks');
      const current = this.#latestMark(policy, false);
      if (current !== undefined && observation.sourceSequence <= current.sourceSequence) {
        throw new NativeClearingStoreError('STALE_MARK', 'Mark source sequence must increase.');
      }
      this.#db.prepare(`
        INSERT INTO native_clearing_marks
          (observation_hash, policy_hash, source_sequence, observation_json, authorization_json, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        observation.observationHash,
        policy.policyHash,
        observation.sourceSequence,
        json(observation, 'native clearing mark'),
        json(input.authorization, 'native clearing mark authorization'),
        clock(this.#clock()),
      );
      return observation;
    });
  }

  latestMark(clearingDomainId: string): NativeClearingMarkObservation | undefined {
    const { policy } = this.#requiredDomain(clearingDomainId);
    return this.#latestMark(policy, false);
  }

  async adjustAuthorizedCollateral(input: Readonly<{
    authorization: NativeClearingCollateralAuthorizationInput;
    ownerSignature: NativeClearingControlSignature;
  }>, backing?: NativeClearingBackingCheck): Promise<NativeClearingAccount> {
    const command = nativeClearingCollateralAuthorization(input.authorization);
    if (!await verifyNativeClearingControlSignature(command.ownerId, command.authorizationHash, input.ownerSignature)) {
      throw new NativeClearingStoreError('INVALID_SIGNATURE', 'Clearing account owner did not sign the collateral command.');
    }
    return this.#backedTransaction(backing, () => {
      const nowMs = this.#nowMs();
      const current = this.account(command.accountId);
      if (current === undefined) throw new NativeClearingStoreError('ACCOUNT_NOT_FOUND', 'Native clearing account was not found.');
      const policy = this.#policy(current.policyHash);
      this.#requireBacking(backing, policy, 'collateral');
      verifyNativeClearingCollateralAuthorization(
        command,
        policy,
        current,
        command.validUntilUnit,
        expiryNow(command.validUntilUnit, nowMs),
      );
      const mark = this.#liveMark(policy, nowMs);
      const next = adjustNativeClearingCollateral(
        current,
        policy,
        command.collateralDeltaQuoteAtoms,
        mark.priceTicks,
        mark.observedAtMs,
        nowMs,
      );
      this.#updateAccount(current, next);
      this.#event('COLLATERAL', next.accountHash, policy, next.sequence, {
        previousAccountHash: current.accountHash,
        authorizationHash: command.authorizationHash,
        collateralDeltaQuoteAtoms: command.collateralDeltaQuoteAtoms,
        markObservationHash: mark.observationHash,
        resultingAccount: next,
      });
      return next;
    });
  }

  settleAuthorizedMatch(input: Readonly<{
    authorization: Omit<NativeClearingMatchAuthorizationInput, 'currentExpiryUnit' | 'currentExpiryValue'>;
    expectedStateHash: Uint8Array | string;
    expectedLongAccountHash: Uint8Array | string;
    expectedShortAccountHash: Uint8Array | string;
  }>): NativeClearingMatchReceipt {
    return this.#db.transaction(() => {
      const nowMs = this.#nowMs();
      const currentExpiryUnit = input.authorization.takerSettlementCommitment.validUntilUnit;
      const authorization = nativeClearingMatchAuthorization({
        ...input.authorization,
        currentExpiryUnit,
        currentExpiryValue: expiryNow(currentExpiryUnit, nowMs),
      });
      const { policy, state } = this.#requiredDomain(input.authorization.policy.clearingDomainId);
      this.#requireBacking(undefined, policy, 'matches');
      expected(policy.policyHash, authorization.policyHash, 'authorized policy hash');
      const long = this.#requiredAccount(authorization.longAccountId, policy);
      const short = this.#requiredAccount(authorization.shortAccountId, policy);
      if (long.ownerId !== authorization.longParticipantId || short.ownerId !== authorization.shortParticipantId) {
        throw new NativeClearingStoreError(
          'OWNER_MISMATCH',
          'Settlement commitments do not identify the durable clearing account owners.',
        );
      }
      expected(state.stateHash, input.expectedStateHash, 'expected domain state hash');
      expected(long.accountHash, input.expectedLongAccountHash, 'expected long account hash');
      expected(short.accountHash, input.expectedShortAccountHash, 'expected short account hash');
      if (this.#db.prepare('SELECT 1 FROM native_clearing_match_settlements WHERE authorization_hash = ?')
        .get(authorization.authorizationHash) !== undefined) {
        throw new NativeClearingStoreError('SETTLEMENT_CONFLICT', 'Match authorization was already settled.');
      }
      const mark = this.#liveMark(policy, nowMs);
      const result = applyNativeClearingMatch({
        policy,
        domainState: state,
        longAccount: long,
        shortAccount: short,
        executionId: nativeClearingExecutionId(authorization),
        quantityAtoms: authorization.quantityAtoms,
        priceTicks: authorization.priceTicks,
        markPriceTicks: mark.priceTicks,
        observedAtMs: mark.observedAtMs,
        nowMs,
      });
      this.#updateState(state, result.domainState);
      this.#updateAccount(long, result.longAccount);
      this.#updateAccount(short, result.shortAccount);
      this.#event('MATCH', result.receipt.receiptHash, policy, result.domainState.sequence, {
        authorizationHash: authorization.authorizationHash,
        markObservationHash: mark.observationHash,
        receipt: result.receipt,
      });
      this.#db.prepare(`
        INSERT INTO native_clearing_match_settlements (authorization_hash, policy_hash, receipt_hash, recorded_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(authorization.authorizationHash, policy.policyHash, result.receipt.receiptHash, clock(this.#clock()));
      return result.receipt;
    }).immediate();
  }

  openDefaultAuction(input: Readonly<{
    clearingDomainId: string;
    defaultedAccountId: string;
    expectedDefaultedAccountHash: Uint8Array | string;
    auctionId: string;
    bidsCloseAtMs: bigint;
  }>): NativeClearingDefaultAuction {
    return this.#db.transaction(() => {
      const nowMs = this.#nowMs();
      const { policy } = this.#requiredDomain(input.clearingDomainId);
      const defaulter = this.#requiredAccount(input.defaultedAccountId, policy);
      this.#requireBacking(undefined, policy, 'auctions');
      expected(defaulter.accountHash, input.expectedDefaultedAccountHash, 'expected defaulted account hash');
      const mark = this.#liveMark(policy, nowMs);
      const auction = nativeClearingDefaultAuction({
        policy,
        defaultedAccount: defaulter,
        markObservation: mark,
        auctionId: input.auctionId,
        openedAtMs: nowMs,
        bidsCloseAtMs: input.bidsCloseAtMs,
      });
      this.#db.prepare(`
        INSERT INTO native_clearing_default_auctions
          (auction_hash, auction_id, policy_hash, status, auction_json, resolution_hash, recorded_at_ms)
        VALUES (?, ?, ?, 'OPEN', ?, NULL, ?)
      `).run(
        auction.auctionHash,
        auction.auctionId,
        policy.policyHash,
        json(auction, 'native clearing default auction'),
        clock(this.#clock()),
      );
      return auction;
    }).immediate();
  }

  async submitDefaultBid(input: Readonly<{
    auctionId: string;
    bid: NativeClearingDefaultBidInput;
    ownerSignature: NativeClearingControlSignature;
  }>): Promise<NativeClearingDefaultBid> {
    const auctionRecord = this.#auctionRecord(input.auctionId);
    if (auctionRecord.status !== 'OPEN' || this.#nowMs() >= auctionRecord.auction.bidsCloseAtMs) {
      throw new NativeClearingStoreError('AUCTION_CLOSED', 'Default auction is not accepting bids.');
    }
    const bid = nativeClearingDefaultBid(input.bid, auctionRecord.auction);
    const policy = this.#policy(auctionRecord.auction.policyHash);
    this.#requireBacking(undefined, policy, 'auction-bids');
    const backstop = this.#requiredAccount(bid.backstopAccountId, policy);
    if (!bytesEqual(backstop.accountHash, bid.backstopAccountHash)
      || backstop.ownerId !== bid.backstopOwnerId
      || backstop.sequence !== bid.nonce) {
      throw new NativeClearingStoreError('STALE_BID', 'Default bid is not bound to current backstop state.');
    }
    if (!await verifyNativeClearingControlSignature(bid.backstopOwnerId, bid.bidHash, input.ownerSignature)) {
      throw new NativeClearingStoreError('INVALID_SIGNATURE', 'Backstop owner did not sign the default bid.');
    }
    return this.#db.transaction(() => {
      const currentAuction = this.#auctionRecord(input.auctionId);
      const nowMs = this.#nowMs();
      if (currentAuction.status !== 'OPEN' || nowMs >= currentAuction.auction.bidsCloseAtMs || nowMs > bid.validUntilMs) {
        throw new NativeClearingStoreError('AUCTION_CLOSED', 'Default auction is not accepting bids.');
      }
      const currentBackstop = this.#requiredAccount(bid.backstopAccountId, policy);
      if (!bytesEqual(currentBackstop.accountHash, bid.backstopAccountHash)
        || currentBackstop.ownerId !== bid.backstopOwnerId || currentBackstop.sequence !== bid.nonce) {
        throw new NativeClearingStoreError('STALE_BID', 'Default bid is not bound to current backstop state.');
      }
      this.#db.prepare(`
        INSERT INTO native_clearing_default_bids
          (bid_hash, auction_hash, backstop_account_id, nonce, bid_json, authorization_json, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        bid.bidHash,
        bid.auctionHash,
        bid.backstopAccountId,
        bid.nonce,
        json(bid, 'native clearing default bid'),
        json(input.ownerSignature, 'native clearing default bid authorization'),
        clock(this.#clock()),
      );
      return bid;
    }).immediate();
  }

  settleDefaultAuction(input: Readonly<{
    auctionId: string;
    expectedStateHash: Uint8Array | string;
  }>): NativeClearingDefaultResolution {
    return this.#db.transaction(() => {
      const nowMs = this.#nowMs();
      const auctionRecord = this.#auctionRecord(input.auctionId);
      if (auctionRecord.status !== 'OPEN') {
        throw new NativeClearingStoreError('AUCTION_CLOSED', 'Default auction is already settled.');
      }
      const auction = auctionRecord.auction;
      const policy = this.#policy(auction.policyHash);
      this.#requireBacking(undefined, policy, 'auction-settlements');
      const state = this.#state(policy);
      expected(state.stateHash, input.expectedStateHash, 'expected domain state hash');
      const mark = this.#mark(auction.markObservationHash, policy);
      if (nowMs < auction.bidsCloseAtMs || nowMs > mark.validUntilMs) {
        throw new NativeClearingStoreError('AUCTION_WINDOW', 'Default auction cannot settle outside its mark-bound window.');
      }
      const defaulter = this.#requiredAccount(auction.defaultedAccountId, policy);
      expected(defaulter.accountHash, auction.defaultedAccountHash, 'auction defaulted account hash');
      const bids = this.#bids(auction).filter((candidate) => {
        const account = this.account(candidate.backstopAccountId);
        return account !== undefined
          && account.ownerId === candidate.backstopOwnerId
          && account.sequence === candidate.nonce
          && bytesEqual(account.accountHash, candidate.backstopAccountHash);
      });
      const selected = selectNativeClearingDefaultBid(auction, bids, nowMs);
      const backstop = this.#requiredAccount(selected.backstopAccountId, policy);
      const result = resolveNativeClearingDefault({
        policy,
        domainState: state,
        defaultedAccount: defaulter,
        backstopAccount: backstop,
        resolutionId: auction.auctionId,
        transferPriceTicks: selected.transferPriceTicks,
        markPriceTicks: mark.priceTicks,
        observedAtMs: mark.observedAtMs,
        nowMs,
      });
      this.#updateState(state, result.domainState);
      this.#updateAccount(defaulter, result.defaultedAccount);
      this.#updateAccount(backstop, result.backstopAccount);
      this.#db.prepare(`
        UPDATE native_clearing_default_auctions
        SET status = 'SETTLED', resolution_hash = ?
        WHERE auction_hash = ? AND status = 'OPEN'
      `).run(result.resolution.resolutionHash, auction.auctionHash);
      this.#event('DEFAULT', result.resolution.resolutionHash, policy, result.domainState.sequence, {
        auctionHash: auction.auctionHash,
        selectedBidHash: selected.bidHash,
        markObservationHash: mark.observationHash,
        resolution: result.resolution,
      });
      return result.resolution;
    }).immediate();
  }

  defaultAuction(auctionId: string): Readonly<{
    auction: NativeClearingDefaultAuction;
    status: 'OPEN' | 'SETTLED';
    bids: readonly NativeClearingDefaultBid[];
  }> {
    const record = this.#auctionRecord(auctionId);
    return Object.freeze({ ...record, bids: this.#bids(record.auction) });
  }

  events(clearingDomainId: string, after = 0, limit = 100): readonly NativeClearingEvent[] {
    const { policy } = this.#requiredDomain(clearingDomainId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new NativeClearingStoreError('INVALID_INPUT', 'Native clearing event cursor or limit is invalid.');
    }
    const rows = this.#db.prepare(`
      SELECT * FROM native_clearing_events
      WHERE policy_hash = ? AND event_sequence > ?
      ORDER BY event_sequence
      LIMIT ?
    `).all(policy.policyHash, after, limit) as EventRow[];
    return Object.freeze(rows.map((row) => this.#decodeEvent(row, policy)));
  }

  #nowMs(): bigint {
    return BigInt(clock(this.#clock()));
  }

  backingSnapshot(clearingDomainId: string): string {
    return this.#db.transaction(() => {
      const domain = this.domain(clearingDomainId);
      return nativeClearingBackingSnapshot(domain, domain === undefined ? [] : this.accounts(clearingDomainId),
        domain === undefined ? undefined : this.latestMark(clearingDomainId));
    })();
  }

  contractTransition(transactionHash: string): EvmNativeClearingTransition | undefined {
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new NativeClearingStoreError('INVALID_INPUT', 'Clearing transaction hash is invalid.');
    const row = this.#db.prepare('SELECT transition_json FROM native_clearing_contract_transitions WHERE transaction_hash = ?')
      .get(transactionHash.toLowerCase()) as { transition_json: string } | undefined;
    return row === undefined ? undefined : parseProtocolJson(row.transition_json) as EvmNativeClearingTransition;
  }

  recordFinalizedTransition(clearingDomainId: string, beforeSnapshot: string, transition: EvmNativeClearingTransition): EvmNativeClearingTransition {
    const { policy } = this.#requiredDomain(clearingDomainId);
    const afterSnapshot = nativeClearingBackingSnapshot({ policy, state: transition.state }, transition.accounts, this.latestMark(clearingDomainId));
    return this.#backedTransaction({ clearingDomainId, beforeSnapshot, afterSnapshot,
      action: transition.kind === 'MATCH' ? 'matches' : 'recoveries', proof: transition.proof }, () => {
      const { state } = this.#requiredDomain(clearingDomainId);
      const accounts = this.accounts(clearingDomainId);
      if (!bytesEqual(policy.policyHash, transition.receipt.policyHash)
        || transition.state.sequence !== state.sequence + 1n
        || !bytesEqual(state.stateHash, transition.receipt.previousDomainStateHash)
        || accounts.length !== transition.accounts.length || new Set(transition.accounts.map((account) => account.accountId)).size !== accounts.length) {
        throw new NativeClearingStoreError('BACKING_STATE_MISMATCH', 'Clearing transition does not extend the durable ledger.');
      }
      if (this.contractTransition(transition.proof.transactionHash) !== undefined) throw new NativeClearingStoreError('SETTLEMENT_CONFLICT', 'Clearing transaction was already reconciled.');
      const changed = accounts.filter((account) => {
        const next = transition.accounts.find((candidate) => candidate.accountId === account.accountId);
        if (next === undefined || next.ownerId !== account.ownerId || !bytesEqual(next.policyHash, policy.policyHash)) {
          throw new NativeClearingStoreError('BACKING_STATE_MISMATCH', 'Clearing transition changes account identity.');
        }
        return !bytesEqual(next.accountHash, account.accountHash);
      });
      if (changed.length !== 2) throw new NativeClearingStoreError('BACKING_STATE_MISMATCH', 'Clearing transition must change exactly two accounts.');
      for (const account of changed) {
        const next = transition.accounts.find((candidate) => candidate.accountId === account.accountId)!;
        if (next.sequence !== account.sequence + 1n) throw new NativeClearingStoreError('BACKING_STATE_MISMATCH', 'Clearing transition account sequence differs.');
        this.#updateAccount(account, nativeClearingAccount(next, policy));
      }
      this.#updateState(state, nativeClearingDomainState(transition.state, policy));
      const receiptHash = transition.kind === 'MATCH' ? transition.receipt.receiptHash : transition.receipt.resolutionHash;
      if (transition.kind === 'MATCH') {
        if (this.#db.prepare('SELECT 1 FROM native_clearing_match_settlements WHERE authorization_hash = ?').get(transition.authorizationHash) !== undefined) {
          throw new NativeClearingStoreError('SETTLEMENT_CONFLICT', 'Clearing match authorization was already reconciled.');
        }
        this.#db.prepare('INSERT INTO native_clearing_match_settlements VALUES (?, ?, ?, ?)')
          .run(transition.authorizationHash, policy.policyHash, receiptHash, clock(this.#clock()));
      }
      this.#event(transition.kind, receiptHash, policy, transition.state.sequence, {
        transactionHash: transition.proof.transactionHash, markObservationHash: transition.markObservationHash, receipt: transition.receipt,
        ...(transition.kind === 'MATCH' ? { authorizationHash: transition.authorizationHash } : {}),
      });
      this.#db.prepare('INSERT INTO native_clearing_contract_transitions VALUES (?, ?, ?, ?)')
        .run(transition.proof.transactionHash.toLowerCase(), policy.policyHash, json(transition, 'clearing transition'), clock(this.#clock()));
      return transition;
    });
  }

  backingReceipts(clearingDomainId: string, after = 0, limit = 100) {
    const { policy } = this.#requiredDomain(clearingDomainId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new NativeClearingStoreError('INVALID_INPUT', 'Native clearing backing cursor or limit is invalid.');
    }
    const rows = this.#db.prepare(`SELECT * FROM native_clearing_backing_receipts
      WHERE policy_hash = ? AND receipt_sequence > ? ORDER BY receipt_sequence LIMIT ?`)
      .all(policy.policyHash, after, limit) as {
        receipt_sequence: number; action: string; before_snapshot: string; after_snapshot: string;
        proof_json: string; recorded_at_ms: number;
      }[];
    return rows.map((row) => ({
      sequence: row.receipt_sequence, action: row.action,
      beforeSnapshot: parseProtocolJson(row.before_snapshot), afterSnapshot: parseProtocolJson(row.after_snapshot),
      proof: parseProtocolJson(row.proof_json), recordedAtMs: row.recorded_at_ms,
    }));
  }

  #backedTransaction<T>(backing: NativeClearingBackingCheck | undefined, mutate: () => T): T {
    return this.#db.transaction(() => {
      if (backing !== undefined && this.backingSnapshot(backing.clearingDomainId) !== backing.beforeSnapshot) {
        throw new NativeClearingStoreError('STALE_BACKING', 'Clearing ledger changed while backing was being verified.');
      }
      const result = mutate();
      if (backing !== undefined) {
        if (this.backingSnapshot(backing.clearingDomainId) !== backing.afterSnapshot) {
          throw new NativeClearingStoreError('BACKING_STATE_MISMATCH', 'Clearing mutation differs from the verified post-state.');
        }
        const { policy } = this.#requiredDomain(backing.clearingDomainId);
        this.#db.prepare(`INSERT INTO native_clearing_backing_receipts
          (policy_hash, action, before_snapshot, after_snapshot, proof_json, recorded_at_ms)
          VALUES (?, ?, ?, ?, ?, ?)`).run(policy.policyHash, backing.action, backing.beforeSnapshot,
          backing.afterSnapshot, json(backing.proof, 'native clearing backing proof'), clock(this.#clock()));
      }
      return result;
    }).immediate();
  }

  #requireBacking(backing: NativeClearingBackingCheck | undefined, policy: NativeClearingPolicy, action: string): void {
    if (backing === undefined) {
      if (this.#db.prepare('SELECT 1 FROM native_clearing_backing_receipts WHERE policy_hash = ? LIMIT 1').get(policy.policyHash) !== undefined) {
        throw new NativeClearingStoreError('BACKING_REQUIRED', 'A backed clearing domain requires verified evidence for funding changes.');
      }
    } else if (backing.clearingDomainId !== policy.clearingDomainId || backing.action !== action) {
      throw new NativeClearingStoreError('BACKING_STATE_MISMATCH', 'Backing evidence belongs to a different domain or operation.');
    }
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

  #latestMark(policy: NativeClearingPolicy, required: true): NativeClearingMarkObservation;
  #latestMark(policy: NativeClearingPolicy, required: false): NativeClearingMarkObservation | undefined;
  #latestMark(policy: NativeClearingPolicy, required: boolean): NativeClearingMarkObservation | undefined {
    const row = this.#db.prepare(`
      SELECT observation_hash, policy_hash, observation_json
      FROM native_clearing_marks
      WHERE policy_hash = ?
      ORDER BY source_sequence DESC
      LIMIT 1
    `).get(policy.policyHash) as MarkRow | undefined;
    if (row === undefined) {
      if (required) throw new NativeClearingStoreError('MARK_UNAVAILABLE', 'Native clearing mark is unavailable.');
      return undefined;
    }
    return this.#decodeMark(row, policy);
  }

  #liveMark(policy: NativeClearingPolicy, nowMs: bigint): NativeClearingMarkObservation {
    const mark = this.#latestMark(policy, true);
    if (nowMs < mark.observedAtMs || nowMs > mark.validUntilMs) {
      throw new NativeClearingStoreError('STALE_MARK', 'Native clearing mark is outside its signed validity window.');
    }
    return mark;
  }

  #mark(observationHash: Uint8Array, policy: NativeClearingPolicy): NativeClearingMarkObservation {
    const row = this.#db.prepare(`
      SELECT observation_hash, policy_hash, observation_json
      FROM native_clearing_marks
      WHERE observation_hash = ?
    `).get(observationHash) as MarkRow | undefined;
    if (row === undefined) throw new NativeClearingStoreError('MARK_UNAVAILABLE', 'Auction mark observation is unavailable.');
    return this.#decodeMark(row, policy);
  }

  #decodeMark(row: MarkRow, policy: NativeClearingPolicy): NativeClearingMarkObservation {
    try {
      if (typeof row.observation_json !== 'string') throw new Error('malformed row');
      const mark = nativeClearingMarkObservation(
        parseProtocolJson(row.observation_json) as NativeClearingMarkObservation,
        policy,
      );
      if (!bytesEqual(mark.observationHash, hash(row.observation_hash, 'stored mark hash'))
        || !bytesEqual(mark.policyHash, hash(row.policy_hash, 'stored mark policy hash'))
        || json(mark, 'stored mark') !== row.observation_json) throw new Error('identity mismatch');
      return mark;
    } catch (cause) {
      throw this.#corrupt('Stored native clearing mark failed revalidation.', cause);
    }
  }

  #auctionRecord(auctionId: string): Readonly<{ auction: NativeClearingDefaultAuction; status: 'OPEN' | 'SETTLED' }> {
    const id = protocolId(auctionId, 'native clearing auction id');
    const row = this.#db.prepare('SELECT * FROM native_clearing_default_auctions WHERE auction_id = ?')
      .get(id) as AuctionRow | undefined;
    if (row === undefined) throw new NativeClearingStoreError('AUCTION_NOT_FOUND', 'Native clearing default auction was not found.');
    try {
      if (typeof row.auction_json !== 'string' || (row.status !== 'OPEN' && row.status !== 'SETTLED')) {
        throw new Error('malformed row');
      }
      const auction = parseProtocolJson(row.auction_json) as NativeClearingDefaultAuction;
      const recomputed = nativeClearingDefaultAuctionHash(auction);
      if (auction.auctionId !== id
        || !bytesEqual(auction.auctionHash, recomputed)
        || !bytesEqual(auction.auctionHash, hash(row.auction_hash, 'stored auction hash'))
        || !bytesEqual(auction.policyHash, hash(row.policy_hash, 'stored auction policy hash'))
        || json(auction, 'stored auction') !== row.auction_json) throw new Error('identity mismatch');
      return Object.freeze({ auction, status: row.status });
    } catch (cause) {
      throw this.#corrupt('Stored native clearing default auction failed revalidation.', cause);
    }
  }

  #bids(auction: NativeClearingDefaultAuction): readonly NativeClearingDefaultBid[] {
    const rows = this.#db.prepare(`
      SELECT bid_hash, auction_hash, bid_json
      FROM native_clearing_default_bids
      WHERE auction_hash = ?
      ORDER BY recorded_at_ms, rowid
    `).all(auction.auctionHash) as BidRow[];
    return Object.freeze(rows.map((row) => {
      try {
        if (typeof row.bid_json !== 'string') throw new Error('malformed row');
        const bid = parseProtocolJson(row.bid_json) as NativeClearingDefaultBid;
        const recomputed = nativeClearingDefaultBidHash(bid);
        if (!bytesEqual(bid.bidHash, recomputed)
          || !bytesEqual(bid.bidHash, hash(row.bid_hash, 'stored bid hash'))
          || !bytesEqual(bid.auctionHash, auction.auctionHash)
          || !bytesEqual(bid.auctionHash, hash(row.auction_hash, 'stored bid auction hash'))
          || json(bid, 'stored bid') !== row.bid_json) throw new Error('identity mismatch');
        return bid;
      } catch (cause) {
        throw this.#corrupt('Stored native clearing default bid failed revalidation.', cause);
      }
    }));
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
