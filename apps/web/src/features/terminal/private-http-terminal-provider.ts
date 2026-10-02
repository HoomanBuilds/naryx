import type {
  DomainId,
  SolanaExecutionPreparation,
  SolanaExecutionPreparationInput,
  TerminalPreview,
  TerminalPreviewInput,
  TerminalViewModel,
  TerminalViewModelProvider,
} from "./terminal-view-model";
import { getTransactionDecoder } from "@solana/transactions";
import bs58 from "bs58";
import { decodeFunctionData, hashTypedData, parseAbi } from "viem";
import { parseSolanaDevnetAccountStatus, type SolanaDevnetAccountStatus } from "./solana-devnet-onboarding";

const SOLANA_DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAX_TRANSACTION_BYTES = 1232;
const MAX_RESOLVED_ACCOUNTS = 64;
const MAX_COMPUTE_UNITS = 1_260_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const LIFECYCLE_ATTEMPT_ID_PATTERN = /^solana-cash-carry-[0-9a-f]{64}$/;
const LOCAL_ATTEMPT_ID_PATTERN = /^local-atomic-[0-9a-f]{64}$/;
const LOCAL_CONTEXT_ID = "local:svm:sol-carry-v1";
const BASE_SEPOLIA_DOMAIN_ID = "eip155:84532" as const;
const BASE_SEPOLIA_CHAIN_REFERENCE = "84532" as const;
// The Arbitrum coordinator commits to keccak256("eip155:421614"), so the service reports this exact id.
const ARBITRUM_SEPOLIA_DOMAIN_ID = "eip155:421614" as const;
const ARBITRUM_SEPOLIA_CHAIN_REFERENCE = "421614" as const;
const EVM_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const EVM_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const EVM_SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const EVM_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const HYPERLIQUID_ATTEMPT_ID_PATTERN = /^hyperliquid-testnet-[0-9a-f]{48}$/;
const HYPERLIQUID_DOMAIN_ID = "hypercore:testnet" as const;

export type SolanaExecutionObservationRequest = Readonly<{
  idempotencyKey: string;
  signature: string;
}>;

export type RuntimeBoundaryHealth = Readonly<{
  available: boolean;
  reason:
    | "DISABLED_BY_CONFIGURATION"
    | "RUNTIME_FACTORY_NOT_INJECTED"
    | "RUNTIME_INITIALIZATION_FAILED"
    | "REQUIRED_PORTS_MISSING"
    | null;
}>;

export type PrivateTerminalRuntimeHealth = Readonly<{
  solanaDevnet: RuntimeBoundaryHealth;
  baseTestnetAtomic: RuntimeBoundaryHealth;
  arbitrumTestnetAsync: RuntimeBoundaryHealth;
  hyperliquidTestnet: RuntimeBoundaryHealth;
  controls: Readonly<{
    /** DISABLED: no local runtime is composed, the default for a real testnet deployment. */
    localAtomicRuntimeMode: "PHASE4_FIXTURE" | "MANIFEST_VALIDATED" | "DISABLED";
    executionReadinessAvailable: boolean;
    lifecycleReadAvailable: boolean;
    solverQuotingAvailable: boolean;
    executionIntentAvailable: boolean;
    localExecutionAvailable: boolean;
    solanaLocalExecutionAvailable: boolean;
  }>;
}>;

export type SolanaExecutionObservation =
  | Readonly<{
    lifecycle: "SUBMITTED";
    signature: string;
    observedSlot: number | null;
  }>
  | Readonly<{
    lifecycle: "FINALIZED";
    signature: string;
    finalizedSlot: number;
  }>
  | Readonly<{
    lifecycle: "FAILED";
    signature: string;
    failedSlot: number | null;
    failureCode: string;
  }>
  | Readonly<{
    lifecycle: "EXPIRED";
    signature: string;
    lastValidBlockHeight: number;
    observedBlockHeight: number;
  }>;

export type EvmRequestIdentity = Readonly<{
  attemptId: string;
  idempotencyKey: string;
}>;

export type BaseAtomicAuthorization = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  domainId: typeof BASE_SEPOLIA_DOMAIN_ID;
  domainManifestVersion: number;
  domainManifestHash: string;
  environment: "TESTNET";
  chainReference: typeof BASE_SEPOLIA_CHAIN_REFERENCE;
  typedData: Readonly<{
    domain: Readonly<{
      name: "Naryx Package Verifier";
      version: "1";
      chainId: typeof BASE_SEPOLIA_CHAIN_REFERENCE;
      verifyingContract: string;
    }>;
    types: Readonly<{
      EIP712Domain: readonly Readonly<{ name: string; type: string }>[];
      TraderPermit: readonly Readonly<{ name: string; type: string }>[];
    }>;
    primaryType: "TraderPermit";
    message: Readonly<{
      packageHash: string;
      accountsHash: string;
      limitsHash: string;
      nonce: string;
      deadline: string;
    }>;
  }>;
  digest: string;
  requestCommitment: string;
}>;

export type BaseAtomicPreparationRequest = EvmRequestIdentity & Readonly<{
  traderSignature: string;
}>;

export type BaseAtomicPreparation = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  domainId: typeof BASE_SEPOLIA_DOMAIN_ID;
  domainManifestVersion: number;
  domainManifestHash: string;
  environment: "TESTNET";
  chainReference: typeof BASE_SEPOLIA_CHAIN_REFERENCE;
  to: string;
  value: "0";
  data: string;
  orderHash: string;
  quoteHash: string;
  routeHash: string;
  requestCommitment: string;
}>;

export type BaseAtomicObservationRequest = EvmRequestIdentity & Readonly<{
  transactionHash: string;
}>;

export type EvmEvidenceGrade =
  | "none"
  | "transaction-receipt"
  | "contract-state"
  | "authenticated-callback-record"
  | "finalized-contract-receipt";

export type BaseAtomicLifecycle =
  | "NOT_FOUND"
  | "SUBMITTED"
  | "REVERTED"
  | "CONFIRMED"
  | "FINALIZED"
  | "EVIDENCE_MISMATCH";

export type BaseAtomicPackageReceipt = Readonly<{
  receiptHash: string;
  domainIdHash: string;
  domainManifestVersion: number;
  domainManifestHash: string;
  orderHash: string;
  quoteHash: string;
  routeHash: string;
  spotFillCommitment: string;
  seriesIdentityKey: string;
  seriesBindingVersion: number;
  seriesBindingHash: string;
  action: number;
  strategyAccount: string;
  solver: string;
  recovery: boolean;
  baseQuantityAtoms: string;
  spotQuoteAtoms: string;
  packageSizeUnits: string;
  nonce: string;
}>;

export type BaseAtomicOpenPackage = Readonly<{
  entryReceiptHash: string;
  routeHash: string;
  baseQuantityAtoms: string;
  packageSizeUnits: string;
}>;

export type BaseAtomicObservation = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  environment: "TESTNET";
  domainId: typeof BASE_SEPOLIA_DOMAIN_ID;
  domainManifestVersion: number;
  domainManifestHash: string;
  chainReference: typeof BASE_SEPOLIA_CHAIN_REFERENCE;
  transactionHash: string;
  lifecycle: BaseAtomicLifecycle;
  evidenceGrade: EvmEvidenceGrade;
  blockNumber: string | null;
  confirmations: number | null;
  receiptHash: string | null;
  packageReceipt: BaseAtomicPackageReceipt | null;
  openPackage: BaseAtomicOpenPackage | null;
  reason: string | null;
}>;

export type EvmCoordinatorState =
  | "NONE" | "RESERVED" | "REQUEST_SUBMITTED" | "VENUE_PENDING" | "EXECUTED"
  | "CANCELLED" | "FROZEN" | "RECOVERY_PENDING" | "RECOVERED"
  | "MANUAL_INTERVENTION" | "CLOSED";

export type EvmVenueStatus =
  | "NONE" | "PENDING" | "EXECUTED" | "CANCELLED" | "FROZEN" | "RECOVERED" | "CONFLICT";

export type ArbitrumAsyncLifecycle =
  | "NOT_FOUND" | "RESERVED" | "REQUEST_SUBMITTED" | "VENUE_PENDING" | "EXECUTED"
  | "CANCELLED" | "FROZEN" | "RECOVERY_PENDING" | "RECOVERED"
  | "MANUAL_INTERVENTION" | "CLOSED" | "CONFLICT" | "EVIDENCE_MISMATCH";

export type ArbitrumAsyncObservation = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  environment: "TESTNET";
  domainId: typeof ARBITRUM_SEPOLIA_DOMAIN_ID;
  domainManifestVersion: number;
  domainManifestHash: string;
  chainReference: typeof ARBITRUM_SEPOLIA_CHAIN_REFERENCE;
  packageId: string;
  lifecycle: ArbitrumAsyncLifecycle;
  evidenceGrade: EvmEvidenceGrade;
  coordinator: Readonly<{
    state: EvmCoordinatorState;
    stateVersion: number;
    requestKey: string;
    outcomeEvidenceHash: string;
    recoveryEvidenceHash: string;
    hasVenueOutcome: boolean;
    lastVenueOutcome: number;
    recoveryDutyActive: boolean;
    recoveryActionSubmitted: boolean;
    recoveryProven: boolean;
    bondSlashed: boolean;
    evidenceConflict: boolean;
  }> | null;
  entry: Readonly<{
    status: EvmVenueStatus;
    evidenceHash: string;
    positionSizeBefore: string;
    positionSizeAfter: string;
    revision: number;
  }> | null;
  exit: Readonly<{
    status: EvmVenueStatus;
    evidenceHash: string;
    revision: number;
    reconciling: boolean;
    released: boolean;
  }> | null;
  finalReceipt: Readonly<{
    commitment: string;
    packageId: string;
    entryRequestKey: string;
    exitRequestKey: string;
    recipient: string;
    fullCloseSizeUsd: string;
    spotBaseAtoms: string;
    spotQuoteAtoms: string;
    perpStatus: number;
    terminalState: number;
  }> | null;
  exitCompleted: boolean;
  reason: string | null;
}>;

export type PackageLifecycleState =
  | "PACKAGE_CREATED"
  | "ENTRY_PREPARED"
  | "ENTRY_SUBMITTED"
  | "ENTRY_CONFIRMED"
  | "OPEN"
  | "EXIT_REQUESTED"
  | "EXIT_SUBMITTED"
  | "RECOVERY_PENDING"
  | "MANUAL_INTERVENTION"
  | "CLOSED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED";

export type PackageEvidenceGrade =
  | "LOCAL_RECORDED"
  | "CONTROLLER_ATTESTED"
  | "VENUE_CORROBORATED"
  | "CONSENSUS_VERIFIED";

export type PackageLifecycleAttempt = Readonly<{
  attemptId: string;
  packageId: string;
  packageCommitmentHex: string;
  revision: string;
  state: PackageLifecycleState;
  receiptHashHex: string;
  eventId: string;
  observedAtUnixMilliseconds: string;
}>;

export type PackageLifecycleReceipt = Readonly<{
  version: 1;
  domain: Readonly<{
    domainId: string;
    domainManifestVersion: number;
    domainManifestHashHex: string;
  }>;
  settlementClass: "ATOMIC_POSTCONDITION" | "BATCHED_IOC_WITH_RECOVERY" | "ASYNC_BONDED_SOLVER";
  packageId: string;
  packageCommitmentHex: string;
  attemptId: string;
  eventId: string;
  revision: string;
  priorState?: PackageLifecycleState;
  previousReceiptHashHex?: string;
  nextState: PackageLifecycleState;
  observedAtUnixMilliseconds: string;
  evidenceGrade: PackageEvidenceGrade;
  onchainEnforced: boolean;
  evidenceSource: Readonly<{
    subjectId: string;
    manifestVersion: number;
    manifestHashHex: string;
  }>;
  evidenceCommitmentHex: string;
  intentCommitmentHex: string;
  receiptHashHex: string;
}>;

/** One package from GET /internal/terminal/packages. */
export type OwnerPackageEntry = Readonly<{
  orderHash: string;
  domainId: string;
  action: string;
  quantityAtoms: string;
  quantityDecimals: number;
  createdAtMs: number;
  attemptId: string | null;
  state: string | null;
}>;

export type PackageLifecycleResponse = Readonly<{
  attempt: PackageLifecycleAttempt;
  receipts: readonly PackageLifecycleReceipt[];
}>;

export type LocalOrderRecord = Readonly<{
  idempotencyKey: string;
  requestCommitmentHex: string;
  orderHashHex: string;
  orderBase64: string;
  contextId: typeof LOCAL_CONTEXT_ID;
  domainId: "svm:local";
  domainManifestVersion: number;
  domainManifestHashHex: string;
  owner: string;
  settlementAccount: string;
  nonceDecimal: string;
  status: "UNSIGNED_CREATED";
  createdAtMs: number;
  orderBytes: Uint8Array;
}>;

export type LocalOrderCreateResponse = Readonly<{
  status: "UNSIGNED_CREATED";
  created: boolean;
  order: LocalOrderRecord;
  traderAuthorization: "REQUIRED";
  solverQuoting: "REQUIRED";
  note: string;
}>;

export type LocalAuthorization = Readonly<{
  orderHash: string;
  owner: string;
  signature: string;
  authorizedAtMs: number;
}>;

export type LocalSolverQuote = Readonly<{
  version: 1;
  status: "SIGNED";
  idempotencyKey: string;
  orderHash: string;
  routeHash: string;
  quoteHash: string;
  solverSignatureDigest: string;
  routeBytes: string;
  solverQuoteBytes: string;
  route: Readonly<Record<string, unknown>>;
  quote: Readonly<Record<string, unknown>>;
}>;

export type LocalSelectedAttempt = Readonly<{
  attemptId: string;
  orderHash: string;
  routeHash: string;
  quoteHash: string;
  status: "AUTHORIZED_QUOTE_SELECTED";
  selectedAtMs: number;
}>;

export type LocalExecutionAction =
  | "prepare"
  | "open"
  | "observation-ambiguity"
  | "controller-recovery"
  | "close";

export type LocalExecutionResult = Readonly<{
  action: LocalExecutionAction;
  state: PackageLifecycleState;
  lifecycle: PackageLifecycleResponse;
}>;

export type HyperliquidTestnetContext = Readonly<{
  contextId: string;
  tradingAccount: string;
  domain: Readonly<{
    domainId: typeof HYPERLIQUID_DOMAIN_ID;
    domainManifestVersion: number;
    domainManifestHash: string;
  }>;
  environment: "TESTNET";
  /** The user's wallet owns and signs each package; Naryx's one testnet account executes it. */
  authorizationMode: "OWNER_SIGNED_OMNIBUS_ACCOUNT";
  maxOpenPackagesPerOwner: number | null;
}>;

/** One package the wallet owns inside Naryx's shared Hyperliquid testnet trading account. */
export type HyperliquidOwnedPackage = Readonly<{
  entryAttemptId: string;
  entryOrderHash: string;
  state: "PENDING_ENTRY" | "OPEN" | "EXITING" | "CLOSED" | "UNRESOLVED";
  perpQuantityAtoms: string | null;
  spotQuantityAtoms: string | null;
  entryNotionalAtoms: string | null;
  entryReceiptHash: string | null;
  exitAttemptId: string | null;
  openedAtMs: number | null;
  closedAtMs: number | null;
}>;

export type HyperliquidAccountStatus = Readonly<{
  owner: string;
  tradingAccount: string;
  maxOpenPackagesPerOwner: number | null;
  /** Atom decimals of the base and quote assets; null from an older service. */
  baseDecimals: number | null;
  quoteDecimals: number | null;
  packages: readonly HyperliquidOwnedPackage[];
}>;

export type HyperliquidAuthorizationRequest = Readonly<{
  attemptId: string;
  orderHash: string;
  typedData: Readonly<{
    domain: Readonly<Record<string, unknown>>;
    types: Readonly<Record<string, unknown>>;
    primaryType: string;
    message: Readonly<Record<string, unknown>>;
  }>;
}>;

/** Where an execution handoff stands while the shared account runs one package at a time. */
export type HyperliquidAttemptProgress =
  | Readonly<{ state: "QUEUED"; queuePosition: number; lane: string | null }>
  | Readonly<{ state: "EXECUTING" | "UNCERTAIN" | "NOT_STARTED"; lane: string | null }>
  | Readonly<{ state: "COMPLETED"; result: HyperliquidTerminalExecutionResult }>;

export type HyperliquidOrderRecord = Readonly<{
  idempotencyKey: string;
  requestCommitmentHex: string;
  orderHashHex: string;
  orderBase64: string;
  contextId: string;
  domainId: typeof HYPERLIQUID_DOMAIN_ID;
  domainManifestVersion: number;
  domainManifestHashHex: string;
  owner: string;
  settlementAccount: string;
  nonceDecimal: string;
  status: "UNSIGNED_CREATED";
  createdAtMs: number;
  orderBytes: Uint8Array;
}>;

export type HyperliquidOrderCreateResponse = Readonly<{
  status: "UNSIGNED_CREATED";
  created: boolean;
  order: HyperliquidOrderRecord;
  traderAuthorization: "OWNER_EVM_SIGNATURE_REQUIRED";
  solverQuoting: "REQUIRED";
  note: string;
}>;

export type HyperliquidSolverQuote = LocalSolverQuote;

export type HyperliquidSelectedAttempt = Readonly<{
  attemptId: string;
  orderHash: string;
  routeHash: string;
  quoteHash: string;
  status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED";
  selectedAtMs: number;
  domainId: typeof HYPERLIQUID_DOMAIN_ID;
  domainManifestVersion: number;
  domainManifestHash: string;
}>;

export type HyperliquidTerminalExecutionResult = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  domain: typeof HYPERLIQUID_DOMAIN_ID;
  environment: "TESTNET";
  status: string;
  submissionStatus?: "ACKNOWLEDGED" | "REJECTED" | "AMBIGUOUS";
  packageStatus?: "NO_EFFECT" | "COMPLETED_EXACT" | "COMPLETED_BOUNDED" |
    "RECOVERY_REQUIRED" | "MANUAL_INTERVENTION" | "RECONCILING";
  evidenceStatus?: "PRECONDITION_REJECTED" | "JOURNAL_REJECTED";
  reasons?: readonly string[];
  reason?: string;
  actionCommitment?: string | null;
  requestCommitment?: string | null;
  errorCommitment?: string;
  rawEvidenceCommitments?: readonly string[];
  /** The account-wide deltas over the serialized window: exactly this package's fills. */
  observedNetSpotDeltaAtoms?: string;
  observedPerpetualDeltaAtoms?: string;
}>;

export type BaseAccountSetupStep = Readonly<{
  kind: "CREATE_ACCOUNT" | "FUND_ACCOUNT" | "DEPOSIT_MARGIN";
  label: string;
  to: string;
  data: string;
  value: "0";
}>;

/** An owner-signed strategy account call that returns settled funds after an exit. */
export type BaseAccountWithdrawal = Readonly<{
  kind: "WITHDRAW_MARGIN" | "WITHDRAW_QUOTE" | "WITHDRAW_BASE";
  label: string;
  to: string;
  data: string;
  value: "0";
}>;

/** The verifier's open package record for the account, read from chain by the service. */
export type BaseOpenPackage = Readonly<{
  entryReceiptHash: string;
  baseQuantityAtoms: string;
  packageSizeUnits: string;
  entryPerpNotionalWad: string;
}>;

/** The owner's Base Sepolia factory account and the wallet transactions it still needs. */
export type BaseAccountStatus = Readonly<{
  contextId: string;
  owner: string;
  account: string;
  deployed: boolean;
  quoteDecimals: number;
  walletQuoteAtoms: string;
  accountQuoteAtoms: string;
  reserveAtoms: string;
  requiredSpotQuoteAtoms: string;
  requiredMarginAtoms: string;
  fundingCovered: boolean;
  steps: readonly BaseAccountSetupStep[];
  accountBaseAtoms: string;
  openPackage: BaseOpenPackage | null;
  withdrawals: readonly BaseAccountWithdrawal[];
}>;

export type BaseOrderRecord = Readonly<{
  orderHashHex: string;
  contextId: string;
  owner: string;
  settlementAccount: string;
  domainManifestVersion: number;
  domainManifestHashHex: string;
}>;

export type BaseSolverQuote = LocalSolverQuote;

export type BaseSelectedAttempt = Readonly<{
  attemptId: string;
  orderHash: string;
  routeHash: string;
  quoteHash: string;
  status: "BASE_ATOMIC_QUOTE_SELECTED";
  selectedAtMs: number;
}>;

const BASE_ATTEMPT_ID_PATTERN = /^base-atomic-[0-9a-f]{52}$/;
const BASE_SETUP_KINDS = new Set(["CREATE_ACCOUNT", "FUND_ACCOUNT", "DEPOSIT_MARGIN"]);
const BASE_WITHDRAWAL_KINDS = new Set(["WITHDRAW_MARGIN", "WITHDRAW_QUOTE", "WITHDRAW_BASE"]);

/** The service's own refusal reason when it sent one, so the ticket can say what to fix. */
async function serviceFailure(response: Response, label: string): Promise<Error> {
  try {
    const body = await response.json() as unknown;
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string" &&
        body.error.message.length > 0 && body.error.message.length <= 300) {
      return new Error(body.error.message);
    }
  } catch {
    // Fall through to the status code.
  }
  return new Error(`${label} failed with ${response.status}.`);
}

function requireBaseAccountStatus(value: unknown, owner: string): BaseAccountStatus {
  if (!isRecord(value)) throw new Error("Base account status is invalid.");
  requireExactKeys(value, [
    "account", "accountBaseAtoms", "accountQuoteAtoms", "chainReference", "contextId", "deployed", "domainId",
    "environment", "fundingCovered", "openPackage", "owner", "quoteDecimals", "requiredMarginAtoms",
    "requiredSpotQuoteAtoms", "reserveAtoms", "steps", "walletQuoteAtoms", "withdrawals",
  ], "Base account status");
  if (value.domainId !== BASE_SEPOLIA_DOMAIN_ID || value.chainReference !== BASE_SEPOLIA_CHAIN_REFERENCE ||
      value.environment !== "TESTNET" || typeof value.deployed !== "boolean" ||
      typeof value.fundingCovered !== "boolean" || !Array.isArray(value.steps) || !Array.isArray(value.withdrawals) ||
      requireEvmAddress(value.owner, "Base account owner").toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Base account status binding is invalid.");
  }
  const account = requireEvmAddress(value.account, "Base strategy account");
  const walletCall = (step: unknown, kinds: ReadonlySet<string>) => {
    if (!isRecord(step)) throw new Error("Base account setup step is invalid.");
    requireExactKeys(step, ["data", "kind", "label", "to", "value"], "Base account setup step");
    if (!kinds.has(step.kind as string) || step.value !== "0" ||
        typeof step.data !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(step.data)) {
      throw new Error("Base account setup step is invalid.");
    }
    return Object.freeze({
      kind: step.kind as string,
      label: requireString(step.label, "Base setup step label"),
      to: requireEvmAddress(step.to, "Base setup step target"),
      data: step.data,
      value: "0" as const,
    });
  };
  const steps = value.steps.map((step) => walletCall(step, BASE_SETUP_KINDS) as BaseAccountSetupStep);
  // Withdrawals are calls on the owner's own strategy account and nothing else.
  const withdrawals = value.withdrawals.map((step) => {
    const call = walletCall(step, BASE_WITHDRAWAL_KINDS) as BaseAccountWithdrawal;
    if (call.to.toLowerCase() !== account.toLowerCase()) throw new Error("Base withdrawal target is not the strategy account.");
    return call;
  });
  let openPackage: BaseOpenPackage | null = null;
  if (value.openPackage !== null) {
    if (!isRecord(value.openPackage)) throw new Error("Base open package is invalid.");
    requireExactKeys(value.openPackage, [
      "baseQuantityAtoms", "entryPerpNotionalWad", "entryReceiptHash", "packageSizeUnits",
    ], "Base open package");
    const entryReceiptHash = value.openPackage.entryReceiptHash;
    if (typeof entryReceiptHash !== "string" || !/^0x[0-9a-f]{64}$/.test(entryReceiptHash)) {
      throw new Error("Base open package receipt is invalid.");
    }
    openPackage = Object.freeze({
      entryReceiptHash,
      baseQuantityAtoms: requireEvmDecimal(value.openPackage.baseQuantityAtoms, "Base open package size"),
      packageSizeUnits: requireEvmDecimal(value.openPackage.packageSizeUnits, "Base open package units"),
      entryPerpNotionalWad: requireEvmDecimal(value.openPackage.entryPerpNotionalWad, "Base open package notional"),
    });
  }
  return Object.freeze({
    contextId: requireProtocolId(value.contextId, "Base context id"),
    owner: value.owner as string,
    account,
    deployed: value.deployed,
    quoteDecimals: requireInteger(value.quoteDecimals, "Base quote decimals", 36),
    walletQuoteAtoms: requireEvmDecimal(value.walletQuoteAtoms, "Base wallet balance"),
    accountQuoteAtoms: requireEvmDecimal(value.accountQuoteAtoms, "Base account balance"),
    reserveAtoms: requireEvmDecimal(value.reserveAtoms, "Base margin reserve"),
    requiredSpotQuoteAtoms: requireEvmDecimal(value.requiredSpotQuoteAtoms, "Base spot requirement"),
    requiredMarginAtoms: requireEvmDecimal(value.requiredMarginAtoms, "Base margin requirement"),
    fundingCovered: value.fundingCovered,
    steps: Object.freeze(steps),
    accountBaseAtoms: requireEvmDecimal(value.accountBaseAtoms, "Base account base balance"),
    openPackage,
    withdrawals: Object.freeze(withdrawals),
  });
}

