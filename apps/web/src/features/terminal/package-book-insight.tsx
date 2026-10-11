"use client";

import { useState } from "react";
import { fromProtocolJson, packageAllocationHash, toHex, type NaryxClient, type VerifiedPackageReopening } from "@naryx/sdk";
import { publicClient, readFailure } from "./pages/public-read";
import styles from "./trading-terminal.module.css";

type TakerOrderInput = Parameters<NaryxClient["simulateClearing"]>[1];
type Allocation = Parameters<typeof packageAllocationHash>[0];

/** The unsigned package-book order the owner would sign, as the service prepared it. */
export type PreparedTakerOrder = Readonly<{ executionClassId: string; packageOrderId: string; order: unknown }>;

type Simulation =
  | Readonly<{ accepted: false; rejection: string }>
  | Readonly<{
    accepted: true;
    requested: bigint;
    filled: bigint;
    rested: bigint;
    cancelled: bigint;
    direct: bigint;
    implied: bigint;
    selfMatchCancelled: number;
    fills: readonly Readonly<{ sequence: bigint; priceTicks: bigint; quantity: bigint; source: string }>[];
  }>;

function hex(value: unknown): string {
  return value instanceof Uint8Array ? toHex(value) : typeof value === "string" ? value : "";
}

/** Verifies the shape and conservation of a simulated allocation; anything else is refused. */
function readSimulation(body: Record<string, unknown>, expectedOrderId: string): Simulation {
  if (body.accepted === false) {
    if (typeof body.rejection !== "string") throw new Error("The simulation rejection is malformed.");
    return { accepted: false, rejection: body.rejection };
  }
  if (body.accepted !== true) throw new Error("The simulation response is malformed.");
  const allocation = body.allocation as Allocation;
  try {
    packageAllocationHash(allocation);
  } catch {
    throw new Error("The simulated allocation failed validation and is not shown.");
  }
  if (hex(allocation.takerOrderId) !== expectedOrderId) throw new Error("The simulation is for another order and is not shown.");
  const filled = allocation.fills.reduce((sum, fill) => sum + fill.quantity, BigInt(0));
  if (filled + allocation.restedQuantity + allocation.cancelledQuantity !== allocation.requestedQuantity
    || filled !== allocation.internalMatchedQuantity + allocation.externalImpliedQuantity) {
    throw new Error("The simulated allocation does not conserve quantity and is not shown.");
  }
  return {
    accepted: true,
    requested: allocation.requestedQuantity,
    filled,
    rested: allocation.restedQuantity,
    cancelled: allocation.cancelledQuantity,
    direct: allocation.internalMatchedQuantity,
    implied: allocation.externalImpliedQuantity,
    selfMatchCancelled: allocation.selfMatchCancelledEntryIds.length,
    fills: allocation.fills.map((fill) => ({
      sequence: fill.fillSequence,
      priceTicks: fill.priceTicks,
      quantity: fill.quantity,
      source: fill.makerSource,
    })),
  };
}

const REJECTIONS: Readonly<Record<string, string>> = {
  HALTED: "the market is halted, so nothing would match now",
  DUPLICATE_ORDER: "this exact order is already on the book",
  POST_ONLY_WOULD_CROSS: "a post-only order would cross the book",
  FOK_UNFILLABLE: "the book cannot fill the whole order at once",
  MINIMUM_QUANTITY_UNFILLABLE: "the book cannot fill the order's minimum quantity",
};

/**
 * Runs the exact unsigned order against the current book through POST /v1/clearing/simulate. The
 * service persists and reserves nothing, so the result is a simulation, never a quote or a promise.
 */
