"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DepthLevel, MarketFeed, TapeTrade } from "../market-feed";
import type { PublicFeedStatus } from "../public-market-feed";
import { handleTablistKeys, usePersistedSetting } from "../persisted-setting";
import styles from "./pro.module.css";
import bookStyles from "./order-book.module.css";

type BookView = "book" | "trades" | "ladder";

/**
 * The average and worst price to fill each size against the book, walking the selected
 * depth from the touch. A size the book cannot fill has no price, never an extrapolated one.
 */
function sizeLadder(levels: readonly DepthLevel[], sizes: readonly number[], implied: boolean): { size: number; average?: number; worst?: number }[] {
  return sizes.map((size) => {
    let remaining = size;
    let notional = 0;
    let worst: number | undefined;
    for (const level of levels) {
      if (remaining <= 0) break;
      const available = implied ? level.implied : level.direct;
      if (available <= 0) continue;
      const take = Math.min(available, remaining);
      notional += take * level.price;
      remaining -= take;
      worst = level.price;
    }
    return remaining > 0 ? { size } : { size, average: notional / size, worst };
  });
}
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
function useRowCapacity(enabled: boolean) {
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
  }, [enabled]);
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
 * size. When only implied liquidity is present, depth bars show that ladder instead.
 */
export function OrderBook({ feed, status, onRequestQuote, onOpenMakerQuotes }: {
  feed: MarketFeed;
  status?: PublicFeedStatus | null;
  onRequestQuote?: () => void;
  onOpenMakerQuotes?: () => void;
}) {
  const { unit, precision } = feed.book ?? feed.seriesMeta("basis");
  const [view, setView] = usePersistedSetting<BookView>("book.view", "book", ["book", "trades", "ladder"]);
  const [sideFilter, setSideFilter] = usePersistedSetting<BookSide>("book.side", "both", ["both", "bids", "asks"]);
  const book = useMemo(() => feed.depth(), [feed]);
  const impliedOnly = ![...book.bids, ...book.asks].some(level => level.direct > 0);
  const depthKind = impliedOnly ? "Implied" : "Direct";
  const sizeUnit = feed.book?.quantityUnit ?? "units";
  const quantity = (value: number) => value > 0 && value < 0.000001 ? "<0.000001"
    : value.toLocaleString("en-US", { maximumFractionDigits: 6 });
  const fixture = feed.label === "FIXTURE";
  const noBook = feed.label === "REFERENCE" || feed.label === "UNAVAILABLE";
  const trades = useMemo(() => feed.tape(), [feed]);
  const emptyView = view === "trades" ? trades.length === 0 : book.bids.length + book.asks.length === 0;
  const stale = status?.state === "stale";
  const halted = status?.halted === true;
  const connecting = status?.state === "connecting";
  const unavailable = noBook || status?.state === "unavailable";
  const emptyTitle = connecting ? "Loading package quotes" : halted ? "Market paused"
    : unavailable ? "Package book unavailable" : view === "trades" ? "No trades yet" : "No resting quotes";
  const emptyDetail = connecting ? "Reading the latest published depth."
    : halted ? "This market is not accepting orders."
      : unavailable ? "Package depth could not be loaded. Check available routes for this strategy."
        : view === "trades" ? "Completed package trades will appear here."
          : "Request a quote for this strategy. Published orders appear here when available.";
  const steps = [book.tick, book.tick * 2, book.tick * 10];
  const [step, setStep] = useState(book.tick);
  const { ref: bodyRef, height: bodyHeight } = useRowCapacity(!emptyView && view === "book");
  const available = Math.max(0, bodyHeight - SPREAD_HEIGHT);
  const rowsPerSide = bodyHeight === 0 ? 12 : Math.max(3, Math.floor((sideFilter === "both" ? available / 2 : available) / ROW_HEIGHT));

  const { bids, asks, spread, mid, bidShare } = useMemo(() => {
    const bidLevels = grouped(book.bids, step, "bid");
    const askLevels = grouped(book.asks, step, "ask");
    const cumulative = (levels: DepthLevel[]) => {
      let running = 0;
      return levels.map((level) => {
        running += impliedOnly ? level.implied : level.direct;
        return { ...level, cumulative: running };
      });
    };
    const withBids = cumulative(bidLevels);
    const withAsks = cumulative(askLevels);
    const bestBid = book.bids.find((level) => level.direct > 0 || level.implied > 0)?.price;
    const bestAsk = book.asks.find((level) => level.direct > 0 || level.implied > 0)?.price;
    const bidTotal = withBids.at(-1)?.cumulative ?? 0;
    const askTotal = withAsks.at(-1)?.cumulative ?? 0;
    return {
      bids: withBids,
      asks: withAsks,
      spread: bestBid === undefined || bestAsk === undefined ? undefined : bestAsk - bestBid,
      mid: bestBid === undefined || bestAsk === undefined ? undefined : (bestAsk + bestBid) / 2,
      bidShare: bidTotal + askTotal === 0 ? null : (bidTotal / (bidTotal + askTotal)) * 100,
    };
  }, [book, step, impliedOnly]);

  // Bars scale to the deepest visible cumulative level so the shown ladder uses the full width.
  const visibleMax = Math.max(Number.EPSILON, bids[Math.min(rowsPerSide, bids.length) - 1]?.cumulative ?? 0, asks[Math.min(rowsPerSide, asks.length) - 1]?.cumulative ?? 0);
  const row = (level: DepthLevel & { cumulative: number }, side: "bid" | "ask") => (
    <div key={`${side}-${level.price}`} className={styles.bookRow} role="row">
      <span
        className={side === "bid" ? styles.depthBarBid : styles.depthBarAsk}
        style={{ width: `${Math.min(100, (level.cumulative / visibleMax) * 100)}%` }}
        aria-hidden="true"
      />
      <span role="cell" className={side === "bid" ? styles.up : styles.down}>{level.price.toFixed(precision)}</span>
      <span role="cell">{level.direct > 0 ? quantity(level.direct) : <span className={styles.dimCell}>-</span>}</span>
      <span role="cell" className={styles.impliedCell}>{level.implied > 0 ? quantity(level.implied) : <span className={styles.dimCell}>-</span>}</span>
      <span role="cell">{quantity(level.cumulative)}</span>
    </div>
  );

  return (
    <section className={styles.bookPanel} aria-label="Order book and trades">
      <div className={styles.panelTabs} role="tablist" aria-label="Book view" onKeyDown={handleTablistKeys}>
        <button type="button" role="tab" aria-selected={view === "book"} className={view === "book" ? styles.tabActive : undefined} onClick={() => setView("book")} title="Order book">Book</button>
        <button type="button" role="tab" aria-selected={view === "trades"} className={view === "trades" ? styles.tabActive : undefined} onClick={() => setView("trades")}>Trades</button>
        <button type="button" role="tab" aria-selected={view === "ladder"} className={view === "ladder" ? styles.tabActive : undefined} onClick={() => setView("ladder")}>Ladder</button>
        {/* Depth from the public API is executable package book depth; trades are observed; a fixture is
            neither, and reference history has no package book at all. */}
        <span
          className={`${fixture ? styles.labelFixture : unavailable || emptyView || stale || halted ? styles.labelUnavailable : styles.labelObserved} ${styles.tabTag}`}
          title={fixture
            ? "Deterministic fixture levels for layout; not resting orders"
            : status?.detail ?? feed.sourceNote}
        >
          {fixture ? "FIXTURE" : connecting ? "LOADING" : halted ? "PAUSED" : stale ? "STALE" : unavailable ? "UNAVAILABLE" : emptyView ? view === "trades" ? "NO TRADES" : "NO DEPTH" : view === "trades" ? "OBSERVED" : "EXECUTABLE"}
        </span>
      </div>
      {emptyView ? (
        <div className={bookStyles.empty} role="status">
          <svg className={bookStyles.emptyIcon} viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M5 8h14M5 16h9M5 24h17M24 8h3M19 16h8M26 24h1" />
          </svg>
          <strong>{emptyTitle}</strong>
          <p>{emptyDetail}</p>
          {!connecting && !halted && view !== "trades" && onRequestQuote !== undefined
            ? <button type="button" onClick={onRequestQuote}>Request quote</button> : null}
          {view !== "trades" && onOpenMakerQuotes !== undefined
            ? <button type="button" onClick={onOpenMakerQuotes}>View SOL cash-and-carry quotes</button> : null}
        </div>
      ) : view === "book" ? (
        <div key="book" className={styles.viewFade}>
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
            <span className={styles.dimCell}>Size ({sizeUnit})</span>
            <label className={styles.stepSelect}>
              <span className={styles.visuallyHidden}>Price grouping</span>
              <select value={step} onChange={(event) => setStep(Number(event.target.value))}>
                {steps.map((value) => <option key={value} value={value}>{value.toFixed(precision)}</option>)}
              </select>
            </label>
          </div>
          <div className={styles.bookHeader} role="row">
            <span role="columnheader">Price ({unit})</span>
            <span role="columnheader" title={fixture ? "Fixture levels, not resting orders" : "Resting signed package orders"}>Direct</span>
            <span role="columnheader" title="Derived from leg sources; never merged into direct size">Implied</span>
            <span role="columnheader" title={`Cumulative ${depthKind.toLowerCase()} size; direct and implied quantities remain separate`}>Cum. {depthKind.toLowerCase()}</span>
          </div>
          <div ref={bodyRef} className={styles.bookBody} role="table" aria-label="Package depth">
            {sideFilter !== "bids" ? (
              <div className={sideFilter === "asks" ? styles.bookSideFull : styles.bookAsks}>
                {(sideFilter === "asks" ? asks.slice(0, rowsPerSide) : asks.slice(0, rowsPerSide).reverse()).map((level) => row(level, "ask"))}
              </div>
            ) : null}
            <div className={styles.spreadRow} role="row">
              <strong role="cell" title="Mid of best published bid and ask">{mid === undefined ? "-" : mid.toFixed(Number.isInteger(mid * 10 ** precision) ? precision : precision + 1)}</strong>
              <span role="cell">Spread</span>
              <span role="cell">{spread === undefined ? "-" : `${spread.toFixed(precision)} ${unit}`}</span>
            </div>
            {sideFilter !== "asks" ? (
              <div className={sideFilter === "bids" ? styles.bookSideFull : styles.bookBids}>
                {bids.slice(0, rowsPerSide).map((level) => row(level, "bid"))}
              </div>
            ) : null}
          </div>
          {bidShare === null ? (
            <div className={styles.ratioBar} aria-label="Published depth unavailable">
              <span className={styles.dimCell}>No published depth</span>
            </div>
          ) : (
            <div className={styles.ratioBar} aria-label={`${depthKind} depth ${bidShare.toFixed(0)} percent bids`}>
              <span className={styles.up}>B {bidShare.toFixed(0)}%</span>
              <div className={styles.ratioTrack}>
                <i className={styles.ratioBid} style={{ width: `${bidShare}%` }} />
                <i className={styles.ratioAsk} style={{ width: `${100 - bidShare}%` }} />
              </div>
              <span className={styles.down}>{(100 - bidShare).toFixed(0)}% S</span>
            </div>
          )}
        </div>
      ) : view === "ladder" ? (
        <div key="ladder" className={styles.viewFade}>
          <SizeLadder bids={book.bids} asks={book.asks} unit={unit} precision={precision} implied={impliedOnly} sizeUnit={sizeUnit} />
        </div>
      ) : (
        <div key="trades" className={styles.viewFade}>
          <TradeTape trades={trades} unit={unit} precision={precision} sizeUnit={sizeUnit} />
        </div>
      )}
    </section>
  );
}

