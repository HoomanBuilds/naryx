import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import { hashTypedData, verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ApproveAgentTypes, approveAgent, ApiRequestError } from '@nktkas/hyperliquid/api/exchange';
import { HttpTransport, InfoClient, TESTNET_API_URL } from '@nktkas/hyperliquid';
import { writeEncryptedHyperliquidTestnetAgentKey } from './hyperliquid-testnet-agent-key.js';
import type { HyperliquidTestnetUserAccount } from './hyperliquid-testnet-per-user-runtime.js';

const OWNER = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const TTL_MS = 600_000;
const AGENT_LIFETIME_MS = 30 * 86_400_000;
const DOMAIN = { name: 'Naryx Hyperliquid Testnet Enrollment', version: '1', chainId: 421614 } as const;
const TYPES = { Enrollment: [
  { name: 'owner', type: 'address' }, { name: 'environment', type: 'string' },
  { name: 'nonce', type: 'bytes32' }, { name: 'expiresAtMs', type: 'uint48' },
] } as const;

type Row = { owner: `0x${string}`; nonce: `0x${string}`; expires_at_ms: number;
  stage: 'CHALLENGE' | 'PREPARED' | 'SUBMITTED' | 'ACTIVE'; agent_address: `0x${string}` | null;
  approval_nonce: number | null; agent_valid_until_ms: number | null };

export class HyperliquidEnrollmentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function check(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new HyperliquidEnrollmentError(code, message);
}

export function enrollmentTypedData(row: Pick<Row, 'owner' | 'nonce' | 'expires_at_ms'>) {
  return { domain: DOMAIN, types: TYPES, primaryType: 'Enrollment' as const,
    message: { owner: row.owner, environment: 'testnet', nonce: row.nonce, expiresAtMs: row.expires_at_ms } };
}

export function agentApprovalTypedData(owner: string, agentAddress: `0x${string}`, nonce: number, validUntilMs: number) {
  return {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 421614,
      verifyingContract: '0x0000000000000000000000000000000000000000' as const },
    types: ApproveAgentTypes, primaryType: 'HyperliquidTransaction:ApproveAgent' as const,
    message: { type: 'approveAgent', hyperliquidChain: 'Testnet', signatureChainId: '0x66eee' as const,
      agentAddress, agentName: `naryx-${owner.slice(2, 10)} valid_until ${validUntilMs}`, nonce },
  };
}

export interface HyperliquidEnrollmentVenue {
  checkApproval(owner: `0x${string}`, agent: `0x${string}`, requiredUntilMs: number): Promise<boolean>;
  submitApproval(owner: `0x${string}`, typedData: ReturnType<typeof agentApprovalTypedData>, signature: `0x${string}`): Promise<void>;
  checkAccount(owner: `0x${string}`): Promise<void>;
}

