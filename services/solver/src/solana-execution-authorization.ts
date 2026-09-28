import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bs58 from 'bs58';
import {
  bytesEqual,
  packageOrderHash,
  quoteHash,
  routeHash,
  solverSignatureDigest,
  type PackageAdmission,
} from '@naryx/protocol-types';
import type { SolanaLocalEnvironmentManifest } from '@naryx/adapter-core';

const ATTEMPT_ID = /^local-atomic-[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{128}$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface SolanaExecutionAuthorizationRequest {
  readonly attemptId: string;
}

export interface SolanaExecutionAuthorizationPayload {
  readonly executionDigest: Uint8Array;
  readonly programId: string;
  readonly solver: string;
  readonly nonce: bigint;
  readonly expirySlot: bigint;
}

export interface SolanaExecutionAuthorizationCompiler {
  compileAuthorizationPayload(
    admission: PackageAdmission,
  ): SolanaExecutionAuthorizationPayload;
}

export type SelectedSolanaAdmissionProvider = (
  attemptId: string,
) => PackageAdmission | undefined | Promise<PackageAdmission | undefined>;

export interface SolanaExecutionSigner {
  readonly verificationKey: Uint8Array;
  signDigest(digest: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export interface SolanaExecutionAuthorizationRecord {
  readonly attemptId: string;
  readonly domainId: string;
  readonly domainManifestVersion: number;
  readonly domainManifestHash: string;
  readonly solver: string;
  readonly nonce: bigint;
  readonly expirySlot: bigint;
  readonly executionDigest: string;
  readonly solverSignature: string | null;
}

export interface SolanaExecutionAuthorizationStore {
  reserve(record: SolanaExecutionAuthorizationRecord): SolanaExecutionAuthorizationRecord;
  complete(attemptId: string, executionDigest: string, solverSignature: string): SolanaExecutionAuthorizationRecord;
  close(): void;
}

export interface SolanaExecutionAuthorization {
  readonly version: 1;
  readonly attemptId: string;
  readonly domainId: string;
  readonly domainManifestVersion: number;
  readonly domainManifestHash: string;
  readonly solver: string;
  readonly nonce: string;
  readonly expirySlot: string;
  readonly executionDigest: string;
  readonly solverSignature: string;
}

export interface SolanaExecutionAuthorizationPort {
  authorize(request: SolanaExecutionAuthorizationRequest): Promise<SolanaExecutionAuthorization>;
}

export class SolanaExecutionAuthorizationError extends Error {
  readonly code: 'INVALID_REQUEST' | 'ATTEMPT_NOT_FOUND' | 'BINDING_MISMATCH'
    | 'EXPIRED' | 'SOLVER_MISMATCH' | 'NONCE_REPLAY' | 'SIGNING_FAILED';

  constructor(code: SolanaExecutionAuthorizationError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'SolanaExecutionAuthorizationError';
    this.code = code;
  }
}

function fail(code: SolanaExecutionAuthorizationError['code'], message: string): never {
  throw new SolanaExecutionAuthorizationError(code, message);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function sameDomain(admission: PackageAdmission, manifest: SolanaLocalEnvironmentManifest): boolean {
  const expected = manifest.runtime.catalog.domain;
  return [admission.order.domain, admission.quote.domain, admission.route.domain].every((domain) =>
    domain.domainId === expected.domainId
      && domain.domainManifestVersion === expected.domainManifestVersion
      && bytesEqual(domain.domainManifestHash, expected.domainManifestHash));
}

function expectedAttemptId(admission: PackageAdmission): string {
  return `local-atomic-${createHash('sha256')
    .update('NARYX/local-execution-attempt/v1', 'ascii')
    .update(admission.orderHash)
    .update(admission.routeHash)
    .update(admission.quoteHash)
    .digest('hex')}`;
}

function verifyAdmissionIdentity(admission: PackageAdmission, attemptId: string): void {
  if (!bytesEqual(packageOrderHash(admission.order), admission.orderHash)
    || !bytesEqual(routeHash(admission.route), admission.routeHash)
    || !bytesEqual(quoteHash(admission.quote), admission.quoteHash)
    || expectedAttemptId(admission) !== attemptId) {
    fail('BINDING_MISMATCH', 'selected admission does not match its canonical attempt identity');
  }
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(solverSignatureDigest(admission.quote)),
      createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(admission.quote.solverVerificationKey)]),
        format: 'der',
        type: 'spki',
      }),
      Buffer.from(admission.quote.signature),
    );
  } catch {
    valid = false;
  }
  if (!valid) fail('BINDING_MISMATCH', 'selected quote signature is invalid');
}

