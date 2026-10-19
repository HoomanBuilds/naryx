"use client";

import styles from "./pro.module.css";

export type ChartCursorMode = "pointer" | "crosshair";

export function ChartTools({
  ready,
  hasData,
  cursor,
  markerActive,
  onCursorChange,
  onMarkerToggle,
  onZoom,
  onFit,
  onLatest,
}: {
  ready: boolean;
  hasData: boolean;
  cursor: ChartCursorMode;
  markerActive: boolean;
  onCursorChange(mode: ChartCursorMode): void;
  onMarkerToggle(): void;
  onZoom(factor: number): void;
  onFit(): void;
  onLatest(): void;
}) {
  return (
    <div className={styles.chartTools} role="toolbar" aria-label="Chart drawing and navigation tools" aria-orientation="vertical">
      <button type="button" title="Pointer" aria-label="Pointer" aria-pressed={cursor === "pointer"} disabled={!ready} onClick={() => onCursorChange("pointer")}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 3 11 8-5 1-2 5Z" /></svg>
      </button>
      <button type="button" title="Crosshair" aria-label="Crosshair" aria-pressed={cursor === "crosshair"} disabled={!ready} onClick={() => onCursorChange("crosshair")}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v5m0 6v5M2 10h5m6 0h5" /><circle cx="10" cy="10" r="2" /></svg>
      </button>
      <button type="button" title="Horizontal price marker" aria-label="Horizontal price marker" aria-pressed={markerActive} disabled={!ready || !hasData} onClick={onMarkerToggle}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10h16" /><circle cx="7" cy="10" r="2" /></svg>
      </button>
      <span className={styles.toolDivider} aria-hidden="true" />
      <button type="button" title="Zoom in" aria-label="Zoom in" disabled={!ready || !hasData} onClick={() => onZoom(1.3)}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4M6 8.5h5m-2.5-2.5v5" /></svg>
      </button>
      <button type="button" title="Zoom out" aria-label="Zoom out" disabled={!ready || !hasData} onClick={() => onZoom(1 / 1.3)}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4M6 8.5h5" /></svg>
      </button>
      <button type="button" title="Fit all bars and reset price scale" aria-label="Fit all bars" disabled={!ready || !hasData} onClick={onFit}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 7V3h4m6 0h4v4M3 13v4h4m6 0h4v-4M7 10h6m-3-3v6" /></svg>
      </button>
      <button type="button" title="Scroll to latest" aria-label="Scroll to latest" disabled={!ready || !hasData} onClick={onLatest}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 5 5 5-5 5m6-10 5 5-5 5m7-11v12" /></svg>
      </button>
    </div>
  );
}
