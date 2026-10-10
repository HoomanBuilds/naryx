"use client";

import { useEffect, useState } from "react";
import {
  NaryxClient,
  type ActivationConditionInput,
  type DerivedAdvancedOrderView,
  type ExecutionScheduleInput,
  type OrderActivationView,
} from "@naryx/sdk";
import { getSolanaDevnetSlot } from "./solana-devnet-onboarding";
import type { DomainId } from "./terminal-view-model";
import styles from "./trading-terminal.module.css";

type AdvancedMode = "IMMEDIATE" | "CONDITIONAL" | "SCHEDULED" | "PACKAGE_TWAP";
type ConditionMetric = ActivationConditionInput["metric"];
type Comparator = ActivationConditionInput["comparator"];

const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
const POSITIVE = /^[1-9][0-9]*$/;

function friendlyError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "Advanced order creation failed.";
  if (message.includes("SCHEDULE_OUTLIVES_ORDER")) return "Move the last slice before the strategy order expires.";
  if (message.includes("SCHEDULE_ABOVE_ORDER")) return "Scheduled quantity cannot exceed the strategy quantity.";
  if (message.includes("TIME_UNIT_MISMATCH")) return "Use the same clock unit as the strategy order.";
  if (message.includes("ORDER_NOT_FOUND")) return "Create or stage the immediate strategy order first.";
  return message;
}

