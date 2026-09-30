import { createPublicKey, verify } from "node:crypto";
import type Database from "better-sqlite3";
import bs58 from "bs58";
import {
  commitmentHash,
  evidenceManifest,
  quoteHash as solverQuoteHash,
  routeHash,
  routePayload,
  solverQuote,
  evidenceManifestHash,
  packageOrderBytes,
  packageOrderHash,
  packageReceipt,
  packageReceiptHash,
  parseProtocolJson,
  replayRouteDecision,
  routeDecisionHash,
  requiresSuccessfulReceipt,
  stringifyProtocolJson,
  terminalOutcomeHash,
  terminalOutcomeRecord,
  toHex,
  validatePackageOrderProfile,
  verifyOutcomeReceiptLink,
  verifyReceiptFees,
} from "@naryx/protocol-types";
import type {
  AcceptedQuoteFeeTerms,
  EvidenceManifestInput,
  PackageOrder,
  PackageOrderInput,
  PackageReceiptInput,
  RouteDecisionInput,
  RouteDecisionReplay,
  RoutePayloadInput,
  SolverQuote,
  SolverQuoteInput,
  TerminalOutcomeInput,
  TerminalState,
} from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";

export class EvidenceStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EvidenceStoreError";
    this.code = code;
  }
}

/** Quotes one public order may store in total, so a quote flood cannot grow storage without bound. */
export const MAX_QUOTES_PER_ORDER = 512;
/** Quotes, live or not, one solver may store for one order; each new one replaces its previous. */
export const MAX_QUOTES_PER_SOLVER_PER_ORDER = 8;
/** Solvers whose latest quote for one order may be live at once. */
export const MAX_QUOTING_SOLVERS_PER_ORDER = 64;

/** Route decisions one solver may record for one order. */
export const MAX_ROUTE_DECISIONS_PER_SOLVER_PER_ORDER = 8;

