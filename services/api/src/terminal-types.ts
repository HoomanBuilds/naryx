export const DOMAIN_IDS = ["solana", "base", "arbitrum", "hyperliquid"] as const;
export const PACKAGE_MODES = ["entry", "exit"] as const;
export const QUOTE_MODES = ["coordinated_limits", "indicative_preview"] as const;
export const SLIPPAGE_CHOICES = [5, 10, 25] as const;

export type DomainId = (typeof DOMAIN_IDS)[number];
export type PackageMode = (typeof PACKAGE_MODES)[number];
export type QuoteMode = (typeof QUOTE_MODES)[number];
export type SlippageBps = (typeof SLIPPAGE_CHOICES)[number];

export type PreviewRequest = {
  domain: DomainId;
  mode: PackageMode;
  size: string;
  slippageBps: SlippageBps;
  quoteMode: QuoteMode;
};

export type PreviewLeg = {
  sequence: number;
  action: string;
  instrument: string;
  venue: string;
  quantity: string;
  limitLabel: string;
  limit: string;
  state: string;
  dependency: string;
};

export type PreviewResponse = {
  source: "PRIVATE_TERMINAL_BFF";
  environment: "LOCAL_CONFORMANCE";
  capturedAt: string;
  evidenceGrade: "FIXTURE_UNATTESTED";
  executionAvailable: false;
  domain: DomainId;
  mode: PackageMode;
  quoteMode: QuoteMode;
  size: {
    baseAtoms: string;
    value: string;
    symbol: "SOL";
  };
  bound: {
    label: string;
    quoteAtoms: string;
    value: string;
    symbol: "USDC";
  };
  fees: Array<{
    label: string;
    amountAtoms: string;
    value: string;
  }>;
  totalFee: {
    amountAtoms: string;
    value: string;
    symbol: "USDC";
  };
  legs: PreviewLeg[];
  action: {
    available: false;
    reason: string;
  };
};

export function isDomainId(value: unknown): value is DomainId {
  return typeof value === "string" && DOMAIN_IDS.includes(value as DomainId);
}

export function isPackageMode(value: unknown): value is PackageMode {
  return typeof value === "string" && PACKAGE_MODES.includes(value as PackageMode);
}

export function isQuoteMode(value: unknown): value is QuoteMode {
  return typeof value === "string" && QUOTE_MODES.includes(value as QuoteMode);
}

export function isSlippageBps(value: unknown): value is SlippageBps {
  return typeof value === "number" && SLIPPAGE_CHOICES.includes(value as SlippageBps);
}