export function hyperliquidTestnetEnrollmentVenue(coins: readonly string[], incidentBufferMs: number, spotTokenIndices: readonly number[]): HyperliquidEnrollmentVenue {
  check(Number.isSafeInteger(incidentBufferMs) && incidentBufferMs > 0 && incidentBufferMs <= 604_800_000
    && spotTokenIndices.length > 0 && spotTokenIndices.every(i => Number.isSafeInteger(i) && i >= 0),
    'INVALID_POLICY', 'Enrollment authority policy is invalid.');
  check(coins.length > 0 && coins.includes('BTC') && coins.every(coin => /^[A-Za-z0-9:._-]{1,64}$/.test(coin)),
    'INVALID_POLICY', 'Enrollment requires an explicit testnet market policy.');
  const transport = new HttpTransport({ isTestnet: true, apiUrl: TESTNET_API_URL });
  const info = new InfoClient({ transport });
  return {
    async checkApproval(owner, agent, requiredUntilMs) {
      const agents = (await info.extraAgents({ user: owner })).filter(a => a.validUntil === null || a.validUntil > Date.now());
      check(agents.every(a => a.address.toLowerCase() === agent), 'OTHER_API_WALLET',
        'This account has another active API wallet. Revoke it in Hyperliquid Testnet before enabling this account.');
      const found = agents.find(a => a.address.toLowerCase() === agent);
      return found !== undefined && found.validUntil !== null && found.validUntil >= requiredUntilMs + incidentBufferMs;
    },
    async submitApproval(owner, typedData, signature) {
      await approveAgent({ transport, signatureChainId: '0x66eee', nonceManager: () => typedData.message.nonce,
        wallet: { address: owner, signTypedData: async (data: Parameters<typeof hashTypedData>[0]) => {
          check(hashTypedData(data) === hashTypedData(typedData), 'APPROVAL_MISMATCH', 'Approval payload changed.');
          return signature;
        } } }, { agentAddress: typedData.message.agentAddress, agentName: typedData.message.agentName });
    },
    async checkAccount(owner) {
      const dexes = [...new Set(coins.map(coin => coin.includes(':') ? coin.split(':')[0]! : ''))];
      const [role, abstraction, dexAbstraction, spot, modes, states, orders] = await Promise.all([
        info.userRole({ user: owner }), info.userAbstraction({ user: owner }), info.userDexAbstraction({ user: owner }),
        info.spotClearinghouseState({ user: owner }), Promise.all(coins.map(coin => info.activeAssetData({ user: owner, coin }))),
        Promise.all(dexes.map(dex => info.clearinghouseState({ user: owner, dex }))),
        Promise.all(dexes.map(dex => info.openOrders({ user: owner, dex }))),
      ]);
      check(role.role === 'user', 'ACCOUNT_NOT_FUNDED', 'Fund your Hyperliquid Testnet account before enabling execution.');
      check((abstraction === 'default' || abstraction === 'disabled') && dexAbstraction !== true
        && spot.portfolioMarginEnabled !== true, 'ACCOUNT_MODE', 'Use a Standard Hyperliquid Testnet account, not unified or portfolio margin.');
      check(spot.balances.every(balance => (!('token' in balance) || !spotTokenIndices.includes(balance.token))
        ? /^-?0(?:\.0+)?$/.test(balance.total) && /^-?0(?:\.0+)?$/.test(balance.hold) : true),
        'UNSUPPORTED_BALANCE', 'This account holds spot assets outside the enabled testnet policy. Use a dedicated account.');
      check(orders.every(a => a.length === 0) && states.every(a => a.assetPositions.every(p => /^-?0(?:\.0+)?$/.test(p.position.szi))),
        'ACCOUNT_NOT_FLAT', 'Close positions and orders in the supported Hyperliquid Testnet markets before enrolling.');
      check(modes.every(a => a.leverage.type === 'isolated'), 'MARGIN_MODE',
        'Set BTC and each supported HIP-3 market to isolated margin in Hyperliquid Testnet, then verify again.');
    },
  };
}

