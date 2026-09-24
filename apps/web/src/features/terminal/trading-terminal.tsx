"use client";

import { useEffect, useMemo, useState } from "react";
import { localConformanceTerminalProvider } from "./local-conformance-provider";
import { PrivateHttpTerminalProvider } from "./private-http-terminal-provider";
import type {
  BasisPoint,
  DomainId,
  PackageLeg,
  PackageMode,
  ProviderConnection,
  QuoteMode,
  SlippageBps,
  TerminalPreview,
  TerminalViewModel,
  WorkspaceTab,
} from "./terminal-view-model";
import styles from "./trading-terminal.module.css";

const SLIPPAGE_OPTIONS: readonly SlippageBps[] = [5, 10, 25];

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
  providerConnection,
  onDomainChange,
}: {
  snapshot: TerminalViewModel;
  selectedDomain: DomainId;
  providerConnection: ProviderConnection;
  onDomainChange: (domain: DomainId) => void;
}) {
  const providerLabel = providerConnection === "connected"
    ? "Private service connected"
    : providerConnection === "connecting"
      ? "Checking private service"
      : "Local fallback";

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
        title={`${snapshot.environment.title}. ${snapshot.environment.detail} Captured ${snapshot.environment.capturedAt}.`}
      >
        <span className={styles.statusDot} />
        <span>{snapshot.environment.label}</span>
        <small>{providerLabel}</small>
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
  preview,
}: {
  snapshot: TerminalViewModel;
  mode: PackageMode;
  preview: TerminalPreview | null;
}) {
  const plan = snapshot.plans.find((item) => item.mode === mode) ?? snapshot.plans[0];
  const legs = preview?.mode === mode ? preview.legs : plan.legs;

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
        <LegCard leg={legs[0]} />
        <div className={styles.dependencyConnector} aria-hidden="true">
          <span />
          <b>then</b>
          <span />
        </div>
        <LegCard leg={legs[1]} />
      </div>
    </section>
  );
}

function Ticket({
  snapshot,
  mode,
  preview,
  size,
  slippage,
  quoteMode,
  onModeChange,
  onSizeChange,
  onSlippageChange,
  onQuoteModeChange,
}: {
  snapshot: TerminalViewModel;
  mode: PackageMode;
  preview: TerminalPreview | null;
  size: string;
  slippage: SlippageBps;
  quoteMode: QuoteMode;
  onModeChange: (mode: PackageMode) => void;
  onSizeChange: (size: string) => void;
  onSlippageChange: (slippage: SlippageBps) => void;
  onQuoteModeChange: (quoteMode: QuoteMode) => void;
}) {
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
          onChange={(event) => onSizeChange(sanitizeSize(event.target.value))}
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
          <strong>{preview ? `$${preview.bound.value}` : "Unavailable"}</strong>
          <small>USDC conformance estimate</small>
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
              onClick={() => onSlippageChange(option)}
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
          onChange={(event) => onQuoteModeChange(event.target.value as QuoteMode)}
        >
          {snapshot.ticket.quoteModes.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
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
        {(preview?.fees ?? []).map((row) => (
          <div className={styles.summaryRow} key={row.label}>
            <span>{row.label}</span>
            <strong>${row.value}</strong>
          </div>
        ))}
        <div className={`${styles.summaryRow} ${styles.totalRow}`}>
          <span>Estimated total</span>
          <strong>{preview ? `$${preview.totalFee.value}` : "Unavailable"}</strong>
        </div>
      </section>

      <div className={styles.actionArea}>
        <button
          className={styles.primaryAction}
          type="button"
          disabled
          aria-describedby="execution-note"
        >
          Execution unavailable
        </button>
        <p id="execution-note">
          {preview?.action.reason ??
            "Enter a valid conformance size to prepare a preview."}
        </p>
      </div>
    </aside>
  );
}

function BottomWorkspace({
  snapshot,
  providerConnection,
}: {
  snapshot: TerminalViewModel;
  providerConnection: ProviderConnection;
}) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("positions");
  const activeWorkspace =
    snapshot.workspaces.find((workspace) => workspace.tab === activeTab) ??
    snapshot.workspaces[0];
  const providerLabel = providerConnection === "connected"
    ? "Provider connected"
    : providerConnection === "connecting"
      ? "Provider connecting"
      : "Provider disconnected";

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
          <span className={providerConnection === "connected" ? styles.statusDot : styles.offlineDot} />
          {providerLabel}
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

