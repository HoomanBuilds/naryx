"use client";

import type { NaryxClient, SizeQuoteView } from "@naryx/sdk";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { PublicPackageMarket } from "../public-market-feed";
import { ReadState, asRecord, compact, publicClient, shown } from "./public-read";
import styles from "./pages.module.css";

const QUOTE_MODE: Readonly<Record<string, string>> = {
  IMPLIED: "Implied",
  EXECUTION_COMMITMENT: "Execution commitment",
  FIRM_SIMULATED: "Firm, simulated",
  FIRM_ONCHAIN: "Firm, onchain",
  FIRM_BONDED: "Firm, bonded",
};

function quoteAt(quote: Partial<SizeQuoteView> | undefined): string {
  if (quote === undefined) return "-";
  if (quote.averagePriceTicks !== undefined) return quote.averagePriceTicks.toString();
  return quote.fillableQuantity === undefined || quote.fillableQuantity === BigInt(0) ? "No depth" : `Partial ${quote.fillableQuantity.toString()} only`;
}

function quoteList(value: unknown, label: "EXECUTABLE" | "INDICATIVE", sizes: readonly bigint[]): readonly Partial<SizeQuoteView>[] | null {
  if (!Array.isArray(value) || value.length !== sizes.length) return null;
  const quotes = value.map((entry) => asRecord(entry));
  // A side is shown only when every size answers under the label it claims.
  return quotes.every((quote, index) => quote !== null && quote.label === label && quote.size === sizes[index]
    && typeof quote.fillableQuantity === "bigint" && (quote.averagePriceTicks === undefined || typeof quote.averagePriceTicks === "bigint"))
    ? quotes as Partial<SizeQuoteView>[]
    : null;
}

