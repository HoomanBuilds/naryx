import type Database from "better-sqlite3";
import bs58 from "bs58";
import {
  applyStrategyCommand,
  parseProtocolJson,
  strategyCommandBytes,
  strategyCommandHash,
  strategyCommandSubjects,
  strategyState,
  strategyStateHash,
  stringifyProtocolJson,
  toHex,
} from "@naryx/protocol-types";
import type { PackageReceiptInput, StrategyCommandInput, StrategyRejection, StrategyState, StrategyTransitionReceipt } from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";
import { verifyEd25519 } from "./ed25519.js";

export class StrategyBookError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StrategyBookError";
    this.code = code;
  }
}

const MAXIMUM_COMMAND_SKEW_MS = 300_000n;
const MAX_STRATEGIES_PER_OWNER = 500;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS strategies (
  strategy_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  state_version TEXT NOT NULL,
  state_hash BLOB NOT NULL,
  state_json TEXT NOT NULL,
  origin_receipt_hash BLOB UNIQUE,
  retired_by BLOB,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS strategies_by_owner ON strategies(owner_id, strategy_id);
CREATE TABLE IF NOT EXISTS strategy_commands (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  command_hash BLOB NOT NULL UNIQUE,
  command_json TEXT NOT NULL,
  signature BLOB NOT NULL,
  receipt_json TEXT,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS strategy_command_subjects (
  command_cursor INTEGER NOT NULL REFERENCES strategy_commands(cursor),
  strategy_id TEXT NOT NULL,
  PRIMARY KEY (strategy_id, command_cursor)
) STRICT;
CREATE TRIGGER IF NOT EXISTS reject_strategy_command_change BEFORE UPDATE ON strategy_commands BEGIN SELECT RAISE(ABORT, 'strategy commands are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_command_delete BEFORE DELETE ON strategy_commands BEGIN SELECT RAISE(ABORT, 'strategy commands are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_subject_change BEFORE UPDATE ON strategy_command_subjects BEGIN SELECT RAISE(ABORT, 'strategy command subjects are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_subject_delete BEFORE DELETE ON strategy_command_subjects BEGIN SELECT RAISE(ABORT, 'strategy command subjects are append-only'); END;
`;

export interface StoredStrategy {
  readonly state: StrategyState;
  readonly stateHashHex: string;
  readonly originReceiptHashHex?: string;
  /** The command that split or merged this strategy away; a retired strategy takes no commands. */
  readonly retiredByCommandHashHex?: string;
}

export interface StoredStrategyCommand {
  readonly commandHashHex: string;
  readonly command: StrategyCommandInput;
  readonly signatureBase58: string;
  readonly receipt?: StrategyTransitionReceipt;
  readonly recordedAtMs: number;
}

export type StrategyCommandResult =
  | {
    readonly accepted: true;
    readonly replayed: boolean;
    readonly commandHashHex: string;
    readonly receipt?: StrategyTransitionReceipt;
    readonly states: readonly { readonly strategyId: string; readonly stateVersion: bigint; readonly stateHashHex: string }[];
  }
  | { readonly accepted: false; readonly rejection: StrategyRejection; readonly remedy?: string };

/**
 * Checks that a settled entry receipt can found a strategy: the book asks it for the receipt and
 * compares the owner, market, and leg quantities itself.
 */
export type OriginReceiptReader = (receiptHashHex: string) => PackageReceiptInput | undefined;

/**
 * The durable strategy book. Every command is signed by its actor's Ed25519 key over the
 * command hash and applied through the kernel's lifecycle rules against the exact stored prior
 * state. A strategy opens only from one settled entry receipt that names its owner and market and
 * whose spot and perpetual deltas are exactly its legs; no receipt founds two strategies. Commands
 * and their transition receipts are append-only, and a replayed command returns its first result.
 */
export class SqliteStrategyBookStore {
  private readonly db: Database.Database;
  private readonly clock: () => number;
  private readonly environment: string;
  private readonly originReceipt: OriginReceiptReader;

  constructor(dbPath: string, options: { readonly environment: string; readonly originReceipt: OriginReceiptReader; readonly clock?: () => number }) {
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new StrategyBookError(code, message));
    this.environment = options.environment;
    this.originReceipt = options.originReceipt;
    this.clock = options.clock ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  submit(command: StrategyCommandInput, signatureBase58: string): StrategyCommandResult {
    let commandHash: Uint8Array;
    try {
      strategyCommandBytes(command);
      commandHash = strategyCommandHash(command);
    } catch (error) {
      throw new StrategyBookError("INVALID_COMMAND", `The command failed validation: ${(error as Error).message}`);
    }
    if (command.environment !== this.environment) throw new StrategyBookError("WRONG_ENVIRONMENT", `This book serves ${this.environment}.`);
    let actorKey: Uint8Array;
    let signature: Uint8Array;
    try {
      actorKey = bs58.decode(command.actorId);
      signature = bs58.decode(signatureBase58);
    } catch {
      throw new StrategyBookError("INVALID_SIGNATURE", "The actor id and signature must be base58.");
    }
    if (actorKey.length !== 32 || !verifyEd25519(actorKey, commandHash, signature)) {
      throw new StrategyBookError("INVALID_SIGNATURE", "The command is not signed by the Ed25519 key its actor id names.");
    }
    const now = BigInt(this.clock());
    if (command.atValue > now + MAXIMUM_COMMAND_SKEW_MS || command.atValue + MAXIMUM_COMMAND_SKEW_MS < now) {
      throw new StrategyBookError("STALE_COMMAND", "The command time is outside five minutes of the book's clock.");
    }
    return this.db.transaction((): StrategyCommandResult => {
      const known = this.db.prepare("SELECT receipt_json FROM strategy_commands WHERE command_hash = ?").get(commandHash) as { receipt_json: string | null } | undefined;
      if (known !== undefined) {
        const receipt = known.receipt_json === null ? undefined : (parseProtocolJson(known.receipt_json) as StrategyTransitionReceipt);
        return { accepted: true, replayed: true, commandHashHex: toHex(commandHash), ...(receipt === undefined ? {} : { receipt }), states: [] };
      }
      const subjects = strategyCommandSubjects(command);
      const states = new Map<string, StrategyState>();
      for (const id of subjects) {
        const stored = this.read(id);
        if (stored === undefined) {
          if (command.parameters.kind === "OPEN") continue;
          throw new StrategyBookError("STRATEGY_NOT_FOUND", `No strategy ${id} exists.`);
        }
        if (stored.retiredByCommandHashHex !== undefined) throw new StrategyBookError("STRATEGY_RETIRED", `Strategy ${id} was split or merged away.`);
        states.set(id, stored.state);
      }
      let outcome;
      try {
        outcome = applyStrategyCommand(command, states);
      } catch (error) {
        throw new StrategyBookError("INVALID_COMMAND", (error as Error).message);
      }
      const nowMs = this.clock();
      if (outcome.kind === "OPENED") {
        if (states.size > 0) throw new StrategyBookError("STRATEGY_EXISTS", "A strategy with this id already exists.");
        const parameters = command.parameters as Extract<StrategyCommandInput["parameters"], { kind: "OPEN" }>;
        const originHex = typeof parameters.originReceiptHash === "string" ? parameters.originReceiptHash.toLowerCase() : toHex(parameters.originReceiptHash);
        this.requireOrigin(originHex, outcome.state);
        if (this.db.prepare("SELECT 1 FROM strategies WHERE origin_receipt_hash = ?").get(Buffer.from(originHex, "hex")) !== undefined) {
          throw new StrategyBookError("ORIGIN_CLAIMED", "This receipt already founded a strategy.");
        }
        const owned = this.db.prepare("SELECT COUNT(*) AS count FROM strategies WHERE owner_id = ?").get(outcome.state.ownerId) as { count: number };
        if (owned.count >= MAX_STRATEGIES_PER_OWNER) throw new StrategyBookError("OWNER_FULL", `An owner holds at most ${MAX_STRATEGIES_PER_OWNER} strategies.`);
        this.write(outcome.state, nowMs, Buffer.from(originHex, "hex"));
        this.record(commandHash, command, signature, undefined, [outcome.state.strategyId], nowMs);
        return { accepted: true, replayed: false, commandHashHex: toHex(commandHash), states: [this.summary(outcome.state)] };
      }
      const result = outcome.result;
      if (!result.accepted) return { accepted: false, rejection: result.rejection, ...(result.remedy === undefined ? {} : { remedy: result.remedy }) };
      const nextIds = new Set(result.states.map((state) => state.strategyId as string));
      for (const state of result.states) {
        if (!states.has(state.strategyId) && this.read(state.strategyId) !== undefined) {
          throw new StrategyBookError("STRATEGY_EXISTS", `Strategy ${state.strategyId} already exists.`);
        }
      }
      for (const state of result.states) this.write(state, nowMs);
      // A prior strategy that is not among the results was split or merged away.
      for (const id of states.keys()) {
        if (!nextIds.has(id)) this.db.prepare("UPDATE strategies SET retired_by = ?, updated_at_ms = ? WHERE strategy_id = ?").run(commandHash, nowMs, id);
      }
      this.record(commandHash, command, signature, result.receipt, [...new Set([...states.keys(), ...nextIds])], nowMs);
      return { accepted: true, replayed: false, commandHashHex: toHex(commandHash), receipt: result.receipt, states: result.states.map((state) => this.summary(state)) };
    }).immediate();
  }

  strategy(strategyId: string): StoredStrategy | undefined {
    return this.read(strategyId);
  }

  history(strategyId: string, limit = 200): readonly StoredStrategyCommand[] {
    const rows = this.db
      .prepare(
        `SELECT c.command_hash, c.command_json, c.signature, c.receipt_json, c.recorded_at_ms FROM strategy_commands c
         JOIN strategy_command_subjects s ON s.command_cursor = c.cursor
         WHERE s.strategy_id = ? ORDER BY c.cursor ASC LIMIT ?`,
      )
      .all(strategyId, Math.min(Math.max(1, limit), 1_000)) as { command_hash: Uint8Array; command_json: string; signature: Uint8Array; receipt_json: string | null; recorded_at_ms: number }[];
    return rows.map((row) => {
      const command = parseProtocolJson(row.command_json) as StrategyCommandInput;
      // Stored commands are re-hashed on read; a modified row is reported, never served.
      if (toHex(strategyCommandHash(command)) !== toHex(row.command_hash)) throw new StrategyBookError("CORRUPT_ROW", "A stored command does not match its hash.");
      return Object.freeze({
        commandHashHex: toHex(row.command_hash),
        command,
        signatureBase58: bs58.encode(row.signature),
        ...(row.receipt_json === null ? {} : { receipt: parseProtocolJson(row.receipt_json) as StrategyTransitionReceipt }),
        recordedAtMs: row.recorded_at_ms,
      });
    });
  }

  ownerStrategies(ownerId: string): readonly StoredStrategy[] {
    const rows = this.db.prepare("SELECT strategy_id FROM strategies WHERE owner_id = ? ORDER BY strategy_id LIMIT ?").all(ownerId, MAX_STRATEGIES_PER_OWNER) as { strategy_id: string }[];
    return rows.map((row) => this.read(row.strategy_id)).filter((entry): entry is StoredStrategy => entry !== undefined);
  }

  /** The receipt must be a settled entry by this owner in this market whose deltas are exactly the legs. */
  private requireOrigin(originHex: string, state: StrategyState): void {
    const receipt = this.originReceipt(originHex);
    if (receipt === undefined) throw new StrategyBookError("ORIGIN_NOT_FOUND", "No settled receipt has this hash.");
    if (receipt.action !== "ENTRY") throw new StrategyBookError("ORIGIN_MISMATCH", "Only a settled entry founds a strategy.");
    if (receipt.owner !== state.ownerId || receipt.packageMarketId !== state.executionClassId) {
      throw new StrategyBookError("ORIGIN_MISMATCH", "The receipt names another owner or market.");
    }
    const spot = state.legs.filter((leg) => leg.venueId === receipt.spotVenue);
    const perp = state.legs.filter((leg) => leg.venueId === receipt.perpVenue);
    // Only an explicit net spot delta is a position; a gross fill quantity is not.
    const spotDelta = receipt.netSpotDelta;
    if (
      state.legs.length !== 2 || spot.length !== 1 || perp.length !== 1 || spotDelta === undefined ||
      spot[0]?.signedQuantityAtoms !== spotDelta || perp[0]?.signedQuantityAtoms !== receipt.perpPositionDelta
    ) {
      throw new StrategyBookError("ORIGIN_MISMATCH", "The legs must be exactly the receipt's spot and perpetual deltas.");
    }
  }

  private read(strategyId: string): StoredStrategy | undefined {
    const row = this.db.prepare("SELECT state_json, state_hash, origin_receipt_hash, retired_by FROM strategies WHERE strategy_id = ?").get(strategyId) as
      | { state_json: string; state_hash: Uint8Array; origin_receipt_hash: Uint8Array | null; retired_by: Uint8Array | null }
      | undefined;
    if (row === undefined) return undefined;
    const state = strategyState(parseProtocolJson(row.state_json) as StrategyState);
    if (toHex(strategyStateHash(state)) !== toHex(row.state_hash)) throw new StrategyBookError("CORRUPT_ROW", "A stored strategy does not match its hash.");
    return Object.freeze({
      state,
      stateHashHex: toHex(row.state_hash),
      ...(row.origin_receipt_hash === null ? {} : { originReceiptHashHex: toHex(row.origin_receipt_hash) }),
      ...(row.retired_by === null ? {} : { retiredByCommandHashHex: toHex(row.retired_by) }),
    });
  }

  private write(state: StrategyState, nowMs: number, originReceiptHash?: Uint8Array): void {
    this.db
      .prepare(
        `INSERT INTO strategies (strategy_id, owner_id, state_version, state_hash, state_json, origin_receipt_hash, retired_by, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (strategy_id) DO UPDATE SET owner_id = excluded.owner_id, state_version = excluded.state_version, state_hash = excluded.state_hash, state_json = excluded.state_json, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(state.strategyId, state.ownerId, state.stateVersion.toString(), strategyStateHash(state), stringifyProtocolJson(state), originReceiptHash ?? null, nowMs);
  }

  private record(commandHash: Uint8Array, command: StrategyCommandInput, signature: Uint8Array, receipt: StrategyTransitionReceipt | undefined, subjects: readonly string[], nowMs: number): void {
    const inserted = this.db
      .prepare("INSERT INTO strategy_commands (command_hash, command_json, signature, receipt_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?)")
      .run(commandHash, stringifyProtocolJson(command), signature, receipt === undefined ? null : stringifyProtocolJson(receipt), nowMs);
    const subject = this.db.prepare("INSERT INTO strategy_command_subjects (command_cursor, strategy_id) VALUES (?, ?)");
    for (const id of subjects) subject.run(inserted.lastInsertRowid, id);
  }

  private summary(state: StrategyState) {
    return Object.freeze({ strategyId: state.strategyId as string, stateVersion: state.stateVersion, stateHashHex: toHex(strategyStateHash(state)) });
  }
}
