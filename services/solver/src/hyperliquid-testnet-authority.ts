import { isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import { HttpTransport, InfoClient, TESTNET_API_URL } from '@nktkas/hyperliquid';
import type {
  ActiveAssetDataResponse,
  ClearinghouseStateResponse,
  ExtraAgentsResponse,
  SpotClearinghouseStateResponse,
  SubAccountsResponse,
  UserRoleResponse,
} from '@nktkas/hyperliquid/api/info';
import type { PackageAdmission } from '@naryx/protocol-types';
import type { HyperliquidSubmissionAccount } from './index.js';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^-?(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

export type HyperliquidAuthorityFenceState =
  | 'ACTIVE'
  | 'INITIALIZING'
  | 'INCIDENT_LOCKED'
  | 'FENCED'
  | 'MANUAL_TAKEOVER';

export interface HyperliquidAuthorityClearanceSnapshot {
  readonly environment: 'testnet';
  readonly apiUrl: typeof TESTNET_API_URL;
  readonly requestedAtMs: number;
  readonly receivedAtMs: number;
  readonly unexpectedOpenOrders: number;
  readonly unexpectedPositions: number;
  readonly reconciliationCommitment: `0x${string}`;
  readonly evidenceCommitment: `0x${string}`;
}

export interface HyperliquidAuthorityClearancePort {
  readonly environment: 'testnet';
  readonly apiUrl: typeof TESTNET_API_URL;
  read(account: HyperliquidSubmissionAccount): Promise<HyperliquidAuthorityClearanceSnapshot>;
}

export interface HyperliquidAuthorityClearanceInput {
  readonly reconciliationCommitment: `0x${string}`;
  readonly evidenceCommitment: `0x${string}`;
  readonly firstReviewerRoleCommitment: `0x${string}`;
  readonly secondReviewerRoleCommitment: `0x${string}`;
}

export interface HyperliquidAuthorityClearanceRecord extends HyperliquidAuthorityClearanceInput {
  readonly clearedAtMs: number;
}

export interface HyperliquidTestnetAuthoritySnapshot {
  readonly environment: 'testnet';
  readonly apiUrl: typeof TESTNET_API_URL;
  readonly requestedAtMs: number;
  readonly receivedAtMs: number;
  readonly agents: ExtraAgentsResponse;
  readonly agentRole: UserRoleResponse;
  readonly masterRole: UserRoleResponse;
  readonly tradingRole: UserRoleResponse;
  readonly subAccounts: SubAccountsResponse;
  readonly perpetualState: ClearinghouseStateResponse;
  readonly spotState: SpotClearinghouseStateResponse;
  readonly assetModes: readonly ActiveAssetDataResponse[];
}

export interface HyperliquidTestnetAuthorityReadPort {
  readonly environment: 'testnet';
  readonly apiUrl: typeof TESTNET_API_URL;
  read(
    account: HyperliquidSubmissionAccount,
    approvedAgent: `0x${string}`,
    perpetualCoins: readonly string[],
  ): Promise<HyperliquidTestnetAuthoritySnapshot>;
}

export interface HyperliquidTestnetAuthorityConfig {
  readonly account: HyperliquidSubmissionAccount;
  readonly approvedAgent: `0x${string}`;
  readonly incidentBufferMs: number;
  readonly expectedPortfolioMarginEnabled: boolean;
  readonly expectedPerpetualLeverageMode: 'cross' | 'isolated';
  readonly allowedSpotTokenIndices: readonly number[];
  readonly allowedPerpetualCoins: readonly string[];
  readonly maxSnapshotAgeMs: number;
  readonly maxClearanceAgeMs: number;
}

interface AuthorityRow {
  readonly state: string;
  readonly revision: number;
}

interface ClearanceRow {
  readonly reconciliation_commitment: string | null;
  readonly evidence_commitment: string | null;
  readonly first_reviewer_role_commitment: string | null;
  readonly second_reviewer_role_commitment: string | null;
  readonly cleared_at_ms: number | null;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Hyperliquid Testnet authority preflight failed: ${message}`);
}

function normalizedAddress(value: string, name: string): `0x${string}` {
  const normalized = value.toLowerCase();
  requireCondition(ADDRESS.test(normalized), `${name} is not a 20-byte address`);
  return normalized as `0x${string}`;
}

function isNonZeroDecimal(value: string, name: string): boolean {
  const match = DECIMAL.exec(value);
  requireCondition(match !== null, `${name} is not an exact decimal`);
  return BigInt(`${value.startsWith('-') ? '-' : ''}${match[1]}${match[2] ?? ''}`) !== 0n;
}

function validState(value: string): HyperliquidAuthorityFenceState {
  if (value === 'ACTIVE' || value === 'INITIALIZING' || value === 'INCIDENT_LOCKED'
    || value === 'FENCED' || value === 'MANUAL_TAKEOVER') return value;
  throw new Error('stored Hyperliquid authority fence state is invalid');
}

export class HyperliquidAuthorityFenceStore {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    if (!isAbsolute(databasePath)) throw new Error('authority fence database path must be absolute');
    this.#database = new Database(databasePath);
    this.#database.pragma('journal_mode = WAL');
    this.#database.pragma('synchronous = FULL');
    this.#initializeSchema();
  }

  state(): HyperliquidAuthorityFenceState {
    const row = this.#database.prepare<[], AuthorityRow>(
      'SELECT state, revision FROM hyperliquid_authority_fence WHERE singleton = 1',
    ).get();
    if (row === undefined || !Number.isSafeInteger(row.revision) || row.revision < 0) {
      throw new Error('Hyperliquid authority fence state is missing or invalid');
    }
    return validState(row.state);
  }

  activate(): HyperliquidAuthorityFenceState {
    const state = this.state();
    if (state === 'ACTIVE') return state;
    if (state !== 'INITIALIZING') return state;
    this.#transition('INITIALIZING', 'ACTIVE');
    return 'ACTIVE';
  }

  incidentLock(): HyperliquidAuthorityFenceState {
    const state = this.state();
    if (state === 'INCIDENT_LOCKED' || state === 'FENCED' || state === 'MANUAL_TAKEOVER') return state;
    this.#transition(state, 'INCIDENT_LOCKED');
    return 'INCIDENT_LOCKED';
  }

  fenced(): HyperliquidAuthorityFenceState {
    const state = this.state();
    if (state === 'FENCED' || state === 'MANUAL_TAKEOVER') return state;
    if (state !== 'INCIDENT_LOCKED') throw new Error('authority must be incident-locked before fenced');
    this.#transition('INCIDENT_LOCKED', 'FENCED');
    return 'FENCED';
  }

  manualTakeover(): HyperliquidAuthorityFenceState {
    const state = this.state();
    if (state === 'MANUAL_TAKEOVER') return state;
    this.#transition(state, 'MANUAL_TAKEOVER');
    return 'MANUAL_TAKEOVER';
  }

  close(): void {
    this.#database.close();
  }

  clearIncident(record: HyperliquidAuthorityClearanceRecord): HyperliquidAuthorityFenceState {
    if (this.state() !== 'INCIDENT_LOCKED') {
      throw new Error('only an incident-locked authority can be cleared');
    }
    const result = this.#database.prepare(`
      UPDATE hyperliquid_authority_fence
      SET state = 'ACTIVE', revision = revision + 1,
          reconciliation_commitment = ?, evidence_commitment = ?,
          first_reviewer_role_commitment = ?, second_reviewer_role_commitment = ?,
          cleared_at_ms = ?
      WHERE singleton = 1 AND state = 'INCIDENT_LOCKED'
    `).run(
      record.reconciliationCommitment,
      record.evidenceCommitment,
      record.firstReviewerRoleCommitment,
      record.secondReviewerRoleCommitment,
      record.clearedAtMs,
    );
    if (result.changes !== 1) throw new Error('concurrent Hyperliquid authority clearance');
    return 'ACTIVE';
  }

  clearanceRecord(): HyperliquidAuthorityClearanceRecord | null {
    const row = this.#database.prepare<[], ClearanceRow>(`
      SELECT reconciliation_commitment, evidence_commitment,
             first_reviewer_role_commitment, second_reviewer_role_commitment, cleared_at_ms
      FROM hyperliquid_authority_fence WHERE singleton = 1
    `).get();
    if (row === undefined || row.reconciliation_commitment === null
      || row.evidence_commitment === null || row.first_reviewer_role_commitment === null
      || row.second_reviewer_role_commitment === null || row.cleared_at_ms === null) return null;
    return Object.freeze({
      reconciliationCommitment: row.reconciliation_commitment as `0x${string}`,
      evidenceCommitment: row.evidence_commitment as `0x${string}`,
      firstReviewerRoleCommitment: row.first_reviewer_role_commitment as `0x${string}`,
      secondReviewerRoleCommitment: row.second_reviewer_role_commitment as `0x${string}`,
      clearedAtMs: row.cleared_at_ms,
    });
  }

  #transition(from: HyperliquidAuthorityFenceState, to: HyperliquidAuthorityFenceState): void {
    const result = this.#database.prepare(`
      UPDATE hyperliquid_authority_fence
      SET state = ?, revision = revision + 1
      WHERE singleton = 1 AND state = ?
    `).run(to, from);
    if (result.changes !== 1) throw new Error('concurrent Hyperliquid authority fence transition');
  }

  #initializeSchema(): void {
    const existing = this.#database.prepare<[], { sql: string }>(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hyperliquid_authority_fence'
    `).get();
    if (existing !== undefined && !existing.sql.includes('INITIALIZING')) {
      this.#database.transaction(() => {
        this.#database.exec('ALTER TABLE hyperliquid_authority_fence RENAME TO hyperliquid_authority_fence_v1');
        this.#createTable();
        this.#database.exec(`
          INSERT INTO hyperliquid_authority_fence (singleton, state, revision)
          SELECT singleton,
            CASE state
              WHEN 'ACTIVE' THEN 'ACTIVE'
              WHEN 'FENCE_PENDING' THEN 'INCIDENT_LOCKED'
              WHEN 'FENCED' THEN 'FENCED'
              ELSE 'MANUAL_TAKEOVER'
            END,
            revision
          FROM hyperliquid_authority_fence_v1;
          DROP TABLE hyperliquid_authority_fence_v1;
        `);
      })();
      return;
    }
    this.#createTable();
    this.#database.prepare(`
      INSERT OR IGNORE INTO hyperliquid_authority_fence (singleton, state, revision)
      VALUES (1, 'INITIALIZING', 0)
    `).run();
  }

  #createTable(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS hyperliquid_authority_fence (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'INITIALIZING', 'INCIDENT_LOCKED', 'FENCED', 'MANUAL_TAKEOVER')),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        reconciliation_commitment TEXT,
        evidence_commitment TEXT,
        first_reviewer_role_commitment TEXT,
        second_reviewer_role_commitment TEXT,
        cleared_at_ms INTEGER
      )
    `);
  }
}

