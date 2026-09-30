import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bs58 from "bs58";
import {
  domainRef,
  fromProtocolJson,
  manualRecoveryApprovalHash,
  manualRecoveryIncidentHash,
  toProtocolJson,
  type CrossDomainPlanInput,
  type ManualRecoveryIncidentInput,
} from "@naryx/protocol-types";
import { createCoordinationInternalHandler, createPublicApiHandler, SqliteCoordinationStore, SqlitePackageExchangeStore } from "../src/index.js";
import { CLASS_SUPPORT, NOW, SERIES_SUPPORT } from "./exchange-fixtures.js";

const NOW_MS = 1_000_000;

function approver(): { id: string; key: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { id: bs58.encode((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32)), key: privateKey };
}

const plan: CrossDomainPlanInput = {
  planVersion: 1,
  environment: "testnet",
  orderHash: "11".repeat(32),
  timeUnit: "EVM_UNIX_SECONDS",
  prepareDeadline: 1_100n,
  commitDeadline: 1_200n,
  maximumInterimExposureQuoteAtoms: 1_000n,
  legs: [
    { domain: domainRef("svm:testnet", 1, "21".repeat(32)), legIds: ["spot"], inventoryReservationId: "31".repeat(32), interimExposureQuoteAtoms: 400n, compensationActionHash: "41".repeat(32) },
    { domain: domainRef("eip155:84532", 1, "22".repeat(32)), legIds: ["perp"], inventoryReservationId: "32".repeat(32), interimExposureQuoteAtoms: 500n, compensationActionHash: "42".repeat(32) },
  ],
};

