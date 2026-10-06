import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import type {
  HypercoreOrderWire,
  HypercoreStrategyBatch,
  HyperliquidStrategyExecutionPlan,
} from '@naryx/adapter-hyperliquid';
import type { DomainRef } from '@naryx/protocol-types';
import type {
  HyperliquidJournalStatus,
  HyperliquidSubmissionAccount,
} from './index.js';

const SCHEMA_VERSION = 1;
const ACTION_COMMITMENT_SCHEME = 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1' as const;
const RECORD_COMMITMENT_SCHEME = 'naryx/hypercore/strategy-sqlite-submission-record/v1';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const CLOID = /^0x[0-9a-f]{32}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const DECIMAL_VALUE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

type StrategyAction = HypercoreStrategyBatch['action'];

interface MetadataRow {
  readonly schema_version: number;
  readonly journal_revision: string;
}

interface AttemptRow {
  readonly submission_id: string;
  readonly attempt_id: string;
  readonly batch_stage: number;
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
  readonly leg_ids_json: string;
  readonly client_order_ids_json: string;
  readonly domain_id: string;
  readonly domain_manifest_version: number;
  readonly domain_manifest_hash: Buffer;
  readonly order_hash: Buffer;
  readonly graph_hash: Buffer;
  readonly quote_hash: Buffer;
  readonly route_hash: Buffer;
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

export interface HyperliquidStrategyJournalCommitments {
  readonly orderHash: Uint8Array;
  readonly graphHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly routeHash: Uint8Array;
}

export interface HyperliquidStrategyJournalRecord {
  readonly attemptId: string;
  readonly batchStage: number;
  readonly status: HyperliquidJournalStatus;
  readonly account: HyperliquidSubmissionAccount;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly nonce: bigint;
  readonly expiresAfterMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
  readonly action: StrategyAction;
  readonly actionCommitmentScheme: typeof ACTION_COMMITMENT_SCHEME;
  readonly actionHash: `0x${string}`;
  readonly recordHash: `0x${string}`;
  readonly legIds: readonly string[];
  readonly clientOrderIds: readonly `0x${string}`[];
  readonly domain: DomainRef;
  readonly commitments: HyperliquidStrategyJournalCommitments;
  readonly durableRevision: string | null;
}

export interface HyperliquidStrategyJournalReceipt {
  readonly journalVersion: bigint;
  readonly record: HyperliquidStrategyJournalRecord;
}

export interface HyperliquidStrategyJournalPrepareInput {
  readonly expectedVersion: bigint;
  readonly attemptId: string;
  readonly batchStage: number;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly plan: HyperliquidStrategyExecutionPlan;
  readonly account: HyperliquidSubmissionAccount;
  readonly nonce: bigint;
  readonly nowMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
}

interface NormalizedPrepare {
  readonly submissionId: string;
  readonly attemptId: string;
  readonly batchStage: number;
  readonly account: HyperliquidSubmissionAccount;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly nonce: bigint;
  readonly expiresAfterMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
  readonly action: StrategyAction;
  readonly actionHash: `0x${string}`;
  readonly recordHash: `0x${string}`;
  readonly legIds: readonly string[];
  readonly clientOrderIds: readonly `0x${string}`[];
  readonly domain: DomainRef;
  readonly commitments: HyperliquidStrategyJournalCommitments;
  readonly nowMs: bigint;
}

export interface HyperliquidStrategySqliteJournalOptions {
  readonly databasePath: string;
}

export interface HyperliquidStrategyDurableSubmissionJournalPort {
  submissionContext(input: Readonly<{
    account: HyperliquidSubmissionAccount;
    agentWallet: `0x${string}`;
    signerLeaseId: string;
    nowMs: bigint;
  }>): Readonly<{ expectedVersion: bigint; nonce: bigint }>;
  prepare(input: HyperliquidStrategyJournalPrepareInput): Promise<HyperliquidStrategyJournalReceipt>;
  confirmDurable(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    batchStage: number;
    recordHash: `0x${string}`;
  }>): Promise<HyperliquidStrategyJournalReceipt>;
  markSubmittedUnknown(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    batchStage: number;
    nowMs: bigint;
  }>): Promise<HyperliquidStrategyJournalReceipt>;
  acknowledge(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    batchStage: number;
    acknowledgementId: string;
  }>): Promise<HyperliquidStrategyJournalReceipt>;
  reject(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    batchStage: number;
    rejectionId: string;
  }>): Promise<HyperliquidStrategyJournalReceipt>;
  beginReconciliation(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    batchStage: number;
  }>): Promise<HyperliquidStrategyJournalReceipt>;
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

