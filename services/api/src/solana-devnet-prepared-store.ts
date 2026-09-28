import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { DomainRef, VersionedManifestRef } from "@naryx/protocol-types";
import {
  InMemoryPreparedSolanaDevnetStore,
  type PreparedSolanaDevnetRecord,
  type PreparedSolanaDevnetStore,
  type SolanaDevnetLifecycleBinding,
  type SolanaDevnetPostconditionBinding,
} from "./solana-devnet-runtime-ports.js";
import type { NormalizedCashCarryExecutionRequest, UnsignedSolanaDevnetMaterializationDto } from "./terminal-execution.js";

const SCHEMA_VERSION = 1;
let cachedRepositoryRoot: string | undefined;

type StoredEnvelope = Readonly<{
  request: NormalizedCashCarryExecutionRequest;
  materialization: UnsignedSolanaDevnetMaterializationDto;
  lifecycleBinding: Readonly<{
    attemptId: string;
    packageId: string;
    packageCommitmentHex: string;
    action: "ENTRY" | "EXIT";
    domain: Readonly<{ domainId: string; domainManifestVersion: number; domainManifestHashHex: string }>;
    settlementClass: SolanaDevnetLifecycleBinding["settlementClass"];
    evidenceSource: Readonly<{ subjectId: string; manifestVersion: number; manifestHashHex: string }>;
  }>;
  postconditionBinding?: Readonly<{
    coreProgram: string;
    receiptAccount: string;
    openPackageAccount: string;
    entryReceiptAccount: string;
    orderHashHex: string;
    quoteHashHex: string;
    routeHashHex: string;
    trader: string;
    solver: string;
    nonce: string;
    spotQuantityAtoms: string;
    perpQuantityAtoms: string;
    resourceAdmissionCommitmentHex: string;
    packageFillCommitmentHex: string;
    expectedOpenPackage?: SolanaDevnetPostconditionBinding["expectedOpenPackage"];
    recovery: boolean;
  }>;
}>;

function repositoryRoot(): string | undefined {
  if (cachedRepositoryRoot !== undefined) return cachedRepositoryRoot;
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      cachedRepositoryRoot = current;
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function databasePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value === ":memory:" || !isAbsolute(value)) {
    throw new Error("Prepared Solana store requires an absolute durable database path.");
  }
  const resolved = resolve(value);
  const root = repositoryRoot();
  if (root !== undefined && (resolved === root || resolved.startsWith(root + sep))) {
    throw new Error("Prepared Solana store database must remain outside the repository checkout.");
  }
  return resolved;
}