function requireBaseOrderCreateResponse(
  value: unknown,
  expected: Readonly<{ contextId: string; owner: string; settlementAccount: string; idempotencyKey: string }>,
): BaseOrderRecord {
  if (!isRecord(value) || !isRecord(value.order) || value.status !== "UNSIGNED_CREATED" ||
      value.traderAuthorization !== "REQUIRED" || value.solverQuoting !== "REQUIRED") {
    throw new Error("Base canonical order response is invalid.");
  }
  const order = value.order;
  const domainManifestVersion = requireInteger(order.domainManifestVersion, "Base order domain manifest version");
  if (order.idempotencyKey !== expected.idempotencyKey || order.contextId !== expected.contextId ||
      order.domainId !== BASE_SEPOLIA_DOMAIN_ID || domainManifestVersion === 0 ||
      order.owner !== expected.owner || order.settlementAccount !== expected.settlementAccount ||
      order.status !== "UNSIGNED_CREATED") {
    throw new Error("Base canonical order does not match the requested owner account.");
  }
  return Object.freeze({
    orderHashHex: requireHex32(order.orderHashHex, "Base order hash"),
    contextId: expected.contextId,
    owner: expected.owner,
    settlementAccount: expected.settlementAccount,
    domainManifestVersion,
    domainManifestHashHex: requireHex32(order.domainManifestHashHex, "Base order domain manifest hash"),
  });
}

function requireBaseSolverQuote(
  value: unknown,
  order: BaseOrderRecord,
  idempotencyKey: string,
): BaseSolverQuote {
  const quote = requireSolverQuote(value, order.orderHashHex, idempotencyKey, "testnet", "ATOMIC_POSTCONDITION");
  if (quote.route.routeExpiryUnit !== "EVM_UNIX_SECONDS" || quote.quote.validUntilUnit !== "EVM_UNIX_SECONDS" ||
      quote.route.executionPlanKind !== "EVM_ATOMIC_BATCH" ||
      quote.route.settlementAccount !== order.settlementAccount || quote.route.owner !== order.owner) {
    throw new Error("Base quote is not bound to the owner's strategy account.");
  }
  return quote;
}

function requireBaseSelectedAttempt(value: unknown, quote: BaseSolverQuote): BaseSelectedAttempt {
  if (!isRecord(value) || value.status !== "BASE_ATOMIC_QUOTE_SELECTED" || !isRecord(value.attempt)) {
    throw new Error("Base quote selection response is invalid.");
  }
  requireExactKeys(value.attempt, [
    "attemptId", "domainId", "domainManifestHash", "domainManifestVersion", "orderHash",
    "quoteHash", "routeHash", "selectedAtMs", "status",
  ], "Base selected attempt");
  const attempt = value.attempt;
  const selectedAtMs = requireInteger(attempt.selectedAtMs, "Base selection time");
  if (attempt.orderHash !== quote.orderHash || attempt.routeHash !== quote.routeHash ||
      attempt.quoteHash !== quote.quoteHash || attempt.status !== "BASE_ATOMIC_QUOTE_SELECTED" ||
      attempt.domainId !== BASE_SEPOLIA_DOMAIN_ID || selectedAtMs === 0 ||
      typeof attempt.attemptId !== "string" || !BASE_ATTEMPT_ID_PATTERN.test(attempt.attemptId)) {
    throw new Error("Base selected attempt binding is invalid.");
  }
  return Object.freeze({
    attemptId: attempt.attemptId,
    orderHash: quote.orderHash,
    routeHash: quote.routeHash,
    quoteHash: quote.quoteHash,
    status: "BASE_ATOMIC_QUOTE_SELECTED",
    selectedAtMs,
  });
}

/** Unsigned wallet call the Arbitrum owner routes hand back; its value is decimal wei. */
export type ArbitrumWalletCall = Readonly<{ to: string; data: string; value: string }>;

/** The package the owner's factory account holds, read from chain on every status request. */
export type ArbitrumOpenPackage = Readonly<{
  packageId: string;
  entryRequestKey: string | null;
  entryExecuted: boolean;
  /** The GMX short's size in 30-decimal USD. */
  positionSizeUsd: string;
  spotBaseAtoms: string;
  /** An exit already submitted and not yet terminal. */
  activeExitRequestKey: string | null;
  exitable: boolean;
}>;

/** The owner's Arbitrum Sepolia factory account, and the creation call when it is not deployed yet. */
export type ArbitrumAccountStatus = Readonly<{
  owner: string;
  account: string;
  accountFactory: string;
  deployed: boolean;
  createAccount: Readonly<{ to: string; data: string; value: "0" }> | null;
  openPackage: ArbitrumOpenPackage | null;
}>;

/** The canonical EXIT order for the open package, with the minimums it signs. Atoms are decimal strings. */
export type ArbitrumExitOrder = Readonly<{
  order: BaseOrderRecord;
  packageId: string;
  quantityAtoms: string;
  limits: Readonly<{
    entryNotionalAtoms: string;
    minSpotQuoteOutAtoms: string;
    minPerpOutputAtoms: string;
    minExitQuoteOutcomeAtoms: string;
  }>;
}>;

/** The EIP-712 fields of the exit controller's ExitAuthorization, in its typehash order. */
const ARBITRUM_EXIT_FIELDS = [
  ["packageId", "bytes32"], ["entryRequestKey", "bytes32"], ["spotRegistrationHash", "bytes32"],
  ["account", "address"], ["owner", "address"], ["receiver", "address"], ["spotProceedsRecipient", "address"],
  ["feePayer", "address"], ["executionFeeRefundRecipient", "address"], ["market", "address"],
  ["collateralToken", "address"], ["isLong", "bool"], ["fullCloseSizeUsd", "uint256"], ["spotBaseAtoms", "uint256"],
  ["spotMinQuoteAtoms", "uint256"], ["packageNonce", "uint256"], ["exitOrderHash", "bytes32"],
  ["exitQuoteHash", "bytes32"], ["exitRouteHash", "bytes32"], ["exitFillCommitment", "bytes32"],
  ["acceptablePrice", "uint256"], ["minOutputAmount", "uint256"], ["executionFeeWei", "uint256"],
  ["callbackGasLimit", "uint256"], ["authorizationExpiry", "uint64"], ["cancelAfter", "uint64"], ["nonce", "uint256"],
] as const;

/** The full close the owner's wallet signs: the solver pays the GMX fee, every proceed goes to the owner. */
export type ArbitrumExitAuthorization = Readonly<{
  attemptId: string;
  packageId: string;
  owner: string;
  account: string;
  exitController: string;
  typedData: Readonly<{
    domain: Readonly<{ name: "Naryx GMX V2 Exit"; version: "1"; chainId: 421614; verifyingContract: string }>;
    types: Readonly<{ ExitAuthorization: readonly Readonly<{ name: string; type: string }>[] }>;
    primaryType: "ExitAuthorization";
    message: Readonly<Record<string, string | boolean>>;
  }>;
  digest: string;
  signed: boolean;
}>;

/** The reviewed exit as the wallet signs it, with integer fields as bigint. */
export function arbitrumExitWalletTypedData(authorization: ArbitrumExitAuthorization) {
  return {
    ...authorization.typedData,
    message: Object.fromEntries(ARBITRUM_EXIT_FIELDS.map(([name, type]) => {
      const value = authorization.typedData.message[name];
      return [name, type.startsWith("uint") ? BigInt(value as string) : value];
    })),
  };
}

/**
 * Binds the solver's prepared exit to the attempt, the wallet, and its open package: the exact
 * fields, the attempt's own hashes, owner-only proceeds, and a digest recomputed from the message.
 */
function requireArbitrumExitAuthorization(
  value: unknown,
  expected: Readonly<{ attempt: ArbitrumSelectedAttempt; owner: string; account: string; packageId: string; signed: boolean | null }>,
): ArbitrumExitAuthorization {
  if (!isRecord(value)) throw new Error("Arbitrum exit authorization is invalid.");
  requireExactKeys(value, [
    "version", "attemptId", "packageId", "chainId", "owner", "account", "exitController", "typedData", "digest", "signed",
  ], "Arbitrum exit authorization");
  const typedData = value.typedData;
  if (value.version !== 1 || value.attemptId !== expected.attempt.attemptId || value.chainId !== 421614 ||
      typeof value.signed !== "boolean" || (expected.signed !== null && value.signed !== expected.signed) ||
      !isRecord(typedData) || !isRecord(typedData.domain) || !isRecord(typedData.types) || !isRecord(typedData.message) ||
      typedData.primaryType !== "ExitAuthorization") {
    throw new Error("Arbitrum exit authorization binding is invalid.");
  }
  requireExactKeys(typedData, ["domain", "types", "primaryType", "message"], "Arbitrum exit typed data");
  requireExactKeys(typedData.domain, ["name", "version", "chainId", "verifyingContract"], "Arbitrum exit domain");
  requireExactKeys(typedData.types, ["ExitAuthorization"], "Arbitrum exit types");
  requireExactKeys(typedData.message, ARBITRUM_EXIT_FIELDS.map(([name]) => name), "Arbitrum exit message");
  const fields = typedData.types.ExitAuthorization;
  const exitController = requireEvmAddress(value.exitController, "Arbitrum exit controller");
  if (typedData.domain.name !== "Naryx GMX V2 Exit" || typedData.domain.version !== "1" || typedData.domain.chainId !== 421614 ||
      typedData.domain.verifyingContract !== exitController || !Array.isArray(fields) ||
      fields.length !== ARBITRUM_EXIT_FIELDS.length || fields.some((field, index) => !isRecord(field) ||
        Object.keys(field).length !== 2 || field.name !== ARBITRUM_EXIT_FIELDS[index]![0] ||
        field.type !== ARBITRUM_EXIT_FIELDS[index]![1])) {
    throw new Error("Arbitrum exit typed data is invalid.");
  }
  const message: Record<string, string | boolean> = {};
  for (const [name, type] of ARBITRUM_EXIT_FIELDS) {
    const field = typedData.message[name];
    message[name] = type === "bytes32" ? requireEvmHash(field, `Arbitrum exit ${name}`)
      : type === "address" ? requireEvmAddress(field, `Arbitrum exit ${name}`).toLowerCase()
        : type === "bool" ? (() => { if (typeof field !== "boolean") throw new Error(`Arbitrum exit ${name} is invalid.`); return field; })()
          : requireEvmDecimal(field, `Arbitrum exit ${name}`);
  }
  const owner = expected.owner.toLowerCase();
  const { attempt } = expected;
  if (!sameAddress(requireEvmAddress(value.owner, "Arbitrum exit owner"), owner) ||
      !sameAddress(requireEvmAddress(value.account, "Arbitrum exit account"), expected.account) ||
      value.packageId !== expected.packageId || message.packageId !== expected.packageId ||
      message.owner !== owner || message.receiver !== owner || message.spotProceedsRecipient !== owner ||
      !sameAddress(message.account as string, expected.account) || message.isLong !== false ||
      message.exitOrderHash !== `0x${attempt.orderHash}` || message.exitQuoteHash !== `0x${attempt.quoteHash}` ||
      message.exitRouteHash !== `0x${attempt.routeHash}`) {
    throw new Error("Arbitrum exit authorization is not for this wallet's open package and attempt.");
  }
  const authorization: ArbitrumExitAuthorization = Object.freeze({
    attemptId: attempt.attemptId,
    packageId: expected.packageId,
    owner,
    account: expected.account,
    exitController,
    typedData: Object.freeze({
      domain: Object.freeze({ name: "Naryx GMX V2 Exit", version: "1", chainId: 421614, verifyingContract: exitController }),
      types: Object.freeze({ ExitAuthorization: ARBITRUM_EXIT_FIELDS.map(([name, type]) => Object.freeze({ name, type })) }),
      primaryType: "ExitAuthorization",
      message: Object.freeze(message),
    }),
    digest: requireEvmHash(value.digest, "Arbitrum exit digest"),
    signed: value.signed,
  });
  if (hashTypedData(arbitrumExitWalletTypedData(authorization) as never).toLowerCase() !== authorization.digest) {
    throw new Error("Arbitrum exit digest does not match its typed data.");
  }
  return authorization;
}

export type ArbitrumOrderRecord = BaseOrderRecord;
export type ArbitrumSolverQuote = LocalSolverQuote;

export type ArbitrumSelectedAttempt = Readonly<{
  attemptId: string;
  orderHash: string;
  routeHash: string;
  quoteHash: string;
  status: "ARBITRUM_ASYNC_QUOTE_SELECTED";
  selectedAtMs: number;
}>;

/** The reservation the owner signs and the exact funding the adapter pulls, prepared by the solver. */
export type ArbitrumOwnerAuthorization = Readonly<{
  attemptId: string;
  packageId: string;
  chainId: 421614;
  owner: string;
  account: string;
  accountFactory: string;
  coordinator: string;
  adapter: string;
  typedData: Readonly<{
    domain: Readonly<{ name: "Naryx Async Bonded Package"; version: "1"; chainId: 421614; verifyingContract: string }>;
    types: Readonly<{ ReserveAsyncPackage: readonly [Readonly<{ name: "termsHash"; type: "bytes32" }>] }>;
    primaryType: "ReserveAsyncPackage";
    message: Readonly<{ termsHash: string }>;
  }>;
  digest: string;
  signed: boolean;
  funding: Readonly<{
    token: string;
    spender: string;
    approveAtoms: string;
    collateralAtoms: string;
    spotQuoteAtoms: string;
    executionFeeWei: string;
    fundRequest: ArbitrumWalletCall;
    reclaimAfterUnixSeconds: string;
  }>;
  summary: Readonly<{
    nonce: string;
    sizeDeltaUsd: string;
    acceptablePrice: string;
    spotBaseAtoms: string;
    rollbackMinQuoteAtoms: string;
    bondAtoms: string;
    submissionDeadline: string;
    venueDeadline: string;
    recoveryDeadline: string;
    solver: string;
  }>;
}>;