function uint32(value: unknown, name: string): number {
  requireCondition(typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= 0xffff_ffff, `${name} must fit u32`);
  return value;
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
  requireCondition(allowZero ? decoded >= 0n : decoded > 0n,
    `${name} must be ${allowZero ? 'nonnegative' : 'positive'}`);
  requireCondition(decoded.toString() === value, `${name} is not canonical integer text`);
  return decoded;
}

function bytes32(value: unknown, name: string): Uint8Array {
  requireCondition(value instanceof Uint8Array && value.length === 32
    && value.some((byte) => byte !== 0), `${name} must be a nonzero 32-byte value`);
  return Uint8Array.from(value);
}

function canonicalDecimal(value: unknown, name: string): string {
  requireCondition(typeof value === 'string' && DECIMAL_VALUE.test(value)
    && !/^0(?:\.0+)?$/.test(value), `${name} must be positive canonical decimal text`);
  return value;
}

function canonicalOrder(value: unknown, name: string): HypercoreOrderWire {
  requireCondition(typeof value === 'object' && value !== null, `${name} must be an order`);
  const order = value as Record<string, unknown>;
  const type = order.t as { readonly limit?: { readonly tif?: unknown } } | undefined;
  requireCondition(typeof order.b === 'boolean' && typeof order.r === 'boolean'
    && type?.limit?.tif === 'Ioc', `${name} must be an IOC order`);
  return Object.freeze({
    a: uint32(order.a, `${name}.a`),
    b: order.b,
    p: canonicalDecimal(order.p, `${name}.p`),
    s: canonicalDecimal(order.s, `${name}.s`),
    r: order.r,
    t: Object.freeze({ limit: Object.freeze({ tif: 'Ioc' as const }) }),
    c: clientOrderId(order.c, `${name}.c`),
  });
}

function canonicalAction(value: unknown): StrategyAction {
  requireCondition(typeof value === 'object' && value !== null, 'action must be an object');
  const action = value as Record<string, unknown>;
  requireCondition(action.type === 'order' && action.grouping === 'na'
    && Array.isArray(action.orders) && action.orders.length > 0 && action.orders.length <= 16,
  'action must contain 1 to 16 ungrouped IOC orders');
  return Object.freeze({
    type: 'order',
    orders: Object.freeze(action.orders.map((order, index) => canonicalOrder(order, `action.orders[${index}]`))),
    grouping: 'na',
  });
}

function actionJson(action: StrategyAction): string {
  return JSON.stringify(action);
}