export class HyperliquidSdkTestnetAuthorityReader implements HyperliquidTestnetAuthorityReadPort {
  readonly environment = 'testnet' as const;
  readonly apiUrl = TESTNET_API_URL;
  readonly #client: InfoClient;
  readonly #currentTimeMs: () => number;

  constructor(currentTimeMs: () => number = Date.now) {
    this.#client = new InfoClient({ transport: new HttpTransport({ isTestnet: true, apiUrl: TESTNET_API_URL }) });
    this.#currentTimeMs = currentTimeMs;
  }

  async read(
    account: HyperliquidSubmissionAccount,
    approvedAgent: `0x${string}`,
    perpetualCoins: readonly string[],
  ): Promise<HyperliquidTestnetAuthoritySnapshot> {
    const requestedAtMs = this.#currentTimeMs();
    const [agents, agentRole, masterRole, tradingRole, subAccounts, perpetualState, spotState] = await Promise.all([
      this.#client.extraAgents({ user: account.masterAccount }),
      this.#client.userRole({ user: approvedAgent }),
      this.#client.userRole({ user: account.masterAccount }),
      this.#client.userRole({ user: account.tradingAccount }),
      this.#client.subAccounts({ user: account.masterAccount }),
      this.#client.clearinghouseState({ user: account.tradingAccount }),
      this.#client.spotClearinghouseState({ user: account.tradingAccount }),
    ]);
    const assetModes = await Promise.all(perpetualCoins.map((coin) =>
      this.#client.activeAssetData({ user: account.tradingAccount, coin })));
    return Object.freeze({
      environment: this.environment,
      apiUrl: this.apiUrl,
      requestedAtMs,
      receivedAtMs: this.#currentTimeMs(),
      agents,
      agentRole,
      masterRole,
      tradingRole,
      subAccounts,
      perpetualState,
      spotState,
      assetModes: Object.freeze(assetModes),
    });
  }
}

export class HyperliquidTestnetAuthorityPreflight {
  readonly #reader: HyperliquidTestnetAuthorityReadPort;
  readonly #store: HyperliquidAuthorityFenceStore;
  readonly #config: HyperliquidTestnetAuthorityConfig;
  readonly #currentTimeMs: () => number;
  readonly #clearance?: HyperliquidAuthorityClearancePort;

  constructor(
    reader: HyperliquidTestnetAuthorityReadPort,
    store: HyperliquidAuthorityFenceStore,
    config: HyperliquidTestnetAuthorityConfig,
    currentTimeMs: () => number = Date.now,
    clearance?: HyperliquidAuthorityClearancePort,
  ) {
    requireCondition(reader.environment === 'testnet' && reader.apiUrl === TESTNET_API_URL,
      'authority reader is not exact Hyperliquid Testnet');
    this.#reader = reader;
    this.#store = store;
    this.#config = config;
    this.#currentTimeMs = currentTimeMs;
    if (clearance !== undefined) {
      requireCondition(clearance.environment === 'testnet' && clearance.apiUrl === TESTNET_API_URL,
        'clearance reader is not exact Hyperliquid Testnet');
      this.#clearance = clearance;
    }
  }

  async qualify(admission: PackageAdmission): Promise<void> {
    try {
      requireCondition(this.#store.state() === 'ACTIVE' || this.#store.state() === 'INITIALIZING',
        'durable authority fence blocks new submissions');
      const nowMs = this.#currentTimeMs();
      requireCondition(Number.isSafeInteger(nowMs) && nowMs > 0, 'trusted clock is invalid');
      const snapshot = await this.#reader.read(
        this.#config.account,
        this.#config.approvedAgent,
        this.#config.allowedPerpetualCoins,
      );
      this.#validateSnapshot(snapshot, admission, nowMs);
      requireCondition(this.#store.activate() === 'ACTIVE',
        'durable authority fence is not active');
    } catch (error) {
      this.#store.incidentLock();
      throw error;
    }
  }

  async clearIncident(input: HyperliquidAuthorityClearanceInput): Promise<void> {
    requireCondition(this.#store.state() === 'INCIDENT_LOCKED',
      'authority is not incident-locked');
    requireCondition(this.#clearance !== undefined, 'signerless clearance reader is unavailable');
    const commitments = [
      input.reconciliationCommitment,
      input.evidenceCommitment,
      input.firstReviewerRoleCommitment,
      input.secondReviewerRoleCommitment,
    ];
    requireCondition(commitments.every((value) => /^0x[0-9a-f]{64}$/.test(value)
      && !/^0x0+$/.test(value)), 'clearance commitments must be nonzero 32-byte hashes');
    requireCondition(input.firstReviewerRoleCommitment !== input.secondReviewerRoleCommitment,
      'incident reviewers must be distinct');
    const nowMs = this.#currentTimeMs();
    const snapshot = await this.#clearance.read(this.#config.account);
    requireCondition(snapshot.environment === 'testnet' && snapshot.apiUrl === TESTNET_API_URL,
      'clearance source is not exact Hyperliquid Testnet');
    requireCondition(Number.isSafeInteger(snapshot.requestedAtMs)
      && Number.isSafeInteger(snapshot.receivedAtMs)
      && snapshot.requestedAtMs <= snapshot.receivedAtMs
      && snapshot.receivedAtMs <= nowMs
      && nowMs - snapshot.requestedAtMs <= this.#config.maxClearanceAgeMs,
    'clearance observation is stale or has invalid timing');
    requireCondition(snapshot.unexpectedOpenOrders === 0 && snapshot.unexpectedPositions === 0,
      'clearance observation still has unexpected orders or positions');
    requireCondition(snapshot.reconciliationCommitment === input.reconciliationCommitment
      && snapshot.evidenceCommitment === input.evidenceCommitment,
    'clearance evidence commitments do not match the observation');
    this.#store.clearIncident(Object.freeze({ ...input, clearedAtMs: nowMs }));
  }

  #validateSnapshot(
    snapshot: HyperliquidTestnetAuthoritySnapshot,
    admission: PackageAdmission,
    nowMs: number,
  ): void {
    requireCondition(snapshot.environment === 'testnet' && snapshot.apiUrl === TESTNET_API_URL,
      'inventory source is not exact Hyperliquid Testnet');
    requireCondition(Number.isSafeInteger(snapshot.requestedAtMs)
      && Number.isSafeInteger(snapshot.receivedAtMs)
      && snapshot.requestedAtMs <= snapshot.receivedAtMs
      && snapshot.receivedAtMs <= nowMs
      && nowMs - snapshot.requestedAtMs <= this.#config.maxSnapshotAgeMs,
    'authority inventory is stale or has invalid timing');

    requireCondition(snapshot.masterRole.role === 'user', 'master account role is not user');
    if (this.#config.account.accountKind === 'MASTER') {
      requireCondition(snapshot.tradingRole.role === 'user'
        && this.#config.account.masterAccount === this.#config.account.tradingAccount,
      'master trading account relation is invalid');
    } else {
      requireCondition(snapshot.tradingRole.role === 'subAccount'
        && normalizedAddress(snapshot.tradingRole.data.master, 'trading role master')
          === this.#config.account.masterAccount,
      'subaccount role does not bind to the configured master');
      const matches = (snapshot.subAccounts ?? []).filter((entry) =>
        normalizedAddress(entry.subAccountUser, 'subaccount address')
          === this.#config.account.tradingAccount
        && normalizedAddress(entry.master, 'subaccount master')
          === this.#config.account.masterAccount);
      requireCondition(matches.length === 1, 'subaccount inventory is missing or ambiguous');
    }

    const recoveryDeadline = admission.order.hyperliquidRecoveryDeadlineValue;
    requireCondition(admission.order.expiryUnit === 'HYPERLIQUID_UNIX_MILLISECONDS'
      && admission.order.hyperliquidRecoveryExpiryUnit === 'HYPERLIQUID_UNIX_MILLISECONDS'
      && recoveryDeadline !== undefined,
    'package expiry semantics are not Hyperliquid milliseconds');
    const requiredUntil = BigInt(this.#config.incidentBufferMs)
      + (admission.order.expiryValue > recoveryDeadline
        ? admission.order.expiryValue : recoveryDeadline);
    requireCondition(requiredUntil <= BigInt(Number.MAX_SAFE_INTEGER),
      'required authority horizon is unsafe');

    const activeAgents = snapshot.agents.filter((agent) =>
      agent.validUntil === null || agent.validUntil > nowMs);
    requireCondition(activeAgents.length === 1, 'unexpected active agent approval exists');
    const approved = activeAgents[0];
    requireCondition(approved !== undefined
      && normalizedAddress(approved.address, 'approved agent') === this.#config.approvedAgent,
    'approved agent does not match the configured signer');
    requireCondition(approved.validUntil !== null
      && Number.isSafeInteger(approved.validUntil)
      && BigInt(approved.validUntil) >= requiredUntil,
    'approved agent expires before package recovery and incident horizon');
    requireCondition(snapshot.agentRole.role === 'agent'
      && normalizedAddress(snapshot.agentRole.data.user, 'agent role master')
        === this.#config.account.masterAccount,
    'agent role does not bind to the configured master');

    requireCondition(snapshot.spotState.portfolioMarginEnabled
      === this.#config.expectedPortfolioMarginEnabled,
    'portfolio margin mode does not match the configured account mode');
    const allowedTokens = new Set(this.#config.allowedSpotTokenIndices);
    for (const balance of snapshot.spotState.balances) {
      if (!('token' in balance)) {
        requireCondition(!isNonZeroDecimal(balance.total, `outcome balance ${balance.coin}`)
          && !isNonZeroDecimal(balance.hold, `outcome hold ${balance.coin}`),
        'outcome balance is outside the approved account scope');
        continue;
      }
      const nonZero = isNonZeroDecimal(balance.total, `spot balance ${balance.token}`)
        || isNonZeroDecimal(balance.hold, `spot hold ${balance.token}`)
        || (balance.borrowed !== undefined
          && isNonZeroDecimal(balance.borrowed, `spot borrowed ${balance.token}`))
        || (balance.supplied !== undefined
          && isNonZeroDecimal(balance.supplied, `spot supplied ${balance.token}`));
      requireCondition(!nonZero || allowedTokens.has(balance.token),
        `spot token ${balance.token} is outside the approved account scope`);
    }
    for (const escrow of snapshot.spotState.evmEscrows ?? []) {
      requireCondition(!isNonZeroDecimal(escrow.total, `EVM escrow ${escrow.token}`),
        'EVM escrow balance is outside the approved account scope');
    }
    const allowedCoins = new Set(this.#config.allowedPerpetualCoins);
    requireCondition(snapshot.assetModes.length === allowedCoins.size,
      'perpetual account mode inventory is incomplete');
    const observedModes = new Set<string>();
    for (const asset of snapshot.assetModes) {
      requireCondition(normalizedAddress(asset.user, 'active asset user')
        === this.#config.account.tradingAccount,
      'active asset account does not match the configured trading account');
      requireCondition(allowedCoins.has(asset.coin) && !observedModes.has(asset.coin),
        'perpetual account mode inventory is unexpected or duplicated');
      requireCondition(asset.leverage.type === this.#config.expectedPerpetualLeverageMode,
        `perpetual ${asset.coin} leverage mode is outside the approved account scope`);
      observedModes.add(asset.coin);
    }
    for (const entry of snapshot.perpetualState.assetPositions) {
      const position = entry.position;
      const nonZero = isNonZeroDecimal(position.szi, `perpetual position ${position.coin}`);
      requireCondition(!nonZero || allowedCoins.has(position.coin),
        `perpetual ${position.coin} is outside the approved account scope`);
      requireCondition(!nonZero || position.leverage.type === this.#config.expectedPerpetualLeverageMode,
        `perpetual ${position.coin} leverage mode is outside the approved account scope`);
    }
  }
}