/** An observe-async refusal; the caller decides whether a 502 before reservation is still pending. */
export class ArbitrumObservationError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Arbitrum async observation failed with ${status}.`);
    this.name = "ArbitrumObservationError";
    this.status = status;
  }
}

const ARBITRUM_ATTEMPT_ID_PATTERN = /^arbitrum-async-[0-9a-f]{48}$/;
const ARBITRUM_CALLDATA_PATTERN = /^0x(?:[0-9a-f]{2}){4,4096}$/;
const ARBITRUM_SUMMARY_DECIMALS = [
  "nonce", "sizeDeltaUsd", "acceptablePrice", "spotBaseAtoms", "rollbackMinQuoteAtoms", "bondAtoms",
  "submissionDeadline", "venueDeadline", "recoveryDeadline",
] as const;
const ARBITRUM_FACTORY_ABI = parseAbi(["function create(address owner) returns (address)"]);
const ARBITRUM_ADAPTER_ABI = parseAbi([
  "struct SpotEntry { address fundingOwner; address port; bytes32 portCodeHash; address baseToken; address quoteToken; uint256 baseAtoms; uint256 maxQuoteAtoms; uint256 rollbackMinQuoteAtoms; bytes32 entryFillCommitment; bytes32 rollbackFillCommitment; }",
  "struct VenueRequest { bytes32 marketId; address collateralToken; int256 sizeDelta; uint256 collateralAtoms; uint256 acceptablePrice; uint256 executionFeeWei; uint256 callbackGasLimit; uint256 packageNonce; bytes32 orderHash; bytes32 quoteHash; bytes32 routeHash; SpotEntry spot; uint64 submissionDeadline; uint64 venueDeadline; uint64 recoveryDeadline; }",
  "function fundRequest(bytes32 packageId, VenueRequest venueRequest) payable",
]);

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requireArbitrumCalldata(value: unknown, name: string): string {
  if (typeof value !== "string" || !ARBITRUM_CALLDATA_PATTERN.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function requireArbitrumAccountStatus(value: unknown, owner: string): ArbitrumAccountStatus {
  if (!isRecord(value)) throw new Error("Arbitrum account status is invalid.");
  requireExactKeys(value, [
    "version", "domainId", "chainId", "owner", "account", "accountFactory", "deployed", "createAccount", "openPackage",
  ], "Arbitrum account status");
  if (value.version !== 1 || value.domainId !== ARBITRUM_SEPOLIA_DOMAIN_ID ||
      value.chainId !== Number(ARBITRUM_SEPOLIA_CHAIN_REFERENCE) || typeof value.deployed !== "boolean" ||
      !sameAddress(requireEvmAddress(value.owner, "Arbitrum account owner"), owner)) {
    throw new Error("Arbitrum account status binding is invalid.");
  }
  const account = requireEvmAddress(value.account, "Arbitrum strategy account");
  const accountFactory = requireEvmAddress(value.accountFactory, "Arbitrum account factory");
  let createAccount: ArbitrumAccountStatus["createAccount"] = null;
  if (value.deployed) {
    if (value.createAccount !== null) throw new Error("Arbitrum account status is inconsistent.");
  } else {
    const call = value.createAccount;
    if (!isRecord(call)) throw new Error("Arbitrum account creation call is invalid.");
    requireExactKeys(call, ["to", "data", "value"], "Arbitrum account creation call");
    const data = requireArbitrumCalldata(call.data, "Arbitrum account creation calldata");
    if (call.value !== "0" || !sameAddress(requireEvmAddress(call.to, "Arbitrum factory target"), accountFactory)) {
      throw new Error("Arbitrum account creation call is invalid.");
    }
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: ARBITRUM_FACTORY_ABI, data: data as `0x${string}` });
    } catch {
      decoded = undefined;
    }
    if (decoded?.functionName !== "create" || !sameAddress(String(decoded.args[0]), owner)) {
      throw new Error("Arbitrum account creation call is not for this wallet.");
    }
    createAccount = Object.freeze({ to: call.to as string, data, value: "0" as const });
  }
  let openPackage: ArbitrumOpenPackage | null = null;
  if (value.openPackage !== null) {
    const open = value.openPackage;
    if (!isRecord(open) || !value.deployed) throw new Error("Arbitrum open package is invalid.");
    requireExactKeys(open, [
      "packageId", "entryRequestKey", "entryExecuted", "positionSizeUsd", "spotBaseAtoms", "activeExitRequestKey", "exitable",
    ], "Arbitrum open package");
    if (typeof open.entryExecuted !== "boolean" || typeof open.exitable !== "boolean") {
      throw new Error("Arbitrum open package is invalid.");
    }
    openPackage = Object.freeze({
      packageId: requireEvmHash(open.packageId, "Arbitrum open package id"),
      entryRequestKey: open.entryRequestKey === null ? null : requireEvmHash(open.entryRequestKey, "Arbitrum entry request key"),
      entryExecuted: open.entryExecuted,
      positionSizeUsd: requireEvmDecimal(open.positionSizeUsd, "Arbitrum position size"),
      spotBaseAtoms: requireEvmDecimal(open.spotBaseAtoms, "Arbitrum spot inventory"),
      activeExitRequestKey: open.activeExitRequestKey === null ? null : requireEvmHash(open.activeExitRequestKey, "Arbitrum active exit"),
      exitable: open.exitable,
    });
  }
  return Object.freeze({
    owner: (value.owner as string).toLowerCase(),
    account: account.toLowerCase(),
    accountFactory: accountFactory.toLowerCase(),
    deployed: value.deployed,
    createAccount,
    openPackage,
  });
}

function requireEvmOrderCreateResponse(
  value: unknown,
  expected: Readonly<{ contextId: string; owner: string; settlementAccount: string; idempotencyKey: string }>,
  domainId: string,
  label: string,
): BaseOrderRecord {
  if (!isRecord(value) || !isRecord(value.order) || value.status !== "UNSIGNED_CREATED" ||
      value.traderAuthorization !== "REQUIRED" || value.solverQuoting !== "REQUIRED") {
    throw new Error(`${label} canonical order response is invalid.`);
  }
  const order = value.order;
  const domainManifestVersion = requireInteger(order.domainManifestVersion, `${label} order domain manifest version`);
  if (order.idempotencyKey !== expected.idempotencyKey || order.contextId !== expected.contextId ||
      order.domainId !== domainId || domainManifestVersion === 0 ||
      order.owner !== expected.owner || order.settlementAccount !== expected.settlementAccount ||
      order.status !== "UNSIGNED_CREATED") {
    throw new Error(`${label} canonical order does not match the requested owner account.`);
  }
  return Object.freeze({
    orderHashHex: requireHex32(order.orderHashHex, `${label} order hash`),
    contextId: expected.contextId,
    owner: expected.owner,
    settlementAccount: expected.settlementAccount,
    domainManifestVersion,
    domainManifestHashHex: requireHex32(order.domainManifestHashHex, `${label} order domain manifest hash`),
  });
}

function requireArbitrumSolverQuote(
  value: unknown,
  order: ArbitrumOrderRecord,
  idempotencyKey: string,
): ArbitrumSolverQuote {
  const quote = requireSolverQuote(value, order.orderHashHex, idempotencyKey, "testnet", "ASYNC_BONDED_SOLVER");
  if (quote.route.routeExpiryUnit !== "EVM_UNIX_SECONDS" || quote.quote.validUntilUnit !== "EVM_UNIX_SECONDS" ||
      quote.route.executionPlanKind !== "EVM_ASYNC_REQUEST" ||
      typeof quote.route.settlementAccount !== "string" || typeof quote.route.owner !== "string" ||
      !sameAddress(quote.route.settlementAccount, order.settlementAccount) ||
      !sameAddress(quote.route.owner, order.owner)) {
    throw new Error("Arbitrum quote is not bound to the owner's strategy account.");
  }
  return quote;
}

function requireArbitrumSelectedAttempt(value: unknown, quote: ArbitrumSolverQuote): ArbitrumSelectedAttempt {
  if (!isRecord(value) || value.status !== "ARBITRUM_ASYNC_QUOTE_SELECTED" || !isRecord(value.attempt)) {
    throw new Error("Arbitrum quote selection response is invalid.");
  }
  requireExactKeys(value.attempt, [
    "attemptId", "domainId", "domainManifestHash", "domainManifestVersion", "orderHash",
    "quoteHash", "routeHash", "selectedAtMs", "status",
  ], "Arbitrum selected attempt");
  const attempt = value.attempt;
  const selectedAtMs = requireInteger(attempt.selectedAtMs, "Arbitrum selection time");
  if (attempt.orderHash !== quote.orderHash || attempt.routeHash !== quote.routeHash ||
      attempt.quoteHash !== quote.quoteHash || attempt.status !== "ARBITRUM_ASYNC_QUOTE_SELECTED" ||
      attempt.domainId !== ARBITRUM_SEPOLIA_DOMAIN_ID || selectedAtMs === 0 ||
      typeof attempt.attemptId !== "string" || !ARBITRUM_ATTEMPT_ID_PATTERN.test(attempt.attemptId)) {
    throw new Error("Arbitrum selected attempt binding is invalid.");
  }
  return Object.freeze({
    attemptId: attempt.attemptId,
    orderHash: quote.orderHash,
    routeHash: quote.routeHash,
    quoteHash: quote.quoteHash,
    status: "ARBITRUM_ASYNC_QUOTE_SELECTED",
    selectedAtMs,
  });
}

/**
 * Binds the solver's prepared reservation to the attempt, the wallet, and its factory account, then
 * recomputes the EIP-712 digest and decodes the funding call so the wallet is never asked to sign
 * or send anything other than what the review shows.
 */
function requireArbitrumOwnerAuthorization(
  value: unknown,
  expected: Readonly<{ attemptId: string; owner: string; account: string; signed: boolean | null }>,
): ArbitrumOwnerAuthorization {
  if (!isRecord(value)) throw new Error("Arbitrum owner authorization is invalid.");
  requireExactKeys(value, [
    "version", "attemptId", "packageId", "chainId", "owner", "account", "accountFactory", "coordinator",
    "adapter", "typedData", "digest", "signed", "funding", "summary",
  ], "Arbitrum owner authorization");
  if (value.version !== 1 || value.attemptId !== expected.attemptId ||
      value.chainId !== Number(ARBITRUM_SEPOLIA_CHAIN_REFERENCE) || typeof value.signed !== "boolean" ||
      (expected.signed !== null && value.signed !== expected.signed)) {
    throw new Error("Arbitrum owner authorization binding is invalid.");
  }
  const owner = requireEvmAddress(value.owner, "Arbitrum authorization owner");
  const account = requireEvmAddress(value.account, "Arbitrum authorization account");
  if (!sameAddress(owner, expected.owner) || !sameAddress(account, expected.account)) {
    throw new Error("Arbitrum owner authorization is not for this wallet's strategy account.");
  }
  const packageId = requireEvmHash(value.packageId, "Arbitrum package id");
  const coordinator = requireEvmAddress(value.coordinator, "Arbitrum coordinator");
  const adapter = requireEvmAddress(value.adapter, "Arbitrum adapter");
  const accountFactory = requireEvmAddress(value.accountFactory, "Arbitrum account factory");

  const typedData = value.typedData;
  if (!isRecord(typedData)) throw new Error("Arbitrum typed data is invalid.");
  requireExactKeys(typedData, ["domain", "types", "primaryType", "message"], "Arbitrum typed data");
  if (!isRecord(typedData.domain) || !isRecord(typedData.types) || !isRecord(typedData.message) ||
      typedData.primaryType !== "ReserveAsyncPackage") {
    throw new Error("Arbitrum typed data is invalid.");
  }
  requireExactKeys(typedData.domain, ["name", "version", "chainId", "verifyingContract"], "Arbitrum typed data domain");
  requireExactKeys(typedData.types, ["ReserveAsyncPackage"], "Arbitrum typed data types");
  requireExactKeys(typedData.message, ["termsHash"], "Arbitrum reservation");
  const fields = typedData.types.ReserveAsyncPackage;
  if (typedData.domain.name !== "Naryx Async Bonded Package" || typedData.domain.version !== "1" ||
      typedData.domain.chainId !== Number(ARBITRUM_SEPOLIA_CHAIN_REFERENCE) ||
      !sameAddress(requireEvmAddress(typedData.domain.verifyingContract, "Arbitrum verifier"), coordinator) ||
      !Array.isArray(fields) || fields.length !== 1 || !isRecord(fields[0]) ||
      Object.keys(fields[0]).length !== 2 || fields[0].name !== "termsHash" || fields[0].type !== "bytes32") {
    throw new Error("Arbitrum typed data is invalid.");
  }
  const termsHash = requireEvmHash(typedData.message.termsHash, "Arbitrum terms hash");
  const verifyingContract = typedData.domain.verifyingContract as string;
  const digest = requireEvmHash(value.digest, "Arbitrum reservation digest");
  const recomputed = hashTypedData({
    domain: { name: "Naryx Async Bonded Package", version: "1", chainId: 421614, verifyingContract: verifyingContract as `0x${string}` },
    types: { ReserveAsyncPackage: [{ name: "termsHash", type: "bytes32" }] },
    primaryType: "ReserveAsyncPackage",
    message: { termsHash: termsHash as `0x${string}` },
  });
  if (recomputed.toLowerCase() !== digest) throw new Error("Arbitrum reservation digest does not match its typed data.");

  const funding = value.funding;
  if (!isRecord(funding)) throw new Error("Arbitrum funding is invalid.");
  requireExactKeys(funding, [
    "token", "spender", "approveAtoms", "collateralAtoms", "spotQuoteAtoms", "executionFeeWei",
    "fundRequest", "reclaimAfterUnixSeconds",
  ], "Arbitrum funding");
  const token = requireEvmAddress(funding.token, "Arbitrum collateral token");
  const spender = requireEvmAddress(funding.spender, "Arbitrum funding spender");
  const approveAtoms = requireEvmDecimal(funding.approveAtoms, "Arbitrum approval amount");
  const collateralAtoms = requireEvmDecimal(funding.collateralAtoms, "Arbitrum collateral amount");
  const spotQuoteAtoms = requireEvmDecimal(funding.spotQuoteAtoms, "Arbitrum spot quote amount");
  const executionFeeWei = requireEvmDecimal(funding.executionFeeWei, "Arbitrum execution fee");
  const reclaimAfterUnixSeconds = requireEvmDecimal(funding.reclaimAfterUnixSeconds, "Arbitrum reclaim time");
  if (!sameAddress(spender, adapter) || BigInt(approveAtoms) === BigInt(0) ||
      BigInt(approveAtoms) !== BigInt(collateralAtoms) + BigInt(spotQuoteAtoms) ||
      BigInt(reclaimAfterUnixSeconds) === BigInt(0)) {
    throw new Error("Arbitrum funding amounts are invalid.");
  }
  const fundRequest = funding.fundRequest;
  if (!isRecord(fundRequest)) throw new Error("Arbitrum funding call is invalid.");
  requireExactKeys(fundRequest, ["to", "data", "value"], "Arbitrum funding call");
  const fundData = requireArbitrumCalldata(fundRequest.data, "Arbitrum funding calldata");
  const fundValue = requireEvmDecimal(fundRequest.value, "Arbitrum funding call value");
  if (!sameAddress(requireEvmAddress(fundRequest.to, "Arbitrum funding target"), spender) || fundValue !== executionFeeWei) {
    throw new Error("Arbitrum funding call is invalid.");
  }
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: ARBITRUM_ADAPTER_ABI, data: fundData as `0x${string}` });
  } catch {
    decoded = undefined;
  }
  const request = decoded?.args?.[1] as {
    collateralToken?: string; collateralAtoms?: bigint; executionFeeWei?: bigint;
    spot?: { fundingOwner?: string; maxQuoteAtoms?: bigint };
  } | undefined;
  if (decoded?.functionName !== "fundRequest" || String(decoded.args?.[0]).toLowerCase() !== packageId ||
      typeof request?.spot?.fundingOwner !== "string" || !sameAddress(request.spot.fundingOwner, owner) ||
      typeof request.collateralToken !== "string" || !sameAddress(request.collateralToken, token) ||
      request.collateralAtoms !== BigInt(collateralAtoms) || request.spot.maxQuoteAtoms !== BigInt(spotQuoteAtoms) ||
      request.executionFeeWei !== BigInt(executionFeeWei)) {
    throw new Error("Arbitrum funding call does not match the reviewed funding.");
  }

  const summary = value.summary;
  if (!isRecord(summary)) throw new Error("Arbitrum reservation summary is invalid.");
  requireExactKeys(summary, [...ARBITRUM_SUMMARY_DECIMALS, "solver"], "Arbitrum reservation summary");
  const checkedSummary: Record<string, string> = { solver: requireEvmAddress(summary.solver, "Arbitrum solver") };
  for (const key of ARBITRUM_SUMMARY_DECIMALS) checkedSummary[key] = requireEvmDecimal(summary[key], `Arbitrum ${key}`);

  return Object.freeze({
    attemptId: expected.attemptId,
    packageId,
    chainId: 421614,
    owner,
    account,
    accountFactory,
    coordinator,
    adapter,
    typedData: Object.freeze({
      domain: Object.freeze({ name: "Naryx Async Bonded Package", version: "1", chainId: 421614, verifyingContract }),
      types: Object.freeze({ ReserveAsyncPackage: Object.freeze([Object.freeze({ name: "termsHash", type: "bytes32" })] as const) }),
      primaryType: "ReserveAsyncPackage",
      message: Object.freeze({ termsHash }),
    }),
    digest,
    signed: value.signed,
    funding: Object.freeze({
      token,
      spender,
      approveAtoms,
      collateralAtoms,
      spotQuoteAtoms,
      executionFeeWei,
      fundRequest: Object.freeze({ to: fundRequest.to as string, data: fundData, value: fundValue }),
      reclaimAfterUnixSeconds,
    }),
    summary: Object.freeze(checkedSummary) as ArbitrumOwnerAuthorization["summary"],
  });
}

const PACKAGE_LIFECYCLE_STATES = new Set<PackageLifecycleState>([
  "PACKAGE_CREATED",
  "ENTRY_PREPARED",
  "ENTRY_SUBMITTED",
  "ENTRY_CONFIRMED",
  "OPEN",
  "EXIT_REQUESTED",
  "EXIT_SUBMITTED",
  "RECOVERY_PENDING",
  "MANUAL_INTERVENTION",
  "CLOSED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
]);
const PACKAGE_EVIDENCE_GRADES = new Set<PackageEvidenceGrade>([
  "LOCAL_RECORDED",
  "CONTROLLER_ATTESTED",
  "VENUE_CORROBORATED",
  "CONSENSUS_VERIFIED",
]);
const SETTLEMENT_CLASSES = new Set<PackageLifecycleReceipt["settlementClass"]>([
  "ATOMIC_POSTCONDITION",
  "BATCHED_IOC_WITH_RECOVERY",
  "ASYNC_BONDED_SOLVER",
]);
const CANONICAL_UNSIGNED_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RUNTIME_HEALTH_REASONS = new Set([
  "DISABLED_BY_CONFIGURATION",
  "RUNTIME_FACTORY_NOT_INJECTED",
  "RUNTIME_INITIALIZATION_FAILED",
  "REQUIRED_PORTS_MISSING",
]);

function requireRuntimeBoundaryHealth(value: unknown, name: string): RuntimeBoundaryHealth {
  if (!isRecord(value)) throw new Error(`${name} is invalid.`);
  requireExactKeys(value, ["available", "reason"], name);
  if (typeof value.available !== "boolean" ||
      (value.reason !== null &&
        (typeof value.reason !== "string" || !RUNTIME_HEALTH_REASONS.has(value.reason)))) {
    throw new Error(`${name} is invalid.`);
  }
  if (value.available !== (value.reason === null)) throw new Error(`${name} is inconsistent.`);
  return Object.freeze({
    available: value.available,
    reason: value.reason as RuntimeBoundaryHealth["reason"],
  });
}

function requireRuntimeHealth(
  value: unknown,
): Omit<PrivateTerminalRuntimeHealth, "controls"> {
  if (!isRecord(value)) throw new Error("Private terminal health is invalid.");
  requireExactKeys(
    value,
    ["solanaDevnet", "baseTestnetAtomic", "arbitrumTestnetAsync", "hyperliquidTestnet"],
    "Private terminal health",
  );
  return Object.freeze({
    solanaDevnet: requireRuntimeBoundaryHealth(value.solanaDevnet, "Solana Devnet health"),
    baseTestnetAtomic: requireRuntimeBoundaryHealth(value.baseTestnetAtomic, "Base Testnet health"),
    arbitrumTestnetAsync: requireRuntimeBoundaryHealth(value.arbitrumTestnetAsync, "Arbitrum Testnet health"),
    hyperliquidTestnet: requireRuntimeBoundaryHealth(value.hyperliquidTestnet, "Hyperliquid Testnet health"),
  });
}

function requireHealthFlag(value: Record<string, unknown>, key: string): boolean {
  if (typeof value[key] !== "boolean") throw new Error(`Private terminal ${key} is invalid.`);
  return value[key];
}

function requireRuntimeControls(value: Record<string, unknown>): PrivateTerminalRuntimeHealth["controls"] {
  if (value.localAtomicRuntimeMode !== "PHASE4_FIXTURE" &&
      value.localAtomicRuntimeMode !== "MANIFEST_VALIDATED" &&
      value.localAtomicRuntimeMode !== "DISABLED") {
    throw new Error("Private terminal local runtime mode is invalid.");
  }
  return Object.freeze({
    localAtomicRuntimeMode: value.localAtomicRuntimeMode,
    executionReadinessAvailable: requireHealthFlag(value, "executionReadinessAvailable"),
    lifecycleReadAvailable: requireHealthFlag(value, "lifecycleReadAvailable"),
    solverQuotingAvailable: requireHealthFlag(value, "solverQuotingAvailable"),
    executionIntentAvailable: requireHealthFlag(value, "executionIntentAvailable"),
    localExecutionAvailable: requireHealthFlag(value, "localExecutionAvailable"),
    solanaLocalExecutionAvailable: requireHealthFlag(value, "solanaLocalExecutionAvailable"),
  });
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} fields are invalid.`);
  }
}

function requireKeysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || actual.some((key) => !allowed.has(key))) {
    throw new Error(`${name} fields are invalid.`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requireInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${name} is invalid.`);
  }
  return value as number;
}

function requireHex32(value: unknown, name: string): string {
  const hex = requireString(value, name);
  if (!/^[0-9a-f]{64}$/.test(hex) || /^0{64}$/.test(hex)) {
    throw new Error(`${name} is invalid.`);
  }
  return hex;
}

function requireProtocolId(value: unknown, name: string): string {
  const id = requireString(value, name);
  if (id.length > 128 || !/^[\x00-\x7f]+$/.test(id)) {
    throw new Error(`${name} is invalid.`);
  }
  return id;
}

function requireCanonicalUnsigned(value: unknown, name: string, positive: boolean): string {
  if (typeof value !== "string" || !CANONICAL_UNSIGNED_PATTERN.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_SAFE_INTEGER_BIGINT || (positive && parsed === BigInt(0))) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requireLifecycleState(value: unknown, name: string): PackageLifecycleState {
  if (typeof value !== "string" || !PACKAGE_LIFECYCLE_STATES.has(value as PackageLifecycleState)) {
    throw new Error(`${name} is invalid.`);
  }
  return value as PackageLifecycleState;
}

function requireEvidenceGrade(value: unknown): PackageEvidenceGrade {
  if (typeof value !== "string" || !PACKAGE_EVIDENCE_GRADES.has(value as PackageEvidenceGrade)) {
    throw new Error("Lifecycle evidence grade is invalid.");
  }
  return value as PackageEvidenceGrade;
}

function requireBase58Bytes32(value: unknown, name: string): string {
  const encoded = requireString(value, name);
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(encoded);
  } catch {
    throw new Error(`${name} is invalid.`);
  }
  if (decoded.length !== 32 || bs58.encode(decoded) !== encoded) {
    throw new Error(`${name} is invalid.`);
  }
  return encoded;
}

function decodeCanonicalBase64(value: unknown, name: string): Uint8Array {
  const encoded = requireString(value, name);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`${name} is invalid.`);
  }
  const decoded = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const canonical = btoa(String.fromCharCode(...decoded));
  if (canonical !== encoded) {
    throw new Error(`${name} is not canonical.`);
  }
  return decoded;
}

function bytesEqual(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function requireStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${name} is invalid.`);
  }
  return Object.freeze([...value]);
}

function requireLifecycleAttemptId(value: unknown): string {
  if (typeof value !== "string" ||
      (!LIFECYCLE_ATTEMPT_ID_PATTERN.test(value) && !LOCAL_ATTEMPT_ID_PATTERN.test(value) &&
        !BASE_ATTEMPT_ID_PATTERN.test(value))) {
    throw new Error("Lifecycle attempt id is invalid.");
  }
  return value;
}

function requireLocalAttemptId(value: unknown): string {
  if (typeof value !== "string" || !LOCAL_ATTEMPT_ID_PATTERN.test(value)) {
    throw new Error("Local execution attempt id is invalid.");
  }
  return value;
}

function requireCanonicalBase58Signature(value: unknown, name: string): string {
  const signature = requireString(value, name);
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(signature);
  } catch {
    throw new Error(`${name} is invalid.`);
  }
  if (decoded.length !== 64 || bs58.encode(decoded) !== signature) {
    throw new Error(`${name} is invalid.`);
  }
  return signature;
}

function requireLocalOrderRecord(
  value: unknown,
  expected: { owner: string; settlementAccount: string; idempotencyKey: string },
): LocalOrderRecord {
  if (!isRecord(value)) throw new Error("Canonical order response is invalid.");
  requireExactKeys(value, [
    "idempotencyKey",
    "requestCommitmentHex",
    "orderHashHex",
    "orderBase64",
    "contextId",
    "domainId",
    "domainManifestVersion",
    "domainManifestHashHex",
    "owner",
    "settlementAccount",
    "nonceDecimal",
    "status",
    "createdAtMs",
  ], "Canonical order");
  if (value.idempotencyKey !== expected.idempotencyKey || value.owner !== expected.owner ||
      value.settlementAccount !== expected.settlementAccount || value.contextId !== LOCAL_CONTEXT_ID ||
      value.domainId !== "svm:local" || value.status !== "UNSIGNED_CREATED") {
    throw new Error("Canonical order response does not match the request.");
  }
  const orderBytes = decodeCanonicalBase64(value.orderBase64, "Canonical order bytes");
  if (orderBytes.length === 0) throw new Error("Canonical order bytes are empty.");
  const domainManifestVersion = requireInteger(value.domainManifestVersion, "Order domain manifest version");
  const createdAtMs = requireInteger(value.createdAtMs, "Order creation time");
  if (domainManifestVersion === 0 || createdAtMs === 0) {
    throw new Error("Canonical order metadata is invalid.");
  }
  return Object.freeze({
    idempotencyKey: value.idempotencyKey,
    requestCommitmentHex: requireHex32(value.requestCommitmentHex, "Order request commitment"),
    orderHashHex: requireHex32(value.orderHashHex, "Order hash"),
    orderBase64: value.orderBase64 as string,
    contextId: LOCAL_CONTEXT_ID,
    domainId: "svm:local",
    domainManifestVersion,
    domainManifestHashHex: requireHex32(value.domainManifestHashHex, "Order domain manifest hash"),
    owner: value.owner as string,
    settlementAccount: value.settlementAccount as string,
    nonceDecimal: requireCanonicalUnsigned(value.nonceDecimal, "Order nonce", true),
    status: "UNSIGNED_CREATED",
    createdAtMs,
    orderBytes,
  });
}

function requireLocalOrderCreateResponse(
  value: unknown,
  expected: { owner: string; settlementAccount: string; idempotencyKey: string },
): LocalOrderCreateResponse {
  if (!isRecord(value)) throw new Error("Canonical order response is invalid.");
  requireExactKeys(value, [
    "status", "created", "order", "traderAuthorization", "solverQuoting", "note",
  ], "Canonical order response");
  if (value.status !== "UNSIGNED_CREATED" || typeof value.created !== "boolean" ||
      value.traderAuthorization !== "REQUIRED" || value.solverQuoting !== "REQUIRED") {
    throw new Error("Canonical order response status is invalid.");
  }
  return Object.freeze({
    status: "UNSIGNED_CREATED",
    created: value.created,
    order: requireLocalOrderRecord(value.order, expected),
    traderAuthorization: "REQUIRED",
    solverQuoting: "REQUIRED",
    note: requireString(value.note, "Canonical order note"),
  });
}

function requireHyperliquidContext(value: unknown): HyperliquidTestnetContext {
  if (!isRecord(value)) throw new Error("Hyperliquid Testnet context is invalid.");
  requireExactKeys(
    value,
    ["authorizationMode", "contextId", "domain", "environment", "maxOpenPackagesPerOwner", "tradingAccount"],
    "Hyperliquid Testnet context",
  );
  if (!isRecord(value.domain)) throw new Error("Hyperliquid Testnet domain is invalid.");
  requireExactKeys(
    value.domain,
    ["domainId", "domainManifestHash", "domainManifestVersion"],
    "Hyperliquid Testnet domain",
  );
  const domainManifestVersion = requireInteger(
    value.domain.domainManifestVersion,
    "Hyperliquid domain manifest version",
  );
  if (value.environment !== "TESTNET" ||
      value.authorizationMode !== "OWNER_SIGNED_OMNIBUS_ACCOUNT" ||
      value.domain.domainId !== HYPERLIQUID_DOMAIN_ID || domainManifestVersion === 0 ||
      (value.maxOpenPackagesPerOwner !== null && !Number.isSafeInteger(value.maxOpenPackagesPerOwner))) {
    throw new Error("Hyperliquid Testnet context binding is invalid.");
  }
  const tradingAccount = requireString(value.tradingAccount, "Hyperliquid trading account");
  if (!/^0x[0-9a-f]{40}$/.test(tradingAccount)) {
    throw new Error("Hyperliquid trading account is invalid.");
  }
  return Object.freeze({
    contextId: requireProtocolId(value.contextId, "Hyperliquid context id"),
    tradingAccount,
    domain: Object.freeze({
      domainId: HYPERLIQUID_DOMAIN_ID,
      domainManifestVersion,
      domainManifestHash: requireHex32(
        value.domain.domainManifestHash,
        "Hyperliquid domain manifest hash",
      ),
    }),
    environment: "TESTNET",
    authorizationMode: "OWNER_SIGNED_OMNIBUS_ACCOUNT",
    maxOpenPackagesPerOwner: value.maxOpenPackagesPerOwner as number | null,
  });
}

const HYPERLIQUID_PACKAGE_STATES = new Set(["PENDING_ENTRY", "OPEN", "EXITING", "CLOSED", "UNRESOLVED"]);

function decimalPlaces(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 36 ? value : null;
}