export function PackageFillSimulation({
  publicApiBaseUrl,
  simulationKey,
  disabled,
  prepare,
}: Readonly<{
  publicApiBaseUrl: string | null;
  /** Changes whenever the order's side, limit, or strategy order changes, which discards the last result. */
  simulationKey: string;
  disabled: boolean;
  prepare: () => Promise<PreparedTakerOrder>;
}>) {
  const [state, setState] = useState<Readonly<{
    key: string;
    busy: boolean;
    result: Simulation | null;
    error: string | null;
  }> | null>(null);
  const current = state?.key === simulationKey ? state : null;

  async function simulate() {
    const client = publicClient(publicApiBaseUrl);
    const key = simulationKey;
    if (client === null) {
      setState({ key, busy: false, result: null, error: "The public API is not configured, so no simulation can run." });
      return;
    }
    setState({ key, busy: true, result: null, error: null });
    try {
      const prepared = await prepare();
      const body = await client.simulateClearing(prepared.executionClassId, fromProtocolJson(prepared.order) as TakerOrderInput);
      setState({ key, busy: false, result: readSimulation(body, prepared.packageOrderId), error: null });
    } catch (cause) {
      setState({ key, busy: false, result: null, error: readFailure(cause, "The fill simulation") });
    }
  }

  const result = current?.result ?? null;
  const prices = result?.accepted ? result.fills.map((fill) => fill.priceTicks) : [];
  return (
    <>
      <button type="button" className={styles.secondaryAction} disabled={disabled || current?.busy === true} onClick={() => void simulate()}>
        {current?.busy ? "Simulating fill" : "Simulate fill"}
      </button>
      {result !== null ? (
        <div className={styles.strategyDomainReview}>
          <div className={styles.evidenceHeading}>
            <h3>Fill simulation</h3>
            <span>SIMULATION</span>
          </div>
          {result.accepted ? (
            <div className={styles.reviewGrid}>
              <span>Would fill</span><strong>{result.filled.toString()} / {result.requested.toString()}</strong>
              <span>Would rest</span><strong>{result.rested.toString()}</strong>
              <span>Would cancel</span><strong>{result.cancelled.toString()}</strong>
              <span>Price range</span>
              <strong>{prices.length === 0 ? "No fill" : `${prices[0]!.toString()} to ${prices[prices.length - 1]!.toString()} ticks`}</strong>
              <span>Direct / implied</span><strong>{result.direct.toString()} / {result.implied.toString()}</strong>
              {result.selfMatchCancelled > 0 ? <><span>Own orders skipped</span><strong>{result.selfMatchCancelled}</strong></> : null}
              {result.fills.map((fill) => (
                <span key={fill.sequence.toString()} className={styles.simulationFill}>
                  Fill {fill.sequence.toString()}: {fill.quantity.toString()} at {fill.priceTicks.toString()} ticks ({fill.source.toLowerCase()})
                </span>
              ))}
            </div>
          ) : (
            <p className={styles.fieldContext}>Would not be accepted: {REJECTIONS[result.rejection] ?? result.rejection.replaceAll("_", " ").toLowerCase()}.</p>
          )}
          <p className={styles.fieldContext}>
            A simulation of this exact unsigned order against the book as it stands now. It is not a quote: nothing is reserved, and the book can move before you sign.
          </p>
        </div>
      ) : null}
      {current?.error ? <p className={styles.fieldContext} role="alert">{current.error}</p> : null}
    </>
  );
}

type HaltRecord = Readonly<{ reasonCode: string; incidentEvidenceHash: string; haltedSnapshotHash: string; recordedAtMs: number }>;

