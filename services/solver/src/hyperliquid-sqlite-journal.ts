import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import {
  HYPERCORE_EXECUTION_GUARANTEE,
  type HypercoreBatchedOrderAction,
  type HypercoreOrderWire,
  type HyperliquidExecutionPlan,
  type HyperliquidPlanCommitments,
} from '@naryx/adapter-hyperliquid';
import type {
  HyperliquidDurableSubmissionJournalPort,
  HyperliquidJournalPrepareInput,
  HyperliquidJournalReceipt,
  HyperliquidJournalRecord,
  HyperliquidJournalStatus,
  HyperliquidSubmissionAccount,
} from './index.js';

const SCHEMA_VERSION = 1;
const ACTION_COMMITMENT_SCHEME = 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1' as const;
const RECORD_COMMITMENT_SCHEME = 'naryx/hypercore/sqlite-submission-record/v1';
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
  readonly action_commitment_scheme: string;
  readonly action_hash: string;
  readonly record_hash: string;
  readonly spot_client_order_id: string;
  readonly perpetual_client_order_id: string;
  readonly domain_id: string;
  readonly domain_manifest_version: number;
  readonly domain_manifest_hash: Buffer;
  readonly series_manifest_hash: Buffer;
  readonly execution_class_manifest_hash: Buffer;
  readonly order_hash: Buffer;
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
  readonly spotClientOrderId: `0x${string}`;
  readonly perpetualClientOrderId: `0x${string}`;
  readonly domain: HyperliquidExecutionPlan['domain'];
  readonly commitments: HyperliquidPlanCommitments;
  readonly nowMs: bigint;
}

interface TransitionInput {
  readonly expectedVersion: bigint;
  readonly attemptId: string;
}

export interface HyperliquidSqliteJournalOptions {
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

function hash(value: unknown, name: string): `0x${string}` {
  requireCondition(typeof value === 'string' && HASH.test(value), `${name} must be a hash`);
  return value as `0x${string}`;
}

function cloid(value: unknown, name: string): `0x${string}` {
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
  requireCondition(value instanceof Uint8Array && value.length === 32, `${name} must be 32 bytes`);
  return Uint8Array.from(value);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function sha256(value: string): `0x${string}` {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalDecimal(value: unknown, name: string, positive: boolean): string {
  requireCondition(typeof value === 'string' && DECIMAL_VALUE.test(value),
    `${name} must be canonical unsigned decimal text`);
  if (positive) requireCondition(!/^0(?:\.0+)?$/.test(value), `${name} must be positive`);
  return value;
}

function canonicalOrder(value: unknown, name: string): HypercoreOrderWire {
  requireCondition(typeof value === 'object' && value !== null, `${name} must be an order`);
  const order = value as Record<string, unknown>;
  requireCondition(typeof order.b === 'boolean' && typeof order.r === 'boolean',
    `${name} direction and reduce-only fields are invalid`);
  const type = order.t as { readonly limit?: { readonly tif?: unknown } } | undefined;
  requireCondition(type?.limit?.tif === 'Ioc', `${name} must be IOC`);
  return Object.freeze({
    a: uint32(order.a, `${name}.a`),
    b: order.b,
    p: canonicalDecimal(order.p, `${name}.p`, true),
    s: canonicalDecimal(order.s, `${name}.s`, true),
    r: order.r,
    t: Object.freeze({ limit: Object.freeze({ tif: 'Ioc' as const }) }),
    c: cloid(order.c, `${name}.c`),
  });
}

function canonicalAction(value: unknown): HypercoreBatchedOrderAction {
  requireCondition(typeof value === 'object' && value !== null, 'action must be an object');
  const action = value as Record<string, unknown>;
  requireCondition(action.type === 'order' && action.grouping === 'na'
    && Array.isArray(action.orders) && action.orders.length === 2,
  'action must contain exactly two ungrouped orders');
  return Object.freeze({
    type: 'order',
    orders: Object.freeze([
      canonicalOrder(action.orders[0], 'action.orders[0]'),
      canonicalOrder(action.orders[1], 'action.orders[1]'),
    ] as const),
    grouping: 'na',
  });
}

function actionJson(action: HypercoreBatchedOrderAction): string {
  return JSON.stringify(action);
}

function actionCommitment(action: HypercoreBatchedOrderAction): `0x${string}` {
  return sha256(JSON.stringify([ACTION_COMMITMENT_SCHEME, action.type,
    action.orders.map((order) => [order.a, order.b, order.p, order.s, order.r,
      order.t.limit.tif, order.c]), action.grouping]));
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
    ACTION_COMMITMENT_SCHEME,
    input.actionHash,
    input.spotClientOrderId,
    input.perpetualClientOrderId,
    input.domain.domainId,
    input.domain.domainManifestVersion,
    hex(input.domain.domainManifestHash),
    hex(input.commitments.seriesManifestHash),
    hex(input.commitments.executionClassManifestHash),
    hex(input.commitments.orderHash),
    hex(input.commitments.quoteHash),
    hex(input.commitments.routeHash),
  ]));
}