function requireHyperliquidAccount(value: unknown, owner: string, context: HyperliquidTestnetContext): HyperliquidAccountStatus {
  if (!isRecord(value) || value.owner !== owner || value.tradingAccount !== context.tradingAccount ||
      value.executionModel !== "OMNIBUS_TESTNET_ACCOUNT" || !Array.isArray(value.packages)) {
    throw new Error("Hyperliquid account response is invalid.");
  }
  const atoms = (entry: unknown) => entry === null || (typeof entry === "string" && /^(?:0|[1-9][0-9]{0,77})$/.test(entry));
  const packages = value.packages.map((entry): HyperliquidOwnedPackage => {
    if (!isRecord(entry) || typeof entry.entryAttemptId !== "string" || !HYPERLIQUID_ATTEMPT_ID_PATTERN.test(entry.entryAttemptId) ||
        typeof entry.state !== "string" || !HYPERLIQUID_PACKAGE_STATES.has(entry.state) ||
        !atoms(entry.perpQuantityAtoms) || !atoms(entry.spotQuantityAtoms) || !atoms(entry.entryNotionalAtoms)) {
      throw new Error("Hyperliquid owned package is invalid.");
    }
    return Object.freeze({
      entryAttemptId: entry.entryAttemptId,
      entryOrderHash: requireHex32(entry.entryOrderHash, "Hyperliquid entry order hash"),
      state: entry.state as HyperliquidOwnedPackage["state"],
      perpQuantityAtoms: entry.perpQuantityAtoms as string | null,
      spotQuantityAtoms: entry.spotQuantityAtoms as string | null,
      entryNotionalAtoms: entry.entryNotionalAtoms as string | null,
      entryReceiptHash: entry.entryReceiptHash === null ? null : requireHex32(entry.entryReceiptHash, "Hyperliquid entry receipt"),
      exitAttemptId: typeof entry.exitAttemptId === "string" ? entry.exitAttemptId : null,
      openedAtMs: typeof entry.openedAtMs === "number" ? entry.openedAtMs : null,
      closedAtMs: typeof entry.closedAtMs === "number" ? entry.closedAtMs : null,
    });
  });
  return Object.freeze({
    owner,
    tradingAccount: context.tradingAccount,
    maxOpenPackagesPerOwner: context.maxOpenPackagesPerOwner,
    baseDecimals: decimalPlaces(value.baseDecimals),
    quoteDecimals: decimalPlaces(value.quoteDecimals),
    packages: Object.freeze(packages),
  });
}

function requireHyperliquidOrderCreateResponse(
  value: unknown,
  context: HyperliquidTestnetContext,
  owner: string,
  idempotencyKey: string,
): HyperliquidOrderCreateResponse {
  if (!isRecord(value)) throw new Error("Hyperliquid canonical order response is invalid.");
  requireExactKeys(
    value,
    ["created", "note", "order", "solverQuoting", "status", "traderAuthorization"],
    "Hyperliquid canonical order response",
  );
  if (value.status !== "UNSIGNED_CREATED" || typeof value.created !== "boolean" ||
      value.traderAuthorization !== "OWNER_EVM_SIGNATURE_REQUIRED" ||
      value.solverQuoting !== "REQUIRED" || !isRecord(value.order)) {
    throw new Error("Hyperliquid canonical order status is invalid.");
  }
  requireExactKeys(value.order, [
    "idempotencyKey", "requestCommitmentHex", "orderHashHex", "orderBase64", "contextId",
    "domainId", "domainManifestVersion", "domainManifestHashHex", "owner",
    "settlementAccount", "nonceDecimal", "status", "createdAtMs",
  ], "Hyperliquid canonical order");
  const order = value.order;
  const domainManifestVersion = requireInteger(
    order.domainManifestVersion,
    "Hyperliquid order domain manifest version",
  );
  const createdAtMs = requireInteger(order.createdAtMs, "Hyperliquid order creation time");
  if (order.idempotencyKey !== idempotencyKey || order.contextId !== context.contextId ||
      order.domainId !== HYPERLIQUID_DOMAIN_ID ||
      domainManifestVersion !== context.domain.domainManifestVersion ||
      order.domainManifestHashHex !== context.domain.domainManifestHash ||
      order.owner !== owner || order.settlementAccount !== context.tradingAccount ||
      order.status !== "UNSIGNED_CREATED" || createdAtMs === 0) {
    throw new Error("Hyperliquid canonical order does not match the owner and trading account.");
  }
  const orderBytes = decodeCanonicalBase64(order.orderBase64, "Hyperliquid canonical order bytes");
  if (orderBytes.length === 0) throw new Error("Hyperliquid canonical order bytes are empty.");
  return Object.freeze({
    status: "UNSIGNED_CREATED",
    created: value.created,
    order: Object.freeze({
      idempotencyKey,
      requestCommitmentHex: requireHex32(order.requestCommitmentHex, "Hyperliquid order request commitment"),
      orderHashHex: requireHex32(order.orderHashHex, "Hyperliquid order hash"),
      orderBase64: order.orderBase64 as string,
      contextId: context.contextId,
      domainId: HYPERLIQUID_DOMAIN_ID,
      domainManifestVersion,
      domainManifestHashHex: context.domain.domainManifestHash,
      owner,
      settlementAccount: context.tradingAccount,
      nonceDecimal: requireCanonicalUnsigned(order.nonceDecimal, "Hyperliquid order nonce", true),
      status: "UNSIGNED_CREATED",
      createdAtMs,
      orderBytes,
    }),
    traderAuthorization: "OWNER_EVM_SIGNATURE_REQUIRED",
    solverQuoting: "REQUIRED",
    note: requireString(value.note, "Hyperliquid canonical order note"),
  });
}

function requireLocalAuthorization(
  value: unknown,
  order: LocalOrderRecord,
  signature: string,
): LocalAuthorization {
  if (!isRecord(value)) throw new Error("Order authorization response is invalid.");
  requireExactKeys(value, ["status", "authorization"], "Order authorization response");
  if (value.status !== "TRADER_AUTHORIZED" || !isRecord(value.authorization)) {
    throw new Error("Order authorization status is invalid.");
  }
  requireExactKeys(
    value.authorization,
    ["orderHash", "owner", "signature", "authorizedAtMs"],
    "Order authorization",
  );
  const authorization = value.authorization;
  if (authorization.orderHash !== order.orderHashHex || authorization.owner !== order.owner ||
      authorization.signature !== signature) {
    throw new Error("Order authorization does not match the canonical order.");
  }
  const authorizedAtMs = requireInteger(authorization.authorizedAtMs, "Authorization time");
  if (authorizedAtMs === 0) throw new Error("Authorization time is invalid.");
  return Object.freeze({
    orderHash: order.orderHashHex,
    owner: order.owner,
    signature: requireCanonicalBase58Signature(signature, "Authorization signature"),
    authorizedAtMs,
  });
}

function requireSolverQuote(
  value: unknown,
  orderHash: string,
  idempotencyKey: string,
  environment: "local" | "testnet",
  settlementClass: "ATOMIC_POSTCONDITION" | "BATCHED_IOC_WITH_RECOVERY" | "ASYNC_BONDED_SOLVER",
): LocalSolverQuote {
  if (!isRecord(value)) throw new Error("Solver quote response is invalid.");
  requireExactKeys(value, [
    "version", "status", "idempotencyKey", "orderHash", "routeHash", "quoteHash",
    "solverSignatureDigest", "routeBytes", "solverQuoteBytes", "route", "quote",
  ], "Solver quote response");
  if (value.version !== 1 || value.status !== "SIGNED" || value.orderHash !== orderHash ||
      value.idempotencyKey !== idempotencyKey || !isRecord(value.route) || !isRecord(value.quote)) {
    throw new Error("Solver quote binding is invalid.");
  }
  requireKeysWithOptional(value.route, [
    "version", "environment", "domain", "orderHash", "templateId", "templateVersion",
    "packageTemplateManifestHash", "templateRegistryRecordHash", "owner", "settlementAccount",
    "solver", "direction", "action", "quantityPolicyClass", "partialFillPolicy",
    "settlementClass", "executionPlanKind", "routeExpiryUnit", "routeExpiryValue",
    "feePolicyVersion", "feePolicyManifestHash", "accountBindings", "serviceCharges",
    "preconditions", "legs", "actions", "postconditions", "evidenceRequirements",
  ], ["recoveryPlan"], "Solver route");
  requireKeysWithOptional(value.quote, [
    "version", "environment", "domain", "orderHash", "solverId",
    "solverCapabilityManifestHash", "solverSignatureScheme", "solverVerificationKey",
    "quoteMode", "routeHash", "quotedOutcome", "expectedSpotNotional",
    "expectedPerpNotional", "expectedGrossSpotQuantity", "expectedNetSpotQuantity",
    "expectedBaseAssetFee", "expectedMarginDelta", "expectedRawFillFeesByAsset",
    "expectedBuilderFeesByAsset", "expectedNormalizedVenueFeesByAsset", "solverFee",
    "protocolFee", "expectedPriorityFee", "maxRecoveryCostAtomsByAsset", "feePolicyVersion",
    "feePolicyManifestHash", "validUntilUnit", "validUntilValue", "quoteNonce", "signature",
  ], ["expectedTerminalResidualBaseQuantity", "expectedTerminalResidualQuoteValue", "reservationId"], "Solver quote");
  if (value.route.version !== 1 || value.route.environment !== environment ||
      value.route.settlementClass !== settlementClass ||
      value.quote.version !== 1 || value.quote.environment !== environment ||
      value.quote.solverSignatureScheme !== "ED25519" ||
      value.quote.quoteMode !== "EXECUTION_COMMITMENT" ||
      typeof value.quote.solverId !== "string" || value.quote.solverId.length === 0 ||
      !isRecord(value.quote.quotedOutcome)) {
    throw new Error("Solver quote semantics are invalid.");
  }
  requireTaggedBytes32(value.route.orderHash, "Solver route order hash");
  requireTaggedBytes32(value.quote.orderHash, "Solver quote order hash");
  requireTaggedBytes32(value.quote.routeHash, "Solver quote route hash");
  requireTaggedScalar(value.route.routeExpiryValue, "bigint", "Solver route expiry");
  requireTaggedScalar(value.quote.validUntilValue, "bigint", "Solver quote expiry");
  requireTaggedScalar(value.quote.quoteNonce, "bigint", "Solver quote nonce");
  const signatureBytes = requireTaggedScalar(value.quote.signature, "bytes", "Solver quote signature");
  if (signatureBytes.length !== 128) throw new Error("Solver quote signature is invalid.");
  for (const key of [
    "expectedRawFillFeesByAsset", "expectedBuilderFeesByAsset",
    "expectedNormalizedVenueFeesByAsset", "maxRecoveryCostAtomsByAsset",
  ]) {
    if (!Array.isArray(value.quote[key])) throw new Error("Solver quote fee evidence is invalid.");
  }
  for (const key of ["solverFee", "protocolFee", "expectedPriorityFee"]) {
    const amount = value.quote[key];
    if (!isRecord(amount)) throw new Error("Solver quote fee amount is invalid.");
    requireExactKeys(amount, ["asset", "atoms"], "Solver quote fee amount");
    requireTaggedScalar(amount.atoms, "bigint", "Solver quote fee atoms");
  }
  for (const [field, raw] of [["Route bytes", value.routeBytes], ["Solver quote bytes", value.solverQuoteBytes]] as const) {
    if (typeof raw !== "string" || raw.length === 0 || !/^(?:[0-9a-f]{2})+$/.test(raw)) {
      throw new Error(`${field} are invalid.`);
    }
  }
  return Object.freeze({
    version: 1,
    status: "SIGNED",
    idempotencyKey,
    orderHash,
    routeHash: requireHex32(value.routeHash, "Route hash"),
    quoteHash: requireHex32(value.quoteHash, "Quote hash"),
    solverSignatureDigest: requireHex32(value.solverSignatureDigest, "Solver signature digest"),
    routeBytes: value.routeBytes as string,
    solverQuoteBytes: value.solverQuoteBytes as string,
    route: Object.freeze({ ...value.route }),
    quote: Object.freeze({ ...value.quote }),
  });
}

function requireLocalSolverQuote(
  value: unknown,
  orderHash: string,
  idempotencyKey: string,
): LocalSolverQuote {
  return requireSolverQuote(value, orderHash, idempotencyKey, "local", "ATOMIC_POSTCONDITION");
}

function requireHyperliquidSolverQuote(
  value: unknown,
  orderHash: string,
  idempotencyKey: string,
): HyperliquidSolverQuote {
  const quote = requireSolverQuote(
    value,
    orderHash,
    idempotencyKey,
    "testnet",
    "BATCHED_IOC_WITH_RECOVERY",
  );
  if (quote.route.routeExpiryUnit !== "HYPERLIQUID_UNIX_MILLISECONDS" ||
      quote.quote.validUntilUnit !== "HYPERLIQUID_UNIX_MILLISECONDS") {
    throw new Error("Hyperliquid quote expiry unit is invalid.");
  }
  return quote;
}

function requireLocalSelectedAttempt(value: unknown, quote: LocalSolverQuote): LocalSelectedAttempt {
  if (!isRecord(value)) throw new Error("Quote selection response is invalid.");
  requireExactKeys(value, ["status", "attempt"], "Quote selection response");
  if (value.status !== "AUTHORIZED_QUOTE_SELECTED" || !isRecord(value.attempt)) {
    throw new Error("Quote selection status is invalid.");
  }
  requireExactKeys(
    value.attempt,
    ["attemptId", "orderHash", "routeHash", "quoteHash", "status", "selectedAtMs"],
    "Selected attempt",
  );
  const attempt = value.attempt;
  if (attempt.orderHash !== quote.orderHash || attempt.routeHash !== quote.routeHash ||
      attempt.quoteHash !== quote.quoteHash || attempt.status !== "AUTHORIZED_QUOTE_SELECTED") {
    throw new Error("Selected attempt does not match the reviewed quote.");
  }
  const selectedAtMs = requireInteger(attempt.selectedAtMs, "Selection time");
  if (selectedAtMs === 0) throw new Error("Selection time is invalid.");
  return Object.freeze({
    attemptId: requireLocalAttemptId(attempt.attemptId),
    orderHash: quote.orderHash,
    routeHash: quote.routeHash,
    quoteHash: quote.quoteHash,
    status: "AUTHORIZED_QUOTE_SELECTED",
    selectedAtMs,
  });
}

function requireHyperliquidSelectedAttempt(
  value: unknown,
  quote: HyperliquidSolverQuote,
  context: HyperliquidTestnetContext,
): HyperliquidSelectedAttempt {
  if (!isRecord(value)) throw new Error("Hyperliquid quote selection response is invalid.");
  requireExactKeys(value, ["attempt", "status"], "Hyperliquid quote selection response");
  if (value.status !== "HYPERLIQUID_TESTNET_QUOTE_SELECTED" || !isRecord(value.attempt)) {
    throw new Error("Hyperliquid quote selection status is invalid.");
  }
  requireExactKeys(value.attempt, [
    "attemptId", "domainId", "domainManifestHash", "domainManifestVersion", "orderHash",
    "quoteHash", "routeHash", "selectedAtMs", "status",
  ], "Hyperliquid selected attempt");
  const attempt = value.attempt;
  const selectedAtMs = requireInteger(attempt.selectedAtMs, "Hyperliquid selection time");
  if (attempt.orderHash !== quote.orderHash || attempt.routeHash !== quote.routeHash ||
      attempt.quoteHash !== quote.quoteHash ||
      attempt.status !== "HYPERLIQUID_TESTNET_QUOTE_SELECTED" ||
      attempt.domainId !== HYPERLIQUID_DOMAIN_ID ||
      attempt.domainManifestVersion !== context.domain.domainManifestVersion ||
      attempt.domainManifestHash !== context.domain.domainManifestHash || selectedAtMs === 0 ||
      typeof attempt.attemptId !== "string" ||
      !HYPERLIQUID_ATTEMPT_ID_PATTERN.test(attempt.attemptId)) {
    throw new Error("Hyperliquid selected attempt binding is invalid.");
  }
  return Object.freeze({
    attemptId: attempt.attemptId,
    orderHash: quote.orderHash,
    routeHash: quote.routeHash,
    quoteHash: quote.quoteHash,
    status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED",
    selectedAtMs,
    domainId: HYPERLIQUID_DOMAIN_ID,
    domainManifestVersion: context.domain.domainManifestVersion,
    domainManifestHash: context.domain.domainManifestHash,
  });
}

const HYPERLIQUID_RESULT_KEYS: Record<string, readonly string[]> = {
  CHECKPOINT_INCOMPLETE: ["rawEvidenceCommitments", "reasons"],
  CHECKPOINT_FAILED: ["errorCommitment"],
  NOT_SUBMITTED: ["actionCommitment", "errorCommitment", "evidenceStatus", "requestCommitment"],
  SUBMISSION_CALL_FAILED: ["errorCommitment"],
  SUBMISSION_RESULT_INVALID: ["errorCommitment"],
  RECONCILIATION_DEFERRED: ["actionCommitment", "errorCommitment", "requestCommitment", "submissionStatus"],
  RECONCILIATION_INCOMPLETE: ["actionCommitment", "packageStatus", "rawEvidenceCommitments", "reasons", "requestCommitment", "submissionStatus"],
  RECONCILED: ["actionCommitment", "packageStatus", "rawEvidenceCommitments", "reasons", "requestCommitment", "submissionStatus"],
  RECONCILED_OBSERVED: ["actionCommitment", "observedNetSpotDeltaAtoms", "observedPerpetualDeltaAtoms", "packageStatus", "rawEvidenceCommitments", "reasons", "requestCommitment", "submissionStatus"],
  HANDOFF_REJECTED: ["actionCommitment", "reason", "requestCommitment"],
};

function requireHyperliquidCommitment(value: unknown, name: string): string {
  const commitment = requireString(value, name);
  if (!/^0x[0-9a-f]{64}$/.test(commitment) || /^0x0+$/.test(commitment)) {
    throw new Error(`${name} is invalid.`);
  }
  return commitment;
}

function requireHyperliquidReasons(value: unknown, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > 8 || (!allowEmpty && value.length === 0)) {
    throw new Error("Hyperliquid execution reasons are invalid.");
  }
  const reasons = value.map((reason) => {
    if (typeof reason !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(reason)) {
      throw new Error("Hyperliquid execution reason is invalid.");
    }
    return reason;
  });
  if (new Set(reasons).size !== reasons.length) {
    throw new Error("Hyperliquid execution reasons repeat.");
  }
  return Object.freeze(reasons);
}

function requireHyperliquidExecutionResult(
  value: unknown,
  attempt: HyperliquidSelectedAttempt,
  idempotencyKey: string,
): HyperliquidTerminalExecutionResult {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new Error("Hyperliquid execution response is invalid.");
  }
  const variantKeys = HYPERLIQUID_RESULT_KEYS[
    value.status === "RECONCILED" && "observedNetSpotDeltaAtoms" in value ? "RECONCILED_OBSERVED" : value.status
  ];
  if (!variantKeys || value.status === "RECONCILED_OBSERVED") throw new Error("Hyperliquid execution status is unsupported.");
  requireExactKeys(
    value,
    ["attemptId", "domain", "environment", "idempotencyKey", "status", ...variantKeys],
    "Hyperliquid execution response",
  );
  if (value.attemptId !== attempt.attemptId || value.idempotencyKey !== idempotencyKey ||
      value.domain !== HYPERLIQUID_DOMAIN_ID || value.environment !== "TESTNET") {
    throw new Error("Hyperliquid execution response binding is invalid.");
  }
  const result: Record<string, unknown> = {
    attemptId: attempt.attemptId,
    idempotencyKey,
    domain: HYPERLIQUID_DOMAIN_ID,
    environment: "TESTNET",
    status: value.status,
  };
  if ("submissionStatus" in value) {
    if (value.submissionStatus !== "ACKNOWLEDGED" && value.submissionStatus !== "REJECTED" &&
        value.submissionStatus !== "AMBIGUOUS") {
      throw new Error("Hyperliquid submission status is invalid.");
    }
    result.submissionStatus = value.submissionStatus;
  }
  if ("packageStatus" in value) {
    const allowed = value.status === "RECONCILIATION_INCOMPLETE"
      ? ["RECONCILING"]
      : ["NO_EFFECT", "COMPLETED_EXACT", "COMPLETED_BOUNDED", "RECOVERY_REQUIRED", "MANUAL_INTERVENTION"];
    if (typeof value.packageStatus !== "string" || !allowed.includes(value.packageStatus)) {
      throw new Error("Hyperliquid package status is invalid.");
    }
    result.packageStatus = value.packageStatus;
  }
  if ("evidenceStatus" in value) {
    if (value.evidenceStatus !== "PRECONDITION_REJECTED" && value.evidenceStatus !== "JOURNAL_REJECTED") {
      throw new Error("Hyperliquid evidence status is invalid.");
    }
    result.evidenceStatus = value.evidenceStatus;
  }
  if ("reasons" in value) {
    const allowEmpty = value.status === "RECONCILED" &&
      (value.packageStatus === "NO_EFFECT" || value.packageStatus === "COMPLETED_EXACT" ||
        value.packageStatus === "COMPLETED_BOUNDED");
    result.reasons = requireHyperliquidReasons(value.reasons, allowEmpty);
  }
  if ("reason" in value) {
    result.reason = requireHyperliquidReasons([value.reason], false)[0];
  }
  for (const key of ["actionCommitment", "requestCommitment"] as const) {
    if (key in value) {
      result[key] = value[key] === null ? null : requireHyperliquidCommitment(value[key], key);
    }
  }
  if ("errorCommitment" in value) {
    result.errorCommitment = requireHyperliquidCommitment(value.errorCommitment, "errorCommitment");
  }
  for (const key of ["observedNetSpotDeltaAtoms", "observedPerpetualDeltaAtoms"] as const) {
    if (key in value) {
      if (typeof value[key] !== "string" || !/^(?:0|-?[1-9][0-9]{0,77})$/.test(value[key])) {
        throw new Error("Hyperliquid observed package delta is invalid.");
      }
      result[key] = value[key];
    }
  }
  if ("rawEvidenceCommitments" in value) {
    if (!Array.isArray(value.rawEvidenceCommitments) || value.rawEvidenceCommitments.length > 64) {
      throw new Error("Hyperliquid evidence commitments are invalid.");
    }
    result.rawEvidenceCommitments = Object.freeze(value.rawEvidenceCommitments.map(
      (commitment) => requireHyperliquidCommitment(commitment, "raw evidence commitment"),
    ));
  }
  return Object.freeze(result) as HyperliquidTerminalExecutionResult;
}

