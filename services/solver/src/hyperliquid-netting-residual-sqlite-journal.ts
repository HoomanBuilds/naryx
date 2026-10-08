import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import type {
  HypercoreBatchedOrderAction,
  HypercoreOrderWire,
  HyperliquidNettingResidualPlan,
} from '@naryx/adapter-hyperliquid';
import type { CommitmentHash, DomainRef } from '@naryx/protocol-types';
import type {
  HyperliquidJournalStatus,
  HyperliquidSubmissionAccount,
} from './index.js';

const SCHEMA_VERSION = 1;
const ACTION_COMMITMENT_SCHEME = 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1' as const;
const RECORD_COMMITMENT_SCHEME = 'naryx/hypercore/netting-residual-submission-record/v1';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const CLOID = /^0x[0-9a-f]{32}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const DECIMAL_VALUE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

interface MetadataRow {
  readonly schema_version: number;
  readonly journal_revision: string;
}

interface AttemptRow {
  readonly attempt_id: string;
  readonly master_account: string;
  readonly trading_account: string;
  readonly account_kind: string;
  readonly agent_wallet: string;
  readonly signer_lease_id: string;
  readonly nonce_decimal: string;
  readonly expiry_decimal: string;
  readonly vault_address: string | null;
  readonly action_json: string;
  readonly action_hash: string;
  readonly record_hash: string;
  readonly client_order_id: string;
  readonly domain_id: string;
  readonly domain_manifest_version: number;
  readonly domain_manifest_hash: Buffer;
  readonly intent_hash: Buffer;
  readonly instrument_hash: Buffer;
  readonly status: string;
  readonly revision_decimal: string;
  readonly durable_revision: string | null;
  readonly acknowledgement_id: string | null;
  readonly rejection_id: string | null;
  readonly created_at_ms_decimal: string;
  readonly updated_at_ms_decimal: string;
}

interface NonceRow {
  readonly highest_nonce_decimal: string;
}

interface AgentRow {
  readonly signer_lease_id: string;
}

interface LeaseRow {
  readonly agent_wallet: string;
}

export interface HyperliquidNettingResidualJournalRecord {
  readonly attemptId: string;
  readonly status: HyperliquidJournalStatus;
  readonly account: HyperliquidSubmissionAccount;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly nonce: bigint;
  readonly expiresAfterMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
  readonly action: HypercoreBatchedOrderAction;
  readonly actionCommitmentScheme: typeof ACTION_COMMITMENT_SCHEME;
  readonly actionHash: `0x${string}`;
  readonly recordHash: `0x${string}`;
  readonly clientOrderId: `0x${string}`;
  readonly domain: DomainRef;
  readonly intentHash: CommitmentHash;
  readonly instrumentHash: CommitmentHash;
  readonly durableRevision: string | null;
}

export interface HyperliquidNettingResidualJournalReceipt {
  readonly journalVersion: bigint;
  readonly record: HyperliquidNettingResidualJournalRecord;
}

export interface HyperliquidNettingResidualJournalPrepareInput {
  readonly expectedVersion: bigint;
  readonly attemptId: string;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly plan: HyperliquidNettingResidualPlan;
  readonly account: HyperliquidSubmissionAccount;
  readonly nonce: bigint;
  readonly nowMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
}

export interface HyperliquidNettingResidualDurableJournalPort {
  submissionContext(input: Readonly<{
    account: HyperliquidSubmissionAccount;
    agentWallet: `0x${string}`;
    signerLeaseId: string;
    nowMs: bigint;
  }>): Readonly<{ expectedVersion: bigint; nonce: bigint }>;
  prepare(input: HyperliquidNettingResidualJournalPrepareInput):
  Promise<HyperliquidNettingResidualJournalReceipt>;
  confirmDurable(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    recordHash: `0x${string}`;
  }>): Promise<HyperliquidNettingResidualJournalReceipt>;
  markSubmittedUnknown(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    nowMs: bigint;
  }>): Promise<HyperliquidNettingResidualJournalReceipt>;
  acknowledge(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    acknowledgementId: string;
  }>): Promise<HyperliquidNettingResidualJournalReceipt>;
  reject(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    rejectionId: string;
  }>): Promise<HyperliquidNettingResidualJournalReceipt>;
  beginReconciliation(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
  }>): Promise<HyperliquidNettingResidualJournalReceipt>;
  readAttempt(attemptId: string): Promise<HyperliquidNettingResidualJournalReceipt | null>;
}

interface NormalizedPrepare {
  readonly attemptId: string;
  readonly account: HyperliquidSubmissionAccount;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly nonce: bigint;
  readonly expiresAfterMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
  readonly action: HypercoreBatchedOrderAction;
  readonly actionHash: `0x${string}`;
  readonly recordHash: `0x${string}`;
  readonly clientOrderId: `0x${string}`;
  readonly domain: DomainRef;
  readonly intentHash: CommitmentHash;
  readonly instrumentHash: CommitmentHash;
  readonly nowMs: bigint;
}

