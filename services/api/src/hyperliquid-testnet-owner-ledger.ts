import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { HyperliquidTestnetTerminalExecutionResult } from "./hyperliquid-testnet-terminal.js";

/**
 * Which user owns which package held in the omnibus Hyperliquid Testnet trading account. The
 * venue sees one account; this ledger is the durable record that each package belongs to the
 * wallet that signed it, that only that wallet can exit it, and that an exit closes exactly it.
 */

export type HyperliquidOwnerPackageState = "PENDING_ENTRY" | "OPEN" | "EXITING" | "CLOSED" | "UNRESOLVED";

export type HyperliquidOwnerPackage = Readonly<{
  entryAttemptId: string;
  owner: string;
  entryOrderHash: string;
  state: HyperliquidOwnerPackageState;
  reservedNotionalAtoms: bigint;
  perpQuantityAtoms: bigint | null;
  spotQuantityAtoms: bigint | null;
  entryNotionalAtoms: bigint | null;
  entryReceiptHash: string | null;
  exitOrderHash: string | null;
  exitAttemptId: string | null;
  /** The spot an exit sells: the package spot floored to the spot lot; the rest stays as dust. */
  exitSpotQuantityAtoms: bigint | null;
  openedAtMs: number | null;
  closedAtMs: number | null;
}>;

export type HyperliquidOmnibusLimits = Readonly<{
  maxOpenPackagesPerOwner: number;
  maxOpenNotionalQuoteAtoms: bigint;
}>;

export type HyperliquidLedgerErrorCode =
  | "OWNER_PACKAGE_LIMIT"
  | "OMNIBUS_NOTIONAL_LIMIT"
  | "NO_OPEN_PACKAGE"
  | "EXIT_PACKAGE_MISMATCH"
  | "LEDGER_CONFLICT";

export class HyperliquidOwnerLedgerError extends Error {
  readonly code: HyperliquidLedgerErrorCode;

  constructor(code: HyperliquidLedgerErrorCode, message: string) {
    super(message);
    this.name = "HyperliquidOwnerLedgerError";
    this.code = code;
  }
}

/** The terms an EXIT order must carry to close exactly one ledger package. */
export type HyperliquidExitOrderTerms = Readonly<{
  owner: string;
  orderHash: string;
  perpQuantityAtoms: bigint;
  grossSpotQuantityAtoms: bigint;
  /** Base atoms per spot size unit: the exit sells the package spot floored to it. */
  spotLotAtoms: bigint;
  entryReceiptHash: string;
}>;

const ACTIVE_STATES = "('PENDING_ENTRY', 'OPEN', 'EXITING', 'UNRESOLVED')";
const RECEIPT_DOMAIN = "NARYX/hyperliquid-testnet-entry-receipt/v1";

type PackageRow = Readonly<{
  entry_attempt_id: string;
  owner: string;
  entry_order_hash: string;
  state: string;
  reserved_notional_atoms: string;
  perp_quantity_atoms: string | null;
  spot_quantity_atoms: string | null;
  entry_notional_atoms: string | null;
  entry_receipt_hash: string | null;
  exit_order_hash: string | null;
  exit_attempt_id: string | null;
  exit_spot_quantity_atoms: string | null;
  opened_at_ms: number | null;
  closed_at_ms: number | null;
}>;

let cachedRepositoryRoot: string | undefined;

function repositoryRoot(): string | undefined {
  if (cachedRepositoryRoot !== undefined) return cachedRepositoryRoot;
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, ".git"))) return cachedRepositoryRoot = current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function databasePath(value: string): string {
  if (typeof value !== "string" || value === ":memory:" || !isAbsolute(value)) {
    throw new Error("Hyperliquid owner ledger requires an absolute durable database path.");
  }
  const resolved = resolve(value);
  const root = repositoryRoot();
  if (root !== undefined && (resolved === root || resolved.startsWith(root + sep))) {
    throw new Error("Hyperliquid owner ledger database must remain outside the repository checkout.");
  }
  return resolved;
}