function requireTaggedScalar(value: unknown, type: "bigint" | "bytes", name: string): string {
  if (!isRecord(value)) throw new Error(`${name} is invalid.`);
  requireExactKeys(value, ["$naryxType", "value"], name);
  if (value.$naryxType !== type || typeof value.value !== "string") {
    throw new Error(`${name} is invalid.`);
  }
  if (type === "bigint" && !/^(?:0|[1-9][0-9]*)$/.test(value.value)) {
    throw new Error(`${name} is invalid.`);
  }
  if (type === "bytes" && !/^(?:[0-9a-f]{2})+$/.test(value.value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value.value;
}

function requireTaggedBytes32(value: unknown, name: string): string {
  const hex = requireTaggedScalar(value, "bytes", name);
  if (hex.length !== 64 || /^0{64}$/.test(hex)) throw new Error(`${name} is invalid.`);
  return hex;
}

function requireLocalActionResponse(
  value: unknown,
  action: LocalExecutionAction,
  attempt: LocalSelectedAttempt,
): PackageLifecycleState {
  if (!isRecord(value)) throw new Error("Local execution response is invalid.");
  requireExactKeys(value, ["action", "attempt", "receipts", "state"], "Local execution response");
  if (value.action !== action || !isRecord(value.attempt) || !Array.isArray(value.receipts) ||
      value.receipts.length === 0 || value.receipts.length > 100) {
    throw new Error("Local execution response is invalid.");
  }
  requireExactKeys(
    value.attempt,
    ["attemptId", "orderHash", "routeHash", "quoteHash", "status", "selectedAtMs"],
    "Local execution attempt",
  );
  if (value.attempt.attemptId !== attempt.attemptId || value.attempt.orderHash !== attempt.orderHash ||
      value.attempt.routeHash !== attempt.routeHash || value.attempt.quoteHash !== attempt.quoteHash ||
      value.attempt.status !== attempt.status || value.attempt.selectedAtMs !== attempt.selectedAtMs) {
    throw new Error("Local execution attempt binding is invalid.");
  }
  const state = requireLifecycleState(value.state, "Local execution state");
  let previousState: PackageLifecycleState | undefined;
  for (const [index, raw] of value.receipts.entries()) {
    if (!isRecord(raw)) throw new Error("Local lifecycle receipt is invalid.");
    requireKeysWithOptional(raw, [
      "version", "domain", "settlementClass", "packageId", "packageCommitment", "attemptId",
      "eventId", "revision", "nextState", "observedAtUnixMilliseconds", "evidenceGrade",
      "onchainEnforced", "evidenceSource", "evidenceCommitment",
    ], ["priorState", "previousReceiptHash"], "Local lifecycle receipt");
    if (raw.version !== 1 || raw.settlementClass !== "ATOMIC_POSTCONDITION" ||
        raw.packageId !== attempt.attemptId || raw.attemptId !== attempt.attemptId ||
        typeof raw.eventId !== "string" || raw.onchainEnforced !== false ||
        raw.evidenceGrade !== "LOCAL_RECORDED" || !isRecord(raw.domain) ||
        !isRecord(raw.evidenceSource)) {
      throw new Error("Local lifecycle receipt binding is invalid.");
    }
    requireExactKeys(raw.domain, ["domainId", "domainManifestVersion", "domainManifestHash"], "Local lifecycle domain");
    requireExactKeys(raw.evidenceSource, ["subjectId", "manifestVersion", "manifestHash"], "Local lifecycle evidence source");
    if (raw.domain.domainId !== "svm:local" || raw.domain.domainManifestVersion !== 1 ||
        raw.evidenceSource.subjectId !== "local-conformance-execution-v1" ||
        raw.evidenceSource.manifestVersion !== 1) {
      throw new Error("Local lifecycle evidence source is invalid.");
    }
    const revision = requireTaggedScalar(raw.revision, "bigint", "Local lifecycle revision");
    if (revision !== String(index + 1)) throw new Error("Local lifecycle receipt revision is invalid.");
    if (requireTaggedScalar(raw.observedAtUnixMilliseconds, "bigint", "Local lifecycle observed time") === "0") {
      throw new Error("Local lifecycle observed time is invalid.");
    }
    requireTaggedBytes32(raw.domain.domainManifestHash, "Local domain manifest hash");
    requireTaggedBytes32(raw.evidenceSource.manifestHash, "Local evidence manifest hash");
    requireTaggedBytes32(raw.packageCommitment, "Local lifecycle package commitment");
    requireTaggedBytes32(raw.evidenceCommitment, "Local lifecycle evidence commitment");
    const nextState = requireLifecycleState(raw.nextState, "Local lifecycle next state");
    if (index === 0 ? raw.priorState !== undefined || nextState !== "PACKAGE_CREATED"
      : raw.priorState !== previousState || raw.previousReceiptHash === undefined) {
      throw new Error("Local lifecycle receipt chain is invalid.");
    }
    if (raw.previousReceiptHash !== undefined) {
      requireTaggedBytes32(raw.previousReceiptHash, "Local previous receipt hash");
    }
    previousState = nextState;
  }
  if (previousState !== state) throw new Error("Local execution state does not match its receipts.");
  return state;
}

function requirePreparation(
  value: unknown,
  input: SolanaExecutionPreparationInput,
): SolanaExecutionPreparation {
  if (!isRecord(value)) {
    throw new Error("Execution preparation response is invalid.");
  }
  requireExactKeys(value, [
    "status",
    "environment",
    "idempotencyKey",
    "domain",
    "domainManifestVersion",
    "domainManifestHash",
    "planKind",
    "messageBase64",
    "transactionBase64",
    "requiredSignerPubkeys",
    "recentBlockhash",
    "blockhashContextSlot",
    "lastValidBlockHeight",
    "lifecycleAttemptId",
    "genesisHash",
    "lookupTables",
    "evidence",
    "requestCommitment",
  ], "Execution preparation response");
  if (value.status !== "DEVNET_UNSIGNED_REVIEW_REQUIRED" ||
      value.domain !== "svm:devnet" ||
      value.environment !== "DEVNET" ||
      value.genesisHash !== SOLANA_DEVNET_GENESIS_HASH) {
    throw new Error("Execution preparation is not bound to Solana Devnet.");
  }
  if (value.idempotencyKey !== input.idempotencyKey) {
    throw new Error("Execution preparation idempotency key does not match the request.");
  }
  const domainManifestVersion = requireInteger(
    value.domainManifestVersion,
    "Domain manifest version",
  );
  if (domainManifestVersion === 0) {
    throw new Error("Domain manifest version must be positive.");
  }
  const domainManifestHash = requireHex32(value.domainManifestHash, "Domain manifest hash");
  if (value.planKind !== "TRADER_ENTRY" && value.planKind !== "TRADER_RECOVERY_EXIT" &&
      value.planKind !== "TRADER_FIRM_EXIT") {
    throw new Error("Execution preparation plan kind is invalid.");
  }
  if ((value.planKind === "TRADER_ENTRY") !== (input.mode === "entry")) {
    throw new Error("Execution preparation plan kind does not match the reviewed mode.");
  }

  const transactionBytes = decodeCanonicalBase64(value.transactionBase64, "Transaction");
  const messageBytes = decodeCanonicalBase64(value.messageBase64, "Transaction message");
  if (transactionBytes.length === 0 || transactionBytes.length > MAX_TRANSACTION_BYTES) {
    throw new Error("Execution transaction exceeds the Solana packet limit.");
  }
  let decoded: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
  try {
    decoded = getTransactionDecoder().decode(transactionBytes);
  } catch {
    throw new Error("Execution transaction cannot be decoded.");
  }
  if (!bytesEqual(decoded.messageBytes, messageBytes)) {
    throw new Error("Execution transaction and message bytes do not match.");
  }
  if (Object.values(decoded.signatures).some((signature) => signature !== null)) {
    throw new Error("Execution transaction already contains a signature.");
  }
  const requiredSignerPubkeys = requireStringArray(value.requiredSignerPubkeys, "Required signers");
  const decodedSignerPubkeys = Object.keys(decoded.signatures);
  if (requiredSignerPubkeys.length !== 1 ||
      decodedSignerPubkeys.length !== 1 ||
      decodedSignerPubkeys[0] !== requiredSignerPubkeys[0] ||
      requiredSignerPubkeys[0] !== input.traderPublicKey) {
    throw new Error("Execution transaction signer does not match the connected account.");
  }

  if (!Array.isArray(value.lookupTables)) {
    throw new Error("Execution lookup tables are invalid.");
  }
  const lookupTables = value.lookupTables.map((table, index) => {
    if (!isRecord(table)) {
      throw new Error(`Execution lookup table ${index} is invalid.`);
    }
    requireExactKeys(
      table,
      ["address", "addresses", "contentCommitment", "contextSlot"],
      `Execution lookup table ${index}`,
    );
    return Object.freeze({
      address: requireString(table.address, `Execution lookup table ${index} address`),
      addresses: requireStringArray(table.addresses, `Execution lookup table ${index} addresses`),
      contentCommitment: requireHex32(
        table.contentCommitment,
        `Execution lookup table ${index} commitment`,
      ),
      contextSlot: requireInteger(table.contextSlot, `Execution lookup table ${index} slot`),
    });
  });

  if (!isRecord(value.evidence)) {
    throw new Error("Execution evidence is invalid.");
  }
  requireExactKeys(value.evidence, [
    "resolvedAddressCount",
    "serializedMessageBytes",
    "serializedTransactionBytes",
    "packetDataLimit",
    "computeUnitLimit",
    "computeUnitLimitSource",
    "routeComputeUnitLimit",
  ], "Execution evidence");
  const resolvedAddressCount = requireInteger(
    value.evidence.resolvedAddressCount,
    "Resolved address count",
    MAX_RESOLVED_ACCOUNTS,
  );
  const serializedMessageBytes = requireInteger(
    value.evidence.serializedMessageBytes,
    "Serialized message size",
    MAX_TRANSACTION_BYTES,
  );
  const serializedTransactionBytes = requireInteger(
    value.evidence.serializedTransactionBytes,
    "Serialized transaction size",
    MAX_TRANSACTION_BYTES,
  );
  if (serializedMessageBytes !== messageBytes.length ||
      serializedTransactionBytes !== transactionBytes.length ||
      value.evidence.packetDataLimit !== MAX_TRANSACTION_BYTES) {
    throw new Error("Execution byte evidence does not match the transaction.");
  }
  const computeUnitLimit = requireInteger(
    value.evidence.computeUnitLimit,
    "Compute unit limit",
    MAX_COMPUTE_UNITS,
  );
  if (value.evidence.computeUnitLimitSource !== "EXPLICIT") {
    throw new Error("Compute unit evidence source is invalid.");
  }
  const routeComputeUnitLimit = requireInteger(
    value.evidence.routeComputeUnitLimit,
    "Route compute unit limit",
    MAX_COMPUTE_UNITS,
  );
  if (routeComputeUnitLimit !== MAX_COMPUTE_UNITS || computeUnitLimit === 0) {
    throw new Error("Execution compute unit evidence is invalid.");
  }
  if (computeUnitLimit > routeComputeUnitLimit) {
    throw new Error("Execution compute unit evidence is inconsistent.");
  }

  return Object.freeze({
    status: value.status,
    domain: value.domain,
    environment: value.environment,
    idempotencyKey: value.idempotencyKey,
    domainManifestVersion,
    domainManifestHash,
    genesisHash: value.genesisHash,
    planKind: value.planKind,
    transactionBase64: value.transactionBase64 as string,
    messageBase64: value.messageBase64 as string,
    requiredSignerPubkeys,
    recentBlockhash: requireBase58Bytes32(value.recentBlockhash, "Recent blockhash"),
    blockhashContextSlot: requireInteger(value.blockhashContextSlot, "Blockhash context slot"),
    lastValidBlockHeight: requireInteger(value.lastValidBlockHeight, "Last valid block height"),
    lifecycleAttemptId: requireLifecycleAttemptId(value.lifecycleAttemptId),
    lookupTables: Object.freeze(lookupTables),
    evidence: Object.freeze({
      resolvedAddressCount,
      serializedMessageBytes,
      serializedTransactionBytes,
      packetDataLimit: 1232,
      computeUnitLimit,
      computeUnitLimitSource: value.evidence.computeUnitLimitSource,
      routeComputeUnitLimit,
    }),
    requestCommitment: requireHex32(value.requestCommitment, "Request commitment"),
    transactionBytes,
  });
}

const TERMINAL_DOMAINS: ReadonlySet<string> = new Set(["solana", "base", "arbitrum", "hyperliquid"]);
const TERMINAL_SYMBOL_PATTERN = /^[A-Z0-9]{1,12}$/;
const TERMINAL_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)\.[0-9]+$/;
const TERMINAL_ATOMS_PATTERN = /^(0|[1-9][0-9]*)$/;
const TERMINAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TERMINAL_PRICE_PATTERN = /^\$(0|[1-9][0-9]*)\.[0-9]+$/;
const TERMINAL_BASIS_PATTERN = /^[+-](0|[1-9][0-9]*)\.[0-9]{2} bps$/;
const TERMINAL_MARKET_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "DOMAIN_MARKET_UNAVAILABLE",
  "SNAPSHOT_UNAVAILABLE",
  "PREVIEW_UNAVAILABLE",
]);

/** The service is reachable but has no fresh live market for the requested domain. */
export class TerminalMarketUnavailableError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Live market data is unavailable for this domain.");
    this.name = "TerminalMarketUnavailableError";
    this.code = code;
  }
}

async function terminalReadFailure(response: Response, name: string): Promise<Error> {
  if (response.status === 503) {
    try {
      const payload = await response.json() as unknown;
      const code = isRecord(payload) && isRecord(payload.error) ? payload.error.code : undefined;
      if (typeof code === "string" && TERMINAL_MARKET_UNAVAILABLE_CODES.has(code)) {
        return new TerminalMarketUnavailableError(code);
      }
    } catch {
      // An unreadable 503 body is reported as a plain failure below.
    }
  }
  return new Error(`Private terminal ${name} failed with ${response.status}.`);
}

/** Replaces every market number with an unavailable state; nothing from another domain is shown. */
export function unavailableTerminalSnapshot(
  previous: TerminalViewModel,
  domain: DomainId,
): TerminalViewModel {
  return {
    ...previous,
    environment: {
      label: "UNAVAILABLE",
      title: "Market data unavailable",
      detail: "The service has no fresh live market for this domain.",
      capturedAt: "",
      source: "PRIVATE_TERMINAL_BFF",
      evidenceGrade: "UNAVAILABLE",
      executionEnabled: false,
    },
    selectedDomain: domain,
    domains: previous.domains.map((entry) => entry.id === domain ? { ...entry, state: "Unavailable" } : entry),
    market: {
      ...previous.market,
      packageId: "Market unavailable",
      metrics: [{ label: "Market data", value: "Unavailable", detail: "No fresh live observation" }],
    },
    chart: { ...previous.chart, points: [] },
    plans: previous.plans.map((plan) => ({ ...plan, legs: [] })),
  };
}

function requireTerminalText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > 160) throw new Error(`${name} is invalid.`);
  return value;
}

function requireTerminalAtoms(atoms: unknown, value: unknown, name: string): void {
  if (typeof atoms !== "string" || !TERMINAL_ATOMS_PATTERN.test(atoms) ||
      typeof value !== "string" || !TERMINAL_DECIMAL_PATTERN.test(value) ||
      BigInt(value.replace(".", "")) !== BigInt(atoms)) {
    throw new Error(`${name} is invalid.`);
  }
}

function requireTerminalLegs(value: unknown): void {
  if (!Array.isArray(value) || value.length > 8) throw new Error("Preview legs are invalid.");
  value.forEach((leg, index) => {
    if (!isRecord(leg) || leg.sequence !== index + 1) throw new Error("Preview leg is invalid.");
    for (const key of ["action", "instrument", "venue", "quantity", "limitLabel", "limit", "state", "dependency"]) {
      requireString(leg[key], `Preview leg ${key}`);
    }
  });
}

function requireObservedEnvironment(label: unknown, grade: unknown, capturedAt: unknown): void {
  if ((label !== "TESTNET" && label !== "DEVNET") || grade !== "OBSERVED_UNATTESTED" ||
      typeof capturedAt !== "string" || !TERMINAL_ISO_PATTERN.test(capturedAt) ||
      !Number.isFinite(Date.parse(capturedAt))) {
    throw new Error("Private terminal evidence is invalid.");
  }
}

function requireSnapshot(value: unknown, domain: DomainId): TerminalViewModel {
  if (!isRecord(value) || !isRecord(value.environment) ||
      value.environment.source !== "PRIVATE_TERMINAL_BFF" ||
      typeof value.environment.executionEnabled !== "boolean" ||
      value.selectedDomain !== domain ||
      !Array.isArray(value.domains) || !isRecord(value.market) ||
      !isRecord(value.chart) || !Array.isArray(value.chart.points) || !Array.isArray(value.plans) ||
      !isRecord(value.ticket) || !Array.isArray(value.workspaces)) {
    throw new Error("Private terminal snapshot response is invalid.");
  }
  requireObservedEnvironment(value.environment.label, value.environment.evidenceGrade, value.environment.capturedAt);
  requireTerminalText(value.environment.title, "Snapshot title");
  requireTerminalText(value.environment.detail, "Snapshot detail");
  for (const entry of value.domains) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !TERMINAL_DOMAINS.has(entry.id)) {
      throw new Error("Snapshot domain is invalid.");
    }
    requireString(entry.label, "Snapshot domain label");
    requireString(entry.runtime, "Snapshot domain runtime");
    requireString(entry.state, "Snapshot domain state");
  }
  const market = value.market;
  if (typeof market.base !== "string" || !TERMINAL_SYMBOL_PATTERN.test(market.base) ||
      typeof market.quote !== "string" || !TERMINAL_SYMBOL_PATTERN.test(market.quote) ||
      !Array.isArray(market.metrics)) {
    throw new Error("Snapshot market is invalid.");
  }
  requireString(market.packageId, "Snapshot package");
  for (const metric of market.metrics) {
    if (!isRecord(metric)) throw new Error("Snapshot metric is invalid.");
    const label = requireString(metric.label, "Snapshot metric label");
    const metricValue = requireString(metric.value, "Snapshot metric value");
    if (((label === "Spot reference" || label === "Perp reference") && !TERMINAL_PRICE_PATTERN.test(metricValue)) ||
        (label === "Basis" && !TERMINAL_BASIS_PATTERN.test(metricValue)) ||
        (metric.detail !== undefined && typeof metric.detail !== "string") ||
        (metric.accent !== undefined && typeof metric.accent !== "boolean")) {
      throw new Error("Snapshot metric is invalid.");
    }
  }
  for (const point of value.chart.points) {
    if (!isRecord(point) || typeof point.label !== "string" ||
        ![point.spot, point.perp, point.basisBps].every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      throw new Error("Snapshot chart point is invalid.");
    }
  }
  for (const plan of value.plans) {
    if (!isRecord(plan) || (plan.mode !== "entry" && plan.mode !== "exit")) {
      throw new Error("Snapshot plan is invalid.");
    }
    requireTerminalLegs(plan.legs);
  }
  const ticket = value.ticket;
  if (typeof ticket.defaultSize !== "string" || !TERMINAL_DECIMAL_PATTERN.test(ticket.defaultSize) ||
      typeof ticket.sizeSymbol !== "string" || !TERMINAL_SYMBOL_PATTERN.test(ticket.sizeSymbol) ||
      ![5, 10, 25].includes(ticket.defaultSlippageBps as number) ||
      !Array.isArray(ticket.quoteModes) || !Array.isArray(ticket.evidence)) {
    throw new Error("Snapshot ticket is invalid.");
  }
  return value as TerminalViewModel;
}

function requirePreview(value: unknown, input: TerminalPreviewInput): TerminalPreview {
  if (!isRecord(value) || value.source !== "PRIVATE_TERMINAL_BFF" ||
      typeof value.executionAvailable !== "boolean" ||
      value.domain !== input.domain || value.mode !== input.mode || value.quoteMode !== input.quoteMode ||
      !isRecord(value.size) || !isRecord(value.bound) || !Array.isArray(value.fees) ||
      !isRecord(value.totalFee) || !isRecord(value.action) || value.action.available !== false) {
    throw new Error("Private terminal preview response is invalid.");
  }
  requireObservedEnvironment(value.environment, value.evidenceGrade, value.capturedAt);
  requireTerminalAtoms(value.size.baseAtoms, value.size.value, "Preview size");
  requireTerminalAtoms(value.bound.quoteAtoms, value.bound.value, "Preview bound");
  requireTerminalAtoms(value.totalFee.amountAtoms, value.totalFee.value, "Preview total fee");
  if (BigInt(value.size.baseAtoms as string) === BigInt(0) ||
      typeof value.size.symbol !== "string" || !TERMINAL_SYMBOL_PATTERN.test(value.size.symbol) ||
      typeof value.bound.symbol !== "string" || !TERMINAL_SYMBOL_PATTERN.test(value.bound.symbol) ||
      value.totalFee.symbol !== value.bound.symbol) {
    throw new Error("Private terminal preview amounts are invalid.");
  }
  requireString(value.bound.label, "Preview bound label");
  let feeTotal = BigInt(0);
  for (const fee of value.fees) {
    if (!isRecord(fee)) throw new Error("Preview fee is invalid.");
    requireString(fee.label, "Preview fee label");
    requireTerminalAtoms(fee.amountAtoms, fee.value, "Preview fee");
    feeTotal += BigInt(fee.amountAtoms as string);
  }
  if (feeTotal !== BigInt(value.totalFee.amountAtoms as string)) {
    throw new Error("Preview fee total does not match its rows.");
  }
  requireTerminalLegs(value.legs);
  requireString(value.action.reason, "Preview action reason");
  return value as TerminalPreview;
}

function requireObservationIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new Error("Observation idempotency key is invalid.");
  }
  return value;
}

function requireCanonicalSignature(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Observation signature is invalid.");
  }
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new Error("Observation signature is invalid.");
  }
  if (decoded.length !== 64 || bs58.encode(decoded) !== value) {
    throw new Error("Observation signature is invalid.");
  }
  return value;
}

