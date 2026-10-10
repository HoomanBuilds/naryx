import type Database from "better-sqlite3";
import {
  metricObservationAttestation,
  metricObservationAttestationHash,
  parseProtocolJson,
  stringifyProtocolJson,
  toHex,
  type ConditionMetric,
  type MetricObservation,
  type MetricObservationAttestation,
  type MetricObservationAttestationInput,
} from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";
import { verifyEd25519 } from "./ed25519.js";
import type { StoredStrategyPackageOrder } from "./strategy-package-store.js";

const HASH = /^[0-9a-f]{64}$/;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metric_observations (
  observation_hash BLOB PRIMARY KEY,
  order_hash BLOB NOT NULL,
  source_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  sequence TEXT NOT NULL,
  observed_at_value TEXT NOT NULL,
  valid_until_value TEXT NOT NULL,
  attestation_json TEXT NOT NULL,
  signature BLOB NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE (order_hash, source_id, metric, sequence)
) STRICT;
CREATE INDEX IF NOT EXISTS metric_observations_by_order
  ON metric_observations(order_hash, metric, recorded_at_ms DESC);
CREATE TRIGGER IF NOT EXISTS reject_metric_observation_change BEFORE UPDATE ON metric_observations BEGIN SELECT RAISE(ABORT, 'metric observations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_metric_observation_delete BEFORE DELETE ON metric_observations BEGIN SELECT RAISE(ABORT, 'metric observations are immutable'); END;
`;

export class MetricObservationStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MetricObservationStoreError";
    this.code = code;
  }
}

export interface MetricObservationSource {
  readonly sourceId: string;
  readonly manifestHashHex: string;
  readonly verificationKey: Uint8Array;
}

type OrderSource = Pick<{ order(orderHashHex: string): StoredStrategyPackageOrder | undefined }, "order">;

function hashBytes(value: string): Buffer {
  if (!HASH.test(value)) throw new MetricObservationStoreError("INVALID_HASH", "Order hash must be 32 lowercase hex bytes.");
  return Buffer.from(value, "hex");
}

function supportedEnvironment(environment: string): boolean {
  return environment === "local" || environment === "devnet" || environment === "testnet";
}

export class SqliteMetricObservationStore {
  private readonly db: Database.Database;
  private readonly options: Readonly<{
    environment: string;
    orders: OrderSource;
    sourcesByMetric: ReadonlyMap<ConditionMetric, MetricObservationSource>;
    clock?: () => number;
  }>;
  private readonly clock: () => number;

  constructor(dbPath: string, options: SqliteMetricObservationStore["options"]) {
    if (!supportedEnvironment(options.environment)) {
      throw new MetricObservationStoreError("UNSUPPORTED_ENVIRONMENT", "Metric observations are limited to local, devnet, and testnet environments.");
    }
    for (const [metric, source] of options.sourcesByMetric) {
      if (metric === "TIME" || !HASH.test(source.manifestHashHex) || source.verificationKey.length !== 32) {
        throw new MetricObservationStoreError("INVALID_SOURCE", "Every non-time metric needs a pinned manifest hash and Ed25519 key.");
      }
    }
    this.options = options;
    this.clock = options.clock ?? Date.now;
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new MetricObservationStoreError(code, message));
  }

  close(): void {
    this.db.close();
  }

  publish(
    input: MetricObservationAttestationInput,
    signature: Uint8Array,
  ): { readonly replayed: boolean; readonly observationHashHex: string; readonly attestation: MetricObservationAttestation } {
    const attestation = metricObservationAttestation(input);
    const orderHashHex = toHex(attestation.orderHash);
    const hash = metricObservationAttestationHash(attestation);
    const hashHex = toHex(hash);
    const source = this.options.sourcesByMetric.get(attestation.metric);
    if (attestation.environment !== this.options.environment) {
      throw new MetricObservationStoreError("ENVIRONMENT_MISMATCH", "Observation environment differs from this runtime.");
    }
    if (source === undefined || source.sourceId !== attestation.sourceId
      || source.manifestHashHex !== toHex(attestation.sourceManifestHash)) {
      throw new MetricObservationStoreError("SOURCE_MISMATCH", "Observation source is not pinned for this metric.");
    }
    if (!(signature instanceof Uint8Array) || !verifyEd25519(source.verificationKey, hash, signature)) {
      throw new MetricObservationStoreError("INVALID_SIGNATURE", "The configured metric source did not sign this observation.");
    }
    const storedOrder = this.options.orders.order(orderHashHex);
    if (storedOrder === undefined) throw new MetricObservationStoreError("ORDER_NOT_FOUND", "No admitted strategy order has this hash.");
    if (storedOrder.order.environment !== attestation.environment
      || storedOrder.order.expiryUnit !== attestation.timeUnit
      || attestation.observedAtValue >= storedOrder.order.expiryValue
      || attestation.validUntilValue > storedOrder.order.expiryValue) {
      throw new MetricObservationStoreError("ORDER_MISMATCH", "Observation environment, clock, or validity does not match the order.");
    }
    const replay = this.db.prepare("SELECT attestation_json, signature FROM metric_observations WHERE observation_hash = ?")
      .get(hash) as { attestation_json: string; signature: Uint8Array } | undefined;
    const json = stringifyProtocolJson(attestation);
    if (replay !== undefined) {
      if (replay.attestation_json !== json || !Buffer.from(replay.signature).equals(Buffer.from(signature))) {
        throw new MetricObservationStoreError("OBSERVATION_CONFLICT", "Observation hash already has different evidence.");
      }
      return Object.freeze({ replayed: true, observationHashHex: hashHex, attestation });
    }
    this.db.transaction(() => {
      const latest = this.db.prepare(`
        SELECT sequence FROM metric_observations
        WHERE order_hash = ? AND source_id = ? AND metric = ?
        ORDER BY rowid DESC LIMIT 1
      `).get(hashBytes(orderHashHex), attestation.sourceId, attestation.metric) as { sequence: string } | undefined;
      if (latest !== undefined && attestation.sequence <= BigInt(latest.sequence)) {
        throw new MetricObservationStoreError("SEQUENCE_REPLAY", "Observation sequence must advance for this order and metric.");
      }
      this.db.prepare(`
        INSERT INTO metric_observations
          (observation_hash, order_hash, source_id, metric, sequence, observed_at_value,
           valid_until_value, attestation_json, signature, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        hash,
        hashBytes(orderHashHex),
        attestation.sourceId,
        attestation.metric,
        attestation.sequence.toString(),
        attestation.observedAtValue.toString(),
        attestation.validUntilValue.toString(),
        json,
        Buffer.from(signature),
        this.clock(),
      );
    }).immediate();
    return Object.freeze({ replayed: false, observationHashHex: hashHex, attestation });
  }

  observations(orderHashHex: string, atValue: bigint): readonly MetricObservation[] {
    if (typeof atValue !== "bigint" || atValue < 0n) {
      throw new MetricObservationStoreError("INVALID_TIME", "Observation time must be a nonnegative exact integer.");
    }
    const rows = this.db.prepare(`
      SELECT attestation_json FROM metric_observations
      WHERE order_hash = ? ORDER BY recorded_at_ms DESC, rowid DESC
    `).all(hashBytes(orderHashHex)) as Array<{ attestation_json: string }>;
    const selected = new Map<ConditionMetric, MetricObservation>();
    for (const row of rows) {
      const attestation = metricObservationAttestation(
        parseProtocolJson(row.attestation_json) as MetricObservationAttestationInput,
      );
      if (selected.has(attestation.metric) || attestation.observedAtValue > atValue || attestation.validUntilValue < atValue) continue;
      selected.set(attestation.metric, Object.freeze({
        metric: attestation.metric,
        value: attestation.value,
        observedAtValue: attestation.observedAtValue,
      }));
    }
    return Object.freeze([...selected.values()].sort((left, right) => left.metric.localeCompare(right.metric)));
  }
}