function SizeLadder({ bids, asks, unit, precision, implied, sizeUnit }: { bids: readonly DepthLevel[]; asks: readonly DepthLevel[]; unit: string; precision: number; implied: boolean; sizeUnit: string }) {
  const rows = useMemo(() => {
    const sizes = [...new Set([bids, asks].flatMap(levels => {
      let total = 0;
      return levels.map(level => total += implied ? level.implied : level.direct);
    }))].filter(size => size > 0).sort((a, b) => a - b).slice(0, 6);
    const buys = sizeLadder([...asks].sort((left, right) => left.price - right.price), sizes, implied);
    const sells = sizeLadder([...bids].sort((left, right) => right.price - left.price), sizes, implied);
    return sizes.map((size, index) => ({ size, buy: buys[index], sell: sells[index] }));
  }, [bids, asks, implied]);
  const price = (value: number | undefined) => (value === undefined ? <span className={styles.dimCell}>Exceeds depth</span> : value.toFixed(precision + 1));
  return (
    <>
      <div className={styles.tapeHeader} role="row">
        <span role="columnheader">Size ({sizeUnit})</span>
        <span role="columnheader" title={`Average price in ${unit} to buy the size from the asks`}>Buy avg</span>
        <span role="columnheader" title="Average price to sell the size into the bids">Sell avg</span>
        <span role="columnheader" title="Buy average minus sell average">Spread</span>
      </div>
      <div className={styles.tapeBody} role="table" aria-label="Executable price at size">
        {rows.map((row) => (
          <div key={row.size} className={styles.tapeRow} role="row">
            <span role="cell">{row.size.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>
            <span role="cell" className={styles.down} title={row.buy?.worst === undefined ? undefined : `Worst level ${row.buy.worst.toFixed(precision)}`}>{price(row.buy?.average)}</span>
            <span role="cell" className={styles.up} title={row.sell?.worst === undefined ? undefined : `Worst level ${row.sell.worst.toFixed(precision)}`}>{price(row.sell?.average)}</span>
            <span role="cell" className={styles.dimCell}>
              {row.buy?.average === undefined || row.sell?.average === undefined ? "-" : (row.buy.average - row.sell.average).toFixed(precision + 1)}
            </span>
          </div>
        ))}
      </div>
      <p className={styles.ladderNote}>Estimated from {implied ? "implied" : "direct"} depth. Direct and implied liquidity are not added together. Execution is rechecked when you request a quote.</p>
    </>
  );
}

function TradeTape({ trades, unit, precision, sizeUnit }: { trades: readonly TapeTrade[]; unit: string; precision: number; sizeUnit: string }) {
  return (
    <>
      <div className={styles.tapeHeader} role="row">
        <span role="columnheader">Price ({unit})</span>
        <span role="columnheader">Size ({sizeUnit})</span>
        <span role="columnheader">Source</span>
        <span role="columnheader">Time</span>
      </div>
      <div className={styles.tapeBody} role="table" aria-label="Recent package trades">
        {trades.map((trade) => (
          <div key={trade.id} className={styles.tapeRow} role="row">
            <span role="cell" className={trade.side === "BID" ? styles.up : styles.down}>{trade.price.toFixed(precision)}</span>
            <span role="cell">{trade.size.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>
            <span role="cell" className={trade.source === "IMPLIED" ? styles.impliedCell : styles.dimCell}>{trade.source === "IMPLIED" ? "Implied" : "Direct"}</span>
            <span role="cell" className={styles.dimCell}>{time(trade.time)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
