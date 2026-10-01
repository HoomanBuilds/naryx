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

/**
 * FIXTURE_UNATTESTED is only the local fixture provider. OBSERVED_UNATTESTED is server-calculated
 * from live, unsigned book observations. UNAVAILABLE marks a domain whose service market answered 503.
 */
export type TerminalEvidenceGrade = "FIXTURE_UNATTESTED" | "OBSERVED_UNATTESTED" | "UNAVAILABLE";

export type TerminalViewModel = {
  environment: {
    label: string;
    title: string;
    detail: string;
    capturedAt: string;
    source: "LOCAL_CONFORMANCE" | "PRIVATE_TERMINAL_BFF";
    evidenceGrade: TerminalEvidenceGrade;
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

export type SolanaExecutionPreparationInput = Omit<TerminalPreviewInput, "domain"> & {
  domain: "svm:devnet";
  traderPublicKey: string;
  idempotencyKey: string;
};

export type SolanaExecutionPreparation = {
  status: "DEVNET_UNSIGNED_REVIEW_REQUIRED";
  domain: "svm:devnet";
  environment: "DEVNET";
  idempotencyKey: string;
  domainManifestVersion: number;
  domainManifestHash: string;
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  planKind: "TRADER_ENTRY" | "TRADER_RECOVERY_EXIT" | "TRADER_FIRM_EXIT";
  transactionBase64: string;
  messageBase64: string;
  requiredSignerPubkeys: readonly string[];
  recentBlockhash: string;
  blockhashContextSlot: number;
  lastValidBlockHeight: number;
  lifecycleAttemptId: string;
  lookupTables: readonly {
    address: string;
    addresses: readonly string[];
    contentCommitment: string;
    contextSlot: number;
  }[];
  evidence: {
    resolvedAddressCount: number;
    serializedMessageBytes: number;
    serializedTransactionBytes: number;
    packetDataLimit: 1232;
    computeUnitLimit: number;
    computeUnitLimitSource: "EXPLICIT";
    routeComputeUnitLimit: number;
  };
  requestCommitment: string;
  transactionBytes: Uint8Array;
};

export type TerminalPreview = {
  source: "LOCAL_CONFORMANCE" | "PRIVATE_TERMINAL_BFF";
  environment: "LOCAL_CONFORMANCE" | "TESTNET" | "DEVNET";
  capturedAt: string;
  evidenceGrade: Exclude<TerminalEvidenceGrade, "UNAVAILABLE">;
  executionAvailable: boolean;
  domain: DomainId;
  mode: PackageMode;
  quoteMode: QuoteMode;
  size: {
    baseAtoms: string;
    value: string;
    symbol: string;
  };
  bound: {
    label: string;
    quoteAtoms: string;
    value: string;
    symbol: string;
  };
  fees: Array<{
    label: string;
    amountAtoms: string;
    value: string;
  }>;
  totalFee: {
    amountAtoms: string;
    value: string;
    symbol: string;
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
