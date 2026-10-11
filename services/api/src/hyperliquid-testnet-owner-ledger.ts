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

/** What a completed entry put in the trading account, and the receipt an exit binds. */
export type HyperliquidEntryFill = Readonly<{
  spotQuantityAtoms: bigint;
  perpQuantityAtoms: bigint;
  entryReceiptHash: string;
}>;

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
const ACTIVE_EXPOSURE_STATES = "('RESERVED', 'OPEN', 'UNRESOLVED')";
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

/** Where a risk-increasing generalized strategy execution leaves its exposure. */
function exposureOutcome(result: HyperliquidTestnetTerminalExecutionResult): "OPEN" | "RELEASED" | "UNRESOLVED" {
  if (result.status === "STRATEGY_EXECUTION") {
    return result.packageStatus === "COMPLETED" ? "OPEN" : result.packageStatus === "NO_EFFECT" ? "RELEASED" : "UNRESOLVED";
  }
  if (noEffect(result)) return "RELEASED";
  return result.status === "RECONCILED"
    && (result.packageStatus === "COMPLETED_EXACT" || result.packageStatus === "COMPLETED_BOUNDED") ? "OPEN" : "UNRESOLVED";
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
      CREATE TABLE IF NOT EXISTS hyperliquid_owner_exit_orders (
        exit_order_hash TEXT PRIMARY KEY,
        entry_attempt_id TEXT NOT NULL,
        owner TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO hyperliquid_owner_exit_orders (exit_order_hash, entry_attempt_id, owner)
        SELECT exit_order_hash, entry_attempt_id, owner FROM hyperliquid_owner_packages WHERE exit_order_hash IS NOT NULL;
      CREATE TABLE IF NOT EXISTS hyperliquid_owner_exposures (
        attempt_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        strategy_key TEXT NOT NULL,
        notional_atoms TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('RESERVED', 'OPEN', 'UNRESOLVED', 'RELEASED')),
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS hyperliquid_owner_exposures_owner ON hyperliquid_owner_exposures(owner, state);
      CREATE INDEX IF NOT EXISTS hyperliquid_owner_exposures_strategy ON hyperliquid_owner_exposures(strategy_key, state);
      CREATE TABLE IF NOT EXISTS hyperliquid_owner_exposure_reductions (
        attempt_id TEXT PRIMARY KEY,
        strategy_key TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      ) STRICT;
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

  /** Every package the owner has not closed, which must stay exitable, plus the most recent closed ones. */
  packages(owner: string, closedLimit = 20): readonly HyperliquidOwnerPackage[] {
    const rows = this.#db.prepare(`
      SELECT * FROM (SELECT * FROM hyperliquid_owner_packages WHERE owner = ? AND state <> 'CLOSED')
      UNION ALL
      SELECT * FROM (SELECT * FROM hyperliquid_owner_packages WHERE owner = ? AND state = 'CLOSED'
        ORDER BY updated_at_ms DESC, entry_attempt_id LIMIT ?)
      ORDER BY updated_at_ms DESC, entry_attempt_id
    `).all(owner, owner, closedLimit) as PackageRow[];
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
      this.#requireWithinLimits(input.owner, input.notionalAtoms, true, input.limits);
      this.#db.prepare(`
        INSERT INTO hyperliquid_owner_packages (entry_attempt_id, owner, entry_order_hash, state, reserved_notional_atoms, updated_at_ms)
        VALUES (?, ?, ?, 'PENDING_ENTRY', ?, ?)
      `).run(input.attemptId, input.owner, input.orderHash, input.notionalAtoms.toString(), this.#now());
    }).immediate();
  }

  /**
   * Reserves a risk-increasing generalized strategy execution before handoff, under the same caps as
   * cash-and-carry packages: an ENTRY takes a package slot, and every reservation counts its signed
   * notional against the omnibus account until it ends with no effect or the strategy is reduced.
   */
  reserveExposure(input: Readonly<{
    attemptId: string;
    owner: string;
    /** The strategy's entry order hash: every reservation of one strategy shares its package slot. */
    strategyKey: string;
    notionalAtoms: bigint;
    newPackage: boolean;
    limits: HyperliquidOmnibusLimits;
  }>): void {
    this.#db.transaction(() => {
      const existing = this.#db.prepare("SELECT owner, strategy_key FROM hyperliquid_owner_exposures WHERE attempt_id = ?")
        .get(input.attemptId) as { owner: string; strategy_key: string } | undefined;
      if (existing !== undefined) {
        if (existing.owner !== input.owner || existing.strategy_key !== input.strategyKey) {
          throw new HyperliquidOwnerLedgerError("LEDGER_CONFLICT", "Strategy attempt is bound to a different exposure.");
        }
        return;
      }
      this.#requireWithinLimits(input.owner, input.notionalAtoms, input.newPackage, input.limits);
      this.#db.prepare(`
        INSERT INTO hyperliquid_owner_exposures (attempt_id, owner, strategy_key, notional_atoms, state, updated_at_ms)
        VALUES (?, ?, ?, ?, 'RESERVED', ?)
      `).run(input.attemptId, input.owner, input.strategyKey, input.notionalAtoms.toString(), this.#now());
    }).immediate();
  }

  /**
   * Records a reserved strategy execution's outcome: no effect releases it, completion keeps it as
   * open exposure, and anything else holds it UNRESOLVED until a later final outcome.
   */
  settleExposure(attemptId: string, result: HyperliquidTestnetTerminalExecutionResult): void {
    this.#db.prepare(`
      UPDATE hyperliquid_owner_exposures SET state = ?, updated_at_ms = ?
      WHERE attempt_id = ? AND state IN ('RESERVED', 'UNRESOLVED')
    `).run(exposureOutcome(result), this.#now(), attemptId);
  }

  /**
   * Applies a completed risk-reducing strategy execution as a reduction; any other outcome leaves
   * the exposure held.
   */
  settleReduction(input: Readonly<{
    attemptId: string;
    strategyKey: string;
    result: HyperliquidTestnetTerminalExecutionResult;
    /** The quantity a DECREASE closes; null for an exit of the whole strategy. */
    reducedQuantityAtoms: bigint | null;
    priorQuantityAtoms: bigint;
  }>): void {
    if (exposureOutcome(input.result) === "OPEN") this.applyReduction(input);
  }

  /**
   * Applies one recorded strategy reduction, once per attempt whichever path reports it: a close
   * releases the strategy's whole exposure; a decrease releases the closed fraction of each
   * reservation, rounded down so the exposure still held is never understated.
   */
  applyReduction(input: Readonly<{
    attemptId: string;
    strategyKey: string;
    reducedQuantityAtoms: bigint | null;
    priorQuantityAtoms: bigint;
  }>): void {
    const { reducedQuantityAtoms: reduced, priorQuantityAtoms: prior } = input;
    if (reduced !== null && (reduced <= 0n || prior <= 0n)) {
      throw new HyperliquidOwnerLedgerError("LEDGER_CONFLICT", "The strategy reduction quantity is invalid.");
    }
    this.#db.transaction(() => {
      const applied = this.#db.prepare(`
        INSERT OR IGNORE INTO hyperliquid_owner_exposure_reductions (attempt_id, strategy_key, applied_at_ms) VALUES (?, ?, ?)
      `).run(input.attemptId, input.strategyKey, this.#now());
      if (applied.changes !== 1) return;
      if (reduced === null || reduced >= prior) {
        this.#db.prepare(`
          UPDATE hyperliquid_owner_exposures SET state = 'RELEASED', updated_at_ms = ?
          WHERE strategy_key = ? AND state IN ${ACTIVE_EXPOSURE_STATES}
        `).run(this.#now(), input.strategyKey);
        return;
      }
      const rows = this.#db.prepare(`
        SELECT attempt_id, notional_atoms FROM hyperliquid_owner_exposures WHERE strategy_key = ? AND state IN ('OPEN', 'UNRESOLVED')
      `).all(input.strategyKey) as { attempt_id: string; notional_atoms: string }[];
      const update = this.#db.prepare(`
        UPDATE hyperliquid_owner_exposures SET notional_atoms = ?, updated_at_ms = ? WHERE attempt_id = ?
      `);
      for (const row of rows) {
        const atoms = BigInt(row.notional_atoms);
        update.run((atoms - atoms * reduced / prior).toString(), this.#now(), row.attempt_id);
      }
    }).immediate();
  }

  /**
   * Brings the exposure of strategies opened before this ledger existed under the caps: each
   * execution an unclosed strategy carries is held as OPEN under its own attempt, so one already
   * reserved, open, or released here is never counted twice or revived. A closed strategy releases
   * whatever it still holds. Decreases made before the backfill are not credited, so held exposure
   * may be overstated until the strategy closes, never understated.
   */
  reconcileStrategyExposures(input: Readonly<{
    open: readonly Readonly<{ attemptId: string; owner: string; strategyKey: string; notionalAtoms: bigint }>[];
    closedStrategyKeys: readonly string[];
  }>): Readonly<{ backfilled: number; released: number }> {
    return this.#db.transaction(() => {
      const insert = this.#db.prepare(`
        INSERT OR IGNORE INTO hyperliquid_owner_exposures (attempt_id, owner, strategy_key, notional_atoms, state, updated_at_ms)
        VALUES (?, ?, ?, ?, 'OPEN', ?)
      `);
      const release = this.#db.prepare(`
        UPDATE hyperliquid_owner_exposures SET state = 'RELEASED', updated_at_ms = ?
        WHERE strategy_key = ? AND state IN ${ACTIVE_EXPOSURE_STATES}
      `);
      let backfilled = 0;
      let released = 0;
      for (const row of input.open) {
        if (row.notionalAtoms <= 0n) {
          throw new HyperliquidOwnerLedgerError("LEDGER_CONFLICT", "A backfilled strategy exposure must be positive.");
        }
        backfilled += insert.run(row.attemptId, row.owner, row.strategyKey, row.notionalAtoms.toString(), this.#now()).changes;
      }
      for (const key of input.closedStrategyKeys) released += release.run(this.#now(), key).changes;
      return Object.freeze({ backfilled, released });
    }).immediate();
  }

  /**
   * Records an entry outcome. Only authoritative completed evidence opens a package; an entry left
   * UNRESOLVED takes a later final outcome (after its recovery or lane release reconciles).
   */
  settleEntry(attemptId: string, result: HyperliquidTestnetTerminalExecutionResult, entryNotionalAtoms: bigint): void {
    const done = completed(result);
    const orderHash = done === undefined ? undefined : this.#row(attemptId)?.entry_order_hash;
    this.#settleEntryOutcome(attemptId, noEffect(result) ? "RELEASED" : done === undefined ? "UNRESOLVED" : "OPEN",
      done === undefined || orderHash === undefined ? undefined : {
        spotQuantityAtoms: BigInt(done.observedNetSpotDeltaAtoms!),
        perpQuantityAtoms: -BigInt(done.observedPerpetualDeltaAtoms!),
        entryReceiptHash: hyperliquidTestnetEntryReceiptHash(attemptId, orderHash, done),
      }, entryNotionalAtoms);
  }

  /**
   * Records a source-backed strategy entry's outcome on its package exactly as a cash-and-carry
   * entry: completion opens it with the fill the caller derived from authoritative evidence, no
   * effect returns the reservation, and anything else (or a missing fill) holds it UNRESOLVED.
   */
  settleStrategyEntry(
    attemptId: string,
    result: HyperliquidTestnetTerminalExecutionResult,
    fill: HyperliquidEntryFill | undefined,
    entryNotionalAtoms: bigint,
  ): void {
    this.#settleEntryOutcome(attemptId, exposureOutcome(result), fill, entryNotionalAtoms);
  }

  /**
   * Moves a source-backed strategy entry admitted under a strategy exposure reservation onto a
   * pending package that takes over its notional, releasing the reservation so nothing is counted
   * twice. An entry with neither a package nor a held reservation (one admitted before reservations
   * existed) takes a package with `notionalAtoms`. A released reservation is never revived.
   * Returns whether a package was created.
   */
  adoptStrategyEntry(input: Readonly<{ attemptId: string; owner: string; orderHash: string; notionalAtoms: bigint }>): boolean {
    return this.#db.transaction(() => {
      const release = () => this.#db.prepare(`
        UPDATE hyperliquid_owner_exposures SET state = 'RELEASED', updated_at_ms = ?
        WHERE attempt_id = ? AND state IN ${ACTIVE_EXPOSURE_STATES}
      `).run(this.#now(), input.attemptId);
      const existing = this.#row(input.attemptId);
      if (existing !== undefined) {
        if (existing.owner !== input.owner || existing.entry_order_hash !== input.orderHash) {
          throw new HyperliquidOwnerLedgerError("LEDGER_CONFLICT", "Entry attempt is bound to a different package.");
        }
        release();
        return false;
      }
      const exposure = this.#db.prepare("SELECT owner, notional_atoms, state FROM hyperliquid_owner_exposures WHERE attempt_id = ?")
        .get(input.attemptId) as { owner: string; notional_atoms: string; state: string } | undefined;
      if (exposure?.state === "RELEASED") return false;
      if (exposure !== undefined && exposure.owner !== input.owner) {
        throw new HyperliquidOwnerLedgerError("LEDGER_CONFLICT", "Strategy attempt is bound to a different exposure.");
      }
      const notional = exposure === undefined ? input.notionalAtoms : BigInt(exposure.notional_atoms);
      if (notional <= 0n) {
        throw new HyperliquidOwnerLedgerError("LEDGER_CONFLICT", "An adopted strategy entry must hold a positive notional.");
      }
      this.#db.prepare(`
        INSERT INTO hyperliquid_owner_packages (entry_attempt_id, owner, entry_order_hash, state, reserved_notional_atoms, updated_at_ms)
        VALUES (?, ?, ?, 'PENDING_ENTRY', ?, ?)
      `).run(input.attemptId, input.owner, input.orderHash, notional.toString(), this.#now());
      release();
      return true;
    }).immediate();
  }

  #settleEntryOutcome(
    attemptId: string,
    outcome: "OPEN" | "RELEASED" | "UNRESOLVED",
    fill: HyperliquidEntryFill | undefined,
    entryNotionalAtoms: bigint,
  ): void {
    this.#db.transaction(() => {
      const row = this.#row(attemptId);
      const unresolvedEntry = row?.state === "UNRESOLVED" && row.exit_attempt_id === null;
      if (row === undefined || (row.state !== "PENDING_ENTRY" && !unresolvedEntry)) return;
      if (unresolvedEntry && outcome === "UNRESOLVED") return;
      if (outcome === "RELEASED") {
        this.#db.prepare("DELETE FROM hyperliquid_owner_packages WHERE entry_attempt_id = ?").run(attemptId);
        return;
      }
      if (outcome !== "OPEN" || fill === undefined || fill.spotQuantityAtoms <= 0n || fill.perpQuantityAtoms <= 0n
        || entryNotionalAtoms <= 0n) {
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
        fill.perpQuantityAtoms.toString(), fill.spotQuantityAtoms.toString(), entryNotionalAtoms.toString(),
        fill.entryReceiptHash, this.#now(), this.#now(), attemptId,
      );
    }).immediate();
  }

  /** The owner's open package an exit order closes: the named one, or else the oldest. */
  openPackage(owner: string, entryAttemptId?: string): HyperliquidOwnerPackage | undefined {
    const row = (entryAttemptId === undefined
      ? this.#db.prepare(`
        SELECT * FROM hyperliquid_owner_packages WHERE owner = ? AND state = 'OPEN'
        ORDER BY opened_at_ms, entry_attempt_id LIMIT 1
      `).get(owner)
      : this.#db.prepare(`
        SELECT * FROM hyperliquid_owner_packages WHERE owner = ? AND state = 'OPEN' AND entry_attempt_id = ?
      `).get(owner, entryAttemptId)) as PackageRow | undefined;
    return row === undefined ? undefined : decode(row);
  }

  /**
   * Binds a freshly built exit order to the owner's open package. Building an order needs no
   * signature, so every order built for the package stays valid: a later build never voids an exit
   * the owner already signed.
   */
  bindExitOrder(entryAttemptId: string, owner: string, exitOrderHash: string): void {
    this.#db.transaction(() => {
      const update = this.#db.prepare(`
        UPDATE hyperliquid_owner_packages SET exit_order_hash = ?, updated_at_ms = ?
        WHERE entry_attempt_id = ? AND owner = ? AND state = 'OPEN'
      `).run(exitOrderHash, this.#now(), entryAttemptId, owner);
      if (update.changes !== 1) throw new HyperliquidOwnerLedgerError("NO_OPEN_PACKAGE", "The wallet has no open package to exit.");
      this.#db.prepare(`
        INSERT OR IGNORE INTO hyperliquid_owner_exit_orders (exit_order_hash, entry_attempt_id, owner) VALUES (?, ?, ?)
      `).run(exitOrderHash, entryAttemptId, owner);
    }).immediate();
  }

  /**
   * Starts an exit only for the package the exit order was built for, owned by the order's owner,
   * selling its spot floored to the spot lot and buying back exactly its short. The sub-lot
   * remainder is base-fee dust that stays in the trading account under the residual caps.
   */
  beginExit(attemptId: string, terms: HyperliquidExitOrderTerms): void {
    this.#db.transaction(() => {
      const row = this.#db.prepare(`
        SELECT p.* FROM hyperliquid_owner_exit_orders e
        JOIN hyperliquid_owner_packages p ON p.entry_attempt_id = e.entry_attempt_id AND p.owner = e.owner
        WHERE e.exit_order_hash = ?
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

  /**
   * The caps both package kinds share, read inside the caller's write transaction: an owner's open
   * cash-and-carry packages plus their distinct generalized strategies, and every held notional.
   */
  #requireWithinLimits(owner: string, notionalAtoms: bigint, newPackage: boolean, limits: HyperliquidOmnibusLimits): void {
    const open = this.#db.prepare(`
      SELECT (SELECT COUNT(*) FROM hyperliquid_owner_packages WHERE owner = ? AND state IN ${ACTIVE_STATES})
        + (SELECT COUNT(DISTINCT strategy_key) FROM hyperliquid_owner_exposures WHERE owner = ? AND state IN ${ACTIVE_EXPOSURE_STATES})
    `).pluck().get(owner, owner) as number;
    if (newPackage && open >= limits.maxOpenPackagesPerOwner) {
      throw new HyperliquidOwnerLedgerError("OWNER_PACKAGE_LIMIT", "This wallet already has its maximum open Hyperliquid packages.");
    }
    const reserved = (this.#db.prepare(`
      SELECT reserved_notional_atoms FROM hyperliquid_owner_packages WHERE state IN ${ACTIVE_STATES}
      UNION ALL
      SELECT notional_atoms FROM hyperliquid_owner_exposures WHERE state IN ${ACTIVE_EXPOSURE_STATES}
    `).pluck().all() as string[]).reduce((total, atoms) => total + BigInt(atoms), 0n);
    if (reserved + notionalAtoms > limits.maxOpenNotionalQuoteAtoms) {
      throw new HyperliquidOwnerLedgerError("OMNIBUS_NOTIONAL_LIMIT", "The shared Hyperliquid testnet account is at its open notional limit.");
    }
  }

  #row(attemptId: string): PackageRow | undefined {
    return this.#db.prepare("SELECT * FROM hyperliquid_owner_packages WHERE entry_attempt_id = ?")
      .get(attemptId) as PackageRow | undefined;
  }
}