/** Reads GET /v1/package-book/halts/:hash; the identity is checked, but the hash is not recomputed here. */
async function readHalt(publicApiBaseUrl: string, haltHash: string, packageMarketId: string | null): Promise<HaltRecord> {
  const response = await fetch(`${publicApiBaseUrl}/v1/package-book/halts/${haltHash}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (response.status === 404) throw new Error("No halt with this hash is published on this server.");
  if (response.status === 503) throw new Error("Halt evidence is not configured on this server.");
  if (!response.ok) throw new Error(`Halt evidence is unavailable (HTTP ${response.status}).`);
  const body = fromProtocolJson(await response.json()) as Record<string, unknown>;
  const halt = body.halt as Record<string, unknown> | undefined;
  if (body.haltHashHex !== haltHash || halt === undefined || typeof halt.reasonCode !== "string"
    || typeof halt.executionClassId !== "string" || typeof body.haltedSnapshotHashHex !== "string"
    || typeof body.recordedAtMs !== "number") {
    throw new Error("The halt record does not bind the requested hash and is not shown.");
  }
  if (packageMarketId !== null && halt.executionClassId !== packageMarketId) {
    throw new Error("This halt belongs to another package market.");
  }
  return {
    reasonCode: halt.reasonCode,
    incidentEvidenceHash: hex(halt.incidentEvidenceHash),
    haltedSnapshotHash: body.haltedSnapshotHashHex,
    recordedAtMs: body.recordedAtMs,
  };
}

const HASH = /^[0-9a-f]{64}$/;

function short(value: string): string {
  return value.length > 20 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value;
}

/**
 * Halt and reopening evidence for a halted package market. The public API lists neither the active
 * halt nor a reopening schedule, so the trader looks evidence up by the hash the operator published.
 */
export function PackageHaltEvidence({
  publicApiBaseUrl,
  packageMarketId,
}: Readonly<{ publicApiBaseUrl: string | null; packageMarketId: string | null }>) {
  const [haltHash, setHaltHash] = useState("");
  const [resultHash, setResultHash] = useState("");
  const [halt, setHalt] = useState<HaltRecord | null>(null);
  const [reopening, setReopening] = useState<VerifiedPackageReopening | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lookUp() {
    if (publicApiBaseUrl === null) return;
    setBusy(true);
    setError(null);
    setHalt(null);
    setReopening(null);
    try {
      if (HASH.test(haltHash)) setHalt(await readHalt(publicApiBaseUrl, haltHash, packageMarketId));
      if (HASH.test(resultHash)) {
        const client = publicClient(publicApiBaseUrl);
        if (client === null) throw new Error("The public API is not configured.");
        const verified = await client.getPackageReopening(resultHash).catch((cause: unknown) => {
          throw new Error(readFailure(cause, "The reopening result"));
        });
        if (packageMarketId !== null && verified.result.executionClassId !== packageMarketId) {
          throw new Error("This reopening result belongs to another package market.");
        }
        setReopening(verified);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Halt evidence is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.strategyDomainReview}>
      <div className={styles.evidenceHeading}>
        <h3>Market halted</h3>
        <span>HALTED</span>
      </div>
      <p className={styles.fieldContext}>
        Continuous matching is stopped. A signed order submitted now is queued for the reopening auction and never
        matches before it clears. This service publishes no reopening schedule; the auction runs when the operator reopens the market.
      </p>
      <label htmlFor="package-halt-hash">Halt hash</label>
      <input id="package-halt-hash" value={haltHash} autoComplete="off" placeholder="64 hex characters" disabled={busy}
        onChange={(event) => setHaltHash(event.target.value.trim().toLowerCase())} />
      <label htmlFor="package-reopening-hash">Reopening result hash</label>
      <input id="package-reopening-hash" value={resultHash} autoComplete="off" placeholder="64 hex characters, after the auction" disabled={busy}
        onChange={(event) => setResultHash(event.target.value.trim().toLowerCase())} />
      <button type="button" className={styles.secondaryAction}
        disabled={publicApiBaseUrl === null || busy || (!HASH.test(haltHash) && !HASH.test(resultHash))}
        onClick={() => void lookUp()}>
        {busy ? "Reading evidence" : "Look up halt evidence"}
      </button>
      {halt !== null ? (
        <div className={styles.reviewGrid}>
          <span>Reason</span><strong>{halt.reasonCode}</strong>
          <span>Halted at</span><strong>{new Date(halt.recordedAtMs).toLocaleString()}</strong>
          <span>Incident evidence</span><strong title={halt.incidentEvidenceHash}>{short(halt.incidentEvidenceHash)}</strong>
          <span>Halted book snapshot</span><strong title={halt.haltedSnapshotHash}>{short(halt.haltedSnapshotHash)}</strong>
          <span>Verification</span><strong>Service-reported; this terminal does not recompute the halt hash</strong>
        </div>
      ) : null}
      {reopening !== null ? (
        <div className={styles.reviewGrid}>
          <span>Auction</span><strong title={toHex(reopening.result.auctionId)}>{short(toHex(reopening.result.auctionId))}</strong>
          <span>Reference price</span><strong>{reopening.result.referencePriceTicks.toString()} ticks</strong>
          <span>Clearing price</span><strong>{reopening.result.clearingPriceTicks === undefined ? "No cross" : `${reopening.result.clearingPriceTicks.toString()} ticks`}</strong>
          <span>Executed quantity</span><strong>{reopening.result.executedQuantity.toString()}</strong>
          <span>Fills</span><strong>{reopening.result.fills.length}</strong>
          <span>Settlement handoff</span><strong title={reopening.settlementHandoffHash}>{reopening.settlementHandoffHash ? short(reopening.settlementHandoffHash) : "None"}</strong>
          <span>Verification</span><strong>Result and handoff hashes recomputed by the SDK</strong>
        </div>
      ) : null}
      {publicApiBaseUrl === null ? <p className={styles.fieldContext}>The public API is not configured, so halt evidence cannot be read.</p> : null}
      {error ? <p className={styles.fieldContext} role="alert">{error}</p> : null}
    </div>
  );
}