/** Server time in a unit, or undefined when this server cannot judge that unit. */
export type NowIn = (unit: string) => bigint | undefined;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS public_orders (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  order_hash BLOB NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  nonce TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  order_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  UNIQUE (owner, nonce)
) STRICT;
CREATE TABLE IF NOT EXISTS terminal_outcomes (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  order_hash BLOB NOT NULL UNIQUE,
  terminal_state TEXT NOT NULL,
  solver_id TEXT,
  outcome_json TEXT NOT NULL,
  outcome_hash BLOB NOT NULL,
  receipt_json TEXT,
  receipt_hash BLOB,
  manifest_json TEXT NOT NULL,
  manifest_hash BLOB NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS order_quotes (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_hash BLOB NOT NULL UNIQUE,
  order_hash BLOB NOT NULL REFERENCES public_orders(order_hash),
  solver_id TEXT NOT NULL,
  quote_json TEXT NOT NULL,
  route_json TEXT NOT NULL,
  valid_until_unit TEXT NOT NULL,
  valid_until_value TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS order_quotes_by_order ON order_quotes(order_hash, cursor);
CREATE TRIGGER IF NOT EXISTS reject_order_quote_change BEFORE UPDATE ON order_quotes BEGIN SELECT RAISE(ABORT, 'quotes are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_order_quote_delete BEFORE DELETE ON order_quotes BEGIN SELECT RAISE(ABORT, 'quotes are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_public_order_change BEFORE UPDATE ON public_orders BEGIN SELECT RAISE(ABORT, 'orders are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_public_order_delete BEFORE DELETE ON public_orders BEGIN SELECT RAISE(ABORT, 'orders are append-only'); END;
CREATE TABLE IF NOT EXISTS route_decisions (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_hash BLOB NOT NULL UNIQUE,
  order_hash BLOB NOT NULL REFERENCES public_orders(order_hash),
  solver_id TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS route_decisions_by_order ON route_decisions(order_hash, solver_id, cursor);
CREATE TRIGGER IF NOT EXISTS reject_route_decision_change BEFORE UPDATE ON route_decisions BEGIN SELECT RAISE(ABORT, 'route decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_route_decision_delete BEFORE DELETE ON route_decisions BEGIN SELECT RAISE(ABORT, 'route decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_outcome_change BEFORE UPDATE ON terminal_outcomes BEGIN SELECT RAISE(ABORT, 'outcomes are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_outcome_delete BEFORE DELETE ON terminal_outcomes BEGIN SELECT RAISE(ABORT, 'outcomes are append-only'); END;
`;

export interface StoredOrder {
  readonly cursor: number;
  readonly orderHashHex: string;
  readonly order: PackageOrder;
  readonly owner: string;
  readonly signature: string;
  readonly receivedAtMs: number;
}

export interface StoredOutcome {
  readonly orderHashHex: string;
  readonly terminalState: TerminalState;
  readonly solverId?: string;
  readonly outcome: TerminalOutcomeInput;
  readonly outcomeHashHex: string;
  readonly receipt?: PackageReceiptInput;
  readonly receiptHashHex?: string;
  readonly evidenceManifest: EvidenceManifestInput;
  readonly evidenceManifestHashHex: string;
  readonly recordedAtMs: number;
}

export interface StoredOrderQuote {
  readonly quoteHashHex: string;
  readonly routeHashHex: string;
  readonly quote: SolverQuote;
  readonly route: RoutePayloadInput;
  readonly receivedAtMs: number;
}

export interface StoredRouteDecision {
  readonly decisionHashHex: string;
  readonly solverId: string;
  readonly decision: RouteDecisionInput;
  /** Recomputed from the stored decision on every read, never stored. */
  readonly replay: RouteDecisionReplay;
  readonly receivedAtMs: number;
}

export interface ExecutionQualitySummary {
  readonly label: "OBSERVED";
  readonly methodology: string;
  readonly solverId?: string;
  readonly terminalOutcomes: number;
  readonly byTerminalState: Readonly<Record<TerminalState, number>>;
  /** Share of terminal outcomes that produced a successful receipt, in basis points. */
  readonly successfulBps: number;
  /** Share of terminal outcomes that entered recovery, in basis points. */
  readonly recoveredBps: number;
  /** Time unhedged across successful receipts, in milliseconds; absent without receipts. */
  readonly timeUnhedgedMs?: { readonly median: bigint; readonly p95: bigint; readonly max: bigint };
  /** Receipt fields by their strongest evidence grade, so the grade of every metric is visible. */
  readonly receiptFieldEvidence: Readonly<Record<string, number>>;
}

/**
 * One solver's raw performance, each dimension from stored signed records: coverage of eligible
 * orders, first-quote latency, what became of the orders it was selected for, and price
 * improvement of its settled receipts against its own quotes. No composite score is formed.
 */
export interface SolverPerformanceSummary {
  readonly label: "OBSERVED";
  readonly methodology: string;
  readonly solverId: string;
  readonly eligibleDomainIds: readonly string[];
  /** Orders in the eligible domains among the newest `SOLVER_PERFORMANCE_ORDER_SAMPLE` stored orders. */
  readonly coverage: { readonly eligibleOrders: number; readonly quotedOrders: number; readonly coverageBps: number };
  /** From an order's receipt by the server to the solver's first quote for it, in milliseconds. */
  readonly firstQuoteLatencyMs?: { readonly median: number; readonly p95: number; readonly max: number };
  readonly outcomes: {
    readonly total: number;
    readonly byTerminalState: Readonly<Record<TerminalState, number>>;
    readonly settledBps: number;
    /** NO_EFFECT outcomes of orders the solver was selected for: the quote was not honored. */
    readonly fadeBps: number;
    readonly recoveredBps: number;
    /** Outcomes that kept a visible bounded residual. */
    readonly boundedResidualBps: number;
    readonly manualInterventionBps: number;
  };
  /**
   * Settled spot quote amounts against the solver's own quoted notional, in basis points of the
   * quote, truncated toward zero: positive when the taker paid less on entry or received more on exit.
   */
  readonly priceImprovementBps?: { readonly measured: number; readonly median: number; readonly min: number; readonly max: number };
}

export const SOLVER_PERFORMANCE_ORDER_SAMPLE = 10_000;

const TERMINAL_STATES: readonly TerminalState[] = [
  "FINALIZED_COMPLETE",
  "FINALIZED_BOUNDED",
  "RECOVERED_COMPLETE",
  "RECOVERED_BOUNDED",
  "RECOVERED_FLAT",
  "MANUAL_INTERVENTION",
  "NO_EFFECT",
];

function canonicalSignature(value: unknown): Uint8Array {
  if (typeof value !== "string") throw new EvidenceStoreError("INVALID_SIGNATURE", "The signature must be canonical base58.");
  try {
    const bytes = bs58.decode(value);
    if (bytes.length !== 64 || bs58.encode(bytes) !== value) throw new Error("not canonical");
    return bytes;
  } catch {
    throw new EvidenceStoreError("INVALID_SIGNATURE", "The signature must be canonical base58 of 64 bytes.");
  }
}

function ownerKey(owner: string): Uint8Array {
  try {
    const bytes = bs58.decode(owner);
    if (bytes.length !== 32 || bs58.encode(bytes) !== owner) throw new Error("not a key");
    return bytes;
  } catch {
    throw new EvidenceStoreError(
      "UNSUPPORTED_AUTHORIZATION",
      "Public order intake accepts Ed25519 owners only; other owners authorize through their domain flow.",
    );
  }
}

function guarded<T>(code: string, message: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof EvidenceStoreError) throw error;
    throw new EvidenceStoreError(code, `${message} ${error instanceof Error ? error.message : ""}`.trim());
  }
}

/**
 * Durable, append-only evidence for public reads. Orders enter only with an owner signature over
 * their exact canonical bytes, and one owner nonce names at most one order. Terminal outcomes are
 * stored once per order together with their evidence manifest and, for successful outcomes, the
 * linked receipt, after every kernel check passes: manifest hash, outcome and receipt schema,
 * outcome-to-receipt linkage, and receipt fees against the accepted quote.
 */
export class SqliteEvidenceStore {
  private readonly db: Database.Database;
  private readonly clock: () => number;

  constructor(dbPath: string, options: { readonly clock?: () => number } = {}) {
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new EvidenceStoreError(code, message));
    // Stores created before settlements were indexed by quote gain the column; their rows stay unindexed.
    const columns = this.db.prepare("PRAGMA table_info(terminal_outcomes)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "quote_hash")) this.db.exec("ALTER TABLE terminal_outcomes ADD COLUMN quote_hash BLOB");
    this.db.exec("CREATE INDEX IF NOT EXISTS terminal_outcomes_by_quote ON terminal_outcomes(quote_hash, solver_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS terminal_outcomes_by_receipt ON terminal_outcomes(receipt_hash)");
    this.clock = options.clock ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(run: () => T): T {
    return this.db.transaction(run).immediate();
  }

  /** Accepts a signed order. A repeat of the same order and signature is idempotent. */
  submitOrder(orderInput: PackageOrderInput, signatureText: string): { readonly orderHashHex: string; readonly replayed: boolean } {
    const order = guarded("INVALID_ORDER", "The order failed validation.", () => validatePackageOrderProfile(orderInput));
    const bytes = packageOrderBytes(order);
    const hash = packageOrderHash(order);
    const signature = canonicalSignature(signatureText);
    const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(ownerKey(order.owner))]), format: "der", type: "spki" });
    let valid = false;
    try {
      valid = verify(null, Buffer.from(bytes), publicKey, Buffer.from(signature));
    } catch {
      valid = false;
    }
    if (!valid) throw new EvidenceStoreError("INVALID_SIGNATURE", "The signature does not authorize the canonical order bytes.");
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT signature FROM public_orders WHERE order_hash = ?").get(hash) as { signature: string } | undefined;
      if (existing !== undefined) {
        if (existing.signature !== signatureText) throw new EvidenceStoreError("ORDER_CONFLICT", "This order was already submitted with another signature.");
        return { orderHashHex: toHex(hash), replayed: true };
      }
      const nonceTaken = this.db.prepare("SELECT 1 FROM public_orders WHERE owner = ? AND nonce = ?").get(order.owner, order.nonce.toString());
      if (nonceTaken !== undefined) throw new EvidenceStoreError("NONCE_REUSED", "The owner already used this nonce for a different order.");
      this.db
        .prepare("INSERT INTO public_orders (order_hash, owner, nonce, domain_id, order_json, signature, received_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(hash, order.owner, order.nonce.toString(), order.domain.domainId, stringifyProtocolJson(order), signatureText, this.clock());
      return { orderHashHex: toHex(hash), replayed: false };
    });
  }

  private decodeOrder(row: { cursor: number; order_hash: Uint8Array; order_json: string; owner: string; signature: string; received_at_ms: number }): StoredOrder {
    const order = guarded("CORRUPT_ROW", "A stored order failed validation.", () => validatePackageOrderProfile(parseProtocolJson(row.order_json) as PackageOrderInput));
    const hashHex = toHex(row.order_hash);
    if (toHex(packageOrderHash(order)) !== hashHex) throw new EvidenceStoreError("CORRUPT_ROW", "A stored order does not match its hash.");
    return Object.freeze({ cursor: row.cursor, orderHashHex: hashHex, order, owner: row.owner, signature: row.signature, receivedAtMs: row.received_at_ms });
  }

  getOrder(orderHashHex: string): StoredOrder | undefined {
    const row = this.db
      .prepare("SELECT cursor, order_hash, order_json, owner, signature, received_at_ms FROM public_orders WHERE order_hash = ?")
      .get(Buffer.from(orderHashHex, "hex")) as Parameters<SqliteEvidenceStore["decodeOrder"]>[0] | undefined;
    return row === undefined ? undefined : this.decodeOrder(row);
  }

  /**
   * Orders after a cursor that have no terminal outcome and have not expired, oldest first, for
   * solvers to quote. An order timed in a unit this server cannot judge stays listed. `nextCursor`
   * is the last cursor scanned, so a page of only expired orders still advances the caller.
   */
  openOrders(afterCursor: number, limit: number, now: NowIn): { readonly orders: readonly StoredOrder[]; readonly nextCursor: number } {
    const rows = this.db
      .prepare(
        `SELECT o.cursor, o.order_hash, o.order_json, o.owner, o.signature, o.received_at_ms FROM public_orders o
         LEFT JOIN terminal_outcomes t ON t.order_hash = o.order_hash
         WHERE o.cursor > ? AND t.order_hash IS NULL ORDER BY o.cursor LIMIT ?`,
      )
      .all(afterCursor, Math.max(1, Math.min(limit, 200))) as Parameters<SqliteEvidenceStore["decodeOrder"]>[0][];
    const orders = rows.map((row) => this.decodeOrder(row)).filter((entry) => !orderExpired(entry.order, now));
    const last = rows[rows.length - 1];
    return Object.freeze({ orders: Object.freeze(orders), nextCursor: last === undefined ? afterCursor : last.cursor });
  }

  /**
   * Records a solver's quote for an open public order together with the route it binds. The caller
   * has already authenticated the solver and verified the quote signature; the store checks that
   * the quote names a stored order without a terminal outcome and that the route hashes to the
   * quote's route hash. An expired order takes no quotes. A solver's newest quote for an order
   * replaces its previous ones, each solver stores a bounded number per order, and only a bounded
   * number of solvers may hold a live quote at once, so no one solver can crowd the others out.
   * A repeat of the same quote is idempotent.
   */
  recordQuote(quoteInput: SolverQuoteInput, routeInput: RoutePayloadInput, now: NowIn): { readonly quoteHashHex: string; readonly replayed: boolean } {
    const quote = guarded("INVALID_QUOTE", "The quote failed validation.", () => solverQuote(quoteInput));
    const route = guarded("INVALID_ROUTE", "The route failed validation.", () => routePayload(routeInput));
    if (toHex(routeHash(routeInput)) !== toHex(quote.routeHash)) throw new EvidenceStoreError("ROUTE_MISMATCH", "The route does not hash to the quote's route hash.");
    if (toHex(route.orderHash) !== toHex(quote.orderHash)) throw new EvidenceStoreError("ROUTE_MISMATCH", "The route is for another order.");
    const hash = solverQuoteHash(quoteInput);
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM order_quotes WHERE quote_hash = ?").get(hash) !== undefined) return { quoteHashHex: toHex(hash), replayed: true };
      const orderRow = this.db.prepare("SELECT order_json FROM public_orders WHERE order_hash = ?").get(quote.orderHash) as { order_json: string } | undefined;
      if (orderRow === undefined) throw new EvidenceStoreError("ORDER_NOT_FOUND", "The quote names no stored public order.");
      const order = parseProtocolJson(orderRow.order_json) as PackageOrderInput;
      if (orderExpired(order, now)) throw new EvidenceStoreError("ORDER_EXPIRED", "The order has expired.");
      if (order.environment !== quote.environment || order.domain.domainId !== quote.domain.domainId || route.environment !== quote.environment) {
        throw new EvidenceStoreError("ENVIRONMENT_MISMATCH", "The quote, route, and order name different environments or domains.");
      }
      if (this.db.prepare("SELECT 1 FROM terminal_outcomes WHERE order_hash = ?").get(quote.orderHash) !== undefined) {
        throw new EvidenceStoreError("ORDER_TERMINAL", "The order already has a terminal outcome.");
      }
      const stored = this.db
        .prepare("SELECT solver_id, valid_until_unit, valid_until_value FROM order_quotes WHERE order_hash = ? ORDER BY cursor")
        .all(quote.orderHash) as { solver_id: string; valid_until_unit: string; valid_until_value: string }[];
      if (stored.length >= MAX_QUOTES_PER_ORDER) throw new EvidenceStoreError("QUOTES_FULL", "This order has stored the maximum number of quotes.");
      if (stored.filter((row) => row.solver_id === quote.solverId).length >= MAX_QUOTES_PER_SOLVER_PER_ORDER) {
        throw new EvidenceStoreError("SOLVER_QUOTES_FULL", "This solver has stored the maximum number of quotes for this order.");
      }
      const liveSolvers = new Set(
        [...latestBySolver(stored, (row) => row.solver_id).values()]
          .filter((row) => stillLive(row.valid_until_unit, BigInt(row.valid_until_value), now))
          .map((row) => row.solver_id),
      );
      if (!liveSolvers.has(quote.solverId) && liveSolvers.size >= MAX_QUOTING_SOLVERS_PER_ORDER) {
        throw new EvidenceStoreError("QUOTES_FULL", "This order already holds live quotes from the maximum number of solvers.");
      }
      this.db
        .prepare(
          `INSERT INTO order_quotes (quote_hash, order_hash, solver_id, quote_json, route_json, valid_until_unit, valid_until_value, received_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(hash, quote.orderHash, quote.solverId, stringifyProtocolJson(quoteInput), stringifyProtocolJson(routeInput), quote.validUntilUnit, quote.validUntilValue.toString(), this.clock());
      return { quoteHashHex: toHex(hash), replayed: false };
    });
  }

  /**
   * Records a solver's route decision for a public order it has quoted. The decision must select
   * the route of one of that solver's own stored quotes for the order. It is replayed from its
   * bounded evidence and stored whatever the replay finds, so a decision with discrepancies stays
   * on the record as exactly that. A repeat of the same decision is idempotent.
   */
  recordRouteDecision(input: RouteDecisionInput): { readonly decisionHashHex: string; readonly replay: RouteDecisionReplay; readonly replayed: boolean } {
    const replay = guarded("INVALID_DECISION", "The route decision failed validation.", () => replayRouteDecision(input));
    const hash = replay.decisionHash;
    const orderHash = Buffer.from(commitmentHash(input.orderHash, "routeDecision.orderHash"));
    const selectedRouteHex = toHex(commitmentHash(input.selectedRouteHash, "routeDecision.selectedRouteHash"));
    const solverId = input.solverId;
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM route_decisions WHERE decision_hash = ?").get(hash) !== undefined) {
        return { decisionHashHex: toHex(hash), replay, replayed: true };
      }
      if (this.db.prepare("SELECT 1 FROM public_orders WHERE order_hash = ?").get(orderHash) === undefined) {
        throw new EvidenceStoreError("ORDER_NOT_FOUND", "The decision names no stored public order.");
      }
      const quoted = (this.db.prepare("SELECT quote_json FROM order_quotes WHERE order_hash = ? AND solver_id = ?").all(orderHash, solverId) as { quote_json: string }[])
        .some((row) => toHex(solverQuote(parseProtocolJson(row.quote_json) as SolverQuoteInput).routeHash) === selectedRouteHex);
      if (!quoted) throw new EvidenceStoreError("ROUTE_NOT_QUOTED", "The decision selects no route this solver quoted for the order.");
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM route_decisions WHERE order_hash = ? AND solver_id = ?").get(orderHash, solverId) as { count: number };
      if (count.count >= MAX_ROUTE_DECISIONS_PER_SOLVER_PER_ORDER) {
        throw new EvidenceStoreError("DECISIONS_FULL", "This solver has recorded the maximum number of route decisions for this order.");
      }
      this.db
        .prepare("INSERT INTO route_decisions (decision_hash, order_hash, solver_id, decision_json, received_at_ms) VALUES (?, ?, ?, ?, ?)")
        .run(hash, orderHash, solverId, stringifyProtocolJson(input), this.clock());
      return { decisionHashHex: toHex(hash), replay, replayed: false };
    });
  }

  /** Every route decision recorded for an order, oldest first, re-hashed and replayed on read. */
  routeDecisionsFor(orderHashHex: string): readonly StoredRouteDecision[] {
    const rows = this.db
      .prepare("SELECT decision_hash, solver_id, decision_json, received_at_ms FROM route_decisions WHERE order_hash = ? ORDER BY cursor")
      .all(Buffer.from(orderHashHex, "hex")) as { decision_hash: Uint8Array; solver_id: string; decision_json: string; received_at_ms: number }[];
    return Object.freeze(
      rows.map((row) => {
        const decision = parseProtocolJson(row.decision_json) as RouteDecisionInput;
        if (toHex(routeDecisionHash(decision)) !== toHex(row.decision_hash)) throw new EvidenceStoreError("CORRUPT_ROW", "A stored route decision does not match its hash.");
        return Object.freeze({ decisionHashHex: toHex(row.decision_hash), solverId: row.solver_id, decision, replay: replayRouteDecision(decision), receivedAtMs: row.received_at_ms });
      }),
    );
  }

  /**
   * Each solver's latest quote for an order while it is still live, oldest first, re-hashed on
   * read. A quote a solver has since replaced is not served; each quote is judged in its own unit.
   */
  quotesFor(orderHashHex: string, now: NowIn): readonly StoredOrderQuote[] {
    const rows = this.db
      .prepare("SELECT cursor, quote_hash, solver_id, quote_json, route_json, valid_until_unit, valid_until_value, received_at_ms FROM order_quotes WHERE order_hash = ? ORDER BY cursor")
      .all(Buffer.from(orderHashHex, "hex")) as {
      cursor: number;
      quote_hash: Uint8Array;
      solver_id: string;
      quote_json: string;
      route_json: string;
      valid_until_unit: string;
      valid_until_value: string;
      received_at_ms: number;
    }[];
    return Object.freeze(
      [...latestBySolver(rows, (row) => row.solver_id).values()]
        .sort((left, right) => left.cursor - right.cursor)
        .filter((row) => stillLive(row.valid_until_unit, BigInt(row.valid_until_value), now))
        .map((row) => {
          const quoteInput = parseProtocolJson(row.quote_json) as SolverQuoteInput;
          const route = parseProtocolJson(row.route_json) as RoutePayloadInput;
          if (toHex(solverQuoteHash(quoteInput)) !== toHex(row.quote_hash) || toHex(routeHash(route)) !== toHex(solverQuote(quoteInput).routeHash)) {
            throw new EvidenceStoreError("CORRUPT_ROW", "A stored quote does not match its hashes.");
          }
          return Object.freeze({
            quoteHashHex: toHex(row.quote_hash),
            routeHashHex: toHex(routeHash(route)),
            quote: solverQuote(quoteInput),
            route,
            receivedAtMs: row.received_at_ms,
          });
        }),
    );
  }

  /**
   * Records the one terminal outcome of an order. A successful outcome must carry its receipt and
   * the accepted quote's fee terms; any other outcome must carry neither receipt nor terms.
   */
  recordOutcome(input: {
    readonly evidenceManifest: EvidenceManifestInput;
    readonly outcome: TerminalOutcomeInput;
    readonly receipt?: PackageReceiptInput;
    readonly acceptedQuoteFeeTerms?: AcceptedQuoteFeeTerms;
  }): { readonly outcomeHashHex: string; readonly receiptHashHex?: string; readonly replayed: boolean } {
    const manifest = guarded("INVALID_EVIDENCE", "The evidence manifest failed validation.", () => evidenceManifest(input.evidenceManifest));
    const manifestHash = evidenceManifestHash(input.evidenceManifest);
    const outcome = guarded("INVALID_EVIDENCE", "The terminal outcome failed validation.", () => terminalOutcomeRecord(input.outcome));
    const outcomeHash = terminalOutcomeHash(input.outcome);
    if (toHex(outcome.evidenceManifestHash) !== toHex(manifestHash)) {
      throw new EvidenceStoreError("EVIDENCE_MISMATCH", "The outcome does not bind this evidence manifest.");
    }
    if (toHex(manifest.orderHash) !== toHex(outcome.orderHash)) throw new EvidenceStoreError("EVIDENCE_MISMATCH", "The manifest and outcome name different orders.");
    let receiptHash: Uint8Array | undefined;
    let solverId: string | undefined;
    let quoteHash: Uint8Array | undefined;
    if (requiresSuccessfulReceipt(outcome.terminalState)) {
      if (input.receipt === undefined || input.acceptedQuoteFeeTerms === undefined) {
        throw new EvidenceStoreError("RECEIPT_REQUIRED", "A successful outcome is recorded with its receipt and the accepted quote's fee terms.");
      }
      const receipt = guarded("INVALID_EVIDENCE", "The receipt failed validation.", () => packageReceipt(input.receipt as PackageReceiptInput));
      const link = verifyOutcomeReceiptLink(input.outcome, input.receipt);
      if (!link.valid) throw new EvidenceStoreError("EVIDENCE_MISMATCH", `The outcome and receipt do not link: ${link.violations.join(", ")}.`);
      const fees = verifyReceiptFees(input.receipt, input.acceptedQuoteFeeTerms);
      if (!fees.valid) throw new EvidenceStoreError("FEE_VIOLATION", `The receipt charges outside the accepted quote: ${fees.violations.join(", ")}.`);
      receiptHash = packageReceiptHash(input.receipt);
      solverId = receipt.solver;
      quoteHash = receipt.quoteHash;
    } else if (input.receipt !== undefined || input.acceptedQuoteFeeTerms !== undefined) {
      throw new EvidenceStoreError("RECEIPT_NOT_EXPECTED", `${outcome.terminalState} is not a successful outcome and has no receipt.`);
    }
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT outcome_hash, receipt_hash FROM terminal_outcomes WHERE order_hash = ?").get(outcome.orderHash) as
        | { outcome_hash: Uint8Array; receipt_hash: Uint8Array | null }
        | undefined;
      if (existing !== undefined) {
        if (toHex(existing.outcome_hash) !== toHex(outcomeHash)) {
          throw new EvidenceStoreError("OUTCOME_CONFLICT", "This order already has a different terminal outcome.");
        }
        return { outcomeHashHex: toHex(outcomeHash), ...(receiptHash === undefined ? {} : { receiptHashHex: toHex(receiptHash) }), replayed: true };
      }
      // A failed outcome names its solver only through the capability manifest hash. It is
      // attributed to the solver whose own signed quote for this order carries that hash, and to
      // nobody when no quote, or more than one solver, does.
      if (solverId === undefined && outcome.solverCapabilityManifestHash !== undefined) {
        const named = toHex(outcome.solverCapabilityManifestHash);
        const quoted = this.db.prepare("SELECT solver_id, quote_json FROM order_quotes WHERE order_hash = ?").all(outcome.orderHash) as { solver_id: string; quote_json: string }[];
        const matching = new Set(
          quoted
            .filter((row) => hexOf((parseProtocolJson(row.quote_json) as SolverQuoteInput).solverCapabilityManifestHash) === named)
            .map((row) => row.solver_id),
        );
        if (matching.size === 1) solverId = [...matching][0];
      }
      this.db
        .prepare(
          `INSERT INTO terminal_outcomes (order_hash, terminal_state, solver_id, quote_hash, outcome_json, outcome_hash, receipt_json, receipt_hash, manifest_json, manifest_hash, recorded_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          outcome.orderHash,
          outcome.terminalState,
          solverId ?? null,
          quoteHash ?? null,
          stringifyProtocolJson(input.outcome),
          outcomeHash,
          input.receipt === undefined ? null : stringifyProtocolJson(input.receipt),
          receiptHash ?? null,
          stringifyProtocolJson(input.evidenceManifest),
          manifestHash,
          this.clock(),
        );
      return { outcomeHashHex: toHex(outcomeHash), ...(receiptHash === undefined ? {} : { receiptHashHex: toHex(receiptHash) }), replayed: false };
    });
  }

  /** The successful outcome whose receipt has this hash, re-hashed on read like `getOutcome`. */
  outcomeByReceipt(receiptHashHex: string): StoredOutcome | undefined {
    const row = this.db.prepare("SELECT order_hash FROM terminal_outcomes WHERE receipt_hash = ?").get(Buffer.from(receiptHashHex, "hex")) as { order_hash: Uint8Array } | undefined;
    return row === undefined ? undefined : this.getOutcome(toHex(row.order_hash));
  }

  getOutcome(orderHashHex: string): StoredOutcome | undefined {
    const row = this.db
      .prepare("SELECT order_hash, terminal_state, solver_id, outcome_json, outcome_hash, receipt_json, receipt_hash, manifest_json, manifest_hash, recorded_at_ms FROM terminal_outcomes WHERE order_hash = ?")
      .get(Buffer.from(orderHashHex, "hex")) as
      | {
          order_hash: Uint8Array;
          terminal_state: string;
          solver_id: string | null;
          outcome_json: string;
          outcome_hash: Uint8Array;
          receipt_json: string | null;
          receipt_hash: Uint8Array | null;
          manifest_json: string;
          manifest_hash: Uint8Array;
          recorded_at_ms: number;
        }
      | undefined;
    if (row === undefined) return undefined;
    const outcome = parseProtocolJson(row.outcome_json) as TerminalOutcomeInput;
    const manifest = parseProtocolJson(row.manifest_json) as EvidenceManifestInput;
    // Stored evidence is re-hashed on every read; a modified row is reported, never served.
    if (toHex(terminalOutcomeHash(outcome)) !== toHex(row.outcome_hash) || toHex(evidenceManifestHash(manifest)) !== toHex(row.manifest_hash)) {
      throw new EvidenceStoreError("CORRUPT_ROW", "Stored outcome evidence does not match its hash.");
    }
    const receipt = row.receipt_json === null ? undefined : (parseProtocolJson(row.receipt_json) as PackageReceiptInput);
    if (receipt !== undefined && (row.receipt_hash === null || toHex(packageReceiptHash(receipt)) !== toHex(row.receipt_hash))) {
      throw new EvidenceStoreError("CORRUPT_ROW", "Stored receipt does not match its hash.");
    }
    return Object.freeze({
      orderHashHex: toHex(row.order_hash),
      terminalState: row.terminal_state as TerminalState,
      ...(row.solver_id === null ? {} : { solverId: row.solver_id }),
      outcome,
      outcomeHashHex: toHex(row.outcome_hash),
      ...(receipt === undefined ? {} : { receipt, receiptHashHex: toHex(row.receipt_hash as Uint8Array) }),
      evidenceManifest: manifest,
      evidenceManifestHashHex: toHex(row.manifest_hash),
      recordedAtMs: row.recorded_at_ms,
    });
  }

  /**
   * Settled receipts of one solver quote, oldest first: the orders that quote settled and how.
   * Only successful outcomes carry a receipt, and so a quote hash; other outcomes are not listed.
   */
  settlementsForQuote(quoteHashHex: string, solverId: string): readonly {
    readonly orderHashHex: string;
    readonly terminalState: TerminalState;
    readonly outcomeHashHex: string;
    readonly receiptHashHex: string;
    readonly recordedAtMs: number;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT order_hash, terminal_state, outcome_hash, receipt_hash, recorded_at_ms FROM terminal_outcomes
         WHERE quote_hash = ? AND solver_id = ? ORDER BY cursor LIMIT 100`,
      )
      .all(Buffer.from(quoteHashHex, "hex"), solverId) as {
      order_hash: Uint8Array;
      terminal_state: string;
      outcome_hash: Uint8Array;
      receipt_hash: Uint8Array;
      recorded_at_ms: number;
    }[];
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          orderHashHex: toHex(row.order_hash),
          terminalState: row.terminal_state as TerminalState,
          outcomeHashHex: toHex(row.outcome_hash),
          receiptHashHex: toHex(row.receipt_hash),
          recordedAtMs: row.recorded_at_ms,
        }),
      ),
    );
  }

  /**
   * Execution quality measured only from stored terminal outcomes and receipts. Nothing is
   * modeled or estimated; an empty store reports zero outcomes rather than defaults.
   */
  executionQuality(filter: { readonly solverId?: string } = {}): ExecutionQualitySummary {
    const rows = (filter.solverId === undefined
      ? this.db.prepare("SELECT terminal_state, receipt_json FROM terminal_outcomes").all()
      : this.db.prepare("SELECT terminal_state, receipt_json FROM terminal_outcomes WHERE solver_id = ?").all(filter.solverId)) as {
      terminal_state: string;
      receipt_json: string | null;
    }[];
    const byTerminalState = Object.fromEntries(TERMINAL_STATES.map((state) => [state, 0])) as Record<TerminalState, number>;
    const unhedged: bigint[] = [];
    const grades: Record<string, number> = {};
    for (const row of rows) {
      const state = row.terminal_state as TerminalState;
      if (state in byTerminalState) byTerminalState[state] += 1;
      if (row.receipt_json !== null) {
        const receipt = parseProtocolJson(row.receipt_json) as PackageReceiptInput;
        unhedged.push(receipt.timeUnhedgedMs);
        for (const field of receipt.fieldEvidence) grades[field.grade] = (grades[field.grade] ?? 0) + 1;
      }
    }
    const total = rows.length;
    const successful = byTerminalState.FINALIZED_COMPLETE + byTerminalState.FINALIZED_BOUNDED + byTerminalState.RECOVERED_COMPLETE + byTerminalState.RECOVERED_BOUNDED;
    const recovered = byTerminalState.RECOVERED_COMPLETE + byTerminalState.RECOVERED_BOUNDED + byTerminalState.RECOVERED_FLAT;
    const sorted = [...unhedged].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    // Nearest-rank percentiles, so every reported value is an observed one.
    const rank = (fraction: number) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] as bigint;
    return Object.freeze({
      label: "OBSERVED" as const,
      methodology: "Counts of stored terminal outcomes and successful receipts; nearest-rank percentiles of receipt timeUnhedgedMs.",
      ...(filter.solverId === undefined ? {} : { solverId: filter.solverId }),
      terminalOutcomes: total,
      byTerminalState: Object.freeze(byTerminalState),
      successfulBps: total === 0 ? 0 : Math.floor((successful * 10_000) / total),
      recoveredBps: total === 0 ? 0 : Math.floor((recovered * 10_000) / total),
      ...(sorted.length === 0 ? {} : { timeUnhedgedMs: Object.freeze({ median: rank(0.5), p95: rank(0.95), max: sorted[sorted.length - 1] as bigint }) }),
      receiptFieldEvidence: Object.freeze(grades),
    });
  }

  solverPerformance(solverIdInput: string, eligibleDomainIds: readonly string[]): SolverPerformanceSummary {
    const solverId = String(solverIdInput);
    const domains = [...new Set(eligibleDomainIds)].sort();
    const bps = (part: number, whole: number) => (whole === 0 ? 0 : Math.floor((part * 10_000) / whole));
    const rank = <T>(sorted: readonly T[], fraction: number) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] as T;

    const eligible = domains.length === 0
      ? []
      : (this.db
        .prepare(
          `SELECT order_hash, received_at_ms FROM (SELECT order_hash, domain_id, received_at_ms FROM public_orders ORDER BY cursor DESC LIMIT ?)
           WHERE domain_id IN (${domains.map(() => "?").join(", ")})`,
        )
        .all(SOLVER_PERFORMANCE_ORDER_SAMPLE, ...domains) as { order_hash: Uint8Array; received_at_ms: number }[]);
    const firstQuotes = new Map(
      (this.db.prepare("SELECT order_hash, MIN(received_at_ms) AS first_ms FROM order_quotes WHERE solver_id = ? GROUP BY order_hash").all(solverId) as {
        order_hash: Uint8Array;
        first_ms: number;
      }[]).map((row) => [toHex(row.order_hash), row.first_ms]),
    );
    const latencies: number[] = [];
    for (const order of eligible) {
      const first = firstQuotes.get(toHex(order.order_hash));
      if (first !== undefined) latencies.push(Math.max(0, first - order.received_at_ms));
    }
    latencies.sort((left, right) => left - right);

    const rows = this.db.prepare("SELECT terminal_state, receipt_json, quote_hash FROM terminal_outcomes WHERE solver_id = ?").all(solverId) as {
      terminal_state: string;
      receipt_json: string | null;
      quote_hash: Uint8Array | null;
    }[];
    const byTerminalState = Object.fromEntries(TERMINAL_STATES.map((state) => [state, 0])) as Record<TerminalState, number>;
    const improvements: number[] = [];
    const quoteOf = this.db.prepare("SELECT quote_json FROM order_quotes WHERE quote_hash = ? AND solver_id = ?");
    for (const row of rows) {
      const state = row.terminal_state as TerminalState;
      if (state in byTerminalState) byTerminalState[state] += 1;
      if (row.receipt_json === null || row.quote_hash === null) continue;
      const stored = quoteOf.get(row.quote_hash, solverId) as { quote_json: string } | undefined;
      if (stored === undefined) continue;
      const receipt = parseProtocolJson(row.receipt_json) as PackageReceiptInput;
      const quoted = (parseProtocolJson(stored.quote_json) as SolverQuoteInput).expectedSpotNotional.atoms;
      if (quoted <= 0n) continue;
      const settled = receipt.spotQuoteDelta < 0n ? -receipt.spotQuoteDelta : receipt.spotQuoteDelta;
      const improvement = receipt.action === "ENTRY" ? quoted - settled : settled - quoted;
      improvements.push(Number((improvement * 10_000n) / quoted));
    }
    improvements.sort((left, right) => left - right);
    const total = rows.length;
    const settled = byTerminalState.FINALIZED_COMPLETE + byTerminalState.FINALIZED_BOUNDED + byTerminalState.RECOVERED_COMPLETE + byTerminalState.RECOVERED_BOUNDED;
    const recovered = byTerminalState.RECOVERED_COMPLETE + byTerminalState.RECOVERED_BOUNDED + byTerminalState.RECOVERED_FLAT;
    return Object.freeze({
      label: "OBSERVED" as const,
      methodology:
        "Coverage: stored orders in the solver's supported domains that it quoted. Latency: order receipt to the solver's first quote. " +
        "Outcomes: terminal outcomes attributed to the solver by its receipt or its own quote's manifest hash. " +
        "Improvement: settled spot quote amount against the accepted quote's expected spot notional. Nearest-rank percentiles.",
      solverId,
      eligibleDomainIds: Object.freeze(domains),
      coverage: Object.freeze({ eligibleOrders: eligible.length, quotedOrders: latencies.length, coverageBps: bps(latencies.length, eligible.length) }),
      ...(latencies.length === 0 ? {} : { firstQuoteLatencyMs: Object.freeze({ median: rank(latencies, 0.5), p95: rank(latencies, 0.95), max: latencies[latencies.length - 1] as number }) }),
      outcomes: Object.freeze({
        total,
        byTerminalState: Object.freeze(byTerminalState),
        settledBps: bps(settled, total),
        fadeBps: bps(byTerminalState.NO_EFFECT, total),
        recoveredBps: bps(recovered, total),
        boundedResidualBps: bps(byTerminalState.FINALIZED_BOUNDED + byTerminalState.RECOVERED_BOUNDED, total),
        manualInterventionBps: bps(byTerminalState.MANUAL_INTERVENTION, total),
      }),
      ...(improvements.length === 0
        ? {}
        : {
          priceImprovementBps: Object.freeze({
            measured: improvements.length,
            median: rank(improvements, 0.5),
            min: improvements[0] as number,
            max: improvements[improvements.length - 1] as number,
          }),
        }),
    });
  }
}

function hexOf(value: Uint8Array | string): string {
  return typeof value === "string" ? value.toLowerCase() : toHex(value);
}

function orderExpired(order: PackageOrderInput, now: NowIn): boolean {
  const current = now(order.expiryUnit);
  return current !== undefined && current >= BigInt(order.expiryValue);
}

/** A quote is live only while this server can judge its unit and it has not yet expired. */
function stillLive(unit: string, validUntilValue: bigint, now: NowIn): boolean {
  const current = now(unit);
  return current !== undefined && current < validUntilValue;
}

function latestBySolver<T>(rows: readonly T[], solverOf: (row: T) => string): Map<string, T> {
  const latest = new Map<string, T>();
  for (const row of rows) latest.set(solverOf(row), row);
  return latest;
}
