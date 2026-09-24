"use client";

import { useMemo, useState } from "react";
import type {
  BasisPoint,
  DomainId,
  PackageLeg,
  PackageMode,
  TerminalViewModel,
  WorkspaceTab,
} from "./terminal-view-model";
import styles from "./trading-terminal.module.css";

const SLIPPAGE_OPTIONS = [5, 10, 25];

function formatCurrency(value: number) {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function sanitizeSize(value: string) {
  const cleaned = value.replace(/[^0-9.]/g, "");
  const [whole, ...decimals] = cleaned.split(".");
  return decimals.length > 0 ? `${whole}.${decimals.join("")}` : whole;
}

function pointsFor(
  points: BasisPoint[],
  key: "spot" | "perp",
  minimum: number,
  range: number,
) {
  return points
    .map((point, index) => {
      const x = 36 + (index / (points.length - 1)) * 648;
      const y = 190 - ((point[key] - minimum) / range) * 140;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function BrandMark() {
  return (
    <span className={styles.brandMark} aria-hidden="true">
      <svg viewBox="0 0 28 28" fill="none">
        <path d="M5 21V7h4.2l9.6 13V7H23v14h-4.2L9.2 8v13H5Z" />
        <path d="M5 24h18" />
      </svg>
    </span>
  );
}

function TopNavigation({
  snapshot,
  selectedDomain,
  onDomainChange,
}: {
  snapshot: TerminalViewModel;
  selectedDomain: DomainId;
  onDomainChange: (domain: DomainId) => void;
}) {
  return (
    <header className={styles.topNavigation}>
      <div className={styles.brand}>
        <BrandMark />
        <div>
          <strong>Naryx</strong>
          <span>Private terminal</span>
        </div>
      </div>

      <div
        className={styles.environmentBadge}
        title={`${snapshot.environment.title}. ${snapshot.environment.detail}`}
      >
        <span className={styles.statusDot} />
        <span>{snapshot.environment.label}</span>
        <small>{snapshot.environment.capturedAt}</small>
      </div>

      <nav className={styles.domainSelector} aria-label="Execution domain preview">
        {snapshot.domains.map((domain) => (
          <button
            key={domain.id}
            type="button"
            className={
              selectedDomain === domain.id ? styles.domainActive : undefined
            }
            aria-pressed={selectedDomain === domain.id}
            title={`${domain.runtime}. ${domain.state} data.`}
            onClick={() => onDomainChange(domain.id)}
          >
            {domain.label}
          </button>
        ))}
      </nav>

      <div className={styles.sessionStatus}>
        <span className={styles.offlineDot} />
        <div>
          <span>Wallet offline</span>
          <small>No signing session</small>
        </div>
      </div>
    </header>
  );
}

function MarketHeader({ snapshot }: { snapshot: TerminalViewModel }) {
  return (
    <section className={styles.marketHeader} aria-label="Package market overview">
      <div className={styles.marketIdentity}>
        <div className={styles.assetMark}>{snapshot.market.base.slice(0, 1)}</div>
        <div>
          <div className={styles.pairLine}>
            <h1>
              {snapshot.market.base}
              <span>/</span>
              {snapshot.market.quote}
            </h1>
            <span className={styles.packageTag}>Package</span>
          </div>
          <p>
            {snapshot.market.strategy} <span>{snapshot.market.packageId}</span>
          </p>
        </div>
      </div>

      <div className={styles.metricsRail}>
        {snapshot.market.metrics.map((metric) => (
          <div className={styles.metric} key={metric.label}>
            <span>{metric.label}</span>
            <strong className={metric.accent ? styles.accentValue : undefined}>
              {metric.value}
            </strong>
            {metric.detail ? <small>{metric.detail}</small> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function BasisChart({ snapshot }: { snapshot: TerminalViewModel }) {
  const values = snapshot.chart.points.flatMap((point) => [point.spot, point.perp]);
  const minimum = Math.min(...values) - 0.12;
  const maximum = Math.max(...values) + 0.12;
  const range = maximum - minimum;
  const spotPoints = pointsFor(snapshot.chart.points, "spot", minimum, range);
  const perpPoints = pointsFor(snapshot.chart.points, "perp", minimum, range);
  const areaPoints = `${spotPoints} ${perpPoints.split(" ").reverse().join(" ")}`;

  return (
    <section className={styles.panel} aria-labelledby="basis-chart-title">
      <div className={styles.panelHeader}>
        <div>
          <div className={styles.eyebrow}>Spread monitor</div>
          <h2 id="basis-chart-title">{snapshot.chart.title}</h2>
          <p>{snapshot.chart.subtitle}</p>
        </div>
        <div className={styles.chartLegend} aria-label="Chart legend">
          <span>
            <i className={styles.spotKey} /> Spot
          </span>
          <span>
            <i className={styles.perpKey} /> Perpetual
          </span>
          <span className={styles.timeframe}>1H</span>
        </div>
      </div>

      <div className={styles.chartFrame}>
        <svg
          className={styles.chart}
          viewBox="0 0 720 220"
          role="img"
          aria-labelledby="chart-title chart-description"
        >
          <title id="chart-title">Spot and perpetual reference prices</title>
          <desc id="chart-description">
            Deterministic conformance prices with the perpetual above spot across the
            captured window.
          </desc>
          {[50, 96.7, 143.3, 190].map((y) => (
            <line
              className={styles.gridLine}
              key={y}
              x1="36"
              x2="684"
              y1={y}
              y2={y}
            />
          ))}
          <polygon className={styles.basisArea} points={areaPoints} />
          <polyline className={styles.spotLine} points={spotPoints} />
          <polyline className={styles.perpLine} points={perpPoints} />
          <circle className={styles.spotPoint} cx="684" cy={spotPoints.split(" ").at(-1)?.split(",")[1]} r="4" />
          <circle className={styles.perpPoint} cx="684" cy={perpPoints.split(" ").at(-1)?.split(",")[1]} r="4" />
          <text className={styles.axisLabel} x="36" y="211">
            {snapshot.chart.points.at(0)?.label}
          </text>
          <text className={styles.axisLabel} x="684" y="211" textAnchor="end">
            {snapshot.chart.points.at(-1)?.label}
          </text>
          <text className={styles.axisLabel} x="36" y="39">
            {formatCurrency(maximum)}
          </text>
          <text className={styles.axisLabel} x="36" y="185">
            {formatCurrency(minimum)}
          </text>
        </svg>

        <div className={styles.basisStrip} aria-label="Basis in basis points">
          <div className={styles.basisStripLabel}>
            <span>Basis profile</span>
            <strong>{snapshot.chart.points.at(-1)?.basisBps.toFixed(1)} bps</strong>
          </div>
          <div className={styles.basisBars}>
            {snapshot.chart.points.map((point) => (
              <span
                key={point.label}
                title={`${point.label}: ${point.basisBps.toFixed(1)} bps`}
                style={{ height: `${Math.max(24, point.basisBps)}%` }}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function LegCard({ leg }: { leg: PackageLeg }) {
  return (
    <article className={styles.legCard}>
      <div className={styles.legTopline}>
        <span className={styles.legSequence}>0{leg.sequence}</span>
        <span className={styles.legState}>{leg.state}</span>
      </div>
      <div className={styles.legTitle}>
        <div>
          <span>{leg.action}</span>
          <h3>{leg.instrument}</h3>
        </div>
        <strong>{leg.quantity}</strong>
      </div>
      <p className={styles.legVenue}>{leg.venue}</p>
      <div className={styles.legDetails}>
        <div>
          <span>{leg.limitLabel}</span>
          <strong>{leg.limit}</strong>
        </div>
        <div>
          <span>Dependency</span>
          <strong>{leg.dependency}</strong>
        </div>
      </div>
    </article>
  );
}

function PackageSequence({
  snapshot,
  mode,
}: {
  snapshot: TerminalViewModel;
  mode: PackageMode;
}) {
  const plan = snapshot.plans.find((item) => item.mode === mode) ?? snapshot.plans[0];

  return (
    <section className={`${styles.panel} ${styles.sequencePanel}`} aria-labelledby="sequence-title">
      <div className={styles.panelHeader}>
        <div>
          <div className={styles.eyebrow}>Isolated package plan</div>
          <h2 id="sequence-title">{plan.label}</h2>
          <p>{plan.description}</p>
        </div>
        <span className={styles.sequencePolicy}>Fail closed</span>
      </div>
      <div className={styles.legs}>
        <LegCard leg={plan.legs[0]} />
        <div className={styles.dependencyConnector} aria-hidden="true">
          <span />
          <b>then</b>
          <span />
        </div>
        <LegCard leg={plan.legs[1]} />
      </div>
    </section>
  );
}

function Ticket({
  snapshot,
  mode,
  onModeChange,
}: {
  snapshot: TerminalViewModel;
  mode: PackageMode;
  onModeChange: (mode: PackageMode) => void;
}) {
  const [size, setSize] = useState(snapshot.ticket.defaultSize);
  const [slippage, setSlippage] = useState(snapshot.ticket.defaultSlippageBps);
  const [quoteMode, setQuoteMode] = useState(snapshot.ticket.quoteModes[0]);
  const units = Number.parseFloat(size) || 0;
  const boundary =
    units *
    (mode === "entry"
      ? snapshot.ticket.entryQuotePerUnit
      : snapshot.ticket.exitOutputPerUnit);
  const feeTotal =
    units > 0
      ? snapshot.ticket.feeRows.reduce(
          (total, row) => total + row.ratePerUnit * units,
          snapshot.ticket.networkFee,
        )
      : 0;

  return (
    <aside className={`${styles.panel} ${styles.ticket}`} aria-labelledby="ticket-title">
      <div className={styles.ticketHeader}>
        <div>
          <div className={styles.eyebrow}>Package ticket</div>
          <h2 id="ticket-title">Prepare route</h2>
        </div>
        <span className={styles.previewPill}>Preview</span>
      </div>

      <div className={styles.modeSwitch} aria-label="Package mode">
        {(["entry", "exit"] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={mode === item ? styles.modeActive : undefined}
            aria-pressed={mode === item}
            onClick={() => onModeChange(item)}
          >
            {item === "entry" ? "Entry" : "Exit"}
          </button>
        ))}
      </div>

      <label className={styles.fieldLabel} htmlFor="package-size">
        <span>Package size</span>
        <small>Fixture reference: {snapshot.ticket.defaultSize} SOL</small>
      </label>
      <div className={styles.amountInput}>
        <input
          id="package-size"
          inputMode="decimal"
          autoComplete="off"
          value={size}
          onChange={(event) => setSize(sanitizeSize(event.target.value))}
          aria-describedby="size-context"
        />
        <span>{snapshot.ticket.sizeSymbol}</span>
      </div>
      <p id="size-context" className={styles.fieldContext}>
        Conformance calculation only. No balance has been loaded.
      </p>

      <div className={styles.boundaryRow}>
        <span>{mode === "entry" ? "Maximum quote" : "Minimum output"}</span>
        <div>
          <strong>{formatCurrency(boundary)}</strong>
          <small>USDC fixture estimate</small>
        </div>
      </div>

      <div className={styles.ticketField}>
        <span>Slippage</span>
        <div className={styles.segmentedControl}>
          {SLIPPAGE_OPTIONS.map((option) => (
            <button
              type="button"
              key={option}
              className={slippage === option ? styles.segmentActive : undefined}
              aria-pressed={slippage === option}
              onClick={() => setSlippage(option)}
            >
              {option} bps
            </button>
          ))}
        </div>
      </div>

      <label className={styles.ticketField} htmlFor="quote-mode">
        <span>Quote mode</span>
        <select
          id="quote-mode"
          value={quoteMode}
          onChange={(event) => setQuoteMode(event.target.value)}
        >
          {snapshot.ticket.quoteModes.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>

      <section className={styles.evidenceBox} aria-labelledby="route-evidence-title">
        <div className={styles.evidenceHeading}>
          <h3 id="route-evidence-title">Route evidence</h3>
          <span>Unverified</span>
        </div>
        {snapshot.ticket.evidence.map((row) => (
          <div className={styles.summaryRow} key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </section>

      <section className={styles.feeSummary} aria-labelledby="fee-summary-title">
        <h3 id="fee-summary-title">Fee summary</h3>
        {snapshot.ticket.feeRows.map((row) => (
          <div className={styles.summaryRow} key={row.label}>
            <span>{row.label}</span>
            <strong>{formatCurrency(row.ratePerUnit * units)}</strong>
          </div>
        ))}
        <div className={styles.summaryRow}>
          <span>Estimated network fees</span>
          <strong>{formatCurrency(units > 0 ? snapshot.ticket.networkFee : 0)}</strong>
        </div>
        <div className={`${styles.summaryRow} ${styles.totalRow}`}>
          <span>Estimated total</span>
          <strong>{formatCurrency(feeTotal)}</strong>
        </div>
      </section>

      <div className={styles.actionArea}>
        <button
          className={styles.primaryAction}
          type="button"
          disabled={!snapshot.environment.executionEnabled}
          aria-describedby="execution-note"
        >
          Execution unavailable
        </button>
        <p id="execution-note">
          Configure an executable private route and signing session before submission.
        </p>
      </div>
    </aside>
  );
}

function BottomWorkspace({ snapshot }: { snapshot: TerminalViewModel }) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("positions");
  const activeWorkspace =
    snapshot.workspaces.find((workspace) => workspace.tab === activeTab) ??
    snapshot.workspaces[0];

  return (
    <section className={`${styles.panel} ${styles.bottomWorkspace}`} aria-label="Trading workspace">
      <div className={styles.workspaceTabs} role="tablist" aria-label="Account data">
        {snapshot.workspaces.map((workspace) => (
          <button
            id={`tab-${workspace.tab}`}
            key={workspace.tab}
            type="button"
            role="tab"
            aria-selected={activeTab === workspace.tab}
            aria-controls={`panel-${workspace.tab}`}
            className={activeTab === workspace.tab ? styles.workspaceTabActive : undefined}
            onClick={() => setActiveTab(workspace.tab)}
          >
            {workspace.label}
            {workspace.count !== undefined ? <span>{workspace.count}</span> : null}
          </button>
        ))}
        <div className={styles.workspaceStatus}>
          <span className={styles.offlineDot} /> Provider disconnected
        </div>
      </div>

      <div
        id={`panel-${activeWorkspace.tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${activeWorkspace.tab}`}
        className={styles.tableScroller}
      >
        <table className={styles.workspaceTable}>
          <thead>
            <tr>
              {activeWorkspace.columns.map((column) => (
                <th
                  key={column.label}
                  className={column.numeric ? styles.numericColumn : undefined}
                  scope="col"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={activeWorkspace.columns.length}>
                <div className={styles.emptyState}>
                  <span className={styles.emptyGlyph} aria-hidden="true" />
                  <div>
                    <strong>{activeWorkspace.emptyTitle}</strong>
                    <p>{activeWorkspace.emptyDetail}</p>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function TradingTerminal({ snapshot }: { snapshot: TerminalViewModel }) {
  const [selectedDomain, setSelectedDomain] = useState(snapshot.selectedDomain);
  const [mode, setMode] = useState<PackageMode>("entry");
  const selectedDomainModel = useMemo(
    () => snapshot.domains.find((domain) => domain.id === selectedDomain),
    [selectedDomain, snapshot.domains],
  );

  return (
    <main className={styles.terminalShell}>
      <TopNavigation
        snapshot={snapshot}
        selectedDomain={selectedDomain}
        onDomainChange={setSelectedDomain}
      />
      <div className={styles.domainContext} role="status">
        <span>{selectedDomainModel?.label}</span>
        <span>{selectedDomainModel?.runtime}</span>
        <span>{selectedDomainModel?.state} data only</span>
      </div>
      <MarketHeader snapshot={snapshot} />
      <div className={styles.contentGrid}>
        <div className={styles.marketWorkspace}>
          <BasisChart snapshot={snapshot} />
          <PackageSequence snapshot={snapshot} mode={mode} />
        </div>
        <Ticket snapshot={snapshot} mode={mode} onModeChange={setMode} />
      </div>
      <BottomWorkspace snapshot={snapshot} />
    </main>
  );
}
