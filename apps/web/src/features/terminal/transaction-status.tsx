import type { ReactNode } from "react";
import type { DomainId } from "./terminal-view-model";
import shellStyles from "./shell/shell.module.css";

const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

/**
 * The public test-network explorer page for a submitted transaction. Only the testnets this app
 * signs on are mapped, so a link never points at a mainnet explorer; anything else is null.
 */
export function explorerTransactionUrl(domain: DomainId | number, hash: string): string | null {
  if (domain === "solana") return SOLANA_SIGNATURE.test(hash) ? `https://explorer.solana.com/tx/${hash}?cluster=devnet` : null;
  if (!EVM_HASH.test(hash)) return null;
  if (domain === "base" || domain === 84532) return `https://sepolia.basescan.org/tx/${hash}`;
  if (domain === "arbitrum" || domain === 421614) return `https://sepolia.arbiscan.io/tx/${hash}`;
  return null;
}

/**
 * Runs `refresh` whenever the page becomes visible again, so a poll that a background tab
 * throttled catches up the moment the user returns. Returns the cleanup.
 */
export function refreshOnReturn(refresh: () => void): () => void {
  const onVisible = () => {
    if (document.visibilityState === "visible") refresh();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}

/** The transaction reference as a link to its testnet explorer page, or plain text when none applies. */
export function TransactionLink({ domain, hash, children }: { domain: DomainId | number; hash: string; children: ReactNode }) {
  const href = explorerTransactionUrl(domain, hash);
  if (href === null) return <>{children}</>;
  return (
    <a className={shellStyles.txLink} href={href} target="_blank" rel="noopener noreferrer" title={`${hash} (opens the testnet explorer)`}>{children}</a>
  );
}
