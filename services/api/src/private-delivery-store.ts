import type Database from "better-sqlite3";
import {
  applySealedAuctionEvent,
  closeSealedAuction,
  openSealedAuction,
  parseProtocolJson,
  privateRfqEnvelope,
  privateRfqEnvelopeHash,
  sealedAuctionDefinition,
  sealedAuctionHash,
  sealedAuctionPublicView,
  stringifyProtocolJson,
  toHex,
} from "@naryx/protocol-types";
import type {
  PrivateRfqEnvelope,
  PrivateRfqEnvelopeInput,
  SealedAuctionDefinition,
  SealedAuctionDefinitionInput,
  SealedAuctionEvent,
  SealedAuctionRejection,
  SealedAuctionResult,
  SealedAuctionState,
} from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";

export class PrivateDeliveryStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PrivateDeliveryStoreError";
    this.code = code;
  }
}

const MAX_AUCTION_EVENTS = 256;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rfq_envelopes (
  envelope_hash BLOB PRIMARY KEY,
  recipient_solver_id TEXT NOT NULL,
  sender_key_id TEXT NOT NULL,
  envelope_nonce TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  expires_at_value TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  UNIQUE (sender_key_id, envelope_nonce, recipient_solver_id)
) STRICT;
CREATE INDEX IF NOT EXISTS rfq_envelopes_by_recipient ON rfq_envelopes(recipient_solver_id, received_at_ms);
CREATE TABLE IF NOT EXISTS rfq_acknowledgements (
  envelope_hash BLOB PRIMARY KEY REFERENCES rfq_envelopes(envelope_hash),
  acknowledged_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS rfq_responses (
  response_hash BLOB PRIMARY KEY,
  envelope_hash BLOB NOT NULL UNIQUE REFERENCES rfq_envelopes(envelope_hash),
  response_json TEXT NOT NULL,
  response_ciphertext BLOB NOT NULL,
  received_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sealed_auctions (
  auction_hash BLOB PRIMARY KEY,
  definition_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sealed_auction_events (
  auction_hash BLOB NOT NULL REFERENCES sealed_auctions(auction_hash),
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (auction_hash, sequence)
) STRICT;
CREATE TRIGGER IF NOT EXISTS reject_envelope_change BEFORE UPDATE ON rfq_envelopes BEGIN SELECT RAISE(ABORT, 'envelopes are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_response_change BEFORE UPDATE ON rfq_responses BEGIN SELECT RAISE(ABORT, 'responses are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_auction_event_change BEFORE UPDATE ON sealed_auction_events BEGIN SELECT RAISE(ABORT, 'auction events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_auction_event_delete BEFORE DELETE ON sealed_auction_events BEGIN SELECT RAISE(ABORT, 'auction events are append-only'); END;
`;

export interface StoredEnvelope {
  readonly envelopeHashHex: string;
  readonly envelope: PrivateRfqEnvelope;
  readonly ciphertext: Uint8Array;
  readonly acknowledged: boolean;
  readonly response?: { readonly responseHashHex: string; readonly response: unknown; readonly responseCiphertext: Uint8Array };
}

/**
 * Durable relay state for private delivery. Envelopes and responses are ciphertext plus canonical
 * metadata only; the relay holds no decryption key. Sealed auctions keep an append-only event log
 * and recompute state from it on every read, so a restarted coordinator reaches the same result.
 */
export class SqlitePrivateDeliveryStore {
  private readonly db: Database.Database;
  private readonly clock: () => number;

  constructor(dbPath: string, options: { readonly clock?: () => number } = {}) {
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new PrivateDeliveryStoreError(code, message));
    this.clock = options.clock ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(run: () => T): T {
    return this.db.transaction(run).immediate();
  }

  /** True when the sender already used this nonce for this recipient. */
  nonceSeen(envelope: PrivateRfqEnvelopeInput): boolean {
    const checked = privateRfqEnvelope(envelope);
    return (
      this.db
        .prepare("SELECT 1 FROM rfq_envelopes WHERE sender_key_id = ? AND envelope_nonce = ? AND recipient_solver_id = ?")
        .get(checked.senderKeyId, checked.envelopeNonce.toString(), checked.recipientSolverId) !== undefined
    );
  }

  /** Stores an envelope the caller already admitted; a repeat of the same envelope is idempotent. */
  storeEnvelope(envelopeInput: PrivateRfqEnvelopeInput, ciphertext: Uint8Array): { readonly envelopeHashHex: string; readonly created: boolean } {
    const envelope = privateRfqEnvelope(envelopeInput);
    const hash = privateRfqEnvelopeHash(envelope);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT 1 FROM rfq_envelopes WHERE envelope_hash = ?").get(hash);
      if (existing !== undefined) return { envelopeHashHex: toHex(hash), created: false };
      try {
        this.db
          .prepare(
            "INSERT INTO rfq_envelopes (envelope_hash, recipient_solver_id, sender_key_id, envelope_nonce, envelope_json, ciphertext, expires_at_value, received_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(hash, envelope.recipientSolverId, envelope.senderKeyId, envelope.envelopeNonce.toString(), stringifyProtocolJson(envelope), ciphertext, envelope.expiresAtValue.toString(), this.clock());
      } catch {
        throw new PrivateDeliveryStoreError("REPLAY", "The sender already used this nonce for this recipient.");
      }
      return { envelopeHashHex: toHex(hash), created: true };
    });
  }

  private decodeEnvelope(row: { envelope_hash: Uint8Array; envelope_json: string; ciphertext: Uint8Array }): StoredEnvelope {
    const hashHex = toHex(row.envelope_hash);
    const envelope = privateRfqEnvelope(parseProtocolJson(row.envelope_json) as PrivateRfqEnvelopeInput);
    if (toHex(privateRfqEnvelopeHash(envelope)) !== hashHex) throw new PrivateDeliveryStoreError("CORRUPT_ROW", "Stored envelope does not match its hash.");
    const acknowledged = this.db.prepare("SELECT 1 FROM rfq_acknowledgements WHERE envelope_hash = ?").get(row.envelope_hash) !== undefined;
    const response = this.db
      .prepare("SELECT response_hash, response_json, response_ciphertext FROM rfq_responses WHERE envelope_hash = ?")
      .get(row.envelope_hash) as { response_hash: Uint8Array; response_json: string; response_ciphertext: Uint8Array } | undefined;
    return Object.freeze({
      envelopeHashHex: hashHex,
      envelope,
      ciphertext: Uint8Array.from(row.ciphertext),
      acknowledged,
      ...(response === undefined
        ? {}
        : { response: { responseHashHex: toHex(response.response_hash), response: parseProtocolJson(response.response_json), responseCiphertext: Uint8Array.from(response.response_ciphertext) } }),
    });
  }

  getEnvelope(envelopeHashHex: string): StoredEnvelope | undefined {
    const row = this.db
      .prepare("SELECT envelope_hash, envelope_json, ciphertext FROM rfq_envelopes WHERE envelope_hash = ?")
      .get(Buffer.from(envelopeHashHex, "hex")) as { envelope_hash: Uint8Array; envelope_json: string; ciphertext: Uint8Array } | undefined;
    return row === undefined ? undefined : this.decodeEnvelope(row);
  }

  /** Unacknowledged, unexpired envelopes addressed to one solver, oldest first. */
  pendingFor(solverId: string, isExpired: (envelope: PrivateRfqEnvelope) => boolean, limit = 50): readonly StoredEnvelope[] {
    const rows = this.db
      .prepare(
        `SELECT e.envelope_hash, e.envelope_json, e.ciphertext FROM rfq_envelopes e
         LEFT JOIN rfq_acknowledgements a ON a.envelope_hash = e.envelope_hash
         WHERE e.recipient_solver_id = ? AND a.envelope_hash IS NULL ORDER BY e.received_at_ms LIMIT 500`,
      )
      .all(solverId) as { envelope_hash: Uint8Array; envelope_json: string; ciphertext: Uint8Array }[];
    return Object.freeze(rows.map((row) => this.decodeEnvelope(row)).filter((entry) => !isExpired(entry.envelope)).slice(0, limit));
  }

  acknowledge(envelopeHashHex: string, solverId: string): void {
    this.transaction(() => {
      const stored = this.getEnvelope(envelopeHashHex);
      if (stored === undefined || stored.envelope.recipientSolverId !== solverId) {
        throw new PrivateDeliveryStoreError("NOT_FOUND", "No such envelope for this solver.");
      }
      this.db.prepare("INSERT OR IGNORE INTO rfq_acknowledgements (envelope_hash, acknowledged_at_ms) VALUES (?, ?)").run(Buffer.from(envelopeHashHex, "hex"), this.clock());
    });
  }

  /** Stores one encrypted response per envelope; the caller verified it with the kernel first. */
  storeResponse(envelopeHashHex: string, responseHash: Uint8Array, response: unknown, responseCiphertext: Uint8Array): void {
    this.transaction(() => {
      const existing = this.db.prepare("SELECT response_hash FROM rfq_responses WHERE envelope_hash = ?").get(Buffer.from(envelopeHashHex, "hex")) as
        | { response_hash: Uint8Array }
        | undefined;
      if (existing !== undefined) {
        if (toHex(existing.response_hash) === toHex(responseHash)) return;
        throw new PrivateDeliveryStoreError("RESPONSE_EXISTS", "This envelope already has a different response.");
      }
      this.db
        .prepare("INSERT INTO rfq_responses (response_hash, envelope_hash, response_json, response_ciphertext, received_at_ms) VALUES (?, ?, ?, ?, ?)")
        .run(responseHash, Buffer.from(envelopeHashHex, "hex"), stringifyProtocolJson(response), responseCiphertext, this.clock());
      this.db.prepare("INSERT OR IGNORE INTO rfq_acknowledgements (envelope_hash, acknowledged_at_ms) VALUES (?, ?)").run(Buffer.from(envelopeHashHex, "hex"), this.clock());
    });
  }

  // ---------------------------------------------------------------- sealed auctions

  createAuction(input: SealedAuctionDefinitionInput): { readonly auctionHashHex: string; readonly created: boolean } {
    const definition = sealedAuctionDefinition(input);
    const hash = sealedAuctionHash(definition);
    return this.transaction(() => {
      const result = this.db
        .prepare("INSERT OR IGNORE INTO sealed_auctions (auction_hash, definition_json, created_at_ms) VALUES (?, ?, ?)")
        .run(hash, stringifyProtocolJson(definition), this.clock());
      return { auctionHashHex: toHex(hash), created: result.changes === 1 };
    });
  }

  private load(auctionHashHex: string): { definition: SealedAuctionDefinition; events: SealedAuctionEvent[] } {
    const key = Buffer.from(auctionHashHex, "hex");
    const row = this.db.prepare("SELECT definition_json FROM sealed_auctions WHERE auction_hash = ?").get(key) as { definition_json: string } | undefined;
    if (row === undefined) throw new PrivateDeliveryStoreError("NOT_FOUND", "No such auction.");
    const definition = sealedAuctionDefinition(parseProtocolJson(row.definition_json) as SealedAuctionDefinitionInput);
    if (toHex(sealedAuctionHash(definition)) !== auctionHashHex) throw new PrivateDeliveryStoreError("CORRUPT_ROW", "Stored auction does not match its hash.");
    const events = (this.db.prepare("SELECT event_json FROM sealed_auction_events WHERE auction_hash = ? ORDER BY sequence").all(key) as { event_json: string }[])
      .map((event) => parseProtocolJson(event.event_json) as SealedAuctionEvent);
    return { definition, events };
  }

  private replay(definition: SealedAuctionDefinition, events: readonly SealedAuctionEvent[]): SealedAuctionState {
    let state = openSealedAuction(definition);
    for (const event of events) {
      const applied = applySealedAuctionEvent(state, event);
      if (!applied.accepted) throw new PrivateDeliveryStoreError("CORRUPT_ROW", "A stored auction event no longer applies.");
      state = applied.state;
    }
    return state;
  }

  /** Appends an event only when the kernel accepts it against the replayed state; rejected events are never stored. */
  appendAuctionEvent(auctionHashHex: string, event: SealedAuctionEvent): { readonly accepted: true } | { readonly accepted: false; readonly reason: SealedAuctionRejection | "TOO_MANY_EVENTS" } {
    return this.transaction(() => {
      const { definition, events } = this.load(auctionHashHex);
      if (events.length >= MAX_AUCTION_EVENTS) return { accepted: false as const, reason: "TOO_MANY_EVENTS" as const };
      const applied = applySealedAuctionEvent(this.replay(definition, events), event);
      if (!applied.accepted) return applied;
      this.db
        .prepare("INSERT INTO sealed_auction_events (auction_hash, sequence, event_json) VALUES (?, ?, ?)")
        .run(Buffer.from(auctionHashHex, "hex"), events.length, stringifyProtocolJson(event));
      return { accepted: true as const };
    });
  }

  auctionDefinition(auctionHashHex: string): SealedAuctionDefinition {
    return this.load(auctionHashHex).definition;
  }

  /**
   * The auction as the public may see it at a time: before close only the phase and commitment
   * count; after close the deterministic result and the full event log for independent replay.
   */
  auctionView(auctionHashHex: string, atValue: bigint):
    | { readonly phase: "COMMIT" | "REVEAL"; readonly commitmentCount: number; readonly definition: SealedAuctionDefinition }
    | { readonly phase: "CLOSED"; readonly definition: SealedAuctionDefinition; readonly result: SealedAuctionResult; readonly events: readonly SealedAuctionEvent[] } {
    const { definition, events } = this.load(auctionHashHex);
    const state = this.replay(definition, events);
    const closed = closeSealedAuction(state, atValue);
    if (closed.closed) return Object.freeze({ phase: "CLOSED" as const, definition, result: closed.result, events: Object.freeze(events) });
    const view = sealedAuctionPublicView(state, atValue);
    return Object.freeze({ phase: view.phase === "CLOSED" ? "REVEAL" : view.phase, commitmentCount: view.commitmentCount, definition });
  }
}
