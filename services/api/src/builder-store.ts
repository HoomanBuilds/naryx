import type Database from "better-sqlite3";
import bs58 from "bs58";
import {
  builderAttributionHash,
  builderManifestHash,
  checkBuilderFee,
  parseProtocolJson,
  stringifyProtocolJson,
  toHex,
} from "@naryx/protocol-types";
import type { BuilderAttributionInput, BuilderFeeViolation, BuilderManifestInput } from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";
import { verifyEd25519 } from "./ed25519.js";
import type { SqliteEvidenceStore } from "./evidence-store.js";

export class BuilderStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BuilderStoreError";
    this.code = code;
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS builder_manifests (
  manifest_hash BLOB PRIMARY KEY,
  builder_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS builder_manifests_by_builder ON builder_manifests(builder_id, recorded_at_ms);
CREATE TABLE IF NOT EXISTS builder_attributions (
  order_hash BLOB PRIMARY KEY,
  builder_id TEXT NOT NULL,
  attribution_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS builder_attributions_by_builder ON builder_attributions(builder_id, recorded_at_ms);
CREATE TRIGGER IF NOT EXISTS reject_builder_manifest_change BEFORE UPDATE ON builder_manifests BEGIN SELECT RAISE(ABORT, 'builder manifests are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_builder_attribution_change BEFORE UPDATE ON builder_attributions BEGIN SELECT RAISE(ABORT, 'builder attributions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_builder_attribution_delete BEFORE DELETE ON builder_attributions BEGIN SELECT RAISE(ABORT, 'builder attributions are append-only'); END;
`;

export interface BuilderAttributionView {
  readonly orderHash: string;
  readonly attribution: BuilderAttributionInput;
  readonly terminalState?: string;
  /** Builder fees the settled receipt charged, by asset. */
  readonly chargedByAsset: readonly { readonly assetId: string; readonly atoms: bigint }[];
  readonly payable: boolean;
  readonly violations: readonly BuilderFeeViolation[];
}

/**
 * Builder manifests, signed by the builder's own key and advanced only by a higher nonce, and
 * order attributions, signed by the order owner over the attribution hash and fixed once per
 * order. Revenue counts only fees on successful receipts that pass the kernel fee check against
 * the exact attributed manifest; a builder never gains authority over an order or a position.
 */
export class SqliteBuilderStore {
  private readonly db: Database.Database;
  private readonly clock: () => number;
  private readonly options: { readonly environment: string; readonly evidence: Pick<SqliteEvidenceStore, "getOrder" | "getOutcome">; readonly clock?: () => number };

  constructor(dbPath: string, options: { readonly environment: string; readonly evidence: Pick<SqliteEvidenceStore, "getOrder" | "getOutcome">; readonly clock?: () => number }) {
    this.options = options;
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new BuilderStoreError(code, message));
    this.clock = options.clock ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  registerManifest(manifest: BuilderManifestInput): { readonly manifestHash: string; readonly created: boolean } {
    let hash: Uint8Array;
    try {
      hash = builderManifestHash(manifest);
    } catch (error) {
      throw new BuilderStoreError("INVALID_MANIFEST", (error as Error).message);
    }
    if (manifest.environment !== this.options.environment) throw new BuilderStoreError("WRONG_ENVIRONMENT", `This registry serves ${this.options.environment}.`);
    if (!verifyEd25519(manifest.identityKey, hash, manifest.signature)) throw new BuilderStoreError("INVALID_SIGNATURE", "The manifest is not signed by its identity key.");
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM builder_manifests WHERE manifest_hash = ?").get(hash) !== undefined) return { manifestHash: toHex(hash), created: false };
      const latest = this.latest(manifest.builderId);
      if (latest !== undefined) {
        if (manifest.nonce <= latest.nonce) throw new BuilderStoreError("NONCE_NOT_INCREASING", "A newer manifest needs a higher nonce.");
        // Only the key that controls a builder id can publish its next manifest.
        if (toHex(latest.identityKey) !== toHex(manifest.identityKey)) throw new BuilderStoreError("IDENTITY_CHANGED", "A builder id keeps its identity key.");
      }
      this.db
        .prepare("INSERT INTO builder_manifests (manifest_hash, builder_id, nonce, manifest_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?)")
        .run(hash, manifest.builderId, manifest.nonce.toString(), stringifyProtocolJson(manifest), this.clock());
      return { manifestHash: toHex(hash), created: true };
    }).immediate();
  }

  latest(builderId: string): BuilderManifestInput | undefined {
    const row = this.db.prepare("SELECT manifest_json FROM builder_manifests WHERE builder_id = ? ORDER BY length(nonce) DESC, nonce DESC LIMIT 1").get(builderId) as { manifest_json: string } | undefined;
    return row === undefined ? undefined : (parseProtocolJson(row.manifest_json) as BuilderManifestInput);
  }

  private manifestByHash(hashHex: string): BuilderManifestInput | undefined {
    const row = this.db.prepare("SELECT manifest_json FROM builder_manifests WHERE manifest_hash = ?").get(Buffer.from(hashHex, "hex")) as { manifest_json: string } | undefined;
    return row === undefined ? undefined : (parseProtocolJson(row.manifest_json) as BuilderManifestInput);
  }

  attribute(attribution: BuilderAttributionInput, signatureBase58: string): { readonly attributionHash: string; readonly replayed: boolean } {
    let hash: Uint8Array;
    try {
      hash = builderAttributionHash(attribution);
    } catch (error) {
      throw new BuilderStoreError("INVALID_ATTRIBUTION", (error as Error).message);
    }
    const orderHashHex = typeof attribution.orderHash === "string" ? attribution.orderHash.toLowerCase() : toHex(attribution.orderHash);
    const order = this.options.evidence.getOrder(orderHashHex);
    if (order === undefined) throw new BuilderStoreError("ORDER_NOT_FOUND", "No accepted order has this hash.");
    let owner: Uint8Array;
    let signature: Uint8Array;
    try {
      owner = bs58.decode(order.owner);
      signature = bs58.decode(signatureBase58);
    } catch {
      throw new BuilderStoreError("INVALID_SIGNATURE", "The owner and signature must be base58.");
    }
    if (owner.length !== 32 || !verifyEd25519(owner, hash, signature)) throw new BuilderStoreError("INVALID_SIGNATURE", "Only the order owner attributes an order.");
    const manifestHex = typeof attribution.builderManifestHash === "string" ? attribution.builderManifestHash.toLowerCase() : toHex(attribution.builderManifestHash);
    const manifest = this.manifestByHash(manifestHex);
    if (manifest === undefined || manifest.builderId !== attribution.builderId) throw new BuilderStoreError("MANIFEST_NOT_FOUND", "The attribution names no registered manifest of that builder.");
    return this.db.transaction(() => {
      const known = this.db.prepare("SELECT attribution_json FROM builder_attributions WHERE order_hash = ?").get(Buffer.from(orderHashHex, "hex")) as { attribution_json: string } | undefined;
      if (known !== undefined) {
        if (toHex(builderAttributionHash(parseProtocolJson(known.attribution_json) as BuilderAttributionInput)) !== toHex(hash)) {
          throw new BuilderStoreError("ALREADY_ATTRIBUTED", "This order is already attributed to another builder or cap.");
        }
        return { attributionHash: toHex(hash), replayed: true };
      }
      this.db
        .prepare("INSERT INTO builder_attributions (order_hash, builder_id, attribution_json, signature, recorded_at_ms) VALUES (?, ?, ?, ?, ?)")
        .run(Buffer.from(orderHashHex, "hex"), attribution.builderId, stringifyProtocolJson(attribution), signatureBase58, this.clock());
      return { attributionHash: toHex(hash), replayed: false };
    }).immediate();
  }

  attributions(builderId: string, limit = 500): readonly BuilderAttributionView[] {
    const rows = this.db
      .prepare("SELECT order_hash, attribution_json FROM builder_attributions WHERE builder_id = ? ORDER BY recorded_at_ms DESC LIMIT ?")
      .all(builderId, Math.min(Math.max(1, limit), 1_000)) as { order_hash: Uint8Array; attribution_json: string }[];
    return rows.map((row) => this.view(row));
  }

  private view(row: { order_hash: Uint8Array; attribution_json: string }): BuilderAttributionView {
    {
      const orderHash = toHex(row.order_hash);
      const attribution = parseProtocolJson(row.attribution_json) as BuilderAttributionInput;
      const outcome = this.options.evidence.getOutcome(orderHash);
      const receipt = outcome?.receipt;
      const chargedByAsset = (receipt?.builderFeesByAsset ?? []).map((fee) => ({ assetId: fee.asset.assetId as string, atoms: fee.atoms }));
      if (receipt === undefined) return Object.freeze({ orderHash, attribution, ...(outcome === undefined ? {} : { terminalState: outcome.terminalState }), chargedByAsset, payable: false, violations: [] });
      const manifestHex = typeof attribution.builderManifestHash === "string" ? attribution.builderManifestHash : toHex(attribution.builderManifestHash);
      const manifest = this.manifestByHash(manifestHex);
      const order = this.options.evidence.getOrder(orderHash);
      const feeAtoms = chargedByAsset.reduce((sum, fee) => sum + fee.atoms, 0n);
      const check = manifest === undefined || order === undefined
        ? { payable: false as const, violations: ["MANIFEST_MISMATCH" as const] }
        : checkBuilderFee(manifest, attribution, {
          domainId: receipt.domain.domainId,
          templateId: receipt.templateId,
          notionalAtoms: receipt.matchedPackageNotional,
          feeAtoms,
          orderAcceptedAtMs: BigInt(order.receivedAtMs),
        });
      return Object.freeze({
        orderHash,
        attribution,
        terminalState: outcome?.terminalState as string,
        chargedByAsset,
        payable: check.payable,
        violations: check.payable ? [] : check.violations,
      });
    }
  }

  /**
   * Payable builder fees by asset over every successful attributed receipt of the builder, not
   * only the newest page, so attributions added by others can never push revenue out of the sum.
   */
  revenue(builderId: string): readonly { readonly assetId: string; readonly atoms: bigint; readonly orders: number }[] {
    const totals = new Map<string, { atoms: bigint; orders: number }>();
    const rows = this.db
      .prepare("SELECT order_hash, attribution_json FROM builder_attributions WHERE builder_id = ?")
      .all(builderId) as { order_hash: Uint8Array; attribution_json: string }[];
    for (const row of rows) {
      const view = this.view(row);
      if (!view.payable) continue;
      for (const fee of view.chargedByAsset) {
        const entry = totals.get(fee.assetId) ?? { atoms: 0n, orders: 0 };
        totals.set(fee.assetId, { atoms: entry.atoms + fee.atoms, orders: entry.orders + 1 });
      }
    }
    return [...totals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([assetId, value]) => Object.freeze({ assetId, ...value }));
  }
}
