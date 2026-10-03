import { formatDecimalAtoms } from "./decimal.js";
import {
  formatExact,
  midpoint,
  observedMarket,
  previewFromMarket,
  quotePrice,
  resolveTerminalMarket,
  type ObservedDecimal,
  type TerminalMarketContext,
} from "./terminal-preview.js";
import type { TerminalMarketDescriptor } from "./private-terminal-manifest.js";
import { SLIPPAGE_CHOICES, type DomainId, type PackageMode, type SlippageBps } from "./terminal-types.js";

const DOMAINS = [
  { id: "solana", label: "Solana", runtime: "SVM" },
  { id: "base", label: "Base", runtime: "EVM" },
  { id: "arbitrum", label: "Arbitrum", runtime: "EVM" },
  { id: "hyperliquid", label: "Hyperliquid", runtime: "HyperCore" },
] as const;

/** Basis of the perpetual mid over the spot mid in hundredths of a basis point, truncated toward zero. */
export function basisHundredthsBps(spotMid: ObservedDecimal, perpMid: ObservedDecimal): bigint {
  const scale = Math.max(spotMid.scale, perpMid.scale);
  const spot = spotMid.digits * 10n ** BigInt(scale - spotMid.scale);
  const perp = perpMid.digits * 10n ** BigInt(scale - perpMid.scale);
  return (perp - spot) * 1_000_000n / spot;
}

/**
 * Basis of the perpetual mid over the spot mid in basis points, truncated toward zero to 0.01 bps
 * and signed, for example "+56.00 bps".
 */
export function formatBasisBps(spotMid: ObservedDecimal, perpMid: ObservedDecimal): string {
  const hundredths = basisHundredthsBps(spotMid, perpMid);
  const magnitude = hundredths < 0n ? -hundredths : hundredths;
  return `${hundredths < 0n ? "-" : "+"}${formatDecimalAtoms(magnitude, 2)} bps`;
}

function rateBps(rate: ObservedDecimal): string {
  return formatExact(rate.scale >= 4
    ? { digits: rate.digits, scale: rate.scale - 4 }
    : { digits: rate.digits * 10n ** BigInt(4 - rate.scale), scale: 0 }, 0);
}

function defaultSlippage(descriptor: TerminalMarketDescriptor): SlippageBps {
  if (descriptor.maxSlippageBps >= 10) return 10;
  return SLIPPAGE_CHOICES[0];
}

export function createTerminalSnapshot(selectedDomain: DomainId, context: TerminalMarketContext) {
  const { descriptor, market } = resolveTerminalMarket(selectedDomain, context, "SNAPSHOT_UNAVAILABLE");
  const executionEnabled = context.executionAvailable(selectedDomain);
  const capturedAt = new Date(market.capturedAtMs).toISOString();
  const spotMid = midpoint(market.spotBid, market.spotAsk);
  const perpMid = midpoint(market.perpBid, market.perpAsk);
  const basis = formatBasisBps(spotMid, perpMid);
  const unitAtoms = 10n ** BigInt(descriptor.baseDecimals);
  const defaultSizeAtoms = unitAtoms < descriptor.maximumSizeAtoms ? unitAtoms : descriptor.maximumSizeAtoms;
  const defaultSize = formatDecimalAtoms(defaultSizeAtoms, descriptor.baseDecimals);
  const slippageBps = defaultSlippage(descriptor);
  const plan = (mode: PackageMode) => ({
    mode,
    label: mode === "entry" ? "Entry sequence" : "Exit sequence",
    description: mode === "entry"
      ? "The hedge leg remains blocked until the spot receipt is accepted."
      : "The spot sale remains blocked until the perpetual close is accepted.",
    legs: previewFromMarket(
      { domain: selectedDomain, mode, size: defaultSize, slippageBps, quoteMode: "coordinated_limits" },
      descriptor,
      market,
      executionEnabled,
    ).legs,
  });

  return {
    environment: {
      label: descriptor.environment,
      title: "Private terminal service",
      detail: "Server-calculated from observed books. Unsigned and unattested.",
      capturedAt,
      source: "PRIVATE_TERMINAL_BFF",
      evidenceGrade: "OBSERVED_UNATTESTED",
      executionEnabled,
    },
    selectedDomain,
    domains: DOMAINS.map((domain) => {
      const source = context.sources[domain.id];
      const live = source !== undefined &&
        observedMarket(source.descriptor, source.latest(), context.nowMs) !== undefined;
      return { ...domain, state: live ? "Live" : "Unavailable" };
    }),
    market: {
      base: descriptor.baseSymbol,
      quote: descriptor.quoteSymbol,
      packageId: descriptor.packageId,
      strategy: "Cash and carry",
      subtitle: "Spot long plus delta-neutral perpetual short",
      metrics: [
        { label: "Spot reference", value: quotePrice(descriptor, spotMid), detail: "Observed spot mid" },
        { label: "Perp reference", value: quotePrice(descriptor, perpMid), detail: "Observed perpetual mid" },
        { label: "Basis", value: basis, accent: true },
        {
          label: "Taker fees",
          value: `${rateBps(market.spotTakerRate)} / ${rateBps(market.perpTakerRate)} bps`,
          detail: "Spot / perpetual, observed",
        },
        { label: "Settlement class", value: descriptor.settlement.label, detail: descriptor.settlement.detail },
      ],
    },
    chart: {
      title: "Package basis",
      subtitle: "Latest observed books",
      points: [{
        label: capturedAt.slice(11, 16),
        spot: Number(formatExact(spotMid)),
        perp: Number(formatExact(perpMid)),
        basisBps: Number(basis.slice(0, -4)),
      }],
    },
    plans: [plan("entry"), plan("exit")],
    ticket: {
      defaultSize,
      sizeSymbol: descriptor.baseSymbol,
      defaultSlippageBps: slippageBps,
      quoteModes: [
        { id: "coordinated_limits", label: "Coordinated limits" },
        { id: "indicative_preview", label: "Indicative preview" },
      ],
      evidence: [
        { label: "Market source", value: `${descriptor.spot.venue}, ${descriptor.perp.venue}` },
        { label: "Quote binding", value: "Server-calculated from observed books, unattested" },
        { label: "Route status", value: executionEnabled ? "Execution gate available" : "Preview only" },
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
        emptyDetail: "The terminal snapshot does not load wallet positions.",
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
        emptyDetail: "The terminal snapshot does not load open orders.",
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
        emptyDetail: "The terminal snapshot does not load submitted packages.",
      },
      {
        tab: "receipts",
        label: "Receipts",
        columns: [
          { label: "Receipt" }, { label: "Domain" }, { label: "Leg" },
          { label: "Block", numeric: true }, { label: "Finality" }, { label: "Evidence" },
        ],
        emptyTitle: "No network receipts",
        emptyDetail: "Execution receipts appear in the package lifecycle, not the snapshot.",
      },
    ],
  };
}