function sameAction(left: HypercoreBatchedOrderAction, right: HypercoreBatchedOrderAction): boolean {
  return actionJson(left) === actionJson(right);
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

function normalizedPrepare(input: HyperliquidJournalPrepareInput): NormalizedPrepare {
  const attemptId = identifier(input.attemptId, 'attemptId');
  const signerLeaseId = identifier(input.signerLeaseId, 'signerLeaseId');
  const account = normalizedAccount(input.account);
  const agentWallet = address(input.agentWallet, 'agentWallet');
  requireCondition(agentWallet !== account.masterAccount && agentWallet !== account.tradingAccount,
    'agent wallet must differ from account identities');
  const nonce = BigInt(canonicalBigint(input.nonce, 'nonce'));
  const nowMs = BigInt(canonicalBigint(input.nowMs, 'nowMs'));
  requireCondition(nonce <= MAX_SAFE_INTEGER, 'nonce must fit a safe integer for the SDK');
  requireCondition(input.plan.version === 1
    && input.plan.guarantee === HYPERCORE_EXECUTION_GUARANTEE,
  'execution plan version or guarantee is unsupported');
  requireCondition(input.plan.domain.domainId === 'hypercore:testnet'
    && Number.isInteger(input.plan.domain.domainManifestVersion)
    && input.plan.domain.domainManifestVersion > 0,
  'execution plan domain is unsupported');
  const domain = Object.freeze({
    domainId: input.plan.domain.domainId,
    domainManifestVersion: input.plan.domain.domainManifestVersion,
    domainManifestHash: bytes32(input.plan.domain.domainManifestHash, 'domainManifestHash'),
  }) as HyperliquidExecutionPlan['domain'];
  const commitments = Object.freeze({
    seriesManifestHash: bytes32(input.plan.commitments.seriesManifestHash, 'seriesManifestHash'),
    executionClassManifestHash: bytes32(
      input.plan.commitments.executionClassManifestHash,
      'executionClassManifestHash',
    ),
    orderHash: bytes32(input.plan.commitments.orderHash, 'orderHash'),
    quoteHash: bytes32(input.plan.commitments.quoteHash, 'quoteHash'),
    routeHash: bytes32(input.plan.commitments.routeHash, 'routeHash'),
  }) as HyperliquidPlanCommitments;
  const expiresAfterMs = BigInt(canonicalBigint(input.plan.requestExpiryMs, 'requestExpiryMs'));
  requireCondition(expiresAfterMs <= MAX_SAFE_INTEGER && expiresAfterMs > nowMs
    && expiresAfterMs > nonce
    && Number.isSafeInteger(input.plan.unsignedRequestFields.expiresAfter)
    && BigInt(input.plan.unsignedRequestFields.expiresAfter) === expiresAfterMs,
  'request expiry is invalid or stale');
  const vaultAddress = input.vaultAddress === null
    ? null : address(input.vaultAddress, 'vaultAddress');
  requireCondition(account.accountKind === 'MASTER'
    ? vaultAddress === null
    : vaultAddress === account.tradingAccount,
  'vault context does not match the trading account');
  requireCondition(input.plan.legs.length === 2, 'execution plan must have exactly two legs');
  const action = canonicalAction(input.plan.unsignedRequestFields.action);
  const firstLegOrder = canonicalOrder(input.plan.legs[0].order, 'plan.legs[0].order');
  const secondLegOrder = canonicalOrder(input.plan.legs[1].order, 'plan.legs[1].order');
  requireCondition(sameAction(action, {
    type: 'order', orders: [firstLegOrder, secondLegOrder], grouping: 'na',
  }), 'action and planned legs differ');
  const spot = input.plan.legs.find((leg) => leg.role === 'SPOT');
  const perpetual = input.plan.legs.find((leg) => leg.role === 'PERPETUAL');
  requireCondition(spot !== undefined && perpetual !== undefined, 'plan leg roles are invalid');
  const spotClientOrderId = cloid(spot.clientOrderId, 'spotClientOrderId');
  const perpetualClientOrderId = cloid(perpetual.clientOrderId, 'perpetualClientOrderId');
  requireCondition(spotClientOrderId === cloid(spot.order.c, 'spot.order.c')
    && perpetualClientOrderId === cloid(perpetual.order.c, 'perpetual.order.c')
    && spotClientOrderId !== perpetualClientOrderId,
  'plan client order ID binding is invalid');
  const normalized = {
    attemptId,
    account,
    agentWallet,
    signerLeaseId,
    nonce,
    expiresAfterMs,
    vaultAddress,
    action,
    actionHash: actionCommitment(action),
    spotClientOrderId,
    perpetualClientOrderId,
    domain,
    commitments,
  };
  return Object.freeze({
    ...normalized,
    recordHash: recordCommitment(normalized),
    nowMs,
  });
}

function rowStatus(value: string): HyperliquidJournalStatus {
  requireCondition(value === 'PREPARED'
    || value === 'DURABLE_RECORD_CONFIRMED'
    || value === 'SUBMITTED_UNKNOWN'
    || value === 'ACKNOWLEDGED'
    || value === 'REJECTED'
    || value === 'RECONCILING', 'stored journal status is invalid');
  return value;
}

function decodeRow(row: AttemptRow): { readonly revision: bigint; readonly record: HyperliquidJournalRecord } {
  const attemptId = identifier(row.attempt_id, 'stored attemptId');
  const account = normalizedAccount({
    masterAccount: address(row.master_account, 'stored masterAccount'),
    tradingAccount: address(row.trading_account, 'stored tradingAccount'),
    accountKind: row.account_kind as HyperliquidSubmissionAccount['accountKind'],
  });
  const agentWallet = address(row.agent_wallet, 'stored agentWallet');
  const signerLeaseId = identifier(row.signer_lease_id, 'stored signerLeaseId');
  const nonce = decodedBigint(row.nonce_decimal, 'stored nonce');
  const expiresAfterMs = decodedBigint(row.expiry_decimal, 'stored expiry');
  const vaultAddress = row.vault_address === null
    ? null : address(row.vault_address, 'stored vaultAddress');
  const parsedAction: unknown = JSON.parse(row.action_json);
  const action = canonicalAction(parsedAction);
  requireCondition(actionJson(action) === row.action_json, 'stored action is not canonical');
  requireCondition(row.action_commitment_scheme === ACTION_COMMITMENT_SCHEME,
    'stored action commitment scheme is unsupported');
  const actionHash = hash(row.action_hash, 'stored actionHash');
  requireCondition(actionHash === actionCommitment(action), 'stored action hash does not match');
  const recordHash = hash(row.record_hash, 'stored recordHash');
  const spotClientOrderId = cloid(row.spot_client_order_id, 'stored spotClientOrderId');
  const perpetualClientOrderId = cloid(
    row.perpetual_client_order_id,
    'stored perpetualClientOrderId',
  );
  requireCondition(spotClientOrderId !== perpetualClientOrderId,
    'stored client order IDs must differ');
  requireCondition(action.orders.filter((order) => order.c === spotClientOrderId).length === 1
    && action.orders.filter((order) => order.c === perpetualClientOrderId).length === 1,
  'stored action does not bind both client order IDs');
  const domain = Object.freeze({
    domainId: row.domain_id,
    domainManifestVersion: uint32(row.domain_manifest_version, 'stored domainManifestVersion'),
    domainManifestHash: bytes32(row.domain_manifest_hash, 'stored domainManifestHash'),
  }) as HyperliquidExecutionPlan['domain'];
  requireCondition(domain.domainId === 'hypercore:testnet' && domain.domainManifestVersion > 0,
    'stored domain is unsupported');
  const commitments = Object.freeze({
    seriesManifestHash: bytes32(row.series_manifest_hash, 'stored seriesManifestHash'),
    executionClassManifestHash: bytes32(
      row.execution_class_manifest_hash,
      'stored executionClassManifestHash',
    ),
    orderHash: bytes32(row.order_hash, 'stored orderHash'),
    quoteHash: bytes32(row.quote_hash, 'stored quoteHash'),
    routeHash: bytes32(row.route_hash, 'stored routeHash'),
  }) as HyperliquidPlanCommitments;
  const status = rowStatus(row.status);
  const revision = decodedBigint(row.revision_decimal, 'stored revision');
  const durableRevision = row.durable_revision === null
    ? null : identifier(row.durable_revision, 'stored durableRevision');
  const acknowledgementId = row.acknowledgement_id === null
    ? null : identifier(row.acknowledgement_id, 'stored acknowledgementId');
  const rejectionId = row.rejection_id === null
    ? null : identifier(row.rejection_id, 'stored rejectionId');
  decodedBigint(row.created_at_ms_decimal, 'stored createdAtMs');
  decodedBigint(row.updated_at_ms_decimal, 'stored updatedAtMs');
  requireCondition(agentWallet !== account.masterAccount && agentWallet !== account.tradingAccount
    && expiresAfterMs > nonce
    && (account.accountKind === 'MASTER'
      ? vaultAddress === null
      : vaultAddress === account.tradingAccount),
  'stored account, signer, nonce, or vault binding is invalid');
  requireCondition(status === 'PREPARED' ? durableRevision === null : durableRevision !== null,
    'stored durable revision does not match status');
  requireCondition(status === 'ACKNOWLEDGED'
    ? acknowledgementId !== null && rejectionId === null
    : status === 'REJECTED'
      ? rejectionId !== null && acknowledgementId === null
      : status === 'RECONCILING'
        ? !(acknowledgementId !== null && rejectionId !== null)
        : acknowledgementId === null && rejectionId === null,
  'stored response evidence does not match status');
  const immutable = {
    attemptId,
    account,
    agentWallet,
    signerLeaseId,
    nonce,
    expiresAfterMs,
    vaultAddress,
    action,
    actionHash,
    spotClientOrderId,
    perpetualClientOrderId,
    domain,
    commitments,
  };
  requireCondition(recordHash === recordCommitment(immutable), 'stored record hash does not match');
  return Object.freeze({
    revision,
    record: Object.freeze({
      attemptId,
      status,
      account,
      agentWallet,
      signerLeaseId,
      nonce,
      expiresAfterMs,
      vaultAddress,
      action,
      actionCommitmentScheme: ACTION_COMMITMENT_SCHEME,
      actionHash,
      recordHash,
      spotClientOrderId,
      perpetualClientOrderId,
      domain,
      commitments,
      durableRevision,
    }),
  });
}

function timestampNow(): bigint {
  return BigInt(Date.now());
}

export class HyperliquidSqliteDurableJournal implements HyperliquidDurableSubmissionJournalPort {
  readonly databasePath: string;
  readonly #database: Database.Database;
  #closed = false;

  constructor(options: HyperliquidSqliteJournalOptions) {
    requireCondition(typeof options?.databasePath === 'string'
      && options.databasePath.length > 0
      && options.databasePath !== ':memory:'
      && !options.databasePath.startsWith('file:')
      && isAbsolute(options.databasePath),
    'databasePath must be an explicit absolute filesystem path');
    const databasePath = resolve(options.databasePath);
    const projectRelativePath = relative(resolve(process.cwd()), databasePath);
    requireCondition(projectRelativePath === '..'
      || projectRelativePath.startsWith(`..${sep}`)
      || isAbsolute(projectRelativePath),
    'databasePath must be outside the current project directory');
    this.databasePath = databasePath;
    this.#database = new Database(databasePath, { timeout: 5_000 });
    try {
      const journalMode = this.#database.pragma('journal_mode = WAL', { simple: true });
      requireCondition(String(journalMode).toLowerCase() === 'wal',
        'SQLite journal mode is not WAL');
      this.#database.pragma('synchronous = FULL');
      requireCondition(Number(this.#database.pragma('synchronous', { simple: true })) === 2,
        'SQLite synchronous mode is not FULL');
      this.#database.pragma('foreign_keys = ON');
      this.#database.pragma('trusted_schema = OFF');
      this.#database.pragma('fullfsync = ON');
      this.#database.pragma('checkpoint_fullfsync = ON');
      this.#database.pragma('wal_autocheckpoint = 1000');
      this.#initializeSchema();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  async prepare(input: HyperliquidJournalPrepareInput): Promise<HyperliquidJournalReceipt> {
    this.#requireOpen();
    const normalized = normalizedPrepare(input);
    const transaction = this.#database.transaction(() => {
      const existing = this.#attemptRow(normalized.attemptId);
      if (existing !== undefined) {
        const decoded = decodeRow(existing);
        requireCondition(decoded.record.recordHash === normalized.recordHash,
          'attempt replay changed its immutable binding');
        return;
      }
      const metadata = this.#metadata();
      requireCondition(metadata.journalRevision === input.expectedVersion,
        'journal compare-and-set version mismatch');
      this.#requireSignerLease(normalized.agentWallet, normalized.signerLeaseId, normalized.nowMs);
      const nonceRow = this.#database.prepare<[string, string, string, string, string], NonceRow>(`
        SELECT highest_nonce_decimal
        FROM hyperliquid_nonce_fences
        WHERE master_account = ? AND trading_account = ? AND account_kind = ?
          AND agent_wallet = ? AND signer_lease_id = ?
      `).get(
        normalized.account.masterAccount,
        normalized.account.tradingAccount,
        normalized.account.accountKind,
        normalized.agentWallet,
        normalized.signerLeaseId,
      );
      if (nonceRow !== undefined) {
        requireCondition(normalized.nonce > decodedBigint(
          nonceRow.highest_nonce_decimal,
          'stored nonce high-water',
        ), 'nonce must strictly increase for the account and signer lease');
      }
      const nextRevision = metadata.journalRevision + 1n;
      this.#insertAttempt(normalized, nextRevision);
      if (nonceRow === undefined) {
        this.#database.prepare(`
          INSERT INTO hyperliquid_nonce_fences (
            master_account, trading_account, account_kind, agent_wallet, signer_lease_id,
            highest_nonce_decimal, updated_at_ms_decimal
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalized.account.masterAccount,
          normalized.account.tradingAccount,
          normalized.account.accountKind,
          normalized.agentWallet,
          normalized.signerLeaseId,
          canonicalBigint(normalized.nonce, 'nonce'),
          canonicalBigint(normalized.nowMs, 'nowMs'),
        );
      } else {
        const update = this.#database.prepare(`
          UPDATE hyperliquid_nonce_fences
          SET highest_nonce_decimal = ?, updated_at_ms_decimal = ?
          WHERE master_account = ? AND trading_account = ? AND account_kind = ?
            AND agent_wallet = ? AND signer_lease_id = ? AND highest_nonce_decimal = ?
        `).run(
          canonicalBigint(normalized.nonce, 'nonce'),
          canonicalBigint(normalized.nowMs, 'nowMs'),
          normalized.account.masterAccount,
          normalized.account.tradingAccount,
          normalized.account.accountKind,
          normalized.agentWallet,
          normalized.signerLeaseId,
          nonceRow.highest_nonce_decimal,
        );
        requireCondition(update.changes === 1, 'nonce high-water compare-and-set failed');
      }
      this.#advanceRevision(metadata.journalRevision, nextRevision);
    });
    transaction.immediate();
    return this.#requiredReceipt(normalized.attemptId);
  }

  async confirmDurable(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    recordHash: `0x${string}`;
  }>): Promise<HyperliquidJournalReceipt> {
    this.#requireOpen();
    const attemptId = identifier(input.attemptId, 'attemptId');
    const expectedRecordHash = hash(input.recordHash, 'recordHash');
    let committedDurableRevision: string | null = null;
    const transaction = this.#database.transaction(() => {
      const row = this.#requiredAttemptRow(attemptId);
      const decoded = decodeRow(row);
      requireCondition(decoded.record.recordHash === expectedRecordHash,
        'durable record hash mismatch');
      if (decoded.record.status === 'DURABLE_RECORD_CONFIRMED') {
        committedDurableRevision = decoded.record.durableRevision;
        return;
      }
      requireCondition(decoded.record.status === 'PREPARED',
        'durable confirmation requires PREPARED');
      const metadata = this.#metadata();
      requireCondition(metadata.journalRevision === input.expectedVersion,
        'journal compare-and-set version mismatch');
      const nextRevision = metadata.journalRevision + 1n;
      const durableRevision = `sqlite-v1:${nextRevision.toString()}`;
      const update = this.#database.prepare(`
        UPDATE hyperliquid_submission_attempts
        SET status = 'DURABLE_RECORD_CONFIRMED', revision_decimal = ?,
          durable_revision = ?, updated_at_ms_decimal = ?
        WHERE attempt_id = ? AND status = 'PREPARED' AND revision_decimal = ?
          AND record_hash = ?
      `).run(
        canonicalBigint(nextRevision, 'nextRevision'),
        durableRevision,
        canonicalBigint(timestampNow(), 'updatedAtMs'),
        attemptId,
        canonicalBigint(decoded.revision, 'recordRevision'),
        expectedRecordHash,
      );
      requireCondition(update.changes === 1, 'durable confirmation compare-and-set failed');
      this.#advanceRevision(metadata.journalRevision, nextRevision);
      committedDurableRevision = durableRevision;
    });
    transaction.immediate();
    const receipt = this.#requiredReceipt(attemptId);
    requireCondition(receipt.record.status === 'DURABLE_RECORD_CONFIRMED'
      && receipt.record.recordHash === expectedRecordHash
      && receipt.record.durableRevision === committedDurableRevision,
    'durable record readback did not match the committed row');
    return receipt;
  }

  async markSubmittedUnknown(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    nowMs: bigint;
  }>): Promise<HyperliquidJournalReceipt> {
    const nowMs = BigInt(canonicalBigint(input.nowMs, 'nowMs'));
    return this.#transition(input, 'SUBMITTED_UNKNOWN', ['DURABLE_RECORD_CONFIRMED'], {
      timestamp: nowMs,
      validate: (record) => requireCondition(nowMs < record.expiresAfterMs,
        'expiresAfter is stale before submission'),
    });
  }

  async acknowledge(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    acknowledgementId: string;
  }>): Promise<HyperliquidJournalReceipt> {
    const acknowledgementId = identifier(input.acknowledgementId, 'acknowledgementId');
    return this.#transition(input, 'ACKNOWLEDGED', ['SUBMITTED_UNKNOWN'], {
      acknowledgementId,
    });
  }

  async reject(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    rejectionId: string;
  }>): Promise<HyperliquidJournalReceipt> {
    const rejectionId = identifier(input.rejectionId, 'rejectionId');
    return this.#transition(input, 'REJECTED', ['SUBMITTED_UNKNOWN'], { rejectionId });
  }

  async beginReconciliation(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
  }>): Promise<HyperliquidJournalReceipt> {
    return this.#transition(input, 'RECONCILING', [
      'DURABLE_RECORD_CONFIRMED', 'SUBMITTED_UNKNOWN', 'ACKNOWLEDGED', 'REJECTED',
    ]);
  }

  async readAttempt(attemptId: string): Promise<HyperliquidJournalReceipt | null> {
    this.#requireOpen();
    const normalized = identifier(attemptId, 'attemptId');
    const row = this.#attemptRow(normalized);
    return row === undefined ? null : this.#receipt(row);
  }

  async listUnresolvedSubmissions(): Promise<readonly HyperliquidJournalReceipt[]> {
    this.#requireOpen();
    const rows = this.#database.prepare<[], AttemptRow>(`
      SELECT * FROM hyperliquid_submission_attempts
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
    const userVersion = Number(this.#database.pragma('user_version', { simple: true }));
    if (userVersion === 0) {
      const existing = this.#database.prepare<[], { readonly count: number }>(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%'
      `).get();
      requireCondition(existing?.count === 0, 'unversioned SQLite schema is not accepted');
      const initialize = this.#database.transaction(() => {
        this.#database.exec(`
          CREATE TABLE hyperliquid_journal_metadata (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            schema_version INTEGER NOT NULL,
            journal_revision TEXT NOT NULL
          ) STRICT;

          CREATE TABLE hyperliquid_signer_agents (
            agent_wallet TEXT PRIMARY KEY,
            signer_lease_id TEXT NOT NULL UNIQUE,
            created_at_ms_decimal TEXT NOT NULL
          ) STRICT;

          CREATE TABLE hyperliquid_nonce_fences (
            master_account TEXT NOT NULL,
            trading_account TEXT NOT NULL,
            account_kind TEXT NOT NULL CHECK (account_kind IN ('MASTER', 'SUBACCOUNT')),
            agent_wallet TEXT NOT NULL,
            signer_lease_id TEXT NOT NULL,
            highest_nonce_decimal TEXT NOT NULL,
            updated_at_ms_decimal TEXT NOT NULL,
            PRIMARY KEY (
              master_account, trading_account, account_kind, agent_wallet, signer_lease_id
            ),
            FOREIGN KEY (agent_wallet) REFERENCES hyperliquid_signer_agents(agent_wallet)
          ) STRICT;

          CREATE TABLE hyperliquid_submission_attempts (
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
            action_commitment_scheme TEXT NOT NULL,
            action_hash TEXT NOT NULL,
            record_hash TEXT NOT NULL,
            spot_client_order_id TEXT NOT NULL,
            perpetual_client_order_id TEXT NOT NULL,
            domain_id TEXT NOT NULL,
            domain_manifest_version INTEGER NOT NULL,
            domain_manifest_hash BLOB NOT NULL,
            series_manifest_hash BLOB NOT NULL,
            execution_class_manifest_hash BLOB NOT NULL,
            order_hash BLOB NOT NULL,
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
            UNIQUE (
              master_account, trading_account, account_kind,
              agent_wallet, signer_lease_id, nonce_decimal
            ),
            FOREIGN KEY (agent_wallet) REFERENCES hyperliquid_signer_agents(agent_wallet)
          ) STRICT;

          CREATE TRIGGER hyperliquid_attempt_immutable_update
          BEFORE UPDATE ON hyperliquid_submission_attempts
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
            OR NEW.action_commitment_scheme IS NOT OLD.action_commitment_scheme
            OR NEW.action_hash IS NOT OLD.action_hash
            OR NEW.record_hash IS NOT OLD.record_hash
            OR NEW.spot_client_order_id IS NOT OLD.spot_client_order_id
            OR NEW.perpetual_client_order_id IS NOT OLD.perpetual_client_order_id
            OR NEW.domain_id IS NOT OLD.domain_id
            OR NEW.domain_manifest_version IS NOT OLD.domain_manifest_version
            OR NEW.domain_manifest_hash IS NOT OLD.domain_manifest_hash
            OR NEW.series_manifest_hash IS NOT OLD.series_manifest_hash
            OR NEW.execution_class_manifest_hash IS NOT OLD.execution_class_manifest_hash
            OR NEW.order_hash IS NOT OLD.order_hash
            OR NEW.quote_hash IS NOT OLD.quote_hash
            OR NEW.route_hash IS NOT OLD.route_hash
            OR NEW.created_at_ms_decimal IS NOT OLD.created_at_ms_decimal
          BEGIN
            SELECT RAISE(ABORT, 'immutable Hyperliquid attempt field changed');
          END;

          CREATE TRIGGER hyperliquid_attempt_no_delete
          BEFORE DELETE ON hyperliquid_submission_attempts
          BEGIN
            SELECT RAISE(ABORT, 'Hyperliquid attempts cannot be deleted');
          END;

          CREATE TRIGGER hyperliquid_nonce_fence_no_delete
          BEFORE DELETE ON hyperliquid_nonce_fences
          BEGIN
            SELECT RAISE(ABORT, 'Hyperliquid nonce fences cannot be deleted');
          END;
        `);
        this.#database.prepare(`
          INSERT INTO hyperliquid_journal_metadata (
            singleton, schema_version, journal_revision
          ) VALUES (1, ?, '0')
        `).run(SCHEMA_VERSION);
        this.#database.pragma(`user_version = ${SCHEMA_VERSION}`);
      });
      initialize.exclusive();
    } else {
      requireCondition(userVersion === SCHEMA_VERSION,
        `unsupported Hyperliquid journal schema version ${userVersion}`);
    }
    const metadata = this.#metadata();
    requireCondition(metadata.schemaVersion === SCHEMA_VERSION,
      'Hyperliquid journal metadata schema version mismatch');
  }

  #requireOpen(): void {
    requireCondition(!this.#closed && this.#database.open, 'Hyperliquid journal is closed');
  }

  #metadata(): { readonly schemaVersion: number; readonly journalRevision: bigint } {
    const row = this.#database.prepare<[], MetadataRow>(`
      SELECT schema_version, journal_revision
      FROM hyperliquid_journal_metadata WHERE singleton = 1
    `).get();
    requireCondition(row !== undefined && row.schema_version === SCHEMA_VERSION,
      'Hyperliquid journal metadata is missing or invalid');
    return Object.freeze({
      schemaVersion: row.schema_version,
      journalRevision: decodedBigint(row.journal_revision, 'journalRevision', true),
    });
  }

  #advanceRevision(previous: bigint, next: bigint): void {
    requireCondition(next === previous + 1n, 'journal revision increment is invalid');
    const update = this.#database.prepare(`
      UPDATE hyperliquid_journal_metadata SET journal_revision = ?
      WHERE singleton = 1 AND journal_revision = ?
    `).run(
      canonicalBigint(next, 'nextRevision', true),
      canonicalBigint(previous, 'previousRevision', true),
    );
    requireCondition(update.changes === 1, 'journal revision compare-and-set failed');
  }

  #attemptRow(attemptId: string): AttemptRow | undefined {
    return this.#database.prepare<[string], AttemptRow>(`
      SELECT * FROM hyperliquid_submission_attempts WHERE attempt_id = ?
    `).get(attemptId);
  }

  #requiredAttemptRow(attemptId: string): AttemptRow {
    const row = this.#attemptRow(attemptId);
    requireCondition(row !== undefined, 'attempt ID is unknown');
    return row;
  }

  #receipt(row: AttemptRow): HyperliquidJournalReceipt {
    const decoded = decodeRow(row);
    const journalVersion = this.#metadata().journalRevision;
    requireCondition(decoded.revision <= journalVersion,
      'attempt revision exceeds the journal revision');
    return Object.freeze({ journalVersion, record: decoded.record });
  }

  #requiredReceipt(attemptId: string): HyperliquidJournalReceipt {
    return this.#receipt(this.#requiredAttemptRow(attemptId));
  }

  #requireSignerLease(
    agentWallet: `0x${string}`,
    signerLeaseId: string,
    nowMs: bigint,
  ): void {
    const agent = this.#database.prepare<[string], AgentRow>(`
      SELECT signer_lease_id FROM hyperliquid_signer_agents WHERE agent_wallet = ?
    `).get(agentWallet);
    const lease = this.#database.prepare<[string], LeaseRow>(`
      SELECT agent_wallet FROM hyperliquid_signer_agents WHERE signer_lease_id = ?
    `).get(signerLeaseId);
    if (agent === undefined && lease === undefined) {
      this.#database.prepare(`
        INSERT INTO hyperliquid_signer_agents (
          agent_wallet, signer_lease_id, created_at_ms_decimal
        ) VALUES (?, ?, ?)
      `).run(agentWallet, signerLeaseId, canonicalBigint(nowMs, 'nowMs'));
      return;
    }
    requireCondition(agent?.signer_lease_id === signerLeaseId
      && lease?.agent_wallet === agentWallet, 'agent wallet or signer lease is already bound');
  }

  #insertAttempt(input: NormalizedPrepare, revision: bigint): void {
    this.#database.prepare(`
      INSERT INTO hyperliquid_submission_attempts (
        attempt_id, master_account, trading_account, account_kind,
        agent_wallet, signer_lease_id, nonce_decimal, expiry_decimal, vault_address,
        action_json, action_commitment_scheme, action_hash, record_hash,
        spot_client_order_id, perpetual_client_order_id,
        domain_id, domain_manifest_version, domain_manifest_hash,
        series_manifest_hash, execution_class_manifest_hash,
        order_hash, quote_hash, route_hash,
        status, revision_decimal, durable_revision,
        acknowledgement_id, rejection_id,
        created_at_ms_decimal, updated_at_ms_decimal
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'PREPARED', ?, NULL, NULL, NULL, ?, ?
      )
    `).run(
      input.attemptId,
      input.account.masterAccount,
      input.account.tradingAccount,
      input.account.accountKind,
      input.agentWallet,
      input.signerLeaseId,
      canonicalBigint(input.nonce, 'nonce'),
      canonicalBigint(input.expiresAfterMs, 'expiresAfterMs'),
      input.vaultAddress,
      actionJson(input.action),
      ACTION_COMMITMENT_SCHEME,
      input.actionHash,
      input.recordHash,
      input.spotClientOrderId,
      input.perpetualClientOrderId,
      input.domain.domainId,
      input.domain.domainManifestVersion,
      Buffer.from(input.domain.domainManifestHash),
      Buffer.from(input.commitments.seriesManifestHash),
      Buffer.from(input.commitments.executionClassManifestHash),
      Buffer.from(input.commitments.orderHash),
      Buffer.from(input.commitments.quoteHash),
      Buffer.from(input.commitments.routeHash),
      canonicalBigint(revision, 'revision'),
      canonicalBigint(input.nowMs, 'createdAtMs'),
      canonicalBigint(input.nowMs, 'updatedAtMs'),
    );
  }

  async #transition(
    input: TransitionInput,
    target: HyperliquidJournalStatus,
    allowed: readonly HyperliquidJournalStatus[],
    options: Readonly<{
      timestamp?: bigint;
      acknowledgementId?: string;
      rejectionId?: string;
      validate?: (record: HyperliquidJournalRecord) => void;
    }> = {},
  ): Promise<HyperliquidJournalReceipt> {
    this.#requireOpen();
    const attemptId = identifier(input.attemptId, 'attemptId');
    const transaction = this.#database.transaction(() => {
      const row = this.#requiredAttemptRow(attemptId);
      const decoded = decodeRow(row);
      if (decoded.record.status === target) {
        requireCondition(options.acknowledgementId === undefined
          || row.acknowledgement_id === options.acknowledgementId,
        'acknowledgement replay changed');
        requireCondition(options.rejectionId === undefined
          || row.rejection_id === options.rejectionId,
        'rejection replay changed');
        return;
      }
      requireCondition(allowed.includes(decoded.record.status),
        `${target} cannot follow ${decoded.record.status}`);
      options.validate?.(decoded.record);
      const metadata = this.#metadata();
      requireCondition(metadata.journalRevision === input.expectedVersion,
        'journal compare-and-set version mismatch');
      const nextRevision = metadata.journalRevision + 1n;
      const timestamp = options.timestamp ?? timestampNow();
      const update = this.#database.prepare(`
        UPDATE hyperliquid_submission_attempts
        SET status = ?, revision_decimal = ?, acknowledgement_id = ?, rejection_id = ?,
          updated_at_ms_decimal = ?
        WHERE attempt_id = ? AND status = ? AND revision_decimal = ?
      `).run(
        target,
        canonicalBigint(nextRevision, 'nextRevision'),
        options.acknowledgementId ?? row.acknowledgement_id,
        options.rejectionId ?? row.rejection_id,
        canonicalBigint(timestamp, 'updatedAtMs'),
        attemptId,
        decoded.record.status,
        canonicalBigint(decoded.revision, 'recordRevision'),
      );
      requireCondition(update.changes === 1, `${target} compare-and-set failed`);
      this.#advanceRevision(metadata.journalRevision, nextRevision);
    });
    transaction.immediate();
    return this.#requiredReceipt(attemptId);
  }
}
