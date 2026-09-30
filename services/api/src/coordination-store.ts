import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import bs58 from "bs58";
import {
  crossDomainPlan,
  crossDomainPlanHash,
  manualRecoveryApprovalHash,
  manualRecoveryIncident,
  manualRecoveryIncidentHash,
  parseProtocolJson,
  replayCrossDomainCoordination,
  replayManualRecovery,
  stringifyProtocolJson,
  toHex,
} from "@naryx/protocol-types";
import type {
  CrossDomainCoordination,
  CrossDomainEvent,
  CrossDomainPlanInput,
  ManualRecoveryEvent,
  ManualRecoveryIncidentInput,
  ManualRecoveryState,
} from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";
import { verifyEd25519 } from "./ed25519.js";
import { internalCaller, readInternalBody, sendError, sendJson } from "./internal-http.js";

export class CoordinationStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CoordinationStoreError";
    this.code = code;
  }
}

const MAX_EVENTS = 256;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cross_domain_plans (
  plan_hash BLOB PRIMARY KEY,
  order_hash BLOB NOT NULL,
  plan_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS cross_domain_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_hash BLOB NOT NULL REFERENCES cross_domain_plans(plan_hash),
  event_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS cross_domain_events_by_plan ON cross_domain_events(plan_hash, cursor);
CREATE TABLE IF NOT EXISTS recovery_incidents (
  incident_id TEXT PRIMARY KEY,
  incident_hash BLOB NOT NULL UNIQUE,
  incident_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS recovery_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL REFERENCES recovery_incidents(incident_id),
  event_json TEXT NOT NULL,
  approval_signature BLOB,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS recovery_events_by_incident ON recovery_events(incident_id, cursor);
CREATE TRIGGER IF NOT EXISTS reject_plan_change BEFORE UPDATE ON cross_domain_plans BEGIN SELECT RAISE(ABORT, 'coordination records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_plan_delete BEFORE DELETE ON cross_domain_plans BEGIN SELECT RAISE(ABORT, 'coordination records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_plan_event_change BEFORE UPDATE ON cross_domain_events BEGIN SELECT RAISE(ABORT, 'coordination records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_plan_event_delete BEFORE DELETE ON cross_domain_events BEGIN SELECT RAISE(ABORT, 'coordination records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_incident_change BEFORE UPDATE ON recovery_incidents BEGIN SELECT RAISE(ABORT, 'coordination records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_incident_delete BEFORE DELETE ON recovery_incidents BEGIN SELECT RAISE(ABORT, 'coordination records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_incident_event_change BEFORE UPDATE ON recovery_events BEGIN SELECT RAISE(ABORT, 'coordination records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_incident_event_delete BEFORE DELETE ON recovery_events BEGIN SELECT RAISE(ABORT, 'coordination records are append-only'); END;
`;

function hex(value: Uint8Array | string): string {
  return typeof value === "string" ? value.toLowerCase() : toHex(value);
}

/**
 * The durable record of cross-domain prepositioned coordinations and manual controlled recovery
 * incidents. The coordinator appends plans and per-domain evidence, and the incident owner opens
 * incidents and records executions and baseline evidence, only over loopback. Approvals arrive
 * publicly but count only when a named approver's Ed25519 key signed the approval hash. Every
 * read recomputes the state with the kernel replay, so the served phase, next actions, and
 * violations are never stored opinions.
 */
export class SqliteCoordinationStore {
  private readonly db: Database.Database;
  private readonly environment: string;
  private readonly clock: () => number;

  constructor(dbPath: string, options: { readonly environment: string; readonly clock?: () => number }) {
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new CoordinationStoreError(code, message));
    this.environment = options.environment;
    this.clock = options.clock ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  registerPlan(plan: CrossDomainPlanInput): { readonly planHash: string; readonly created: boolean } {
    let hash: Uint8Array;
    try {
      hash = crossDomainPlanHash(plan);
      crossDomainPlan(plan);
    } catch (error) {
      throw new CoordinationStoreError("INVALID_PLAN", (error as Error).message);
    }
    if (plan.environment !== this.environment) throw new CoordinationStoreError("WRONG_ENVIRONMENT", `This coordinator serves ${this.environment}.`);
    if (this.db.prepare("SELECT 1 FROM cross_domain_plans WHERE plan_hash = ?").get(hash) !== undefined) return { planHash: toHex(hash), created: false };
    this.db
      .prepare("INSERT INTO cross_domain_plans (plan_hash, order_hash, plan_json, recorded_at_ms) VALUES (?, ?, ?, ?)")
      .run(hash, Buffer.from(hex(plan.orderHash), "hex"), stringifyProtocolJson(plan), this.clock());
    return { planHash: toHex(hash), created: true };
  }

  /** Appends one domain's evidence. It must replay; conflicts and late evidence are kept and fence the package. */
  appendCrossDomainEvent(planHashHex: string, event: CrossDomainEvent): { readonly sequence: number } {
    return this.db.transaction(() => {
      const stored = this.planRow(planHashHex);
      const events = this.planEvents(planHashHex);
      if (events.length >= MAX_EVENTS) throw new CoordinationStoreError("EVENTS_FULL", `A coordination holds at most ${MAX_EVENTS} events.`);
      try {
        replayCrossDomainCoordination(stored, [...events, event], event.atValue);
      } catch (error) {
        throw new CoordinationStoreError("INVALID_EVENT", (error as Error).message);
      }
      this.db
        .prepare("INSERT INTO cross_domain_events (plan_hash, event_json, recorded_at_ms) VALUES (?, ?, ?)")
        .run(Buffer.from(planHashHex.toLowerCase(), "hex"), stringifyProtocolJson(event), this.clock());
      return { sequence: events.length + 1 };
    }).immediate();
  }

  /**
   * The plan, its evidence, and the kernel replay at the coordinator's clock in the plan's unit.
   * Without a clock in that unit (Solana slots) the replay runs at the latest evidence time, so no
   * deadline is judged past what the evidence shows, and `timeSource` says so.
   */
  coordination(planHashHex: string, nowIn: (unit: string) => bigint | undefined): {
    readonly plan: CrossDomainPlanInput;
    readonly events: readonly CrossDomainEvent[];
    readonly state: CrossDomainCoordination;
    readonly timeSource: "SERVER_CLOCK" | "LATEST_EVIDENCE";
  } | undefined {
    if (!/^[0-9a-f]{64}$/i.test(planHashHex)) return undefined;
    const row = this.db.prepare("SELECT plan_json FROM cross_domain_plans WHERE plan_hash = ?").get(Buffer.from(planHashHex.toLowerCase(), "hex")) as { plan_json: string } | undefined;
    if (row === undefined) return undefined;
    const plan = parseProtocolJson(row.plan_json) as CrossDomainPlanInput;
    const events = this.planEvents(planHashHex);
    const clock = nowIn(plan.timeUnit);
    const latest = events.reduce((max, event) => (event.atValue > max ? event.atValue : max), 0n);
    return Object.freeze({
      plan,
      events,
      state: replayCrossDomainCoordination(plan, events, clock ?? latest),
      timeSource: clock === undefined ? ("LATEST_EVIDENCE" as const) : ("SERVER_CLOCK" as const),
    });
  }

  openIncident(incident: ManualRecoveryIncidentInput): { readonly incidentHash: string; readonly created: boolean } {
    let hash: Uint8Array;
    try {
      manualRecoveryIncident(incident);
      hash = manualRecoveryIncidentHash(incident);
    } catch (error) {
      throw new CoordinationStoreError("INVALID_INCIDENT", (error as Error).message);
    }
    if (incident.environment !== this.environment) throw new CoordinationStoreError("WRONG_ENVIRONMENT", `This coordinator serves ${this.environment}.`);
    // Approvers sign with their own keys, so every approver id must be a base58 Ed25519 key.
    for (const approverId of incident.approverIds) {
      let key: Uint8Array;
      try {
        key = bs58.decode(approverId);
      } catch {
        throw new CoordinationStoreError("INVALID_INCIDENT", "Approver ids are base58 Ed25519 keys.");
      }
      if (key.length !== 32) throw new CoordinationStoreError("INVALID_INCIDENT", "Approver ids are base58 Ed25519 keys.");
    }
    return this.db.transaction(() => {
      const known = this.db.prepare("SELECT incident_hash FROM recovery_incidents WHERE incident_id = ?").get(incident.incidentId) as { incident_hash: Uint8Array } | undefined;
      if (known !== undefined) {
        if (toHex(known.incident_hash) !== toHex(hash)) throw new CoordinationStoreError("INCIDENT_EXISTS", "Another incident already has this id.");
        return { incidentHash: toHex(hash), created: false };
      }
      this.db
        .prepare("INSERT INTO recovery_incidents (incident_id, incident_hash, incident_json, recorded_at_ms) VALUES (?, ?, ?, ?)")
        .run(incident.incidentId, hash, stringifyProtocolJson(incident), this.clock());
      return { incidentHash: toHex(hash), created: true };
    }).immediate();
  }

  /** A named approver's approval, signed over the approval hash with the approver's own key. */
  approve(incidentId: string, approval: { readonly actionHash: Uint8Array | string; readonly approverId: string; readonly atValue: bigint }, signature: Uint8Array): { readonly sequence: number } {
    return this.db.transaction(() => {
      const incident = this.incidentRow(incidentId);
      // An approval dated ahead of the coordinator's clock would push every later event out.
      const now = this.nowIn(incident.timeUnit);
      if (typeof approval.atValue !== "bigint" || (now !== undefined && approval.atValue > now)) {
        throw new CoordinationStoreError("APPROVAL_IN_FUTURE", "An approval cannot be dated after the coordinator's clock.");
      }
      if (!incident.approverIds.includes(approval.approverId)) throw new CoordinationStoreError("NOT_AN_APPROVER", "The approver is not named by this incident.");
      let digest: Uint8Array;
      try {
        digest = manualRecoveryApprovalHash({ incidentHash: manualRecoveryIncidentHash(incident), ...approval });
      } catch (error) {
        throw new CoordinationStoreError("INVALID_EVENT", (error as Error).message);
      }
      if (!verifyEd25519(bs58.decode(approval.approverId), digest, signature)) throw new CoordinationStoreError("INVALID_SIGNATURE", "The approver did not sign this approval.");
      return this.appendRecovery(incidentId, incident, { kind: "ACTION_APPROVED", ...approval }, signature);
    }).immediate();
  }

  /** Executions, refused automation, and baseline evidence; approvals go through `approve`. */
  appendRecoveryEvent(incidentId: string, event: ManualRecoveryEvent): { readonly sequence: number } {
    if (event?.kind === "ACTION_APPROVED") throw new CoordinationStoreError("SIGNATURE_REQUIRED", "Approvals must be signed by their approver.");
    return this.db.transaction(() => this.appendRecovery(incidentId, this.incidentRow(incidentId), event, undefined)).immediate();
  }

  incident(incidentId: string):
    | {
      readonly incident: ManualRecoveryIncidentInput;
      readonly incidentHash: string;
      readonly events: readonly { readonly event: ManualRecoveryEvent; readonly signature?: Uint8Array }[];
      readonly state: ManualRecoveryState;
    }
    | undefined {
    const row = this.db.prepare("SELECT incident_json, incident_hash FROM recovery_incidents WHERE incident_id = ?").get(incidentId) as { incident_json: string; incident_hash: Uint8Array } | undefined;
    if (row === undefined) return undefined;
    const incident = parseProtocolJson(row.incident_json) as ManualRecoveryIncidentInput;
    const events = this.incidentEvents(incidentId);
    return Object.freeze({
      incident,
      incidentHash: toHex(row.incident_hash),
      events,
      state: replayManualRecovery(incident, events.map((entry) => entry.event)),
    });
  }

  private appendRecovery(incidentId: string, incident: ManualRecoveryIncidentInput, event: ManualRecoveryEvent, signature: Uint8Array | undefined): { readonly sequence: number } {
    const events = this.incidentEvents(incidentId).map((entry) => entry.event);
    if (events.length >= MAX_EVENTS) throw new CoordinationStoreError("EVENTS_FULL", `An incident holds at most ${MAX_EVENTS} events.`);
    let before: ManualRecoveryState;
    let after: ManualRecoveryState;
    try {
      before = replayManualRecovery(incident, events);
      after = replayManualRecovery(incident, [...events, event]);
    } catch (error) {
      throw new CoordinationStoreError("INVALID_EVENT", (error as Error).message);
    }
    if (before.phase === "RESTORED") throw new CoordinationStoreError("INCIDENT_RESTORED", "The incident is restored; nothing more runs.");
    // An event that would only add a violation (backward time, a repeated execution) is refused.
    if (after.violations.length > before.violations.length && event.kind !== "ACTION_EXECUTED") {
      throw new CoordinationStoreError("EVENT_REJECTED", after.violations[after.violations.length - 1] as string);
    }
    this.db
      .prepare("INSERT INTO recovery_events (incident_id, event_json, approval_signature, recorded_at_ms) VALUES (?, ?, ?, ?)")
      .run(incidentId, stringifyProtocolJson(event), signature ?? null, this.clock());
    return { sequence: events.length + 1 };
  }

  private nowIn(unit: string): bigint | undefined {
    if (unit === "EVM_UNIX_SECONDS") return BigInt(Math.floor(this.clock() / 1_000));
    if (unit === "HYPERLIQUID_UNIX_MILLISECONDS") return BigInt(Math.floor(this.clock()));
    return undefined;
  }

  private planRow(planHashHex: string): CrossDomainPlanInput {
    if (!/^[0-9a-f]{64}$/i.test(planHashHex)) throw new CoordinationStoreError("PLAN_NOT_FOUND", "No such coordination.");
    const row = this.db.prepare("SELECT plan_json FROM cross_domain_plans WHERE plan_hash = ?").get(Buffer.from(planHashHex.toLowerCase(), "hex")) as { plan_json: string } | undefined;
    if (row === undefined) throw new CoordinationStoreError("PLAN_NOT_FOUND", "No such coordination.");
    return parseProtocolJson(row.plan_json) as CrossDomainPlanInput;
  }

  private planEvents(planHashHex: string): CrossDomainEvent[] {
    return (this.db.prepare("SELECT event_json FROM cross_domain_events WHERE plan_hash = ? ORDER BY cursor").all(Buffer.from(planHashHex.toLowerCase(), "hex")) as { event_json: string }[])
      .map((row) => parseProtocolJson(row.event_json) as CrossDomainEvent);
  }

  private incidentRow(incidentId: string): ManualRecoveryIncidentInput {
    const row = this.db.prepare("SELECT incident_json FROM recovery_incidents WHERE incident_id = ?").get(incidentId) as { incident_json: string } | undefined;
    if (row === undefined) throw new CoordinationStoreError("INCIDENT_NOT_FOUND", "No such incident.");
    return parseProtocolJson(row.incident_json) as ManualRecoveryIncidentInput;
  }

  private incidentEvents(incidentId: string): { readonly event: ManualRecoveryEvent; readonly signature?: Uint8Array }[] {
    return (this.db.prepare("SELECT event_json, approval_signature FROM recovery_events WHERE incident_id = ? ORDER BY cursor").all(incidentId) as { event_json: string; approval_signature: Uint8Array | null }[])
      .map((row) => Object.freeze({ event: parseProtocolJson(row.event_json) as ManualRecoveryEvent, ...(row.approval_signature === null ? {} : { signature: new Uint8Array(row.approval_signature) }) }));
  }
}

/**
 * Loopback coordinator routes: `POST /internal/coordination/plans` ({plan}),
 * `POST /internal/coordination/events` ({planHash, event}), `POST /internal/recovery/incidents`
 * ({incident}), and `POST /internal/recovery/events` ({incidentId, event}). Mount only on the
 * private server.
 */
export function createCoordinationInternalHandler(store: SqliteCoordinationStore): (request: IncomingMessage, response: ServerResponse) => boolean {
  const routes = new Set(["/internal/coordination/plans", "/internal/coordination/events", "/internal/recovery/incidents", "/internal/recovery/events"]);
  return (request, response) => {
    const path = new URL(request.url ?? "/", "http://internal.local").pathname;
    if (!path.startsWith("/internal/coordination/") && !path.startsWith("/internal/recovery/")) return false;
    if (!internalCaller(request)) return sendError(response, 403, "FORBIDDEN", "Coordination routes answer loopback callers only.");
    if (request.method !== "POST" || !routes.has(path)) return sendError(response, 404, "NOT_FOUND", "Unknown coordination route.");
    readInternalBody(request, response, (body) => {
      try {
        if (path === "/internal/coordination/plans") return sendJson(response, 200, store.registerPlan(body.plan as CrossDomainPlanInput));
        if (path === "/internal/coordination/events") return sendJson(response, 200, store.appendCrossDomainEvent(String(body.planHash), body.event as CrossDomainEvent));
        if (path === "/internal/recovery/incidents") return sendJson(response, 200, store.openIncident(body.incident as ManualRecoveryIncidentInput));
        return sendJson(response, 200, store.appendRecoveryEvent(String(body.incidentId), body.event as ManualRecoveryEvent));
      } catch (error) {
        if (error instanceof CoordinationStoreError) return sendError(response, error.code.endsWith("NOT_FOUND") ? 404 : error.code.startsWith("INVALID") || error.code === "WRONG_ENVIRONMENT" ? 400 : 409, error.code, error.message);
        return sendError(response, 400, "INVALID_REQUEST", (error as Error).message);
      }
    });
    return true;
  };
}
