"use client";

import { useEffect, useState } from "react";
import type { PublicFeedStatus } from "../public-market-feed";
import type { ProviderConnection, TerminalViewModel } from "../terminal-view-model";
import { ChainIcon } from "@/features/brand/chain-icons";
import styles from "./pro.module.css";

function UtcClock() {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date().toISOString().slice(11, 19));
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className={styles.statusItem} suppressHydrationWarning>{now === null ? "--:--:--" : now} UTC</span>;
}

export function StatusBar({
  snapshot,
  providerConnection,
  feedLabel,
  feedStatus = null,
  domainLabel,
  domainNote,
  executionLive,
}: {
  snapshot: TerminalViewModel;
  providerConnection: ProviderConnection;
  feedLabel: string;
  /** Present when a public market API or the private API's reference history is configured. */
  feedStatus?: PublicFeedStatus | null;
  domainLabel: string;
  domainNote: string;
  /** The selected domain's testnet runtime and the execution gate are both up. */
  executionLive: boolean;
}) {
  const connection = providerConnection === "connected" ? "Service connected" : providerConnection === "connecting" ? "Connecting" : "Service offline";
  const dataLabel = feedLabel === "FIXTURE" ? "Sample data" : feedLabel === "REFERENCE" ? "Index prices" : feedLabel === "OBSERVED" ? "Market data" : "Data unavailable";
  return (
    <footer className={styles.statusBar} aria-label="Terminal status">
      <span className={providerConnection === "connected" ? styles.statusPillOk : styles.statusPill}>
        <i className={providerConnection === "connected" ? styles.dotOk : providerConnection === "connecting" ? styles.dotWarn : styles.dotOff} aria-hidden="true" />
        {connection}
      </span>
      <span className={styles.statusNetwork} title={`${domainLabel}. ${domainNote}`}>
        <ChainIcon chain={domainLabel} size={12} />
        {domainLabel} <span>{snapshot.environment.source === "LOCAL_CONFORMANCE" ? "Local" : "Testnet"}</span>
      </span>
      <span className={`${styles.statusItem} ${styles.statusData}`} title={feedStatus?.detail}>
        {dataLabel}{feedStatus === null ? null : <em>{feedStatus.state === "live" ? "connected" : feedStatus.state}</em>}
      </span>
      <span className={styles.statusSpacer} />
      <span className={`${styles.statusItem} ${styles.statusExecution}`}>
        {executionLive ? <>Execution <em>available</em></> : "Execution unavailable"}
      </span>
      <UtcClock />
    </footer>
  );
}
