import type {
  DomainId,
  TerminalPreview,
  TerminalPreviewInput,
  TerminalViewModel,
  TerminalViewModelProvider,
} from "./terminal-view-model";

const BASE_SCALE = BigInt(1_000_000);
const QUOTE_SCALE = BigInt(1_000_000);
const BPS_SCALE = BigInt(10_000);
const SPOT_PRICE = BigInt(148_240_000);
const PERPETUAL_PRICE = BigInt(149_070_000);
const NETWORK_FEE = BigInt(180_000);

const LOCAL_CONFORMANCE_SNAPSHOT: TerminalViewModel = {
  environment: {
    label: "LOCAL_CONFORMANCE",
    title: "Deterministic conformance data",
    detail: "No RPC, venue session, wallet, or executable route is connected.",
    capturedAt: "2026-09-20 12:00 UTC",
    source: "LOCAL_CONFORMANCE",
    evidenceGrade: "FIXTURE_UNATTESTED",
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
    defaultSlippageBps: 10,
    quoteModes: [
      { id: "coordinated_limits", label: "Coordinated limits" },
      { id: "indicative_preview", label: "Indicative preview" },
    ],
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

function parseBaseAtoms(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(value)) {
    throw new Error("Invalid conformance size.");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const atoms = BigInt(whole) * BASE_SCALE + BigInt(fraction.padEnd(6, "0"));
  if (atoms <= BigInt(0) || atoms > BigInt(100_000) * BASE_SCALE) {
    throw new Error("Conformance size is outside the supported range.");
  }
  return atoms;
}

function formatAtoms(atoms: bigint): string {
  return `${atoms / QUOTE_SCALE}.${(atoms % QUOTE_SCALE).toString().padStart(6, "0")}`;
}

function multiplyDivideFloor(value: bigint, multiplier: bigint, divisor: bigint): bigint {
  return value * multiplier / divisor;
}

function multiplyDivideCeil(value: bigint, multiplier: bigint, divisor: bigint): bigint {
  return (value * multiplier + divisor - BigInt(1)) / divisor;
}

function previewLegs(input: TerminalPreviewInput, size: string) {
  const slippage = BigInt(input.slippageBps);
  if (input.mode === "entry") {
    const maximumSpot = multiplyDivideCeil(SPOT_PRICE, BPS_SCALE + slippage, BPS_SCALE);
    const minimumPerpetual = multiplyDivideFloor(
      PERPETUAL_PRICE,
      BPS_SCALE - slippage,
      BPS_SCALE,
    );
    return [
      {
        sequence: 1, action: "Buy spot", instrument: "SOL / USDC",
        venue: "Solana spot route fixture", quantity: `${size} SOL`,
        limitLabel: "Maximum price", limit: `$${formatAtoms(maximumSpot)}`,
        state: "Preview ready", dependency: "First leg",
      },
      {
        sequence: 2, action: "Short perpetual", instrument: "SOL-PERP",
        venue: "Hyperliquid testnet route fixture", quantity: `${size} SOL`,
        limitLabel: "Minimum entry", limit: `$${formatAtoms(minimumPerpetual)}`,
        state: "Awaiting leg 1", dependency: "Requires accepted spot receipt",
      },
    ];
  }
  const maximumPerpetual = multiplyDivideCeil(
    PERPETUAL_PRICE,
    BPS_SCALE + slippage,
    BPS_SCALE,
  );
  const minimumSpot = multiplyDivideFloor(SPOT_PRICE, BPS_SCALE - slippage, BPS_SCALE);
  return [
    {
      sequence: 1, action: "Buy to close", instrument: "SOL-PERP",
      venue: "Hyperliquid testnet route fixture", quantity: `${size} SOL`,
      limitLabel: "Maximum close", limit: `$${formatAtoms(maximumPerpetual)}`,
      state: "Preview ready", dependency: "First leg",
    },
    {
      sequence: 2, action: "Sell spot", instrument: "SOL / USDC",
      venue: "Solana spot route fixture", quantity: `${size} SOL`,
      limitLabel: "Minimum output", limit: `$${formatAtoms(minimumSpot)}`,
      state: "Awaiting leg 1", dependency: "Requires accepted perp close",
    },
  ];
}

class LocalConformanceTerminalProvider implements TerminalViewModelProvider {
  async getSnapshot(domain: DomainId): Promise<TerminalViewModel> {
    return { ...LOCAL_CONFORMANCE_SNAPSHOT, selectedDomain: domain };
  }

  async getPreview(input: TerminalPreviewInput): Promise<TerminalPreview> {
    const sizeAtoms = parseBaseAtoms(input.size);
    const normalizedSize = formatAtoms(sizeAtoms);
    const slippage = BigInt(input.slippageBps);
    const boundPrice = input.mode === "entry"
      ? multiplyDivideCeil(SPOT_PRICE, BPS_SCALE + slippage, BPS_SCALE)
      : multiplyDivideFloor(SPOT_PRICE, BPS_SCALE - slippage, BPS_SCALE);
    const boundAtoms = input.mode === "entry"
      ? multiplyDivideCeil(sizeAtoms, boundPrice, BASE_SCALE)
      : multiplyDivideFloor(sizeAtoms, boundPrice, BASE_SCALE);
    const spotNotional = multiplyDivideCeil(sizeAtoms, SPOT_PRICE, BASE_SCALE);
    const perpetualNotional = multiplyDivideCeil(sizeAtoms, PERPETUAL_PRICE, BASE_SCALE);
    const spotFee = multiplyDivideCeil(spotNotional, BigInt(8), BPS_SCALE);
    const perpetualFee = multiplyDivideCeil(
      perpetualNotional,
      BigInt(2),
      BPS_SCALE,
    );
    const fees = [
      { label: "Spot venue fee", amountAtoms: spotFee.toString(), value: formatAtoms(spotFee) },
      {
        label: "Perp venue fee",
        amountAtoms: perpetualFee.toString(),
        value: formatAtoms(perpetualFee),
      },
      {
        label: "Coordinator fee",
        amountAtoms: "0",
        value: formatAtoms(BigInt(0)),
      },
      {
        label: "Estimated network fees",
        amountAtoms: NETWORK_FEE.toString(),
        value: formatAtoms(NETWORK_FEE),
      },
    ];
    const totalFee = spotFee + perpetualFee + NETWORK_FEE;
    return {
      source: "LOCAL_CONFORMANCE",
      environment: "LOCAL_CONFORMANCE",
      capturedAt: LOCAL_CONFORMANCE_SNAPSHOT.environment.capturedAt,
      evidenceGrade: "FIXTURE_UNATTESTED",
      executionAvailable: false,
      domain: input.domain,
      mode: input.mode,
      quoteMode: input.quoteMode,
      size: { baseAtoms: sizeAtoms.toString(), value: normalizedSize, symbol: "SOL" },
      bound: {
        label: input.mode === "entry" ? "Maximum quote" : "Minimum output",
        quoteAtoms: boundAtoms.toString(),
        value: formatAtoms(boundAtoms),
        symbol: "USDC",
      },
      fees,
      totalFee: { amountAtoms: totalFee.toString(), value: formatAtoms(totalFee), symbol: "USDC" },
      legs: previewLegs(input, normalizedSize),
      action: {
        available: false,
        reason: "Configure an executable private route and signing session before submission.",
      },
    };
  }
}

export const localConformanceTerminalProvider =
  new LocalConformanceTerminalProvider();