export class HyperliquidTestnetEnrollmentService {
  readonly #db: Database.Database;
  readonly #pending = new Map<string, Promise<unknown>>();
  readonly options: Readonly<{
    environment: 'TESTNET'; directory: string; encryptionKeyPath: string;
    bootstrapAccounts: readonly HyperliquidTestnetUserAccount[];
    hasAccount(owner: string): boolean; registerAccount(account: HyperliquidTestnetUserAccount): Promise<void>;
    venue: HyperliquidEnrollmentVenue; now?: () => number;
  }>;
  constructor(options: HyperliquidTestnetEnrollmentService['options']) {
    this.options = options;
    check(options.environment === 'TESTNET' && isAbsolute(options.directory), 'INVALID_ENVIRONMENT', 'Enrollment is testnet-only.');
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(options.directory);
    check(!stat.isSymbolicLink() && stat.isDirectory() && realpathSync(options.directory) === options.directory
      && (stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid()),
      'INVALID_DIRECTORY', 'Enrollment storage must be an owner-only canonical directory.');
    this.#db = new Database(join(options.directory, 'enrollment.sqlite'));
    this.#db.pragma('journal_mode=WAL'); this.#db.pragma('synchronous=FULL');
    this.#db.exec(`CREATE TABLE IF NOT EXISTS hyperliquid_user_enrollment (
      owner TEXT PRIMARY KEY, nonce TEXT NOT NULL, expires_at_ms INTEGER NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('CHALLENGE','PREPARED','SUBMITTED','ACTIVE')),
      agent_address TEXT, approval_nonce INTEGER, agent_valid_until_ms INTEGER,
      owner_signature TEXT, approval_signature TEXT)`);
  }
  #now() { return (this.options.now ?? Date.now)(); }
  #owner(owner: string): asserts owner is `0x${string}` { check(OWNER.test(owner), 'INVALID_OWNER', 'Use your connected EVM wallet.'); }
  #row(owner: string) { return this.#db.prepare('SELECT * FROM hyperliquid_user_enrollment WHERE owner=?').get(owner) as Row | undefined; }
  #account(row: Row): HyperliquidTestnetUserAccount {
    check(row.agent_address !== null, 'NOT_PREPARED', 'Prepare the API wallet first.');
    return { owner: row.owner, agentAddress: row.agent_address, agentKeyPath: join(this.options.directory, `${row.owner}.key`),
      journalPath: join(this.options.directory, `${row.owner}.journal.sqlite`), signerLeaseId: `user-${row.owner.slice(2)}-v1` };
  }
  status(owner: string) {
    this.#owner(owner);
    const row = this.#row(owner);
    return { environment: 'TESTNET', owner, stage: this.options.hasAccount(owner) ? 'ACTIVE' : row?.stage ?? 'NOT_ENROLLED',
      agentAddress: row?.agent_address ?? null, agentValidUntilMs: row?.agent_valid_until_ms ?? null,
      ...(row?.stage === 'CHALLENGE' ? { typedData: enrollmentTypedData(row) } : {}),
      ...(row?.agent_address !== null && row?.agent_address !== undefined
        ? { approvalTypedData: agentApprovalTypedData(owner, row.agent_address, row.approval_nonce!, row.agent_valid_until_ms!) } : {}) };
  }
  challenge(owner: string) {
    this.#owner(owner);
    const row = this.#row(owner);
    if (this.options.hasAccount(owner)) return this.status(owner);
    if (row !== undefined && (row.stage === 'PREPARED' && this.#now() - row.approval_nonce! >= TTL_MS
      || row.stage === 'CHALLENGE' && row.expires_at_ms <= this.#now())) {
      this.#db.prepare("UPDATE hyperliquid_user_enrollment SET stage='CHALLENGE',nonce=?,expires_at_ms=? WHERE owner=?")
        .run(`0x${randomBytes(32).toString('hex')}`, this.#now() + TTL_MS, owner);
      return this.status(owner);
    }
    if (row !== undefined && (row.stage !== 'CHALLENGE' || row.expires_at_ms > this.#now())) return this.status(owner);
    this.#db.prepare("DELETE FROM hyperliquid_user_enrollment WHERE stage='CHALLENGE' AND agent_address IS NULL AND expires_at_ms<=?").run(this.#now());
    const count = this.#db.prepare('SELECT count(*) AS n FROM hyperliquid_user_enrollment').get() as { n: number };
    check(count.n < 256, 'ENROLLMENT_FULL', 'Enrollment is temporarily at capacity.');
    this.#db.prepare(`INSERT INTO hyperliquid_user_enrollment(owner,nonce,expires_at_ms,stage) VALUES(?,?,?,'CHALLENGE')`)
      .run(owner, `0x${randomBytes(32).toString('hex')}`, this.#now() + TTL_MS);
    return this.status(owner);
  }
  async #serial(owner: string, work: () => Promise<unknown>) {
    check(!this.#pending.has(owner), 'ENROLLMENT_BUSY', 'This wallet already has an enrollment request in progress.');
    const pending = work(); this.#pending.set(owner, pending);
    try { return await pending; } finally { this.#pending.delete(owner); }
  }
  async prepare(owner: string, signature: `0x${string}`) {
    this.#owner(owner);
    return this.#serial(owner, async () => {
      const row = this.#row(owner);
      check(row !== undefined && row.stage === 'CHALLENGE' && row.expires_at_ms > this.#now(), 'CHALLENGE_EXPIRED', 'Request a fresh enrollment challenge.');
      check(await verifyTypedData({ ...enrollmentTypedData(row), address: owner, signature }), 'INVALID_SIGNATURE', 'Enrollment must be signed by this wallet.');
      await this.options.venue.checkAccount(owner);
      const count = this.#db.prepare("SELECT count(*) AS n FROM hyperliquid_user_enrollment WHERE agent_address IS NOT NULL").get() as { n: number };
      check(row.agent_address !== null || count.n + this.options.bootstrapAccounts.length < 64,
        'ENROLLMENT_FULL', 'The testnet account cohort is full.');
      let agent = row.agent_address;
      if (agent === null) {
        const privateKey = generatePrivateKey();
        agent = privateKeyToAccount(privateKey).address.toLowerCase() as `0x${string}`;
        writeEncryptedHyperliquidTestnetAgentKey(join(this.options.directory, `${owner}.key`), privateKey, this.options.encryptionKeyPath);
      }
      this.#db.prepare("UPDATE hyperliquid_user_enrollment SET stage='PREPARED',agent_address=?,approval_nonce=?,agent_valid_until_ms=?,owner_signature=? WHERE owner=? AND stage='CHALLENGE'")
        .run(agent, this.#now(), this.#now() + AGENT_LIFETIME_MS, signature, owner);
      return this.status(owner);
    });
  }
  async confirm(owner: string, signature?: `0x${string}`) {
    this.#owner(owner);
    return this.#serial(owner, async () => {
      if (this.options.hasAccount(owner)) return this.status(owner);
      const row = this.#row(owner);
      check(row?.agent_address !== null && row?.agent_address !== undefined, 'NOT_PREPARED', 'Prepare and approve an API wallet first.');
      const typedData = agentApprovalTypedData(owner, row.agent_address, row.approval_nonce!, row.agent_valid_until_ms!);
      let approved = await this.options.venue.checkApproval(owner, row.agent_address, this.#now() + TTL_MS);
      if (!approved && row.stage === 'PREPARED') {
        check(this.#now() - row.approval_nonce! < TTL_MS && signature !== undefined
          && await verifyTypedData({ ...typedData, address: owner, signature }), 'INVALID_SIGNATURE', 'Approve this API wallet using your connected wallet.');
        this.#db.prepare("UPDATE hyperliquid_user_enrollment SET stage='SUBMITTED',approval_signature=? WHERE owner=? AND stage='PREPARED'").run(signature, owner);
        try { await this.options.venue.submitApproval(owner, typedData, signature!); }
        catch (error) {
          if (error instanceof ApiRequestError) {
            this.#db.prepare("UPDATE hyperliquid_user_enrollment SET stage='PREPARED' WHERE owner=? AND stage='SUBMITTED'").run(owner);
            throw new HyperliquidEnrollmentError('APPROVAL_REJECTED', 'Hyperliquid rejected approval. Fund your testnet account and retry.');
          }
          return { ...this.status(owner), stage: 'APPROVAL_PENDING' };
        }
        approved = await this.options.venue.checkApproval(owner, row.agent_address, this.#now() + TTL_MS);
      }
      if (!approved) return { ...this.status(owner), stage: 'APPROVAL_PENDING' };
      await this.options.venue.checkAccount(owner);
      await this.options.registerAccount(this.#account(row));
      this.#db.prepare("UPDATE hyperliquid_user_enrollment SET stage='ACTIVE' WHERE owner=?").run(owner);
      return this.status(owner);
    });
  }
  async restore() {
    for (const row of this.#db.prepare("SELECT * FROM hyperliquid_user_enrollment WHERE stage='ACTIVE'").all() as Row[]) {
      check(!this.options.bootstrapAccounts.some(a => a.owner === row.owner), 'ACCOUNT_CONFLICT', 'An enrolled account overlaps the bootstrap registry.');
      await this.options.registerAccount(this.#account(row));
    }
  }
  close() { this.#db.close(); }
}
