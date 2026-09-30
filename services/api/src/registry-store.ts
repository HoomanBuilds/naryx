import type Database from "better-sqlite3";
import {
  bytesEqual,
  domainManifest,
  domainManifestBytes,
  domainManifestHash,
  marketManifest,
  marketManifestBytes,
  marketManifestHash,
  packageTemplateManifest,
  packageTemplateManifestBytes,
  packageTemplateManifestHash,
  parseProtocolJson,
  solverCapabilityManifest,
  solverCapabilityManifestHash,
  stringifyProtocolJson,
  toHex,
  unsignedSolverCapabilityManifestBytes,
} from "@naryx/protocol-types";
import type {
  DomainManifestInput,
  MarketManifestInput,
  PackageTemplateManifestInput,
  SolverCapabilityManifestInput,
} from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";
import { verifyEd25519 } from "./ed25519.js";

export type RegistryKind = "DOMAIN" | "MARKET" | "PACKAGE_TEMPLATE" | "SOLVER_CAPABILITY";

export class RegistryStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RegistryStoreError";
    this.code = code;
  }
}

export interface RegisteredDocument<T> {
  readonly kind: RegistryKind;
  readonly subjectId: string;
  readonly subjectVersion: number;
  readonly environment: string;
  readonly documentHashHex: string;
  readonly registeredAtMs: number;
  readonly document: T;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS registry_documents (
  document_hash BLOB PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('DOMAIN', 'MARKET', 'PACKAGE_TEMPLATE', 'SOLVER_CAPABILITY')),
  subject_id TEXT NOT NULL,
  subject_version INTEGER NOT NULL CHECK (subject_version >= 0),
  environment TEXT NOT NULL,
  canonical_bytes BLOB NOT NULL,
  document_json TEXT NOT NULL,
  registered_at_ms INTEGER NOT NULL,
  UNIQUE (kind, subject_id, subject_version)
) STRICT;
CREATE INDEX IF NOT EXISTS registry_by_subject ON registry_documents(kind, subject_id, subject_version);
CREATE TRIGGER IF NOT EXISTS reject_registry_change BEFORE UPDATE ON registry_documents BEGIN SELECT RAISE(ABORT, 'registry documents are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_registry_delete BEFORE DELETE ON registry_documents BEGIN SELECT RAISE(ABORT, 'registry documents are immutable'); END;
`;

function guarded<T>(code: string, message: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof RegistryStoreError) throw error;
    throw new RegistryStoreError(code, `${message} ${error instanceof Error ? error.message : ""}`.trim());
  }
}

interface Row {
  document_hash: Uint8Array;
  kind: RegistryKind;
  subject_id: string;
  subject_version: number;
  environment: string;
  document_json: string;
  registered_at_ms: number;
}

/**
 * Immutable public registries of domain, market, package-template, and solver capability
 * manifests. Every document is validated by its kernel schema and stored under its canonical
 * hash; a published identity and version never changes content. A solver manifest is admitted
 * only with a valid operator signature over its manifest hash and a strictly increasing nonce.
 */
export class SqliteRegistryStore {
  private readonly db: Database.Database;
  private readonly clock: () => number;

  constructor(dbPath: string, options: { readonly clock?: () => number } = {}) {
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new RegistryStoreError(code, message));
    this.clock = options.clock ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  private insert(
    kind: RegistryKind,
    subjectId: string,
    subjectVersion: number,
    environment: string,
    bytes: Uint8Array,
    hash: Uint8Array,
    document: unknown,
    precheck: () => void = () => undefined,
  ): { created: boolean; documentHashHex: string } {
    return this.db.transaction(() => {
      precheck();
      const existing = this.db
        .prepare("SELECT document_hash FROM registry_documents WHERE kind = ? AND subject_id = ? AND subject_version = ?")
        .get(kind, subjectId, subjectVersion) as { document_hash: Uint8Array } | undefined;
      if (existing !== undefined) {
        if (!bytesEqual(existing.document_hash, hash)) {
          throw new RegistryStoreError("DOCUMENT_CONFLICT", `${kind} ${subjectId} version ${subjectVersion} is already registered with different content.`);
        }
        return { created: false, documentHashHex: toHex(hash) };
      }
      this.db
        .prepare(
          "INSERT INTO registry_documents (document_hash, kind, subject_id, subject_version, environment, canonical_bytes, document_json, registered_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(hash, kind, subjectId, subjectVersion, environment, bytes, stringifyProtocolJson(document), this.clock());
      return { created: true, documentHashHex: toHex(hash) };
    }).immediate();
  }

  registerDomain(input: DomainManifestInput): { created: boolean; documentHashHex: string } {
    const manifest = guarded("INVALID_DOCUMENT", "Domain manifest is invalid.", () => domainManifest(input));
    return this.insert("DOMAIN", manifest.domainId, manifest.manifestVersion, manifest.environment, domainManifestBytes(manifest), domainManifestHash(manifest), manifest);
  }

  registerMarket(input: MarketManifestInput): { created: boolean; documentHashHex: string } {
    const manifest = guarded("INVALID_DOCUMENT", "Market manifest is invalid.", () => marketManifest(input));
    const domain = this.latest("DOMAIN", manifest.domain.domainId, manifest.domain.domainManifestVersion);
    if (domain === undefined || domain.documentHashHex !== toHex(manifest.domain.domainManifestHash)) {
      throw new RegistryStoreError("UNKNOWN_REFERENCE", "A market must reference a registered domain manifest by exact version and hash.");
    }
    return this.insert("MARKET", manifest.marketId, manifest.manifestVersion, manifest.environment, marketManifestBytes(manifest), marketManifestHash(manifest), manifest);
  }

  registerPackageTemplate(input: PackageTemplateManifestInput): { created: boolean; documentHashHex: string } {
    const manifest = guarded("INVALID_DOCUMENT", "Package template manifest is invalid.", () => packageTemplateManifest(input));
    for (const domain of manifest.supportedDomains) {
      const registered = this.latest("DOMAIN", domain.domainId, domain.domainManifestVersion);
      if (registered === undefined || registered.documentHashHex !== toHex(domain.domainManifestHash)) {
        throw new RegistryStoreError("UNKNOWN_REFERENCE", "A template must reference registered domain manifests by exact version and hash.");
      }
    }
    return this.insert(
      "PACKAGE_TEMPLATE",
      manifest.templateId,
      manifest.templateVersion,
      manifest.environment,
      packageTemplateManifestBytes(manifest),
      packageTemplateManifestHash(manifest),
      manifest,
    );
  }

  /** Admits a signed solver capability manifest. Only ED25519 operator identities are verified today. */
  registerSolverManifest(input: SolverCapabilityManifestInput): { created: boolean; documentHashHex: string } {
    const manifest = guarded("INVALID_DOCUMENT", "Solver capability manifest is invalid.", () => solverCapabilityManifest(input));
    if (manifest.operatorIdentityScheme !== "ED25519") {
      throw new RegistryStoreError("SCHEME_UNSUPPORTED", "Only ED25519 operator identities can be verified by this registry.");
    }
    const hash = solverCapabilityManifestHash(manifest);
    if (!verifyEd25519(manifest.operatorIdentityKey, hash, manifest.signature)) {
      throw new RegistryStoreError("INVALID_SIGNATURE", "The operator signature does not verify over the manifest hash.");
    }
    const nonce = manifest.manifestNonce;
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new RegistryStoreError("INVALID_DOCUMENT", "Manifest nonce is too large.");
    // Checked inside the write transaction so concurrent registrations cannot both pass.
    const precheck = () => {
      const latest = this.latest("SOLVER_CAPABILITY", manifest.solverId);
      if (latest === undefined) return;
      const prior = latest.document as { operatorIdentityKey: Uint8Array };
      if (!bytesEqual(prior.operatorIdentityKey, manifest.operatorIdentityKey)) {
        throw new RegistryStoreError("OPERATOR_CHANGED", "A solver's operator identity key cannot change through a manifest update.");
      }
      if (Number(nonce) < latest.subjectVersion) throw new RegistryStoreError("NONCE_REGRESSED", "Manifest nonce must increase.");
    };
    return this.insert("SOLVER_CAPABILITY", manifest.solverId, Number(nonce), manifest.environment, unsignedSolverCapabilityManifestBytes(manifest), hash, manifest, precheck);
  }

  private decode<T>(row: Row): RegisteredDocument<T> {
    return Object.freeze({
      kind: row.kind,
      subjectId: row.subject_id,
      subjectVersion: row.subject_version,
      environment: row.environment,
      documentHashHex: toHex(row.document_hash),
      registeredAtMs: row.registered_at_ms,
      document: guarded("CORRUPT_ROW", "Stored document failed to decode.", () => parseProtocolJson(row.document_json)) as T,
    });
  }

  /** The exact version when given, otherwise the highest registered version of the subject. */
  latest<T = unknown>(kind: RegistryKind, subjectId: string, subjectVersion?: number): RegisteredDocument<T> | undefined {
    const row = (subjectVersion === undefined
      ? this.db
          .prepare("SELECT * FROM registry_documents WHERE kind = ? AND subject_id = ? ORDER BY subject_version DESC LIMIT 1")
          .get(kind, subjectId)
      : this.db
          .prepare("SELECT * FROM registry_documents WHERE kind = ? AND subject_id = ? AND subject_version = ?")
          .get(kind, subjectId, subjectVersion)) as Row | undefined;
    return row === undefined ? undefined : this.decode<T>(row);
  }

  /** One exact registered document of a subject, by its canonical hash, whatever its version. */
  byHash<T = unknown>(kind: RegistryKind, subjectId: string, documentHashHex: string): RegisteredDocument<T> | undefined {
    if (!/^[0-9a-f]{64}$/.test(documentHashHex)) return undefined;
    const row = this.db
      .prepare("SELECT * FROM registry_documents WHERE document_hash = ? AND kind = ? AND subject_id = ?")
      .get(Buffer.from(documentHashHex, "hex"), kind, subjectId) as Row | undefined;
    return row === undefined ? undefined : this.decode<T>(row);
  }

  /** The highest version of every subject of one kind, ordered by subject id. */
  list<T = unknown>(kind: RegistryKind, limit = 200): readonly RegisteredDocument<T>[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RegistryStoreError("INVALID_INPUT", "Limit must be between 1 and 500.");
    const rows = this.db
      .prepare(
        `SELECT d.* FROM registry_documents d
         JOIN (SELECT subject_id, MAX(subject_version) AS version FROM registry_documents WHERE kind = ? GROUP BY subject_id) m
           ON d.subject_id = m.subject_id AND d.subject_version = m.version
         WHERE d.kind = ? ORDER BY d.subject_id LIMIT ?`,
      )
      .all(kind, kind, limit) as Row[];
    return Object.freeze(rows.map((row) => this.decode<T>(row)));
  }
}
