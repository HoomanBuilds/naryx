"use client";

import { useState, useSyncExternalStore } from "react";
import { NaryxClient, type CandlePage } from "@naryx/sdk";
import type { PublicPackageOpportunity } from "../public-market-feed";
import styles from "./pages.module.css";

const STORAGE_KEY = "naryx.terminal.paper-positions.v1";
const STORAGE_EVENT = "naryx-paper-positions";
const EMPTY: readonly PaperPosition[] = Object.freeze([]);
let memoryPositions: string | null = null;
let cachedValue: string | null | undefined;
let cachedPositions: readonly PaperPosition[] = EMPTY;

type Direction = "LONG" | "SHORT";

type PaperPosition = Readonly<{
  id: string;
  packageMarketId: string;
  seriesId: string | null;
  direction: Direction;
  quantity: bigint;
  entryPriceTicks: bigint;
  openedAtMs: number;
  exitPriceTicks: bigint | null;
  closedAtMs: number | null;
}>;

type Replay = Readonly<{
  packageMarketId: string;
  direction: Direction;
  entryTicks: bigint;
  exitTicks: bigint;
  outcomeTicks: bigint;
  bestExcursionTicks: bigint;
  worstExcursionTicks: bigint;
  volume: bigint;
  candles: number;
  fromMs: number;
  toMs: number;
  truncated: boolean;
}>;

function storedValue(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? memoryPositions;
  } catch {
    return memoryPositions;
  }
}

function parsePosition(value: unknown): PaperPosition | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.packageMarketId !== "string") return null;
  if (item.seriesId !== null && typeof item.seriesId !== "string") return null;
  if (item.direction !== "LONG" && item.direction !== "SHORT") return null;
  if (typeof item.quantity !== "string" || !/^[1-9][0-9]*$/.test(item.quantity)) return null;
  if (typeof item.entryPriceTicks !== "string" || !/^-?[0-9]+$/.test(item.entryPriceTicks)) return null;
  if (item.exitPriceTicks !== null && (typeof item.exitPriceTicks !== "string" || !/^-?[0-9]+$/.test(item.exitPriceTicks))) return null;
  if (typeof item.openedAtMs !== "number" || !Number.isSafeInteger(item.openedAtMs) || item.openedAtMs < 0) return null;
  if (item.closedAtMs !== null && (typeof item.closedAtMs !== "number" || !Number.isSafeInteger(item.closedAtMs) || item.closedAtMs < item.openedAtMs)) return null;
  return Object.freeze({
    id: item.id,
    packageMarketId: item.packageMarketId,
    seriesId: item.seriesId,
    direction: item.direction,
    quantity: BigInt(item.quantity),
    entryPriceTicks: BigInt(item.entryPriceTicks),
    openedAtMs: item.openedAtMs,
    exitPriceTicks: item.exitPriceTicks === null ? null : BigInt(item.exitPriceTicks),
    closedAtMs: item.closedAtMs,
  });
}

function positionsSnapshot(): readonly PaperPosition[] {
  const value = storedValue();
  if (value === cachedValue) return cachedPositions;
  cachedValue = value;
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    cachedPositions = Array.isArray(parsed)
      ? Object.freeze(parsed.map(parsePosition).filter((position): position is PaperPosition => position !== null).slice(0, 100))
      : EMPTY;
  } catch {
    cachedPositions = EMPTY;
  }
  return cachedPositions;
}

function subscribePositions(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(STORAGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(STORAGE_EVENT, callback);
  };
}

function writePositions(positions: readonly PaperPosition[]) {
  const encoded = JSON.stringify(positions.slice(0, 100).map((position) => ({
    ...position,
    quantity: position.quantity.toString(),
    entryPriceTicks: position.entryPriceTicks.toString(),
    exitPriceTicks: position.exitPriceTicks?.toString() ?? null,
  })));
  memoryPositions = encoded;
  cachedValue = undefined;
  try {
    window.localStorage.setItem(STORAGE_KEY, encoded);
  } catch {
    // The current page still retains paper positions when browser storage is unavailable.
  }
  window.dispatchEvent(new Event(STORAGE_EVENT));
}

