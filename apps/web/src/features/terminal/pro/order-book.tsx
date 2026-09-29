"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DepthLevel, MarketFeed, TapeTrade } from "../market-feed";
import styles from "./pro.module.css";

type BookView = "book" | "trades";
type BookSide = "both" | "bids" | "asks";

function grouped(levels: readonly DepthLevel[], step: number, side: "bid" | "ask"): DepthLevel[] {
  const buckets = new Map<number, { direct: number; implied: number }>();
  for (const level of levels) {
    const price = side === "bid" ? Math.floor(level.price / step + 1e-9) * step : Math.ceil(level.price / step - 1e-9) * step;
    const bucket = buckets.get(price) ?? { direct: 0, implied: 0 };
    bucket.direct += level.direct;
    bucket.implied += level.implied;
    buckets.set(price, bucket);
  }
  return [...buckets.entries()]
    .map(([price, bucket]) => ({ price, ...bucket }))
    .sort((left, right) => (side === "bid" ? right.price - left.price : left.price - right.price));
}

const ROW_HEIGHT = 21;
const SPREAD_HEIGHT = 34;

/** How many whole rows fit in the book body, so no level is ever drawn partially clipped. */
function useRowCapacity() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, height };
}

function time(seconds: number): string {
  return new Date(seconds * 1_000).toISOString().slice(11, 19);
}

function SideIcon({ side }: { side: BookSide }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.sideIcon}>
      {side !== "bids" ? <rect x="2" y="2" width="5" height={side === "both" ? 5 : 12} className={styles.sideIconAsk} /> : null}
      {side !== "asks" ? <rect x="2" y={side === "both" ? 9 : 2} width="5" height={side === "both" ? 5 : 12} className={styles.sideIconBid} /> : null}
      <path d="M9.5 3h4.5M9.5 6h4.5M9.5 10h4.5M9.5 13h4.5" />
    </svg>
  );
}

/**
 * The package order book and trade tape. Direct size is resting signed package orders; implied
 * size is derived from leg sources and is shown in its own column and never merged into direct
 * size. Depth bars scale with cumulative direct size only.
 */
