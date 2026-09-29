"use client";

import { useEffect, useState } from "react";
import type { ProviderConnection, TerminalViewModel } from "../terminal-view-model";
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

/** The persistent footer: environment, connection, activation status, and data provenance. */
export function StatusBar({
  snapshot,
  providerConnection,
  feedLabel,
  domainLabel,
  domainNote,
}: {
  snapshot: TerminalViewModel;
  providerConnection: ProviderConnection;
  feedLabel: string;
  domainLabel: string;
  domainNote: string;
}) {
  const connection = providerConnection === "connected" ? "Service connected" : providerConnection === "connecting" ? "Connecting" : "Service offline";
  return (
    <footer className={styles.statusBar} aria-label="Terminal status">
      <span className={providerConnection === "connected" ? styles.statusPillOk : styles.statusPill}>
        <i className={providerConnection === "connected" ? styles.dotOk : providerConnection === "connecting" ? styles.dotWarn : styles.dotOff} aria-hidden="true" />
        {connection}
      </span>
      <span className={styles.statusItem}>{domainLabel} <em>{domainNote}</em></span>
      <span className={styles.statusItem}>Evidence <em>{snapshot.environment.evidenceGrade}</em></span>
      <span className={styles.statusItem}>Market data <em className={feedLabel === "FIXTURE" ? styles.statusFixture : undefined}>{feedLabel}</em></span>
      <span className={styles.statusSpacer} />
      <span className={styles.statusWarn}>Public deployment deferred</span>
      <span className={styles.statusDanger}>Mainnet writes prohibited</span>
      <span className={styles.statusItem} title="Snapshot capture time">Captured {snapshot.environment.capturedAt}</span>
      <UtcClock />
    </footer>
  );
}
