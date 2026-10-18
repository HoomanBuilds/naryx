"use client";

import { useQuery } from "@tanstack/react-query";
import styles from "./pages.module.css";

type StandingLevel = Readonly<{
  levelId: string;
  referenceOffsetAtoms: string;
  remainingCapacityUnits: string;
  expirySlot: string;
}>;

type StandingBook = Readonly<{
  version: 1;
  domainId: "svm:devnet";
  shard: string;
  seriesManifestHash: string;
  finalizedSlot: string;
  referencePackagePriceAtoms: string;
  bid: StandingLevel | null;
  ask: StandingLevel | null;
}>;

const format = (value: string) => new Intl.NumberFormat("en-US").format(BigInt(value));

function StandingSide({ side, level, reference }: { side: "Bid" | "Ask"; level: StandingLevel | null; reference: string }) {
  const price = level === null ? null : BigInt(reference) + BigInt(level.referenceOffsetAtoms);
  return (
    <div className={styles.standingSide}>
      <span>{side}</span>
      {level === null ? <strong>No current level</strong> : (
        <>
          <strong className={styles.num}>Reference {new Intl.NumberFormat("en-US").format(price!)} atoms</strong>
          <small className={styles.num}>{format(level.remainingCapacityUnits)} package units</small>
        </>
      )}
    </div>
  );
}

export function OnchainStandingBook({ baseUrl }: { baseUrl: string | null }) {
  const query = useQuery({
    queryKey: ["solana-devnet-standing-book", baseUrl],
    enabled: baseUrl !== null,
    refetchInterval: 10_000,
    retry: false,
    queryFn: async ({ signal }): Promise<StandingBook> => {
      const response = await fetch(`${baseUrl}/internal/terminal/solana-devnet/standing-book`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error(`Standing book returned ${response.status}`);
      const book = await response.json() as StandingBook;
      if (book.version !== 1 || book.domainId !== "svm:devnet") throw new Error("Standing book identity mismatch");
      return book;
    },
  });
  const book = query.isError ? null : query.data ?? null;

  return (
    <section className={styles.card} aria-labelledby="onchain-standing-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="onchain-standing-title">Solana cash-and-carry quotes</h2>
          <p>Current maker capacity, bounded by finalized token balances and market limits.</p>
        </div>
        <span className={book === null ? styles.pill : styles.pillOk}>{book === null ? "Unavailable" : "Onchain snapshot"}</span>
      </div>
      {book === null ? (
        <div className={styles.empty}>
          <strong>{query.isLoading ? "Reading finalized Solana state" : "No current onchain quote snapshot"}</strong>
          <p>This view does not substitute stale or simulated quotes when the Devnet read fails.</p>
        </div>
      ) : (
        <>
          <div className={styles.standingSides}>
            <StandingSide side="Bid" level={book.bid} reference={book.referencePackagePriceAtoms} />
            <StandingSide side="Ask" level={book.ask} reference={book.referencePackagePriceAtoms} />
          </div>
          <p className={styles.standingNote}>
            Finalized slot {format(book.finalizedSlot)}. The shard reference is not a net strategy price.
            Request a complete quote for executable pricing; inventory is reserved during preparation.
            This is the cash-and-carry solver shard, not treasury-hedge liquidity or public package-exchange depth.
            Refreshed levels from the same maker are not added together.
          </p>
        </>
      )}
    </section>
  );
}
