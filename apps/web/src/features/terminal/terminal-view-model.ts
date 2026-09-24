export type DomainId = "solana" | "base" | "arbitrum" | "hyperliquid";

export type PackageMode = "entry" | "exit";

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
  entryQuotePerUnit: number;
  exitOutputPerUnit: number;
  defaultSlippageBps: number;
  quoteModes: string[];
  feeRows: Array<{
    label: string;
    ratePerUnit: number;
  }>;
  networkFee: number;
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

export interface TerminalViewModelProvider {
  getSnapshot(): Promise<TerminalViewModel>;
}
