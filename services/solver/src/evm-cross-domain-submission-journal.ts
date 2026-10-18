import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getAddress, keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem';

export interface CrossDomainSubmission {
  readonly operationId: string;
  readonly to: Address;
  readonly data: Hex;
  readonly gas: bigint;
  readonly maximumFeePerGasWei: bigint;
}

export interface CrossDomainSubmissionPort {
  chainId(): Promise<number>;
  pendingNonce(): Promise<number>;
  sign(request: CrossDomainSubmission & { readonly nonce: number }): Promise<Hex>;
  broadcast(raw: Hex): Promise<Hex>;
  finalized(hash: Hex): Promise<'SUCCESS' | 'REVERTED' | undefined>;
}

interface SubmissionRow {
  operation_id: string;
  request_json: string;
  nonce: number;
  raw: Hex | null;
  hash: Hex | null;
  status: 'PENDING' | 'SUCCESS' | 'REVERTED';
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Cross-domain submission refused: ${message}`);
}

function privateDatabasePath(input: string): string {
  requireCondition(isAbsolute(input) && resolve(input) === input, 'journal path must be absolute and canonical');
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, '.git')) && dirname(root) !== root) root = dirname(root);
  requireCondition(!existsSync(join(root, '.git')) || !input.startsWith(root + sep), 'journal must be outside the repository');
  mkdirSync(dirname(input), { recursive: true, mode: 0o700 });
  requireCondition(realpathSync(dirname(input)) === dirname(input), 'journal parent must not contain symbolic links');
  const parent = lstatSync(dirname(input));
  requireCondition((parent.mode & 0o077) === 0 && parent.uid === process.getuid?.(), 'journal directory must be owner-only');
  if (!existsSync(input)) closeSync(openSync(input, 'wx', 0o600));
  const file = lstatSync(input);
  requireCondition(file.isFile() && !file.isSymbolicLink() && (file.mode & 0o077) === 0
    && file.uid === process.getuid?.(), 'journal must be an owner-only regular file');
  return input;
}

function requestJson(input: CrossDomainSubmission): string {
  requireCondition(/^[0-9a-f]{64}:(COMMIT|COMPENSATE|RELEASE)$/.test(input.operationId), 'operation identity is invalid');
  requireCondition(/^0x(?:[0-9a-fA-F]{2}){4,65536}$/.test(input.data), 'calldata is invalid or exceeds its bound');
  requireCondition(typeof input.gas === 'bigint' && input.gas > 0n && input.gas <= 30_000_000n
    && typeof input.maximumFeePerGasWei === 'bigint' && input.maximumFeePerGasWei > 0n
    && input.maximumFeePerGasWei < 2n ** 256n, 'gas bounds are invalid');
  return JSON.stringify({ to: getAddress(input.to), data: input.data.toLowerCase(),
    gas: input.gas.toString(), maximumFeePerGasWei: input.maximumFeePerGasWei.toString() });
}

export class EvmCrossDomainSubmissionJournal {
  readonly #db: Database.Database;
  readonly #chainId: number;
  readonly #signer: Address;
  readonly #port: CrossDomainSubmissionPort;

  constructor(input: Readonly<{ path: string; chainId: number; signer: Address;
    maximumGasBudgetWei: bigint; alreadySpentWei: bigint; port: CrossDomainSubmissionPort }>) {
    requireCondition(input.chainId === 84532 || input.chainId === 421614, 'only supported test chains may sign');
    requireCondition(typeof input.maximumGasBudgetWei === 'bigint' && input.maximumGasBudgetWei > 0n
      && input.maximumGasBudgetWei <= 10_000_000_000_000_000n
      && typeof input.alreadySpentWei === 'bigint' && input.alreadySpentWei >= 0n
      && input.alreadySpentWei <= input.maximumGasBudgetWei, 'testnet gas budget is invalid');
    this.#chainId = input.chainId;
    this.#signer = getAddress(input.signer);
    this.#port = input.port;
    this.#db = new Database(privateDatabasePath(input.path));
    try {
      this.#db.pragma('journal_mode = WAL');
      this.#db.pragma('synchronous = FULL');
      this.#db.pragma('busy_timeout = 5000');
      this.#db.pragma('trusted_schema = OFF');
      this.#db.exec(`CREATE TABLE IF NOT EXISTS binding (
        id INTEGER PRIMARY KEY CHECK(id=1), chain_id INTEGER NOT NULL, signer TEXT NOT NULL,
        cap_wei TEXT NOT NULL, initial_spent_wei TEXT NOT NULL, reserved_wei TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS submissions (
        operation_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, nonce INTEGER NOT NULL UNIQUE,
        raw TEXT, hash TEXT UNIQUE, status TEXT NOT NULL CHECK(status IN ('PENDING','SUCCESS','REVERTED')),
        CHECK((raw IS NULL) = (hash IS NULL))) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS single_pending ON submissions(status) WHERE status='PENDING';`);
      this.#db.prepare('INSERT OR IGNORE INTO binding VALUES(1,?,?,?,?,?)').run(input.chainId,
        this.#signer, input.maximumGasBudgetWei.toString(), input.alreadySpentWei.toString(), input.alreadySpentWei.toString());
      const binding = this.#db.prepare('SELECT * FROM binding WHERE id=1').get() as Record<string, unknown>;
      requireCondition(binding.chain_id === input.chainId && binding.signer === this.#signer
        && binding.cap_wei === input.maximumGasBudgetWei.toString()
        && binding.initial_spent_wei === input.alreadySpentWei.toString(), 'journal binding or approved budget changed');
    } catch (error) { this.#db.close(); throw error; }
  }

  close(): void { this.#db.close(); }

  async reconcilePending(): Promise<boolean> {
    await this.#assertChain();
    const row = this.#pending();
    if (row === undefined) return true;
    return (await this.observe(row.operation_id))?.status !== 'PENDING';
  }

  async observe(operationId: string): Promise<Readonly<{ hash: Hex | null; status: 'PENDING' | 'SUCCESS' | 'REVERTED' }> | undefined> {
    await this.#assertChain();
    const row = this.#get(operationId);
    if (row === undefined) return undefined;
    if (row.hash === null) return Object.freeze({ hash: null, status: 'PENDING' });
    requireCondition(row.raw !== null && keccak256(row.raw) === row.hash, 'durable transaction is corrupt');
    if (row.status !== 'PENDING') return Object.freeze({ hash: row.hash, status: row.status });
    const status = await this.#port.finalized(row.hash);
    if (status !== undefined) this.#resolve(operationId, status);
    return Object.freeze({ hash: row.hash, status: status ?? 'PENDING' });
  }

  async submit(requestInput: CrossDomainSubmission): Promise<Hex> {
    const request = requestJson(requestInput);
    const input = Object.freeze({ ...requestInput });
    await this.#assertChain();
    let row = this.#get(input.operationId);
    if (row === undefined) {
      await this.#reconcilePending();
      const nonce = await this.#port.pendingNonce();
      requireCondition(Number.isSafeInteger(nonce) && nonce >= 0, 'pending nonce is invalid');
      row = this.#db.transaction(() => {
        const known = this.#get(input.operationId);
        if (known !== undefined) return known;
        requireCondition(this.#pending() === undefined, 'signer has an unresolved transaction');
        const budget = this.#db.prepare('SELECT cap_wei,reserved_wei FROM binding WHERE id=1').get() as { cap_wei: string; reserved_wei: string };
        const next = BigInt(budget.reserved_wei) + input.gas * input.maximumFeePerGasWei;
        requireCondition(next <= BigInt(budget.cap_wei), 'approved testnet gas budget is exhausted');
        this.#db.prepare("INSERT INTO submissions VALUES(?,?,?,NULL,NULL,'PENDING')").run(input.operationId, request, nonce);
        this.#db.prepare('UPDATE binding SET reserved_wei=? WHERE id=1').run(next.toString());
        return this.#get(input.operationId)!;
      }).immediate();
    }
    requireCondition(row.request_json === request, 'operation payload changed');
    if (row.raw === null) {
      await this.#assertChain();
      const raw = await this.#port.sign({ ...input, nonce: row.nonce });
      await this.#verifyRaw(raw, input, row.nonce);
      this.#db.prepare('UPDATE submissions SET raw=?,hash=? WHERE operation_id=? AND raw IS NULL')
        .run(raw, keccak256(raw), input.operationId);
      row = this.#get(input.operationId)!;
    }
    requireCondition(row.raw !== null && row.hash !== null && keccak256(row.raw) === row.hash, 'durable transaction is corrupt');
    await this.#verifyRaw(row.raw, input, row.nonce);
    requireCondition(row.status !== 'REVERTED', 'transaction reverted; it will not be replaced automatically');
    if (row.status === 'SUCCESS') return row.hash;
    const status = await this.#port.finalized(row.hash);
    if (status !== undefined) {
      this.#resolve(row.operation_id, status);
      requireCondition(status === 'SUCCESS', 'transaction reverted; it will not be replaced automatically');
      return row.hash;
    }
    await this.#assertChain();
    const hash = await this.#port.broadcast(row.raw);
    requireCondition(hash.toLowerCase() === row.hash, 'RPC returned another transaction hash');
    return row.hash;
  }

  async #assertChain(): Promise<void> {
    requireCondition(await this.#port.chainId() === this.#chainId, 'RPC chain identity changed');
  }

  async #verifyRaw(raw: Hex, input: CrossDomainSubmission, nonce: number): Promise<void> {
    const tx = parseTransaction(raw);
    requireCondition(tx.type === 'eip1559' && tx.chainId === this.#chainId && tx.nonce === nonce
      && typeof tx.to === 'string' && getAddress(tx.to) === getAddress(input.to)
      && tx.data?.toLowerCase() === input.data.toLowerCase() && (tx.value ?? 0n) === 0n
      && tx.gas === input.gas && tx.maxFeePerGas === input.maximumFeePerGasWei
      && tx.maxPriorityFeePerGas === input.maximumFeePerGasWei
      && (tx.accessList === undefined || tx.accessList.length === 0), 'signed transaction differs from the reservation');
    requireCondition(getAddress(await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })) === this.#signer,
      'signed transaction uses another signer');
  }

  async #reconcilePending(): Promise<void> {
    const pending = this.#pending();
    if (pending?.hash === null || pending === undefined) return;
    const result = await this.#port.finalized(pending.hash);
    if (result !== undefined) this.#resolve(pending.operation_id, result);
  }

  #resolve(id: string, status: 'SUCCESS' | 'REVERTED'): void {
    this.#db.prepare("UPDATE submissions SET status=? WHERE operation_id=? AND status='PENDING'").run(status, id);
  }

  #get(id: string): SubmissionRow | undefined {
    return this.#db.prepare('SELECT * FROM submissions WHERE operation_id=?').get(id) as SubmissionRow | undefined;
  }

  #pending(): SubmissionRow | undefined {
    return this.#db.prepare("SELECT * FROM submissions WHERE status='PENDING'").get() as SubmissionRow | undefined;
  }
}