export function AdvancedOrderControls({
  publicApiBaseUrl,
  executionDomain,
  sourceOrderHash,
  expiryUnit,
  expiryValue,
  derivedOrder,
  onDerived,
  onReset,
}: Readonly<{
  publicApiBaseUrl: string | null;
  executionDomain: DomainId;
  sourceOrderHash: string;
  expiryUnit: ActivationConditionInput["observationUnit"] | null;
  expiryValue: string | null;
  derivedOrder: DerivedAdvancedOrderView | null;
  onDerived: (order: DerivedAdvancedOrderView) => void;
  onReset: (sourceOrderHash: string) => void;
}>) {
  const [mode, setMode] = useState<AdvancedMode>("IMMEDIATE");
  const [metric, setMetric] = useState<ConditionMetric>("BASIS");
  const [comparator, setComparator] = useState<Comparator>("AT_OR_ABOVE");
  const [threshold, setThreshold] = useState("");
  const [maximumAge, setMaximumAge] = useState("30");
  const [startValue, setStartValue] = useState("");
  const [sliceInterval, setSliceInterval] = useState("");
  const [sliceCount, setSliceCount] = useState("4");
  const [aggregateQuantity, setAggregateQuantity] = useState("");
  const [maximumSliceQuantity, setMaximumSliceQuantity] = useState("");
  const [aggregateLimitPrice, setAggregateLimitPrice] = useState("");
  const [stopRule, setStopRule] = useState<ExecutionScheduleInput["stopRule"]>("STOP_ON_FIRST_FAILURE");
  const [activation, setActivation] = useState<OrderActivationView | null>(derivedOrder?.activation ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (derivedOrder === null || publicApiBaseUrl === null) return;
    const client = new NaryxClient({ baseUrl: publicApiBaseUrl });
    let stopped = false;
    const refresh = async () => {
      try {
        const next = await client.getOrderActivation(derivedOrder.orderHash);
        if (!stopped) {
          setActivation(next);
          setError(null);
        }
      } catch (cause) {
        if (!stopped) setError(friendlyError(cause));
      }
    };
    const timer = window.setInterval(() => void refresh(), 5_000);
    void refresh();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [derivedOrder, publicApiBaseUrl]);

  const conditionalReady = INTEGER.test(threshold) && POSITIVE.test(maximumAge);
  const scheduledReady = POSITIVE.test(startValue) && POSITIVE.test(sliceInterval)
    && POSITIVE.test(sliceCount) && POSITIVE.test(aggregateQuantity) && POSITIVE.test(maximumSliceQuantity)
    && (mode !== "PACKAGE_TWAP" || INTEGER.test(aggregateLimitPrice));
  const ready = publicApiBaseUrl !== null && expiryUnit !== null && expiryValue !== null
    && sourceOrderHash.length === 64
    && ((mode === "CONDITIONAL" && conditionalReady)
      || ((mode === "SCHEDULED" || mode === "PACKAGE_TWAP") && scheduledReady));

  async function createAdvancedOrder() {
    if (!ready || publicApiBaseUrl === null || expiryUnit === null) return;
    setBusy(true);
    setError(null);
    try {
      const condition: ActivationConditionInput | undefined = mode === "CONDITIONAL" ? {
        conditionVersion: 1,
        metric,
        comparator: metric === "TIME" ? "AT_OR_ABOVE" : comparator,
        threshold: BigInt(threshold),
        observationUnit: expiryUnit,
        maximumObservationAge: BigInt(maximumAge),
      } : undefined;
      const schedule: ExecutionScheduleInput | undefined = mode === "SCHEDULED" || mode === "PACKAGE_TWAP" ? {
        scheduleVersion: 1,
        kind: mode,
        timeUnit: expiryUnit,
        startValue: BigInt(startValue),
        sliceInterval: BigInt(sliceInterval),
        sliceCount: Number(sliceCount),
        aggregateQuantityLimit: BigInt(aggregateQuantity),
        maximumSliceQuantity: BigInt(maximumSliceQuantity),
        ...(mode === "PACKAGE_TWAP" ? { aggregateLimitPriceTicks: BigInt(aggregateLimitPrice) } : {}),
        stopRule,
      } : undefined;
      const atSlot = executionDomain === "solana" ? BigInt(await getSolanaDevnetSlot()) : undefined;
      const result = await new NaryxClient({ baseUrl: publicApiBaseUrl }).deriveAdvancedOrder({
        sourceOrderHash,
        ...(condition === undefined ? {} : { condition }),
        ...(schedule === undefined ? {} : { schedule }),
        ...(atSlot === undefined ? {} : { atSlot }),
      });
      setActivation(result.activation);
      onDerived(result);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  if (derivedOrder !== null && activation !== null) {
    return (
      <div className={styles.strategyDomainReview}>
        <div className={styles.evidenceHeading}>
          <h3>Advanced execution</h3>
          <span>{activation.status}</span>
        </div>
        <div className={styles.reviewGrid}>
          <span>Order type</span><strong>{activation.order.packageOrderType.replaceAll("_", " ")}</strong>
          <span>Executed quantity</span><strong>{activation.progress.executedQuantity.toString()} atoms</strong>
          <span>Completed attempts</span><strong>{activation.progress.attemptedSlices}</strong>
          <span>Failed attempts</span><strong>{activation.progress.failedSlices}</strong>
          <span>Advanced order</span><strong title={derivedOrder.orderHash}>{derivedOrder.orderHash.slice(0, 10)}...{derivedOrder.orderHash.slice(-8)}</strong>
        </div>
        <p className={styles.fieldContext} role="status">
          The activation runtime accepts authoritative observations and creates at most one reserved child attempt. Direct manual routing is disabled for this parent order.
        </p>
        <button type="button" className={styles.secondaryAction} disabled={busy} onClick={() => {
          setActivation(null);
          setMode("IMMEDIATE");
          setError(null);
          onReset(derivedOrder.sourceOrderHash);
        }}>
          Use immediate source order
        </button>
        {error ? <p className={styles.fieldContext} role="alert">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className={styles.strategyDomainReview}>
      <div className={styles.evidenceHeading}>
        <h3>Advanced execution</h3>
        <span>OPTIONAL</span>
      </div>
      <label htmlFor="advanced-order-mode">Execution policy</label>
      <select id="advanced-order-mode" value={mode} disabled={busy} onChange={(event) => {
        setMode(event.target.value as AdvancedMode);
        setError(null);
      }}>
        <option value="IMMEDIATE">Immediate</option>
        <option value="CONDITIONAL">Conditional trigger</option>
        <option value="SCHEDULED">Scheduled slices</option>
        <option value="PACKAGE_TWAP">Package TWAP</option>
      </select>
      {mode === "CONDITIONAL" ? (
        <>
          <label htmlFor="advanced-condition-metric">Trigger metric</label>
          <select id="advanced-condition-metric" value={metric} disabled={busy} onChange={(event) => setMetric(event.target.value as ConditionMetric)}>
            <option value="TIME">Time</option>
            <option value="PACKAGE_PRICE">Package price</option>
            <option value="BASIS">Basis</option>
            <option value="FUNDING">Funding</option>
            <option value="VOLATILITY">Volatility</option>
            <option value="INVENTORY">Inventory</option>
            <option value="MARGIN_HEALTH">Margin health</option>
            <option value="LIQUIDATION_DISTANCE">Liquidation distance</option>
          </select>
          {metric !== "TIME" ? (
            <>
              <label htmlFor="advanced-condition-comparator">Comparator</label>
              <select id="advanced-condition-comparator" value={comparator} disabled={busy} onChange={(event) => setComparator(event.target.value as Comparator)}>
                <option value="AT_OR_ABOVE">At or above</option>
                <option value="AT_OR_BELOW">At or below</option>
              </select>
            </>
          ) : null}
          <label htmlFor="advanced-condition-threshold">Threshold in exact metric units</label>
          <input id="advanced-condition-threshold" value={threshold} inputMode="numeric" disabled={busy} placeholder={metric === "TIME" ? `Before expiry ${expiryValue ?? ""}` : "Signed integer"} onChange={(event) => setThreshold(event.target.value.trim())} />
          <label htmlFor="advanced-condition-age">Maximum observation age in {expiryUnit ?? "order clock units"}</label>
          <input id="advanced-condition-age" value={maximumAge} inputMode="numeric" disabled={busy} onChange={(event) => setMaximumAge(event.target.value.replace(/[^0-9]/g, ""))} />
        </>
      ) : null}
      {mode === "SCHEDULED" || mode === "PACKAGE_TWAP" ? (
        <>
          <label htmlFor="advanced-schedule-start">First slice in {expiryUnit ?? "order clock units"}</label>
          <input id="advanced-schedule-start" value={startValue} inputMode="numeric" disabled={busy} placeholder={`Before expiry ${expiryValue ?? ""}`} onChange={(event) => setStartValue(event.target.value.replace(/[^0-9]/g, ""))} />
          <label htmlFor="advanced-schedule-interval">Slice interval</label>
          <input id="advanced-schedule-interval" value={sliceInterval} inputMode="numeric" disabled={busy} onChange={(event) => setSliceInterval(event.target.value.replace(/[^0-9]/g, ""))} />
          <label htmlFor="advanced-schedule-count">Slice count</label>
          <input id="advanced-schedule-count" value={sliceCount} inputMode="numeric" disabled={busy} onChange={(event) => setSliceCount(event.target.value.replace(/[^0-9]/g, ""))} />
          <label htmlFor="advanced-schedule-total">Total quantity in asset atoms</label>
          <input id="advanced-schedule-total" value={aggregateQuantity} inputMode="numeric" disabled={busy} onChange={(event) => setAggregateQuantity(event.target.value.replace(/[^0-9]/g, ""))} />
          <label htmlFor="advanced-schedule-slice">Maximum quantity per slice in asset atoms</label>
          <input id="advanced-schedule-slice" value={maximumSliceQuantity} inputMode="numeric" disabled={busy} onChange={(event) => setMaximumSliceQuantity(event.target.value.replace(/[^0-9]/g, ""))} />
          {mode === "PACKAGE_TWAP" ? (
            <>
              <label htmlFor="advanced-twap-limit">Aggregate package limit in market ticks</label>
              <input id="advanced-twap-limit" value={aggregateLimitPrice} inputMode="numeric" disabled={busy} placeholder="Signed integer" onChange={(event) => setAggregateLimitPrice(event.target.value.trim())} />
            </>
          ) : null}
          <label htmlFor="advanced-schedule-failure">Failed slice policy</label>
          <select id="advanced-schedule-failure" value={stopRule} disabled={busy} onChange={(event) => setStopRule(event.target.value as ExecutionScheduleInput["stopRule"])}>
            <option value="STOP_ON_FIRST_FAILURE">Stop on first failure</option>
            <option value="SKIP_FAILED_SLICE">Skip failed slice</option>
          </select>
        </>
      ) : null}
      {mode !== "IMMEDIATE" ? (
        <button type="button" className={styles.primaryAction} disabled={!ready || busy} onClick={() => void createAdvancedOrder()}>
          {busy ? "Creating advanced order" : `Create ${mode.replaceAll("_", " ").toLowerCase()} order`}
        </button>
      ) : (
        <p className={styles.fieldContext}>The stored strategy remains immediately quoteable and owner-authorized through the standard package flow.</p>
      )}
      {expiryUnit === null ? (
        <p className={styles.fieldContext}>Create or stage the strategy through this terminal to load its exact expiry clock before adding automation.</p>
      ) : null}
      {error ? <p className={styles.fieldContext} role="alert">{error}</p> : null}
    </div>
  );
}