function requireNonnegativeSlot(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requirePositiveHeight(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requireFailureCode(value: unknown): string {
  if (typeof value !== "string" || !FAILURE_CODE_PATTERN.test(value)) {
    throw new Error("Observation failure code is invalid.");
  }
  return value;
}

function requireObservation(
  value: unknown,
  request: SolanaExecutionObservationRequest,
): SolanaExecutionObservation {
  if (!isRecord(value)) {
    throw new Error("Devnet observation response is invalid.");
  }
  if (value.environment !== "DEVNET" || value.domain !== "svm:devnet") {
    throw new Error("Devnet observation is not bound to Solana Devnet.");
  }
  if (value.idempotencyKey !== request.idempotencyKey) {
    throw new Error("Devnet observation idempotency key does not match the request.");
  }
  if (value.signature !== request.signature) {
    throw new Error("Devnet observation signature does not match the request.");
  }
  if (value.lifecycle === "SUBMITTED") {
    requireExactKeys(value, [
      "domain",
      "environment",
      "idempotencyKey",
      "lifecycle",
      "observedSlot",
      "signature",
    ], "Devnet observation");
    const observedSlotRaw = value.observedSlot;
    const observedSlot = observedSlotRaw === null
      ? null
      : requireNonnegativeSlot(observedSlotRaw, "Observed slot");
    return Object.freeze({
      lifecycle: "SUBMITTED",
      signature: request.signature,
      observedSlot,
    });
  }
  if (value.lifecycle === "FINALIZED") {
    requireExactKeys(value, [
      "domain",
      "environment",
      "finalizedSlot",
      "idempotencyKey",
      "lifecycle",
      "signature",
    ], "Devnet observation");
    return Object.freeze({
      lifecycle: "FINALIZED",
      signature: request.signature,
      finalizedSlot: requireNonnegativeSlot(value.finalizedSlot, "Finalized slot"),
    });
  }
  if (value.lifecycle === "FAILED") {
    requireExactKeys(value, [
      "domain",
      "environment",
      "failedSlot",
      "failureCode",
      "idempotencyKey",
      "lifecycle",
      "signature",
    ], "Devnet observation");
    const failedSlotRaw = value.failedSlot;
    const failedSlot = failedSlotRaw === null
      ? null
      : requireNonnegativeSlot(failedSlotRaw, "Failed slot");
    return Object.freeze({
      lifecycle: "FAILED",
      signature: request.signature,
      failedSlot,
      failureCode: requireFailureCode(value.failureCode),
    });
  }
  if (value.lifecycle === "EXPIRED") {
    requireExactKeys(value, [
      "domain",
      "environment",
      "idempotencyKey",
      "lastValidBlockHeight",
      "lifecycle",
      "observedBlockHeight",
      "signature",
    ], "Devnet observation");
    const lastValidBlockHeight = requirePositiveHeight(
      value.lastValidBlockHeight,
      "Last valid block height",
    );
    const observedBlockHeight = requirePositiveHeight(
      value.observedBlockHeight,
      "Observed block height",
    );
    if (observedBlockHeight <= lastValidBlockHeight) {
      throw new Error("Devnet expired observation has not crossed last valid block height.");
    }
    return Object.freeze({
      lifecycle: "EXPIRED",
      signature: request.signature,
      lastValidBlockHeight,
      observedBlockHeight,
    });
  }
  throw new Error("Devnet observation lifecycle is unsupported.");
}

function requireLifecycleAttempt(value: unknown, requestedAttemptId: string): PackageLifecycleAttempt {
  if (!isRecord(value)) throw new Error("Lifecycle attempt is invalid.");
  requireExactKeys(value, [
    "attemptId",
    "packageId",
    "packageCommitmentHex",
    "revision",
    "state",
    "receiptHashHex",
    "eventId",
    "observedAtUnixMilliseconds",
  ], "Lifecycle attempt");
  const attemptId = requireLifecycleAttemptId(value.attemptId);
  if (attemptId !== requestedAttemptId) throw new Error("Lifecycle attempt does not match the request.");
  return Object.freeze({
    attemptId,
    packageId: requireProtocolId(value.packageId, "Lifecycle package id"),
    packageCommitmentHex: requireHex32(value.packageCommitmentHex, "Lifecycle package commitment"),
    revision: requireCanonicalUnsigned(value.revision, "Lifecycle revision", true),
    state: requireLifecycleState(value.state, "Lifecycle state"),
    receiptHashHex: requireHex32(value.receiptHashHex, "Lifecycle receipt hash"),
    eventId: requireProtocolId(value.eventId, "Lifecycle event id"),
    observedAtUnixMilliseconds: requireCanonicalUnsigned(
      value.observedAtUnixMilliseconds,
      "Lifecycle observed time",
      true,
    ),
  });
}

function requireLifecycleReceipt(value: unknown): PackageLifecycleReceipt {
  if (!isRecord(value)) throw new Error("Lifecycle receipt is invalid.");
  requireKeysWithOptional(value, [
    "version",
    "domain",
    "settlementClass",
    "packageId",
    "packageCommitmentHex",
    "attemptId",
    "eventId",
    "revision",
    "nextState",
    "observedAtUnixMilliseconds",
    "evidenceGrade",
    "onchainEnforced",
    "evidenceSource",
    "evidenceCommitmentHex",
    "intentCommitmentHex",
    "receiptHashHex",
  ], ["priorState", "previousReceiptHashHex"], "Lifecycle receipt");
  if (value.version !== 1) throw new Error("Lifecycle receipt version is invalid.");
  if (!isRecord(value.domain)) throw new Error("Lifecycle receipt domain is invalid.");
  requireExactKeys(
    value.domain,
    ["domainId", "domainManifestVersion", "domainManifestHashHex"],
    "Lifecycle receipt domain",
  );
  if (!isRecord(value.evidenceSource)) throw new Error("Lifecycle evidence source is invalid.");
  requireExactKeys(
    value.evidenceSource,
    ["subjectId", "manifestVersion", "manifestHashHex"],
    "Lifecycle evidence source",
  );
  if (typeof value.settlementClass !== "string" ||
      !SETTLEMENT_CLASSES.has(value.settlementClass as PackageLifecycleReceipt["settlementClass"])) {
    throw new Error("Lifecycle settlement class is invalid.");
  }
  if (typeof value.onchainEnforced !== "boolean") {
    throw new Error("Lifecycle enforcement flag is invalid.");
  }
  const priorState = value.priorState === undefined
    ? undefined
    : requireLifecycleState(value.priorState, "Lifecycle prior state");
  const previousReceiptHashHex = value.previousReceiptHashHex === undefined
    ? undefined
    : requireHex32(value.previousReceiptHashHex, "Lifecycle previous receipt hash");
  if ((priorState === undefined) !== (previousReceiptHashHex === undefined)) {
    throw new Error("Lifecycle receipt linkage is incomplete.");
  }
  const receipt: PackageLifecycleReceipt = {
    version: 1,
    domain: Object.freeze({
      domainId: requireProtocolId(value.domain.domainId, "Lifecycle domain id"),
      domainManifestVersion: requireInteger(
        value.domain.domainManifestVersion,
        "Lifecycle domain manifest version",
      ),
      domainManifestHashHex: requireHex32(
        value.domain.domainManifestHashHex,
        "Lifecycle domain manifest hash",
      ),
    }),
    settlementClass: value.settlementClass as PackageLifecycleReceipt["settlementClass"],
    packageId: requireProtocolId(value.packageId, "Lifecycle receipt package id"),
    packageCommitmentHex: requireHex32(
      value.packageCommitmentHex,
      "Lifecycle receipt package commitment",
    ),
    attemptId: requireLifecycleAttemptId(value.attemptId),
    eventId: requireProtocolId(value.eventId, "Lifecycle receipt event id"),
    revision: requireCanonicalUnsigned(value.revision, "Lifecycle receipt revision", true),
    nextState: requireLifecycleState(value.nextState, "Lifecycle next state"),
    observedAtUnixMilliseconds: requireCanonicalUnsigned(
      value.observedAtUnixMilliseconds,
      "Lifecycle receipt observed time",
      true,
    ),
    evidenceGrade: requireEvidenceGrade(value.evidenceGrade),
    onchainEnforced: value.onchainEnforced,
    evidenceSource: Object.freeze({
      subjectId: requireProtocolId(value.evidenceSource.subjectId, "Lifecycle evidence subject"),
      manifestVersion: requireInteger(
        value.evidenceSource.manifestVersion,
        "Lifecycle evidence manifest version",
      ),
      manifestHashHex: requireHex32(
        value.evidenceSource.manifestHashHex,
        "Lifecycle evidence manifest hash",
      ),
    }),
    evidenceCommitmentHex: requireHex32(
      value.evidenceCommitmentHex,
      "Lifecycle evidence commitment",
    ),
    intentCommitmentHex: requireHex32(
      value.intentCommitmentHex,
      "Lifecycle intent commitment",
    ),
    receiptHashHex: requireHex32(value.receiptHashHex, "Lifecycle receipt hash"),
    ...(priorState === undefined ? {} : { priorState }),
    ...(previousReceiptHashHex === undefined ? {} : { previousReceiptHashHex }),
  };
  if (receipt.domain.domainManifestVersion === 0 || receipt.evidenceSource.manifestVersion === 0) {
    throw new Error("Lifecycle manifest version must be positive.");
  }
  return Object.freeze(receipt);
}

function requireLifecycleResponse(value: unknown, requestedAttemptId: string): PackageLifecycleResponse {
  if (!isRecord(value)) throw new Error("Lifecycle response is invalid.");
  requireExactKeys(value, ["attempt", "receipts"], "Lifecycle response");
  const attempt = requireLifecycleAttempt(value.attempt, requestedAttemptId);
  if (!Array.isArray(value.receipts) || value.receipts.length === 0 || value.receipts.length > 100) {
    throw new Error("Lifecycle receipt history is invalid.");
  }
  const receipts = value.receipts.map(requireLifecycleReceipt);
  for (const [index, receipt] of receipts.entries()) {
    const expectedRevision = String(index + 1);
    if (receipt.revision !== expectedRevision ||
        receipt.attemptId !== attempt.attemptId ||
        receipt.packageId !== attempt.packageId ||
        receipt.packageCommitmentHex !== attempt.packageCommitmentHex) {
      throw new Error("Lifecycle receipt history does not match its attempt.");
    }
    if (index === 0) {
      if (receipt.priorState !== undefined || receipt.previousReceiptHashHex !== undefined ||
          receipt.nextState !== "PACKAGE_CREATED") {
        throw new Error("Lifecycle receipt history has an invalid initial receipt.");
      }
      continue;
    }
    const previous = receipts[index - 1];
    if (!previous || receipt.priorState !== previous.nextState ||
        receipt.previousReceiptHashHex !== previous.receiptHashHex) {
      throw new Error("Lifecycle receipt history has a broken chain.");
    }
  }
  const latest = receipts.at(-1);
  if (!latest || latest.revision !== attempt.revision || latest.nextState !== attempt.state ||
      latest.receiptHashHex !== attempt.receiptHashHex || latest.eventId !== attempt.eventId ||
      latest.observedAtUnixMilliseconds !== attempt.observedAtUnixMilliseconds) {
    throw new Error("Lifecycle receipt history does not match the attempt head.");
  }
  return Object.freeze({ attempt, receipts: Object.freeze(receipts) });
}

const EVM_EVIDENCE_GRADES = new Set<EvmEvidenceGrade>([
  "none", "transaction-receipt", "contract-state", "authenticated-callback-record",
  "finalized-contract-receipt",
]);
const BASE_ATOMIC_LIFECYCLES = new Set<BaseAtomicLifecycle>([
  "NOT_FOUND", "SUBMITTED", "REVERTED", "CONFIRMED", "FINALIZED", "EVIDENCE_MISMATCH",
]);
const EVM_COORDINATOR_STATES = new Set<EvmCoordinatorState>([
  "NONE", "RESERVED", "REQUEST_SUBMITTED", "VENUE_PENDING", "EXECUTED", "CANCELLED",
  "FROZEN", "RECOVERY_PENDING", "RECOVERED", "MANUAL_INTERVENTION", "CLOSED",
]);
const EVM_VENUE_STATUSES = new Set<EvmVenueStatus>([
  "NONE", "PENDING", "EXECUTED", "CANCELLED", "FROZEN", "RECOVERED", "CONFLICT",
]);
const ARBITRUM_ASYNC_LIFECYCLES = new Set<ArbitrumAsyncLifecycle>([
  "NOT_FOUND", "RESERVED", "REQUEST_SUBMITTED", "VENUE_PENDING", "EXECUTED", "CANCELLED",
  "FROZEN", "RECOVERY_PENDING", "RECOVERED", "MANUAL_INTERVENTION", "CLOSED", "CONFLICT",
  "EVIDENCE_MISMATCH",
]);
const EIP712_DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;
const TRADER_PERMIT_FIELDS = [
  { name: "packageHash", type: "bytes32" },
  { name: "accountsHash", type: "bytes32" },
  { name: "limitsHash", type: "bytes32" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

function requireEvmIdentity(value: EvmRequestIdentity): EvmRequestIdentity {
  if (!EVM_ID_PATTERN.test(value.attemptId) || !EVM_ID_PATTERN.test(value.idempotencyKey)) {
    throw new Error("EVM request identity is invalid.");
  }
  return Object.freeze({ attemptId: value.attemptId, idempotencyKey: value.idempotencyKey });
}

function requireEvmHash(value: unknown, name: string, allowZero = false): string {
  if (typeof value !== "string" || !EVM_HASH_PATTERN.test(value) ||
      (!allowZero && /^0x0{64}$/.test(value))) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requireEvmAddress(value: unknown, name: string): string {
  if (typeof value !== "string" || !EVM_ADDRESS_PATTERN.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requireEvmDecimal(value: unknown, name: string): string {
  if (typeof value !== "string" || !EVM_DECIMAL_PATTERN.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requireEvmPositiveInteger(value: unknown, name: string): number {
  const checked = requireInteger(value, name);
  if (checked === 0) throw new Error(`${name} is invalid.`);
  return checked;
}

function requireEvmReason(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 300) {
    throw new Error("EVM observation reason is invalid.");
  }
  return value;
}

function requireBaseAuthorization(
  value: unknown,
  request: EvmRequestIdentity,
): BaseAtomicAuthorization {
  if (!isRecord(value) || !isRecord(value.typedData)) {
    throw new Error("Base atomic authorization response is invalid.");
  }
  requireExactKeys(value, [
    "attemptId", "idempotencyKey", "domainId", "domainManifestVersion", "domainManifestHash",
    "environment", "chainReference", "typedData", "digest", "requestCommitment",
  ], "Base atomic authorization response");
  if (value.attemptId !== request.attemptId || value.idempotencyKey !== request.idempotencyKey ||
      value.domainId !== BASE_SEPOLIA_DOMAIN_ID || value.environment !== "TESTNET" ||
      value.chainReference !== BASE_SEPOLIA_CHAIN_REFERENCE) {
    throw new Error("Base atomic authorization response binding is invalid.");
  }
  const typedData = value.typedData;
  requireExactKeys(typedData, ["domain", "types", "primaryType", "message"], "Base typed data");
  if (!isRecord(typedData.domain) || !isRecord(typedData.types) || !isRecord(typedData.message)) {
    throw new Error("Base typed data is invalid.");
  }
  requireExactKeys(typedData.domain, ["name", "version", "chainId", "verifyingContract"], "Base typed data domain");
  if (typedData.domain.name !== "Naryx Package Verifier" || typedData.domain.version !== "1" ||
      typedData.domain.chainId !== BASE_SEPOLIA_CHAIN_REFERENCE || typedData.primaryType !== "TraderPermit") {
    throw new Error("Base typed data domain is invalid.");
  }
  requireExactKeys(typedData.types, ["EIP712Domain", "TraderPermit"], "Base typed data types");
  if (JSON.stringify(typedData.types.EIP712Domain) !== JSON.stringify(EIP712_DOMAIN_FIELDS) ||
      JSON.stringify(typedData.types.TraderPermit) !== JSON.stringify(TRADER_PERMIT_FIELDS)) {
    throw new Error("Base typed data types are invalid.");
  }
  requireExactKeys(typedData.message, ["packageHash", "accountsHash", "limitsHash", "nonce", "deadline"], "Base trader permit");
  const domain = Object.freeze({
    name: "Naryx Package Verifier" as const,
    version: "1" as const,
    chainId: BASE_SEPOLIA_CHAIN_REFERENCE,
    verifyingContract: requireEvmAddress(typedData.domain.verifyingContract, "Base verifier"),
  });
  const message = Object.freeze({
    packageHash: requireEvmHash(typedData.message.packageHash, "Base package hash"),
    accountsHash: requireEvmHash(typedData.message.accountsHash, "Base accounts hash"),
    limitsHash: requireEvmHash(typedData.message.limitsHash, "Base limits hash"),
    nonce: requireEvmDecimal(typedData.message.nonce, "Base permit nonce"),
    deadline: requireEvmDecimal(typedData.message.deadline, "Base permit deadline"),
  });
  return Object.freeze({
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    domainId: BASE_SEPOLIA_DOMAIN_ID,
    domainManifestVersion: requireEvmPositiveInteger(value.domainManifestVersion, "Base manifest version"),
    domainManifestHash: requireEvmHash(value.domainManifestHash, "Base manifest hash"),
    environment: "TESTNET",
    chainReference: BASE_SEPOLIA_CHAIN_REFERENCE,
    typedData: Object.freeze({
      domain,
      types: Object.freeze({
        EIP712Domain: Object.freeze(EIP712_DOMAIN_FIELDS.map((field) => Object.freeze({ ...field }))),
        TraderPermit: Object.freeze(TRADER_PERMIT_FIELDS.map((field) => Object.freeze({ ...field }))),
      }),
      primaryType: "TraderPermit",
      message,
    }),
    digest: requireEvmHash(value.digest, "Base permit digest"),
    requestCommitment: requireEvmHash(value.requestCommitment, "Base authorization request commitment"),
  });
}

function requireBasePreparation(
  value: unknown,
  request: BaseAtomicPreparationRequest,
): BaseAtomicPreparation {
  if (!isRecord(value)) throw new Error("Base atomic preparation response is invalid.");
  requireExactKeys(value, [
    "attemptId", "idempotencyKey", "domainId", "domainManifestVersion", "domainManifestHash",
    "environment", "chainReference", "to", "value", "data", "orderHash", "quoteHash",
    "routeHash", "requestCommitment",
  ], "Base atomic preparation response");
  if (value.attemptId !== request.attemptId || value.idempotencyKey !== request.idempotencyKey ||
      value.domainId !== BASE_SEPOLIA_DOMAIN_ID || value.environment !== "TESTNET" ||
      value.chainReference !== BASE_SEPOLIA_CHAIN_REFERENCE || value.value !== "0") {
    throw new Error("Base atomic preparation response binding is invalid.");
  }
  if (typeof value.data !== "string" || !/^0x[0-9a-f]+$/.test(value.data) ||
      value.data.length <= 2 || value.data.length % 2 !== 0) {
    throw new Error("Base atomic calldata is invalid.");
  }
  return Object.freeze({
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    domainId: BASE_SEPOLIA_DOMAIN_ID,
    domainManifestVersion: requireEvmPositiveInteger(value.domainManifestVersion, "Base manifest version"),
    domainManifestHash: requireEvmHash(value.domainManifestHash, "Base manifest hash"),
    environment: "TESTNET",
    chainReference: BASE_SEPOLIA_CHAIN_REFERENCE,
    to: requireEvmAddress(value.to, "Base transaction target"),
    value: "0",
    data: value.data,
    orderHash: requireEvmHash(value.orderHash, "Base order hash"),
    quoteHash: requireEvmHash(value.quoteHash, "Base quote hash"),
    routeHash: requireEvmHash(value.routeHash, "Base route hash"),
    requestCommitment: requireEvmHash(value.requestCommitment, "Base preparation request commitment"),
  });
}

function requireBasePackageReceipt(value: unknown): BaseAtomicPackageReceipt {
  if (!isRecord(value)) throw new Error("Base package receipt is invalid.");
  requireExactKeys(value, [
    "receiptHash", "domainIdHash", "domainManifestVersion", "domainManifestHash", "orderHash",
    "quoteHash", "routeHash", "spotFillCommitment", "seriesIdentityKey", "seriesBindingVersion",
    "seriesBindingHash", "action", "strategyAccount", "solver", "recovery", "baseQuantityAtoms",
    "spotQuoteAtoms", "packageSizeUnits", "nonce",
  ], "Base package receipt");
  if (typeof value.recovery !== "boolean") throw new Error("Base package receipt recovery flag is invalid.");
  return Object.freeze({
    receiptHash: requireEvmHash(value.receiptHash, "Base receipt hash"),
    domainIdHash: requireEvmHash(value.domainIdHash, "Base receipt domain hash"),
    domainManifestVersion: requireEvmPositiveInteger(value.domainManifestVersion, "Base receipt domain version"),
    domainManifestHash: requireEvmHash(value.domainManifestHash, "Base receipt manifest hash"),
    orderHash: requireEvmHash(value.orderHash, "Base receipt order hash"),
    quoteHash: requireEvmHash(value.quoteHash, "Base receipt quote hash"),
    routeHash: requireEvmHash(value.routeHash, "Base receipt route hash"),
    spotFillCommitment: requireEvmHash(value.spotFillCommitment, "Base spot fill commitment"),
    seriesIdentityKey: requireEvmHash(value.seriesIdentityKey, "Base series identity"),
    seriesBindingVersion: requireEvmPositiveInteger(value.seriesBindingVersion, "Base series version"),
    seriesBindingHash: requireEvmHash(value.seriesBindingHash, "Base series binding hash"),
    action: requireInteger(value.action, "Base package action"),
    strategyAccount: requireEvmAddress(value.strategyAccount, "Base strategy account"),
    solver: requireEvmAddress(value.solver, "Base solver"),
    recovery: value.recovery,
    baseQuantityAtoms: requireEvmDecimal(value.baseQuantityAtoms, "Base quantity"),
    spotQuoteAtoms: requireEvmDecimal(value.spotQuoteAtoms, "Base spot quote"),
    packageSizeUnits: requireEvmDecimal(value.packageSizeUnits, "Base package units"),
    nonce: requireEvmDecimal(value.nonce, "Base package nonce"),
  });
}

function requireBaseOpenPackage(value: unknown): BaseAtomicOpenPackage {
  if (!isRecord(value)) throw new Error("Base open package is invalid.");
  requireExactKeys(value, ["entryReceiptHash", "routeHash", "baseQuantityAtoms", "packageSizeUnits"], "Base open package");
  return Object.freeze({
    entryReceiptHash: requireEvmHash(value.entryReceiptHash, "Base entry receipt hash"),
    routeHash: requireEvmHash(value.routeHash, "Base open route hash"),
    baseQuantityAtoms: requireEvmDecimal(value.baseQuantityAtoms, "Base open quantity"),
    packageSizeUnits: requireEvmDecimal(value.packageSizeUnits, "Base open package units"),
  });
}

function requireBaseObservation(
  value: unknown,
  request: BaseAtomicObservationRequest,
): BaseAtomicObservation {
  if (!isRecord(value)) throw new Error("Base atomic observation response is invalid.");
  requireExactKeys(value, [
    "attemptId", "idempotencyKey", "environment", "domainId", "domainManifestVersion",
    "domainManifestHash", "chainReference", "transactionHash", "lifecycle", "evidenceGrade",
    "blockNumber", "confirmations", "receiptHash", "packageReceipt", "openPackage", "reason",
  ], "Base atomic observation response");
  if (value.attemptId !== request.attemptId || value.idempotencyKey !== request.idempotencyKey ||
      value.transactionHash !== request.transactionHash || value.environment !== "TESTNET" ||
      value.domainId !== BASE_SEPOLIA_DOMAIN_ID || value.chainReference !== BASE_SEPOLIA_CHAIN_REFERENCE ||
      typeof value.lifecycle !== "string" || !BASE_ATOMIC_LIFECYCLES.has(value.lifecycle as BaseAtomicLifecycle) ||
      typeof value.evidenceGrade !== "string" || !EVM_EVIDENCE_GRADES.has(value.evidenceGrade as EvmEvidenceGrade)) {
    throw new Error("Base atomic observation response binding is invalid.");
  }
  const lifecycle = value.lifecycle as BaseAtomicLifecycle;
  const evidenceGrade = value.evidenceGrade as EvmEvidenceGrade;
  const blockNumber = value.blockNumber === null ? null : requireEvmDecimal(value.blockNumber, "Base block number");
  const confirmations = value.confirmations === null ? null : requireInteger(value.confirmations, "Base confirmations");
  const receiptHash = value.receiptHash === null ? null : requireEvmHash(value.receiptHash, "Base receipt hash");
  const packageReceipt = value.packageReceipt === null ? null : requireBasePackageReceipt(value.packageReceipt);
  const openPackage = value.openPackage === null ? null : requireBaseOpenPackage(value.openPackage);
  const reason = requireEvmReason(value.reason);
  if (lifecycle === "NOT_FOUND" &&
      (evidenceGrade !== "none" || blockNumber !== null || confirmations !== null || receiptHash !== null ||
        packageReceipt !== null || openPackage !== null)) {
    throw new Error("Base NOT_FOUND observation carries impossible evidence.");
  }
  if (lifecycle === "REVERTED" &&
      (evidenceGrade !== "transaction-receipt" || blockNumber === null || confirmations === null ||
        packageReceipt !== null || openPackage !== null)) {
    throw new Error("Base REVERTED observation carries impossible evidence.");
  }
  if ((lifecycle === "SUBMITTED" || lifecycle === "CONFIRMED") &&
      (evidenceGrade !== "contract-state" || blockNumber === null || confirmations === null ||
        (packageReceipt === null && openPackage === null))) {
    throw new Error(`Base ${lifecycle} observation carries impossible evidence.`);
  }
  if (lifecycle === "FINALIZED" &&
      (evidenceGrade !== "finalized-contract-receipt" || blockNumber === null || confirmations === null ||
        (packageReceipt === null && openPackage === null) || reason !== null)) {
    throw new Error("Base FINALIZED observation carries impossible evidence.");
  }
  const domainManifestVersion = requireEvmPositiveInteger(value.domainManifestVersion, "Base observation manifest version");
  const domainManifestHash = requireEvmHash(value.domainManifestHash, "Base observation manifest hash");
  if (packageReceipt && (packageReceipt.domainManifestVersion !== domainManifestVersion ||
      packageReceipt.domainManifestHash !== domainManifestHash || receiptHash !== packageReceipt.receiptHash)) {
    throw new Error("Base package receipt does not match its observation.");
  }
  return Object.freeze({
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    environment: "TESTNET",
    domainId: BASE_SEPOLIA_DOMAIN_ID,
    domainManifestVersion,
    domainManifestHash,
    chainReference: BASE_SEPOLIA_CHAIN_REFERENCE,
    transactionHash: requireEvmHash(request.transactionHash, "Base transaction hash"),
    lifecycle,
    evidenceGrade,
    blockNumber,
    confirmations,
    receiptHash,
    packageReceipt,
    openPackage,
    reason,
  });
}

function requireArbitrumAsyncObservation(
  value: unknown,
  request: EvmRequestIdentity,
): ArbitrumAsyncObservation {
  if (!isRecord(value)) throw new Error("Arbitrum async observation response is invalid.");
  requireExactKeys(value, [
    "attemptId", "idempotencyKey", "environment", "domainId", "domainManifestVersion",
    "domainManifestHash", "chainReference", "packageId", "lifecycle", "evidenceGrade",
    "coordinator", "entry", "exit", "finalReceipt", "exitCompleted", "reason",
  ], "Arbitrum async observation response");
  if (value.attemptId !== request.attemptId || value.idempotencyKey !== request.idempotencyKey ||
      value.environment !== "TESTNET" || value.domainId !== ARBITRUM_SEPOLIA_DOMAIN_ID ||
      value.chainReference !== ARBITRUM_SEPOLIA_CHAIN_REFERENCE || typeof value.lifecycle !== "string" ||
      !ARBITRUM_ASYNC_LIFECYCLES.has(value.lifecycle as ArbitrumAsyncLifecycle) ||
      typeof value.evidenceGrade !== "string" || !EVM_EVIDENCE_GRADES.has(value.evidenceGrade as EvmEvidenceGrade) ||
      typeof value.exitCompleted !== "boolean") {
    throw new Error("Arbitrum async observation response binding is invalid.");
  }
  const lifecycle = value.lifecycle as ArbitrumAsyncLifecycle;
  const evidenceGrade = value.evidenceGrade as EvmEvidenceGrade;
  let coordinator: ArbitrumAsyncObservation["coordinator"] = null;
  if (value.coordinator !== null) {
    if (!isRecord(value.coordinator)) throw new Error("Arbitrum coordinator is invalid.");
    requireExactKeys(value.coordinator, [
      "state", "stateVersion", "requestKey", "outcomeEvidenceHash", "recoveryEvidenceHash",
      "hasVenueOutcome", "lastVenueOutcome", "recoveryDutyActive", "recoveryActionSubmitted",
      "recoveryProven", "bondSlashed", "evidenceConflict",
    ], "Arbitrum coordinator");
    if (typeof value.coordinator.state !== "string" ||
        !EVM_COORDINATOR_STATES.has(value.coordinator.state as EvmCoordinatorState)) {
      throw new Error("Arbitrum coordinator state is invalid.");
    }
    for (const field of [
      "hasVenueOutcome", "recoveryDutyActive", "recoveryActionSubmitted", "recoveryProven",
      "bondSlashed", "evidenceConflict",
    ] as const) {
      if (typeof value.coordinator[field] !== "boolean") throw new Error("Arbitrum coordinator flags are invalid.");
    }
    coordinator = Object.freeze({
      state: value.coordinator.state as EvmCoordinatorState,
      stateVersion: requireInteger(value.coordinator.stateVersion, "Arbitrum coordinator version"),
      requestKey: requireEvmHash(value.coordinator.requestKey, "Arbitrum request key", true),
      outcomeEvidenceHash: requireEvmHash(value.coordinator.outcomeEvidenceHash, "Arbitrum outcome evidence", true),
      recoveryEvidenceHash: requireEvmHash(value.coordinator.recoveryEvidenceHash, "Arbitrum recovery evidence", true),
      hasVenueOutcome: value.coordinator.hasVenueOutcome as boolean,
      lastVenueOutcome: requireInteger(value.coordinator.lastVenueOutcome, "Arbitrum venue outcome"),
      recoveryDutyActive: value.coordinator.recoveryDutyActive as boolean,
      recoveryActionSubmitted: value.coordinator.recoveryActionSubmitted as boolean,
      recoveryProven: value.coordinator.recoveryProven as boolean,
      bondSlashed: value.coordinator.bondSlashed as boolean,
      evidenceConflict: value.coordinator.evidenceConflict as boolean,
    });
  }
  const requireVenueRecord = (raw: unknown, name: string) => {
    if (!isRecord(raw)) throw new Error(`${name} is invalid.`);
    if (typeof raw.status !== "string" || !EVM_VENUE_STATUSES.has(raw.status as EvmVenueStatus)) {
      throw new Error(`${name} status is invalid.`);
    }
    return raw;
  };
  let entry: ArbitrumAsyncObservation["entry"] = null;
  if (value.entry !== null) {
    const raw = requireVenueRecord(value.entry, "Arbitrum entry");
    requireExactKeys(raw, ["status", "evidenceHash", "positionSizeBefore", "positionSizeAfter", "revision"], "Arbitrum entry");
    entry = Object.freeze({
      status: raw.status as EvmVenueStatus,
      evidenceHash: requireEvmHash(raw.evidenceHash, "Arbitrum entry evidence", true),
      positionSizeBefore: requireEvmDecimal(raw.positionSizeBefore, "Arbitrum position before"),
      positionSizeAfter: requireEvmDecimal(raw.positionSizeAfter, "Arbitrum position after"),
      revision: requireInteger(raw.revision, "Arbitrum entry revision"),
    });
  }
  let exit: ArbitrumAsyncObservation["exit"] = null;
  if (value.exit !== null) {
    const raw = requireVenueRecord(value.exit, "Arbitrum exit");
    requireExactKeys(raw, ["status", "evidenceHash", "revision", "reconciling", "released"], "Arbitrum exit");
    if (typeof raw.reconciling !== "boolean" || typeof raw.released !== "boolean") {
      throw new Error("Arbitrum exit flags are invalid.");
    }
    exit = Object.freeze({
      status: raw.status as EvmVenueStatus,
      evidenceHash: requireEvmHash(raw.evidenceHash, "Arbitrum exit evidence", true),
      revision: requireInteger(raw.revision, "Arbitrum exit revision"),
      reconciling: raw.reconciling as boolean,
      released: raw.released as boolean,
    });
  }
  let finalReceipt: ArbitrumAsyncObservation["finalReceipt"] = null;
  if (value.finalReceipt !== null) {
    if (!isRecord(value.finalReceipt)) throw new Error("Arbitrum final receipt is invalid.");
    requireExactKeys(value.finalReceipt, [
      "commitment", "packageId", "entryRequestKey", "exitRequestKey", "recipient",
      "fullCloseSizeUsd", "spotBaseAtoms", "spotQuoteAtoms", "perpStatus", "terminalState",
    ], "Arbitrum final receipt");
    finalReceipt = Object.freeze({
      commitment: requireEvmHash(value.finalReceipt.commitment, "Arbitrum final commitment"),
      packageId: requireEvmHash(value.finalReceipt.packageId, "Arbitrum final package id"),
      entryRequestKey: requireEvmHash(value.finalReceipt.entryRequestKey, "Arbitrum entry request key", true),
      exitRequestKey: requireEvmHash(value.finalReceipt.exitRequestKey, "Arbitrum exit request key", true),
      recipient: requireEvmAddress(value.finalReceipt.recipient, "Arbitrum recipient"),
      fullCloseSizeUsd: requireEvmDecimal(value.finalReceipt.fullCloseSizeUsd, "Arbitrum close size"),
      spotBaseAtoms: requireEvmDecimal(value.finalReceipt.spotBaseAtoms, "Arbitrum spot base"),
      spotQuoteAtoms: requireEvmDecimal(value.finalReceipt.spotQuoteAtoms, "Arbitrum spot quote"),
      perpStatus: requireInteger(value.finalReceipt.perpStatus, "Arbitrum perp status"),
      terminalState: requireInteger(value.finalReceipt.terminalState, "Arbitrum terminal state"),
    });
  }
  const packageId = requireEvmHash(value.packageId, "Arbitrum package id");
  const exitCompleted = value.exitCompleted;
  if (lifecycle === "NOT_FOUND" &&
      (evidenceGrade !== "none" || coordinator !== null || entry !== null || exit !== null ||
        finalReceipt !== null || exitCompleted)) {
    throw new Error("Arbitrum NOT_FOUND observation carries impossible evidence.");
  }
  if (lifecycle === "CONFLICT" && (!coordinator ||
      (!coordinator.evidenceConflict && entry?.status !== "CONFLICT" && exit?.status !== "CONFLICT"))) {
    throw new Error("Arbitrum CONFLICT observation carries no conflict signal.");
  }
  if (lifecycle !== "NOT_FOUND" && lifecycle !== "CONFLICT" && lifecycle !== "EVIDENCE_MISMATCH" &&
      (!coordinator || lifecycle !== coordinator.state)) {
    throw new Error("Arbitrum lifecycle does not match coordinator state.");
  }
  for (const record of [entry, exit]) {
    if (record && record.status !== "NONE" && record.status !== "PENDING" && /^0x0{64}$/.test(record.evidenceHash)) {
      throw new Error("Arbitrum terminal venue status lacks evidence.");
    }
  }
  if (finalReceipt && (!exit || finalReceipt.packageId !== packageId)) {
    throw new Error("Arbitrum final receipt does not match its observation.");
  }
  if (exitCompleted && (entry?.status !== "EXECUTED" || exit?.status !== "EXECUTED" || !exit.released ||
      /^0x0{64}$/.test(exit.evidenceHash) || !finalReceipt || finalReceipt.packageId !== packageId ||
      finalReceipt.perpStatus !== 2 || finalReceipt.terminalState !== 1 ||
      evidenceGrade !== "finalized-contract-receipt")) {
    throw new Error("Arbitrum completed exit carries incomplete evidence.");
  }
  return Object.freeze({
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    environment: "TESTNET",
    domainId: ARBITRUM_SEPOLIA_DOMAIN_ID,
    domainManifestVersion: requireEvmPositiveInteger(value.domainManifestVersion, "Arbitrum manifest version"),
    domainManifestHash: requireEvmHash(value.domainManifestHash, "Arbitrum manifest hash"),
    chainReference: ARBITRUM_SEPOLIA_CHAIN_REFERENCE,
    packageId,
    lifecycle,
    evidenceGrade,
    coordinator,
    entry,
    exit,
    finalReceipt,
    exitCompleted,
    reason: requireEvmReason(value.reason),
  });
}

function toSafeObservationError(status: number, code: string | null): Error {
  if (status === 503 || code === "EXECUTION_UNAVAILABLE" ||
      status === 502 || code === "EXECUTION_OBSERVATION_FAILED") {
    return new Error("Devnet observation is temporarily unavailable.");
  }
  if (status === 400 || status === 405 || status === 404) {
    return new Error("Devnet observation rejected the request.");
  }
  return new Error("Devnet observation is temporarily unavailable.");
}

export class PrivateHttpTerminalProvider implements TerminalViewModelProvider {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    const parsed = new URL(baseUrl);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username !== "" || parsed.password !== "" ||
        parsed.search !== "" || parsed.hash !== "") {
      throw new Error("Private terminal base URL must be an HTTP or HTTPS URL.");
    }
    this.#baseUrl = parsed.href.replace(/\/$/, "");
  }

  async getRuntimeHealth(signal?: AbortSignal): Promise<PrivateTerminalRuntimeHealth> {
    const response = await fetch(`${this.#baseUrl}/internal/healthz`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) throw new Error("Private terminal health is unavailable.");
    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      throw new Error("Private terminal health response is invalid.");
    }
    if (!isRecord(payload) || !("runtime" in payload)) {
      throw new Error("Private terminal runtime health is unavailable.");
    }
    const runtime = requireRuntimeHealth(payload.runtime);
    return Object.freeze({
      ...runtime,
      controls: requireRuntimeControls(payload),
    });
  }

  async prepareBaseAtomicAuthorization(
    input: EvmRequestIdentity,
    signal?: AbortSignal,
  ): Promise<BaseAtomicAuthorization> {
    const request = requireEvmIdentity(input);
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/evm-testnet/prepare-atomic-authorization`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      },
    );
    if (!response.ok) throw await serviceFailure(response, "Base authorization preparation");
    return requireBaseAuthorization(await response.json() as unknown, request);
  }

  async prepareBaseAtomicExecution(
    input: BaseAtomicPreparationRequest,
    signal?: AbortSignal,
  ): Promise<BaseAtomicPreparation> {
    const identity = requireEvmIdentity(input);
    if (!EVM_SIGNATURE_PATTERN.test(input.traderSignature)) {
      throw new Error("Base trader signature is invalid.");
    }
    const request = Object.freeze({ ...identity, traderSignature: input.traderSignature });
    const response = await fetch(`${this.#baseUrl}/internal/terminal/evm-testnet/prepare-atomic`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Base atomic preparation");
    return requireBasePreparation(await response.json() as unknown, request);
  }

  async observeBaseAtomicExecution(
    input: BaseAtomicObservationRequest,
    signal?: AbortSignal,
  ): Promise<BaseAtomicObservation> {
    const identity = requireEvmIdentity(input);
    const transactionHash = requireEvmHash(input.transactionHash, "Base transaction hash");
    const request = Object.freeze({ ...identity, transactionHash });
    const response = await fetch(`${this.#baseUrl}/internal/terminal/evm-testnet/observe-atomic`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw new Error(`Base atomic observation failed with ${response.status}.`);
    return requireBaseObservation(await response.json() as unknown, request);
  }

  async observeArbitrumAsyncExecution(
    input: EvmRequestIdentity,
    signal?: AbortSignal,
  ): Promise<ArbitrumAsyncObservation> {
    const request = requireEvmIdentity(input);
    const response = await fetch(`${this.#baseUrl}/internal/terminal/evm-testnet/observe-async`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw new ArbitrumObservationError(response.status);
    return requireArbitrumAsyncObservation(await response.json() as unknown, request);
  }

  async getSnapshot(domain: DomainId, signal?: AbortSignal): Promise<TerminalViewModel> {
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/snapshot?domain=${encodeURIComponent(domain)}`,
      {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal,
      },
    );
    if (!response.ok) throw await terminalReadFailure(response, "snapshot");
    return requireSnapshot(await response.json() as unknown, domain);
  }

  async getPreview(
    input: TerminalPreviewInput,
    signal?: AbortSignal,
  ): Promise<TerminalPreview> {
    const response = await fetch(`${this.#baseUrl}/internal/terminal/preview`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok) throw await terminalReadFailure(response, "preview");
    return requirePreview(await response.json() as unknown, input);
  }

  async getHyperliquidTestnetContext(signal?: AbortSignal): Promise<HyperliquidTestnetContext> {
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/hyperliquid-testnet/context`,
      {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal,
      },
    );
    if (!response.ok) throw new Error(`Hyperliquid context discovery failed with ${response.status}.`);
    return requireHyperliquidContext(await response.json() as unknown);
  }

  async createHyperliquidOrder(
    context: HyperliquidTestnetContext,
    owner: string,
    input: Readonly<{ size: string; slippageBps: number; idempotencyKey: string }>,
    signal?: AbortSignal,
  ): Promise<HyperliquidOrderCreateResponse> {
    const request = {
      contextId: requireProtocolId(context.contextId, "Hyperliquid context id"),
      owner: requireEvmAddress(owner, "Hyperliquid package owner").toLowerCase(),
      settlementAccount: context.tradingAccount,
      size: requireString(input.size, "Hyperliquid order size"),
      slippageBps: requireInteger(input.slippageBps, "Hyperliquid order slippage"),
      idempotencyKey: requireObservationIdempotencyKey(input.idempotencyKey),
    };
    if (request.slippageBps === 0 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(request.size)) {
      throw new Error("Hyperliquid order limits are invalid.");
    }
    const response = await fetch(`${this.#baseUrl}/internal/terminal/orders`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Hyperliquid canonical order creation");
    return requireHyperliquidOrderCreateResponse(
      await response.json() as unknown,
      context,
      request.owner,
      request.idempotencyKey,
    );
  }

  /** The wallet's packages in Naryx's shared Hyperliquid testnet account, from the API ledger. */
  async getHyperliquidAccount(
    context: HyperliquidTestnetContext,
    owner: string,
    signal?: AbortSignal,
  ): Promise<HyperliquidAccountStatus> {
    const wallet = requireEvmAddress(owner, "Hyperliquid package owner").toLowerCase();
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/hyperliquid-testnet/account?owner=${wallet}`,
      { method: "GET", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal },
    );
    if (!response.ok) throw await serviceFailure(response, "Hyperliquid account read");
    return requireHyperliquidAccount(await response.json() as unknown, wallet, context);
  }

  /** Builds the canonical EXIT of the wallet's open package: its exact spot and its exact short. */
  async createHyperliquidExitOrder(
    context: HyperliquidTestnetContext,
    owner: string,
    input: Readonly<{ slippageBps: number; idempotencyKey: string }>,
    signal?: AbortSignal,
  ): Promise<HyperliquidOrderCreateResponse> {
    const request = {
      owner: requireEvmAddress(owner, "Hyperliquid package owner").toLowerCase(),
      slippageBps: requireInteger(input.slippageBps, "Hyperliquid exit slippage"),
      idempotencyKey: requireObservationIdempotencyKey(input.idempotencyKey),
    };
    const response = await fetch(`${this.#baseUrl}/internal/terminal/hyperliquid-testnet/exit-order`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Hyperliquid exit order creation");
    const body = await response.json() as unknown;
    if (!isRecord(body) || body.executionModel !== "OMNIBUS_TESTNET_ACCOUNT") {
      throw new Error("Hyperliquid exit order response is invalid.");
    }
    return requireHyperliquidOrderCreateResponse({
      status: body.status,
      created: body.created,
      order: body.order,
      traderAuthorization: "OWNER_EVM_SIGNATURE_REQUIRED",
      solverQuoting: "REQUIRED",
      note: "Exit order stored. The owner signs it before the shared testnet account executes it.",
    }, context, request.owner, request.idempotencyKey);
  }

  /** The typed data the owner wallet signs for one selected attempt. */
  async prepareHyperliquidAuthorization(
    attempt: HyperliquidSelectedAttempt,
    signal?: AbortSignal,
  ): Promise<HyperliquidAuthorizationRequest> {
    const response = await fetch(`${this.#baseUrl}/internal/terminal/hyperliquid-testnet/authorization`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId: attempt.attemptId }),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Hyperliquid authorization request");
    const body = await response.json() as unknown;
    if (!isRecord(body) || body.attemptId !== attempt.attemptId || body.orderHash !== attempt.orderHash ||
        !isRecord(body.typedData) || !isRecord(body.typedData.domain) || !isRecord(body.typedData.types) ||
        body.typedData.primaryType !== "PackageAuthorization" || !isRecord(body.typedData.message) ||
        body.typedData.message.orderHash !== `0x${attempt.orderHash}`) {
      throw new Error("Hyperliquid authorization request is invalid.");
    }
    return body as HyperliquidAuthorizationRequest;
  }

  async authorizeHyperliquid(
    attempt: HyperliquidSelectedAttempt,
    signature: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/internal/terminal/hyperliquid-testnet/authorize`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId: attempt.attemptId, signature }),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Hyperliquid authorization");
  }

  /** Polls a running handoff; for an uncertain one the service resolves it from the executor record. */
  async getHyperliquidAttemptProgress(
    attempt: HyperliquidSelectedAttempt,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<HyperliquidAttemptProgress> {
    const key = requireObservationIdempotencyKey(idempotencyKey);
    const response = await fetch(`${this.#baseUrl}/internal/terminal/hyperliquid-testnet/attempt-status`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId: attempt.attemptId, idempotencyKey: key }),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Hyperliquid attempt status");
    const body = await response.json() as unknown;
    if (!isRecord(body) || body.attemptId !== attempt.attemptId || body.idempotencyKey !== key) {
      throw new Error("Hyperliquid attempt status is invalid.");
    }
    const lane = typeof body.lane === "string" ? body.lane : null;
    if (body.state === "COMPLETED") {
      return Object.freeze({ state: "COMPLETED", result: requireHyperliquidExecutionResult(body.result, attempt, key) });
    }
    if (body.state === "QUEUED" && typeof body.queuePosition === "number" && Number.isSafeInteger(body.queuePosition)) {
      return Object.freeze({ state: "QUEUED", queuePosition: body.queuePosition, lane });
    }
    if (body.state === "EXECUTING" || body.state === "UNCERTAIN" || body.state === "NOT_STARTED") {
      return Object.freeze({ state: body.state, lane });
    }
    throw new Error("Hyperliquid attempt status is invalid.");
  }

  async requestHyperliquidQuote(
    order: HyperliquidOrderRecord,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<HyperliquidSolverQuote> {
    const key = requireObservationIdempotencyKey(idempotencyKey);
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/orders/${order.orderHashHex}/quote`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: key }),
        signal,
      },
    );
    if (!response.ok) throw new Error(`Hyperliquid quote request failed with ${response.status}.`);
    return requireHyperliquidSolverQuote(await response.json() as unknown, order.orderHashHex, key);
  }

  async selectHyperliquidQuote(
    context: HyperliquidTestnetContext,
    quote: HyperliquidSolverQuote,
    signal?: AbortSignal,
  ): Promise<HyperliquidSelectedAttempt> {
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/orders/${quote.orderHash}/select`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteHash: quote.quoteHash }),
        signal,
      },
    );
    if (!response.ok) throw new Error(`Hyperliquid quote selection failed with ${response.status}.`);
    return requireHyperliquidSelectedAttempt(await response.json() as unknown, quote, context);
  }

  async executeHyperliquidTestnet(
    attempt: HyperliquidSelectedAttempt,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<HyperliquidTerminalExecutionResult> {
    const key = requireObservationIdempotencyKey(idempotencyKey);
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/hyperliquid-testnet/execute`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptId: attempt.attemptId, idempotencyKey: key }),
        signal,
      },
    );
    if (!response.ok) throw await serviceFailure(response, "Hyperliquid Testnet execution");
    return requireHyperliquidExecutionResult(await response.json() as unknown, attempt, key);
  }

  async getBaseAccountStatus(
    owner: string,
    input: Readonly<{ orderHash?: string; marginAtoms?: string }> = {},
    signal?: AbortSignal,
  ): Promise<BaseAccountStatus> {
    const query = new URLSearchParams({ owner: requireEvmAddress(owner, "Base owner") });
    if (input.orderHash !== undefined) query.set("orderHash", requireHex32(input.orderHash, "Base order hash"));
    if (input.marginAtoms !== undefined) query.set("marginAtoms", requireEvmDecimal(input.marginAtoms, "Base margin"));
    const response = await fetch(`${this.#baseUrl}/internal/terminal/base-sepolia/account?${query.toString()}`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Base account status");
    return requireBaseAccountStatus(await response.json() as unknown, owner);
  }

  async createBaseOrder(
    account: BaseAccountStatus,
    input: Readonly<{ size: string; slippageBps: number; idempotencyKey: string }>,
    signal?: AbortSignal,
  ): Promise<BaseOrderRecord> {
    const request = {
      contextId: account.contextId,
      owner: account.owner,
      settlementAccount: account.account,
      size: requireString(input.size, "Base order size"),
      slippageBps: requireInteger(input.slippageBps, "Base order slippage"),
      idempotencyKey: requireObservationIdempotencyKey(input.idempotencyKey),
    };
    if (request.slippageBps === 0 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(request.size)) {
      throw new Error("Base order limits are invalid.");
    }
    const response = await fetch(`${this.#baseUrl}/internal/terminal/orders`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Base order creation");
    return requireBaseOrderCreateResponse(await response.json() as unknown, request);
  }

  /** The canonical EXIT order for the owner's open package; the service reads every quantity from chain. */
  async createBaseExitOrder(
    account: BaseAccountStatus,
    input: Readonly<{ slippageBps: number; idempotencyKey: string }>,
    signal?: AbortSignal,
  ): Promise<BaseOrderRecord> {
    const request = {
      owner: account.owner,
      slippageBps: requireInteger(input.slippageBps, "Base exit slippage"),
      idempotencyKey: requireObservationIdempotencyKey(input.idempotencyKey),
    };
    if (request.slippageBps === 0) throw new Error("Base exit limits are invalid.");
    const response = await fetch(`${this.#baseUrl}/internal/terminal/base-sepolia/exit-order`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Base exit order creation");
    return requireBaseOrderCreateResponse(await response.json() as unknown, {
      contextId: account.contextId,
      owner: account.owner,
      settlementAccount: account.account,
      idempotencyKey: request.idempotencyKey,
    });
  }

  async requestBaseQuote(
    order: BaseOrderRecord,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<BaseSolverQuote> {
    const key = requireObservationIdempotencyKey(idempotencyKey);
    const response = await fetch(`${this.#baseUrl}/internal/terminal/orders/${order.orderHashHex}/quote`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: key }),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Base quote request");
    return requireBaseSolverQuote(await response.json() as unknown, order, key);
  }

  async selectBaseQuote(quote: BaseSolverQuote, signal?: AbortSignal): Promise<BaseSelectedAttempt> {
    const response = await fetch(`${this.#baseUrl}/internal/terminal/orders/${quote.orderHash}/select`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteHash: quote.quoteHash }),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Base quote selection");
    return requireBaseSelectedAttempt(await response.json() as unknown, quote);
  }

  async getArbitrumAccountStatus(owner: string, signal?: AbortSignal): Promise<ArbitrumAccountStatus> {
    const query = new URLSearchParams({ owner: requireEvmAddress(owner, "Arbitrum owner") });
    const response = await fetch(`${this.#baseUrl}/internal/terminal/arbitrum-sepolia/account?${query.toString()}`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Arbitrum account status");
    return requireArbitrumAccountStatus(await response.json() as unknown, owner);
  }

  async createArbitrumOrder(
    account: ArbitrumAccountStatus,
    input: Readonly<{ contextId: string; size: string; slippageBps: number; idempotencyKey: string }>,
    signal?: AbortSignal,
  ): Promise<ArbitrumOrderRecord> {
    if (!account.deployed) throw new Error("Create the Arbitrum strategy account first.");
    const request = {
      contextId: requireProtocolId(input.contextId, "Arbitrum context id"),
      owner: account.owner,
      settlementAccount: account.account,
      size: requireString(input.size, "Arbitrum order size"),
      slippageBps: requireInteger(input.slippageBps, "Arbitrum order slippage"),
      idempotencyKey: requireObservationIdempotencyKey(input.idempotencyKey),
    };
    if (request.slippageBps === 0 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(request.size)) {
      throw new Error("Arbitrum order limits are invalid.");
    }
    const response = await fetch(`${this.#baseUrl}/internal/terminal/orders`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Arbitrum order creation");
    return requireEvmOrderCreateResponse(await response.json() as unknown, request, ARBITRUM_SEPOLIA_DOMAIN_ID, "Arbitrum");
  }

  async requestArbitrumQuote(
    order: ArbitrumOrderRecord,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ArbitrumSolverQuote> {
    const key = requireObservationIdempotencyKey(idempotencyKey);
    const response = await fetch(`${this.#baseUrl}/internal/terminal/orders/${order.orderHashHex}/quote`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: key }),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Arbitrum quote request");
    return requireArbitrumSolverQuote(await response.json() as unknown, order, key);
  }

  async selectArbitrumQuote(quote: ArbitrumSolverQuote, signal?: AbortSignal): Promise<ArbitrumSelectedAttempt> {
    const response = await fetch(`${this.#baseUrl}/internal/terminal/orders/${quote.orderHash}/select`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteHash: quote.quoteHash }),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Arbitrum quote selection");
    return requireArbitrumSelectedAttempt(await response.json() as unknown, quote);
  }

  async prepareArbitrumOwnerAuthorization(
    attempt: ArbitrumSelectedAttempt,
    account: ArbitrumAccountStatus,
    signal?: AbortSignal,
  ): Promise<ArbitrumOwnerAuthorization> {
    if (!ARBITRUM_ATTEMPT_ID_PATTERN.test(attempt.attemptId)) throw new Error("Arbitrum attempt id is invalid.");
    const response = await fetch(`${this.#baseUrl}/internal/terminal/arbitrum-sepolia/prepare-owner-authorization`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId: attempt.attemptId }),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Arbitrum reservation preparation");
    return requireArbitrumOwnerAuthorization(await response.json() as unknown, {
      attemptId: attempt.attemptId,
      owner: account.owner,
      account: account.account,
      signed: null,
    });
  }

  async authorizeArbitrumOwner(
    prepared: ArbitrumOwnerAuthorization,
    ownerSignature: string,
    signal?: AbortSignal,
  ): Promise<ArbitrumOwnerAuthorization> {
    if (!EVM_SIGNATURE_PATTERN.test(ownerSignature)) throw new Error("Arbitrum owner signature is invalid.");
    const response = await fetch(`${this.#baseUrl}/internal/terminal/arbitrum-sepolia/authorize-owner`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId: prepared.attemptId, ownerSignature }),
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Arbitrum reservation authorization");
    const authorized = requireArbitrumOwnerAuthorization(await response.json() as unknown, {
      attemptId: prepared.attemptId,
      owner: prepared.owner,
      account: prepared.account,
      signed: true,
    });
    // The signed reservation must be the one the owner reviewed, not a fresh preparation.
    if (authorized.packageId !== prepared.packageId || authorized.digest !== prepared.digest ||
        authorized.funding.fundRequest.data !== prepared.funding.fundRequest.data ||
        authorized.funding.approveAtoms !== prepared.funding.approveAtoms ||
        authorized.funding.reclaimAfterUnixSeconds !== prepared.funding.reclaimAfterUnixSeconds) {
      throw new Error("Arbitrum authorization changed after review. Prepare the reservation again.");
    }
    return authorized;
  }

  /** Builds the canonical EXIT order for the wallet's open package from chain; nothing is signed or sent. */
  async createArbitrumExitOrder(
    account: ArbitrumAccountStatus,
    input: Readonly<{ contextId: string; slippageBps: number; idempotencyKey: string }>,
    signal?: AbortSignal,
  ): Promise<ArbitrumExitOrder> {
    const open = account.openPackage;
    if (!account.deployed || open === null || !open.exitable) throw new Error("This wallet holds no exitable Arbitrum package.");
    const request = {
      owner: account.owner,
      slippageBps: requireInteger(input.slippageBps, "Arbitrum exit slippage"),
      idempotencyKey: requireObservationIdempotencyKey(input.idempotencyKey),
    };
    const response = await this.#postJson("/internal/terminal/arbitrum-sepolia/exit-order", request, signal);
    if (!response.ok) throw await serviceFailure(response, "Arbitrum exit order");
    const value = await response.json() as unknown;
    const order = requireEvmOrderCreateResponse(value, {
      contextId: requireProtocolId(input.contextId, "Arbitrum context id"),
      owner: account.owner,
      settlementAccount: account.account,
      idempotencyKey: request.idempotencyKey,
    }, ARBITRUM_SEPOLIA_DOMAIN_ID, "Arbitrum exit");
    const body = value as Record<string, unknown>;
    const limits = body.limits;
    if (body.packageId !== open.packageId || body.quantityAtoms !== open.spotBaseAtoms || !isRecord(limits)) {
      throw new Error("Arbitrum exit order is not for the open package.");
    }
    requireExactKeys(limits, ["entryNotionalAtoms", "minSpotQuoteOutAtoms", "minPerpOutputAtoms", "minExitQuoteOutcomeAtoms"], "Arbitrum exit limits");
    return Object.freeze({
      order,
      packageId: open.packageId,
      quantityAtoms: open.spotBaseAtoms,
      limits: Object.freeze({
        entryNotionalAtoms: requireEvmDecimal(limits.entryNotionalAtoms, "Arbitrum entry notional"),
        minSpotQuoteOutAtoms: requireEvmDecimal(limits.minSpotQuoteOutAtoms, "Arbitrum spot minimum"),
        minPerpOutputAtoms: requireEvmDecimal(limits.minPerpOutputAtoms, "Arbitrum close minimum"),
        minExitQuoteOutcomeAtoms: requireEvmDecimal(limits.minExitQuoteOutcomeAtoms, "Arbitrum exit outcome minimum"),
      }),
    });
  }

  async prepareArbitrumExitAuthorization(
    attempt: ArbitrumSelectedAttempt,
    exit: Readonly<{ account: ArbitrumAccountStatus; packageId: string }>,
    signal?: AbortSignal,
  ): Promise<ArbitrumExitAuthorization> {
    if (!ARBITRUM_ATTEMPT_ID_PATTERN.test(attempt.attemptId)) throw new Error("Arbitrum attempt id is invalid.");
    const response = await this.#postJson(
      "/internal/terminal/arbitrum-sepolia/prepare-exit-authorization", { attemptId: attempt.attemptId }, signal,
    );
    if (!response.ok) throw await serviceFailure(response, "Arbitrum exit preparation");
    return requireArbitrumExitAuthorization(await response.json() as unknown, {
      attempt, owner: exit.account.owner, account: exit.account.account, packageId: exit.packageId, signed: null,
    });
  }

  async authorizeArbitrumExit(
    prepared: ArbitrumExitAuthorization,
    attempt: ArbitrumSelectedAttempt,
    ownerSignature: string,
    signal?: AbortSignal,
  ): Promise<ArbitrumExitAuthorization> {
    if (!EVM_SIGNATURE_PATTERN.test(ownerSignature)) throw new Error("Arbitrum owner signature is invalid.");
    const response = await this.#postJson(
      "/internal/terminal/arbitrum-sepolia/authorize-exit", { attemptId: prepared.attemptId, ownerSignature }, signal,
    );
    if (!response.ok) throw await serviceFailure(response, "Arbitrum exit authorization");
    const authorized = requireArbitrumExitAuthorization(await response.json() as unknown, {
      attempt, owner: prepared.owner, account: prepared.account, packageId: prepared.packageId, signed: true,
    });
    // The signed exit must be the one the owner reviewed, not a fresh preparation.
    if (authorized.digest !== prepared.digest) throw new Error("Arbitrum exit changed after review. Prepare it again.");
    return authorized;
  }

  async createLocalOrder(
    input: Readonly<{
      owner: string;
      settlementAccount: string;
      size: string;
      slippageBps: number;
      idempotencyKey: string;
    }>,
    signal?: AbortSignal,
  ): Promise<LocalOrderCreateResponse> {
    const request = {
      contextId: LOCAL_CONTEXT_ID,
      owner: requireBase58Bytes32(input.owner, "Order owner"),
      settlementAccount: requireString(input.settlementAccount, "Settlement account"),
      size: requireString(input.size, "Order size"),
      slippageBps: requireInteger(input.slippageBps, "Order slippage"),
      idempotencyKey: requireObservationIdempotencyKey(input.idempotencyKey),
    };
    if (request.slippageBps === 0) throw new Error("Order slippage is invalid.");
    const response = await fetch(`${this.#baseUrl}/internal/terminal/orders`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw new Error(`Canonical order creation failed with ${response.status}.`);
    return requireLocalOrderCreateResponse(await response.json() as unknown, request);
  }

  async authorizeLocalOrder(
    order: LocalOrderRecord,
    signature: string,
    signal?: AbortSignal,
  ): Promise<LocalAuthorization> {
    const checkedSignature = requireCanonicalBase58Signature(signature, "Authorization signature");
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/orders/${order.orderHashHex}/authorize`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: checkedSignature }),
        signal,
      },
    );
    if (!response.ok) throw new Error(`Order authorization failed with ${response.status}.`);
    return requireLocalAuthorization(await response.json() as unknown, order, checkedSignature);
  }

  async requestLocalQuote(
    order: LocalOrderRecord,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<LocalSolverQuote> {
    const key = requireObservationIdempotencyKey(idempotencyKey);
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/orders/${order.orderHashHex}/quote`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: key }),
        signal,
      },
    );
    if (!response.ok) throw new Error(`Solver quote request failed with ${response.status}.`);
    return requireLocalSolverQuote(await response.json() as unknown, order.orderHashHex, key);
  }

  async selectLocalQuote(
    quote: LocalSolverQuote,
    signal?: AbortSignal,
  ): Promise<LocalSelectedAttempt> {
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/orders/${quote.orderHash}/select`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteHash: quote.quoteHash }),
        signal,
      },
    );
    if (!response.ok) throw new Error(`Quote selection failed with ${response.status}.`);
    return requireLocalSelectedAttempt(await response.json() as unknown, quote);
  }

  async runLocalExecutionAction(
    attempt: LocalSelectedAttempt,
    action: LocalExecutionAction,
    signal?: AbortSignal,
  ): Promise<LocalExecutionResult> {
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/attempts/${attempt.attemptId}/${action}`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal,
      },
    );
    if (!response.ok) throw new Error(`Local ${action} action failed with ${response.status}.`);
    const state = requireLocalActionResponse(await response.json() as unknown, action, attempt);
    const lifecycle = await this.getPackageLifecycle(attempt.attemptId, signal);
    if (lifecycle.attempt.state !== state) {
      throw new Error("Local action response does not match the authoritative lifecycle head.");
    }
    return Object.freeze({ action, state, lifecycle });
  }

  async getSolanaDevnetAccountStatus(
    owner: string,
    sizeAtoms: string,
    signal?: AbortSignal,
    claimTestCollateral = false,
  ): Promise<SolanaDevnetAccountStatus> {
    if (!/^(?:0|[1-9][0-9]{0,30})$/.test(sizeAtoms)) throw new Error("Devnet package size must be decimal atoms.");
    const query = new URLSearchParams({ owner, sizeAtoms });
    if (claimTestCollateral) query.set("claimTestCollateral", "1");
    const response = await fetch(`${this.#baseUrl}/internal/terminal/solana-devnet/account?${query.toString()}`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) throw await serviceFailure(response, "Devnet account status");
    return parseSolanaDevnetAccountStatus(await response.json() as unknown, owner);
  }

  /**
   * Devnet entry: the service builds the canonical ENTRY order under the active Devnet context with
   * the wallet as owner and settlement account, the wallet signs the exact order bytes, the solver
   * quotes, and the quote is selected. The prepare step must reuse the same idempotency key and size.
   * Nothing is submitted here.
   */
  async createSolanaDevnetEntryAttempt(
    input: Readonly<{ contextId: string; owner: string; size: string; slippageBps: number; idempotencyKey: string }>,
    signMessage: (message: Uint8Array) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<Readonly<{ orderHashHex: string }>> {
    const idempotencyKey = requireObservationIdempotencyKey(input.idempotencyKey);
    const request = {
      contextId: requireString(input.contextId, "Devnet order context"),
      owner: requireBase58Bytes32(input.owner, "Devnet order owner"),
      settlementAccount: input.owner,
      size: requireString(input.size, "Devnet order size"),
      slippageBps: requireInteger(input.slippageBps, "Devnet order slippage"),
      idempotencyKey,
    };
    if (request.slippageBps === 0 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(request.size)) {
      throw new Error("Devnet entry order limits are invalid.");
    }
    const created = await this.#postJson("/internal/terminal/orders", request, signal);
    if (!created.ok) throw await serviceFailure(created, "Devnet entry order");
    const value = await created.json() as unknown;
    if (!isRecord(value) || value.status !== "UNSIGNED_CREATED" || !isRecord(value.order) ||
        value.traderAuthorization !== "REQUIRED" || value.order.contextId !== request.contextId) {
      throw new Error("Devnet entry order response is invalid.");
    }
    const orderHashHex = await this.#authorizeAndSelectSolanaDevnetOrder(
      value.order, input.owner, idempotencyKey, signMessage, "Entry", signal,
    );
    return Object.freeze({ orderHashHex });
  }

  /**
   * Firm Devnet exit: the service builds the canonical EXIT order for the wallet's open package from
   * the live oracle, the wallet signs the order bytes, the solver quotes its firm buy-back bid, and
   * the quote is selected. The returned size is the open package size the prepare step must use with
   * the same idempotency key. Nothing is submitted here.
   */
  async createSolanaDevnetExitAttempt(
    input: Readonly<{ owner: string; slippageBps: number; idempotencyKey: string }>,
    signMessage: (message: Uint8Array) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<Readonly<{ orderHashHex: string; quantityAtoms: string }>> {
    const idempotencyKey = requireObservationIdempotencyKey(input.idempotencyKey);
    const created = await this.#postJson("/internal/terminal/solana-devnet/exit-order", {
      owner: input.owner,
      slippageBps: input.slippageBps,
      idempotencyKey,
    }, signal);
    if (!created.ok) throw await serviceFailure(created, "Devnet exit order");
    const value = await created.json() as unknown;
    if (!isRecord(value) || value.status !== "UNSIGNED_CREATED" || !isRecord(value.order) ||
        typeof value.quantityAtoms !== "string" || !/^[1-9][0-9]{0,30}$/.test(value.quantityAtoms)) {
      throw new Error("Devnet exit order response is invalid.");
    }
    const orderHashHex = await this.#authorizeAndSelectSolanaDevnetOrder(
      value.order, input.owner, idempotencyKey, signMessage, "Exit", signal,
    );
    return Object.freeze({ orderHashHex, quantityAtoms: value.quantityAtoms });
  }

  #postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  /** Wallet signs the exact canonical order bytes, then authorize, solver quote, and selection. */
  async #authorizeAndSelectSolanaDevnetOrder(
    order: Record<string, unknown>,
    owner: string,
    idempotencyKey: string,
    signMessage: (message: Uint8Array) => Promise<string>,
    label: "Entry" | "Exit",
    signal?: AbortSignal,
  ): Promise<string> {
    if (order.idempotencyKey !== idempotencyKey || order.owner !== owner || order.settlementAccount !== owner ||
        order.domainId !== "svm:devnet" || order.status !== "UNSIGNED_CREATED") {
      throw new Error(`Devnet ${label.toLowerCase()} order does not match the request.`);
    }
    const orderHashHex = requireHex32(order.orderHashHex, `${label} order hash`);
    const orderBytes = decodeCanonicalBase64(order.orderBase64, `${label} order bytes`);
    if (orderBytes.length === 0) throw new Error(`${label} order bytes are empty.`);
    const signature = requireCanonicalBase58Signature(await signMessage(orderBytes), `${label} authorization signature`);
    const authorized = await this.#postJson(`/internal/terminal/orders/${orderHashHex}/authorize`, { signature }, signal);
    if (!authorized.ok) throw await serviceFailure(authorized, `${label} order authorization`);
    const quoted = await this.#postJson(
      `/internal/terminal/orders/${orderHashHex}/quote`, { idempotencyKey: crypto.randomUUID() }, signal,
    );
    if (!quoted.ok) throw await serviceFailure(quoted, `${label} solver quote`);
    const quote = await quoted.json() as unknown;
    if (!isRecord(quote) || quote.orderHash !== orderHashHex) throw new Error(`${label} solver quote does not match the order.`);
    const quoteHash = requireHex32(quote.quoteHash, `${label} quote hash`);
    const selected = await this.#postJson(`/internal/terminal/orders/${orderHashHex}/select`, { quoteHash }, signal);
    if (!selected.ok) throw await serviceFailure(selected, `${label} quote selection`);
    return orderHashHex;
  }

  async prepareSolanaExecution(
    input: SolanaExecutionPreparationInput,
    signal?: AbortSignal,
  ): Promise<SolanaExecutionPreparation> {
    const response = await fetch(`${this.#baseUrl}/internal/terminal/execution/prepare`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Execution preparation failed with ${response.status}.`);
    }
    return requirePreparation(await response.json() as unknown, input);
  }

  /**
   * The packages a wallet created, newest first, from the service's durable records, so the
   * Activity page follows the wallet across devices. Malformed entries are dropped.
   */
  async listOwnerPackages(owner: string, signal?: AbortSignal): Promise<readonly OwnerPackageEntry[]> {
    if (!/^(?:0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(owner)) throw new Error("Wallet address is invalid.");
    const response = await fetch(`${this.#baseUrl}/internal/terminal/packages?${new URLSearchParams({ owner }).toString()}`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) throw new Error("Package list is temporarily unavailable.");
    const payload = await response.json() as unknown;
    const packages = typeof payload === "object" && payload !== null && Array.isArray((payload as { packages?: unknown }).packages)
      ? (payload as { packages: unknown[] }).packages : [];
    return Object.freeze(packages.flatMap((entry): OwnerPackageEntry[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const value = entry as Record<string, unknown>;
      if (typeof value.orderHash !== "string" || !/^[0-9a-f]{64}$/.test(value.orderHash)
          || typeof value.domainId !== "string" || typeof value.action !== "string"
          || typeof value.quantityAtoms !== "string" || !/^\d{1,40}$/.test(value.quantityAtoms)
          || typeof value.quantityDecimals !== "number" || !Number.isSafeInteger(value.quantityDecimals)
          || value.quantityDecimals < 0 || value.quantityDecimals > 36
          || typeof value.createdAtMs !== "number" || !Number.isSafeInteger(value.createdAtMs)
          || (value.attemptId !== null && (typeof value.attemptId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(value.attemptId)))
          || (value.state !== null && typeof value.state !== "string")) {
        return [];
      }
      return [Object.freeze({
        orderHash: value.orderHash,
        domainId: value.domainId,
        action: value.action,
        quantityAtoms: value.quantityAtoms,
        quantityDecimals: value.quantityDecimals,
        createdAtMs: value.createdAtMs,
        attemptId: value.attemptId as string | null,
        state: value.state as string | null,
      })];
    }));
  }

  async getPackageLifecycle(
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<PackageLifecycleResponse> {
    const checkedAttemptId = requireLifecycleAttemptId(attemptId);
    const query = new URLSearchParams({
      attemptId: checkedAttemptId,
      afterRevision: "0",
      limit: "100",
    });
    const response = await fetch(`${this.#baseUrl}/internal/terminal/lifecycle?${query.toString()}`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) throw new Error("Package lifecycle is temporarily unavailable.");
    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      throw new Error("Package lifecycle response is invalid.");
    }
    return requireLifecycleResponse(payload, checkedAttemptId);
  }

  async observeSolanaExecution(
    request: SolanaExecutionObservationRequest,
    signal?: AbortSignal,
  ): Promise<SolanaExecutionObservation> {
    const idempotencyKey = requireObservationIdempotencyKey(request.idempotencyKey);
    const signature = requireCanonicalSignature(request.signature);
    const response = await fetch(`${this.#baseUrl}/internal/terminal/execution/observe`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey, signature }),
      signal,
    });
    if (!response.ok) {
      let code: string | null = null;
      try {
        const body = await response.json() as unknown;
        if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string") {
          code = body.error.code;
        }
      } catch {
        code = null;
      }
      throw toSafeObservationError(response.status, code);
    }
    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      throw new Error("Devnet observation response is invalid.");
    }
    return requireObservation(payload, { idempotencyKey, signature });
  }
}
