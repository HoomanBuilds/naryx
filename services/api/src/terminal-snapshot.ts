import {
  PRIVATE_TERMINAL_PACKAGE_MANIFEST_V1 as manifest,
  TERMINAL_CAPTURED_AT,
} from "./private-terminal-manifest.js";
import { createTerminalPreview } from "./terminal-preview.js";
import type { DomainId, PackageMode } from "./terminal-types.js";

const DOMAINS = [
  { id: "solana", label: "Solana", runtime: "SVM", state: "Fixture" },
  { id: "base", label: "Base", runtime: "EVM", state: "Fixture" },
  { id: "arbitrum", label: "Arbitrum", runtime: "EVM", state: "Fixture" },
  { id: "hyperliquid", label: "Hyperliquid", runtime: "HyperCore", state: "Fixture" },
] as const;

function plan(mode: PackageMode) {
  const preview = createTerminalPreview({
    domain: "solana",
    mode,
    size: "100",
    slippageBps: 10,
    quoteMode: "coordinated_limits",
  });
  return {
    mode,
    label: mode === "entry" ? "Entry sequence" : "Exit sequence",
    description: mode === "entry"
      ? "The hedge leg remains blocked until the spot receipt is accepted."
      : "The spot sale remains blocked until the perpetual close is accepted.",
    legs: preview.legs,
  };
}

export function createTerminalSnapshot(selectedDomain: DomainId) {
  return {
    environment: {
      label: "LOCAL_CONFORMANCE",
      title: "Private preview service",
      detail: "Server-calculated fixture preview with no signer or executable route.",
      capturedAt: TERMINAL_CAPTURED_AT,
      source: "PRIVATE_TERMINAL_BFF",
      evidenceGrade: "FIXTURE_UNATTESTED",
      executionEnabled: false,
    },
    selectedDomain,
    domains: DOMAINS,
    market: {
      base: manifest.baseSymbol,
      quote: manifest.quoteSymbol,
      packageId: manifest.packageId,
      strategy: "Cash and carry",
      subtitle: "Spot long plus delta-neutral perpetual short",
      metrics: [
        { label: "Spot reference", value: "$148.240", detail: "Fixture" },
        { label: "Perp reference", value: "$149.070", detail: "Fixture" },
        { label: "Basis", value: "+56.0 bps", accent: true },
        {
          label: "Expected net annualized yield",
          value: "7.18%",
          detail: "Fixture model",
          accent: true,
        },
        { label: "Funding annualized", value: "8.36%", detail: "Fixture" },
        { label: "Liquidity at size", value: "$250,000", detail: "100 SOL" },
        { label: "Settlement class", value: "Coordinated", detail: "Isolated accounts" },
      ],
    },
    chart: {
      title: "Package basis",
      subtitle: "Deterministic one-hour reference window",
      points: [
        { label: "01:00", spot: 147.84, perp: 148.55, basisBps: 48.0 },
        { label: "02:00", spot: 147.93, perp: 148.68, basisBps: 50.7 },
        { label: "03:00", spot: 147.88, perp: 148.61, basisBps: 49.4 },
        { label: "04:00", spot: 148.02, perp: 148.81, basisBps: 53.4 },
        { label: "05:00", spot: 148.11, perp: 148.92, basisBps: 54.7 },
        { label: "06:00", spot: 148.04, perp: 148.87, basisBps: 56.1 },
        { label: "07:00", spot: 148.18, perp: 149.03, basisBps: 57.4 },
        { label: "08:00", spot: 148.29, perp: 149.13, basisBps: 56.6 },
        { label: "09:00", spot: 148.16, perp: 148.96, basisBps: 54.0 },
        { label: "10:00", spot: 148.22, perp: 149.05, basisBps: 56.0 },
        { label: "11:00", spot: 148.31, perp: 149.16, basisBps: 57.3 },
        { label: "12:00", spot: 148.24, perp: 149.07, basisBps: 56.0 },
      ],
    },
    plans: [plan("entry"), plan("exit")],
    ticket: {
      defaultSize: "100",
      sizeSymbol: "SOL",
      defaultSlippageBps: 10,
      quoteModes: [
        { id: "coordinated_limits", label: "Coordinated limits" },
        { id: "indicative_preview", label: "Indicative preview" },
      ],
      evidence: [
        { label: "Manifest", value: `Private fixture manifest v${manifest.version}` },
        { label: "Quote binding", value: "Server-calculated, unattested" },
        { label: "Route status", value: "Preview only" },
      ],
    },
    workspaces: [
      {
        tab: "positions",
        label: "Positions",
        count: 0,
        columns: [
          { label: "Package" }, { label: "Mode" }, { label: "Size", numeric: true },
          { label: "Cost basis", numeric: true }, { label: "Mark", numeric: true },
          { label: "PnL", numeric: true }, { label: "State" },
        ],
        emptyTitle: "No wallet positions",
        emptyDetail: "The private preview service does not load wallet positions.",
      },
      {
        tab: "orders",
        label: "Open Orders",
        count: 0,
        columns: [
          { label: "Order" }, { label: "Leg" }, { label: "Quantity", numeric: true },
          { label: "Limit", numeric: true }, { label: "Filled", numeric: true },
          { label: "State" },
        ],
        emptyTitle: "No open orders",
        emptyDetail: "Execution is disabled for the private preview service.",
      },
      {
        tab: "history",
        label: "History",
        columns: [
          { label: "Time" }, { label: "Package" }, { label: "Mode" },
          { label: "Size", numeric: true }, { label: "Net result", numeric: true },
          { label: "State" },
        ],
        emptyTitle: "No execution history",
        emptyDetail: "This deterministic snapshot contains no submitted packages.",
      },
      {
        tab: "receipts",
        label: "Receipts",
        columns: [
          { label: "Receipt" }, { label: "Domain" }, { label: "Leg" },
          { label: "Block", numeric: true }, { label: "Finality" }, { label: "Evidence" },
        ],
        emptyTitle: "No network receipts",
        emptyDetail: "The preview service does not submit or collect execution receipts.",
      },
    ],
  };
}