export function OrderBook({ feed, unit }: { feed: MarketFeed; unit: string }) {
  const [view, setView] = useState<BookView>("book");
  const [sideFilter, setSideFilter] = useState<BookSide>("both");
  const book = useMemo(() => feed.depth(), [feed]);
  const trades = useMemo(() => feed.tape(), [feed]);
  const steps = [book.tick, book.tick * 2, book.tick * 10];
  const [step, setStep] = useState(book.tick);
  const { ref: bodyRef, height: bodyHeight } = useRowCapacity();
  const available = Math.max(0, bodyHeight - SPREAD_HEIGHT);
  const rowsPerSide = bodyHeight === 0 ? 12 : Math.max(3, Math.floor((sideFilter === "both" ? available / 2 : available) / ROW_HEIGHT));

  const { bids, asks, spread, mid, bidShare } = useMemo(() => {
    const bidLevels = grouped(book.bids, step, "bid");
    const askLevels = grouped(book.asks, step, "ask");
    const cumulative = (levels: DepthLevel[]) => {
      let running = 0;
      return levels.map((level) => {
        running += level.direct;
        return { ...level, cumulative: running };
      });
    };
    const withBids = cumulative(bidLevels);
    const withAsks = cumulative(askLevels);
    const bestBid = book.bids.find((level) => level.direct > 0)?.price;
    const bestAsk = book.asks.find((level) => level.direct > 0)?.price;
    const bidTotal = withBids.at(-1)?.cumulative ?? 0;
    const askTotal = withAsks.at(-1)?.cumulative ?? 0;
    return {
      bids: withBids,
      asks: withAsks,
      spread: bestBid === undefined || bestAsk === undefined ? undefined : bestAsk - bestBid,
      mid: bestBid === undefined || bestAsk === undefined ? undefined : (bestAsk + bestBid) / 2,
      bidShare: bidTotal + askTotal === 0 ? 50 : (bidTotal / (bidTotal + askTotal)) * 100,
    };
  }, [book, step]);

  // Bars scale to the deepest visible cumulative level so the shown ladder uses the full width.
  const visibleMax = Math.max(1, bids[Math.min(rowsPerSide, bids.length) - 1]?.cumulative ?? 0, asks[Math.min(rowsPerSide, asks.length) - 1]?.cumulative ?? 0);
  const row = (level: DepthLevel & { cumulative: number }, side: "bid" | "ask") => (
    <div key={`${side}-${level.price}`} className={styles.bookRow} role="row">
      <span
        className={side === "bid" ? styles.depthBarBid : styles.depthBarAsk}
        style={{ width: `${Math.min(100, (level.cumulative / visibleMax) * 100)}%` }}
        aria-hidden="true"
      />
      <span role="cell" className={side === "bid" ? styles.up : styles.down}>{level.price.toFixed(1)}</span>
      <span role="cell">{level.direct > 0 ? level.direct.toLocaleString("en-US") : <span className={styles.dimCell}>-</span>}</span>
      <span role="cell" className={styles.impliedCell}>{level.implied > 0 ? level.implied.toLocaleString("en-US") : <span className={styles.dimCell}>-</span>}</span>
      <span role="cell">{level.cumulative.toLocaleString("en-US")}</span>
    </div>
  );

  return (
    <section className={styles.bookPanel} aria-label="Order book and trades">
      <div className={styles.panelTabs} role="tablist" aria-label="Book view">
        <button type="button" role="tab" aria-selected={view === "book"} className={view === "book" ? styles.tabActive : undefined} onClick={() => setView("book")}>Order book</button>
        <button type="button" role="tab" aria-selected={view === "trades"} className={view === "trades" ? styles.tabActive : undefined} onClick={() => setView("trades")}>Trades</button>
      </div>
      {view === "book" ? (
        <>
          <div className={styles.bookControls}>
            <div className={styles.iconGroup} role="group" aria-label="Book side">
              {(["both", "bids", "asks"] as const).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  aria-pressed={sideFilter === entry}
                  aria-label={entry === "both" ? "Bids and asks" : entry === "bids" ? "Bids only" : "Asks only"}
                  title={entry === "both" ? "Bids and asks" : entry === "bids" ? "Bids only" : "Asks only"}
                  className={sideFilter === entry ? styles.iconActive : undefined}
                  onClick={() => setSideFilter(entry)}
                >
                  <SideIcon side={entry} />
                </button>
              ))}
            </div>
            <label className={styles.stepSelect}>
              <span className={styles.visuallyHidden}>Price grouping</span>
              <select value={step} onChange={(event) => setStep(Number(event.target.value))}>
                {steps.map((value) => <option key={value} value={value}>{value.toFixed(1)}</option>)}
              </select>
            </label>
          </div>
          <div className={styles.bookHeader} role="row">
            <span role="columnheader">Price ({unit})</span>
            <span role="columnheader" title="Resting signed package orders">Direct</span>
            <span role="columnheader" title="Derived from leg sources; never merged into direct size">Implied</span>
            <span role="columnheader" title="Cumulative direct size">Total</span>
          </div>
          <div ref={bodyRef} className={styles.bookBody} role="table" aria-label="Package depth">
            {sideFilter !== "bids" ? (
              <div className={sideFilter === "asks" ? styles.bookSideFull : styles.bookAsks}>
                {(sideFilter === "asks" ? asks.slice(0, rowsPerSide) : asks.slice(0, rowsPerSide).reverse()).map((level) => row(level, "ask"))}
              </div>
            ) : null}
            <div className={styles.spreadRow} role="row">
              <strong role="cell" title="Mid of best direct bid and ask">{mid === undefined ? "-" : mid.toFixed(2)}</strong>
              <span role="cell">Spread</span>
              <span role="cell">{spread === undefined ? "-" : `${spread.toFixed(1)} ${unit}`}</span>
            </div>
            {sideFilter !== "asks" ? (
              <div className={sideFilter === "bids" ? styles.bookSideFull : styles.bookBids}>
                {bids.slice(0, rowsPerSide).map((level) => row(level, "bid"))}
              </div>
            ) : null}
          </div>
          <div className={styles.ratioBar} aria-label={`Direct depth ${bidShare.toFixed(0)} percent bids`}>
            <span className={styles.up}>B {bidShare.toFixed(0)}%</span>
            <div className={styles.ratioTrack}>
              <i className={styles.ratioBid} style={{ width: `${bidShare}%` }} />
              <i className={styles.ratioAsk} style={{ width: `${100 - bidShare}%` }} />
            </div>
            <span className={styles.down}>{(100 - bidShare).toFixed(0)}% S</span>
          </div>
        </>
      ) : (
        <TradeTape trades={trades} unit={unit} />
      )}
    </section>
  );
}

function TradeTape({ trades, unit }: { trades: readonly TapeTrade[]; unit: string }) {
  return (
    <>
      <div className={styles.tapeHeader} role="row">
        <span role="columnheader">Price ({unit})</span>
        <span role="columnheader">Size</span>
        <span role="columnheader">Source</span>
        <span role="columnheader">Time</span>
      </div>
      <div className={styles.tapeBody} role="table" aria-label="Recent package trades">
        {trades.map((trade) => (
          <div key={trade.id} className={styles.tapeRow} role="row">
            <span role="cell" className={trade.side === "BID" ? styles.up : styles.down}>{trade.price.toFixed(1)}</span>
            <span role="cell">{trade.size.toLocaleString("en-US")}</span>
            <span role="cell" className={trade.source === "IMPLIED" ? styles.impliedCell : styles.dimCell}>{trade.source === "IMPLIED" ? "Implied" : "Direct"}</span>
            <span role="cell" className={styles.dimCell}>{time(trade.time)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