function requireManifestBindings(
  admission: PackageAdmission,
  manifest: SolanaLocalEnvironmentManifest,
): void {
  if (manifest.network !== 'local-validator' || manifest.mainnet !== false
    || admission.order.environment !== 'local' || admission.quote.environment !== 'local'
    || admission.route.environment !== 'local' || !sameDomain(admission, manifest)) {
    fail('BINDING_MISMATCH', 'selected admission is outside the manifest-validated local domain');
  }
  const expected = new Map<string, string>([
    ['trader', manifest.identities.trader],
    ['solver', manifest.identities.solver],
    ['market', manifest.accounts.market],
    ['position', manifest.accounts.position],
    ['trader-base', manifest.accounts['trader-base']],
    ['trader-quote', manifest.accounts['trader-quote']],
    ['spot-base-vault', manifest.accounts.spotBaseVault],
    ['spot-quote-vault', manifest.accounts.spotQuoteVault],
    ['perp-quote-vault', manifest.accounts.perpQuoteVault],
    ['conformance-program', manifest.programs.conformanceVenue.id],
  ]);
  const actual = new Map<string, string>(admission.route.accountBindings.map((binding) => [
    binding.routeBindingId,
    binding.accountIdentity,
  ]));
  if (actual.size !== admission.route.accountBindings.length
    || [...expected].some(([name, value]) => actual.get(name) !== value)
    || admission.order.owner !== manifest.identities.trader
    || admission.route.solver !== manifest.identities.solver
    || admission.quote.solverId !== manifest.identities.solver
    || !bytesEqual(admission.quote.solverVerificationKey, bs58.decode(manifest.identities.solver))) {
    fail('BINDING_MISMATCH', 'selected admission contains non-manifest account substitutions');
  }
}

function signerIdentity(signer: SolanaExecutionSigner): string {
  if (!(signer.verificationKey instanceof Uint8Array) || signer.verificationKey.length !== 32) {
    fail('SOLVER_MISMATCH', 'configured solver verification key is invalid');
  }
  return bs58.encode(signer.verificationKey);
}

function response(record: SolanaExecutionAuthorizationRecord): SolanaExecutionAuthorization {
  if (record.solverSignature === null) fail('SIGNING_FAILED', 'authorization reservation is incomplete');
  return Object.freeze({
    version: 1,
    attemptId: record.attemptId,
    domainId: record.domainId,
    domainManifestVersion: record.domainManifestVersion,
    domainManifestHash: record.domainManifestHash,
    solver: record.solver,
    nonce: record.nonce.toString(),
    expirySlot: record.expirySlot.toString(),
    executionDigest: record.executionDigest,
    solverSignature: record.solverSignature,
  });
}

export class SolanaExecutionAuthorizationService implements SolanaExecutionAuthorizationPort {
  readonly #manifest: SolanaLocalEnvironmentManifest;
  readonly #selectedAdmission: SelectedSolanaAdmissionProvider;
  readonly #compiler: SolanaExecutionAuthorizationCompiler;
  readonly #signer: SolanaExecutionSigner;
  readonly #store: SolanaExecutionAuthorizationStore;
  readonly #readSlot: () => bigint | Promise<bigint>;

  constructor(options: Readonly<{
    manifest: SolanaLocalEnvironmentManifest;
    selectedAdmission: SelectedSolanaAdmissionProvider;
    compiler: SolanaExecutionAuthorizationCompiler;
    signer: SolanaExecutionSigner;
    store: SolanaExecutionAuthorizationStore;
    readSlot: () => bigint | Promise<bigint>;
  }>) {
    this.#manifest = options.manifest;
    this.#selectedAdmission = options.selectedAdmission;
    this.#compiler = options.compiler;
    this.#signer = options.signer;
    this.#store = options.store;
    this.#readSlot = options.readSlot;
    if (signerIdentity(options.signer) !== options.manifest.identities.solver) {
      fail('SOLVER_MISMATCH', 'configured external solver key does not match the environment manifest');
    }
  }

