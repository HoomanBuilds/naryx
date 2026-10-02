import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { formatDecimalAtoms } from "./decimal.js";
import { openDurableDatabase } from "./durable-sqlite.js";
import type { TerminalMarketSource, TerminalMarketSources } from "./private-terminal-manifest.js";
import { createReadCache } from "./read-cache.js";
import { formatExact, midpoint, observedDecimal, type ObservedDecimal } from "./terminal-preview.js";
import { basisHundredthsBps } from "./terminal-snapshot.js";
import { DOMAIN_IDS, isDomainId, type DomainId } from "./terminal-types.js";

export const REFERENCE_CANDLES_PATH = "/internal/terminal/reference-candles";
export const REFERENCE_SAMPLE_INTERVAL_MS = 15_000;
export const REFERENCE_RETENTION_MS = 30 * 86_400_000;
const PRUNE_INTERVAL_MS = 3_600_000;
const DEFAULT_CANDLE_LIMIT = 300;
const MAX_CANDLE_LIMIT = 1_000;
const RESPONSE_CACHE_MS = 5_000;
const SOURCE_LABEL = /^[\x20-\x7e]{1,200}$/;
const QUERY_KEYS: readonly string[] = ["domain", "series", "interval", "limit"];

export const REFERENCE_INTERVALS = Object.freeze({
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
  "1d": 86_400,
});
export type ReferenceInterval = keyof typeof REFERENCE_INTERVALS;
export const REFERENCE_SERIES = ["spot", "perp", "basis"] as const;
export type ReferenceSeries = (typeof REFERENCE_SERIES)[number];

export const REFERENCE_METHODOLOGY =
  "Sampled every 15 s from the lane's live terminal market source. A sample is kept only while that source is " +
  "fresh under the lane's staleness bound; while it is stale or unavailable nothing is recorded, so a gap stays " +
  "a gap and no value is carried forward. Spot and perp references are the midpoints of the observed bid and ask " +
  "(an oracle-priced leg's midpoint is its oracle price). Basis is (perp - spot) / spot in bps, truncated toward " +
  "zero to 0.01 bps. Each candle is the first, highest, lowest, and last sample in its UTC bucket; a bucket " +
  "without samples has no candle. Kept 30 days. Unsigned and unattested.";

