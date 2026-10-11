"use client";

import type { ReactNode } from "react";
import { WalletProviders } from "@/features/wallet/wallet-providers";
import { TerminalHeader } from "./terminal-header";
import { TerminalProvider, type TerminalServiceConfig } from "./terminal-context";
import { TransactionNotices, TransactionWatch } from "./transaction-watch";
import styles from "./shell.module.css";

/**
 * The frame every terminal page shares: wallets, service health, the chain selection, the header,
 * and the watch that keeps submitted transactions current on every page.
 */
export function TerminalShell({ config, children }: { config: TerminalServiceConfig; children: ReactNode }) {
  return (
    <WalletProviders>
      <TerminalProvider config={config}>
        <div className={styles.shell}>
          <TerminalHeader />
          {children}
          <TransactionWatch />
          <TransactionNotices />
        </div>
      </TerminalProvider>
    </WalletProviders>
  );
}