  async authorize(request: SolanaExecutionAuthorizationRequest): Promise<SolanaExecutionAuthorization> {
    if (typeof request !== 'object' || request === null
      || Object.keys(request).length !== 1 || !ATTEMPT_ID.test(request.attemptId)) {
      fail('INVALID_REQUEST', 'authorization request must contain only a canonical attemptId');
    }
    const admission = await this.#selectedAdmission(request.attemptId);
    if (admission === undefined) fail('ATTEMPT_NOT_FOUND', 'selected execution attempt was not found');
    verifyAdmissionIdentity(admission, request.attemptId);
    requireManifestBindings(admission, this.#manifest);
    const payload = this.#compiler.compileAuthorizationPayload(admission);
    const currentSlot = await this.#readSlot();
    if (typeof currentSlot !== 'bigint' || currentSlot <= 0n
      || currentSlot < BigInt(this.#manifest.governance.solverActivationSlot)) {
      fail('SOLVER_MISMATCH', 'manifest solver is not active at the current slot');
    }
    if (payload.expirySlot <= currentSlot) fail('EXPIRED', 'selected execution is expired');
    const expectedExpiry = [
      admission.order.expiryValue,
      admission.quote.validUntilValue,
      admission.route.routeExpiryValue,
    ].reduce((left, right) => left < right ? left : right);
    if (payload.programId !== this.#manifest.programs.core.id
      || payload.solver !== this.#manifest.identities.solver
      || payload.nonce !== admission.order.nonce || payload.nonce <= 0n
      || payload.expirySlot !== expectedExpiry || payload.executionDigest.length !== 32
      || payload.executionDigest.every((byte) => byte === 0)) {
      fail('BINDING_MISMATCH', 'compiled authorization payload does not match the manifest');
    }
    const domain = this.#manifest.runtime.catalog.domain;
    const reserved = this.#store.reserve({
      attemptId: request.attemptId,
      domainId: domain.domainId,
      domainManifestVersion: domain.domainManifestVersion,
      domainManifestHash: hex(domain.domainManifestHash),
      solver: payload.solver,
      nonce: payload.nonce,
      expirySlot: payload.expirySlot,
      executionDigest: hex(payload.executionDigest),
      solverSignature: null,
    });
    if (reserved.solverSignature !== null) return response(reserved);
    let signature: Uint8Array;
    try {
      signature = await this.#signer.signDigest(Uint8Array.from(payload.executionDigest));
    } catch {
      fail('SIGNING_FAILED', 'external solver signing failed');
    }
    if (!(signature instanceof Uint8Array) || signature.length !== 64
      || !verify(null, Buffer.from(payload.executionDigest), createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(this.#signer.verificationKey)]),
        format: 'der', type: 'spki',
      }), Buffer.from(signature))) {
      fail('SIGNING_FAILED', 'external solver returned an invalid Ed25519 signature');
    }
    return response(this.#store.complete(request.attemptId, hex(payload.executionDigest), hex(signature)));
  }
}

let cachedRepositoryRoot: string | undefined;

function repositoryRoot(): string | undefined {
  if (cachedRepositoryRoot !== undefined) return cachedRepositoryRoot;
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, '.git'))) return cachedRepositoryRoot = current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function databasePath(value: string): string {
  if (!isAbsolute(value) || value === ':memory:') throw new Error('authorization database path must be absolute');
  const path = resolve(value);
  const root = repositoryRoot();
  if (root !== undefined && (path === root || path.startsWith(resolve(root) + sep))) {
    throw new Error('authorization database must remain outside the repository');
  }
  return path;
}

function readRecord(row: Record<string, unknown> | undefined): SolanaExecutionAuthorizationRecord | undefined {
  if (row === undefined) return undefined;
  if (typeof row.attempt_id !== 'string' || !ATTEMPT_ID.test(row.attempt_id)
    || typeof row.domain_id !== 'string' || row.domain_id.length === 0
    || typeof row.domain_manifest_version !== 'number' || !Number.isSafeInteger(row.domain_manifest_version)
    || typeof row.domain_manifest_hash !== 'string' || !HASH.test(row.domain_manifest_hash)
    || typeof row.solver !== 'string' || row.solver.length === 0
    || typeof row.nonce_decimal !== 'string' || !/^[1-9]\d*$/.test(row.nonce_decimal)
    || typeof row.expiry_slot_decimal !== 'string' || !/^[1-9]\d*$/.test(row.expiry_slot_decimal)
    || typeof row.execution_digest !== 'string' || !HASH.test(row.execution_digest)
    || (row.solver_signature !== null
      && (typeof row.solver_signature !== 'string' || !SIGNATURE.test(row.solver_signature)))) {
    throw new Error('stored Solana execution authorization is invalid');
  }
  return Object.freeze({
    attemptId: row.attempt_id,
    domainId: row.domain_id,
    domainManifestVersion: row.domain_manifest_version,
    domainManifestHash: row.domain_manifest_hash,
    solver: row.solver,
    nonce: BigInt(row.nonce_decimal),
    expirySlot: BigInt(row.expiry_slot_decimal),
    executionDigest: row.execution_digest,
    solverSignature: row.solver_signature as string | null,
  });
}