export interface HyperliquidNettingResidualSqliteJournalOptions {
  readonly databasePath: string;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function identifier(value: unknown, name: string): string {
  requireCondition(typeof value === 'string' && IDENTIFIER.test(value), `${name} is invalid`);
  return value;
}

function address(value: unknown, name: string): `0x${string}` {
  requireCondition(typeof value === 'string', `${name} must be an address`);
  const normalized = value.toLowerCase();
  requireCondition(ADDRESS.test(normalized), `${name} must be a 20-byte address`);
  return normalized as `0x${string}`;
}

function clientOrderId(value: unknown, name: string): `0x${string}` {
  requireCondition(typeof value === 'string', `${name} must be a client order ID`);
  const normalized = value.toLowerCase();
  requireCondition(CLOID.test(normalized), `${name} must be a 16-byte client order ID`);
  return normalized as `0x${string}`;
}

function canonicalBigint(value: bigint, name: string, allowZero = false): string {
  requireCondition(typeof value === 'bigint' && (allowZero ? value >= 0n : value > 0n),
    `${name} must be ${allowZero ? 'nonnegative' : 'positive'}`);
  return value.toString();
}

function decodedBigint(value: unknown, name: string, allowZero = false): bigint {
  requireCondition(typeof value === 'string' && DECIMAL_INTEGER.test(value),
    `${name} is not canonical integer text`);
  const decoded = BigInt(value);
  requireCondition((allowZero ? decoded >= 0n : decoded > 0n) && decoded.toString() === value,
    `${name} is invalid`);
  return decoded;
}

function canonicalDecimal(value: unknown, name: string): string {
  requireCondition(typeof value === 'string' && DECIMAL_VALUE.test(value)
    && !/^0(?:\.0+)?$/.test(value), `${name} must be positive canonical decimal text`);
  return value;
}

function bytes32(value: unknown, name: string): Uint8Array {
  requireCondition(value instanceof Uint8Array && value.length === 32
    && value.some((byte) => byte !== 0), `${name} must be a nonzero 32-byte value`);
  return Uint8Array.from(value);
}

function canonicalOrder(value: unknown): HypercoreOrderWire {
  requireCondition(typeof value === 'object' && value !== null, 'order must be an object');
  const order = value as Record<string, unknown>;
  const type = order.t as { readonly limit?: { readonly tif?: unknown } } | undefined;
  requireCondition(Number.isSafeInteger(order.a) && Number(order.a) >= 0
    && Number(order.a) <= 0xffff_ffff && typeof order.b === 'boolean'
    && typeof order.r === 'boolean' && type?.limit?.tif === 'Ioc',
  'order must be a bounded IOC order');
  return Object.freeze({
    a: Number(order.a),
    b: order.b,
    p: canonicalDecimal(order.p, 'order.p'),
    s: canonicalDecimal(order.s, 'order.s'),
    r: order.r,
    t: Object.freeze({ limit: Object.freeze({ tif: 'Ioc' as const }) }),
    c: clientOrderId(order.c, 'order.c'),
  });
}

function canonicalAction(value: unknown): HypercoreBatchedOrderAction {
  requireCondition(typeof value === 'object' && value !== null, 'action must be an object');
  const action = value as Record<string, unknown>;
  requireCondition(action.type === 'order' && action.grouping === 'na'
    && Array.isArray(action.orders) && action.orders.length === 1,
  'residual action must contain exactly one ungrouped IOC order');
  return Object.freeze({
    type: 'order',
    grouping: 'na',
    orders: Object.freeze([canonicalOrder(action.orders[0])]),
  });
}

function actionJson(action: HypercoreBatchedOrderAction): string {
  return JSON.stringify(action);
}

function sha256(value: string): `0x${string}` {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function actionCommitment(action: HypercoreBatchedOrderAction): `0x${string}` {
  const order = action.orders[0]!;
  return sha256(JSON.stringify([ACTION_COMMITMENT_SCHEME, action.type,
    [[order.a, order.b, order.p, order.s, order.r, order.t.limit.tif, order.c]],
    action.grouping]));
}

function normalizedAccount(input: HyperliquidSubmissionAccount): HyperliquidSubmissionAccount {
  requireCondition(input.accountKind === 'MASTER' || input.accountKind === 'SUBACCOUNT',
    'account kind is unsupported');
  const masterAccount = address(input.masterAccount, 'masterAccount');
  const tradingAccount = address(input.tradingAccount, 'tradingAccount');
  requireCondition(input.accountKind === 'MASTER'
    ? masterAccount === tradingAccount
    : masterAccount !== tradingAccount, 'account relation is invalid');
  return Object.freeze({ masterAccount, tradingAccount, accountKind: input.accountKind });
}

function recordCommitment(input: Omit<NormalizedPrepare, 'recordHash' | 'nowMs'>): `0x${string}` {
  return sha256(JSON.stringify([
    RECORD_COMMITMENT_SCHEME,
    input.attemptId,
    input.account.masterAccount,
    input.account.tradingAccount,
    input.account.accountKind,
    input.agentWallet,
    input.signerLeaseId,
    input.nonce.toString(),
    input.expiresAfterMs.toString(),
    input.vaultAddress,
    input.actionHash,
    input.clientOrderId,
    input.domain.domainId,
    input.domain.domainManifestVersion,
    Buffer.from(input.domain.domainManifestHash).toString('hex'),
    Buffer.from(input.intentHash).toString('hex'),
    Buffer.from(input.instrumentHash).toString('hex'),
  ]));
}

function normalizedPrepare(input: HyperliquidNettingResidualJournalPrepareInput): NormalizedPrepare {
  const attemptId = identifier(input.attemptId, 'attemptId');
  const signerLeaseId = identifier(input.signerLeaseId, 'signerLeaseId');
  requireCondition(input.expectedVersion >= 0n, 'expectedVersion must be nonnegative');
  const account = normalizedAccount(input.account);
  const agentWallet = address(input.agentWallet, 'agentWallet');
  requireCondition(agentWallet !== account.masterAccount && agentWallet !== account.tradingAccount,
    'agent wallet must differ from account identities');
  const nonce = BigInt(canonicalBigint(input.nonce, 'nonce'));
  const nowMs = BigInt(canonicalBigint(input.nowMs, 'nowMs'));
  requireCondition(nonce <= MAX_SAFE_INTEGER, 'nonce must fit a safe integer');
  const plan = input.plan;
  requireCondition(plan.version === 1 && plan.guarantee === 'SINGLE_IOC_WITH_TERMINAL_EVIDENCE'
    && plan.domain.domainId === 'hypercore:testnet', 'only current Hyperliquid Testnet residual plans are supported');
  const domain = Object.freeze({
    domainId: plan.domain.domainId,
    domainManifestVersion: plan.domain.domainManifestVersion,
    domainManifestHash: bytes32(plan.domain.domainManifestHash, 'domainManifestHash'),
  }) as DomainRef;
  requireCondition(Number.isSafeInteger(domain.domainManifestVersion)
    && domain.domainManifestVersion > 0, 'domain manifest version is invalid');
  const intentHash = bytes32(plan.intentHash, 'intentHash') as CommitmentHash;
  const instrumentHash = bytes32(plan.instrumentHash, 'instrumentHash') as CommitmentHash;
  const expiresAfterMs = BigInt(canonicalBigint(plan.requestExpiryMs, 'requestExpiryMs'));
  requireCondition(expiresAfterMs <= MAX_SAFE_INTEGER && expiresAfterMs > nowMs && expiresAfterMs > nonce,
    'request expiry is invalid or stale');
  const vaultAddress = input.vaultAddress === null ? null : address(input.vaultAddress, 'vaultAddress');
  requireCondition(account.accountKind === 'MASTER'
    ? vaultAddress === null
    : vaultAddress === account.tradingAccount, 'vault context does not match the trading account');
  const action = canonicalAction(plan.action);
  const planClientOrderId = clientOrderId(plan.clientOrderId, 'plan.clientOrderId');
  requireCondition(action.orders[0]!.c === planClientOrderId
    && JSON.stringify(action.orders[0]) === JSON.stringify(plan.order),
  'residual plan action does not bind the planned order');
  const immutable = {
    attemptId,
    account,
    agentWallet,
    signerLeaseId,
    nonce,
    expiresAfterMs,
    vaultAddress,
    action,
    actionHash: actionCommitment(action),
    clientOrderId: planClientOrderId,
    domain,
    intentHash,
    instrumentHash,
  };
  return Object.freeze({ ...immutable, recordHash: recordCommitment(immutable), nowMs });
}

function rowStatus(value: string): HyperliquidJournalStatus {
  requireCondition(value === 'PREPARED' || value === 'DURABLE_RECORD_CONFIRMED'
    || value === 'SUBMITTED_UNKNOWN' || value === 'ACKNOWLEDGED'
    || value === 'REJECTED' || value === 'RECONCILING', 'stored journal status is invalid');
  return value;
}

function hashValue(value: string, name: string): `0x${string}` {
  requireCondition(HASH.test(value), `${name} must be a hash`);
  return value as `0x${string}`;
}

function decodeRow(row: AttemptRow): Readonly<{
  revision: bigint;
  record: HyperliquidNettingResidualJournalRecord;
}> {
  const account = normalizedAccount({
    masterAccount: address(row.master_account, 'stored masterAccount'),
    tradingAccount: address(row.trading_account, 'stored tradingAccount'),
    accountKind: row.account_kind as HyperliquidSubmissionAccount['accountKind'],
  });
  const action = canonicalAction(JSON.parse(row.action_json));
  requireCondition(actionJson(action) === row.action_json, 'stored action is not canonical');
  const domain = Object.freeze({
    domainId: row.domain_id,
    domainManifestVersion: row.domain_manifest_version,
    domainManifestHash: bytes32(row.domain_manifest_hash, 'stored domainManifestHash'),
  }) as DomainRef;
  requireCondition(domain.domainId === 'hypercore:testnet'
    && Number.isSafeInteger(domain.domainManifestVersion) && domain.domainManifestVersion > 0,
  'stored domain is unsupported');
  const immutable = {
    attemptId: identifier(row.attempt_id, 'stored attemptId'),
    account,
    agentWallet: address(row.agent_wallet, 'stored agentWallet'),
    signerLeaseId: identifier(row.signer_lease_id, 'stored signerLeaseId'),
    nonce: decodedBigint(row.nonce_decimal, 'stored nonce'),
    expiresAfterMs: decodedBigint(row.expiry_decimal, 'stored expiry'),
    vaultAddress: row.vault_address === null ? null : address(row.vault_address, 'stored vaultAddress'),
    action,
    actionHash: hashValue(row.action_hash, 'stored actionHash'),
    clientOrderId: clientOrderId(row.client_order_id, 'stored clientOrderId'),
    domain,
    intentHash: bytes32(row.intent_hash, 'stored intentHash') as CommitmentHash,
    instrumentHash: bytes32(row.instrument_hash, 'stored instrumentHash') as CommitmentHash,
  };
  requireCondition(action.orders[0]!.c === immutable.clientOrderId
    && immutable.actionHash === actionCommitment(action)
    && hashValue(row.record_hash, 'stored recordHash') === recordCommitment(immutable),
  'stored record commitment does not match');
  const durableRevision = row.durable_revision === null
    ? null : identifier(row.durable_revision, 'stored durableRevision');
  const status = rowStatus(row.status);
  requireCondition((status === 'PREPARED') === (durableRevision === null),
    'stored durable revision does not match status');
  return Object.freeze({
    revision: decodedBigint(row.revision_decimal, 'stored revision'),
    record: Object.freeze({
      attemptId: immutable.attemptId,
      status,
      account,
      agentWallet: immutable.agentWallet,
      signerLeaseId: immutable.signerLeaseId,
      nonce: immutable.nonce,
      expiresAfterMs: immutable.expiresAfterMs,
      vaultAddress: immutable.vaultAddress,
      action,
      actionCommitmentScheme: ACTION_COMMITMENT_SCHEME,
      actionHash: immutable.actionHash,
      recordHash: hashValue(row.record_hash, 'stored recordHash'),
      clientOrderId: immutable.clientOrderId,
      domain,
      intentHash: immutable.intentHash,
      instrumentHash: immutable.instrumentHash,
      durableRevision,
    }),
  });
}

function timestampNow(): bigint {
  return BigInt(Date.now());
}

export class HyperliquidNettingResidualSqliteDurableJournal
implements HyperliquidNettingResidualDurableJournalPort {
  readonly databasePath: string;
  readonly #database: Database.Database;
  #closed = false;

  constructor(options: HyperliquidNettingResidualSqliteJournalOptions) {
    requireCondition(typeof options?.databasePath === 'string' && options.databasePath.length > 0
      && options.databasePath !== ':memory:' && !options.databasePath.startsWith('file:')
      && isAbsolute(options.databasePath), 'databasePath must be an explicit absolute filesystem path');
    const databasePath = resolve(options.databasePath);
    const projectRelativePath = relative(resolve(process.cwd()), databasePath);
    requireCondition(projectRelativePath === '..' || projectRelativePath.startsWith(`..${sep}`)
      || isAbsolute(projectRelativePath), 'databasePath must be outside the current project directory');
    this.databasePath = databasePath;
    this.#database = new Database(databasePath, { timeout: 5_000 });
    try {
      const journalMode = this.#database.pragma('journal_mode = WAL', { simple: true });
      requireCondition(String(journalMode).toLowerCase() === 'wal', 'SQLite journal mode is not WAL');
      this.#database.pragma('synchronous = FULL');
      this.#database.pragma('foreign_keys = ON');
      this.#database.pragma('trusted_schema = OFF');
      this.#initializeSchema();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  submissionContext(input: Readonly<{
    account: HyperliquidSubmissionAccount;
    agentWallet: `0x${string}`;
    signerLeaseId: string;
    nowMs: bigint;
  }>): Readonly<{ expectedVersion: bigint; nonce: bigint }> {
    this.#requireOpen();
    const account = normalizedAccount(input.account);
    const agentWallet = address(input.agentWallet, 'agentWallet');
    const signerLeaseId = identifier(input.signerLeaseId, 'signerLeaseId');
    const nowMs = decodedBigint(canonicalBigint(input.nowMs, 'nowMs'), 'nowMs');
    const row = this.#database.prepare<[string, string, string, string, string], NonceRow>(`
      SELECT highest_nonce_decimal FROM hyperliquid_nonce_fences
      WHERE master_account = ? AND trading_account = ? AND account_kind = ?
        AND agent_wallet = ? AND signer_lease_id = ?
    `).get(account.masterAccount, account.tradingAccount, account.accountKind, agentWallet, signerLeaseId);
    const previous = row === undefined ? 0n : decodedBigint(row.highest_nonce_decimal, 'stored nonce high-water');
    const nonce = nowMs > previous ? nowMs : previous + 1n;
    requireCondition(nonce <= MAX_SAFE_INTEGER, 'allocated nonce must fit a safe integer');
    return Object.freeze({ expectedVersion: this.#metadata().journalRevision, nonce });
  }

  async prepare(input: HyperliquidNettingResidualJournalPrepareInput):
  Promise<HyperliquidNettingResidualJournalReceipt> {
    this.#requireOpen();
    const normalized = normalizedPrepare(input);
    const transaction = this.#database.transaction(() => {
      const existing = this.#attemptRow(normalized.attemptId);
      if (existing !== undefined) {
        requireCondition(decodeRow(existing).record.recordHash === normalized.recordHash,
          'residual submission replay changed its immutable binding');
        return;
      }
      const metadata = this.#metadata();
      requireCondition(metadata.journalRevision === input.expectedVersion,
        'journal compare-and-set version mismatch');
      this.#requireSignerLease(normalized.agentWallet, normalized.signerLeaseId, normalized.nowMs);
      const nonceRow = this.#nonceRow(normalized);
      if (nonceRow !== undefined) {
        requireCondition(normalized.nonce > decodedBigint(nonceRow.highest_nonce_decimal,
          'stored nonce high-water'), 'nonce must strictly increase for the account and signer lease');
      }
      const nextRevision = metadata.journalRevision + 1n;
      this.#insertAttempt(normalized, nextRevision);
      this.#advanceNonce(normalized, nonceRow);
      this.#advanceRevision(metadata.journalRevision, nextRevision);
    });
    transaction.immediate();
    return this.#requiredReceipt(normalized.attemptId);
  }

  confirmDurable(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    recordHash: `0x${string}`;
  }>): Promise<HyperliquidNettingResidualJournalReceipt> {
    const expectedRecordHash = hashValue(input.recordHash, 'recordHash');
    return this.#transition(identifier(input.attemptId, 'attemptId'), input.expectedVersion,
      'DURABLE_RECORD_CONFIRMED', ['PREPARED'], {
        validate: (record) => requireCondition(record.recordHash === expectedRecordHash,
          'durable record hash mismatch'),
        durableRevision: true,
      });
  }

  markSubmittedUnknown(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    nowMs: bigint;
  }>): Promise<HyperliquidNettingResidualJournalReceipt> {
    return this.#transition(identifier(input.attemptId, 'attemptId'), input.expectedVersion,
      'SUBMITTED_UNKNOWN', ['DURABLE_RECORD_CONFIRMED'], { timestamp: input.nowMs });
  }

  acknowledge(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    acknowledgementId: string;
  }>): Promise<HyperliquidNettingResidualJournalReceipt> {
    return this.#transition(identifier(input.attemptId, 'attemptId'), input.expectedVersion,
      'ACKNOWLEDGED', ['SUBMITTED_UNKNOWN'], {
        acknowledgementId: identifier(input.acknowledgementId, 'acknowledgementId'),
      });
  }

  reject(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    rejectionId: string;
  }>): Promise<HyperliquidNettingResidualJournalReceipt> {
    return this.#transition(identifier(input.attemptId, 'attemptId'), input.expectedVersion,
      'REJECTED', ['SUBMITTED_UNKNOWN'], {
        rejectionId: identifier(input.rejectionId, 'rejectionId'),
      });
  }

  beginReconciliation(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
  }>): Promise<HyperliquidNettingResidualJournalReceipt> {
    return this.#transition(identifier(input.attemptId, 'attemptId'), input.expectedVersion,
      'RECONCILING', ['SUBMITTED_UNKNOWN', 'ACKNOWLEDGED', 'REJECTED']);
  }

  async readAttempt(attemptId: string): Promise<HyperliquidNettingResidualJournalReceipt | null> {
    this.#requireOpen();
    const row = this.#attemptRow(identifier(attemptId, 'attemptId'));
    return row === undefined ? null : this.#receipt(row);
  }

  async listUnresolvedSubmissions(): Promise<readonly HyperliquidNettingResidualJournalReceipt[]> {
    this.#requireOpen();
    const rows = this.#database.prepare<[], AttemptRow>(`
      SELECT * FROM hyperliquid_netting_residual_submission_attempts
      WHERE status IN ('PREPARED', 'DURABLE_RECORD_CONFIRMED', 'SUBMITTED_UNKNOWN', 'RECONCILING')
      ORDER BY length(created_at_ms_decimal), created_at_ms_decimal, attempt_id
    `).all();
    return Object.freeze(rows.map((row) => this.#receipt(row)));
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #initializeSchema(): void {
    const baseTables = this.#database.prepare<[], { readonly count: number }>(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN ('hyperliquid_signer_agents', 'hyperliquid_nonce_fences')
    `).get();
    requireCondition(baseTables?.count === 2,
      'base Hyperliquid journal must initialize the shared signer and nonce fences first');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS hyperliquid_netting_residual_journal_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        journal_revision TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS hyperliquid_netting_residual_submission_attempts (
        attempt_id TEXT PRIMARY KEY,
        master_account TEXT NOT NULL,
        trading_account TEXT NOT NULL,
        account_kind TEXT NOT NULL CHECK (account_kind IN ('MASTER', 'SUBACCOUNT')),
        agent_wallet TEXT NOT NULL,
        signer_lease_id TEXT NOT NULL,
        nonce_decimal TEXT NOT NULL,
        expiry_decimal TEXT NOT NULL,
        vault_address TEXT,
        action_json TEXT NOT NULL,
        action_hash TEXT NOT NULL,
        record_hash TEXT NOT NULL,
        client_order_id TEXT NOT NULL UNIQUE,
        domain_id TEXT NOT NULL,
        domain_manifest_version INTEGER NOT NULL,
        domain_manifest_hash BLOB NOT NULL,
        intent_hash BLOB NOT NULL UNIQUE,
        instrument_hash BLOB NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'PREPARED', 'DURABLE_RECORD_CONFIRMED', 'SUBMITTED_UNKNOWN',
          'ACKNOWLEDGED', 'REJECTED', 'RECONCILING'
        )),
        revision_decimal TEXT NOT NULL,
        durable_revision TEXT,
        acknowledgement_id TEXT,
        rejection_id TEXT,
        created_at_ms_decimal TEXT NOT NULL,
        updated_at_ms_decimal TEXT NOT NULL,
        UNIQUE (master_account, trading_account, account_kind, agent_wallet, signer_lease_id, nonce_decimal),
        FOREIGN KEY (agent_wallet) REFERENCES hyperliquid_signer_agents(agent_wallet)
      ) STRICT;

