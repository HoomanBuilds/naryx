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

/** The persistent footer: environment, connection, activation status, and data provenance. */
export function StatusBar({
  snapshot,
  providerConnection,
  feedLabel,
  feedStatus = null,
  domainLabel,
  domainNote,
}: {
  snapshot: TerminalViewModel;
  providerConnection: ProviderConnection;
  feedLabel: string;
  /** Present when a public market API is configured. */
  feedStatus?: PublicFeedStatus | null;
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
      <span className={styles.statusItem}>
        <ChainIcon chain={domainLabel} size={12} />
        {domainLabel} <em>{domainNote}</em>
      </span>
      <span className={styles.statusItem}>Evidence <em>{snapshot.environment.evidenceGrade}</em></span>
      <span className={styles.statusItem} title={feedStatus?.detail}>
        Market data <em className={feedLabel === "FIXTURE" ? styles.statusFixture : undefined}>{feedLabel}</em>
        {feedStatus === null ? null : (
          <i
            className={feedStatus.state === "live" ? styles.dotOk : feedStatus.state === "unavailable" ? styles.dotOff : styles.dotWarn}
            aria-label={`Public market feed ${feedStatus.state}`}
            role="img"
          />
        )}
      </span>
      <span className={styles.statusSpacer} />
      <span className={styles.statusWarn}>Public deployment deferred</span>
      <span className={styles.statusDanger}>Mainnet writes prohibited</span>
      <span className={styles.statusItem} title="Snapshot capture time">Captured {snapshot.environment.capturedAt}</span>
      <UtcClock />
    </footer>
  );
}