function sameReservation(
  left: SolanaExecutionAuthorizationRecord,
  right: SolanaExecutionAuthorizationRecord,
): boolean {
  return left.attemptId === right.attemptId && left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && left.domainManifestHash === right.domainManifestHash && left.solver === right.solver
    && left.nonce === right.nonce && left.expirySlot === right.expirySlot
    && left.executionDigest === right.executionDigest;
}

export class SqliteSolanaExecutionAuthorizationStore implements SolanaExecutionAuthorizationStore {
  readonly #db: Database.Database;

  constructor(value: string) {
    const path = databasePath(value);
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = FULL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS solana_execution_authorizations (
        attempt_id TEXT PRIMARY KEY,
        domain_id TEXT NOT NULL,
        domain_manifest_version INTEGER NOT NULL,
        domain_manifest_hash TEXT NOT NULL,
        solver TEXT NOT NULL,
        nonce_decimal TEXT NOT NULL,
        expiry_slot_decimal TEXT NOT NULL,
        execution_digest TEXT NOT NULL,
        solver_signature TEXT,
        UNIQUE (domain_id, domain_manifest_version, domain_manifest_hash, solver, nonce_decimal)
      )
    `);
  }

  #get(attemptId: string): SolanaExecutionAuthorizationRecord | undefined {
    return readRecord(this.#db.prepare(`
      SELECT attempt_id, domain_id, domain_manifest_version, domain_manifest_hash, solver,
        nonce_decimal, expiry_slot_decimal, execution_digest, solver_signature
      FROM solana_execution_authorizations WHERE attempt_id = ?
    `).get(attemptId) as Record<string, unknown> | undefined);
  }

  reserve(record: SolanaExecutionAuthorizationRecord): SolanaExecutionAuthorizationRecord {
    if (!ATTEMPT_ID.test(record.attemptId) || !HASH.test(record.domainManifestHash)
      || !HASH.test(record.executionDigest) || record.nonce <= 0n || record.expirySlot <= 0n
      || record.solverSignature !== null) {
      throw new Error('authorization reservation is invalid');
    }
    try {
      this.#db.prepare(`
        INSERT INTO solana_execution_authorizations (
          attempt_id, domain_id, domain_manifest_version, domain_manifest_hash, solver,
          nonce_decimal, expiry_slot_decimal, execution_digest, solver_signature
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(record.attemptId, record.domainId, record.domainManifestVersion,
        record.domainManifestHash, record.solver, record.nonce.toString(),
        record.expirySlot.toString(), record.executionDigest);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code !== 'string' || !code.startsWith('SQLITE_CONSTRAINT')) throw error;
    }
    const stored = this.#get(record.attemptId);
    if (stored === undefined || !sameReservation(stored, record)) {
      fail('NONCE_REPLAY', 'execution nonce is already reserved by a conflicting authorization');
    }
    return stored;
  }

  complete(attemptId: string, executionDigest: string, solverSignature: string): SolanaExecutionAuthorizationRecord {
    if (!ATTEMPT_ID.test(attemptId) || !HASH.test(executionDigest) || !SIGNATURE.test(solverSignature)) {
      throw new Error('completed authorization is invalid');
    }
    this.#db.prepare(`
      UPDATE solana_execution_authorizations SET solver_signature = ?
      WHERE attempt_id = ? AND execution_digest = ? AND solver_signature IS NULL
    `).run(solverSignature, attemptId, executionDigest);
    const stored = this.#get(attemptId);
    if (stored === undefined || stored.executionDigest !== executionDigest
      || stored.solverSignature !== solverSignature) {
      fail('NONCE_REPLAY', 'authorization completion conflicts with durable state');
    }
    return stored;
  }

  close(): void {
    this.#db.close();
  }
}