function sha256(value: string): `0x${string}` {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function actionCommitment(action: StrategyAction): `0x${string}` {
  return sha256(JSON.stringify([ACTION_COMMITMENT_SCHEME, action.type,
    action.orders.map((order) => [order.a, order.b, order.p, order.s, order.r,
      order.t.limit.tif, order.c]), action.grouping]));
}

function sameOrder(left: HypercoreOrderWire, right: HypercoreOrderWire): boolean {
  return left.a === right.a && left.b === right.b && left.p === right.p
    && left.s === right.s && left.r === right.r && left.c === right.c
    && left.t.limit.tif === right.t.limit.tif;
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

function commitments(plan: HyperliquidStrategyExecutionPlan): HyperliquidStrategyJournalCommitments {
  return Object.freeze({
    orderHash: bytes32(plan.orderHash, 'orderHash'),
    graphHash: bytes32(plan.graphHash, 'graphHash'),
    quoteHash: bytes32(plan.quoteHash, 'quoteHash'),
    routeHash: bytes32(plan.routeHash, 'routeHash'),
  });
}

function recordCommitment(input: Omit<NormalizedPrepare, 'recordHash' | 'nowMs'>): `0x${string}` {
  return sha256(JSON.stringify([
    RECORD_COMMITMENT_SCHEME,
    input.submissionId,
    input.attemptId,
    input.batchStage,
    input.account.masterAccount,
    input.account.tradingAccount,
    input.account.accountKind,
    input.agentWallet,
    input.signerLeaseId,
    input.nonce.toString(),
    input.expiresAfterMs.toString(),
    input.vaultAddress,
    input.actionHash,
    input.legIds,
    input.clientOrderIds,
    input.domain.domainId,
    input.domain.domainManifestVersion,
    Buffer.from(input.domain.domainManifestHash).toString('hex'),
    Buffer.from(input.commitments.orderHash).toString('hex'),
    Buffer.from(input.commitments.graphHash).toString('hex'),
    Buffer.from(input.commitments.quoteHash).toString('hex'),
    Buffer.from(input.commitments.routeHash).toString('hex'),
  ]));
}

function normalizedPrepare(input: HyperliquidStrategyJournalPrepareInput): NormalizedPrepare {
  const attemptId = identifier(input.attemptId, 'attemptId');
  const signerLeaseId = identifier(input.signerLeaseId, 'signerLeaseId');
  const batchStage = uint32(input.batchStage, 'batchStage');
  const submissionId = `${attemptId}:${batchStage}`;
  requireCondition(IDENTIFIER.test(submissionId), 'submission identity is invalid');
  const account = normalizedAccount(input.account);
  const agentWallet = address(input.agentWallet, 'agentWallet');
  requireCondition(agentWallet !== account.masterAccount && agentWallet !== account.tradingAccount,
    'agent wallet must differ from account identities');
  const nonce = BigInt(canonicalBigint(input.nonce, 'nonce'));
  const nowMs = BigInt(canonicalBigint(input.nowMs, 'nowMs'));
  requireCondition(nonce <= MAX_SAFE_INTEGER, 'nonce must fit a safe integer for the SDK');
  const plan = input.plan;
  requireCondition(plan.version === 1 && plan.guarantee === 'BATCHED_IOC_WITH_BOUNDED_RECOVERY',
    'execution plan version or guarantee is unsupported');
  requireCondition(plan.domain.domainId === 'hypercore:testnet'
    && Number.isInteger(plan.domain.domainManifestVersion) && plan.domain.domainManifestVersion > 0,
  'execution plan domain is unsupported');
  const domain = Object.freeze({
    domainId: plan.domain.domainId,
    domainManifestVersion: plan.domain.domainManifestVersion,
    domainManifestHash: bytes32(plan.domain.domainManifestHash, 'domainManifestHash'),
  }) as DomainRef;
  const expiresAfterMs = BigInt(canonicalBigint(plan.requestExpiryMs, 'requestExpiryMs'));
  requireCondition(expiresAfterMs <= MAX_SAFE_INTEGER && expiresAfterMs > nowMs && expiresAfterMs > nonce,
    'request expiry is invalid or stale');
  const vaultAddress = input.vaultAddress === null ? null : address(input.vaultAddress, 'vaultAddress');
  requireCondition(account.accountKind === 'MASTER'
    ? vaultAddress === null
    : vaultAddress === account.tradingAccount, 'vault context does not match the trading account');
  const matchingBatches = plan.batches.filter((candidate) => candidate.stage === batchStage);
  requireCondition(matchingBatches.length === 1, 'batch stage must resolve exactly once');
  const batch = matchingBatches[0]!;
  const action = canonicalAction(batch.action);
  const plannedOrders = plan.orders.filter((order) => order.stage === batchStage);
  requireCondition(plannedOrders.length === action.orders.length
    && batch.legIds.length === action.orders.length, 'batch membership is inconsistent');
  for (let index = 0; index < plannedOrders.length; index += 1) {
    const planned = plannedOrders[index]!;
    requireCondition(batch.legIds[index] === planned.legId
      && sameOrder(action.orders[index]!, planned.wire)
      && planned.clientOrderId === planned.wire.c, 'batch does not bind its planned orders');
  }
  const legIds = Object.freeze([...batch.legIds]);
  const clientOrderIds = Object.freeze(plannedOrders.map((order, index) =>
    clientOrderId(order.clientOrderId, `clientOrderIds[${index}]`)));
  requireCondition(new Set(legIds).size === legIds.length
    && new Set(clientOrderIds).size === clientOrderIds.length, 'batch identities must be unique');
  const immutable = {
    submissionId,
    attemptId,
    batchStage,
    account,
    agentWallet,
    signerLeaseId,
    nonce,
    expiresAfterMs,
    vaultAddress,
    action,
    actionHash: actionCommitment(action),
    legIds,
    clientOrderIds,
    domain,
    commitments: commitments(plan),
  };
  return Object.freeze({
    ...immutable,
    recordHash: recordCommitment(immutable),
    nowMs,
  });
}

function rowStatus(value: string): HyperliquidJournalStatus {
  requireCondition(value === 'PREPARED' || value === 'DURABLE_RECORD_CONFIRMED'
    || value === 'SUBMITTED_UNKNOWN' || value === 'ACKNOWLEDGED'
    || value === 'REJECTED' || value === 'RECONCILING', 'stored journal status is invalid');
  return value;
}

function parseStringArray(value: string, name: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  requireCondition(Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 16
    && parsed.every((item) => typeof item === 'string'), `${name} is invalid`);
  return Object.freeze(parsed);
}

function hashValue(value: string, name: string): `0x${string}` {
  requireCondition(HASH.test(value), `${name} must be a hash`);
  return value as `0x${string}`;
}

function decodeRow(row: AttemptRow): Readonly<{
  revision: bigint;
  record: HyperliquidStrategyJournalRecord;
}> {
  const account = normalizedAccount({
    masterAccount: address(row.master_account, 'stored masterAccount'),
    tradingAccount: address(row.trading_account, 'stored tradingAccount'),
    accountKind: row.account_kind as HyperliquidSubmissionAccount['accountKind'],
  });
  const action = canonicalAction(JSON.parse(row.action_json));
  requireCondition(actionJson(action) === row.action_json, 'stored action is not canonical');
  const legIds = parseStringArray(row.leg_ids_json, 'stored leg IDs');
  const clientOrderIds = Object.freeze(parseStringArray(row.client_order_ids_json, 'stored client order IDs')
    .map((value, index) => clientOrderId(value, `stored clientOrderIds[${index}]`)));
  requireCondition(legIds.length === action.orders.length && clientOrderIds.length === action.orders.length
    && action.orders.every((order, index) => order.c === clientOrderIds[index])
    && new Set(legIds).size === legIds.length && new Set(clientOrderIds).size === clientOrderIds.length,
  'stored batch identities do not match the action');
  const domain = Object.freeze({
    domainId: row.domain_id,
    domainManifestVersion: uint32(row.domain_manifest_version, 'stored domainManifestVersion'),
    domainManifestHash: bytes32(row.domain_manifest_hash, 'stored domainManifestHash'),
  }) as DomainRef;
  requireCondition(domain.domainId === 'hypercore:testnet' && domain.domainManifestVersion > 0,
    'stored domain is unsupported');
  const immutable = {
    submissionId: identifier(row.submission_id, 'stored submissionId'),
    attemptId: identifier(row.attempt_id, 'stored attemptId'),
    batchStage: uint32(row.batch_stage, 'stored batchStage'),
    account,
    agentWallet: address(row.agent_wallet, 'stored agentWallet'),
    signerLeaseId: identifier(row.signer_lease_id, 'stored signerLeaseId'),
    nonce: decodedBigint(row.nonce_decimal, 'stored nonce'),
    expiresAfterMs: decodedBigint(row.expiry_decimal, 'stored expiry'),
    vaultAddress: row.vault_address === null ? null : address(row.vault_address, 'stored vaultAddress'),
    action,
    actionHash: hashValue(row.action_hash, 'stored actionHash'),
    legIds,
    clientOrderIds,
    domain,
    commitments: Object.freeze({
      orderHash: bytes32(row.order_hash, 'stored orderHash'),
      graphHash: bytes32(row.graph_hash, 'stored graphHash'),
      quoteHash: bytes32(row.quote_hash, 'stored quoteHash'),
      routeHash: bytes32(row.route_hash, 'stored routeHash'),
    }),
  };
  requireCondition(immutable.submissionId === `${immutable.attemptId}:${immutable.batchStage}`
    && immutable.actionHash === actionCommitment(action)
    && hashValue(row.record_hash, 'stored recordHash') === recordCommitment(immutable),
  'stored record commitment does not match');
  const status = rowStatus(row.status);
  const durableRevision = row.durable_revision === null
    ? null : identifier(row.durable_revision, 'stored durableRevision');
  requireCondition(status === 'PREPARED' ? durableRevision === null : durableRevision !== null,
    'stored durable revision does not match status');
  requireCondition(status === 'ACKNOWLEDGED'
    ? row.acknowledgement_id !== null && row.rejection_id === null
    : status === 'REJECTED'
      ? row.rejection_id !== null && row.acknowledgement_id === null
      : status === 'RECONCILING'
        ? !(row.acknowledgement_id !== null && row.rejection_id !== null)
        : row.acknowledgement_id === null && row.rejection_id === null,
  'stored response evidence does not match status');
  return Object.freeze({
    revision: decodedBigint(row.revision_decimal, 'stored revision'),
    record: Object.freeze({
      attemptId: immutable.attemptId,
      batchStage: immutable.batchStage,
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
      legIds,
      clientOrderIds,
      domain,
      commitments: immutable.commitments,
      durableRevision,
    }),
  });
}

function timestampNow(): bigint {
  return BigInt(Date.now());
}

export class HyperliquidStrategySqliteDurableJournal
implements HyperliquidStrategyDurableSubmissionJournalPort {
  readonly databasePath: string;
  readonly #database: Database.Database;
  #closed = false;

  constructor(options: HyperliquidStrategySqliteJournalOptions) {
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

  async prepare(input: HyperliquidStrategyJournalPrepareInput): Promise<HyperliquidStrategyJournalReceipt> {
    this.#requireOpen();
    const normalized = normalizedPrepare(input);
    const transaction = this.#database.transaction(() => {
      const existing = this.#attemptRow(normalized.submissionId);
      if (existing !== undefined) {
        requireCondition(decodeRow(existing).record.recordHash === normalized.recordHash,
          'submission replay changed its immutable binding');
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
    return this.#requiredReceipt(normalized.submissionId);
  }

  async confirmDurable(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    batchStage: number;
    recordHash: `0x${string}`;
  }>): Promise<HyperliquidStrategyJournalReceipt> {
    const submissionId = this.#submissionId(input.attemptId, input.batchStage);
    const expectedRecordHash = hashValue(input.recordHash, 'recordHash');
    return this.#transition(submissionId, input.expectedVersion, 'DURABLE_RECORD_CONFIRMED', ['PREPARED'], {
      validate: (record) => requireCondition(record.recordHash === expectedRecordHash,
        'durable record hash mismatch'),
      durableRevision: true,
    });
  }

  async markSubmittedUnknown(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    batchStage: number;
    nowMs: bigint;
  }>): Promise<HyperliquidStrategyJournalReceipt> {
    return this.#transition(this.#submissionId(input.attemptId, input.batchStage), input.expectedVersion,
      'SUBMITTED_UNKNOWN', ['DURABLE_RECORD_CONFIRMED'], { timestamp: input.nowMs });
  }

  async acknowledge(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    batchStage: number;
    acknowledgementId: string;
  }>): Promise<HyperliquidStrategyJournalReceipt> {
    const acknowledgementId = identifier(input.acknowledgementId, 'acknowledgementId');
    return this.#transition(this.#submissionId(input.attemptId, input.batchStage), input.expectedVersion,
      'ACKNOWLEDGED', ['SUBMITTED_UNKNOWN'], { acknowledgementId });
  }

  async reject(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    batchStage: number;
    rejectionId: string;
  }>): Promise<HyperliquidStrategyJournalReceipt> {
    const rejectionId = identifier(input.rejectionId, 'rejectionId');
    return this.#transition(this.#submissionId(input.attemptId, input.batchStage), input.expectedVersion,
      'REJECTED', ['SUBMITTED_UNKNOWN'], { rejectionId });
  }

  async beginReconciliation(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    batchStage: number;
  }>): Promise<HyperliquidStrategyJournalReceipt> {
    return this.#transition(this.#submissionId(input.attemptId, input.batchStage), input.expectedVersion,
      'RECONCILING', ['SUBMITTED_UNKNOWN', 'ACKNOWLEDGED', 'REJECTED']);
  }

  async readAttempt(attemptId: string, batchStage: number): Promise<HyperliquidStrategyJournalReceipt | null> {
    this.#requireOpen();
    const row = this.#attemptRow(this.#submissionId(attemptId, batchStage));
    return row === undefined ? null : this.#receipt(row);
  }

  async listUnresolvedSubmissions(): Promise<readonly HyperliquidStrategyJournalReceipt[]> {
    this.#requireOpen();
    const rows = this.#database.prepare<[], AttemptRow>(`
      SELECT * FROM hyperliquid_strategy_submission_attempts
      WHERE status IN ('PREPARED', 'DURABLE_RECORD_CONFIRMED', 'SUBMITTED_UNKNOWN', 'RECONCILING')
      ORDER BY length(created_at_ms_decimal), created_at_ms_decimal, submission_id
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
      CREATE TABLE IF NOT EXISTS hyperliquid_strategy_journal_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        journal_revision TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS hyperliquid_strategy_submission_attempts (
        submission_id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        batch_stage INTEGER NOT NULL,
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
        leg_ids_json TEXT NOT NULL,
        client_order_ids_json TEXT NOT NULL,
        domain_id TEXT NOT NULL,
        domain_manifest_version INTEGER NOT NULL,
        domain_manifest_hash BLOB NOT NULL,
        order_hash BLOB NOT NULL,
        graph_hash BLOB NOT NULL,
        quote_hash BLOB NOT NULL,
        route_hash BLOB NOT NULL,
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
        UNIQUE (attempt_id, batch_stage),
        UNIQUE (order_hash, batch_stage),
        UNIQUE (master_account, trading_account, account_kind, agent_wallet, signer_lease_id, nonce_decimal),
        FOREIGN KEY (agent_wallet) REFERENCES hyperliquid_signer_agents(agent_wallet)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS hyperliquid_strategy_client_orders (
        client_order_id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL,
        leg_id TEXT NOT NULL,
        FOREIGN KEY (submission_id) REFERENCES hyperliquid_strategy_submission_attempts(submission_id)
      ) STRICT;

      CREATE TRIGGER IF NOT EXISTS hyperliquid_strategy_attempt_immutable_update
      BEFORE UPDATE ON hyperliquid_strategy_submission_attempts
      WHEN NEW.submission_id IS NOT OLD.submission_id
        OR NEW.attempt_id IS NOT OLD.attempt_id
        OR NEW.batch_stage IS NOT OLD.batch_stage
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
        OR NEW.leg_ids_json IS NOT OLD.leg_ids_json
        OR NEW.client_order_ids_json IS NOT OLD.client_order_ids_json
        OR NEW.domain_id IS NOT OLD.domain_id
        OR NEW.domain_manifest_version IS NOT OLD.domain_manifest_version
        OR NEW.domain_manifest_hash IS NOT OLD.domain_manifest_hash
        OR NEW.order_hash IS NOT OLD.order_hash
        OR NEW.graph_hash IS NOT OLD.graph_hash
        OR NEW.quote_hash IS NOT OLD.quote_hash
        OR NEW.route_hash IS NOT OLD.route_hash
        OR NEW.created_at_ms_decimal IS NOT OLD.created_at_ms_decimal
      BEGIN SELECT RAISE(ABORT, 'immutable Hyperliquid strategy attempt field changed'); END;

      CREATE TRIGGER IF NOT EXISTS hyperliquid_strategy_attempt_no_delete
      BEFORE DELETE ON hyperliquid_strategy_submission_attempts
      BEGIN SELECT RAISE(ABORT, 'Hyperliquid strategy attempts cannot be deleted'); END;

      CREATE TRIGGER IF NOT EXISTS hyperliquid_strategy_client_order_immutable_update
      BEFORE UPDATE ON hyperliquid_strategy_client_orders
      BEGIN SELECT RAISE(ABORT, 'Hyperliquid strategy client orders cannot be changed'); END;

      CREATE TRIGGER IF NOT EXISTS hyperliquid_strategy_client_order_no_delete
      BEFORE DELETE ON hyperliquid_strategy_client_orders
      BEGIN SELECT RAISE(ABORT, 'Hyperliquid strategy client orders cannot be deleted'); END;
    `);
    const metadata = this.#database.prepare<[], MetadataRow>(`
      SELECT schema_version, journal_revision FROM hyperliquid_strategy_journal_metadata
      WHERE singleton = 1
    `).get();
    if (metadata === undefined) {
      this.#database.prepare(`
        INSERT INTO hyperliquid_strategy_journal_metadata
          (singleton, schema_version, journal_revision) VALUES (1, ?, '0')
      `).run(SCHEMA_VERSION);
    } else {
      requireCondition(metadata.schema_version === SCHEMA_VERSION,
        `unsupported Hyperliquid strategy journal schema version ${metadata.schema_version}`);
    }
  }

  #requireOpen(): void {
    requireCondition(!this.#closed && this.#database.open, 'Hyperliquid strategy journal is closed');
  }

  #submissionId(attemptId: string, batchStage: number): string {
    const value = `${identifier(attemptId, 'attemptId')}:${uint32(batchStage, 'batchStage')}`;
    requireCondition(IDENTIFIER.test(value), 'submission identity is invalid');
    return value;
  }

  #metadata(): { readonly journalRevision: bigint } {
    const row = this.#database.prepare<[], MetadataRow>(`
      SELECT schema_version, journal_revision FROM hyperliquid_strategy_journal_metadata
      WHERE singleton = 1
    `).get();
    requireCondition(row !== undefined && row.schema_version === SCHEMA_VERSION,
      'Hyperliquid strategy journal metadata is missing or invalid');
    return Object.freeze({ journalRevision: decodedBigint(row.journal_revision, 'journalRevision', true) });
  }

  #advanceRevision(previous: bigint, next: bigint): void {
    requireCondition(next === previous + 1n, 'journal revision increment is invalid');
    const update = this.#database.prepare(`
      UPDATE hyperliquid_strategy_journal_metadata SET journal_revision = ?
      WHERE singleton = 1 AND journal_revision = ?
    `).run(canonicalBigint(next, 'nextRevision', true), canonicalBigint(previous, 'previousRevision', true));
    requireCondition(update.changes === 1, 'journal revision compare-and-set failed');
  }

  #attemptRow(submissionId: string): AttemptRow | undefined {
    return this.#database.prepare<[string], AttemptRow>(`
      SELECT * FROM hyperliquid_strategy_submission_attempts WHERE submission_id = ?
    `).get(submissionId);
  }

  #requiredReceipt(submissionId: string): HyperliquidStrategyJournalReceipt {
    const row = this.#attemptRow(submissionId);
    requireCondition(row !== undefined, 'submission identity is unknown');
    return this.#receipt(row);
  }

  #receipt(row: AttemptRow): HyperliquidStrategyJournalReceipt {
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

  #nonceRow(input: Pick<NormalizedPrepare, 'account' | 'agentWallet' | 'signerLeaseId'>): NonceRow | undefined {
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
      INSERT INTO hyperliquid_strategy_submission_attempts (
        submission_id, attempt_id, batch_stage, master_account, trading_account, account_kind,
        agent_wallet, signer_lease_id, nonce_decimal, expiry_decimal, vault_address,
        action_json, action_hash, record_hash, leg_ids_json, client_order_ids_json,
        domain_id, domain_manifest_version, domain_manifest_hash,
        order_hash, graph_hash, quote_hash, route_hash, status, revision_decimal,
        durable_revision, acknowledgement_id, rejection_id, created_at_ms_decimal, updated_at_ms_decimal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'PREPARED', ?, NULL, NULL, NULL, ?, ?)
    `).run(
      input.submissionId, input.attemptId, input.batchStage,
      input.account.masterAccount, input.account.tradingAccount, input.account.accountKind,
      input.agentWallet, input.signerLeaseId, canonicalBigint(input.nonce, 'nonce'),
      canonicalBigint(input.expiresAfterMs, 'expiresAfterMs'), input.vaultAddress,
      actionJson(input.action), input.actionHash, input.recordHash,
      JSON.stringify(input.legIds), JSON.stringify(input.clientOrderIds),
      input.domain.domainId, input.domain.domainManifestVersion, Buffer.from(input.domain.domainManifestHash),
      Buffer.from(input.commitments.orderHash), Buffer.from(input.commitments.graphHash),
      Buffer.from(input.commitments.quoteHash), Buffer.from(input.commitments.routeHash),
      canonicalBigint(revision, 'revision'), canonicalBigint(input.nowMs, 'createdAtMs'),
      canonicalBigint(input.nowMs, 'updatedAtMs'),
    );
    const insertClientOrder = this.#database.prepare(`
      INSERT INTO hyperliquid_strategy_client_orders (client_order_id, submission_id, leg_id)
      VALUES (?, ?, ?)
    `);
    input.clientOrderIds.forEach((value, index) => {
      insertClientOrder.run(value, input.submissionId, input.legIds[index]);
    });
  }

  async #transition(
    submissionId: string,
    expectedVersion: bigint,
    target: HyperliquidJournalStatus,
    allowed: readonly HyperliquidJournalStatus[],
    options: Readonly<{
      timestamp?: bigint;
      acknowledgementId?: string;
      rejectionId?: string;
      durableRevision?: boolean;
      validate?: (record: HyperliquidStrategyJournalRecord) => void;
    }> = {},
  ): Promise<HyperliquidStrategyJournalReceipt> {
    this.#requireOpen();
    const transaction = this.#database.transaction(() => {
      const row = this.#attemptRow(submissionId);
      requireCondition(row !== undefined, 'submission identity is unknown');
      const decoded = decodeRow(row);
      if (decoded.record.status === target) return;
      requireCondition(allowed.includes(decoded.record.status), `${target} cannot follow ${decoded.record.status}`);
      options.validate?.(decoded.record);
      const metadata = this.#metadata();
      requireCondition(metadata.journalRevision === expectedVersion,
        'journal compare-and-set version mismatch');
      const nextRevision = metadata.journalRevision + 1n;
      const durableRevision = options.durableRevision
        ? `sqlite-strategy-v1:${nextRevision.toString()}` : row.durable_revision;
      const update = this.#database.prepare(`
        UPDATE hyperliquid_strategy_submission_attempts
        SET status = ?, revision_decimal = ?, durable_revision = ?, acknowledgement_id = ?,
          rejection_id = ?, updated_at_ms_decimal = ?
        WHERE submission_id = ? AND status = ? AND revision_decimal = ?
      `).run(target, canonicalBigint(nextRevision, 'nextRevision'), durableRevision,
        options.acknowledgementId ?? row.acknowledgement_id,
        options.rejectionId ?? row.rejection_id,
        canonicalBigint(options.timestamp ?? timestampNow(), 'updatedAtMs'), submissionId,
        decoded.record.status, canonicalBigint(decoded.revision, 'recordRevision'));
      requireCondition(update.changes === 1, `${target} compare-and-set failed`);
      this.#advanceRevision(metadata.journalRevision, nextRevision);
    });
    transaction.immediate();
    return this.#requiredReceipt(submissionId);
  }
}