      CREATE TRIGGER IF NOT EXISTS hyperliquid_netting_residual_attempt_immutable_update
      BEFORE UPDATE ON hyperliquid_netting_residual_submission_attempts
      WHEN NEW.attempt_id IS NOT OLD.attempt_id
        OR NEW.master_account IS NOT OLD.master_account
        OR NEW.trading_account IS NOT OLD.trading_account
        OR NEW.account_kind IS NOT OLD.account_kind
        OR NEW.agent_wallet IS NOT OLD.agent_wallet
        OR NEW.signer_lease_id IS NOT OLD.signer_lease_id
        OR NEW.nonce_decimal IS NOT OLD.nonce_decimal
        OR NEW.expiry_decimal IS NOT OLD.expiry_decimal
        OR NEW.vault_address IS NOT OLD.vault_address
        OR NEW.action_json IS NOT OLD.action_json
        OR NEW.action_hash IS NOT OLD.action_hash
        OR NEW.record_hash IS NOT OLD.record_hash
        OR NEW.client_order_id IS NOT OLD.client_order_id
        OR NEW.domain_id IS NOT OLD.domain_id
        OR NEW.domain_manifest_version IS NOT OLD.domain_manifest_version
        OR NEW.domain_manifest_hash IS NOT OLD.domain_manifest_hash
        OR NEW.intent_hash IS NOT OLD.intent_hash
        OR NEW.instrument_hash IS NOT OLD.instrument_hash
        OR NEW.created_at_ms_decimal IS NOT OLD.created_at_ms_decimal
      BEGIN SELECT RAISE(ABORT, 'immutable Hyperliquid residual attempt field changed'); END;

