"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PublicPackageMarket } from "./public-market-feed";
import styles from "./pages/pages.module.css";

const STORAGE_KEY = "naryx.terminal.market-alerts.v1";
const STORAGE_EVENT = "naryx-market-alerts";
const MARKET_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SIGNED_INTEGER = /^-?(?:0|[1-9][0-9]{0,30})$/;
const EMPTY_ALERTS: readonly MarketAlert[] = Object.freeze([]);

type MarketAlert = Readonly<{ marketId: string; maximumSpreadTicks: string }>;

let memoryValue: string | null = null;
let cachedValue: string | null | undefined;
let cachedAlerts: readonly MarketAlert[] = EMPTY_ALERTS;

function storedValue() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? memoryValue;
  } catch {
    return memoryValue;
  }
}

function snapshot(): readonly MarketAlert[] {
  const value = storedValue();
  if (value === cachedValue) return cachedAlerts;
  cachedValue = value;
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    const alerts = Array.isArray(parsed) ? parsed.flatMap((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
      const candidate = entry as Record<string, unknown>;
      return typeof candidate.marketId === "string" && MARKET_ID.test(candidate.marketId)
        && typeof candidate.maximumSpreadTicks === "string" && SIGNED_INTEGER.test(candidate.maximumSpreadTicks)
        ? [Object.freeze({ marketId: candidate.marketId, maximumSpreadTicks: candidate.maximumSpreadTicks })]
        : [];
    }) : [];
    const byMarket = new Map(alerts.map((alert) => [alert.marketId, alert]));
    cachedAlerts = Object.freeze([...byMarket.values()].slice(0, 50));
  } catch {
    cachedAlerts = EMPTY_ALERTS;
  }
  return cachedAlerts;
}

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(STORAGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(STORAGE_EVENT, callback);
  };
}

function write(alerts: readonly MarketAlert[]) {
  memoryValue = JSON.stringify(alerts.slice(0, 50));
  try {
    window.localStorage.setItem(STORAGE_KEY, memoryValue);
  } catch {
    // The active page still retains the configuration when browser storage is unavailable.
  }
  window.dispatchEvent(new Event(STORAGE_EVENT));
}

export function MarketAlerts({ markets }: { markets: readonly PublicPackageMarket[] }) {
  const alerts = useSyncExternalStore(subscribe, snapshot, () => EMPTY_ALERTS);
  const [marketId, setMarketId] = useState("");
  const [maximumSpreadTicks, setMaximumSpreadTicks] = useState("10");
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const notified = useRef(new Set<string>());
  const marketById = useMemo(() => new Map(markets.map((market) => [market.packageMarketId, market])), [markets]);
  const selectedMarketId = marketById.has(marketId) ? marketId : markets[0]?.packageMarketId ?? "";
  const triggered = alerts.filter((alert) => {
    const market = marketById.get(alert.marketId);
    return market?.spreadTicks !== null && market?.spreadTicks !== undefined
      && !market.halted && market.spreadTicks <= BigInt(alert.maximumSpreadTicks);
  });

  useEffect(() => {
    const active = new Set(triggered.map((alert) => alert.marketId));
    for (const alert of alerts) if (!active.has(alert.marketId)) notified.current.delete(alert.marketId);
    if (notificationPermission !== "granted") return;
    for (const alert of triggered) {
      if (notified.current.has(alert.marketId)) continue;
      notified.current.add(alert.marketId);
      const spread = marketById.get(alert.marketId)?.spreadTicks;
      new Notification("Naryx package spread alert", {
        body: `${alert.marketId} is executable at ${spread?.toString() ?? "-"} ticks.`,
        tag: `naryx-market-${alert.marketId}`,
      });
    }
  }, [alerts, marketById, notificationPermission, triggered]);

  const validThreshold = SIGNED_INTEGER.test(maximumSpreadTicks);

  return (
    <section className={styles.card} aria-labelledby="market-alerts-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="market-alerts-title">Package spread alerts</h2>
          <p>Notify when a live package book reaches your maximum executable spread. Configuration stays in this browser.</p>
        </div>
        {notificationPermission === "default" ? (
          <button
            type="button"
            className={styles.ghost}
            onClick={() => void Notification.requestPermission().then(setNotificationPermission)}
          >
            Enable browser alerts
          </button>
        ) : (
          <span className={notificationPermission === "granted" ? styles.pillOk : styles.pill}>
            {notificationPermission === "granted" ? "Browser alerts on" : "In-app alerts only"}
          </span>
        )}
      </div>
      <form
        className={`${styles.cardBody} ${styles.alertForm}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (selectedMarketId === "" || !validThreshold) return;
          write([{ marketId: selectedMarketId, maximumSpreadTicks }, ...alerts.filter((alert) => alert.marketId !== selectedMarketId)]);
        }}
      >
        <label className={styles.field}>
          <span>Package market</span>
          <select value={selectedMarketId} onChange={(event) => setMarketId(event.target.value)} disabled={markets.length === 0}>
            {markets.length === 0 ? <option value="">No published markets</option> : markets.map((market) => (
              <option key={market.packageMarketId} value={market.packageMarketId}>{market.packageMarketId}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Maximum spread in ticks</span>
          <input inputMode="numeric" value={maximumSpreadTicks} onChange={(event) => setMaximumSpreadTicks(event.target.value)} aria-invalid={!validThreshold} />
        </label>
        <button type="submit" className={styles.connect} disabled={selectedMarketId === "" || !validThreshold}>Save alert</button>
      </form>
      {alerts.length > 0 ? (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead><tr><th>Market</th><th className={styles.num}>Trigger</th><th className={styles.num}>Current spread</th><th>Status</th><th aria-label="Action" /></tr></thead>
            <tbody>
              {alerts.map((alert) => {
                const market = marketById.get(alert.marketId);
                const active = triggered.some((candidate) => candidate.marketId === alert.marketId);
                return (
                  <tr key={alert.marketId}>
                    <td className={styles.mono}>{alert.marketId}</td>
                    <td className={styles.num}>&lt;= {alert.maximumSpreadTicks}</td>
                    <td className={styles.num}>{market?.spreadTicks?.toString() ?? "-"}</td>
                    <td><span className={active ? styles.pillOk : market?.halted ? styles.pillWarn : styles.pill}>{active ? "Triggered" : market?.halted ? "Halted" : "Watching"}</span></td>
                    <td className={styles.num}><button type="button" className={styles.ghost} onClick={() => write(alerts.filter((candidate) => candidate.marketId !== alert.marketId))}>Remove</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
