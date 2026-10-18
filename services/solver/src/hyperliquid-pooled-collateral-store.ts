import Database from 'better-sqlite3';
import { isAbsolute } from 'node:path';
import { assetRef, domainRef, parseProtocolJson, stringifyProtocolJson, type AssetRef, type DomainRef } from '@naryx/protocol-types';

const ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAX_ATOMS = (1n << 128n) - 1n;

export interface HyperliquidPoolBinding {
  readonly version: 1 | 2 | 3;
  readonly environment: 'TESTNET';
  readonly domain: DomainRef;
  readonly poolAccount: `0x${string}`;
  readonly policyHash: `0x${string}`;
  readonly quoteAsset: AssetRef;
  readonly collateralTokenId: `0x${string}`;
  readonly dedicatedTestOwners: readonly `0x${string}`[];
  readonly maximumTotalQuoteAtoms: bigint;
  readonly maximumOwnerQuoteAtoms?: bigint;
}

export interface HyperliquidPoolMember {
  readonly owner: string;
  readonly balanceQuoteAtoms: bigint;
}

export interface HyperliquidPoolReservation {
  readonly owner: string;
  readonly maximumLossQuoteAtoms: bigint;
  readonly authorizationHash: `0x${string}`;
}

type MemberRow = { owner: string; balance: string };
type OperationRow = { id: string; kind: string; state: string; payload: string; result: string | null };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Pooled collateral: ${message}`);
}

function amount(value: bigint, positive = false): bigint {
  check(typeof value === 'bigint' && value >= (positive ? 1n : 0n) && value <= MAX_ATOMS, 'invalid quote atoms');
  return value;
}

// This store accepts evidence only from its trusted service, never directly from HTTP requests.
export class HyperliquidPooledCollateralStore {
  readonly #db: Database.Database;
  readonly binding: HyperliquidPoolBinding;

  constructor(path: string, binding: HyperliquidPoolBinding) {
    check(path === ':memory:' || isAbsolute(path), 'database path must be absolute');
    check((binding.version === 1 || binding.version === 2 || binding.version === 3) && binding.environment === 'TESTNET'
      && binding.domain.domainId === 'hypercore:testnet' && ADDRESS.test(binding.poolAccount)
      && HASH.test(binding.policyHash) && !/^0x0+$/.test(binding.policyHash)
      && binding.quoteAsset.decimals === 6 && /^0x[0-9a-f]{32}$/.test(binding.collateralTokenId), 'invalid testnet binding');
    amount(binding.maximumTotalQuoteAtoms, true);
    if (binding.version === 3) {
      amount(binding.maximumOwnerQuoteAtoms!, true);
      check(binding.maximumOwnerQuoteAtoms! <= binding.maximumTotalQuoteAtoms, 'owner funding cap exceeds pool cap');
    } else check(binding.maximumOwnerQuoteAtoms === undefined, 'owner cap requires version 3 custody consent');
    check(Array.isArray(binding.dedicatedTestOwners) && (binding.version !== 1 ? binding.dedicatedTestOwners.length === 0 : binding.dedicatedTestOwners.length > 0)
      && binding.dedicatedTestOwners.length <= 64
      && new Set(binding.dedicatedTestOwners).size === binding.dedicatedTestOwners.length
      && binding.dedicatedTestOwners.every(owner => ADDRESS.test(owner) && owner !== binding.poolAccount),
    'pool requires an explicit dedicated test owner allowlist');
    this.binding = Object.freeze({ ...binding,
      dedicatedTestOwners: Object.freeze([...binding.dedicatedTestOwners].sort()),
      quoteAsset: assetRef(binding.quoteAsset.assetId, binding.quoteAsset.assetManifestHash, binding.quoteAsset.decimals),
      domain: domainRef(binding.domain.domainId,
      binding.domain.domainManifestVersion, binding.domain.domainManifestHash) });
    this.#db = new Database(path);
    try {
      this.#db.pragma('journal_mode = WAL');
      this.#db.pragma('synchronous = FULL');
      this.#db.pragma('busy_timeout = 5000');
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS pool_binding (id INTEGER PRIMARY KEY CHECK(id = 1), binding TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS pool_members (owner TEXT PRIMARY KEY, consent TEXT NOT NULL, balance TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS pool_operations (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('DEPOSIT', 'EPOCH', 'WITHDRAWAL')),
          state TEXT NOT NULL CHECK(state IN ('PENDING', 'COMPLETE', 'CANCELLED')), payload TEXT NOT NULL, result TEXT
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS pool_one_pending_operation ON pool_operations(state) WHERE state = 'PENDING';
        CREATE TABLE IF NOT EXISTS pool_transfer_evidence (hash TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE) STRICT;
        CREATE TABLE IF NOT EXISTS pool_epoch_evidence (hash TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE) STRICT;
        CREATE TABLE IF NOT EXISTS pool_epoch_sources (hash TEXT PRIMARY KEY, operation_id TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS pool_epoch_stages (
          operation_id TEXT NOT NULL, stage TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY(operation_id, stage)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS pool_withdrawal_submissions (
          operation_id TEXT PRIMARY KEY, nonce INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('SUBMITTED_UNKNOWN', 'ACKNOWLEDGED'))
        ) STRICT;
      `);
      this.#db.transaction(() => {
        const serialized = stringifyProtocolJson(this.binding);
        const existing = this.#db.prepare('SELECT binding FROM pool_binding WHERE id = 1').get() as { binding: string } | undefined;
        check(existing === undefined || existing.binding === serialized, 'database belongs to another immutable pool binding');
        if (existing === undefined) this.#db.prepare('INSERT INTO pool_binding VALUES (1, ?)').run(serialized);
      }).immediate();
    } catch (error) { this.#db.close(); throw error; }
  }

  close(): void { this.#db.close(); }

  acceptsOwner(owner: string): boolean {
    return ADDRESS.test(owner) && owner !== this.binding.poolAccount
      && (this.binding.version !== 1 || this.binding.dedicatedTestOwners.includes(owner as `0x${string}`));
  }

  members(): readonly HyperliquidPoolMember[] {
    return Object.freeze((this.#db.prepare('SELECT owner, balance FROM pool_members ORDER BY owner').all() as MemberRow[])
      .map(row => Object.freeze({ owner: row.owner, balanceQuoteAtoms: amount(BigInt(row.balance)) })));
  }

  totalQuoteAtoms(): bigint {
    return amount(this.members().reduce((total, row) => total + row.balanceQuoteAtoms, 0n));
  }

  ownerFundingOperations(owner: string): readonly Readonly<{ id: string; kind: string; state: string }>[] {
    check(ADDRESS.test(owner), 'invalid owner');
    return this.#db.prepare("SELECT id, kind, state FROM pool_operations WHERE kind IN ('DEPOSIT', 'WITHDRAWAL') AND json_extract(payload, '$.owner') = ? ORDER BY rowid DESC LIMIT 50")
      .all(owner) as { id: string; kind: string; state: string }[];
  }

  pending(): Readonly<{ id: string; kind: string }> | undefined {
    const row = this.#db.prepare("SELECT id, kind FROM pool_operations WHERE state = 'PENDING'").get() as { id: string; kind: string } | undefined;
    return row === undefined ? undefined : Object.freeze(row);
  }

  operation(id: string): Readonly<{ kind: string; state: string; payload: unknown; result: unknown }> | undefined {
    const row = this.#operation(id);
    return row === undefined ? undefined : Object.freeze({ kind: row.kind, state: row.state,
      payload: parseProtocolJson(row.payload), result: row.result === null ? null : parseProtocolJson(row.result) });
  }

  epochStage(id: string, stage: string): unknown | undefined {
    check(ID.test(id) && ID.test(stage), 'invalid epoch stage identity');
    const row = this.#db.prepare('SELECT payload FROM pool_epoch_stages WHERE operation_id = ? AND stage = ?')
      .get(id, stage) as { payload: string } | undefined;
    return row === undefined ? undefined : parseProtocolJson(row.payload);
  }

  recordEpochStage(id: string, stage: string, value: unknown): void {
    check(ID.test(stage), 'invalid epoch stage');
    const payload = stringifyProtocolJson(value);
    check(payload.length <= 1_048_576, 'epoch stage exceeds size bound');
    this.#db.transaction(() => {
      const operation = this.#operation(id);
      check(operation?.kind === 'EPOCH' && operation.state === 'PENDING', 'epoch is not pending');
      if (stage.startsWith('ENTRY_DISPATCH_')) check(this.epochStage(id, 'RECOVERY_REQUESTED') === undefined,
        'recovery has locked new entry dispatch');
      if (stage === 'ENTRY_RESULT') check(this.epochStage(id, 'RECOVERY_REQUESTED') === undefined,
        'recovery has locked entry allocation');
      if (stage === 'RECOVERY_REQUESTED') check(this.epochStage(id, 'ENTRY_RESULT') === undefined,
        'allocated owner positions require a coordinated close');
      const prior = this.#db.prepare('SELECT payload FROM pool_epoch_stages WHERE operation_id = ? AND stage = ?')
        .get(id, stage) as { payload: string } | undefined;
      check(prior === undefined || prior.payload === payload, 'epoch stage replay changed');
      if (prior === undefined) this.#db.prepare('INSERT INTO pool_epoch_stages VALUES (?, ?, ?)').run(id, stage, payload);
    }).immediate();
  }

  withdrawalSubmission(id: string): Readonly<{ nonce: number; payload: string; state: string }> | undefined {
    check(ID.test(id), 'invalid operation id');
    const row = this.#db.prepare('SELECT nonce, payload, state FROM pool_withdrawal_submissions WHERE operation_id = ?')
      .get(id) as { nonce: number; payload: string; state: string } | undefined;
    return row === undefined ? undefined : Object.freeze(row);
  }

  claimWithdrawalSubmission(id: string, nonce: number, payload: string): boolean {
    check(Number.isSafeInteger(nonce) && nonce > 0 && typeof payload === 'string' && payload.length <= 4_096, 'invalid withdrawal submission');
    return this.#db.transaction(() => {
      const operation = this.#operation(id);
      check(operation?.kind === 'WITHDRAWAL' && operation.state === 'PENDING', 'withdrawal is not pending');
      if (this.withdrawalSubmission(id) !== undefined) return false;
      const request = parseProtocolJson(operation.payload) as { preparedAtMs: number; expiresAtMs: number };
      check(nonce > request.preparedAtMs && nonce <= request.expiresAtMs, 'withdrawal nonce is outside owner authorization');
      this.#db.prepare("INSERT INTO pool_withdrawal_submissions VALUES (?, ?, ?, 'SUBMITTED_UNKNOWN')").run(id, nonce, payload);
      return true;
    }).immediate();
  }

  acknowledgeWithdrawal(id: string): void {
    check(this.withdrawalSubmission(id) !== undefined, 'withdrawal submission was not reserved');
    this.#db.prepare("UPDATE pool_withdrawal_submissions SET state = 'ACKNOWLEDGED' WHERE operation_id = ?").run(id);
  }

  releaseExpiredUnsubmittedWithdrawal(id: string, nowMs: number, verifiedFlatEquityQuoteAtoms: bigint): void {
    amount(verifiedFlatEquityQuoteAtoms);
    check(Number.isSafeInteger(nowMs) && nowMs > 0, 'invalid recovery time');
    this.#db.transaction(() => {
      const row = this.#operation(id);
      check(row?.kind === 'WITHDRAWAL', 'withdrawal does not exist');
      if (row.state === 'CANCELLED') return;
      check(row.state === 'PENDING' && this.withdrawalSubmission(id) === undefined,
        'submitted withdrawals require reconciliation, not expiry release');
      const request = parseProtocolJson(row.payload) as { expiresAtMs: number };
      check(nowMs > request.expiresAtMs && verifiedFlatEquityQuoteAtoms === this.totalQuoteAtoms(),
        'unsubmitted withdrawal must be expired with reconciled backing');
      this.#db.prepare("UPDATE pool_operations SET state = 'CANCELLED', result = ? WHERE id = ?")
        .run(stringifyProtocolJson({ reason: 'EXPIRED_NEVER_SUBMITTED', nowMs, verifiedFlatEquityQuoteAtoms }), id);
    }).immediate();
  }

  #member(owner: string): HyperliquidPoolMember {
    check(ADDRESS.test(owner), 'invalid owner');
    const row = this.#db.prepare('SELECT owner, balance FROM pool_members WHERE owner = ?').get(owner) as MemberRow | undefined;
    check(row !== undefined, 'owner has not consented to pooled custody');
    return { owner, balanceQuoteAtoms: amount(BigInt(row.balance)) };
  }

  #idle(): void { check(this.pending() === undefined, 'unresolved operation locks the pool'); }

  #balance(owner: string, balance: bigint): void {
    this.#db.prepare('UPDATE pool_members SET balance = ? WHERE owner = ?').run(amount(balance).toString(), owner);
  }

  #operation(id: string): OperationRow | undefined {
    check(ID.test(id), 'invalid operation id');
    return this.#db.prepare('SELECT * FROM pool_operations WHERE id = ?').get(id) as OperationRow | undefined;
  }

  #replay(id: string, kind: string, payload: string): OperationRow | undefined {
    const row = this.#operation(id);
    check(row === undefined || row.kind === kind && row.payload === payload, 'operation replay changed its payload');
    return row;
  }

  #evidence(hash: string, id: string): void {
    check(HASH.test(hash) && !/^0x0+$/.test(hash), 'invalid transfer hash');
    this.#db.prepare('INSERT INTO pool_transfer_evidence VALUES (?, ?)').run(hash, id);
  }

  enroll(owner: string, consentHash: string): void {
    check(ADDRESS.test(owner) && owner !== this.binding.poolAccount
      && HASH.test(consentHash) && !/^0x0+$/.test(consentHash), 'invalid custody consent');
    check(this.acceptsOwner(owner), 'owner is not eligible for this pool');
    this.#db.transaction(() => {
      const row = this.#db.prepare('SELECT consent FROM pool_members WHERE owner = ?').get(owner) as { consent: string } | undefined;
      check(row === undefined || row.consent === consentHash, 'custody consent changed');
      if (row !== undefined) return;
      this.#idle();
      check(this.members().length < (this.binding.version !== 1 ? 10_000 : 64), 'owner capacity reached');
      this.#db.prepare('INSERT INTO pool_members VALUES (?, ?, ?)').run(owner, consentHash, '0');
    }).immediate();
  }

  creditDeposit(input: Readonly<{ id: string; owner: string; receivedQuoteAtoms: bigint; transferHash: string }>, verifiedFlatEquityQuoteAtoms: bigint): void {
    amount(input.receivedQuoteAtoms, true);
    amount(verifiedFlatEquityQuoteAtoms);
    const payload = stringifyProtocolJson(input);
    this.#db.transaction(() => {
      if (this.#replay(input.id, 'DEPOSIT', payload) !== undefined) return;
      this.#idle();
      const member = this.#member(input.owner);
      const backed = this.totalQuoteAtoms() + input.receivedQuoteAtoms;
      check(this.binding.version !== 1 ? backed <= verifiedFlatEquityQuoteAtoms : backed === verifiedFlatEquityQuoteAtoms,
        'deposit backing changed before commit');
      check(this.totalQuoteAtoms() + input.receivedQuoteAtoms <= this.binding.maximumTotalQuoteAtoms, 'pool funding cap exceeded');
      if (this.binding.version === 3) check(member.balanceQuoteAtoms + input.receivedQuoteAtoms <= this.binding.maximumOwnerQuoteAtoms!,
        'owner funding cap exceeded');
      this.#evidence(input.transferHash, input.id);
      this.#balance(input.owner, member.balanceQuoteAtoms + input.receivedQuoteAtoms);
      this.#db.prepare("INSERT INTO pool_operations VALUES (?, 'DEPOSIT', 'COMPLETE', ?, NULL)").run(input.id, payload);
    }).immediate();
  }

  reserveEpoch(input: Readonly<{ id: string; reservations: readonly HyperliquidPoolReservation[]; verifiedFlatEquityQuoteAtoms: bigint;
    context?: Readonly<{ planHash: string; plan: string; sourceOrderHashes: readonly string[] }> }>): void {
    amount(input.verifiedFlatEquityQuoteAtoms);
    if (input.context !== undefined) check(HASH.test(input.context.planHash) && !/^0x0+$/.test(input.context.planHash)
      && typeof input.context.plan === 'string' && input.context.plan.length <= 1_048_576
      && Array.isArray(input.context.sourceOrderHashes) && input.context.sourceOrderHashes.length > 0
      && input.context.sourceOrderHashes.length <= 512
      && new Set(input.context.sourceOrderHashes).size === input.context.sourceOrderHashes.length
      && input.context.sourceOrderHashes.every(hash => HASH.test(hash) && !/^0x0+$/.test(hash)), 'invalid epoch plan');
    check(Array.isArray(input.reservations) && input.reservations.length >= 2 && input.reservations.length <= 64
      && new Set(input.reservations.map(row => row.owner)).size === input.reservations.length, 'epoch requires distinct consenting owners');
    const payload = stringifyProtocolJson(input);
    this.#db.transaction(() => {
      if (this.#replay(input.id, 'EPOCH', payload) !== undefined) return;
      this.#idle();
      check(this.totalQuoteAtoms() === input.verifiedFlatEquityQuoteAtoms, 'venue equity differs from customer liabilities');
      check(this.totalQuoteAtoms() <= this.binding.maximumTotalQuoteAtoms, 'pool exceeds the new-entry cap');
      for (const row of input.reservations) {
        amount(row.maximumLossQuoteAtoms, true);
        check(HASH.test(row.authorizationHash) && !/^0x0+$/.test(row.authorizationHash), 'missing owner epoch authorization');
        check(row.maximumLossQuoteAtoms <= this.#member(row.owner).balanceQuoteAtoms, 'owner loss reservation exceeds funded balance');
        if (this.binding.version === 3) check(row.maximumLossQuoteAtoms <= this.binding.maximumOwnerQuoteAtoms!, 'owner loss reservation exceeds risk cap');
      }
      for (const hash of input.context?.sourceOrderHashes ?? []) {
        this.#db.prepare('INSERT INTO pool_epoch_sources VALUES (?, ?)').run(hash, input.id);
      }
      this.#db.prepare("INSERT INTO pool_operations VALUES (?, 'EPOCH', 'PENDING', ?, NULL)").run(input.id, payload);
    }).immediate();
  }

  settleEpoch(input: Readonly<{ id: string; allocations: readonly { owner: string; pnlQuoteAtoms: bigint }[];
    verifiedFlatEquityQuoteAtoms: bigint; evidenceHash: string }>): void {
    amount(input.verifiedFlatEquityQuoteAtoms);
    check(HASH.test(input.evidenceHash) && !/^0x0+$/.test(input.evidenceHash), 'missing epoch evidence');
    const result = stringifyProtocolJson(input);
    this.#db.transaction(() => {
      const row = this.#operation(input.id);
      check(row?.kind === 'EPOCH', 'epoch does not exist');
      if (row.state === 'COMPLETE') { check(row.result === result, 'epoch settlement replay changed'); return; }
      const reservations = this.#decodeReservations(row.payload);
      check(reservations.length === input.allocations.length
        && new Set(input.allocations.map(allocation => allocation.owner)).size === input.allocations.length, 'settlement must cover each owner exactly once');
      for (const allocation of input.allocations) {
        const reservation = reservations.find(candidate => candidate.owner === allocation.owner);
        check(reservation !== undefined && typeof allocation.pnlQuoteAtoms === 'bigint'
          && allocation.pnlQuoteAtoms >= -reservation.maximumLossQuoteAtoms
          && allocation.pnlQuoteAtoms <= MAX_ATOMS, 'settlement exceeds owner authority');
        this.#balance(allocation.owner, this.#member(allocation.owner).balanceQuoteAtoms + allocation.pnlQuoteAtoms);
      }
      check(this.totalQuoteAtoms() === input.verifiedFlatEquityQuoteAtoms, 'settlement does not conserve venue equity');
      this.#db.prepare('INSERT INTO pool_epoch_evidence VALUES (?, ?)').run(input.evidenceHash, input.id);
      this.#db.prepare("UPDATE pool_operations SET state = 'COMPLETE', result = ? WHERE id = ?").run(result, input.id);
    }).immediate();
  }

  #decodeReservations(payload: string): readonly HyperliquidPoolReservation[] {
    return (parseProtocolJson(payload) as { reservations: HyperliquidPoolReservation[] }).reservations;
  }

  prepareWithdrawal(input: Readonly<{ id: string; owner: string; debitQuoteAtoms: bigint;
    authorizationHash: string; verifiedFlatEquityQuoteAtoms: bigint; preparedAtMs: number; expiresAtMs: number }>): void {
    amount(input.debitQuoteAtoms, true);
    amount(input.verifiedFlatEquityQuoteAtoms);
    check(HASH.test(input.authorizationHash) && !/^0x0+$/.test(input.authorizationHash), 'missing withdrawal authority');
    check(Number.isSafeInteger(input.preparedAtMs) && input.preparedAtMs > 0
      && Number.isSafeInteger(input.expiresAtMs) && input.expiresAtMs > input.preparedAtMs
      && input.expiresAtMs - input.preparedAtMs <= 600_000, 'invalid withdrawal authorization window');
    const payload = stringifyProtocolJson(input);
    this.#db.transaction(() => {
      if (this.#replay(input.id, 'WITHDRAWAL', payload) !== undefined) return;
      this.#idle();
      check(this.totalQuoteAtoms() === input.verifiedFlatEquityQuoteAtoms, 'withdrawal equity is not reconciled');
      check(this.#member(input.owner).balanceQuoteAtoms >= input.debitQuoteAtoms, 'insufficient owner balance');
      this.#db.prepare("INSERT INTO pool_operations VALUES (?, 'WITHDRAWAL', 'PENDING', ?, NULL)").run(input.id, payload);
    }).immediate();
  }

  completeWithdrawal(input: Readonly<{ id: string; transferHash: string; verifiedFlatEquityQuoteAtoms: bigint }>): void {
    amount(input.verifiedFlatEquityQuoteAtoms);
    const result = stringifyProtocolJson(input);
    this.#db.transaction(() => {
      const row = this.#operation(input.id);
      check(row?.kind === 'WITHDRAWAL', 'withdrawal does not exist');
      if (row.state === 'COMPLETE') { check(row.result === result, 'withdrawal settlement replay changed'); return; }
      check(row.state === 'PENDING', 'cancelled withdrawal cannot settle');
      const withdrawal = parseProtocolJson(row.payload) as { owner: string; debitQuoteAtoms: bigint };
      check(this.totalQuoteAtoms() - withdrawal.debitQuoteAtoms === input.verifiedFlatEquityQuoteAtoms, 'withdrawal does not conserve venue equity');
      this.#evidence(input.transferHash, input.id);
      this.#balance(withdrawal.owner, this.#member(withdrawal.owner).balanceQuoteAtoms - withdrawal.debitQuoteAtoms);
      this.#db.prepare("UPDATE pool_operations SET state = 'COMPLETE', result = ? WHERE id = ?").run(result, input.id);
    }).immediate();
  }
}