      CREATE TRIGGER IF NOT EXISTS hyperliquid_netting_residual_attempt_no_delete
      BEFORE DELETE ON hyperliquid_netting_residual_submission_attempts
      BEGIN SELECT RAISE(ABORT, 'Hyperliquid residual attempts cannot be deleted'); END;
    `);
    const metadata = this.#database.prepare<[], MetadataRow>(`
      SELECT schema_version, journal_revision
      FROM hyperliquid_netting_residual_journal_metadata WHERE singleton = 1
    `).get();
    if (metadata === undefined) {
      this.#database.prepare(`
        INSERT INTO hyperliquid_netting_residual_journal_metadata
          (singleton, schema_version, journal_revision) VALUES (1, ?, '0')
      `).run(SCHEMA_VERSION);
    } else {
      requireCondition(metadata.schema_version === SCHEMA_VERSION,
        `unsupported Hyperliquid residual journal schema version ${metadata.schema_version}`);
    }
  }

  #requireOpen(): void {
    requireCondition(!this.#closed && this.#database.open, 'Hyperliquid residual journal is closed');
  }

  #metadata(): { readonly journalRevision: bigint } {
    const row = this.#database.prepare<[], MetadataRow>(`
      SELECT schema_version, journal_revision
      FROM hyperliquid_netting_residual_journal_metadata WHERE singleton = 1
    `).get();
    requireCondition(row !== undefined && row.schema_version === SCHEMA_VERSION,
      'Hyperliquid residual journal metadata is missing or invalid');
    return Object.freeze({ journalRevision: decodedBigint(row.journal_revision, 'journalRevision', true) });
  }

  #advanceRevision(previous: bigint, next: bigint): void {
    requireCondition(next === previous + 1n, 'journal revision increment is invalid');
    const update = this.#database.prepare(`
      UPDATE hyperliquid_netting_residual_journal_metadata SET journal_revision = ?
      WHERE singleton = 1 AND journal_revision = ?
    `).run(canonicalBigint(next, 'nextRevision', true),
      canonicalBigint(previous, 'previousRevision', true));
    requireCondition(update.changes === 1, 'journal revision compare-and-set failed');
  }

  #attemptRow(attemptId: string): AttemptRow | undefined {
    return this.#database.prepare<[string], AttemptRow>(`
      SELECT * FROM hyperliquid_netting_residual_submission_attempts WHERE attempt_id = ?
    `).get(attemptId);
  }

  #requiredReceipt(attemptId: string): HyperliquidNettingResidualJournalReceipt {
    const row = this.#attemptRow(attemptId);
    requireCondition(row !== undefined, 'residual submission identity is unknown');
    return this.#receipt(row);
  }

  #receipt(row: AttemptRow): HyperliquidNettingResidualJournalReceipt {
    const decoded = decodeRow(row);
    const journalVersion = this.#metadata().journalRevision;
    requireCondition(decoded.revision <= journalVersion, 'attempt revision exceeds journal revision');
    return Object.freeze({ journalVersion, record: decoded.record });
  }

  #requireSignerLease(agentWallet: `0x${string}`, signerLeaseId: string, nowMs: bigint): void {
    const agent = this.#database.prepare<[string], AgentRow>(`
      SELECT signer_lease_id FROM hyperliquid_signer_agents WHERE agent_wallet = ?
    `).get(agentWallet);
    const lease = this.#database.prepare<[string], LeaseRow>(`
      SELECT agent_wallet FROM hyperliquid_signer_agents WHERE signer_lease_id = ?
    `).get(signerLeaseId);
    if (agent === undefined && lease === undefined) {
      this.#database.prepare(`
        INSERT INTO hyperliquid_signer_agents
          (agent_wallet, signer_lease_id, created_at_ms_decimal) VALUES (?, ?, ?)
      `).run(agentWallet, signerLeaseId, canonicalBigint(nowMs, 'nowMs'));
      return;
    }
    requireCondition(agent?.signer_lease_id === signerLeaseId && lease?.agent_wallet === agentWallet,
      'agent wallet or signer lease is already bound');
  }

  #nonceRow(input: Pick<NormalizedPrepare, 'account' | 'agentWallet' | 'signerLeaseId'>):
  NonceRow | undefined {
    return this.#database.prepare<[string, string, string, string, string], NonceRow>(`
      SELECT highest_nonce_decimal FROM hyperliquid_nonce_fences
      WHERE master_account = ? AND trading_account = ? AND account_kind = ?
        AND agent_wallet = ? AND signer_lease_id = ?
    `).get(input.account.masterAccount, input.account.tradingAccount, input.account.accountKind,
      input.agentWallet, input.signerLeaseId);
  }

  #advanceNonce(input: NormalizedPrepare, previous: NonceRow | undefined): void {
    const values = [input.account.masterAccount, input.account.tradingAccount, input.account.accountKind,
      input.agentWallet, input.signerLeaseId] as const;
    if (previous === undefined) {
      this.#database.prepare(`
        INSERT INTO hyperliquid_nonce_fences (
          master_account, trading_account, account_kind, agent_wallet, signer_lease_id,
          highest_nonce_decimal, updated_at_ms_decimal
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(...values, canonicalBigint(input.nonce, 'nonce'), canonicalBigint(input.nowMs, 'nowMs'));
      return;
    }
    const update = this.#database.prepare(`
      UPDATE hyperliquid_nonce_fences SET highest_nonce_decimal = ?, updated_at_ms_decimal = ?
      WHERE master_account = ? AND trading_account = ? AND account_kind = ?
        AND agent_wallet = ? AND signer_lease_id = ? AND highest_nonce_decimal = ?
    `).run(canonicalBigint(input.nonce, 'nonce'), canonicalBigint(input.nowMs, 'nowMs'),
      ...values, previous.highest_nonce_decimal);
    requireCondition(update.changes === 1, 'nonce high-water compare-and-set failed');
  }

  #insertAttempt(input: NormalizedPrepare, revision: bigint): void {
    this.#database.prepare(`
      INSERT INTO hyperliquid_netting_residual_submission_attempts (
        attempt_id, master_account, trading_account, account_kind, agent_wallet, signer_lease_id,
        nonce_decimal, expiry_decimal, vault_address, action_json, action_hash, record_hash,
        client_order_id, domain_id, domain_manifest_version, domain_manifest_hash,
        intent_hash, instrument_hash, status, revision_decimal, durable_revision,
        acknowledgement_id, rejection_id, created_at_ms_decimal, updated_at_ms_decimal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'PREPARED', ?, NULL, NULL, NULL, ?, ?)
    `).run(
      input.attemptId, input.account.masterAccount, input.account.tradingAccount,
      input.account.accountKind, input.agentWallet, input.signerLeaseId,
      canonicalBigint(input.nonce, 'nonce'), canonicalBigint(input.expiresAfterMs, 'expiresAfterMs'),
      input.vaultAddress, actionJson(input.action), input.actionHash, input.recordHash,
      input.clientOrderId, input.domain.domainId, input.domain.domainManifestVersion,
      Buffer.from(input.domain.domainManifestHash), Buffer.from(input.intentHash),
      Buffer.from(input.instrumentHash), canonicalBigint(revision, 'revision'),
      canonicalBigint(input.nowMs, 'createdAtMs'), canonicalBigint(input.nowMs, 'updatedAtMs'),
    );
  }

  async #transition(
    attemptId: string,
    expectedVersion: bigint,
    target: HyperliquidJournalStatus,
    allowed: readonly HyperliquidJournalStatus[],
    options: Readonly<{
      timestamp?: bigint;
      acknowledgementId?: string;
      rejectionId?: string;
      durableRevision?: boolean;
      validate?: (record: HyperliquidNettingResidualJournalRecord) => void;
    }> = {},
  ): Promise<HyperliquidNettingResidualJournalReceipt> {
    this.#requireOpen();
    const transaction = this.#database.transaction(() => {
      const row = this.#attemptRow(attemptId);
      requireCondition(row !== undefined, 'residual submission identity is unknown');
      const decoded = decodeRow(row);
      if (decoded.record.status === target) return;
      requireCondition(allowed.includes(decoded.record.status), `${target} cannot follow ${decoded.record.status}`);
      options.validate?.(decoded.record);
      const metadata = this.#metadata();
      requireCondition(metadata.journalRevision === expectedVersion,
        'journal compare-and-set version mismatch');
      const nextRevision = metadata.journalRevision + 1n;
      const durableRevision = options.durableRevision
        ? `sqlite-net-residual-v1:${nextRevision.toString()}` : row.durable_revision;
      const update = this.#database.prepare(`
        UPDATE hyperliquid_netting_residual_submission_attempts
        SET status = ?, revision_decimal = ?, durable_revision = ?, acknowledgement_id = ?,
          rejection_id = ?, updated_at_ms_decimal = ?
        WHERE attempt_id = ? AND status = ? AND revision_decimal = ?
      `).run(target, canonicalBigint(nextRevision, 'nextRevision'), durableRevision,
        options.acknowledgementId ?? row.acknowledgement_id,
        options.rejectionId ?? row.rejection_id,
        canonicalBigint(options.timestamp ?? timestampNow(), 'updatedAtMs'), attemptId,
        decoded.record.status, canonicalBigint(decoded.revision, 'recordRevision'));
      requireCondition(update.changes === 1, `${target} compare-and-set failed`);
      this.#advanceRevision(metadata.journalRevision, nextRevision);
    });
    transaction.immediate();
    return this.#requiredReceipt(attemptId);
  }
}