function markFor(position: PaperPosition, opportunity: PublicPackageOpportunity | undefined, scanSize: bigint): bigint | null {
  if (opportunity === undefined || position.quantity !== scanSize) return null;
  return position.direction === "LONG" ? opportunity.bid?.averagePriceTicks ?? null : opportunity.ask?.averagePriceTicks ?? null;
}

function outcome(position: PaperPosition, mark: bigint | null): bigint | null {
  const exit = position.exitPriceTicks ?? mark;
  if (exit === null) return null;
  const movement = position.direction === "LONG" ? exit - position.entryPriceTicks : position.entryPriceTicks - exit;
  return movement * position.quantity;
}

function replay(candles: CandlePage, direction: Direction): Replay | null {
  const first = candles.candles[0];
  const last = candles.candles.at(-1);
  if (first === undefined || last === undefined) return null;
  const highs = candles.candles.map((candle) => candle.high);
  const lows = candles.candles.map((candle) => candle.low);
  const high = highs.reduce((current, value) => value > current ? value : current);
  const low = lows.reduce((current, value) => value < current ? value : current);
  const outcomeTicks = direction === "LONG" ? last.close - first.open : first.open - last.close;
  return Object.freeze({
    packageMarketId: candles.packageMarketId,
    direction,
    entryTicks: first.open,
    exitTicks: last.close,
    outcomeTicks,
    bestExcursionTicks: direction === "LONG" ? high - first.open : first.open - low,
    worstExcursionTicks: direction === "LONG" ? low - first.open : first.open - high,
    volume: candles.candles.reduce((sum, candle) => sum + candle.volume, BigInt(0)),
    candles: candles.candles.length,
    fromMs: candles.fromMs,
    toMs: candles.toMs,
    truncated: candles.truncated,
  });
}