function hexBytes(value: string, name: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`Stored ${name} is invalid.`);
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function decimal(value: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Stored ${name} is invalid.`);
  return BigInt(value);
}

function serialize(record: PreparedSolanaDevnetRecord): string {
  const lifecycle = record.lifecycleBinding;
  const postcondition = record.postconditionBinding;
  const envelope: StoredEnvelope = {
    request: record.request,
    materialization: record.materialization,
    lifecycleBinding: {
      attemptId: lifecycle.attemptId,
      packageId: lifecycle.packageId,
      packageCommitmentHex: lifecycle.packageCommitmentHex,
      action: lifecycle.action,
      domain: {
        domainId: lifecycle.domain.domainId,
        domainManifestVersion: lifecycle.domain.domainManifestVersion,
        domainManifestHashHex: Buffer.from(lifecycle.domain.domainManifestHash).toString("hex"),
      },
      settlementClass: lifecycle.settlementClass,
      evidenceSource: {
        subjectId: lifecycle.evidenceSource.subjectId,
        manifestVersion: lifecycle.evidenceSource.manifestVersion,
        manifestHashHex: Buffer.from(lifecycle.evidenceSource.manifestHash).toString("hex"),
      },
    },
    ...(postcondition === undefined ? {} : {
      postconditionBinding: {
        ...postcondition,
        nonce: postcondition.nonce.toString(),
        spotQuantityAtoms: postcondition.spotQuantityAtoms.toString(),
        perpQuantityAtoms: postcondition.perpQuantityAtoms.toString(),
      },
    }),
  };
  return JSON.stringify(envelope);
}

function deserialize(payload: string, signature: string | null): PreparedSolanaDevnetRecord {
  let parsed: StoredEnvelope;
  try {
    parsed = JSON.parse(payload) as StoredEnvelope;
  } catch {
    throw new Error("Stored prepared Solana attempt is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || typeof parsed.lifecycleBinding !== "object" || parsed.lifecycleBinding === null) {
    throw new Error("Stored prepared Solana attempt is malformed.");
  }
  const lifecycle: SolanaDevnetLifecycleBinding = {
    ...parsed.lifecycleBinding,
    domain: {
      domainId: parsed.lifecycleBinding.domain.domainId,
      domainManifestVersion: parsed.lifecycleBinding.domain.domainManifestVersion,
      domainManifestHash: hexBytes(parsed.lifecycleBinding.domain.domainManifestHashHex, "lifecycle domain hash"),
    } as DomainRef,
    evidenceSource: {
      subjectId: parsed.lifecycleBinding.evidenceSource.subjectId,
      manifestVersion: parsed.lifecycleBinding.evidenceSource.manifestVersion,
      manifestHash: hexBytes(parsed.lifecycleBinding.evidenceSource.manifestHashHex, "evidence manifest hash"),
    } as VersionedManifestRef,
  };
  const storedPostcondition = parsed.postconditionBinding;
  const postcondition: SolanaDevnetPostconditionBinding | undefined = storedPostcondition === undefined ? undefined : {
    coreProgram: storedPostcondition.coreProgram,
    receiptAccount: storedPostcondition.receiptAccount,
    openPackageAccount: storedPostcondition.openPackageAccount,
    entryReceiptAccount: storedPostcondition.entryReceiptAccount,
    orderHashHex: storedPostcondition.orderHashHex,
    quoteHashHex: storedPostcondition.quoteHashHex,
    routeHashHex: storedPostcondition.routeHashHex,
    trader: storedPostcondition.trader,
    solver: storedPostcondition.solver,
    nonce: decimal(storedPostcondition.nonce, "postcondition nonce"),
    spotQuantityAtoms: decimal(storedPostcondition.spotQuantityAtoms, "postcondition spot quantity"),
    perpQuantityAtoms: decimal(storedPostcondition.perpQuantityAtoms, "postcondition perp quantity"),
    resourceAdmissionCommitmentHex: storedPostcondition.resourceAdmissionCommitmentHex,
    packageFillCommitmentHex: storedPostcondition.packageFillCommitmentHex,
    ...(storedPostcondition.expectedOpenPackage === undefined ? {} : {
      expectedOpenPackage: storedPostcondition.expectedOpenPackage,
    }),
    recovery: storedPostcondition.recovery,
  };
  const validator = new InMemoryPreparedSolanaDevnetStore();
  const validated = validator.save(parsed.request, parsed.materialization, lifecycle, postcondition);
  return signature === null ? validated : validator.bindSignature(validated.request.idempotencyKey, signature);
}

export class SqlitePreparedSolanaDevnetStore implements PreparedSolanaDevnetStore {
  readonly #db: Database.Database;
  readonly #select: Database.Statement;
  readonly #insert: Database.Statement;
  readonly #bind: Database.Statement;

  constructor(path: string) {
    const resolved = databasePath(path);
    mkdirSync(dirname(resolved), { recursive: true });
    this.#db = new Database(resolved);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta(version) SELECT ${SCHEMA_VERSION} WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
      CREATE TABLE IF NOT EXISTS solana_prepared_attempts (
        idempotency_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        bound_signature TEXT
      ) STRICT;
    `);
    const version = this.#db.prepare("SELECT version FROM schema_meta").pluck().get();
    if (version !== SCHEMA_VERSION) throw new Error("Prepared Solana store schema version is unsupported.");
    this.#select = this.#db.prepare("SELECT payload, bound_signature FROM solana_prepared_attempts WHERE idempotency_key = ?");
    this.#insert = this.#db.prepare("INSERT INTO solana_prepared_attempts(idempotency_key, payload, bound_signature) VALUES (?, ?, NULL)");
    this.#bind = this.#db.prepare("UPDATE solana_prepared_attempts SET bound_signature = ? WHERE idempotency_key = ? AND (bound_signature IS NULL OR bound_signature = ?)");
  }

  get(idempotencyKey: string): PreparedSolanaDevnetRecord | undefined {
    const row = this.#select.get(idempotencyKey) as { payload: unknown; bound_signature: unknown } | undefined;
    if (row === undefined) return undefined;
    if (typeof row.payload !== "string" || (row.bound_signature !== null && typeof row.bound_signature !== "string")) {
      throw new Error("Stored prepared Solana attempt row is malformed.");
    }
    const record = deserialize(row.payload, row.bound_signature as string | null);
    if (record.request.idempotencyKey !== idempotencyKey) {
      throw new Error("Stored prepared Solana attempt idempotency binding is corrupt.");
    }
    return record;
  }

  save(
    request: NormalizedCashCarryExecutionRequest,
    materialization: UnsignedSolanaDevnetMaterializationDto,
    lifecycleBinding: SolanaDevnetLifecycleBinding,
    postconditionBinding?: SolanaDevnetPostconditionBinding,
  ): PreparedSolanaDevnetRecord {
    const validator = new InMemoryPreparedSolanaDevnetStore();
    const candidate = validator.save(request, materialization, lifecycleBinding, postconditionBinding);
    const payload = serialize(candidate);
    const existing = this.get(request.idempotencyKey);
    if (existing !== undefined) {
      if (serialize(existing) !== payload) throw new Error(`Idempotency key "${request.idempotencyKey}" was already used with different preparation fields.`);
      return existing;
    }
    try {
      this.#insert.run(request.idempotencyKey, payload);
    } catch {
      const raced = this.get(request.idempotencyKey);
      if (raced === undefined || serialize(raced) !== payload) throw new Error("Prepared Solana attempt insert conflicted.");
      return raced;
    }
    return candidate;
  }

  bindSignature(idempotencyKey: string, signature: string): PreparedSolanaDevnetRecord {
    const current = this.get(idempotencyKey);
    if (current === undefined) throw new Error(`Unknown idempotency key "${idempotencyKey}".`);
    const validator = new InMemoryPreparedSolanaDevnetStore();
    validator.save(current.request, current.materialization, current.lifecycleBinding, current.postconditionBinding);
    const validated = validator.bindSignature(idempotencyKey, signature);
    const result = this.#bind.run(signature, idempotencyKey, signature);
    if (result.changes !== 1) throw new Error(`Idempotency key "${idempotencyKey}" is already bound to a different signature.`);
    return validated;
  }

  close(): void {
    this.#db.close();
  }
}
