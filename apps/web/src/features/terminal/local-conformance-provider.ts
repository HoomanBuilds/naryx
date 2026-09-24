import type {
  TerminalViewModel,
  TerminalViewModelProvider,
} from "./terminal-view-model";

const LOCAL_CONFORMANCE_SNAPSHOT: TerminalViewModel = {
  environment: {
    label: "LOCAL_CONFORMANCE",
    title: "Deterministic conformance data",
    detail: "No RPC, venue session, wallet, or executable route is connected.",
    capturedAt: "2026-09-20 12:00 UTC",
    executionEnabled: false,
  },
  selectedDomain: "solana",
  domains: [
    {
      id: "solana",
      label: "Solana",
      runtime: "SVM",
      state: "Fixture",
    },
    {
      id: "base",
      label: "Base",
      runtime: "EVM",
      state: "Fixture",
    },
    {
      id: "arbitrum",
      label: "Arbitrum",
      runtime: "EVM",
      state: "Fixture",
    },
    {
      id: "hyperliquid",
      label: "Hyperliquid",
      runtime: "HyperCore",
      state: "Fixture",
    },
  ],
  market: {
    base: "SOL",
    quote: "USDC",
    packageId: "SOL-CARRY-30D",
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
  plans: [
    {
      mode: "entry",
      label: "Entry sequence",
      description: "The hedge leg remains blocked until the spot receipt is accepted.",
      legs: [
        {
          sequence: 1,
          action: "Buy spot",
          instrument: "SOL / USDC",
          venue: "Solana spot adapter preview",
          quantity: "100.00 SOL",
          limitLabel: "Maximum price",
          limit: "$148.800",
          state: "Quote staged",
          dependency: "First leg",
        },
        {
          sequence: 2,
          action: "Short perpetual",
          instrument: "SOL-PERP",
          venue: "Hyperliquid testnet preview",
          quantity: "100.00 SOL",
          limitLabel: "Minimum entry",
          limit: "$149.000",
          state: "Awaiting leg 1",
          dependency: "Requires accepted spot receipt",
        },
      ],
    },
    {
      mode: "exit",
      label: "Exit sequence",
      description: "The spot sale remains blocked until the perpetual close is accepted.",
      legs: [
        {
          sequence: 1,
          action: "Buy to close",
          instrument: "SOL-PERP",
          venue: "Hyperliquid testnet preview",
          quantity: "100.00 SOL",
          limitLabel: "Maximum close",
          limit: "$149.220",
          state: "Quote staged",
          dependency: "First leg",
        },
        {
          sequence: 2,
          action: "Sell spot",
          instrument: "SOL / USDC",
          venue: "Solana spot adapter preview",
          quantity: "100.00 SOL",
          limitLabel: "Minimum output",
          limit: "$147.000",
          state: "Awaiting leg 1",
          dependency: "Requires accepted perp close",
        },
      ],
    },
  ],
  ticket: {
    defaultSize: "100",
    sizeSymbol: "SOL",
    entryQuotePerUnit: 148.8,
    exitOutputPerUnit: 147,
    defaultSlippageBps: 10,
    quoteModes: ["Coordinated limits", "Indicative preview"],
    feeRows: [
      { label: "Spot venue fee", ratePerUnit: 0.1186 },
      { label: "Perp venue fee", ratePerUnit: 0.0298 },
      { label: "Coordinator fee", ratePerUnit: 0 },
    ],
    networkFee: 0.18,
    evidence: [
      { label: "Manifest", value: "Fixture manifest v1" },
      { label: "Quote binding", value: "Not network-attested" },
      { label: "Route status", value: "Preview only" },
    ],
  },
  workspaces: [
    {
      tab: "positions",
      label: "Positions",
      count: 0,
      columns: [
        { label: "Package" },
        { label: "Mode" },
        { label: "Size", numeric: true },
        { label: "Cost basis", numeric: true },
        { label: "Mark", numeric: true },
        { label: "PnL", numeric: true },
        { label: "State" },
      ],
      emptyTitle: "No wallet positions",
      emptyDetail: "Connect the private execution service to load positions.",
    },
    {
      tab: "orders",
      label: "Open Orders",
      count: 0,
      columns: [
        { label: "Order" },
        { label: "Leg" },
        { label: "Quantity", numeric: true },
        { label: "Limit", numeric: true },
        { label: "Filled", numeric: true },
        { label: "State" },
      ],
      emptyTitle: "No open orders",
      emptyDetail: "Execution is disabled for the local conformance provider.",
    },
    {
      tab: "history",
      label: "History",
      columns: [
        { label: "Time" },
        { label: "Package" },
        { label: "Mode" },
        { label: "Size", numeric: true },
        { label: "Net result", numeric: true },
        { label: "State" },
      ],
      emptyTitle: "No execution history",
      emptyDetail: "This deterministic snapshot contains no submitted packages.",
    },
    {
      tab: "receipts",
      label: "Receipts",
      columns: [
        { label: "Receipt" },
        { label: "Domain" },
        { label: "Leg" },
        { label: "Block", numeric: true },
        { label: "Finality" },
        { label: "Evidence" },
      ],
      emptyTitle: "No network receipts",
      emptyDetail: "Receipt evidence appears only after an executable route is configured.",
    },
  ],
};

class LocalConformanceTerminalProvider implements TerminalViewModelProvider {
  async getSnapshot(): Promise<TerminalViewModel> {
    return LOCAL_CONFORMANCE_SNAPSHOT;
  }
}

export const localConformanceTerminalProvider =
  new LocalConformanceTerminalProvider();