export function TradingTerminal({
  initialSnapshot,
  initialPreview,
  privateApiBaseUrl,
}: {
  initialSnapshot: TerminalViewModel;
  initialPreview: TerminalPreview;
  privateApiBaseUrl: string | null;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [preview, setPreview] = useState<TerminalPreview | null>(initialPreview);
  const [selectedDomain, setSelectedDomain] = useState(initialSnapshot.selectedDomain);
  const [mode, setMode] = useState<PackageMode>("entry");
  const [size, setSize] = useState(initialSnapshot.ticket.defaultSize);
  const [slippage, setSlippage] = useState<SlippageBps>(
    initialSnapshot.ticket.defaultSlippageBps,
  );
  const [quoteMode, setQuoteMode] = useState<QuoteMode>("coordinated_limits");
  const privateProvider = useMemo(() => {
    if (!privateApiBaseUrl) {
      return null;
    }
    try {
      return new PrivateHttpTerminalProvider(privateApiBaseUrl);
    } catch {
      return null;
    }
  }, [privateApiBaseUrl]);
  const [providerConnection, setProviderConnection] = useState<ProviderConnection>(
    privateProvider ? "connecting" : "disconnected",
  );

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function loadSnapshot() {
      if (!privateProvider) {
        const localSnapshot = await localConformanceTerminalProvider.getSnapshot(
          selectedDomain,
        );
        if (active) {
          setSnapshot(localSnapshot);
          setProviderConnection("disconnected");
        }
        return;
      }

      try {
        const serviceSnapshot = await privateProvider.getSnapshot(
          selectedDomain,
          controller.signal,
        );
        if (active) {
          setSnapshot(serviceSnapshot);
          setProviderConnection("connected");
        }
      } catch {
        if (controller.signal.aborted) {
          return;
        }
        const localSnapshot = await localConformanceTerminalProvider.getSnapshot(
          selectedDomain,
        );
        if (active) {
          setSnapshot(localSnapshot);
          setProviderConnection("disconnected");
        }
      }
    }

    void loadSnapshot();
    return () => {
      active = false;
      controller.abort();
    };
  }, [privateProvider, selectedDomain]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(async () => {
      const input = {
        domain: selectedDomain,
        mode,
        size,
        slippageBps: slippage,
        quoteMode,
      };
      try {
        const nextPreview = privateProvider
          ? await privateProvider.getPreview(input, controller.signal)
          : await localConformanceTerminalProvider.getPreview(input);
        if (active) {
          setPreview(nextPreview);
          if (privateProvider) {
            setProviderConnection("connected");
          }
        }
      } catch {
        if (controller.signal.aborted) {
          return;
        }
        try {
          const localPreview = await localConformanceTerminalProvider.getPreview(input);
          if (active) {
            setPreview(localPreview);
            setProviderConnection("disconnected");
          }
        } catch {
          if (active) {
            setPreview(null);
          }
        }
      }
    }, 200);

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [mode, privateProvider, quoteMode, selectedDomain, size, slippage]);

  const selectedDomainModel = useMemo(
    () => snapshot.domains.find((domain) => domain.id === selectedDomain),
    [selectedDomain, snapshot.domains],
  );

  return (
    <main className={styles.terminalShell}>
      <TopNavigation
        snapshot={snapshot}
        selectedDomain={selectedDomain}
        providerConnection={providerConnection}
        onDomainChange={(domain) => {
          setSelectedDomain(domain);
          if (privateProvider) {
            setProviderConnection("connecting");
          }
        }}
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
          <PackageSequence snapshot={snapshot} mode={mode} preview={preview} />
        </div>
        <Ticket
          snapshot={snapshot}
          mode={mode}
          preview={preview}
          size={size}
          slippage={slippage}
          quoteMode={quoteMode}
          onModeChange={setMode}
          onSizeChange={setSize}
          onSlippageChange={setSlippage}
          onQuoteModeChange={setQuoteMode}
        />
      </div>
      <BottomWorkspace
        snapshot={snapshot}
        providerConnection={providerConnection}
      />
    </main>
  );
}
