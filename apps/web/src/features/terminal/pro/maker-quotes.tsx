"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatAtomicAmount } from "../format";
import { marketAssetLabel } from "../market-label";
import styles from "./pro.module.css";
import bookStyles from "./order-book.module.css";

type QuotePoint = {
  levelId: string;
  quantityAtoms: string;
  basisQuoteAtoms: string;
  feeQuoteAtoms: string;
};

type MakerLadder = {
  version: 1;
  domainId: "svm:devnet";
  templateId: "cash-and-carry-v1";
  pricing: "INDICATIVE";
  quantityKind: "ALTERNATIVE_SIZES";
  capturedAtMs: number;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  bids: QuotePoint[];
  asks: QuotePoint[];
};

export function MakerQuotes({ apiOrigin, onSelectSize }: {
  apiOrigin: string | null;
  onSelectSize: (quantityAtoms: string, decimals: number, mode: "entry" | "exit") => void;
}) {
  const [now, setNow] = useState(0);
  const query = useQuery({
    queryKey: ["solana-cash-carry-maker-quotes", apiOrigin],
    enabled: apiOrigin !== null,
    queryFn: async ({ signal }): Promise<MakerLadder> => {
      const response = await fetch(new URL("/internal/terminal/solana-devnet/quote-ladder", apiOrigin!), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), cache: "no-store",
      });
      if (!response.ok) throw new Error("Maker pricing is temporarily unavailable.");
      const data = await response.json() as MakerLadder;
      if (data.version !== 1 || data.domainId !== "svm:devnet" || data.templateId !== "cash-and-carry-v1"
        || data.pricing !== "INDICATIVE" || data.quantityKind !== "ALTERNATIVE_SIZES"
        || !Number.isSafeInteger(data.capturedAtMs)) throw new Error("Maker pricing identity is invalid.");
      return data;
    },
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    retry: false,
  });
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  const data = query.data;
  const fresh = data !== undefined && !query.isError && now >= data.capturedAtMs - 1_000
    && now - data.capturedAtMs < 10_000;
  const ready = fresh && data.bids.length + data.asks.length > 0;
  const amount = (atoms: string, decimals: number) => formatAtomicAmount(atoms, decimals, "").trim();
  const levels = (points: QuotePoint[], mode: "entry" | "exit") => (
    <div className={bookStyles.quoteSide}>
      <div className={bookStyles.quoteSideTitle}>
        <span className={mode === "entry" ? styles.down : styles.up}>{mode === "entry" ? "Enter package" : "Exit package"}</span>
        <span>{mode === "entry" ? "Buy spot / short perp" : "Sell spot / close short"}</span>
      </div>
      {points.length === 0 ? <p className={bookStyles.quoteUnavailable}>No funded quote sizes available.</p> : points.map((point) => (
        <button key={point.quantityAtoms} type="button" className={bookStyles.quoteRow}
          onClick={() => onSelectSize(point.quantityAtoms, data!.baseDecimals, mode)}
          title={`Use this size for a new ${mode} quote. No trade is submitted.`}>
          <span>{amount(point.quantityAtoms, data!.baseDecimals)}</span>
          <span className={mode === "entry" ? styles.down : styles.up}>{amount(point.basisQuoteAtoms, data!.quoteDecimals)}</span>
          <span>{amount(point.feeQuoteAtoms, data!.quoteDecimals)}</span>
        </button>
      ))}
    </div>
  );
  return (
    <section className={styles.bookPanel} aria-label="SOL cash-and-carry maker quotes">
      <div className={bookStyles.quoteHeading}>
        <strong>Maker quotes</strong>
        <span className={ready ? styles.labelObserved : styles.labelUnavailable}>
          {query.isPending && apiOrigin ? "Loading" : ready ? "Indicative" : "Unavailable"}
        </span>
      </div>
      {!ready ? <div className={bookStyles.empty} role="status">
        <strong>{query.isPending && apiOrigin ? "Reading funded maker quotes" : "Maker quotes unavailable"}</strong>
        <p>{fresh ? "The maker has no currently funded sizes. Quotes return when inventory and validity allow."
          : "Fresh maker pricing is required. Expired or unavailable quotes are not displayed."}</p>
        <button type="button" disabled={query.isFetching || !apiOrigin} onClick={() => void query.refetch()}>Refresh quotes</button>
      </div> : <>
        <div className={bookStyles.quoteMarket}>SOL cash and carry <span>Quote at size</span></div>
        <div className={bookStyles.quoteColumns}>
          <span>Size ({marketAssetLabel(data.baseMint)})</span>
          <span title="Spot value minus perpetual notional for the complete size, before fees">Basis ({marketAssetLabel(data.quoteMint)})</span>
          <span title="Perpetual trading fee in the quote asset, excluding gas and funding">Perp fee</span>
        </div>
        <div className={bookStyles.quoteLevels}>
          {levels(data.asks, "entry")}
          {levels(data.bids, "exit")}
        </div>
        <div className={bookStyles.quoteFootnote}>
          <p>Alternative sizes share inventory, not cumulative depth. Funding and gas excluded. Select a size to request a firm quote. Inventory is reserved when accepted.</p>
          <span>Updated {new Date(data.capturedAtMs).toLocaleTimeString("en-GB", { hour12: false })}</span>
        </div>
      </>}
    </section>
  );
}