export class ReferenceHistoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReferenceHistoryError";
    this.code = code;
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reference_sources (
  source_id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE
) STRICT;
CREATE TABLE IF NOT EXISTS reference_samples (
  domain TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  spot TEXT NOT NULL,
  perp TEXT NOT NULL,
  basis_hundredths_bps INTEGER NOT NULL,
  spot_source INTEGER NOT NULL REFERENCES reference_sources(source_id),
  perp_source INTEGER NOT NULL REFERENCES reference_sources(source_id),
  PRIMARY KEY (domain, observed_at_ms)
) STRICT, WITHOUT ROWID;
`;

/** One fresh observation of a lane: exact decimal mids, the basis, and where each leg came from. */
export type ReferenceSample = Readonly<{
  domain: DomainId;
  observedAtMs: number;
  spot: string;
  perp: string;
  basisHundredthsBps: number;
  spotSource: string;
  perpSource: string;
}>;

/** A lane the recorder samples: its live terminal market source and the exact origin of each leg. */
export type ReferenceLane = Readonly<{
  domain: DomainId;
  source: TerminalMarketSource;
  spotSource: string;
  perpSource: string;
}>;

export type ReferenceCandleQuery = Readonly<{
  domain: DomainId;
  series: ReferenceSeries;
  interval: ReferenceInterval;
  limit: number;
}>;

export type ReferenceCandle = Readonly<{
  /** Bucket open time in UTC seconds. */
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  samples: number;
}>;

export type ReferenceCandles = Readonly<{
  /** First and last bucket open times of the window, in UTC seconds. */
  from: number;
  to: number;
  sources: readonly Readonly<{ leg: "spot" | "perp"; label: string }>[];
  latestObservedAtMs: number | null;
  candles: readonly ReferenceCandle[];
}>;

// A locked book (bid equal to ask) is a single quoted mid or oracle price and is accepted; a zero,
// malformed, or crossed book is not.
function referenceMid(bidText: string, askText: string): ObservedDecimal | undefined {
  const bid = observedDecimal(bidText);
  const ask = observedDecimal(askText);
  if (bid === undefined || ask === undefined || bid.digits === 0n) return undefined;
  const scale = Math.max(bid.scale, ask.scale);
  if (bid.digits * 10n ** BigInt(scale - bid.scale) > ask.digits * 10n ** BigInt(scale - ask.scale)) return undefined;
  return midpoint(bid, ask);
}

/**
 * The lane's latest observation as a sample, timed at its capture, or nothing when the source has
 * no observation, the observation is older than the source's maxStalenessMs or future-dated, or
 * either book is malformed or crossed.
 */
export function referenceSample(lane: ReferenceLane, nowMs: number): ReferenceSample | undefined {
  let observation;
  try {
    observation = lane.source.latest();
  } catch {
    return undefined;
  }
  if (observation === undefined || !Number.isSafeInteger(nowMs)) return undefined;
  const { capturedAtMs } = observation;
  if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs <= 0 || capturedAtMs > nowMs
    || nowMs - capturedAtMs > lane.source.descriptor.maxStalenessMs) {
    return undefined;
  }
  const spot = referenceMid(observation.spotBid, observation.spotAsk);
  const perp = referenceMid(observation.perpBid, observation.perpAsk);
  if (spot === undefined || perp === undefined) return undefined;
  const basis = basisHundredthsBps(spot, perp);
  const bound = BigInt(Number.MAX_SAFE_INTEGER);
  if (basis > bound || basis < -bound) return undefined;
  return Object.freeze({
    domain: lane.domain,
    observedAtMs: capturedAtMs,
    spot: formatExact(spot, 0),
    perp: formatExact(perp, 0),
    basisHundredthsBps: Number(basis),
    spotSource: lane.spotSource,
    perpSource: lane.perpSource,
  });
}

function basisText(hundredths: number): string {
  const magnitude = BigInt(Math.abs(hundredths));
  return `${hundredths < 0 ? "-" : ""}${formatDecimalAtoms(magnitude, 2)}`;
}

type Bucket = { time: number; open: string; high: string; highKey: number; low: string; lowKey: number; close: string; samples: number };
type SampleRow = [observedAtMs: number, value: string | number, spotSource: number, perpSource: number];

/**
 * Durable per-domain reference samples. A sample is keyed by its domain and observation time, so a
 * repeated observation is recorded once; rows older than the retention bound are pruned.
 */
export class SqliteReferenceHistoryStore {
  readonly #db: Database.Database;
  readonly #sourceIds = new Map<string, number>();
  readonly #sourceLabels = new Map<number, string>();

  constructor(dbPath: string) {
    this.#db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new ReferenceHistoryError(code, message));
  }

  close(): void {
    this.#db.close();
  }

  /** Appends a sample; false when the domain already has a sample at that observation time. */
  record(sample: ReferenceSample): boolean {
    const spot = observedDecimal(sample.spot);
    const perp = observedDecimal(sample.perp);
    if (!isDomainId(sample.domain) || !Number.isSafeInteger(sample.observedAtMs) || sample.observedAtMs <= 0
      || spot === undefined || spot.digits === 0n || perp === undefined || perp.digits === 0n
      || !Number.isSafeInteger(sample.basisHundredthsBps)
      || !SOURCE_LABEL.test(sample.spotSource) || !SOURCE_LABEL.test(sample.perpSource)) {
      throw new ReferenceHistoryError("INVALID_SAMPLE", "The reference sample is invalid.");
    }
    // Source rows commit on their own, so a cached source id always names a stored row.
    const spotSource = this.#sourceId(sample.spotSource);
    const perpSource = this.#sourceId(sample.perpSource);
    return this.#db.prepare(
      "INSERT OR IGNORE INTO reference_samples (domain, observed_at_ms, spot, perp, basis_hundredths_bps, spot_source, perp_source) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(sample.domain, sample.observedAtMs, sample.spot, sample.perp, sample.basisHundredthsBps, spotSource, perpSource)
      .changes === 1;
  }

  /** Deletes every sample observed before `beforeMs`; returns how many were deleted. */
  prune(beforeMs: number): number {
    if (!Number.isSafeInteger(beforeMs)) throw new ReferenceHistoryError("INVALID_BOUND", "The retention bound is invalid.");
    const statement = this.#db.prepare("DELETE FROM reference_samples WHERE domain = ? AND observed_at_ms < ?");
    return this.#db.transaction(() => DOMAIN_IDS.reduce((total, domain) => total + statement.run(domain, beforeMs).changes, 0))();
  }

  /** OHLC candles over the `limit` buckets ending with the one that contains `nowMs`. */
  candles(query: ReferenceCandleQuery, nowMs: number): ReferenceCandles {
    const seconds = REFERENCE_INTERVALS[query.interval];
    const to = Math.floor(nowMs / 1_000 / seconds) * seconds;
    const from = to - (query.limit - 1) * seconds;
    const column = query.series === "basis" ? "basis_hundredths_bps" : query.series;
    const rows = this.#db.prepare(
      `SELECT observed_at_ms, ${column}, spot_source, perp_source FROM reference_samples WHERE domain = ? AND observed_at_ms >= ? AND observed_at_ms < ? ORDER BY observed_at_ms`,
    ).raw(true).iterate(query.domain, from * 1_000, (to + seconds) * 1_000) as IterableIterator<SampleRow>;
    const buckets: Bucket[] = [];
    const spotSources = new Set<number>();
    const perpSources = new Set<number>();
    for (const [observedAtMs, value, spotSource, perpSource] of rows) {
      // High and low are ordered by the parsed value, but every candle field is a sample's exact text.
      const text = typeof value === "number" ? basisText(value) : value;
      const key = Number(value);
      const time = Math.floor(observedAtMs / 1_000 / seconds) * seconds;
      const bucket = buckets.at(-1);
      if (bucket === undefined || bucket.time !== time) {
        buckets.push({ time, open: text, high: text, highKey: key, low: text, lowKey: key, close: text, samples: 1 });
      } else {
        if (key > bucket.highKey) {
          bucket.high = text;
          bucket.highKey = key;
        }
        if (key < bucket.lowKey) {
          bucket.low = text;
          bucket.lowKey = key;
        }
        bucket.close = text;
        bucket.samples += 1;
      }
      if (query.series !== "perp") spotSources.add(spotSource);
      if (query.series !== "spot") perpSources.add(perpSource);
    }
    const latest = this.#db.prepare("SELECT MAX(observed_at_ms) FROM reference_samples WHERE domain = ?")
      .pluck(true).get(query.domain) as number | null;
    return Object.freeze({
      from,
      to,
      sources: [
        ...[...spotSources].map((id) => ({ leg: "spot" as const, label: this.#sourceLabel(id) })),
        ...[...perpSources].map((id) => ({ leg: "perp" as const, label: this.#sourceLabel(id) })),
      ],
      latestObservedAtMs: latest,
      candles: buckets.map(({ time, open, high, low, close, samples }) => Object.freeze({ time, open, high, low, close, samples })),
    });
  }

  #sourceId(label: string): number {
    const cached = this.#sourceIds.get(label);
    if (cached !== undefined) return cached;
    this.#db.prepare("INSERT OR IGNORE INTO reference_sources (label) VALUES (?)").run(label);
    const id = this.#db.prepare("SELECT source_id FROM reference_sources WHERE label = ?").pluck(true).get(label) as number;
    this.#sourceIds.set(label, id);
    return id;
  }

  #sourceLabel(id: number): string {
    const cached = this.#sourceLabels.get(id);
    if (cached !== undefined) return cached;
    const label = this.#db.prepare("SELECT label FROM reference_sources WHERE source_id = ?").pluck(true).get(id) as string;
    this.#sourceLabels.set(id, label);
    return label;
  }
}

/**
 * Samples every lane's live terminal market source on a fixed interval and records the fresh ones.
 * Retention is enforced on the first sample and then hourly. A store failure is reported once and
 * retried on the next tick.
 */
export class ReferenceHistoryRecorder {
  readonly #store: Pick<SqliteReferenceHistoryStore, "record" | "prune">;
  readonly #lanes: readonly ReferenceLane[];
  readonly #intervalMs: number;
  readonly #retentionMs: number;
  readonly #nowMs: () => number;
  readonly #report: (message: string) => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #prunedAtMs: number | undefined;
  #failing = false;

  constructor(
    store: Pick<SqliteReferenceHistoryStore, "record" | "prune">,
    lanes: readonly ReferenceLane[],
    options: Readonly<{ intervalMs?: number; retentionMs?: number; nowMs?: () => number; report?: (message: string) => void }> = {},
  ) {
    this.#store = store;
    this.#lanes = lanes;
    this.#intervalMs = options.intervalMs ?? REFERENCE_SAMPLE_INTERVAL_MS;
    this.#retentionMs = options.retentionMs ?? REFERENCE_RETENTION_MS;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#report = options.report
      ?? ((message) => { process.stderr.write(`Naryx API reference history: ${message}\n`); });
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 1_000
      || !Number.isSafeInteger(this.#retentionMs) || this.#retentionMs < this.#intervalMs) {
      throw new ReferenceHistoryError("INVALID_CONFIGURATION", "Reference history interval or retention is invalid.");
    }
  }

  /** Records one sample per fresh lane and returns how many were recorded. */
  sampleOnce(): number {
    const now = this.#nowMs();
    let recorded = 0;
    try {
      if (this.#prunedAtMs === undefined || now - this.#prunedAtMs >= PRUNE_INTERVAL_MS) {
        this.#store.prune(now - this.#retentionMs);
        this.#prunedAtMs = now;
      }
      for (const lane of this.#lanes) {
        const sample = referenceSample(lane, now);
        if (sample !== undefined && this.#store.record(sample)) recorded += 1;
      }
      if (this.#failing) this.#report("recording recovered");
      this.#failing = false;
    } catch (error) {
      if (!this.#failing) this.#report(`recording failed: ${error instanceof Error ? error.message : "unknown error"}`);
      this.#failing = true;
    }
    return recorded;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.sampleOnce();
    this.#timer = setInterval(() => { this.sampleOnce(); }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

function invalidQuery(message: string): never {
  throw new ReferenceHistoryError("INVALID_QUERY", message);
}

/** domain, series, and interval exactly once each, and optionally limit (1 to 1000, default 300). */
export function parseReferenceCandleQuery(search: URLSearchParams): ReferenceCandleQuery {
  const keys = [...search.keys()];
  if (new Set(keys).size !== keys.length || keys.some((key) => !QUERY_KEYS.includes(key))) {
    invalidQuery("Query must contain domain, series, interval, and optionally limit, each at most once.");
  }
  const domain = search.get("domain");
  if (!isDomainId(domain)) invalidQuery(`domain must be one of ${DOMAIN_IDS.join(", ")}.`);
  const series = search.get("series");
  if (!REFERENCE_SERIES.includes(series as ReferenceSeries)) invalidQuery("series must be spot, perp, or basis.");
  const interval = search.get("interval");
  if (interval === null || !Object.hasOwn(REFERENCE_INTERVALS, interval)) {
    invalidQuery(`interval must be one of ${Object.keys(REFERENCE_INTERVALS).join(", ")}.`);
  }
  const limitText = search.get("limit");
  if (limitText !== null && (!/^[1-9][0-9]{0,3}$/.test(limitText) || Number(limitText) > MAX_CANDLE_LIMIT)) {
    invalidQuery(`limit must be an integer from 1 to ${MAX_CANDLE_LIMIT}.`);
  }
  return Object.freeze({
    domain,
    series: series as ReferenceSeries,
    interval: interval as ReferenceInterval,
    limit: limitText === null ? DEFAULT_CANDLE_LIMIT : Number(limitText),
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

/**
 * GET /internal/terminal/reference-candles: reference candles for one lane and series. Mounted
 * ahead of the private handler, so the server's terminal origin policy and preflight apply.
 */
export function createReferenceCandleRoutes(options: Readonly<{
  store: Pick<SqliteReferenceHistoryStore, "candles">;
  markets?: TerminalMarketSources;
  nowMs?: () => number;
}>): (request: IncomingMessage, response: ServerResponse) => boolean {
  const nowMs = options.nowMs ?? Date.now;
  const cache = createReadCache<unknown>({ ttlMs: RESPONSE_CACHE_MS, maxKeys: 512 });
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://private-terminal.local");
    if (url.pathname !== REFERENCE_CANDLES_PATH) return false;
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET, OPTIONS");
      send(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is allowed." } });
      return true;
    }
    let query: ReferenceCandleQuery;
    try {
      query = parseReferenceCandleQuery(url.searchParams);
    } catch (error) {
      const message = error instanceof ReferenceHistoryError ? error.message : "Query is invalid.";
      send(response, 400, { error: { code: "INVALID_QUERY", message } });
      return true;
    }
    const descriptor = options.markets?.[query.domain]?.descriptor;
    void cache(`${query.domain}|${query.series}|${query.interval}|${query.limit}`, async () => ({
      version: 1,
      domain: query.domain,
      series: query.series,
      interval: query.interval,
      intervalSeconds: REFERENCE_INTERVALS[query.interval],
      market: descriptor === undefined ? null : { base: descriptor.baseSymbol, quote: descriptor.quoteSymbol },
      sampleIntervalSeconds: REFERENCE_SAMPLE_INTERVAL_MS / 1_000,
      methodology: REFERENCE_METHODOLOGY,
      ...options.store.candles(query, nowMs()),
    })).then(
      (body) => send(response, 200, body),
      () => send(response, 500, { error: { code: "REFERENCE_READ_FAILED", message: "Reference history reading failed." } }),
    );
    return true;
  };
}