function optionalAtoms(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function decode(row: PackageRow): HyperliquidOwnerPackage {
  return Object.freeze({
    entryAttemptId: row.entry_attempt_id,
    owner: row.owner,
    entryOrderHash: row.entry_order_hash,
    state: row.state as HyperliquidOwnerPackageState,
    reservedNotionalAtoms: BigInt(row.reserved_notional_atoms),
    perpQuantityAtoms: optionalAtoms(row.perp_quantity_atoms),
    spotQuantityAtoms: optionalAtoms(row.spot_quantity_atoms),
    entryNotionalAtoms: optionalAtoms(row.entry_notional_atoms),
    entryReceiptHash: row.entry_receipt_hash,
    exitOrderHash: row.exit_order_hash,
    exitAttemptId: row.exit_attempt_id,
    exitSpotQuantityAtoms: optionalAtoms(row.exit_spot_quantity_atoms ?? null),
    openedAtMs: row.opened_at_ms,
    closedAtMs: row.closed_at_ms,
  });
}

/** Nothing reached the account: the reservation is returned. */
function noEffect(result: HyperliquidTestnetTerminalExecutionResult): boolean {
  return result.status === "NOT_SUBMITTED" || result.status === "CHECKPOINT_INCOMPLETE"
    || result.status === "CHECKPOINT_FAILED"
    || (result.status === "RECONCILED" && result.packageStatus === "NO_EFFECT");
}

function completed(result: HyperliquidTestnetTerminalExecutionResult) {
  return result.status === "RECONCILED"
    && (result.packageStatus === "COMPLETED_EXACT" || result.packageStatus === "COMPLETED_BOUNDED")
    && result.observedNetSpotDeltaAtoms !== undefined && result.observedPerpetualDeltaAtoms !== undefined
    ? result : undefined;
}

/** The evidence commitment an EXIT order binds as its entry receipt. */
export function hyperliquidTestnetEntryReceiptHash(
  attemptId: string,
  orderHash: string,
  result: Extract<HyperliquidTestnetTerminalExecutionResult, { status: "RECONCILED" }>,
): string {
  return createHash("sha256").update(JSON.stringify([
    RECEIPT_DOMAIN, attemptId, orderHash, result.packageStatus, result.actionCommitment,
    result.requestCommitment, result.observedNetSpotDeltaAtoms, result.observedPerpetualDeltaAtoms,
  ])).digest("hex");
}

/** An unresolved entry has no receipt yet; an unresolved exit keeps its entry receipt and exit attempt. */
const UNRESOLVED_RULE = "state = 'UNRESOLVED' AND (entry_receipt_hash IS NULL) = (exit_attempt_id IS NULL)";
const PACKAGE_COLUMNS = [
  "entry_attempt_id", "owner", "entry_order_hash", "state", "reserved_notional_atoms", "perp_quantity_atoms",
  "spot_quantity_atoms", "entry_notional_atoms", "entry_receipt_hash", "exit_order_hash", "exit_attempt_id",
  "opened_at_ms", "closed_at_ms", "updated_at_ms", "exit_spot_quantity_atoms",
].join(", ");

function packagesTable(name: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${name} (
      entry_attempt_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      entry_order_hash TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('PENDING_ENTRY', 'OPEN', 'EXITING', 'CLOSED', 'UNRESOLVED')),
      reserved_notional_atoms TEXT NOT NULL,
      perp_quantity_atoms TEXT,
      spot_quantity_atoms TEXT,
      entry_notional_atoms TEXT,
      entry_receipt_hash TEXT UNIQUE,
      exit_order_hash TEXT UNIQUE,
      exit_attempt_id TEXT UNIQUE,
      opened_at_ms INTEGER,
      closed_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL,
      exit_spot_quantity_atoms TEXT,
      CHECK ((state = 'PENDING_ENTRY' AND entry_receipt_hash IS NULL)
        OR (state IN ('OPEN', 'EXITING', 'CLOSED') AND entry_receipt_hash IS NOT NULL)
        OR (${UNRESOLVED_RULE}))
    ) STRICT;`;
}

export class HyperliquidTestnetOwnerLedger {
  readonly #db: Database.Database;
  readonly #now: () => number;

  constructor(path: string, currentTimeMs: () => number = Date.now) {
    const resolved = databasePath(path);
    mkdirSync(dirname(resolved), { recursive: true });
    this.#db = new Database(resolved);
    this.#now = currentTimeMs;
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS hyperliquid_owner_authorizations (
        order_hash TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        signature TEXT NOT NULL,
        authorized_at_ms INTEGER NOT NULL
      ) STRICT;
      ${packagesTable("hyperliquid_owner_packages")}
      CREATE INDEX IF NOT EXISTS hyperliquid_owner_packages_owner ON hyperliquid_owner_packages(owner, state);
    `);
    const columns = this.#db.prepare("PRAGMA table_info(hyperliquid_owner_packages)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "exit_spot_quantity_atoms")) {
      this.#db.exec("ALTER TABLE hyperliquid_owner_packages ADD COLUMN exit_spot_quantity_atoms TEXT");
    }
    // The first table version forbade an entry receipt on an UNRESOLVED row, so an exit that ended
    // unresolved could not be recorded. Rebuild such a table once under the current rule.
    const sql = this.#db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hyperliquid_owner_packages'").pluck().get();
    if (typeof sql === "string" && !sql.includes(UNRESOLVED_RULE)) {
      this.#db.transaction(() => {
        this.#db.exec(`
          ${packagesTable("hyperliquid_owner_packages_v2")}
          INSERT INTO hyperliquid_owner_packages_v2 (${PACKAGE_COLUMNS}) SELECT ${PACKAGE_COLUMNS} FROM hyperliquid_owner_packages;
          DROP TABLE hyperliquid_owner_packages;
          ALTER TABLE hyperliquid_owner_packages_v2 RENAME TO hyperliquid_owner_packages;
          CREATE INDEX IF NOT EXISTS hyperliquid_owner_packages_owner ON hyperliquid_owner_packages(owner, state);
        `);
      }).immediate();
    }
  }

  recordAuthorization(orderHash: string, owner: string, signature: string): void {
    this.#db.prepare(`
      INSERT INTO hyperliquid_owner_authorizations (order_hash, owner, signature, authorized_at_ms)
      VALUES (?, ?, ?, ?) ON CONFLICT(order_hash) DO NOTHING
    `).run(orderHash, owner, signature, this.#now());
    const stored = this.authorization(orderHash);
    if (stored?.owner !== owner) {
      throw new HyperliquidOwnerLedgerError("LEDGER_CONFLICT", "Order is already authorized by a different owner.");
    }
  }

  authorization(orderHash: string): Readonly<{ owner: string; signature: string }> | undefined {
    return this.#db.prepare(`
      SELECT owner, signature FROM hyperliquid_owner_authorizations WHERE order_hash = ?
    `).get(orderHash) as { owner: string; signature: string } | undefined;
  }

  packages(owner: string): readonly HyperliquidOwnerPackage[] {
    const rows = this.#db.prepare(`
      SELECT * FROM hyperliquid_owner_packages WHERE owner = ?
      ORDER BY updated_at_ms DESC, entry_attempt_id LIMIT 20
    `).all(owner) as PackageRow[];
    return Object.freeze(rows.map(decode));
  }

  /**
   * Reserves an entry before handoff: the owner stays within the per-owner package limit and the
   * omnibus account within its total notional, counting every package not yet closed.
   */
  reserveEntry(input: Readonly<{
    attemptId: string;
    owner: string;
    orderHash: string;
    notionalAtoms: bigint;
    limits: HyperliquidOmnibusLimits;
  }>): void {
    this.#db.transaction(() => {
      const existing = this.#row(input.attemptId);
      if (existing !== undefined) {
        if (existing.owner !== input.owner || existing.entry_order_hash !== input.orderHash) {
          throw new HyperliquidOwnerLedgerError("LEDGER_CONFLICT", "Entry attempt is bound to a different package.");
        }
        return;
      }
      const open = this.#db.prepare(`
        SELECT COUNT(*) AS count FROM hyperliquid_owner_packages WHERE owner = ? AND state IN ${ACTIVE_STATES}
      `).get(input.owner) as { count: number };
      if (open.count >= input.limits.maxOpenPackagesPerOwner) {
        throw new HyperliquidOwnerLedgerError("OWNER_PACKAGE_LIMIT", "This wallet already has its maximum open Hyperliquid packages.");
      }
      const reserved = (this.#db.prepare(`
        SELECT reserved_notional_atoms FROM hyperliquid_owner_packages WHERE state IN ${ACTIVE_STATES}
      `).all() as { reserved_notional_atoms: string }[])
        .reduce((total, row) => total + BigInt(row.reserved_notional_atoms), 0n);
      if (reserved + input.notionalAtoms > input.limits.maxOpenNotionalQuoteAtoms) {
        throw new HyperliquidOwnerLedgerError("OMNIBUS_NOTIONAL_LIMIT", "The shared Hyperliquid testnet account is at its open notional limit.");
      }
      this.#db.prepare(`
        INSERT INTO hyperliquid_owner_packages (entry_attempt_id, owner, entry_order_hash, state, reserved_notional_atoms, updated_at_ms)
        VALUES (?, ?, ?, 'PENDING_ENTRY', ?, ?)
      `).run(input.attemptId, input.owner, input.orderHash, input.notionalAtoms.toString(), this.#now());
    }).immediate();
  }

  /**
   * Records an entry outcome. Only authoritative completed evidence opens a package; an entry left
   * UNRESOLVED takes a later final outcome (after its recovery or lane release reconciles).
   */
  settleEntry(attemptId: string, result: HyperliquidTestnetTerminalExecutionResult, entryNotionalAtoms: bigint): void {
    this.#db.transaction(() => {
      const row = this.#row(attemptId);
      const unresolvedEntry = row?.state === "UNRESOLVED" && row.exit_attempt_id === null;
      if (row === undefined || (row.state !== "PENDING_ENTRY" && !unresolvedEntry)) return;
      if (unresolvedEntry && completed(result) === undefined && !noEffect(result)) return;
      if (noEffect(result)) {
        this.#db.prepare("DELETE FROM hyperliquid_owner_packages WHERE entry_attempt_id = ?").run(attemptId);
        return;
      }
      const done = completed(result);
      const spot = done === undefined ? 0n : BigInt(done.observedNetSpotDeltaAtoms!);
      const perp = done === undefined ? 0n : -BigInt(done.observedPerpetualDeltaAtoms!);
      if (done === undefined || spot <= 0n || perp <= 0n || entryNotionalAtoms <= 0n) {
        this.#db.prepare(`
          UPDATE hyperliquid_owner_packages SET state = 'UNRESOLVED', updated_at_ms = ? WHERE entry_attempt_id = ?
        `).run(this.#now(), attemptId);
        return;
      }
      this.#db.prepare(`
        UPDATE hyperliquid_owner_packages
        SET state = 'OPEN', perp_quantity_atoms = ?, spot_quantity_atoms = ?, entry_notional_atoms = ?,
          entry_receipt_hash = ?, opened_at_ms = ?, updated_at_ms = ?
        WHERE entry_attempt_id = ? AND state IN ('PENDING_ENTRY', 'UNRESOLVED') AND exit_attempt_id IS NULL
      `).run(
        perp.toString(), spot.toString(), entryNotionalAtoms.toString(),
        hyperliquidTestnetEntryReceiptHash(attemptId, row.entry_order_hash, done),
        this.#now(), this.#now(), attemptId,
      );
    }).immediate();
  }

  /** The owner's oldest open package, which an exit order closes. */
  openPackage(owner: string): HyperliquidOwnerPackage | undefined {
    const row = this.#db.prepare(`
      SELECT * FROM hyperliquid_owner_packages WHERE owner = ? AND state = 'OPEN'
      ORDER BY opened_at_ms, entry_attempt_id LIMIT 1
    `).get(owner) as PackageRow | undefined;
    return row === undefined ? undefined : decode(row);
  }

  /** Binds a freshly built exit order to the owner's open package, replacing an unexecuted one. */
  bindExitOrder(entryAttemptId: string, owner: string, exitOrderHash: string): void {
    const update = this.#db.prepare(`
      UPDATE hyperliquid_owner_packages SET exit_order_hash = ?, updated_at_ms = ?
      WHERE entry_attempt_id = ? AND owner = ? AND state = 'OPEN'
    `).run(exitOrderHash, this.#now(), entryAttemptId, owner);
    if (update.changes !== 1) throw new HyperliquidOwnerLedgerError("NO_OPEN_PACKAGE", "The wallet has no open package to exit.");
  }

  /**
   * Starts an exit only for the package the exit order was built for, owned by the order's owner,
   * selling its spot floored to the spot lot and buying back exactly its short. The sub-lot
   * remainder is base-fee dust that stays in the trading account under the residual caps.
   */
  beginExit(attemptId: string, terms: HyperliquidExitOrderTerms): void {
    this.#db.transaction(() => {
      const row = this.#db.prepare(`
        SELECT * FROM hyperliquid_owner_packages WHERE exit_order_hash = ?
      `).get(terms.orderHash) as PackageRow | undefined;
      if (row === undefined || row.owner !== terms.owner) {
        throw new HyperliquidOwnerLedgerError("EXIT_PACKAGE_MISMATCH", "The exit order does not close a package this wallet owns.");
      }
      if (row.state === "EXITING" && row.exit_attempt_id === attemptId) return;
      const spot = row.spot_quantity_atoms === null ? 0n : BigInt(row.spot_quantity_atoms);
      const lot = terms.spotLotAtoms;
      if (row.state !== "OPEN" || row.perp_quantity_atoms !== terms.perpQuantityAtoms.toString()
        || typeof lot !== "bigint" || lot <= 0n || terms.grossSpotQuantityAtoms <= 0n
        || terms.grossSpotQuantityAtoms !== spot - spot % lot
        || row.entry_receipt_hash !== terms.entryReceiptHash) {
        throw new HyperliquidOwnerLedgerError("EXIT_PACKAGE_MISMATCH", "The exit order does not close exactly the open package.");
      }
      this.#db.prepare(`
        UPDATE hyperliquid_owner_packages
        SET state = 'EXITING', exit_attempt_id = ?, exit_spot_quantity_atoms = ?, updated_at_ms = ?
        WHERE entry_attempt_id = ? AND state = 'OPEN'
      `).run(attemptId, terms.grossSpotQuantityAtoms.toString(), this.#now(), row.entry_attempt_id);
    }).immediate();
  }

  /** Records an exit outcome; an exit left UNRESOLVED takes a later final outcome. */
  settleExit(attemptId: string, result: HyperliquidTestnetTerminalExecutionResult): void {
    const next = completed(result) !== undefined ? "CLOSED" : noEffect(result) ? "OPEN" : "UNRESOLVED";
    this.#db.prepare(`
      UPDATE hyperliquid_owner_packages
      SET state = ?, exit_attempt_id = CASE WHEN ? = 'OPEN' THEN NULL ELSE exit_attempt_id END,
        exit_spot_quantity_atoms = CASE WHEN ? = 'OPEN' THEN NULL ELSE exit_spot_quantity_atoms END,
        closed_at_ms = CASE WHEN ? = 'CLOSED' THEN ? ELSE closed_at_ms END, updated_at_ms = ?
      WHERE exit_attempt_id = ? AND (state = 'EXITING' OR (state = 'UNRESOLVED' AND ? <> 'UNRESOLVED'))
    `).run(next, next, next, next, this.#now(), this.#now(), attemptId, next);
  }

  close(): void {
    this.#db.close();
  }

  /**
   * What an owner's package listing shows for one Hyperliquid attempt: an exit attempt shows its
   * package's state; an entry shows the package's state until its exit begins, then OPENED (the
   * exit's own row carries what followed). An entry that had no effect was removed and has none.
   */
  attemptOutcome(attemptId: string): Readonly<{
    state: string; transactionHash: null; blockNumber: null; receiptHash: string | null;
  }> | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM hyperliquid_owner_packages WHERE entry_attempt_id = ? OR exit_attempt_id = ?",
    ).get(attemptId, attemptId) as PackageRow | undefined;
    if (row === undefined) return undefined;
    const state = row.exit_attempt_id === attemptId || row.exit_attempt_id === null ? row.state : "OPENED";
    // Package listings carry receipt hashes 0x-prefixed, as every other lane's are.
    const receiptHash = row.entry_receipt_hash === null ? null : `0x${row.entry_receipt_hash}`;
    return Object.freeze({ state, transactionHash: null, blockNumber: null, receiptHash });
  }

  #row(attemptId: string): PackageRow | undefined {
    return this.#db.prepare("SELECT * FROM hyperliquid_owner_packages WHERE entry_attempt_id = ?")
      .get(attemptId) as PackageRow | undefined;
  }
}
