import type Database from "better-sqlite3";
import {
  applyStrategyCommand,
  parseProtocolJson,
  strategyCommandBytes,
  strategyCommandHash,
  strategyCommandSubjects,
  strategyExecutionMatches,
  strategyExecutionReceiptHashes,
  strategyPackageReceipt,
  strategyState,
  strategyStateHash,
  stringifyProtocolJson,
  toHex,
  requiresSuccessfulReceipt,
} from "@naryx/protocol-types";
import type { PackageReceiptInput, StrategyCommandInput, StrategyPackageOrderInput, StrategyPackageReceiptInput, StrategyRejection, StrategyState, StrategyTransitionReceipt } from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";
import {
  storedStrategyCommandAuthorization,
  verifyStrategyCommandAuthorization,
  type StrategyCommandAuthorization,
} from "./strategy-command-authorization.js";

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
CREATE TABLE IF NOT EXISTS strategy_execution_receipts (
  receipt_hash BLOB PRIMARY KEY,
  command_hash BLOB NOT NULL,
  strategy_id TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS strategy_command_consents (
  command_hash BLOB NOT NULL,
  signer_id TEXT NOT NULL,
  signature BLOB NOT NULL,
  PRIMARY KEY (command_hash, signer_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS reject_execution_receipt_change BEFORE UPDATE ON strategy_execution_receipts BEGIN SELECT RAISE(ABORT, 'execution receipt claims are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_execution_receipt_delete BEFORE DELETE ON strategy_execution_receipts BEGIN SELECT RAISE(ABORT, 'execution receipt claims are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_consent_change BEFORE UPDATE ON strategy_command_consents BEGIN SELECT RAISE(ABORT, 'command consents are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_consent_delete BEFORE DELETE ON strategy_command_consents BEGIN SELECT RAISE(ABORT, 'command consents are append-only'); END;
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
  readonly authorization: StrategyCommandAuthorization;
  readonly receipt?: StrategyTransitionReceipt;
  /** Other owners' verified consents over the same command hash. */
  readonly consents: readonly StrategyCommandConsent[];
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
export type StrategyExecutionReceiptInput = PackageReceiptInput | StrategyPackageReceiptInput;
export type OriginReceiptReader = (receiptHashHex: string) => StrategyExecutionReceiptInput | undefined;
export type StrategyPackageOrderReader = (orderHashHex: string) => StrategyPackageOrderInput | undefined;

function isStrategyPackageReceipt(receipt: StrategyExecutionReceiptInput): receipt is StrategyPackageReceiptInput {
  return "legOutcomes" in receipt;
}

function aggregatePositionDeltas(receipt: StrategyPackageReceiptInput): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const outcome of receipt.legOutcomes) {
    if (outcome.positionLegId === undefined) continue;
    totals.set(outcome.positionLegId, (totals.get(outcome.positionLegId) ?? 0n) + outcome.settledQuantity.atoms);
  }
  for (const [legId, atoms] of totals) if (atoms === 0n) totals.delete(legId);
  return totals;
}

function aggregateLiabilityDeltas(receipt: StrategyPackageReceiptInput): Map<string, { readonly assetId: string; readonly atoms: bigint }> {
  const totals = new Map<string, { readonly assetId: string; readonly atoms: bigint }>();
  for (const outcome of receipt.legOutcomes) {
    if (outcome.liabilityId === undefined) continue;
    const assetId = outcome.settledQuantity.asset.assetId;
    const current = totals.get(outcome.liabilityId);
    if (current !== undefined && current.assetId !== assetId) {
      throw new StrategyBookError("ORIGIN_MISMATCH", `Liability ${outcome.liabilityId} was settled in multiple assets.`);
    }
    totals.set(outcome.liabilityId, { assetId, atoms: (current?.atoms ?? 0n) + outcome.settledQuantity.atoms });
  }
  for (const [liabilityId, delta] of totals) if (delta.atoms === 0n) totals.delete(liabilityId);
  return totals;
}

/**
 * Verifies one venue's evidence that a strategy's position there moved from one owner to another.
 * Without a verifier no venue confirms, so a novation is never accepted on a claim alone.
 */
export type TransferEvidenceVerifier = (claim: {
  readonly strategyId: string;
  readonly venueId: string;
  readonly evidenceHashHex: string;
  readonly fromOwnerId: string;
  readonly toOwnerId: string;
}) => boolean;

/** Another owner's wallet consent to a command, over the same command hash. */
export interface StrategyCommandConsent {
  readonly signerId: string;
  readonly authorization: StrategyCommandAuthorization;
}

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
  private readonly packageOrder: StrategyPackageOrderReader | undefined;
  private readonly transferEvidence: TransferEvidenceVerifier | undefined;

  constructor(dbPath: string, options: { readonly environment: string; readonly originReceipt: OriginReceiptReader; readonly packageOrder?: StrategyPackageOrderReader; readonly transferEvidence?: TransferEvidenceVerifier; readonly clock?: () => number }) {
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new StrategyBookError(code, message));
    this.environment = options.environment;
    this.originReceipt = options.originReceipt;
    this.packageOrder = options.packageOrder;
    this.transferEvidence = options.transferEvidence;
    this.clock = options.clock ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  environmentName(): string {
    return this.environment;
  }

  async submit(
    command: StrategyCommandInput,
    authorization: StrategyCommandAuthorization,
    consents: readonly StrategyCommandConsent[] = [],
  ): Promise<StrategyCommandResult> {
    let commandHash: Uint8Array;
    try {
      strategyCommandBytes(command);
      commandHash = strategyCommandHash(command);
    } catch (error) {
      throw new StrategyBookError("INVALID_COMMAND", `The command failed validation: ${(error as Error).message}`);
    }
    if (command.environment !== this.environment) throw new StrategyBookError("WRONG_ENVIRONMENT", `This book serves ${this.environment}.`);
    const signature = await verifyStrategyCommandAuthorization(command, command.actorId, authorization);
    if (signature === undefined) throw new StrategyBookError("INVALID_SIGNATURE", "The command is not signed by the actor identity it names.");
    // Consents are other owners' signatures over the same command hash; only verified ones count.
    if (!Array.isArray(consents) || consents.length > 3) throw new StrategyBookError("INVALID_SIGNATURE", "A command carries at most three consents.");
    const consented: { signerId: string; signature: Uint8Array }[] = [];
    for (const consent of consents) {
      const consentSignature = await verifyStrategyCommandAuthorization(command, consent.signerId, consent.authorization);
      if (consentSignature === undefined) throw new StrategyBookError("INVALID_SIGNATURE", "A consent is not signed by the identity its signer id names.");
      if (!consented.some((entry) => entry.signerId === consent.signerId)) consented.push({ signerId: consent.signerId, signature: consentSignature });
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
        outcome = applyStrategyCommand(command, states, this.evidenceFor(command, states, consented.map((entry) => entry.signerId)));
      } catch (error) {
        throw new StrategyBookError("INVALID_COMMAND", (error as Error).message);
      }
      const nowMs = this.clock();
      if (outcome.kind === "OPENED") {
        if (states.size > 0) throw new StrategyBookError("STRATEGY_EXISTS", "A strategy with this id already exists.");
        const parameters = command.parameters as Extract<StrategyCommandInput["parameters"], { kind: "OPEN" }>;
        const originHex = typeof parameters.originReceiptHash === "string" ? parameters.originReceiptHash.toLowerCase() : toHex(parameters.originReceiptHash);
        this.requireOrigin(originHex, outcome.state);
        if (
          this.db.prepare("SELECT 1 FROM strategies WHERE origin_receipt_hash = ?").get(Buffer.from(originHex, "hex")) !== undefined ||
          this.db.prepare("SELECT 1 FROM strategy_execution_receipts WHERE receipt_hash = ?").get(Buffer.from(originHex, "hex")) !== undefined
        ) {
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
      const executionReceipts = this.requireExecution(command, states, result.states);
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
      const claim = this.db.prepare("INSERT INTO strategy_execution_receipts (receipt_hash, command_hash, strategy_id, recorded_at_ms) VALUES (?, ?, ?, ?)");
      for (const receiptHash of executionReceipts) claim.run(receiptHash, commandHash, command.strategyId, nowMs);
      const consent = this.db.prepare("INSERT INTO strategy_command_consents (command_hash, signer_id, signature) VALUES (?, ?, ?)");
      for (const entry of consented) consent.run(commandHash, entry.signerId, entry.signature);
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
    const consents = this.db.prepare("SELECT signer_id, signature FROM strategy_command_consents WHERE command_hash = ? ORDER BY signer_id");
    return rows.map((row) => {
      const command = parseProtocolJson(row.command_json) as StrategyCommandInput;
      // Stored commands are re-hashed on read; a modified row is reported, never served.
      if (toHex(strategyCommandHash(command)) !== toHex(row.command_hash)) throw new StrategyBookError("CORRUPT_ROW", "A stored command does not match its hash.");
      return Object.freeze({
        commandHashHex: toHex(row.command_hash),
        command,
        authorization: storedStrategyCommandAuthorization(command.actorId, row.signature),
        consents: (consents.all(row.command_hash) as { signer_id: string; signature: Uint8Array }[]).map((entry) => Object.freeze({
          signerId: entry.signer_id,
          authorization: storedStrategyCommandAuthorization(entry.signer_id, entry.signature),
        })),
        ...(row.receipt_json === null ? {} : { receipt: parseProtocolJson(row.receipt_json) as StrategyTransitionReceipt }),
        recordedAtMs: row.recorded_at_ms,
      });
    });
  }

  ownerStrategies(ownerId: string): readonly StoredStrategy[] {
    const rows = this.db.prepare("SELECT strategy_id FROM strategies WHERE owner_id = ? ORDER BY strategy_id LIMIT ?").all(ownerId, MAX_STRATEGIES_PER_OWNER) as { strategy_id: string }[];
    return rows.map((row) => this.read(row.strategy_id)).filter((entry): entry is StoredStrategy => entry !== undefined);
  }

  /** Verified consents and venue transfer evidence for a novation; nothing for any other command. */
  private evidenceFor(command: StrategyCommandInput, states: ReadonlyMap<string, StrategyState>, consentingOwnerIds: readonly string[]) {
    const parameters = command.parameters;
    if (parameters.kind !== "NOVATE") return {};
    const current = states.get(command.strategyId);
    const confirmedVenueIds = current === undefined || this.transferEvidence === undefined
      ? []
      : parameters.venueConfirmations
        .filter((confirmation) => this.transferEvidence?.({
          strategyId: command.strategyId,
          venueId: confirmation.venueId,
          evidenceHashHex: typeof confirmation.evidenceHash === "string" ? confirmation.evidenceHash.toLowerCase() : toHex(confirmation.evidenceHash),
          fromOwnerId: current.ownerId,
          toOwnerId: parameters.newOwnerId,
        }) === true)
        .map((confirmation) => confirmation.venueId);
    return { consentingOwnerIds, confirmedVenueIds };
  }

  /**
   * A position-moving command must be accounted for by settled receipts that no strategy has
   * founded on or claimed: their per-venue deltas are the exact change the kernel computed.
   */
  private requireExecution(command: StrategyCommandInput, states: ReadonlyMap<string, StrategyState>, next: readonly StrategyState[]): readonly Uint8Array[] {
    const hashes = strategyExecutionReceiptHashes(command.parameters);
    if (hashes.length === 0) return [];
    const receipts = hashes.map((hash) => {
      const hex = toHex(hash);
      if (
        this.db.prepare("SELECT 1 FROM strategy_execution_receipts WHERE receipt_hash = ?").get(hash) !== undefined ||
        this.db.prepare("SELECT 1 FROM strategies WHERE origin_receipt_hash = ?").get(hash) !== undefined
      ) {
        throw new StrategyBookError("RECEIPT_CLAIMED", `Receipt ${hex} already accounts for another strategy change.`);
      }
      const receipt = this.originReceipt(hex);
      if (receipt === undefined) throw new StrategyBookError("RECEIPT_NOT_FOUND", `No settled receipt has hash ${hex}.`);
      return receipt;
    });
    const prior = states.get(command.strategyId) as StrategyState;
    const packageOrders = command.parameters.kind === "APPLY_PACKAGE"
      ? receipts.map((receipt) => {
        if (!isStrategyPackageReceipt(receipt)) {
          throw new StrategyBookError("EXECUTION_AMBIGUOUS", "A generalized package transition requires generalized receipts.");
        }
        const orderHashHex = toHex(strategyPackageReceipt(receipt).orderHash);
        const order = this.packageOrder?.(orderHashHex);
        if (order === undefined) throw new StrategyBookError("ORDER_NOT_FOUND", `No package order has hash ${orderHashHex}.`);
        return order;
      })
      : [];
    const check = strategyExecutionMatches(
      command.parameters.kind,
      prior,
      next[0] as StrategyState,
      receipts,
      command.parameters.kind === "APPLY_PACKAGE" ? command.parameters.operation : undefined,
      packageOrders,
    );
    if (!check.matches) throw new StrategyBookError(check.mismatch, "The bound receipts do not account for this exact position change.");
    return hashes;
  }

  /** The receipt must be a settled entry by this owner in this market whose deltas are exactly the legs. */
  private requireOrigin(originHex: string, state: StrategyState): void {
    const receipt = this.originReceipt(originHex);
    if (receipt === undefined) throw new StrategyBookError("ORIGIN_NOT_FOUND", "No settled receipt has this hash.");
    if (isStrategyPackageReceipt(receipt)) {
      const checked = strategyPackageReceipt(receipt);
      if (
        !requiresSuccessfulReceipt(checked.terminalState)
        || checked.lifecycleAction === "exit"
        || checked.lifecycleAction === "decrease"
        || checked.lifecycleAction === "emergency-unwind"
      ) {
        throw new StrategyBookError("ORIGIN_MISMATCH", "Only a successful risk-opening package execution founds a strategy.");
      }
      if (checked.owner !== state.ownerId || checked.executionClassId !== state.executionClassId || checked.seriesId !== state.seriesId) {
        throw new StrategyBookError("ORIGIN_MISMATCH", "The receipt names another owner, series, or execution class.");
      }
      const deltas = aggregatePositionDeltas(checked);
      if (deltas.size !== state.legs.length || state.legs.some((leg) => deltas.get(leg.legId) !== leg.signedQuantityAtoms)) {
        throw new StrategyBookError("ORIGIN_MISMATCH", "The receipt position deltas do not exactly found the strategy legs.");
      }
      const liabilities = aggregateLiabilityDeltas(checked);
      if (
        liabilities.size !== state.liabilities.length
        || state.liabilities.some((liability) => {
          const delta = liabilities.get(liability.liabilityId);
          return delta?.assetId !== liability.assetId || delta.atoms !== liability.atoms;
        })
      ) {
        throw new StrategyBookError("ORIGIN_MISMATCH", "The receipt liability deltas do not exactly found the strategy liabilities.");
      }
      return;
    }
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
