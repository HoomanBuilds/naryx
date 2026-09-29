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
/** Unacknowledged, unexpired envelopes one recipient may hold before new ones are refused. */
export const MAX_PENDING_ENVELOPES_PER_RECIPIENT = 1_000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rfq_envelopes (
  envelope_hash BLOB PRIMARY KEY,
  recipient_solver_id TEXT NOT NULL,
  sender_key_id TEXT NOT NULL,
  envelope_nonce TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  expires_at_value TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL DEFAULT 0,
  sender_signature BLOB,
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
  /** The sender key's Ed25519 signature over the envelope hash; absent only on rows stored before sender authentication. */
  readonly senderSignature?: Uint8Array;
  readonly response?: { readonly responseHashHex: string; readonly response: unknown; readonly responseCiphertext: Uint8Array };
}

interface EnvelopeRow {
  readonly envelope_hash: Uint8Array;
  readonly envelope_json: string;
  readonly ciphertext: Uint8Array;
  readonly sender_signature: Uint8Array | null;
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
    // Stores created before expiry was kept in milliseconds gain the column; their rows read as expired.
    const columns = this.db.prepare("PRAGMA table_info(rfq_envelopes)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "expires_at_ms")) {
      this.db.exec("ALTER TABLE rfq_envelopes ADD COLUMN expires_at_ms INTEGER NOT NULL DEFAULT 0");
    }
    // Stores created before sender authentication gain the column; their rows carry no signature.
    if (!columns.some((column) => column.name === "sender_signature")) {
      this.db.exec("ALTER TABLE rfq_envelopes ADD COLUMN sender_signature BLOB");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS rfq_envelopes_pending ON rfq_envelopes(recipient_solver_id, expires_at_ms, received_at_ms)");
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

  /**
   * Stores envelopes the caller already admitted, all in one transaction: either every entry is
   * recorded or none is. A repeat of the same envelope is idempotent. `expiresAtMs` is the
   * envelope's expiry on the server wall clock, used to hide expired envelopes from the inbox.
   * `senderSignature` is the sender key's signature over the envelope hash, which the caller has
   * already verified; it is kept so the recipient can verify the sender itself.
   */
  storeEnvelopes(
    items: readonly {
      readonly envelope: PrivateRfqEnvelopeInput;
      readonly ciphertext: Uint8Array;
      readonly expiresAtMs: number;
      readonly senderSignature: Uint8Array;
    }[],
  ): readonly { readonly envelopeHashHex: string; readonly created: boolean }[] {
    const prepared = items.map((item) => {
      const envelope = privateRfqEnvelope(item.envelope);
      if (!Number.isSafeInteger(item.expiresAtMs) || item.expiresAtMs <= 0) {
        throw new PrivateDeliveryStoreError("INVALID_EXPIRY", "Envelope expiry must be a positive millisecond time.");
      }
      if (!(item.senderSignature instanceof Uint8Array) || item.senderSignature.length !== 64) {
        throw new PrivateDeliveryStoreError("INVALID_SIGNATURE", "The sender signature must be 64 bytes.");
      }
      return { envelope, hash: privateRfqEnvelopeHash(envelope), ciphertext: item.ciphertext, expiresAtMs: item.expiresAtMs, senderSignature: item.senderSignature };
    });
    return this.transaction(() => {
      const now = this.clock();
      return prepared.map(({ envelope, hash, ciphertext, expiresAtMs, senderSignature }) => {
        const existing = this.db.prepare("SELECT 1 FROM rfq_envelopes WHERE envelope_hash = ?").get(hash);
        if (existing !== undefined) return { envelopeHashHex: toHex(hash), created: false };
        const pending = this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM rfq_envelopes e LEFT JOIN rfq_acknowledgements a ON a.envelope_hash = e.envelope_hash
             WHERE e.recipient_solver_id = ? AND a.envelope_hash IS NULL AND e.expires_at_ms > ?`,
          )
          .get(envelope.recipientSolverId, now) as { count: number };
        if (pending.count >= MAX_PENDING_ENVELOPES_PER_RECIPIENT) {
          throw new PrivateDeliveryStoreError("INBOX_FULL", "The recipient has too many undelivered envelopes; retry later.");
        }
        try {
          this.db
            .prepare(
              "INSERT INTO rfq_envelopes (envelope_hash, recipient_solver_id, sender_key_id, envelope_nonce, envelope_json, ciphertext, expires_at_value, expires_at_ms, sender_signature, received_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              hash,
              envelope.recipientSolverId,
              envelope.senderKeyId,
              envelope.envelopeNonce.toString(),
              stringifyProtocolJson(envelope),
              ciphertext,
              envelope.expiresAtValue.toString(),
              expiresAtMs,
              senderSignature,
              now,
            );
        } catch (error) {
          // Only the sender, nonce, and recipient uniqueness constraint means a replay.
          if ((error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") {
            throw new PrivateDeliveryStoreError("REPLAY", "The sender already used this nonce for this recipient.");
          }
          throw error;
        }
        return { envelopeHashHex: toHex(hash), created: true };
      });
    });
  }

  /** Single-envelope form of storeEnvelopes. */
  storeEnvelope(
    envelopeInput: PrivateRfqEnvelopeInput,
    ciphertext: Uint8Array,
    expiresAtMs: number,
    senderSignature: Uint8Array,
  ): { readonly envelopeHashHex: string; readonly created: boolean } {
    return this.storeEnvelopes([{ envelope: envelopeInput, ciphertext, expiresAtMs, senderSignature }])[0] as { envelopeHashHex: string; created: boolean };
  }

  private decodeEnvelope(row: EnvelopeRow): StoredEnvelope {
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
      ...(row.sender_signature === null ? {} : { senderSignature: Uint8Array.from(row.sender_signature) }),
      ...(response === undefined
        ? {}
        : { response: { responseHashHex: toHex(response.response_hash), response: parseProtocolJson(response.response_json), responseCiphertext: Uint8Array.from(response.response_ciphertext) } }),
    });
  }

  getEnvelope(envelopeHashHex: string): StoredEnvelope | undefined {
    const row = this.db
      .prepare("SELECT envelope_hash, envelope_json, ciphertext, sender_signature FROM rfq_envelopes WHERE envelope_hash = ?")
      .get(Buffer.from(envelopeHashHex, "hex")) as EnvelopeRow | undefined;
    return row === undefined ? undefined : this.decodeEnvelope(row);
  }

  /**
   * Unacknowledged, unexpired envelopes addressed to one solver, oldest first. Expiry is filtered
   * in SQL, so any number of expired envelopes can never hide a live one.
   */
  pendingFor(solverId: string, nowMs: number, limit = 50): readonly StoredEnvelope[] {
    const rows = this.db
      .prepare(
        `SELECT e.envelope_hash, e.envelope_json, e.ciphertext, e.sender_signature FROM rfq_envelopes e
         LEFT JOIN rfq_acknowledgements a ON a.envelope_hash = e.envelope_hash
         WHERE e.recipient_solver_id = ? AND a.envelope_hash IS NULL AND e.expires_at_ms > ?
         ORDER BY e.received_at_ms LIMIT ?`,
      )
      .all(solverId, nowMs, Math.max(1, Math.min(limit, 200))) as EnvelopeRow[];
    return Object.freeze(rows.map((row) => this.decodeEnvelope(row)));
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