test("coordinations and recovery incidents replay through the kernel, and only signed approvals from named approvers count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-coordination-"));
  const store = new SqliteCoordinationStore(join(dir, "coordination.sqlite"), { environment: "testnet", clock: () => NOW_MS });
  const exchange = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
  const a = approver();
  const b = approver();
  const outsider = approver();
  try {
    const { planHash } = store.registerPlan(plan);
    assert.equal(store.registerPlan(plan).created, false);
    assert.throws(() => store.registerPlan({ ...plan, environment: "devnet" }), { code: "WRONG_ENVIRONMENT" });
    store.appendCrossDomainEvent(planHash, { kind: "PREPARED", domainId: "svm:testnet", evidenceHash: "51".repeat(32), finality: "FINALIZED", atValue: 990n });
    store.appendCrossDomainEvent(planHash, { kind: "PREPARED", domainId: "eip155:84532", evidenceHash: "52".repeat(32), finality: "FINALIZED", atValue: 995n });
    const nowIn = (unit: string) => (unit === "EVM_UNIX_SECONDS" ? 1_000n : undefined);
    assert.equal(store.coordination(planHash, nowIn)?.state.phase, "COMMITTING");
    assert.equal(store.coordination(planHash, () => undefined)?.timeSource, "LATEST_EVIDENCE");
    assert.throws(() => store.appendCrossDomainEvent("ab".repeat(32), { kind: "PREPARED", domainId: "svm:testnet", evidenceHash: "51".repeat(32), finality: "FINALIZED", atValue: 1n }), { code: "PLAN_NOT_FOUND" });

    const incident: ManualRecoveryIncidentInput = {
      incidentVersion: 1, environment: "testnet", incidentId: "incident-1", orderHash: "11".repeat(32), timeUnit: "EVM_UNIX_SECONDS",
      fencedAtValue: 900n, approverIds: [a.id, b.id], approvalQuorum: 2, baselineTargetHash: "77".repeat(32),
    };
    assert.throws(() => store.openIncident({ ...incident, approverIds: ["ops-a", "ops-b"] }), { code: "INVALID_INCIDENT" });
    store.openIncident(incident);
    assert.throws(() => store.openIncident({ ...incident, approvalQuorum: 1 }), { code: "INVALID_INCIDENT" });
    const incidentHash = manualRecoveryIncidentHash(incident);
    const approval = (who: { id: string }, atValue: bigint) => ({ actionHash: "62".repeat(32), approverId: who.id, atValue });
    const signed = (signer: { key: KeyObject }, value: ReturnType<typeof approval>) => new Uint8Array(sign(null, manualRecoveryApprovalHash({ incidentHash, ...value }), signer.key));
    assert.throws(() => store.appendRecoveryEvent("incident-1", { kind: "ACTION_APPROVED", ...approval(a, 950n) }), { code: "SIGNATURE_REQUIRED" });
    assert.throws(() => store.approve("incident-1", approval(outsider, 950n), signed(outsider, approval(outsider, 950n))), { code: "NOT_AN_APPROVER" });
    assert.throws(() => store.approve("incident-1", approval(a, 950n), signed(b, approval(a, 950n))), { code: "INVALID_SIGNATURE" });
    assert.throws(() => store.approve("incident-1", approval(a, 1_001n), signed(a, approval(a, 1_001n))), { code: "APPROVAL_IN_FUTURE" });
    store.approve("incident-1", approval(a, 950n), signed(a, approval(a, 950n)));
    assert.throws(() => store.approve("incident-1", approval(b, 940n), signed(b, approval(b, 940n))), { code: "EVENT_REJECTED" });
    // A replayed approval is acknowledged without a new event, so replays cannot fill the incident.
    for (let i = 0; i < 3; i += 1) assert.deepEqual(store.approve("incident-1", approval(a, 950n), signed(a, approval(a, 950n))), { sequence: 1, replayed: true });
    // Caller-supplied kind or incident hash never overrides the server's.
    const forged = { ...approval(a, 950n), kind: "BASELINE_VERIFIED", baselineHash: "77".repeat(32), evidenceHash: "64".repeat(32) };
    assert.deepEqual(store.approve("incident-1", forged, signed(a, approval(a, 950n))), { sequence: 1, replayed: true });
    assert.equal(store.incident("incident-1")?.state.phase, "FENCED");
    store.openIncident({ ...incident, incidentId: "incident-2" });
    const otherHash = manualRecoveryIncidentHash({ ...incident, incidentId: "incident-2" });
    assert.throws(() => store.approve("incident-1", { ...approval(b, 955n), incidentHash: otherHash } as ReturnType<typeof approval>, new Uint8Array(sign(null, manualRecoveryApprovalHash({ ...approval(b, 955n), incidentHash: otherHash }), b.key))), { code: "INVALID_SIGNATURE" });
    assert.equal(store.incident("incident-1")?.events.length, 1);

    // Loopback coordinator writes; the public route serves the replay and takes signed approvals.
    const internal = createCoordinationInternalHandler(store);
    const handler = createPublicApiHandler({ exchange, coordination: store, nowValue: () => NOW, clockMs: () => NOW_MS, rateLimit: { windowMs: 60_000, maxRequests: 1_000 } });
    const server = createServer((request, response) => {
      if (!internal(request, response) && !handler(request, response)) response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(toProtocolJson(body)) }) });
      return { status: response.status, body: fromProtocolJson(JSON.parse(await response.text())) as Record<string, unknown> };
    };
    try {
      const b2 = approval(b, 960n);
      const approved = await call("POST", "/v1/recovery/approvals", { incidentId: "incident-1", approval: b2, authorization: { scheme: "ED25519", signature: bs58.encode(signed(b, b2)) } });
      assert.equal(approved.status, 200);
      const executed = await call("POST", "/internal/recovery/events", { incidentId: "incident-1", event: { kind: "ACTION_EXECUTED", actionHash: "62".repeat(32), evidenceHash: "63".repeat(32), atValue: 970n } });
      assert.equal(executed.status, 200);
      assert.equal((await call("POST", "/internal/recovery/events", { incidentId: "incident-1", event: { kind: "BASELINE_VERIFIED", baselineHash: "77".repeat(32), evidenceHash: "64".repeat(32), atValue: 980n } }, { Origin: "https://example.com" })).status, 403);
      assert.equal((await call("POST", "/internal/recovery/events", { incidentId: "incident-1", event: { kind: "BASELINE_VERIFIED", baselineHash: "77".repeat(32), evidenceHash: "64".repeat(32), atValue: 980n } })).status, 200);
      const read = await call("GET", "/v1/recovery/incidents/incident-1");
      assert.equal((read.body.state as { phase: string }).phase, "RESTORED");
      assert.equal((read.body.events as unknown[]).length, 4);
      const committed = await call("POST", "/internal/coordination/events", { planHash, event: { kind: "COMMITTED", domainId: "svm:testnet", evidenceHash: "53".repeat(32), finality: "FINALIZED", atValue: 998n } });
      assert.equal(committed.status, 200);
      const coordination = await call("GET", `/v1/coordinations/${planHash}`);
      assert.equal(coordination.status, 200);
      assert.equal((coordination.body.state as { phase: string }).phase, "COMMITTING");
      assert.equal((await call("GET", `/v1/coordinations/${"cd".repeat(32)}`)).status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    store.close();
    exchange.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