export function PaperTradingLab({
  baseUrl,
  opportunities,
  scanSize,
}: {
  baseUrl: string | null;
  opportunities: readonly PublicPackageOpportunity[];
  scanSize: bigint;
}) {
  const positions = useSyncExternalStore(subscribePositions, positionsSnapshot, () => EMPTY);
  const [packageMarketId, setPackageMarketId] = useState("");
  const [direction, setDirection] = useState<Direction>("LONG");
  const [replayState, setReplayState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [replayResult, setReplayResult] = useState<Replay | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const selected = opportunities.find((opportunity) => opportunity.packageMarketId === packageMarketId) ?? opportunities[0] ?? null;
  const entry = direction === "LONG" ? selected?.ask ?? null : selected?.bid ?? null;

  const openPaperPosition = () => {
    if (selected === null || entry === null) return;
    const position: PaperPosition = Object.freeze({
      id: crypto.randomUUID(),
      packageMarketId: selected.packageMarketId,
      seriesId: selected.seriesId,
      direction,
      quantity: scanSize,
      entryPriceTicks: entry.averagePriceTicks,
      openedAtMs: Date.now(),
      exitPriceTicks: null,
      closedAtMs: null,
    });
    writePositions([position, ...positions]);
  };

  const closePaperPosition = (position: PaperPosition) => {
    const current = opportunities.find((opportunity) => opportunity.packageMarketId === position.packageMarketId);
    const mark = markFor(position, current, scanSize);
    if (mark === null) return;
    writePositions(positions.map((candidate) => candidate.id === position.id
      ? Object.freeze({ ...candidate, exitPriceTicks: mark, closedAtMs: Date.now() })
      : candidate));
  };

  const loadReplay = async () => {
    if (baseUrl === null || selected === null) return;
    setReplayState("loading");
    setReplayError(null);
    try {
      const now = Date.now();
      const candles = await new NaryxClient({ baseUrl }).getCandles(selected.packageMarketId, {
        interval: "1h",
        fromMs: now - 7 * 24 * 60 * 60 * 1000,
        toMs: now,
      });
      const result = replay(candles, direction);
      if (result === null) throw new Error("No observed package trades exist in this seven-day window.");
      setReplayResult(result);
      setReplayState("success");
    } catch (error) {
      setReplayResult(null);
      setReplayError(error instanceof Error ? error.message : "Replay request failed.");
      setReplayState("error");
    }
  };

  return (
    <section className={styles.card} aria-labelledby="paper-trading-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="paper-trading-title">Paper strategy desk</h2>
          <p>Practice against executable package snapshots and replay observed package history without signing or sending a transaction.</p>
        </div>
        <span className={styles.pillWarn}>Simulation only</span>
      </div>
      <div className={`${styles.cardBody} ${styles.paperControls}`}>
        <label className={styles.field}>
          <span>Package market</span>
          <select value={selected?.packageMarketId ?? ""} onChange={(event) => setPackageMarketId(event.target.value)} disabled={opportunities.length === 0}>
            {opportunities.map((opportunity) => <option key={opportunity.packageMarketId} value={opportunity.packageMarketId}>{opportunity.packageMarketId}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span>Direction</span>
          <select value={direction} onChange={(event) => setDirection(event.target.value as Direction)}>
            <option value="LONG">Long package</option>
            <option value="SHORT">Short package</option>
          </select>
        </label>
        <div className={styles.paperQuote}>
          <span>Executable entry snapshot</span>
          <strong>{entry?.averagePriceTicks.toString() ?? "No executable side"}</strong>
          <small>{scanSize.toString()} package units</small>
        </div>
        <button type="button" className={styles.primary} disabled={entry === null} onClick={openPaperPosition}>Open paper position</button>
        <button type="button" className={styles.ghost} disabled={baseUrl === null || selected === null || replayState === "loading"} onClick={() => void loadReplay()}>
          {replayState === "loading" ? "Loading observed history..." : "Replay last 7 days"}
        </button>
      </div>
      <div className={styles.evidenceBar}>
        <span className={styles.pill}>Evidence labels</span>
        <p>Paper entries and marks use executable snapshots at the selected size. Historical replay uses observed hourly candles and never claims a fill.</p>
      </div>
      {replayState === "error" ? <p className={styles.noticeError}>{replayError}</p> : null}
      {replayState === "success" && replayResult?.packageMarketId === selected?.packageMarketId && replayResult.direction === direction ? (
        <div className={styles.scenarioResults}>
          <div><span>Observed entry</span><strong>{replayResult.entryTicks.toString()} ticks</strong></div>
          <div><span>Observed exit</span><strong>{replayResult.exitTicks.toString()} ticks</strong></div>
          <div><span>Directional movement</span><strong>{replayResult.outcomeTicks.toString()} ticks</strong></div>
          <div><span>Observed volume</span><strong>{replayResult.volume.toString()}</strong></div>
          <div><span>Best excursion</span><strong>{replayResult.bestExcursionTicks.toString()} ticks</strong></div>
          <div><span>Worst excursion</span><strong>{replayResult.worstExcursionTicks.toString()} ticks</strong></div>
          <div><span>Observed candles</span><strong>{replayResult.candles}</strong></div>
          <div><span>Coverage</span><strong>{replayResult.truncated ? "Truncated" : "Complete window"}</strong></div>
        </div>
      ) : null}
      {positions.length === 0 ? (
        <div className={styles.empty}><strong>No paper positions</strong><p>Open one from a currently executable package side. Nothing is signed or submitted.</p></div>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead><tr><th>Package</th><th>Direction</th><th className={styles.num}>Size</th><th className={styles.num}>Entry</th><th className={styles.num}>Exit or mark</th><th className={styles.num}>Outcome</th><th>Status</th></tr></thead>
            <tbody>
              {positions.map((position) => {
                const current = opportunities.find((opportunity) => opportunity.packageMarketId === position.packageMarketId);
                const mark = markFor(position, current, scanSize);
                const value = outcome(position, mark);
                return (
                  <tr key={position.id}>
                    <td><span className={styles.cellStack}><strong className={styles.mono}>{position.packageMarketId}</strong><small className={styles.cellDetail}>{position.seriesId ?? "Series not published"}</small></span></td>
                    <td>{position.direction}</td>
                    <td className={styles.num}>{position.quantity.toString()}</td>
                    <td className={styles.num}>{position.entryPriceTicks.toString()}</td>
                    <td className={styles.num}>{(position.exitPriceTicks ?? mark)?.toString() ?? "Size not scanned"}</td>
                    <td className={styles.num}>{value === null ? "-" : `${value.toString()} tick units`}</td>
                    <td>{position.closedAtMs === null ? <button type="button" className={styles.ghost} disabled={mark === null} onClick={() => closePaperPosition(position)}>Close on snapshot</button> : <span className={styles.pill}>Closed</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