function SizeIndex({ client, scope, marketId, sizes }: { client: NaryxClient; scope: string; marketId: string; sizes: readonly bigint[] }) {
  const query = useQuery({
    queryKey: ["market-index", scope, marketId, sizes.join(",")],
    retry: false,
    staleTime: 5_000,
    queryFn: () => client.getIndex(marketId, sizes),
  });
  return (
    <ReadState query={query} subject="Executable index">
      {(index) => {
        const bids = quoteList(index.executable.bids, "EXECUTABLE", sizes);
        const asks = quoteList(index.executable.asks, "EXECUTABLE", sizes);
        const impliedBids = quoteList(index.withImplied?.bids, "INDICATIVE", sizes);
        const impliedAsks = quoteList(index.withImplied?.asks, "INDICATIVE", sizes);
        if (bids === null || asks === null) return <p className={styles.readNote}>The executable index does not answer every size under its label and is not shown.</p>;
        return (
          <>
            <p className={styles.readNote}>
              Best {index.bestBidTicks?.toString() ?? "-"} / {index.bestAskTicks?.toString() ?? "-"}, spread {index.spreadTicks?.toString() ?? "-"} ticks. Methodology v{index.methodologyVersion}.
            </p>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.num}>Size</th>
                  <th className={styles.num}>Executable bid / ask</th>
                  <th className={styles.num}>Indicative with implied</th>
                </tr>
              </thead>
              <tbody>
                {sizes.map((size, position) => (
                  <tr key={size.toString()}>
                    <td className={styles.num}>{size.toString()}</td>
                    <td className={styles.num}>{quoteAt(bids[position])} / {quoteAt(asks[position])}</td>
                    <td className={styles.num}>
                      {impliedBids === null || impliedAsks === null ? "Not labeled indicative" : `${quoteAt(impliedBids[position])} / ${quoteAt(impliedAsks[position])}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        );
      }}
    </ReadState>
  );
}

function QuoteSurface({ client, scope, marketId }: { client: NaryxClient; scope: string; marketId: string }) {
  const query = useQuery({
    queryKey: ["market-quotes", scope, marketId],
    retry: false,
    staleTime: 5_000,
    queryFn: () => client.getMarketQuotes(marketId),
  });
  return (
    <ReadState query={query} subject="Maker quote surface" empty={(quotes) => quotes.length === 0 ? "No live maker quote level for this market." : null}>
      {(quotes) => (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Solver</th>
              <th>Side</th>
              <th className={styles.num}>Size</th>
              <th className={styles.num}>Offset</th>
              <th className={styles.num}>Max fee</th>
              <th>Mode</th>
              <th>Settlement</th>
            </tr>
          </thead>
          <tbody>
            {quotes.map((quote) => (
              <tr key={`${shown(quote.shardHash)}:${shown(quote.levelId)}`}>
                <td className={styles.mono} title={`Shard ${shown(quote.shardHash)} sequence ${shown(quote.shardSequence)}`}>{shown(quote.solverId)}</td>
                <td>{shown(quote.direction)}</td>
                <td className={styles.num}>{shown(quote.size)}</td>
                <td className={styles.num}>{shown(quote.referenceOffset)}</td>
                <td className={styles.num}>{shown(quote.maximumFee)}</td>
                <td>{QUOTE_MODE[shown(quote.quoteMode)] ?? shown(quote.quoteMode)}</td>
                <td>{shown(quote.settlementClass)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ReadState>
  );
}

function ImpliedProvenance({ client, scope, marketId }: { client: NaryxClient; scope: string; marketId: string }) {
  const query = useQuery({
    queryKey: ["market-implied-provenance", scope, marketId],
    retry: false,
    staleTime: 5_000,
    queryFn: () => client.getImpliedProvenance(marketId),
  });
  return (
    <ReadState query={query} subject="Implied liquidity provenance" empty={(entries) => entries.length === 0 ? "No implied liquidity rests on this book." : null}>
      {(entries) => (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Side</th>
              <th className={styles.num}>Price</th>
              <th className={styles.num}>Quantity</th>
              <th>Evidence</th>
              <th className={styles.num}>Depth / sources</th>
              <th>Label</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={shown(entry.entryId)}>
                <td title={`Entry ${shown(entry.entryId)} from ${shown(entry.solverId)}`}>{shown(entry.side)}</td>
                <td className={styles.num}>{shown(entry.priceTicks)}</td>
                <td className={styles.num}>{shown(entry.quantity)}</td>
                <td>{shown(entry.evidence).replaceAll("_", " ")}</td>
                <td className={styles.num}>{shown(entry.derivationDepth)} / {Array.isArray(entry.sources) ? entry.sources.length : "-"}</td>
                <td><span className={entry.label === "EXECUTABLE" ? styles.pillOk : styles.pillWarn}>{entry.label === "EXECUTABLE" ? "Executable" : "Indicative"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ReadState>
  );
}

function SeriesIndex({ client, scope, seriesId, marketId, sizes }: { client: NaryxClient; scope: string; seriesId: string; marketId: string; sizes: readonly bigint[] }) {
  const query = useQuery({
    queryKey: ["series-index", scope, seriesId, sizes.join(",")],
    retry: false,
    staleTime: 5_000,
    queryFn: () => client.getSeriesIndex(seriesId, sizes),
  });
  return (
    <ReadState query={query} subject="Series index" empty={(body) => Array.isArray(body.executionClasses) && body.executionClasses.length > 0 ? null : "No execution class is registered for this series."}>
      {(body) => (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Execution class</th>
              <th>Settlement</th>
              <th>Status</th>
              <th className={styles.num}>Executable at {sizes[0]!.toString()}</th>
              <th className={styles.num}>Indicative at {sizes[0]!.toString()}</th>
            </tr>
          </thead>
          <tbody>
            {(body.executionClasses as unknown[]).map((candidate, position) => {
              const entry = asRecord(candidate) ?? {};
              const index = asRecord(entry.index);
              const executable = asRecord(index?.executable);
              const implied = asRecord(index?.withImplied);
              const bids = quoteList(executable?.bids, "EXECUTABLE", sizes);
              const asks = quoteList(executable?.asks, "EXECUTABLE", sizes);
              const impliedBids = quoteList(implied?.bids, "INDICATIVE", sizes);
              const impliedAsks = quoteList(implied?.asks, "INDICATIVE", sizes);
              const status = entry.open !== true ? "Not opened" : entry.halted === true ? "Halted" : "Open";
              return (
                <tr key={`${shown(entry.executionClassId)}:${position}`}>
                  <td className={styles.mono}>{shown(entry.executionClassId)}{entry.executionClassId === marketId ? " (this book)" : ""}</td>
                  <td>{shown(entry.settlementClass)}</td>
                  <td><span className={status === "Open" ? styles.pillOk : styles.pillWarn}>{status}</span></td>
                  <td className={styles.num}>{bids === null || asks === null ? "-" : `${quoteAt(bids[0])} / ${quoteAt(asks[0])}`}</td>
                  <td className={styles.num}>{impliedBids === null || impliedAsks === null ? "-" : `${quoteAt(impliedBids[0])} / ${quoteAt(impliedAsks[0])}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </ReadState>
  );
}

/**
 * Market transparency for one book, read only when the row is opened. Direct depth is executable;
 * anything that adds implied liquidity is indicative unless the server labels the entry executable
 * from its solver or reservation backing. Nothing here is modeled.
 */
export function MarketTransparency({ baseUrl, market, sizes }: { baseUrl: string | null; market: PublicPackageMarket; sizes: readonly bigint[] }) {
  const client = useMemo(() => publicClient(baseUrl), [baseUrl]);
  if (client === null) return <p className={styles.readNote}>Market transparency needs an HTTPS public API.</p>;
  const scope = baseUrl ?? "";
  return (
    <div className={styles.transparencyGrid}>
      <div className={styles.transparencyPanel}>
        <h3>Size-indexed price <span className={styles.pillOk}>Executable</span> <span className={styles.pill}>Indicative</span></h3>
        <SizeIndex client={client} scope={scope} marketId={market.packageMarketId} sizes={sizes} />
      </div>
      <div className={styles.transparencyPanel}>
        <h3>Maker quote surface <span className={styles.pill}>Quoted levels</span></h3>
        <p className={styles.readNote}>Offsets from each shard&apos;s signed reference state. A level fills only once matched; its mode states its firmness.</p>
        <QuoteSurface client={client} scope={scope} marketId={market.packageMarketId} />
      </div>
      <div className={styles.transparencyPanel}>
        <h3>Implied liquidity provenance</h3>
        <p className={styles.readNote}>The server labels each entry from its backing evidence. Implied quantity is never merged into direct depth.</p>
        <ImpliedProvenance client={client} scope={scope} marketId={market.packageMarketId} />
      </div>
      <div className={styles.transparencyPanel}>
        <h3>Series index {market.seriesId === null ? null : <span className={styles.mono} title={market.seriesId}>{compact(market.seriesId, 18, 6)}</span>}</h3>
        {market.seriesId === null
          ? <p className={styles.readNote}>This book has no verified series metadata, so its series index cannot be selected.</p>
          : <SeriesIndex client={client} scope={scope} seriesId={market.seriesId} marketId={market.packageMarketId} sizes={sizes} />}
      </div>
    </div>
  );
}
