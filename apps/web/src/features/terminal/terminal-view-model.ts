export type DomainId = "solana" | "base" | "arbitrum" | "hyperliquid";

export type PackageMode = "entry" | "exit";

export type QuoteMode = "coordinated_limits" | "indicative_preview";

export type SlippageBps = 5 | 10 | 25;

export type ProviderConnection = "connected" | "connecting" | "disconnected";

export type WorkspaceTab = "positions" | "orders" | "history" | "receipts";

export type TerminalDomain = {
  id: DomainId;
  label: string;
  runtime: string;
  state: string;
};

export type TerminalMetric = {
  label: string;
  value: string;
  detail?: string;
  accent?: boolean;
};

export type BasisPoint = {
  label: string;
  spot: number;
  perp: number;
  basisBps: number;
};

export type PackageLeg = {
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

export type PackagePlan = {
  mode: PackageMode;
  label: string;
  description: string;
  legs: PackageLeg[];
};

export type TicketModel = {
  defaultSize: string;
  sizeSymbol: string;
  defaultSlippageBps: SlippageBps;
  quoteModes: Array<{
    id: QuoteMode;
    label: string;
  }>;
  evidence: Array<{
    label: string;
    value: string;
  }>;
};

export type WorkspaceModel = {
  tab: WorkspaceTab;
  label: string;
  count?: number;
  columns: Array<{
    label: string;
    numeric?: boolean;
  }>;
  emptyTitle: string;
  emptyDetail: string;
};

export type TerminalViewModel = {
  environment: {
    label: string;
    title: string;
    detail: string;
    capturedAt: string;
    source: "LOCAL_CONFORMANCE" | "PRIVATE_TERMINAL_BFF";
    evidenceGrade: "FIXTURE_UNATTESTED";
    executionEnabled: boolean;
  };
  domains: TerminalDomain[];
  selectedDomain: DomainId;
  market: {
    base: string;
    quote: string;
    packageId: string;
    strategy: string;
    subtitle: string;
    metrics: TerminalMetric[];
  };
  chart: {
    title: string;
    subtitle: string;
    points: BasisPoint[];
  };
  plans: PackagePlan[];
  ticket: TicketModel;
  workspaces: WorkspaceModel[];
};

export type TerminalPreviewInput = {
  domain: DomainId;
  mode: PackageMode;
  size: string;
  slippageBps: SlippageBps;
  quoteMode: QuoteMode;
};

export type TerminalPreview = {
  source: "LOCAL_CONFORMANCE" | "PRIVATE_TERMINAL_BFF";
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
  legs: PackageLeg[];
  action: {
    available: false;
    reason: string;
  };
};

export interface TerminalViewModelProvider {
  getSnapshot(domain: DomainId, signal?: AbortSignal): Promise<TerminalViewModel>;
  getPreview(input: TerminalPreviewInput, signal?: AbortSignal): Promise<TerminalPreview>;
}
