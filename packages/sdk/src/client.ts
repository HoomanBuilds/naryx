import {
  crossDomainPlanHash,
  manualRecoveryApprovalHash,
  manualRecoveryIncidentHash,
  replayCrossDomainCoordination,
  replayManualRecovery,
  type CrossDomainCoordination,
  type CrossDomainEvent,
  type CrossDomainPlanInput,
  type ManualRecoveryApprovalInput,
  type ManualRecoveryEvent,
  type ManualRecoveryIncidentInput,
  type ManualRecoveryState,
  aggregateCandles,
  buildExposureGraph,
  bytesEqual,
  CANDLE_INTERVAL_MS,
  commitmentHash,
  evidenceManifest,
  evidenceManifestHash,
  fromHex,
  fromProtocolJson,
  packageAllocation,
  packageAllocationHash,
  packageMatchingPolicy,
  packageMatchingPolicyHash,
  netObligations,
  packageOrderBytes,
  packageOrderHash,
  packageTakerOrderHash,
  packageBookAmendment,
  packageBookAmendmentBytes,
  packageBookAmendmentHash,
  packageBookCancellationBytes,
  packageBookCancellationHash,
  packageSettlementCommitment,
  packageSettlementCommitmentBytes,
  packageSettlementCommitmentHash,
  packageSettlementHandoff,
  packageSettlementHandoffHash,
  packageSettlementReadiness,
  packageSettlementReadinessHash,
  packageReopeningResult,
  packageReopeningResultHash,
  packageReopeningSettlementHandoff,
  packageReopeningSettlementHandoffHash,
  packageCloseCostIndex,
  stressPortfolio,
  packageGraph,
  packageGraphHash,
  simulatePackageGraphFailures,
  packageReceipt,
  packageReceiptHash,
  positionSnapshotRecord,
  positionSnapshotRecordHash,
  strategyCommandHash,
  strategyCommandAuthorizationTypedData,
  isEvmStrategyActor,
  builderAttributionHash,
  builderManifestHash,
  type BuilderAttributionInput,
  type BuilderManifestInput,
  strategyState,
  strategyStateHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  strategyPackageQuote,
  strategyPackageQuoteHash,
  strategyPackageReceipt,
  strategyPackageReceiptHash,
  typedStrategyRouteHash,
  type StrategyCommandInput,
  type StrategyState,
  type StrategyTransitionReceipt,
  marketCatalogue,
  marketCatalogueCurrent,
  marketCatalogueHash,
  searchMarketCatalogue,
  type MarketCatalogue,
  type MarketCatalogueEntry,
  type MarketCatalogueInput,
  type MarketCatalogueQuery,
  privateRfqEnvelopeHash,
  ProtocolError,
  QUALIFICATION_OBJECT_TYPE,
  qualificationRecord,
  qualificationRecordHash,
  quoteHash as solverQuoteHash,
  routeHash,
  routePayload,
  solverCapabilityManifest,
  solverCapabilityManifestHash,
  solverQuote,
  solverSignatureDigest,
  replayRouteDecision,
  replaySealedAuction,
  requiresSuccessfulReceipt,
  verifyQualificationHistory,
  sealedAuctionHash,
  TERMINAL_STATE,
  terminalOutcomeHash,
  terminalOutcomeRecord,
  toHex,
  toProtocolJson,
  validatePackageOrderProfile,
  verifyOutcomeReceiptLink,
  verifyPackageAllocation,
  verifyPackageSettlementHandoff,
  verifyPackageReopeningSettlementHandoff,
  verifyNettingResultAgainstPolicy,
  verifyReceiptFees,
  type AcceptedQuoteFeeTerms,
  type CandleInterval,
  type CandleSeries,
  type EvidenceManifest,
  type EvidenceManifestInput,
  type ExecutablePackageIndex,
  type PackageAllocation,
  type PackageMatchingPolicy,
  type PackageOrder,
  type PackageOrderInput,
  type PackageReceipt,
  type PackageReceiptInput,
  type PackageTakerOrderInput,
  type PackageBookAmendment,
  type PackageBookAmendmentInput,
  type PackageBookCancellationInput,
  type PackageSettlementCommitmentInput,
  type PackageSettlementCommitment,
  type PackageSettlementHandoff,
  type PackageSettlementReadiness,
  type PackageReopeningResult,
  type PackageReopeningSettlementHandoff,
  type PackageGraphInput,
  type PackageGraph,
  type AssetRef,
  type DomainRef,
  type ExposureGraph,
  type NormalizedPosition,
  type NettingObligationInput,
  type NettingPolicyManifestInput,
  type NettingResult,
  type PositionSnapshotRecord,
  type PositionSnapshotRecordInput,
  type PackageCloseCostIndex,
  type PrivateRfqEnvelopeInput,
  type QualificationObjectType,
  type QualificationRecord,
  type QualificationRecordInput,
  type RoutePayload,
  type RoutePayloadInput,
  type SolverCapabilityManifest,
  type SolverCapabilityManifestInput,
  type SolverQuote,
  type SolverQuoteInput,
  type SealedAuctionDefinitionInput,
  type SealedAuctionEvent,
  type RfqDecision,
  type RfqRequest,
  type RfqResponse,
  type RfqSolverCapacity,
  type RouteDecisionInput,
  type RouteDecisionReplay,
  type TerminalOutcomeInput,
  type TerminalOutcomeRecord,
  type TerminalState,
  type StressResult,
  type StrategyPackageOrder,
  type StrategyPackageOrderInput,
  type StrategyPackageQuote,
  type StrategyPackageQuoteInput,
  type StrategyPackageReceipt,
  type StrategyPackageReceiptInput,
  type TypedStrategyRoute,
} from '@naryx/protocol-types';
import { verifyTypedData, type Hex } from 'viem';

const MAX_RESPONSE_CHARS = 2_097_152;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
const BASE_URL = /^(https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?)(\/[A-Za-z0-9._~\/-]*)?$/;

/** The minimal fetch surface the client needs, so any runtime or test double can supply it. */
export type FetchLike = (
  url: string,
  init: { readonly method: 'GET' | 'POST' | 'PUT'; readonly headers: Readonly<Record<string, string>>; readonly body?: string },
) => Promise<{ readonly status: number; readonly headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface NaryxClientOptions {
  /** HTTPS, or HTTP only on a loopback host. */
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
}

export class NaryxApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'NaryxApiError';
    this.status = status;
    this.code = code;
  }
}

export class NaryxEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NaryxEvidenceError';
  }
}

export interface PackageBookLevelView {
  readonly priceTicks: bigint;
  /** Resting signed package orders. */
  readonly directQuantity: bigint;
  /** Liquidity derived from leg sources; never merged into direct quantity. */
  readonly impliedQuantity: bigint;
}

export interface PackageDepth {
  readonly packageMarketId: string;
  readonly matchingPolicyHash: string;
  readonly halted: boolean;
  readonly asOfValue: bigint;
  readonly bids: readonly PackageBookLevelView[];
  readonly asks: readonly PackageBookLevelView[];
}

export interface PackageMarketSummary {
  readonly packageMarketId: string;
  readonly halted: boolean;
  readonly matchingPolicyHash: string;
  readonly bestBidTicks?: bigint;
  readonly bestAskTicks?: bigint;
  readonly spreadTicks?: bigint;
  readonly label: 'EXECUTABLE';
}

export interface PackageTapeTrade {
  readonly cursor: number;
  readonly allocationHash: string;
  readonly takerSide: 'BID' | 'ASK';
  readonly recordedAtMs: number;
  readonly fills: readonly { readonly fillSequence: bigint; readonly priceTicks: bigint; readonly quantity: bigint; readonly makerSource: string }[];
}

export interface PackageTapePage {
  readonly packageMarketId: string;
  readonly trades: readonly PackageTapeTrade[];
  readonly nextCursor: number;
}

export interface CandlePage extends CandleSeries {
  readonly packageMarketId: string;
  readonly fromMs: number;
  readonly toMs: number;
  /** True when the server hit its trade cap; narrow the window for a complete series. */
  readonly truncated: boolean;
}

export interface VerifiedAllocation {
  readonly allocation: PackageAllocation;
  readonly matchingPolicy: PackageMatchingPolicy;
  readonly allocationHash: string;
}

export interface VerifiedSettlementAllocation extends VerifiedAllocation {
  readonly settlementCommitment: PackageSettlementCommitment;
  readonly settlementCommitmentHash: string;
  readonly settlementHandoff?: PackageSettlementHandoff;
  readonly settlementHandoffHash?: string;
}

export interface PackageSettlementObligationView {
  readonly evidenceKind: 'CONTINUOUS_ALLOCATION' | 'REOPENING_RESULT';
  readonly evidenceHashHex: string;
  readonly fillSequence: bigint;
  readonly role: 'TAKER' | 'MAKER' | 'BID' | 'ASK';
  readonly counterpartyOrderIdHex?: string;
  readonly liquiditySource: 'DIRECT' | 'IMPLIED';
  readonly priceTicks: bigint;
  readonly quantity: bigint;
}

export interface PackageSettlementProgressView {
  readonly readiness: PackageSettlementReadiness;
  readonly readinessHash: string;
  readonly obligations: readonly PackageSettlementObligationView[];
}

export type PackageBookOrderDraft = Omit<PackageTakerOrderInput, 'orderId'>;

export type PackageBookSettlementDraft = Omit<
  PackageSettlementCommitmentInput,
  'version' | 'executionClassId' | 'packageOrderId' | 'participantId' | 'quantity'
>;

export type PackageBookOrderSubmission =
  | {
      readonly accepted: true;
      readonly order: PackageTakerOrderInput;
      readonly replayed: boolean;
      readonly evidence: VerifiedAllocation;
      readonly settlementCommitmentHash: string;
      readonly settlementHandoff?: PackageSettlementHandoff;
      readonly settlementHandoffHash?: string;
    }
  | {
      readonly accepted: false;
      readonly order: PackageTakerOrderInput;
      readonly rejection: string;
    };

export interface PackageReopeningOrderSubmission {
  readonly accepted: true;
  readonly queuedForReopening: true;
  readonly order: PackageTakerOrderInput;
  readonly replayed: boolean;
  readonly settlementCommitmentHash: string;
}

export interface VerifiedPackageReopening {
  readonly result: PackageReopeningResult;
  readonly resultHash: string;
  readonly settlementHandoff?: PackageReopeningSettlementHandoff;
  readonly settlementHandoffHash?: string;
}

export interface PackageBookCancellationResult {
  readonly cancelled: true;
  readonly packageMarketId: string;
  readonly entryId: string;
  readonly cancellationHash: string;
  readonly replayed: boolean;
}

export interface PackageBookAmendmentResult {
  readonly amended: true;
  readonly amendment: PackageBookAmendment;
  readonly amendmentHash: string;
  readonly replayed: boolean;
}

export interface RegisteredDocumentView<T = unknown> {
  readonly kind: string;
  readonly subjectId: string;
  readonly subjectVersion: number;
  readonly environment: string;
  readonly documentHashHex: string;
  readonly registeredAtMs: number;
  readonly document: T;
}

/**
 * Signs the exact canonical order bytes with the owner's Ed25519 key and returns the 64-byte
 * signature. The key never enters this client; a wallet, an HSM, or a signing service backs it.
 */
export type OrderSigner = (canonicalOrderBytes: Uint8Array) => Promise<Uint8Array>;

export interface SubmittedOrder {
  readonly orderHash: string;
  /** True when the server already held this exact order and signature. */
  readonly replayed: boolean;
  /** Intake only: the order may be quoted; nothing has executed. */
  readonly status: 'ACCEPTED_FOR_QUOTING';
}

export interface OrderStatusView {
  readonly orderHash: string;
  /** Present when the server holds the signed order; always re-hashed to the requested hash. */
  readonly order?: PackageOrder;
  readonly owner?: string;
  readonly authorizationSignature?: string;
  readonly receivedAtMs?: number;
  /** OPEN means no terminal outcome is recorded yet; it is not a claim about execution. */
  readonly status: TerminalState | 'OPEN';
  readonly outcomeHash?: string;
  readonly receiptHash?: string;
}

export interface VerifiedTerminalEvidence {
  readonly orderHash: string;
  readonly terminalState: TerminalState;
  readonly evidenceManifest: EvidenceManifest;
  readonly evidenceManifestHash: string;
  readonly outcome: TerminalOutcomeRecord;
  readonly outcomeHash: string;
  /** Present exactly when the terminal state is a successful one. */
  readonly receipt?: PackageReceipt;
  readonly receiptHash?: string;
  /** True only when the caller supplied accepted quote fee terms and the receipt satisfied them. */
  readonly feesVerified: boolean;
  readonly recordedAtMs: number;
}

export interface ExecutionQualityView {
  readonly label: 'OBSERVED';
  readonly methodology: string;
  readonly solverId?: string;
  readonly terminalOutcomes: number;
  readonly byTerminalState: Readonly<Record<TerminalState, number>>;
  readonly successfulBps: number;
  readonly recoveredBps: number;
  readonly timeUnhedgedMs?: { readonly median: bigint; readonly p95: bigint; readonly max: bigint };
  readonly receiptFieldEvidence: Readonly<Record<string, number>>;
}

export interface SolverPerformanceView {
  readonly label: 'OBSERVED';
  readonly methodology: string;
  readonly solverId: string;
  readonly eligibleDomainIds: readonly string[];
  readonly coverage: { readonly eligibleOrders: number; readonly quotedOrders: number; readonly coverageBps: number };
  readonly firstQuoteLatencyMs?: { readonly median: number; readonly p95: number; readonly max: number };
  readonly outcomes: {
    readonly total: number;
    readonly byTerminalState: Readonly<Record<TerminalState, number>>;
    readonly settledBps: number;
    readonly fadeBps: number;
    readonly recoveredBps: number;
    readonly boundedResidualBps: number;
    readonly manualInterventionBps: number;
  };
  readonly priceImprovementBps?: { readonly measured: number; readonly median: number; readonly min: number; readonly max: number };
}

export interface VerifiedOutcome {
  readonly orderHash: string;
  readonly terminalState: TerminalState;
  readonly evidenceManifest: EvidenceManifest;
  readonly evidenceManifestHash: string;
  readonly outcome: TerminalOutcomeRecord;
  readonly outcomeHash: string;
  /** The receipt the outcome links; present exactly for successful terminal states. */
  readonly receiptHash?: string;
  readonly recordedAtMs: number;
}

export interface SizeQuoteView {
  readonly size: bigint;
  /** Absent when the book cannot fill the whole size. */
  readonly averagePriceTicks?: bigint;
  readonly fillableQuantity: bigint;
  readonly label: 'EXECUTABLE' | 'INDICATIVE';
}

export interface ObservedTrade {
  readonly priceTicks: bigint;
  readonly quantity: bigint;
  readonly recordedAtMs: number;
  readonly allocationHash: string;
  readonly label: 'OBSERVED';
}

export interface SeriesCurvePoint {
  readonly executionClassId: string;
  readonly settlementClass: string;
  readonly domains: readonly string[];
  readonly open: boolean;
  readonly halted?: boolean;
  readonly executable?: { readonly bids: readonly SizeQuoteView[]; readonly asks: readonly SizeQuoteView[] };
  readonly lastTrade?: ObservedTrade;
}

export interface SeriesCurve {
  readonly seriesId: string;
  readonly quoteAsset: string;
  readonly quoteConvention: string;
  readonly asOfValue: bigint;
  readonly methodologyVersion: number;
  readonly points: readonly SeriesCurvePoint[];
}

export interface PackageOpportunity {
  readonly packageMarketId: string;
  readonly seriesId?: string;
  readonly bid?: SizeQuoteView;
  readonly ask?: SizeQuoteView;
  readonly spreadAtSizeTicks?: bigint;
  readonly lastTrade?: ObservedTrade;
}

export interface VerifiedQualificationRecord {
  readonly record: QualificationRecord;
  readonly recordHash: string;
}

export type QualificationView =
  | { readonly objectType: QualificationObjectType; readonly objectId: string; readonly asOfValue: bigint; readonly current: VerifiedQualificationRecord }
  | { readonly objectType: QualificationObjectType; readonly objectId: string; readonly unavailable: 'NOT_YET_EFFECTIVE' | 'EXPIRED' | 'TIME_UNIT_UNSUPPORTED' };

export interface VerifiedOrderQuote {
  readonly quoteHash: string;
  readonly routeHash: string;
  readonly quote: SolverQuote;
  readonly route: RoutePayload;
  readonly receivedAtMs: number;
  /**
   * True only when this runtime verified locally that the quote's Ed25519 signature is by a quote
   * key the named solver's operator-signed manifest registers, and the manifest is the one the
   * quote binds. False when that cannot be checked here: no Ed25519 support, or no registry on the
   * server. A signature, manifest, or key binding that is checked and fails is rejected.
   */
  readonly signatureVerified: boolean;
}

export interface VerifiedPositionSource {
  readonly sourceId: string;
  readonly recordHash: string;
  readonly observedAtMs: bigint;
  readonly ageMs: bigint;
  readonly unmappedInstruments: readonly string[];
  readonly record: PositionSnapshotRecord;
  /** True only when the record's authority is one the caller trusts and its signature verified here. */
  readonly signatureVerified: boolean;
}

export interface VerifiedPositions {
  readonly strategyAccount: string;
  readonly label: 'OBSERVED';
  readonly sources: readonly VerifiedPositionSource[];
  readonly positions: readonly NormalizedPosition[];
}

export interface VerifiedRiskGroup {
  readonly accountingAsset: AssetRef;
  readonly exposure: ExposureGraph;
  readonly closeCost: PackageCloseCostIndex;
  readonly stress: Readonly<{ readonly label: 'MODELED'; readonly results: readonly StressResult[] }>;
}

export interface VerifiedRisk {
  readonly positions: VerifiedPositions;
  readonly methodology: string;
  readonly byAccountingAsset: readonly VerifiedRiskGroup[];
}

export interface VerifiedStrategyQuoteProof {
  readonly orderHash: string;
  readonly graphHash: string;
  readonly quoteHash: string;
  readonly routeHash: string;
  readonly order: StrategyPackageOrder;
  readonly graph: PackageGraph;
  readonly quote: StrategyPackageQuote;
  readonly route: TypedStrategyRoute;
  readonly recordedAtMs: number;
  /** True when this runtime verified the embedded Ed25519 quote key over the quote hash. */
  readonly signatureVerified: boolean;
}

export interface VerifiedStrategyReceiptProof extends VerifiedStrategyQuoteProof {
  readonly receiptHash: string;
  readonly receipt: StrategyPackageReceipt;
  readonly receiptRecordedAtMs: number;
}

export interface VerifiedRouteDecision {
  readonly decisionHash: string;
  readonly solverId: string;
  readonly decision: RouteDecisionInput;
  /** Replayed locally; a decision with discrepancies stays on the record as exactly that. */
  readonly replay: RouteDecisionReplay;
  readonly receivedAtMs: number;
}

export interface VerifiedSolverManifest {
  readonly solverId: string;
  readonly manifestHash: string;
  readonly manifestNonce: number;
  readonly manifest: SolverCapabilityManifest;
  /** True when this runtime verified the operator's Ed25519 signature over the manifest hash. */
  readonly operatorSignatureVerified: boolean;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Bitcoin-alphabet base58, the encoding the order intake expects for Ed25519 signatures. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [];
  for (let index = zeros; index < bytes.length; index += 1) {
    let carry = bytes[index] as number;
    for (let digit = 0; digit < digits.length; digit += 1) {
      carry += (digits[digit] as number) << 8;
      digits[digit] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return '1'.repeat(zeros) + digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join('');
}

/** Decodes Bitcoin-alphabet base58; undefined for any character outside the alphabet. */
export function base58Decode(text: string): Uint8Array | undefined {
  if (typeof text !== 'string' || text.length > 256) return undefined;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  const bytes: number[] = [];
  for (let index = zeros; index < text.length; index += 1) {
    let carry = BASE58_ALPHABET.indexOf(text[index] as string);
    if (carry < 0) return undefined;
    for (let byte = 0; byte < bytes.length; byte += 1) {
      carry += (bytes[byte] as number) * 58;
      bytes[byte] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new NaryxEvidenceError(`${context} is not an object`);
  return value as Record<string, unknown>;
}

function list(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new NaryxEvidenceError(`${context} is not an array`);
  return value;
}

function big(value: unknown, context: string): bigint {
  if (typeof value !== 'bigint') throw new NaryxEvidenceError(`${context} is not an exact integer`);
  return value;
}

function optionalBig(value: unknown, context: string): bigint | undefined {
  return value === undefined ? undefined : big(value, context);
}

function count(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new NaryxEvidenceError(`${context} is not a count`);
  return value;
}

function hashHex(value: unknown, context: string): string {
  if (typeof value !== 'string' || !HASH_HEX.test(value)) throw new NaryxEvidenceError(`${context} is not a 32-byte hash`);
  return value;
}

function sameDomainRef(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function sameAssetRef(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function feeCap(caps: StrategyPackageOrder['maximumServiceFeesByAsset'], asset: AssetRef): bigint {
  return caps.find((cap) => sameAssetRef(cap.asset, asset))?.maxAtoms ?? 0n;
}

function sameAdapterRef(
  left: Readonly<{ adapterId: string; adapterManifestVersion: number; adapterManifestHash: Uint8Array }>,
  right: Readonly<{ adapterId: string; adapterManifestVersion: number; adapterManifestHash: Uint8Array }>,
): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function requireStrategyProof(condition: boolean, message: string): asserts condition {
  if (!condition) throw new NaryxEvidenceError(message);
}

/** Rebuilds every commitment and verifies the static links in a served strategy quote proof. */
export async function verifyStrategyQuoteProof(expectedQuoteHash: string, value: unknown): Promise<VerifiedStrategyQuoteProof> {
  const requested = hashHex(expectedQuoteHash, 'quote hash');
  const body = record(value, 'strategy quote proof');
  requireStrategyProof(body.version === 1, 'strategy quote proof has an unsupported version');
  let order: StrategyPackageOrder;
  let graph: PackageGraph;
  let quote: StrategyPackageQuote;
  let route: TypedStrategyRoute;
  let orderHash: string;
  let graphHash: string;
  let quoteHash: string;
  let routeHash: string;
  try {
    order = strategyPackageOrder(body.order as StrategyPackageOrderInput);
    graph = packageGraph(body.graph as PackageGraphInput);
    quote = strategyPackageQuote(body.quote as StrategyPackageQuoteInput);
    route = body.route as TypedStrategyRoute;
    orderHash = toHex(strategyPackageOrderHash(order));
    graphHash = toHex(packageGraphHash(graph));
    quoteHash = toHex(strategyPackageQuoteHash(quote));
    routeHash = toHex(typedStrategyRouteHash(route));
  } catch (error) {
    throw new NaryxEvidenceError(`strategy quote proof is malformed: ${(error as Error).message}`);
  }
  requireStrategyProof(hashHex(body.orderHash, 'served order hash') === orderHash, 'strategy order does not hash to its served hash');
  requireStrategyProof(hashHex(body.graphHash, 'served graph hash') === graphHash, 'strategy graph does not hash to its served hash');
  requireStrategyProof(hashHex(body.quoteHash, 'served quote hash') === quoteHash && quoteHash === requested, 'strategy quote does not hash to the requested hash');
  requireStrategyProof(hashHex(body.routeHash, 'served route hash') === routeHash, 'strategy route does not hash to its served hash');
  requireStrategyProof(toHex(order.graphHash) === graphHash, 'strategy order does not bind the served graph');
  requireStrategyProof(toHex(quote.orderHash) === orderHash && toHex(route.orderHash) === orderHash, 'strategy quote or route does not bind the served order');
  requireStrategyProof(toHex(quote.graphHash) === graphHash && toHex(route.graphHash) === graphHash, 'strategy quote or route does not bind the served graph');
  requireStrategyProof(toHex(quote.routeHash) === routeHash, 'strategy quote does not bind the served route');
  requireStrategyProof(order.environment === graph.environment && quote.environment === graph.environment && route.environment === graph.environment,
    'strategy proof environments differ');
  requireStrategyProof(order.templateId === graph.templateId && quote.templateId === graph.templateId
    && order.templateVersion === graph.templateVersion && quote.templateVersion === graph.templateVersion,
  'strategy proof templates differ');
  requireStrategyProof(bytesEqual(order.packageTemplateManifestHash, graph.packageTemplateManifestHash)
    && bytesEqual(quote.packageTemplateManifestHash, graph.packageTemplateManifestHash),
  'strategy proof template manifests differ');
  requireStrategyProof(order.seriesId === graph.seriesId && quote.seriesId === graph.seriesId
    && order.seriesVersion === graph.seriesVersion && quote.seriesVersion === graph.seriesVersion
    && bytesEqual(order.seriesManifestHash, graph.seriesManifestHash) && bytesEqual(quote.seriesManifestHash, graph.seriesManifestHash),
  'strategy proof series identities differ');
  requireStrategyProof(order.executionClassId === graph.executionClassId && quote.executionClassId === graph.executionClassId
    && order.executionClassVersion === graph.executionClassVersion && quote.executionClassVersion === graph.executionClassVersion
    && bytesEqual(order.executionClassManifestHash, graph.executionClassManifestHash)
    && bytesEqual(quote.executionClassManifestHash, graph.executionClassManifestHash),
  'strategy proof execution classes differ');
  requireStrategyProof(order.owner === graph.owner && order.lifecycleAction === graph.lifecycleAction,
    'strategy proof owner or lifecycle action differs');
  requireStrategyProof(order.settlementClass === graph.settlementClass && quote.settlementClass === graph.settlementClass
    && route.settlementClass === graph.settlementClass, 'strategy proof settlement classes differ');
  requireStrategyProof(order.quoteConventionId === quote.quoteConventionId && order.riskClassId === quote.riskClassId,
    'strategy proof quote convention or risk class differs');
  requireStrategyProof(order.expiryUnit === graph.expiryUnit && order.expiryValue <= graph.packageExpiryValue
    && quote.validUntilUnit === order.expiryUnit && quote.validUntilValue <= order.expiryValue
    && route.routeExpiryUnit === order.expiryUnit && route.routeExpiryValue > 0n && route.routeExpiryValue <= quote.validUntilValue,
  'strategy proof validity windows are inconsistent');
  requireStrategyProof(route.solverId === quote.solverId, 'strategy route names another solver');

  const graphDomains = graph.legs.reduce<DomainRef[]>((domains, leg) => {
    if (!domains.some((domain) => sameDomainRef(domain, leg.domain))) domains.push(leg.domain);
    return domains;
  }, []).sort((left, right) => left.domainId.localeCompare(right.domainId));
  requireStrategyProof(graphDomains.length === quote.domains.length
    && graphDomains.every((domain, index) => sameDomainRef(domain, quote.domains[index]!)),
  'strategy quote domains do not match the graph');

  const graphLegs = [...graph.legs].sort((left, right) => left.legId.localeCompare(right.legId));
  const quoteLegs = [...quote.legEconomics].sort((left, right) => left.legId.localeCompare(right.legId));
  const routeLegs = [...route.legs].sort((left, right) => left.legId.localeCompare(right.legId));
  requireStrategyProof(graphLegs.length === quoteLegs.length && graphLegs.length === routeLegs.length,
    'strategy proof leg counts differ');
  for (let index = 0; index < graphLegs.length; index += 1) {
    const graphLeg = graphLegs[index]!;
    const quoteLeg = quoteLegs[index]!;
    const routeLeg = routeLegs[index]!;
    const group = graph.executionGroups.find((candidate) => candidate.legIds.includes(graphLeg.legId));
    const stage = graph.stages.findIndex((candidate) => candidate.includes(graphLeg.legId));
    requireStrategyProof(quoteLeg.legId === graphLeg.legId && routeLeg.legId === graphLeg.legId,
      `strategy proof leg ${graphLeg.legId} is missing or reordered`);
    requireStrategyProof(quoteLeg.quantity.atoms === graphLeg.quantityAtoms
      && quoteLeg.quantity.asset.assetId === graphLeg.quantityAsset.assetId
      && quoteLeg.quantity.asset.decimals === graphLeg.quantityAsset.decimals
      && bytesEqual(quoteLeg.quantity.asset.assetManifestHash, graphLeg.quantityAsset.assetManifestHash),
    `strategy quote quantity differs for ${graphLeg.legId}`);
    requireStrategyProof(routeLeg.legFamily === graphLeg.legFamily
      && sameDomainRef(routeLeg.domain, graphLeg.domain)
      && sameAdapterRef(routeLeg.adapter, graphLeg.adapter)
      && routeLeg.stage === stage
      && routeLeg.groupId === group?.groupId,
    `strategy route differs from the graph for ${graphLeg.legId}`);
  }
  requireStrategyProof(quote.legEconomics.reduce((sum, leg) => sum + leg.grossNotional.atoms, 0n) === quote.totalGrossNotional.atoms,
    'strategy quote gross notional total is inconsistent');
  requireStrategyProof(quote.legEconomics.reduce((sum, leg) => sum + leg.marginDelta.atoms, 0n) === quote.totalMarginDelta.atoms,
    'strategy quote margin total is inconsistent');
  requireStrategyProof(quote.legEconomics.reduce((sum, leg) => sum + leg.residualValue.atoms, 0n) === quote.totalResidualValue.atoms,
    'strategy quote residual total is inconsistent');

  const plans = [...route.domainPlans].sort((left, right) => left.domain.domainId.localeCompare(right.domain.domainId));
  requireStrategyProof(plans.length === graphDomains.length, 'strategy route domain plan count differs from the graph');
  for (let index = 0; index < graphDomains.length; index += 1) {
    const domain = graphDomains[index]!;
    const plan = plans[index]!;
    const domainLegs = routeLegs.filter((leg) => sameDomainRef(leg.domain, domain));
    const legIds = domainLegs.map((leg) => leg.legId).sort();
    const kinds = [...new Set(domainLegs.map((leg) => leg.executionPlanKind))];
    requireStrategyProof(sameDomainRef(plan.domain, domain) && kinds.length === 1 && plan.executionPlanKind === kinds[0]
      && plan.legIds.length === legIds.length && [...plan.legIds].sort().every((legId, legIndex) => legId === legIds[legIndex])
      && plan.stageCount === new Set(domainLegs.map((leg) => leg.stage)).size,
    `strategy route domain plan differs for ${domain.domainId}`);
  }
  requireStrategyProof(quote.solverSignatureScheme === 'ED25519', 'strategy quote uses an unsupported signature scheme');
  const verdict = await webCryptoEd25519(quote.solverVerificationKey, strategyPackageQuoteHash(quote), quote.signature);
  if (verdict === false) throw new NaryxEvidenceError('strategy quote signature does not verify');
  const signatureVerified = verdict === true;
  return Object.freeze({
    orderHash,
    graphHash,
    quoteHash,
    routeHash,
    order,
    graph,
    quote,
    route,
    recordedAtMs: count(body.recordedAtMs, 'recordedAtMs'),
    signatureVerified,
  });
}

/** Rebuilds a terminal receipt and verifies its complete order, graph, quote, and route proof. */
export async function verifyStrategyReceiptProof(expectedReceiptHash: string, value: unknown): Promise<VerifiedStrategyReceiptProof> {
  const requested = hashHex(expectedReceiptHash, 'receipt hash');
  const body = record(value, 'strategy receipt proof');
  requireStrategyProof(body.version === 1, 'strategy receipt proof has an unsupported version');
  let receipt: StrategyPackageReceipt;
  let receiptHash: string;
  try {
    receipt = strategyPackageReceipt(body.receipt as StrategyPackageReceiptInput);
    receiptHash = toHex(strategyPackageReceiptHash(receipt));
  } catch (error) {
    throw new NaryxEvidenceError(`strategy receipt proof is malformed: ${(error as Error).message}`);
  }
  requireStrategyProof(hashHex(body.receiptHash, 'served receipt hash') === receiptHash && receiptHash === requested,
    'strategy receipt does not hash to the requested hash');
  const quoteProof = await verifyStrategyQuoteProof(toHex(receipt.quoteHash), body.quoteProof);
  requireStrategyProof(toHex(receipt.orderHash) === quoteProof.orderHash
    && toHex(receipt.graphHash) === quoteProof.graphHash
    && toHex(receipt.quoteHash) === quoteProof.quoteHash
    && toHex(receipt.routeHash) === quoteProof.routeHash,
  'strategy receipt does not bind the proved order, graph, quote, and route');
  requireStrategyProof(receipt.environment === quoteProof.order.environment
    && receipt.owner === quoteProof.order.owner
    && receipt.templateId === quoteProof.order.templateId
    && receipt.templateVersion === quoteProof.order.templateVersion
    && bytesEqual(receipt.packageTemplateManifestHash, quoteProof.order.packageTemplateManifestHash),
  'strategy receipt order identity differs');
  requireStrategyProof(receipt.seriesId === quoteProof.order.seriesId
    && receipt.seriesVersion === quoteProof.order.seriesVersion
    && bytesEqual(receipt.seriesManifestHash, quoteProof.order.seriesManifestHash),
  'strategy receipt series identity differs');
  requireStrategyProof(receipt.executionClassId === quoteProof.order.executionClassId
    && receipt.executionClassVersion === quoteProof.order.executionClassVersion
    && bytesEqual(receipt.executionClassManifestHash, quoteProof.order.executionClassManifestHash),
  'strategy receipt execution class differs');
  requireStrategyProof(receipt.lifecycleAction === quoteProof.order.lifecycleAction.toLowerCase().replaceAll('_', '-')
    && receipt.settlementClass === quoteProof.order.settlementClass
    && receipt.solverId === quoteProof.quote.solverId
    && sameAssetRef(receipt.quoteAsset, quoteProof.order.quoteAsset),
  'strategy receipt lifecycle, settlement, solver, or quote asset differs');
  requireStrategyProof(receipt.domains.length === quoteProof.quote.domains.length
    && receipt.domains.every((domain, index) => sameDomainRef(domain, quoteProof.quote.domains[index]!)),
  'strategy receipt domains differ from the selected quote');

  const graphLegs = [...quoteProof.graph.legs].sort((left, right) => left.legId.localeCompare(right.legId));
  const quoteLegs = [...quoteProof.quote.legEconomics].sort((left, right) => left.legId.localeCompare(right.legId));
  const outcomes = [...receipt.legOutcomes].sort((left, right) => left.legId.localeCompare(right.legId));
  requireStrategyProof(graphLegs.length === outcomes.length, 'strategy receipt does not report every graph leg');
  for (let index = 0; index < graphLegs.length; index += 1) {
    const graphLeg = graphLegs[index]!;
    const quoteLeg = quoteLegs[index]!;
    const outcome = outcomes[index]!;
    const settled = outcome.settledQuantity.atoms < 0n ? -outcome.settledQuantity.atoms : outcome.settledQuantity.atoms;
    requireStrategyProof(outcome.legId === graphLeg.legId && quoteLeg.legId === graphLeg.legId,
      `strategy receipt leg ${graphLeg.legId} is missing or reordered`);
    requireStrategyProof(sameDomainRef(outcome.domain, graphLeg.domain)
      && sameAssetRef(outcome.requestedQuantity.asset, graphLeg.quantityAsset)
      && outcome.requestedQuantity.atoms === graphLeg.quantityAtoms
      && sameAssetRef(outcome.settledQuantity.asset, graphLeg.quantityAsset)
      && settled <= graphLeg.quantityAtoms,
    `strategy receipt quantity or domain differs for ${graphLeg.legId}`);
    requireStrategyProof(outcome.status !== 'EXECUTED' || settled >= graphLeg.minimumQuantityAtoms,
      `strategy receipt executed less than the minimum for ${graphLeg.legId}`);
    requireStrategyProof(outcome.venueFee.atoms <= quoteLeg.venueFee.atoms,
      `strategy receipt venue fee exceeds the quote for ${graphLeg.legId}`);
  }

  const quoteCharge = (category: 'PROTOCOL' | 'SOLVER'): bigint => quoteProof.quote.serviceCharges
    .find((charge) => charge.category === category)?.amount.atoms ?? 0n;
  const quoteCost = (category: 'VENUE' | 'NETWORK'): bigint => quoteProof.quote.passThroughCosts
    .find((cost) => cost.category === category)?.amount.atoms ?? 0n;
  requireStrategyProof(receipt.serviceFee.atoms <= quoteCharge('PROTOCOL'), 'strategy receipt service fee exceeds the quote');
  requireStrategyProof(receipt.solverFee.atoms <= quoteCharge('SOLVER'), 'strategy receipt solver fee exceeds the quote');
  requireStrategyProof(receipt.venueFees.atoms <= quoteCost('VENUE'), 'strategy receipt venue fees exceed the quote');
  requireStrategyProof(receipt.networkCost.atoms <= quoteCost('NETWORK'), 'strategy receipt network cost exceeds the quote');
  requireStrategyProof(receipt.serviceFee.atoms + receipt.solverFee.atoms
      <= feeCap(quoteProof.order.maximumServiceFeesByAsset, receipt.quoteAsset),
  'strategy receipt service fees exceed the signed cap');
  requireStrategyProof(receipt.venueFees.atoms <= feeCap(quoteProof.order.maximumVenueFeesByAsset, receipt.quoteAsset),
    'strategy receipt venue fees exceed the signed cap');
  requireStrategyProof(receipt.networkCost.atoms <= feeCap(quoteProof.order.maximumNetworkFeesByAsset, receipt.quoteAsset),
    'strategy receipt network cost exceeds the signed cap');
  requireStrategyProof(receipt.recoveryCost.atoms <= feeCap(quoteProof.order.maximumRecoveryCostByAsset, receipt.quoteAsset),
    'strategy receipt recovery cost exceeds the signed cap');
  requireStrategyProof(receipt.terminalResidualValue.atoms <= quoteProof.order.maximumResidualValue.atoms,
    'strategy receipt residual exceeds the signed cap');
  return Object.freeze({
    ...quoteProof,
    receiptHash,
    receipt,
    receiptRecordedAtMs: count(body.recordedAtMs, 'receiptRecordedAtMs'),
  });
}

function checkId(value: string, name: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`invalid ${name}`);
  return value;
}

function levels(value: unknown, context: string): readonly PackageBookLevelView[] {
  return Object.freeze(
    list(value, context).map((entry, index) => {
      const level = record(entry, `${context}[${index}]`);
      return Object.freeze({
        priceTicks: big(level.priceTicks, `${context}[${index}].priceTicks`),
        directQuantity: big(level.directQuantity, `${context}[${index}].directQuantity`),
        impliedQuantity: big(level.impliedQuantity, `${context}[${index}].impliedQuantity`),
      });
    }),
  );
}

function documents<T>(value: unknown, context: string): readonly RegisteredDocumentView<T>[] {
  return Object.freeze(
    list(value, context).map((entry, index) => {
      const document = record(entry, `${context}[${index}]`);
      if (typeof document.subjectId !== 'string' || typeof document.kind !== 'string') throw new NaryxEvidenceError(`${context}[${index}] is malformed`);
      hashHex(document.documentHashHex, `${context}[${index}].documentHashHex`);
      return document as unknown as RegisteredDocumentView<T>;
    }),
  );
}

function sizeQuotes(value: unknown, sizes: readonly bigint[], label: 'EXECUTABLE' | 'INDICATIVE', context: string): readonly SizeQuoteView[] {
  const quotes = list(value, context);
  if (quotes.length !== sizes.length) throw new NaryxEvidenceError(`${context} does not answer every requested size`);
  return Object.freeze(
    quotes.map((entry, index) => {
      const quote = record(entry, `${context}[${index}]`);
      const size = big(quote.size, `${context}[${index}].size`);
      if (size !== sizes[index]) throw new NaryxEvidenceError(`${context}[${index}] answers another size`);
      if (quote.label !== label) throw new NaryxEvidenceError(`${context}[${index}] must be labeled ${label}`);
      const fillableQuantity = big(quote.fillableQuantity, `${context}[${index}].fillableQuantity`);
      const averagePriceTicks = optionalBig(quote.averagePriceTicks, `${context}[${index}].averagePriceTicks`);
      if (fillableQuantity > size || (averagePriceTicks === undefined) !== (fillableQuantity < size)) {
        throw new NaryxEvidenceError(`${context}[${index}] reports a price for depth it does not have`);
      }
      return Object.freeze({ size, fillableQuantity, label, ...(averagePriceTicks === undefined ? {} : { averagePriceTicks }) });
    }),
  );
}

function observedTrade(value: unknown, context: string): ObservedTrade | undefined {
  if (value === undefined) return undefined;
  const trade = record(value, context);
  if (trade.label !== 'OBSERVED') throw new NaryxEvidenceError(`${context} must be labeled OBSERVED`);
  const quantity = big(trade.quantity, `${context}.quantity`);
  if (quantity <= 0n) throw new NaryxEvidenceError(`${context} has no traded quantity`);
  return Object.freeze({
    priceTicks: big(trade.priceTicks, `${context}.priceTicks`),
    quantity,
    recordedAtMs: count(trade.recordedAtMs, `${context}.recordedAtMs`),
    allocationHash: hashHex(trade.allocationHash, `${context}.allocationHash`),
    label: 'OBSERVED' as const,
  });
}

function verifiedQualification(value: unknown, hash: unknown, objectType: string, objectId: string, context: string): VerifiedQualificationRecord {
  let record: QualificationRecord;
  let recordHash: string;
  try {
    record = qualificationRecord(value as QualificationRecordInput);
    recordHash = toHex(qualificationRecordHash(value as QualificationRecordInput));
  } catch (error) {
    throw new NaryxEvidenceError(`${context} is malformed: ${(error as Error).message}`);
  }
  if (hash !== recordHash) throw new NaryxEvidenceError(`${context} does not hash to its served hash`);
  if (record.objectType !== objectType || record.objectId !== objectId) throw new NaryxEvidenceError(`${context} is for another object`);
  return Object.freeze({ record, recordHash });
}

/** Verifies an Ed25519 signature with Web Crypto; undefined when the runtime lacks Ed25519. */
async function webCryptoEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean | undefined> {
  const subtle = (globalThis as { crypto?: { subtle?: { importKey: Function; verify: Function } } }).crypto?.subtle;
  if (subtle === undefined) return undefined;
  let key: unknown;
  try {
    key = await subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    return undefined;
  }
  return (await subtle.verify({ name: 'Ed25519' }, key, signature, message)) as boolean;
}

function sizesQuery(sizes: readonly bigint[]): string {
  if (!Array.isArray(sizes) || sizes.length === 0 || sizes.length > 16 || sizes.some((size) => typeof size !== 'bigint' || size <= 0n)) {
    throw new TypeError('sizes must be 1 to 16 positive integers');
  }
  return sizes.join(',');
}

/**
 * Client for the public Naryx v1 API. It holds no key and signs nothing. It never trusts served
 * evidence it can check: allocations are re-hashed and re-verified against the policy they bind,
 * order validation and route-decision replay are recomputed locally and must agree with the
 * server, and candle series are rebuilt from the tape on request.
 */
/** Signs a strategy command hash with the actor's own Ed25519 key; the key never enters the SDK. */
export type StrategyCommandSigner = (commandHash: Uint8Array) => Promise<Uint8Array>;

export type StrategyCommandAuthorizationSigner =
  | {
    readonly scheme: 'ED25519';
    readonly signerId: string;
    readonly sign: StrategyCommandSigner;
  }
  | {
    readonly scheme: 'EIP712_SECP256K1';
    readonly signerId: string;
    readonly sign: (typedData: ReturnType<typeof strategyCommandAuthorizationTypedData>) => Promise<string>;
  };

async function createStrategyCommandAuthorization(
  command: StrategyCommandInput,
  signer: StrategyCommandAuthorizationSigner,
) {
  if (signer.scheme === 'ED25519') {
    const signature = await signer.sign(strategyCommandHash(command));
    if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new TypeError('the Ed25519 signer must return a 64-byte signature');
    return Object.freeze({ scheme: signer.scheme, signature: base58Encode(signature) });
  }
  if (!isEvmStrategyActor(signer.signerId)) throw new TypeError('the EVM signer id must be a canonical lowercase address');
  const signature = (await signer.sign(strategyCommandAuthorizationTypedData(command, signer.signerId))).toLowerCase();
  if (!/^0x[0-9a-f]{130}$/.test(signature)) throw new TypeError('the EVM signer must return a 65-byte hex signature');
  return Object.freeze({ scheme: signer.scheme, signature });
}

export interface VerifiedStrategyCommand {
  readonly commandHash: string;
  readonly command: StrategyCommandInput;
  /** True only when the actor's own key verified the signature here. */
  readonly signatureVerified: boolean;
  readonly receipt?: StrategyTransitionReceipt;
  readonly recordedAtMs: number;
}

/** A market catalogue whose hash was recomputed here; search it locally with `search`. */
export interface VerifiedMarketCatalogue {
  readonly catalogue: MarketCatalogue;
  readonly catalogueHash: string;
  /** True only when the signing authority is one the caller trusts and the signature verifies. */
  readonly signatureVerified: boolean;
  /** Whether the catalogue was current by this machine's clock when it was read. */
  readonly current: boolean;
  /** Filters the downloaded catalogue in this process; no request is made. */
  search(query: MarketCatalogueQuery): readonly MarketCatalogueEntry[];
}

export class NaryxClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  /** The highest catalogue sequence accepted per environment and authority, so an older one cannot be replayed. */
  readonly #catalogueSequences = new Map<string, bigint>();

  constructor(options: NaryxClientOptions) {
    if (typeof options !== 'object' || options === null || typeof options.baseUrl !== 'string') throw new TypeError('baseUrl is required');
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (!BASE_URL.test(baseUrl)) throw new TypeError('baseUrl must be HTTPS, or HTTP on a loopback host');
    const supplied = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (typeof supplied !== 'function') throw new TypeError('no fetch implementation is available');
    this.#baseUrl = baseUrl;
    this.#fetch = supplied;
  }

  async #request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const init = body === undefined
      ? { method, headers: { Accept: 'application/json' } }
      : { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(toProtocolJson(body)) };
    const response = await this.#fetch(`${this.#baseUrl}${path}`, init);
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new NaryxEvidenceError('response is too large');
    if (!contentType.startsWith('application/json')) throw new NaryxEvidenceError('response is not JSON');
    let parsed: unknown;
    try {
      parsed = fromProtocolJson(JSON.parse(text));
    } catch {
      throw new NaryxEvidenceError('response is not valid protocol JSON');
    }
    if (response.status !== 200) {
      const error = record(record(parsed, 'error response').error, 'error');
      throw new NaryxApiError(response.status, String(error.code), String(error.message));
    }
    return parsed;
  }

  // ---------------------------------------------------------------- registries

  async listDomains(): Promise<readonly RegisteredDocumentView[]> {
    return documents(record(await this.#request('GET', '/v1/domains'), 'domains').domains, 'domains');
  }

  async listInstruments(): Promise<readonly RegisteredDocumentView[]> {
    return documents(record(await this.#request('GET', '/v1/instruments'), 'instruments').instruments, 'instruments');
  }

  async listPackageTemplates(): Promise<readonly RegisteredDocumentView[]> {
    return documents(record(await this.#request('GET', '/v1/package-templates'), 'templates').templates, 'templates');
  }

  async getPackageTemplate(templateId: string, templateVersion: number): Promise<RegisteredDocumentView> {
    if (!Number.isSafeInteger(templateVersion) || templateVersion < 1) throw new TypeError('invalid template version');
    const [document] = documents([await this.#request('GET', `/v1/package-templates/${checkId(templateId, 'template id')}/${templateVersion}`)], 'template');
    return document as RegisteredDocumentView;
  }

  async listSolvers(): Promise<readonly Record<string, unknown>[]> {
    return list(record(await this.#request('GET', '/v1/solvers'), 'solvers').solvers, 'solvers').map((entry, index) => record(entry, `solvers[${index}]`));
  }

  async getSolver(solverId: string): Promise<Record<string, unknown>> {
    const solver = record(await this.#request('GET', `/v1/solvers/${checkId(solverId, 'solver id')}`), 'solver');
    if (solver.solverId !== solverId) throw new NaryxEvidenceError('solver response is for another solver');
    hashHex(solver.manifestHash, 'solver.manifestHash');
    return solver;
  }

  async listStrategySeries(): Promise<readonly Record<string, unknown>[]> {
    return list(record(await this.#request('GET', '/v1/strategy-series'), 'series').series, 'series').map((entry, index) => record(entry, `series[${index}]`));
  }

  async listExecutionClasses(seriesId: string): Promise<readonly Record<string, unknown>[]> {
    const body = record(await this.#request('GET', `/v1/strategy-series/${checkId(seriesId, 'series id')}/execution-classes`), 'execution classes');
    return list(body.executionClasses, 'executionClasses').map((entry, index) => {
      const executionClass = record(entry, `executionClasses[${index}]`);
      if (executionClass.seriesId !== seriesId) throw new NaryxEvidenceError('an execution class belongs to another series');
      return executionClass;
    });
  }

  // ---------------------------------------------------------------- package markets

  async listMarkets(): Promise<readonly PackageMarketSummary[]> {
    const body = record(await this.#request('GET', '/v1/markets'), 'markets');
    return Object.freeze(
      list(body.markets, 'markets').map((entry, index) => {
        const market = record(entry, `markets[${index}]`);
        if (typeof market.packageMarketId !== 'string' || typeof market.halted !== 'boolean' || market.label !== 'EXECUTABLE') {
          throw new NaryxEvidenceError(`markets[${index}] is malformed`);
        }
        const bestBidTicks = optionalBig(market.bestBidTicks, 'bestBidTicks');
        const bestAskTicks = optionalBig(market.bestAskTicks, 'bestAskTicks');
        if (bestBidTicks !== undefined && bestAskTicks !== undefined && bestBidTicks >= bestAskTicks) {
          throw new NaryxEvidenceError(`markets[${index}] reports a crossed executable book`);
        }
        const spreadTicks = optionalBig(market.spreadTicks, 'spreadTicks');
        return Object.freeze({
          packageMarketId: market.packageMarketId,
          halted: market.halted,
          matchingPolicyHash: hashHex(market.matchingPolicyHash, 'matchingPolicyHash'),
          label: 'EXECUTABLE' as const,
          ...(bestBidTicks === undefined ? {} : { bestBidTicks }),
          ...(bestAskTicks === undefined ? {} : { bestAskTicks }),
          ...(spreadTicks === undefined ? {} : { spreadTicks }),
        });
      }),
    );
  }

  async getDepth(packageMarketId: string): Promise<PackageDepth> {
    checkId(packageMarketId, 'package market id');
    const body = record(await this.#request('GET', `/v1/markets/${packageMarketId}/package-depth`), 'depth');
    if (body.packageMarketId !== packageMarketId) throw new NaryxEvidenceError('depth is for another market');
    if (typeof body.halted !== 'boolean') throw new NaryxEvidenceError('depth header is malformed');
    return Object.freeze({
      packageMarketId,
      matchingPolicyHash: hashHex(body.matchingPolicyHash, 'matchingPolicyHash'),
      halted: body.halted,
      asOfValue: big(body.asOfValue, 'asOfValue'),
      bids: levels(body.bids, 'bids'),
      asks: levels(body.asks, 'asks'),
    });
  }

  async getTape(packageMarketId: string, page: { readonly after?: number; readonly limit?: number } = {}): Promise<PackageTapePage> {
    checkId(packageMarketId, 'package market id');
    const after = page.after ?? 0;
    const limit = page.limit ?? 50;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('after must be a nonnegative cursor and limit between 1 and 100');
    }
    const body = record(await this.#request('GET', `/v1/markets/${packageMarketId}/package-tape?after=${after}&limit=${limit}`), 'tape');
    if (body.packageMarketId !== packageMarketId) throw new NaryxEvidenceError('tape is for another market');
    let previous = after;
    const trades = list(body.trades, 'tape.trades').map((entry, index) => {
      const trade = record(entry, `tape.trades[${index}]`);
      const cursor = count(trade.cursor, `tape.trades[${index}].cursor`);
      if (cursor <= previous) throw new NaryxEvidenceError('tape cursors must strictly increase past the requested cursor');
      previous = cursor;
      if (trade.takerSide !== 'BID' && trade.takerSide !== 'ASK') throw new NaryxEvidenceError('trade side is malformed');
      return Object.freeze({
        cursor,
        allocationHash: hashHex(trade.allocationHash, 'trade.allocationHash'),
        takerSide: trade.takerSide,
        recordedAtMs: count(trade.recordedAtMs, `tape.trades[${index}].recordedAtMs`),
        fills: Object.freeze(
          list(trade.fills, `tape.trades[${index}].fills`).map((value, fillIndex) => {
            const fill = record(value, `tape.trades[${index}].fills[${fillIndex}]`);
            if (typeof fill.makerSource !== 'string') throw new NaryxEvidenceError('fill source is malformed');
            return Object.freeze({
              fillSequence: big(fill.fillSequence, 'fill.fillSequence'),
              priceTicks: big(fill.priceTicks, 'fill.priceTicks'),
              quantity: big(fill.quantity, 'fill.quantity'),
              makerSource: fill.makerSource,
            });
          }),
        ),
      });
    });
    if (trades.length > limit) throw new NaryxEvidenceError('tape returned more trades than requested');
    const nextCursor = count(body.nextCursor, 'tape.nextCursor');
    if (nextCursor !== previous) throw new NaryxEvidenceError('tape cursor does not follow its last trade');
    return Object.freeze({ packageMarketId, trades: Object.freeze(trades), nextCursor });
  }

  async getCandles(packageMarketId: string, query: { readonly interval: CandleInterval; readonly fromMs?: number; readonly toMs?: number }): Promise<CandlePage> {
    checkId(packageMarketId, 'package market id');
    if (!Object.hasOwn(CANDLE_INTERVAL_MS, query.interval)) throw new TypeError('unknown candle interval');
    const params = [`interval=${query.interval}`];
    for (const [name, value] of [['from', query.fromMs], ['to', query.toMs]] as const) {
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be nonnegative milliseconds`);
      params.push(`${name}=${value}`);
    }
    const body = record(await this.#request('GET', `/v1/markets/${packageMarketId}/candles?${params.join('&')}`), 'candles');
    if (body.packageMarketId !== packageMarketId || body.interval !== query.interval) throw new NaryxEvidenceError('candles are for another market or interval');
    if (body.label !== 'OBSERVED') throw new NaryxEvidenceError('public candles must be labeled OBSERVED');
    let previousOpen = -1;
    const candles = list(body.candles, 'candles').map((entry, index) => {
      const candle = record(entry, `candles[${index}]`);
      const openTimeMs = count(candle.openTimeMs, 'openTimeMs');
      if (openTimeMs <= previousOpen || openTimeMs % CANDLE_INTERVAL_MS[query.interval] !== 0) throw new NaryxEvidenceError('candles are unordered or misaligned');
      previousOpen = openTimeMs;
      const open = big(candle.open, 'open');
      const high = big(candle.high, 'high');
      const low = big(candle.low, 'low');
      const close = big(candle.close, 'close');
      if (high < open || high < close || low > open || low > close) throw new NaryxEvidenceError('candle range does not contain open and close');
      return Object.freeze({ openTimeMs, open, high, low, close, volume: big(candle.volume, 'volume'), tradeCount: count(candle.tradeCount, 'tradeCount') });
    });
    return Object.freeze({
      packageMarketId,
      label: 'OBSERVED' as const,
      interval: query.interval,
      methodologyVersion: count(body.methodologyVersion, 'methodologyVersion'),
      fromMs: count(body.fromMs, 'fromMs'),
      toMs: count(body.toMs, 'toMs'),
      truncated: body.truncated === true,
      candles: Object.freeze(candles),
    });
  }

  async getIndex(packageMarketId: string, sizes: readonly bigint[]): Promise<ExecutablePackageIndex & { readonly asOfValue: bigint }> {
    checkId(packageMarketId, 'package market id');
    if (sizes.length === 0 || sizes.length > 16 || sizes.some((size) => typeof size !== 'bigint' || size <= 0n)) throw new TypeError('sizes must be 1 to 16 positive integers');
    const body = record(await this.#request('GET', `/v1/markets/${packageMarketId}/index?sizes=${sizes.join(',')}`), 'index');
    const executable = record(body.executable, 'index.executable');
    for (const side of ['bids', 'asks'] as const) {
      for (const quote of list(executable[side], `index.executable.${side}`)) {
        if (record(quote, 'quote').label !== 'EXECUTABLE') throw new NaryxEvidenceError('executable index entries must be labeled EXECUTABLE');
      }
    }
    return body as unknown as ExecutablePackageIndex & { readonly asOfValue: bigint };
  }

  /** Live solver shard quotes for a market, each with its quote mode and settlement class. */
  async getMarketQuotes(packageMarketId: string): Promise<readonly Record<string, unknown>[]> {
    checkId(packageMarketId, 'package market id');
    const body = record(await this.#request('GET', `/v1/markets/${packageMarketId}/quotes`), 'quotes');
    const modes = new Set(['IMPLIED', 'EXECUTION_COMMITMENT', 'FIRM_SIMULATED', 'FIRM_ONCHAIN', 'FIRM_BONDED']);
    return list(body.quotes, 'quotes').map((entry, index) => {
      const quote = record(entry, `quotes[${index}]`);
      if (typeof quote.quoteMode !== 'string' || !modes.has(quote.quoteMode)) throw new NaryxEvidenceError('every quote must carry a known quote mode');
      return quote;
    });
  }

  async getSolverCapacity(solverId: string): Promise<Record<string, unknown>> {
    const body = record(await this.#request('GET', `/v1/solvers/${checkId(solverId, 'solver id')}/capacity`), 'capacity');
    if (body.solverId !== solverId) throw new NaryxEvidenceError('capacity is for another solver');
    return body;
  }

  async getImpliedProvenance(packageMarketId: string): Promise<readonly Record<string, unknown>[]> {
    checkId(packageMarketId, 'package market id');
    const body = record(await this.#request('GET', `/v1/package-book/${packageMarketId}/implied-provenance`), 'provenance');
    return list(body.implied, 'implied').map((entry, index) => record(entry, `implied[${index}]`));
  }

  /** Fetches the allocation for an order the caller submitted and verifies it before returning it. */
  async getVerifiedAllocation(takerOrderId: string): Promise<VerifiedSettlementAllocation> {
    if (!HASH_HEX.test(takerOrderId)) throw new TypeError('taker order id must be 32 bytes of lowercase hex');
    const body = record(await this.#request('GET', `/v1/allocations/${takerOrderId}`), 'allocation response');
    const evidence = verifyAllocationEvidence(takerOrderId, body.allocation, body.matchingPolicy);
    if (body.allocationHash !== evidence.allocationHash) {
      throw new NaryxEvidenceError('allocation response hash is inconsistent');
    }
    const settlementCommitment = packageSettlementCommitment(
      body.settlementCommitment as PackageSettlementCommitmentInput,
    );
    const settlementCommitmentHash = toHex(packageSettlementCommitmentHash(settlementCommitment));
    if (
      body.settlementCommitmentHash !== settlementCommitmentHash
      || toHex(settlementCommitment.packageOrderId) !== takerOrderId
      || settlementCommitment.environment !== evidence.allocation.environment
      || settlementCommitment.executionClassId !== evidence.allocation.executionClassId
      || settlementCommitment.quantity !== evidence.allocation.requestedQuantity
    ) {
      throw new NaryxEvidenceError('allocation settlement commitment is inconsistent');
    }
    let settlementHandoff: PackageSettlementHandoff | undefined;
    let settlementHandoffHash: string | undefined;
    if (body.settlementHandoff !== undefined || body.settlementHandoffHash !== undefined) {
      settlementHandoff = packageSettlementHandoff(body.settlementHandoff as PackageSettlementHandoff);
      settlementHandoffHash = toHex(packageSettlementHandoffHash(settlementHandoff));
      if (
        body.settlementHandoffHash !== settlementHandoffHash
        || toHex(settlementHandoff.allocationHash) !== evidence.allocationHash
        || settlementHandoff.executionClassId !== evidence.allocation.executionClassId
        || !bytesEqual(
          settlementHandoff.takerSettlementCommitmentHash,
          packageSettlementCommitmentHash(settlementCommitment),
        )
      ) {
        throw new NaryxEvidenceError('allocation settlement handoff is inconsistent');
      }
      try {
        verifyPackageSettlementHandoff(evidence.allocation, settlementHandoff);
      } catch (error) {
        throw new NaryxEvidenceError(`allocation settlement handoff failed verification: ${(error as Error).message}`);
      }
    }
    if ((evidence.allocation.fills.length > 0) !== (settlementHandoff !== undefined)) {
      throw new NaryxEvidenceError('allocation settlement handoff presence is inconsistent');
    }
    return Object.freeze({
      ...evidence,
      settlementCommitment,
      settlementCommitmentHash,
      ...(settlementHandoff === undefined || settlementHandoffHash === undefined
        ? {}
        : { settlementHandoff, settlementHandoffHash }),
    });
  }

  async getPackageSettlementProgress(packageOrderId: string): Promise<PackageSettlementProgressView> {
    if (!HASH_HEX.test(packageOrderId)) throw new TypeError('package order id must be 32 bytes of lowercase hex');
    const body = record(
      await this.#request('GET', `/v1/package-book/orders/${packageOrderId}/settlement-readiness`),
      'package settlement progress',
    );
    const readiness = packageSettlementReadiness(body.readiness as PackageSettlementReadiness);
    const readinessHash = toHex(packageSettlementReadinessHash(readiness));
    if (body.readinessHashHex !== readinessHash || toHex(readiness.packageOrderId) !== packageOrderId) {
      throw new NaryxEvidenceError('package settlement readiness is inconsistent');
    }
    const obligations = list(body.obligations, 'package settlement obligations').map((value, index) => {
      const obligation = record(value, `package settlement obligations[${index}]`);
      const continuous = obligation.evidenceKind === 'CONTINUOUS_ALLOCATION';
      const reopening = obligation.evidenceKind === 'REOPENING_RESULT';
      const continuousRole = obligation.role === 'TAKER' || obligation.role === 'MAKER';
      const reopeningRole = obligation.role === 'BID' || obligation.role === 'ASK';
      const hasCounterparty = obligation.counterpartyOrderIdHex !== undefined;
      if ((!continuous && !reopening)
        || typeof obligation.evidenceHashHex !== 'string' || !HASH_HEX.test(obligation.evidenceHashHex)
        || typeof obligation.fillSequence !== 'bigint' || obligation.fillSequence < 0n
        || (!continuousRole && !reopeningRole)
        || (obligation.liquiditySource !== 'DIRECT' && obligation.liquiditySource !== 'IMPLIED')
        || typeof obligation.priceTicks !== 'bigint'
        || typeof obligation.quantity !== 'bigint' || obligation.quantity <= 0n
        || (hasCounterparty
          && (typeof obligation.counterpartyOrderIdHex !== 'string' || !HASH_HEX.test(obligation.counterpartyOrderIdHex)))
        || (continuous !== continuousRole)
        || (reopening !== reopeningRole)
        || (continuous && ((obligation.liquiditySource === 'DIRECT') !== hasCounterparty))
        || (continuous && obligation.role === 'MAKER' && obligation.liquiditySource !== 'DIRECT')
        || (reopening && (obligation.liquiditySource !== 'DIRECT' || !hasCounterparty))) {
        throw new NaryxEvidenceError('package settlement obligation is malformed');
      }
      return Object.freeze({
        evidenceKind: obligation.evidenceKind,
        evidenceHashHex: obligation.evidenceHashHex,
        fillSequence: obligation.fillSequence,
        role: obligation.role,
        ...(obligation.counterpartyOrderIdHex === undefined
          ? {}
          : { counterpartyOrderIdHex: obligation.counterpartyOrderIdHex }),
        liquiditySource: obligation.liquiditySource,
        priceTicks: obligation.priceTicks,
        quantity: obligation.quantity,
      }) as PackageSettlementObligationView;
    });
    const allocatedQuantity = obligations.reduce((sum, obligation) => sum + obligation.quantity, 0n);
    const evidenceRefs = [...new Map(obligations.map((obligation) => [
      `${obligation.evidenceKind}:${obligation.evidenceHashHex}`,
      { kind: obligation.evidenceKind, evidenceHash: obligation.evidenceHashHex },
    ])).values()].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'CONTINUOUS_ALLOCATION' ? -1 : 1;
      return left.evidenceHash < right.evidenceHash ? -1 : left.evidenceHash > right.evidenceHash ? 1 : 0;
    });
    if (allocatedQuantity !== readiness.allocatedQuantity
      || evidenceRefs.length !== readiness.evidenceRefs.length
      || evidenceRefs.some((reference, index) => {
        const expected = readiness.evidenceRefs[index];
        return expected?.kind !== reference.kind || toHex(expected.evidenceHash) !== reference.evidenceHash;
      })) {
      throw new NaryxEvidenceError('package settlement obligations do not reproduce readiness');
    }
    return Object.freeze({ readiness, readinessHash, obligations: Object.freeze(obligations) });
  }

  async getPackageReopening(resultHash: string): Promise<VerifiedPackageReopening> {
    const expectedHash = hashHex(resultHash, 'reopening result hash');
    const body = record(
      await this.#request('GET', `/v1/package-book/reopenings/${expectedHash}`),
      'package reopening result',
    );
    const result = packageReopeningResult(body.result as PackageReopeningResult);
    if (body.resultHash !== expectedHash || toHex(packageReopeningResultHash(result)) !== expectedHash) {
      throw new NaryxEvidenceError('package reopening result hash is inconsistent');
    }
    let settlementHandoff: PackageReopeningSettlementHandoff | undefined;
    let settlementHandoffHash: string | undefined;
    if (body.settlementHandoff !== undefined || body.settlementHandoffHash !== undefined) {
      settlementHandoff = packageReopeningSettlementHandoff(
        body.settlementHandoff as PackageReopeningSettlementHandoff,
      );
      settlementHandoffHash = toHex(packageReopeningSettlementHandoffHash(settlementHandoff));
      if (body.settlementHandoffHash !== settlementHandoffHash) {
        throw new NaryxEvidenceError('package reopening settlement handoff hash is inconsistent');
      }
      try {
        verifyPackageReopeningSettlementHandoff(result, settlementHandoff);
      } catch (error) {
        throw new NaryxEvidenceError(`package reopening settlement handoff failed verification: ${(error as Error).message}`);
      }
    }
    if ((result.fills.length > 0) !== (settlementHandoff !== undefined)) {
      throw new NaryxEvidenceError('package reopening settlement handoff presence is inconsistent');
    }
    return Object.freeze({
      result,
      resultHash: expectedHash,
      ...(settlementHandoff === undefined || settlementHandoffHash === undefined
        ? {}
        : { settlementHandoff, settlementHandoffHash }),
    });
  }

  /** Queues one signed, settlement-backed order while its package market is halted. */
  async submitPackageReopeningOrder(
    draft: PackageBookOrderDraft,
    settlementDraft: PackageBookSettlementDraft,
    sign: OrderSigner,
  ): Promise<PackageReopeningOrderSubmission> {
    if (typeof sign !== 'function') throw new TypeError('an order signer is required');
    const provisional: PackageTakerOrderInput = { ...draft, orderId: '00'.repeat(32) };
    const orderId = toHex(packageTakerOrderHash(provisional));
    const order: PackageTakerOrderInput = Object.freeze({ ...draft, orderId });
    const settlementCommitment = packageSettlementCommitment({
      version: 1,
      ...settlementDraft,
      executionClassId: order.executionClassId,
      packageOrderId: orderId,
      participantId: order.participantId,
      quantity: order.quantity,
    });
    const participantKey = base58Decode(order.participantId);
    if (participantKey?.length !== 32 || order.commonControlGroupId !== order.participantId) {
      throw new TypeError('public package book participants use their Ed25519 key as participant and control-group id');
    }
    const signature = await sign(packageSettlementCommitmentBytes(settlementCommitment));
    if (!(signature instanceof Uint8Array) || signature.length !== 64) {
      throw new TypeError('the signer must return a 64-byte signature');
    }
    const body = record(
      await this.#request('POST', '/v1/package-book/reopening/orders', {
        order,
        settlementCommitment,
        authorization: { scheme: 'ED25519', signature: base58Encode(signature) },
      }),
      'package reopening order submission',
    );
    const entry = record(body.entry, 'package reopening entry');
    const expectedCommitmentHash = toHex(packageSettlementCommitmentHash(settlementCommitment));
    if (
      body.accepted !== true
      || body.queuedForReopening !== true
      || body.packageMarketId !== order.executionClassId
      || body.orderId !== orderId
      || typeof body.replayed !== 'boolean'
      || body.settlementCommitmentHash !== expectedCommitmentHash
      || !(entry.entryId instanceof Uint8Array)
      || toHex(entry.entryId) !== orderId
      || entry.quantity !== order.quantity
    ) {
      throw new NaryxEvidenceError('package reopening order response is inconsistent');
    }
    return Object.freeze({
      accepted: true,
      queuedForReopening: true,
      order,
      replayed: body.replayed,
      settlementCommitmentHash: expectedCommitmentHash,
    });
  }

  /** Signs and submits one order to the native package book. Matching is not venue settlement. */
  async submitPackageBookOrder(
    draft: PackageBookOrderDraft,
    settlementDraft: PackageBookSettlementDraft,
    sign: OrderSigner,
  ): Promise<PackageBookOrderSubmission> {
    if (typeof sign !== 'function') throw new TypeError('an order signer is required');
    const provisional: PackageTakerOrderInput = { ...draft, orderId: '00'.repeat(32) };
    const orderId = toHex(packageTakerOrderHash(provisional));
    const order: PackageTakerOrderInput = Object.freeze({ ...draft, orderId });
    const settlementCommitment = packageSettlementCommitment({
      version: 1,
      ...settlementDraft,
      executionClassId: order.executionClassId,
      packageOrderId: orderId,
      participantId: order.participantId,
      quantity: order.quantity,
    });
    const participantKey = base58Decode(order.participantId);
    if (participantKey?.length !== 32 || order.commonControlGroupId !== order.participantId) {
      throw new TypeError('public package book participants use their Ed25519 key as participant and control-group id');
    }
    const signature = await sign(packageSettlementCommitmentBytes(settlementCommitment));
    if (!(signature instanceof Uint8Array) || signature.length !== 64) {
      throw new TypeError('the signer must return a 64-byte signature');
    }
    const body = record(
      await this.#request('POST', '/v1/package-book/orders', {
        order,
        settlementCommitment,
        authorization: { scheme: 'ED25519', signature: base58Encode(signature) },
      }),
      'package book submission',
    );
    if (body.packageMarketId !== order.executionClassId || body.orderId !== orderId || typeof body.accepted !== 'boolean') {
      throw new NaryxEvidenceError('package book response is for another order or market');
    }
    if (!body.accepted) {
      if (typeof body.rejection !== 'string') throw new NaryxEvidenceError('package book rejection is malformed');
      return Object.freeze({ accepted: false, order, rejection: body.rejection });
    }
    const expectedCommitmentHash = toHex(packageSettlementCommitmentHash(settlementCommitment));
    if (
      typeof body.replayed !== 'boolean'
      || typeof body.allocationHash !== 'string'
      || body.settlementCommitmentHash !== expectedCommitmentHash
    ) {
      throw new NaryxEvidenceError('package book allocation response is malformed');
    }
    const evidence = verifyAllocationEvidence(orderId, body.allocation, body.matchingPolicy);
    if (body.allocationHash !== evidence.allocationHash) {
      throw new NaryxEvidenceError('package book allocation hash is inconsistent');
    }
    let settlementHandoff: PackageSettlementHandoff | undefined;
    let settlementHandoffHash: string | undefined;
    if (body.settlementHandoff !== undefined || body.settlementHandoffHash !== undefined) {
      settlementHandoff = packageSettlementHandoff(body.settlementHandoff as PackageSettlementHandoff);
      settlementHandoffHash = toHex(packageSettlementHandoffHash(settlementHandoff));
      if (
        body.settlementHandoffHash !== settlementHandoffHash
        || toHex(settlementHandoff.allocationHash) !== evidence.allocationHash
        || settlementHandoff.executionClassId !== order.executionClassId
        || !bytesEqual(
          settlementHandoff.takerSettlementCommitmentHash,
          packageSettlementCommitmentHash(settlementCommitment),
        )
      ) {
        throw new NaryxEvidenceError('package settlement handoff is inconsistent');
      }
      try {
        verifyPackageSettlementHandoff(evidence.allocation, settlementHandoff);
      } catch (error) {
        throw new NaryxEvidenceError(`package settlement handoff failed verification: ${(error as Error).message}`);
      }
    }
    if ((evidence.allocation.fills.length > 0) !== (settlementHandoff !== undefined)) {
      throw new NaryxEvidenceError('package settlement handoff presence is inconsistent');
    }
    return Object.freeze({
      accepted: true,
      order,
      replayed: body.replayed,
      evidence,
      settlementCommitmentHash: expectedCommitmentHash,
      ...(settlementHandoff === undefined || settlementHandoffHash === undefined
        ? {}
        : { settlementHandoff, settlementHandoffHash }),
    });
  }

  /** Compare-and-swaps one live package-book entry with its participant key. */
  async amendPackageBookOrder(
    amendmentInput: PackageBookAmendmentInput,
    sign: OrderSigner,
  ): Promise<PackageBookAmendmentResult> {
    const amendment = packageBookAmendment(amendmentInput);
    if (base58Decode(amendment.participantId)?.length !== 32) {
      throw new TypeError('participant id must be a canonical Ed25519 public key');
    }
    if (typeof sign !== 'function') throw new TypeError('an order signer is required');
    const signature = await sign(packageBookAmendmentBytes(amendment));
    if (!(signature instanceof Uint8Array) || signature.length !== 64) {
      throw new TypeError('the signer must return a 64-byte signature');
    }
    const expectedHash = toHex(packageBookAmendmentHash(amendment));
    const body = record(
      await this.#request('POST', '/v1/package-book/amendments', {
        amendment,
        authorization: { scheme: 'ED25519', signature: base58Encode(signature) },
      }),
      'package book amendment',
    );
    const entry = record(body.entry, 'amended package book entry');
    if (
      body.amended !== true
      || body.packageMarketId !== amendment.executionClassId
      || body.entryId !== toHex(amendment.entryId)
      || body.amendmentHash !== expectedHash
      || typeof body.replayed !== 'boolean'
      || !(entry.entryId instanceof Uint8Array)
      || toHex(entry.entryId) !== toHex(amendment.entryId)
      || entry.participantId !== amendment.participantId
      || entry.quantity !== (amendment.quantity ?? amendment.expectedQuantity)
      || entry.priceTicks !== (amendment.priceTicks ?? amendment.expectedPriceTicks)
    ) {
      throw new NaryxEvidenceError('package book amendment response is inconsistent');
    }
    return Object.freeze({
      amended: true,
      amendment,
      amendmentHash: expectedHash,
      replayed: body.replayed,
    });
  }

  /** Cancels one live native package-book order with its participant key. */
  async cancelPackageBookOrder(
    packageMarketId: string,
    entryId: string,
    participantId: string,
    sign: OrderSigner,
  ): Promise<PackageBookCancellationResult> {
    const cancellation: PackageBookCancellationInput = {
      version: 1,
      executionClassId: checkId(packageMarketId, 'package market id'),
      entryId: hashHex(entryId, 'entry id'),
      participantId: checkId(participantId, 'participant id'),
    };
    if (base58Decode(cancellation.participantId)?.length !== 32) {
      throw new TypeError('participant id must be a canonical Ed25519 public key');
    }
    if (typeof sign !== 'function') throw new TypeError('an order signer is required');
    const signature = await sign(packageBookCancellationBytes(cancellation));
    if (!(signature instanceof Uint8Array) || signature.length !== 64) {
      throw new TypeError('the signer must return a 64-byte signature');
    }
    const expectedHash = toHex(packageBookCancellationHash(cancellation));
    const body = record(
      await this.#request('POST', '/v1/package-book/cancellations', {
        cancellation,
        authorization: { scheme: 'ED25519', signature: base58Encode(signature) },
      }),
      'package book cancellation',
    );
    if (
      body.cancelled !== true ||
      body.packageMarketId !== cancellation.executionClassId ||
      body.entryId !== cancellation.entryId ||
      body.cancellationHash !== expectedHash ||
      typeof body.replayed !== 'boolean'
    ) {
      throw new NaryxEvidenceError('package book cancellation response is inconsistent');
    }
    return Object.freeze(body as unknown as PackageBookCancellationResult);
  }

  // ---------------------------------------------------------------- orders and evidence

  /**
   * Submits an order signed by its owner. The order is validated and hashed locally first, the
   * signer sees only the canonical bytes, and the server must acknowledge the same hash. Intake is
   * not execution: an accepted order is only eligible to be quoted.
   */
  async submitOrder(order: PackageOrderInput, sign: OrderSigner): Promise<SubmittedOrder> {
    if (typeof sign !== 'function') throw new TypeError('an order signer is required');
    const validated = validatePackageOrderProfile(order);
    const orderHash = toHex(packageOrderHash(validated));
    const signature = await sign(packageOrderBytes(validated));
    if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new TypeError('the signer must return a 64-byte signature');
    const body = record(
      await this.#request('POST', '/v1/orders', { order: validated, authorization: { scheme: 'ED25519', signature: base58Encode(signature) } }),
      'order intake',
    );
    if (body.orderHashHex !== orderHash) throw new NaryxEvidenceError('the server acknowledged a different order hash');
    if (body.status !== 'ACCEPTED_FOR_QUOTING' || typeof body.replayed !== 'boolean') throw new NaryxEvidenceError('order intake response is malformed');
    return Object.freeze({ orderHash, replayed: body.replayed, status: 'ACCEPTED_FOR_QUOTING' as const });
  }

  /** Reads an order's status. A served order must hash to the requested order hash. */
  async getOrder(orderHash: string): Promise<OrderStatusView> {
    const requested = hashHex(orderHash, 'order hash');
    const body = record(await this.#request('GET', `/v1/orders/${requested}`), 'order');
    if (body.orderHash !== requested) throw new NaryxEvidenceError('order response is for another order');
    const status = body.status;
    if (typeof status !== 'string' || (status !== 'OPEN' && !Object.hasOwn(TERMINAL_STATE, status))) throw new NaryxEvidenceError('order status is unknown');
    let order: PackageOrder | undefined;
    if (body.order !== undefined) {
      try {
        order = validatePackageOrderProfile(body.order as PackageOrderInput);
      } catch {
        throw new NaryxEvidenceError('the served order failed validation');
      }
      if (toHex(packageOrderHash(order)) !== requested) throw new NaryxEvidenceError('the served order does not hash to the requested order');
      if (body.owner !== order.owner) throw new NaryxEvidenceError('the served owner is not the order owner');
    }
    if (status === 'OPEN' && (body.outcomeHash !== undefined || body.receiptHash !== undefined)) throw new NaryxEvidenceError('an open order cannot carry outcome evidence');
    if (status !== 'OPEN' && body.outcomeHash === undefined) throw new NaryxEvidenceError('a terminal order must name its outcome hash');
    return Object.freeze({
      orderHash: requested,
      status: status as TerminalState | 'OPEN',
      ...(order === undefined ? {} : { order, owner: order.owner }),
      ...(typeof body.authorizationSignature === 'string' ? { authorizationSignature: body.authorizationSignature } : {}),
      ...(body.receivedAtMs === undefined ? {} : { receivedAtMs: count(body.receivedAtMs, 'receivedAtMs') }),
      ...(body.outcomeHash === undefined ? {} : { outcomeHash: hashHex(body.outcomeHash, 'outcomeHash') }),
      ...(body.receiptHash === undefined ? {} : { receiptHash: hashHex(body.receiptHash, 'receiptHash') }),
    });
  }

  /**
   * Follows an order until it has a terminal outcome, reading its status every `intervalMs`, and
   * returns the terminal status. OPEN only means no outcome is recorded yet. It stops with an error
   * after `timeoutMs` or when `signal` aborts; it never infers execution from silence.
   */
  async watchOrder(orderHash: string, options: { readonly intervalMs?: number; readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<OrderStatusView> {
    const intervalMs = options.intervalMs ?? 2_000;
    const timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || !Number.isSafeInteger(timeoutMs) || timeoutMs < intervalMs) {
      throw new TypeError('intervalMs must be at least 100 and timeoutMs at least intervalMs');
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (options.signal?.aborted === true) throw new Error('watchOrder was aborted');
      const status = await this.getOrder(orderHash);
      if (status.status !== 'OPEN') return status;
      if (Date.now() + intervalMs > deadline) throw new Error('the order has no terminal outcome within the timeout');
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /**
   * Subscribes to public market data over `/v1/stream` with the runtime's WebSocket. Depth arrives
   * labeled EXECUTABLE and tape labeled OBSERVED, exactly as the HTTP routes serve them; tape trade
   * cursors must strictly advance or the message is reported as an error instead.
   */
  subscribeMarket(packageMarketId: string, channels: readonly ('package-depth' | 'package-tape')[], onMessage: (message: Record<string, unknown>) => void, options: { readonly tapeAfter?: number } = {}) {
    const market = checkId(packageMarketId, 'package market id');
    const Socket = (globalThis as { WebSocket?: new (url: string) => { send(text: string): void; close(): void; addEventListener(type: string, listener: (event: { data?: unknown }) => void): void } }).WebSocket;
    if (Socket === undefined) throw new TypeError('no WebSocket implementation is available');
    const url = new URL(`${this.#baseUrl}/v1/stream`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new Socket(url.toString());
    let tapeCursor = options.tapeAfter ?? -1;
    socket.addEventListener('open', () => {
      for (const channel of channels) {
        socket.send(JSON.stringify(toProtocolJson({ op: 'subscribe', channel, packageMarketId: market, ...(channel === 'package-tape' && options.tapeAfter !== undefined ? { after: options.tapeAfter } : {}) })));
      }
    });
    socket.addEventListener('message', (event) => {
      let message: Record<string, unknown>;
      try {
        message = fromProtocolJson(JSON.parse(String(event.data))) as Record<string, unknown>;
      } catch {
        onMessage({ type: 'error', code: 'INVALID_MESSAGE', message: 'the stream sent a message that is not protocol JSON' });
        return;
      }
      if (message.type === 'subscribed' && message.channel === 'package-tape' && typeof message.after === 'number') tapeCursor = message.after;
      if (message.type === 'package-depth' && message.label !== 'EXECUTABLE') {
        onMessage({ type: 'error', code: 'MISLABELED', message: 'depth must be labeled EXECUTABLE' });
        return;
      }
      if (message.type === 'package-tape') {
        if (message.label !== 'OBSERVED' || !Array.isArray(message.trades)) {
          onMessage({ type: 'error', code: 'MISLABELED', message: 'tape must be labeled OBSERVED' });
          return;
        }
        for (const trade of message.trades as Record<string, unknown>[]) {
          if (typeof trade.cursor !== 'number' || trade.cursor <= tapeCursor) {
            onMessage({ type: 'error', code: 'TAPE_OUT_OF_ORDER', message: 'tape cursors must strictly advance' });
            return;
          }
          tapeCursor = trade.cursor;
        }
      }
      onMessage(message);
    });
    return { close: () => socket.close() };
  }

  /**
   * Reads the terminal evidence of an order and verifies it without trusting the server. Pass the
   * accepted quote's fee terms to also check that the receipt charged nothing outside them.
   */
  async getReceipt(orderHash: string, options: { readonly acceptedQuoteFeeTerms?: AcceptedQuoteFeeTerms } = {}): Promise<VerifiedTerminalEvidence> {
    const requested = hashHex(orderHash, 'order hash');
    const body = record(await this.#request('GET', `/v1/receipts/${requested}`), 'receipt');
    if (body.orderHash !== requested) throw new NaryxEvidenceError('receipt response is for another order');
    return verifyTerminalEvidence(requested, body, options.acceptedQuoteFeeTerms);
  }

  /** Reads the selected generalized quote and route and verifies their four commitments locally. */
  async getStrategyQuoteProof(quoteHash: string): Promise<VerifiedStrategyQuoteProof> {
    const requested = hashHex(quoteHash, 'quote hash');
    return verifyStrategyQuoteProof(
      requested,
      await this.#request('GET', `/v1/strategy-quotes/${requested}/proof`),
    );
  }

  /** Reads and independently verifies a terminal strategy receipt and every document it binds. */
  async getStrategyReceiptProof(receiptHash: string): Promise<VerifiedStrategyReceiptProof> {
    const requested = hashHex(receiptHash, 'receipt hash');
    return verifyStrategyReceiptProof(
      requested,
      await this.#request('GET', `/v1/strategy-receipts/${requested}/proof`),
    );
  }

  /** Reads the terminal outcome of an order without its receipt, verified as `verifyOutcomeEvidence` does. */
  async getOutcome(orderHash: string): Promise<VerifiedOutcome> {
    const requested = hashHex(orderHash, 'order hash');
    const body = record(await this.#request('GET', `/v1/outcomes/${requested}`), 'outcome');
    if (body.orderHash !== requested) throw new NaryxEvidenceError('outcome response is for another order');
    return verifyOutcomeEvidence(requested, body);
  }

  /**
   * The series curve across its execution classes: executable prices at each size and the last
   * observed trade. Every point must answer every requested size with the right label.
   */
  async getCurve(seriesId: string, sizes: readonly bigint[] = [1n]): Promise<SeriesCurve> {
    checkId(seriesId, 'series id');
    const body = record(await this.#request('GET', `/v1/curves/${seriesId}?sizes=${sizesQuery(sizes)}`), 'curve');
    if (body.seriesId !== seriesId) throw new NaryxEvidenceError('curve is for another series');
    if (typeof body.quoteAsset !== 'string' || typeof body.quoteConvention !== 'string') throw new NaryxEvidenceError('curve header is malformed');
    const points = list(body.points, 'curve.points').map((entry, index) => {
      const point = record(entry, `curve.points[${index}]`);
      const context = `curve.points[${index}]`;
      if (typeof point.executionClassId !== 'string' || typeof point.settlementClass !== 'string' || typeof point.open !== 'boolean') {
        throw new NaryxEvidenceError(`${context} is malformed`);
      }
      const domains = list(point.domains, `${context}.domains`).map((domain) => {
        if (typeof domain !== 'string') throw new NaryxEvidenceError(`${context}.domains is malformed`);
        return domain;
      });
      if (!point.open) {
        if (point.executable !== undefined || point.lastTrade !== undefined) throw new NaryxEvidenceError(`${context} is closed but carries market data`);
        return Object.freeze({ executionClassId: point.executionClassId, settlementClass: point.settlementClass, domains: Object.freeze(domains), open: false });
      }
      if (typeof point.halted !== 'boolean') throw new NaryxEvidenceError(`${context}.halted is malformed`);
      const executable = record(point.executable, `${context}.executable`);
      const lastTrade = observedTrade(point.lastTrade, `${context}.lastTrade`);
      return Object.freeze({
        executionClassId: point.executionClassId,
        settlementClass: point.settlementClass,
        domains: Object.freeze(domains),
        open: true,
        halted: point.halted,
        executable: Object.freeze({
          bids: sizeQuotes(executable.bids, sizes, 'EXECUTABLE', `${context}.executable.bids`),
          asks: sizeQuotes(executable.asks, sizes, 'EXECUTABLE', `${context}.executable.asks`),
        }),
        ...(lastTrade === undefined ? {} : { lastTrade }),
      });
    });
    return Object.freeze({
      seriesId,
      quoteAsset: body.quoteAsset,
      quoteConvention: body.quoteConvention,
      asOfValue: big(body.asOfValue, 'asOfValue'),
      methodologyVersion: count(body.methodologyVersion, 'methodologyVersion'),
      points: Object.freeze(points),
    });
  }

  /** The executable index of every execution class of a series; unopened classes are marked. */
  async getSeriesIndex(seriesId: string, sizes: readonly bigint[] = [1n]): Promise<Record<string, unknown>> {
    checkId(seriesId, 'series id');
    const body = record(await this.#request('GET', `/v1/indices/${seriesId}?sizes=${sizesQuery(sizes)}`), 'series index');
    if (body.seriesId !== seriesId) throw new NaryxEvidenceError('index is for another series');
    for (const [index, entry] of list(body.executionClasses, 'executionClasses').entries()) {
      const executionClass = record(entry, `executionClasses[${index}]`);
      if (executionClass.open !== true) continue;
      const served = record(executionClass.index, `executionClasses[${index}].index`);
      const executable = record(served.executable, `executionClasses[${index}].index.executable`);
      const implied = record(served.withImplied, `executionClasses[${index}].index.withImplied`);
      sizeQuotes(executable.bids, sizes, 'EXECUTABLE', `executionClasses[${index}].executable.bids`);
      sizeQuotes(executable.asks, sizes, 'EXECUTABLE', `executionClasses[${index}].executable.asks`);
      sizeQuotes(implied.bids, sizes, 'INDICATIVE', `executionClasses[${index}].withImplied.bids`);
      sizeQuotes(implied.asks, sizes, 'INDICATIVE', `executionClasses[${index}].withImplied.asks`);
    }
    return body;
  }

  /**
   * Package markets with executable direct depth at the size on at least one side, tightest
   * executable spread first. Every entry must answer the requested size as EXECUTABLE.
   */
  async getOpportunities(size = 1n): Promise<readonly PackageOpportunity[]> {
    const body = record(await this.#request('GET', `/v1/opportunities?size=${sizesQuery([size])}`), 'opportunities');
    if (body.label !== 'EXECUTABLE' || body.size !== size) throw new NaryxEvidenceError('the opportunity feed must be EXECUTABLE at the requested size');
    let previousSpread: bigint | undefined;
    let spreadEnded = false;
    return Object.freeze(
      list(body.opportunities, 'opportunities').map((entry, index) => {
        const context = `opportunities[${index}]`;
        const opportunity = record(entry, context);
        if (typeof opportunity.packageMarketId !== 'string') throw new NaryxEvidenceError(`${context} is malformed`);
        const [bid] = opportunity.bid === undefined ? [] : sizeQuotes([opportunity.bid], [size], 'EXECUTABLE', `${context}.bid`);
        const [ask] = opportunity.ask === undefined ? [] : sizeQuotes([opportunity.ask], [size], 'EXECUTABLE', `${context}.ask`);
        if (bid?.averagePriceTicks === undefined && ask?.averagePriceTicks === undefined) throw new NaryxEvidenceError(`${context} has no executable side at the size`);
        const spread = optionalBig(opportunity.spreadAtSizeTicks, `${context}.spreadAtSizeTicks`);
        const expected = bid?.averagePriceTicks !== undefined && ask?.averagePriceTicks !== undefined ? ask.averagePriceTicks - bid.averagePriceTicks : undefined;
        if (spread !== expected) throw new NaryxEvidenceError(`${context} spread is not its ask minus its bid`);
        if (spread === undefined) spreadEnded = true;
        else if (spreadEnded || (previousSpread !== undefined && spread < previousSpread)) throw new NaryxEvidenceError('opportunities are not ordered by executable spread');
        if (spread !== undefined) previousSpread = spread;
        const lastTrade = observedTrade(opportunity.lastTrade, `${context}.lastTrade`);
        return Object.freeze({
          packageMarketId: opportunity.packageMarketId,
          ...(typeof opportunity.seriesId === 'string' ? { seriesId: opportunity.seriesId } : {}),
          ...(bid === undefined ? {} : { bid }),
          ...(ask === undefined ? {} : { ask }),
          ...(spread === undefined ? {} : { spreadAtSizeTicks: spread }),
          ...(lastTrade === undefined ? {} : { lastTrade }),
        });
      }),
    );
  }

  /**
   * The qualification record governing an object now. The record must hash to its served hash and
   * name the requested object; an expired or not yet effective record governs nothing.
   */
  async getQualification(objectType: QualificationObjectType, objectId: string): Promise<QualificationView> {
    if (!Object.hasOwn(QUALIFICATION_OBJECT_TYPE, objectType)) throw new TypeError('unknown qualification object type');
    checkId(objectId, 'object id');
    const body = record(await this.#request('GET', `/v1/qualification/${objectType}/${objectId}`), 'qualification');
    if (body.objectType !== objectType || body.objectId !== objectId) throw new NaryxEvidenceError('qualification is for another object');
    if (body.unavailable !== undefined) {
      if (body.unavailable !== 'NOT_YET_EFFECTIVE' && body.unavailable !== 'EXPIRED' && body.unavailable !== 'TIME_UNIT_UNSUPPORTED') {
        throw new NaryxEvidenceError('qualification unavailability is unknown');
      }
      return Object.freeze({ objectType, objectId, unavailable: body.unavailable });
    }
    const current = verifiedQualification(body.record, body.recordHash, objectType, objectId, 'qualification.record');
    const asOfValue = big(body.asOfValue, 'asOfValue');
    if (current.record.effectiveAtValue > asOfValue || (current.record.expiresAtValue !== undefined && asOfValue >= current.record.expiresAtValue)) {
      throw new NaryxEvidenceError('the served record does not govern at its own time');
    }
    return Object.freeze({ objectType, objectId, asOfValue, current });
  }

  /**
   * The full append-only history of an object. Each record is re-hashed, must chain to the one
   * before it, and must obey the kernel rules: a monitor never loosens qualification.
   */
  async getQualificationHistory(objectType: QualificationObjectType, objectId: string): Promise<readonly VerifiedQualificationRecord[]> {
    if (!Object.hasOwn(QUALIFICATION_OBJECT_TYPE, objectType)) throw new TypeError('unknown qualification object type');
    checkId(objectId, 'object id');
    const body = record(await this.#request('GET', `/v1/qualification/${objectType}/${objectId}/history`), 'qualification history');
    if (body.objectType !== objectType || body.objectId !== objectId) throw new NaryxEvidenceError('history is for another object');
    const records = list(body.records, 'records').map((entry, index) => {
      const served = record(entry, `records[${index}]`);
      return verifiedQualification(served.record, served.recordHash, objectType, objectId, `records[${index}]`);
    });
    // The activation delay is server policy; the chain, object, time order, and loosening rules are not.
    const verdict = verifyQualificationHistory(records.map((entry) => entry.record), 0n);
    if (!verdict.valid) throw new NaryxEvidenceError(`qualification history breaks at record ${verdict.index}: ${verdict.reason}`);
    return Object.freeze(records);
  }

  /**
   * Live signed solver quotes for a public order, each with the route it binds. Every quote must
   * re-hash to its served hash, bind the served route and the requested order, and carry its own
   * quote mode; Ed25519 signatures are verified locally wherever the runtime supports Ed25519.
   */
  /**
   * One exact solver manifest by the hash a quote binds. The manifest is re-validated and
   * re-hashed, and the operator's signature over its hash is verified here when the runtime can.
   */
  async getSolverManifest(solverId: string, manifestHash: string): Promise<VerifiedSolverManifest> {
    const id = checkId(solverId, 'solver id');
    const requested = hashHex(manifestHash, 'manifest hash');
    const body = record(await this.#request('GET', `/v1/solvers/${id}/manifests/${requested}`), 'solver manifest');
    let manifest: SolverCapabilityManifest;
    let computed: string;
    try {
      manifest = solverCapabilityManifest(body.manifest as SolverCapabilityManifestInput);
      computed = toHex(solverCapabilityManifestHash(body.manifest as SolverCapabilityManifestInput));
    } catch (error) {
      throw new NaryxEvidenceError(`solver manifest is malformed: ${(error as Error).message}`);
    }
    if (computed !== requested || body.manifestHash !== requested) throw new NaryxEvidenceError('solver manifest does not hash to the requested hash');
    if (manifest.solverId !== id || body.solverId !== id) throw new NaryxEvidenceError('solver manifest is for another solver');
    let operatorSignatureVerified = false;
    if (manifest.operatorIdentityScheme === 'ED25519') {
      const verdict = await webCryptoEd25519(manifest.operatorIdentityKey, fromHex(computed), manifest.signature);
      if (verdict === false) throw new NaryxEvidenceError('solver manifest operator signature does not verify');
      operatorSignatureVerified = verdict === true;
    }
    return Object.freeze({ solverId: id, manifestHash: computed, manifestNonce: count(body.manifestNonce, 'manifestNonce'), manifest, operatorSignatureVerified });
  }

  /**
   * Compiles a package graph on the server against its registered template and registry state.
   * The served graph hash must equal the local one; a slot-timed graph compiles at `atSlot`.
   */
  async compilePackageGraph(graph: PackageGraphInput, atSlot?: bigint) {
    const expected = toHex(packageGraphHash(graph));
    const body = record(await this.#request('POST', '/v1/packages/compile', { graph, ...(atSlot === undefined ? {} : { atSlot }) }), 'compiled graph');
    if (body.compiled === true && toHex(commitmentHash(body.graphHash as Uint8Array, 'graphHash')) !== expected) throw new NaryxEvidenceError('the compiled graph hash differs from the local hash');
    return body;
  }

  /** Simulates a graph's failure points on the server; they must equal the local simulation exactly. */
  async simulatePackageGraph(graph: PackageGraphInput) {
    const local = simulatePackageGraphFailures(graph);
    const body = record(await this.#request('POST', '/v1/packages/simulate', { graph }), 'simulated graph');
    if (body.label !== 'SIMULATED' || body.graphHash !== toHex(packageGraphHash(graph))) throw new NaryxEvidenceError('the simulation is unlabeled or for another graph');
    if (JSON.stringify(toProtocolJson(body.failurePoints)) !== JSON.stringify(toProtocolJson(local))) throw new NaryxEvidenceError('the served failure points differ from the local simulation');
    return Object.freeze({ graphHash: body.graphHash as string, stages: body.stages, failurePoints: local });
  }

  /** Builds the exact unsigned OPEN command from a finalized entry receipt. */
  async prepareStrategyOpen(receiptHash: string) {
    const requestedReceiptHash = hashHex(receiptHash, 'receipt hash');
    const body = record(await this.#request('POST', '/v1/strategies/open/prepare', {
      receiptHash: requestedReceiptHash,
    }), 'prepared strategy open');
    const command = body.command as StrategyCommandInput;
    const commandHash = toHex(strategyCommandHash(command));
    if (command.parameters.kind !== 'OPEN') throw new NaryxEvidenceError('the prepared strategy command is not an opening');
    const state = strategyState(command.parameters.state);
    const stateHash = toHex(strategyStateHash(state));
    if (body.receiptHashHex !== requestedReceiptHash || body.commandHashHex !== commandHash || body.stateHashHex !== stateHash) {
      throw new NaryxEvidenceError('the prepared strategy opening commitments do not match locally derived hashes');
    }
    return Object.freeze({
      command,
      commandHash,
      stateHash,
      orderHash: hashHex(body.orderHashHex, 'order hash'),
      receiptHash: requestedReceiptHash,
    });
  }

  /** Builds an exact unsigned lifecycle command from one finalized transition receipt. */
  async prepareStrategyTransition(strategyId: string, receiptHash: string) {
    const requestedStrategyId = checkId(strategyId, 'strategy id');
    const requestedReceiptHash = hashHex(receiptHash, 'receipt hash');
    const body = record(await this.#request('POST', '/v1/strategies/transitions/prepare', {
      strategyId: requestedStrategyId,
      receiptHash: requestedReceiptHash,
    }), 'prepared strategy transition');
    const command = body.command as StrategyCommandInput;
    const commandHash = toHex(strategyCommandHash(command));
    if (command.strategyId !== requestedStrategyId || command.parameters.kind !== 'APPLY_PACKAGE') {
      throw new NaryxEvidenceError('the prepared lifecycle command targets another strategy or operation');
    }
    const state = strategyState(command.parameters.nextState);
    const stateHash = toHex(strategyStateHash(state));
    if (body.receiptHashHex !== requestedReceiptHash || body.commandHashHex !== commandHash || body.stateHashHex !== stateHash) {
      throw new NaryxEvidenceError('the prepared lifecycle commitments do not match locally derived hashes');
    }
    return Object.freeze({
      command,
      commandHash,
      stateHash,
      orderHash: hashHex(body.orderHashHex, 'order hash'),
      receiptHash: requestedReceiptHash,
    });
  }

  /**
   * Signs and submits one strategy command. The command is hashed locally and only its hash goes
   * to the caller's signer; the server's acknowledgement must name that exact hash.
   */
  async submitStrategyCommand(
    command: StrategyCommandInput,
    sign: StrategyCommandSigner,
    /** Other owners' consents over the same command hash, as a novation needs from the new owner. */
    consents: readonly { readonly signerId: string; readonly sign: StrategyCommandSigner }[] = [],
  ) {
    if (typeof sign !== 'function') throw new TypeError('a strategy command signer is required');
    if (!Array.isArray(consents) || consents.length > 3) throw new TypeError('at most three consents');
    const commandHash = strategyCommandHash(command);
    const signature = await sign(commandHash);
    if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new TypeError('the signer must return a 64-byte signature');
    const consentBodies = [];
    for (const consent of consents) {
      const consentSignature = await consent.sign(commandHash);
      if (!(consentSignature instanceof Uint8Array) || consentSignature.length !== 64) throw new TypeError('a consent signer must return a 64-byte signature');
      consentBodies.push({ scheme: 'ED25519', signerId: consent.signerId, signature: base58Encode(consentSignature) });
    }
    const body = record(await this.#request('POST', '/v1/strategies/commands', {
      command,
      authorization: { scheme: 'ED25519', signature: base58Encode(signature) },
      ...(consentBodies.length === 0 ? {} : { consents: consentBodies }),
    }), 'strategy command');
    if (body.accepted !== true || body.commandHashHex !== toHex(commandHash)) throw new NaryxEvidenceError('the server acknowledged a different strategy command');
    return Object.freeze({ commandHash: toHex(commandHash), replayed: body.replayed === true, ...(body.receipt === undefined ? {} : { receipt: body.receipt as StrategyTransitionReceipt }) });
  }

  async submitAuthorizedStrategyCommand(
    command: StrategyCommandInput,
    signer: StrategyCommandAuthorizationSigner,
    consents: readonly StrategyCommandAuthorizationSigner[] = [],
  ) {
    if (signer.signerId !== command.actorId) throw new TypeError('the primary signer must be the command actor');
    if (!Array.isArray(consents) || consents.length > 3) throw new TypeError('at most three consents');
    const commandHash = strategyCommandHash(command);
    const authorization = await createStrategyCommandAuthorization(command, signer);
    const consentBodies = [];
    for (const consent of consents) {
      consentBodies.push({ signerId: consent.signerId, ...await createStrategyCommandAuthorization(command, consent) });
    }
    const body = record(await this.#request('POST', '/v1/strategies/commands', {
      command,
      authorization,
      ...(consentBodies.length === 0 ? {} : { consents: consentBodies }),
    }), 'strategy command');
    if (body.accepted !== true || body.commandHashHex !== toHex(commandHash)) throw new NaryxEvidenceError('the server acknowledged a different strategy command');
    return Object.freeze({ commandHash: toHex(commandHash), replayed: body.replayed === true, ...(body.receipt === undefined ? {} : { receipt: body.receipt as StrategyTransitionReceipt }) });
  }

  /**
   * Attributes the caller's order to a builder. Only the attribution hash goes to the owner's
   * signer, and the server must acknowledge that exact hash.
   */
  async submitBuilderAttribution(attribution: BuilderAttributionInput, sign: StrategyCommandSigner) {
    const hash = builderAttributionHash(attribution);
    const signature = await sign(hash);
    if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new TypeError('the signer must return a 64-byte signature');
    const body = record(await this.#request('POST', '/v1/builders/attributions', { attribution, authorization: { scheme: 'ED25519', signature: base58Encode(signature) } }), 'builder attribution');
    if (body.attributionHash !== toHex(hash)) throw new NaryxEvidenceError('the server acknowledged a different attribution');
    return Object.freeze({ attributionHash: toHex(hash), replayed: body.replayed === true });
  }

  /** A builder's current manifest, re-hashed here; the served hash must match. */
  async getBuilder(builderId: string): Promise<{ readonly manifest: BuilderManifestInput; readonly manifestHash: string }> {
    const id = checkId(builderId, 'builder id');
    const body = record(await this.#request('GET', `/v1/builders/${id}`), 'builder');
    const manifest = body.manifest as BuilderManifestInput;
    let hash: string;
    try {
      hash = toHex(builderManifestHash(manifest));
    } catch (error) {
      throw new NaryxEvidenceError(`builder manifest is malformed: ${(error as Error).message}`);
    }
    if (manifest.builderId !== id || body.manifestHash !== hash) throw new NaryxEvidenceError('the builder manifest is another builder or does not match its hash');
    return Object.freeze({ manifest, manifestHash: hash });
  }

  /** Payable builder fees by asset, labeled OBSERVED. */
  async getBuilderRevenue(builderId: string): Promise<readonly { readonly assetId: string; readonly atoms: bigint; readonly orders: number }[]> {
    const id = checkId(builderId, 'builder id');
    const body = record(await this.#request('GET', `/v1/builders/${id}/revenue`), 'builder revenue');
    if (body.builderId !== id || body.label !== 'OBSERVED') throw new NaryxEvidenceError('builder revenue is another builder or unlabeled');
    return Object.freeze(list(body.payableByAsset, 'payableByAsset').map((entry, index) => {
      const row = record(entry, `payableByAsset[${index}]`);
      return Object.freeze({ assetId: String(row.assetId), atoms: big(row.atoms, `payableByAsset[${index}].atoms`), orders: count(row.orders, `payableByAsset[${index}].orders`) });
    }));
  }

  /** A strategy's current state, re-validated and re-hashed here; the served hash must match. */
  async getStrategy(strategyId: string): Promise<{ readonly state: StrategyState; readonly stateHash: string; readonly originReceiptHash?: string; readonly retiredByCommandHash?: string }> {
    const id = checkId(strategyId, 'strategy id');
    const body = record(await this.#request('GET', `/v1/strategies/${id}`), 'strategy');
    let state: StrategyState;
    try {
      state = strategyState(body.state as StrategyState);
    } catch (error) {
      throw new NaryxEvidenceError(`strategy state is malformed: ${(error as Error).message}`);
    }
    const stateHash = toHex(strategyStateHash(state));
    if (state.strategyId !== id || body.stateHash !== stateHash) throw new NaryxEvidenceError('the strategy state is another strategy or does not match its hash');
    return Object.freeze({
      state,
      stateHash,
      ...(typeof body.originReceiptHash === 'string' ? { originReceiptHash: body.originReceiptHash } : {}),
      ...(typeof body.retiredByCommandHash === 'string' ? { retiredByCommandHash: body.retiredByCommandHash } : {}),
    });
  }

  /**
   * A cross-domain coordination, checked here: the plan must hash to the requested plan hash, and
   * the phase, next actions, and violations are replayed locally from the served evidence at
   * `nowValue` (default: this machine's clock in the plan's unit, or the latest evidence time for
   * slot-timed plans). The server's own replay is never trusted.
   */
  async getCoordination(planHash: string, nowValue?: bigint): Promise<{ readonly plan: CrossDomainPlanInput; readonly events: readonly CrossDomainEvent[]; readonly state: CrossDomainCoordination }> {
    if (!/^[0-9a-f]{64}$/.test(planHash)) throw new TypeError('the plan hash is 64 lowercase hex characters');
    const body = record(await this.#request('GET', `/v1/coordinations/${planHash}`), 'coordination');
    const plan = body.plan as CrossDomainPlanInput;
    const events = list(body.events, 'events') as CrossDomainEvent[];
    let state: CrossDomainCoordination;
    try {
      if (toHex(crossDomainPlanHash(plan)) !== planHash) throw new Error('the plan does not match its hash');
      const latest = events.reduce((max, event) => (event.atValue > max ? event.atValue : max), 0n);
      const clock = plan.timeUnit === 'EVM_UNIX_SECONDS' ? BigInt(Math.floor(Date.now() / 1_000)) : plan.timeUnit === 'HYPERLIQUID_UNIX_MILLISECONDS' ? BigInt(Date.now()) : latest;
      state = replayCrossDomainCoordination(plan, events, nowValue ?? clock);
    } catch (error) {
      throw new NaryxEvidenceError(`the coordination does not verify: ${(error as Error).message}`);
    }
    return Object.freeze({ plan, events: Object.freeze(events), state });
  }

  /**
   * A manual recovery incident, checked here: the incident must hash to the served hash, every
   * approval must carry its named approver's Ed25519 signature over the approval hash, and the
   * phase is replayed locally from the served events.
   */
  async getRecoveryIncident(incidentId: string): Promise<{ readonly incident: ManualRecoveryIncidentInput; readonly incidentHash: string; readonly events: readonly ManualRecoveryEvent[]; readonly state: ManualRecoveryState }> {
    const id = checkId(incidentId, 'incident id');
    const body = record(await this.#request('GET', `/v1/recovery/incidents/${id}`), 'recovery incident');
    const incident = body.incident as ManualRecoveryIncidentInput;
    let incidentHash: string;
    try {
      incidentHash = toHex(manualRecoveryIncidentHash(incident));
    } catch (error) {
      throw new NaryxEvidenceError(`the incident is malformed: ${(error as Error).message}`);
    }
    if (incident.incidentId !== id || body.incidentHash !== incidentHash) throw new NaryxEvidenceError('the incident is another incident or does not match its hash');
    const events: ManualRecoveryEvent[] = [];
    for (const [index, entry] of list(body.events, 'events').entries()) {
      const served = record(entry, `events[${index}]`);
      const event = served.event as ManualRecoveryEvent;
      if (event?.kind === 'ACTION_APPROVED') {
        const key = base58Decode(event.approverId);
        const signature = served.signature;
        if (key === undefined || key.length !== 32 || !(signature instanceof Uint8Array)) throw new NaryxEvidenceError(`events[${index}] is an approval without a usable key or signature`);
        const digest = manualRecoveryApprovalHash({ incidentHash, actionHash: event.actionHash, approverId: event.approverId, atValue: event.atValue });
        // Quorum rests on these signatures, so an approval that cannot be checked is never counted.
        const verdict = await webCryptoEd25519(key, digest, signature);
        if (verdict === undefined) throw new NaryxEvidenceError('Ed25519 verification is unavailable here, so recovery approvals cannot be checked');
        if (!verdict) throw new NaryxEvidenceError(`events[${index}] is not signed by its approver`);
      }
      events.push(event);
    }
    let state: ManualRecoveryState;
    try {
      state = replayManualRecovery(incident, events);
    } catch (error) {
      throw new NaryxEvidenceError(`the incident does not replay: ${(error as Error).message}`);
    }
    return Object.freeze({ incident, incidentHash, events: Object.freeze(events), state });
  }

  /** Signs one approval hash with the approver's own key; the server counts it only for a named approver. */
  async submitRecoveryApproval(incidentId: string, approval: ManualRecoveryApprovalInput, sign: StrategyCommandSigner): Promise<{ readonly sequence: number }> {
    const id = checkId(incidentId, 'incident id');
    if (typeof sign !== 'function') throw new TypeError('an approval signer is required');
    const signature = await sign(manualRecoveryApprovalHash(approval));
    if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new TypeError('the signer must return a 64-byte signature');
    const body = record(await this.#request('POST', '/v1/recovery/approvals', {
      incidentId: id,
      approval: { actionHash: approval.actionHash, approverId: approval.approverId, atValue: approval.atValue },
      authorization: { scheme: 'ED25519', signature: base58Encode(signature) },
    }), 'recovery approval');
    return Object.freeze({ sequence: Number(body.sequence) });
  }

  /**
   * Every signed command that touched a strategy. Each is re-hashed, its signature is checked
   * against the key its actor id names, its receipt must start from the state it bound, and after
   * the first, every command must bind a state an earlier command in the history produced.
   */
  async getStrategyHistory(strategyId: string): Promise<readonly VerifiedStrategyCommand[]> {
    const id = checkId(strategyId, 'strategy id');
    const body = record(await this.#request('GET', `/v1/strategies/${id}/history`), 'strategy history');
    if (body.strategyId !== id) throw new NaryxEvidenceError('the history is for another strategy');
    const produced = new Set<string>();
    const verified: VerifiedStrategyCommand[] = [];
    for (const [index, entry] of list(body.commands, 'commands').entries()) {
      const served = record(entry, `commands[${index}]`);
      const command = served.command as StrategyCommandInput;
      let commandHash: Uint8Array;
      try {
        commandHash = strategyCommandHash(command);
      } catch (error) {
        throw new NaryxEvidenceError(`commands[${index}] is malformed: ${(error as Error).message}`);
      }
      if (served.commandHash !== toHex(commandHash)) throw new NaryxEvidenceError(`commands[${index}] does not match its hash`);
      const authorization = record(served.authorization, `commands[${index}].authorization`);
      let signatureVerified = false;
      if (authorization.scheme === 'ED25519') {
        const signature = base58Decode(String(authorization.signature));
        const key = base58Decode(command.actorId);
        if (signature === undefined || key === undefined || key.length !== 32) throw new NaryxEvidenceError(`commands[${index}] has no usable actor key or signature`);
        const verdict = await webCryptoEd25519(key, commandHash, signature);
        if (verdict === false) throw new NaryxEvidenceError(`commands[${index}] is not signed by its actor`);
        signatureVerified = verdict === true;
      } else if (authorization.scheme === 'EIP712_SECP256K1' && isEvmStrategyActor(command.actorId)) {
        const signature = typeof authorization.signature === 'string' ? authorization.signature.toLowerCase() : '';
        if (!/^0x[0-9a-f]{130}$/.test(signature)) throw new NaryxEvidenceError(`commands[${index}] has no usable EVM signature`);
        try {
          const typedData = strategyCommandAuthorizationTypedData(command, command.actorId);
          signatureVerified = await verifyTypedData({
            address: command.actorId as Hex,
            domain: typedData.domain,
            types: { StrategyCommandAuthorization: [...typedData.types.StrategyCommandAuthorization] },
            primaryType: typedData.primaryType,
            message: {
              ...typedData.message,
              commandHash: typedData.message.commandHash as Hex,
              signer: command.actorId as Hex,
            },
            signature: signature as Hex,
          });
        } catch {
          signatureVerified = false;
        }
        if (!signatureVerified) throw new NaryxEvidenceError(`commands[${index}] is not signed by its actor`);
      } else {
        throw new NaryxEvidenceError(`commands[${index}] has an unsupported actor authorization`);
      }
      const receipt = served.receipt as StrategyTransitionReceipt | undefined;
      const bound: string[] = [];
      if (command.parameters.kind === 'OPEN') {
        produced.add(toHex(strategyStateHash(command.parameters.state)));
      } else {
        bound.push(typeof command.expectedStateHash === 'string' ? command.expectedStateHash.toLowerCase() : toHex(command.expectedStateHash));
        if (command.parameters.kind === 'MERGE') {
          const other = command.parameters.otherExpectedStateHash;
          bound.push(typeof other === 'string' ? other.toLowerCase() : toHex(other));
        }
        const prior = new Set((receipt?.priorStateHashes ?? []).map((hash) => (typeof hash === 'string' ? String(hash).toLowerCase() : toHex(hash))));
        if (receipt === undefined || bound.some((hash) => !prior.has(hash))) throw new NaryxEvidenceError(`commands[${index}] has no receipt from the state it bound`);
        if (index > 0 && !bound.some((hash) => produced.has(hash))) throw new NaryxEvidenceError(`commands[${index}] binds a state no earlier command produced`);
        for (const hash of receipt.nextStateHashes) produced.add(typeof hash === 'string' ? String(hash).toLowerCase() : toHex(hash));
      }
      verified.push(Object.freeze({
        commandHash: toHex(commandHash),
        command,
        signatureVerified,
        ...(receipt === undefined ? {} : { receipt }),
        recordedAtMs: typeof served.recordedAtMs === 'number' ? served.recordedAtMs : 0,
      }));
    }
    return Object.freeze(verified);
  }

  /**
   * The whole signed market catalogue, the same for every reader, so searching it locally never
   * reveals what the caller looks for. It is re-validated and re-hashed here. A catalogue signed by
   * an authority in `trustedAuthorities` must verify; a catalogue from `environment`, when given,
   * is required; and a catalogue older than one this client already accepted from the same
   * authority is refused as a replay.
   */
  async getCatalogue(options: { readonly trustedAuthorities?: ReadonlyMap<string, Uint8Array>; readonly environment?: string; readonly nowMs?: bigint } = {}): Promise<VerifiedMarketCatalogue> {
    const body = record(await this.#request('GET', '/v1/catalogue'), 'catalogue');
    let catalogue: MarketCatalogue;
    let hash: string;
    try {
      catalogue = marketCatalogue(body.catalogue as MarketCatalogueInput);
      hash = toHex(marketCatalogueHash(body.catalogue as MarketCatalogueInput));
    } catch (error) {
      throw new NaryxEvidenceError(`catalogue is malformed: ${(error as Error).message}`);
    }
    if (body.catalogueHash !== hash) throw new NaryxEvidenceError('the served catalogue hash does not match the catalogue');
    if (options.environment !== undefined && catalogue.environment !== options.environment) throw new NaryxEvidenceError('the catalogue is for another environment');
    let signatureVerified = false;
    const trusted = options.trustedAuthorities?.get(catalogue.authority);
    if (trusted !== undefined) {
      const verdict = await webCryptoEd25519(trusted, fromHex(hash), catalogue.signature);
      if (verdict === false) throw new NaryxEvidenceError('the catalogue signature does not verify under the trusted authority');
      signatureVerified = verdict === true;
    }
    const key = `${catalogue.environment}/${catalogue.authority}`;
    const seen = this.#catalogueSequences.get(key);
    if (seen !== undefined && catalogue.sequence < seen) throw new NaryxEvidenceError('the catalogue is older than one already accepted');
    // Only a verified catalogue may raise the replay floor, so an unsigned one cannot lock out a real one.
    if (signatureVerified) this.#catalogueSequences.set(key, catalogue.sequence);
    const current = marketCatalogueCurrent(catalogue, options.nowMs ?? BigInt(Date.now()));
    return Object.freeze({ catalogue, catalogueHash: hash, signatureVerified, current, search: (query: MarketCatalogueQuery) => searchMarketCatalogue(catalogue, query) });
  }

  /**
   * The latest signed position snapshot of each source for a strategy account. Every record is
   * re-validated and re-hashed, must belong to the account, and must carry exactly the positions
   * served. A record signed by an authority in `trustedAuthorities` must verify, and only then is
   * it marked verified; the server's own configuration is never taken as trust.
   */
  async getPositions(strategyAccount: string, options: { readonly trustedAuthorities?: ReadonlyMap<string, Uint8Array> } = {}): Promise<VerifiedPositions> {
    const account = checkId(strategyAccount, 'strategy account');
    const body = record(await this.#request('GET', `/v1/positions/${account}`), 'positions');
    if (body.strategyAccount !== account || body.label !== 'OBSERVED') throw new NaryxEvidenceError('positions are for another account or not labeled OBSERVED');
    const servedSources = list(body.sources, 'sources');
    const records = list(body.records, 'records');
    if (servedSources.length !== records.length) throw new NaryxEvidenceError('every source must carry its record');
    const sources: VerifiedPositionSource[] = [];
    for (const [index, entry] of records.entries()) {
      let snapshot: PositionSnapshotRecord;
      let hash: string;
      try {
        snapshot = positionSnapshotRecord(entry as PositionSnapshotRecordInput);
        hash = toHex(positionSnapshotRecordHash(entry as PositionSnapshotRecordInput));
      } catch (error) {
        throw new NaryxEvidenceError(`records[${index}] is malformed: ${(error as Error).message}`);
      }
      const served = record(servedSources[index], `sources[${index}]`);
      if (served.recordHash !== hash || served.sourceId !== snapshot.sourceId || served.observedAtMs !== snapshot.observedAtMs) {
        throw new NaryxEvidenceError(`sources[${index}] does not describe its record`);
      }
      if (snapshot.strategyAccount !== account) throw new NaryxEvidenceError(`records[${index}] belongs to another account`);
      let signatureVerified = false;
      const trusted = options.trustedAuthorities?.get(snapshot.authority);
      if (trusted !== undefined) {
        const verdict = await webCryptoEd25519(trusted, fromHex(hash), snapshot.signature);
        if (verdict === false) throw new NaryxEvidenceError(`records[${index}] signature does not verify under the trusted authority`);
        signatureVerified = verdict === true;
      }
      sources.push(Object.freeze({
        sourceId: snapshot.sourceId,
        recordHash: hash,
        observedAtMs: snapshot.observedAtMs,
        ageMs: big(served.ageMs, 'ageMs'),
        unmappedInstruments: snapshot.unmappedInstruments,
        record: snapshot,
        signatureVerified,
      }));
    }
    const positions = sources.flatMap((source) => source.record.positions);
    const servedPositions = list(body.positions, 'positions');
    if (servedPositions.length !== positions.length) throw new NaryxEvidenceError('served positions differ from their records');
    return Object.freeze({ strategyAccount: account, label: 'OBSERVED' as const, sources: Object.freeze(sources), positions: Object.freeze(positions) });
  }

  /**
   * Risk for a strategy account. Positions come from `getPositions` and are verified the same way;
   * exposure and close cost are recomputed here from those positions and must equal the served
   * figures exactly. The stress rows are a server model labeled MODELED and are passed through.
   */
  async getRisk(
    strategyAccount: string,
    options: { readonly trustedAuthorities?: ReadonlyMap<string, Uint8Array> } = {},
  ): Promise<VerifiedRisk> {
    const positions = await this.getPositions(strategyAccount, options);
    const body = record(await this.#request('GET', `/v1/risk/${positions.strategyAccount}`), 'risk');
    if (body.strategyAccount !== positions.strategyAccount || typeof body.methodology !== 'string') throw new NaryxEvidenceError('risk is for another account or has no methodology');
    const seenAssets = new Set<string>();
    const groups = list(body.byAccountingAsset, 'byAccountingAsset').map((entry, index) => {
      const served = record(entry, `byAccountingAsset[${index}]`);
      const asset = served.accountingAsset as NormalizedPosition['markPrice']['quoteAsset'];
      // Each accounting asset appears once, so a repeated group can never stand in for a missing one.
      const assetKey = `${String(asset?.assetId)}/${asset?.assetManifestHash instanceof Uint8Array ? toHex(asset.assetManifestHash) : String(asset?.assetManifestHash)}`;
      if (seenAssets.has(assetKey)) throw new NaryxEvidenceError(`byAccountingAsset[${index}] repeats an accounting asset`);
      seenAssets.add(assetKey);
      const grouped = positions.positions.filter((position) => bytesEqual(position.markPrice.quoteAsset.assetManifestHash, asset.assetManifestHash) && position.markPrice.quoteAsset.assetId === asset.assetId);
      const same = (left: unknown, right: unknown) => JSON.stringify(toProtocolJson(left)) === JSON.stringify(toProtocolJson(right));
      const exposure = served.exposure as ExposureGraph;
      const closeCost = served.closeCost as PackageCloseCostIndex;
      if (!same(buildExposureGraph(grouped, asset), exposure) || !same(packageCloseCostIndex(grouped), closeCost)) {
        throw new NaryxEvidenceError(`byAccountingAsset[${index}] exposure or close cost differs from the local computation`);
      }
      const stress = record(served.stress, `byAccountingAsset[${index}].stress`);
      if (stress.label !== 'MODELED') throw new NaryxEvidenceError('stress rows must be labeled MODELED');
      const stressResults = list(stress.results, `byAccountingAsset[${index}].stress.results`) as unknown as readonly StressResult[];
      const underlyings = [...new Set(grouped.map((position) => position.underlyingId))].sort();
      const scenario = (scenarioId: string, shockBps: bigint) => ({
        scenarioId,
        priceShocksBps: underlyings.map((underlyingId) => ({ underlyingId, shockBps })),
        closeCostMultiplierBps: 15_000n,
        failedDependencyIds: [],
      });
      const expectedStress = [
        stressPortfolio(grouped, scenario('uniform-down-10pct', -1_000n), asset),
        stressPortfolio(grouped, scenario('uniform-up-10pct', 1_000n), asset),
      ];
      if (!same(expectedStress, stressResults)) {
        throw new NaryxEvidenceError(`byAccountingAsset[${index}] stress differs from the local computation`);
      }
      return Object.freeze({
        accountingAsset: asset,
        exposure,
        closeCost,
        stress: Object.freeze({ label: 'MODELED' as const, results: stressResults }),
      });
    });
    const covered = groups.reduce((sum, group) => sum + positions.positions.filter((position) => position.markPrice.quoteAsset.assetId === group.accountingAsset.assetId && bytesEqual(position.markPrice.quoteAsset.assetManifestHash, group.accountingAsset.assetManifestHash)).length, 0);
    if (covered !== positions.positions.length) throw new NaryxEvidenceError('risk leaves out positions it was built from');
    return Object.freeze({ positions, methodology: body.methodology, byAccountingAsset: Object.freeze(groups) });
  }

  /**
   * Every solver route decision recorded for a public order. Each decision is replayed here from
   * its bounded evidence, and the server's hash and replay must agree with the local one. A valid
   * replay proves the declared selection under the declared objective, never global optimality.
   */
  async getRouteDecisions(orderHash: string): Promise<readonly VerifiedRouteDecision[]> {
    const requested = hashHex(orderHash, 'order hash');
    const body = record(await this.#request('GET', `/v1/orders/${requested}/route-decisions`), 'route decisions');
    if (body.orderHash !== requested) throw new NaryxEvidenceError('route decisions are for another order');
    return Object.freeze(
      list(body.decisions, 'decisions').map((entry, index) => {
        const served = record(entry, `decisions[${index}]`);
        let replay: RouteDecisionReplay;
        try {
          replay = replayRouteDecision(served.decision as RouteDecisionInput);
        } catch (error) {
          throw new NaryxEvidenceError(`decisions[${index}] is malformed: ${(error as Error).message}`);
        }
        const decision = served.decision as RouteDecisionInput;
        if (toHex(commitmentHash(decision.orderHash, 'decision.orderHash')) !== requested) throw new NaryxEvidenceError(`decisions[${index}] is for another order`);
        if (served.decisionHash !== toHex(replay.decisionHash) || served.solverId !== decision.solverId) throw new NaryxEvidenceError(`decisions[${index}] does not hash to its served hash`);
        const servedReplay = record(served.replay, `decisions[${index}].replay`);
        const discrepancies = list(servedReplay.discrepancies, `decisions[${index}].replay.discrepancies`);
        if (servedReplay.valid !== replay.valid || discrepancies.join(',') !== replay.discrepancies.join(',')) {
          throw new NaryxEvidenceError(`decisions[${index}] replay differs from the local replay`);
        }
        return Object.freeze({ decisionHash: toHex(replay.decisionHash), solverId: decision.solverId, decision, replay, receivedAtMs: count(served.receivedAtMs, 'receivedAtMs') });
      }),
    );
  }

  async getOrderQuotes(orderHash: string): Promise<readonly VerifiedOrderQuote[]> {
    const requested = hashHex(orderHash, 'order hash');
    const body = record(await this.#request('GET', `/v1/orders/${requested}/quotes`), 'order quotes');
    if (body.orderHash !== requested) throw new NaryxEvidenceError('quotes are for another order');
    const manifests = new Map<string, VerifiedSolverManifest | undefined>();
    const manifestFor = async (quote: SolverQuote): Promise<VerifiedSolverManifest | undefined> => {
      const key = `${quote.solverId}/${toHex(quote.solverCapabilityManifestHash)}`;
      if (!manifests.has(key)) {
        try {
          manifests.set(key, await this.getSolverManifest(quote.solverId, toHex(quote.solverCapabilityManifestHash)));
        } catch (error) {
          // Without a registry on this server the binding cannot be checked; anything else is evidence.
          if (!(error instanceof NaryxApiError) || error.status !== 503) throw error;
          manifests.set(key, undefined);
        }
      }
      return manifests.get(key);
    };
    const quotes: VerifiedOrderQuote[] = [];
    for (const [index, entry] of list(body.quotes, 'quotes').entries()) {
      const served = record(entry, `quotes[${index}]`);
      let quote: SolverQuote;
      let route: RoutePayload;
      let computedQuoteHash: string;
      let computedRouteHash: string;
      try {
        quote = solverQuote(served.quote as SolverQuoteInput);
        route = routePayload(served.route as RoutePayloadInput);
        computedQuoteHash = toHex(solverQuoteHash(served.quote as SolverQuoteInput));
        computedRouteHash = toHex(routeHash(served.route as RoutePayloadInput));
      } catch (error) {
        throw new NaryxEvidenceError(`quotes[${index}] is malformed: ${(error as Error).message}`);
      }
      if (served.quoteHash !== computedQuoteHash || served.routeHash !== computedRouteHash) throw new NaryxEvidenceError(`quotes[${index}] does not hash to its served hashes`);
      if (toHex(quote.routeHash) !== computedRouteHash) throw new NaryxEvidenceError(`quotes[${index}] does not bind its served route`);
      if (toHex(quote.orderHash) !== requested || toHex(route.orderHash) !== requested) throw new NaryxEvidenceError(`quotes[${index}] is for another order`);
      if (served.quoteMode !== quote.quoteMode || served.solverId !== quote.solverId) throw new NaryxEvidenceError(`quotes[${index}] labels differ from the signed quote`);
      let signatureVerified = false;
      if (quote.solverSignatureScheme === 'ED25519') {
        const verdict = await webCryptoEd25519(quote.solverVerificationKey, solverSignatureDigest(served.quote as SolverQuoteInput), quote.signature);
        if (verdict === false) throw new NaryxEvidenceError(`quotes[${index}] signature does not verify`);
        const registered = await manifestFor(quote);
        if (registered !== undefined) {
          const listed = registered.manifest.quoteVerificationKeys.some(
            (key) => key.scheme === quote.solverSignatureScheme && bytesEqual(key.verificationKey, quote.solverVerificationKey),
          );
          if (!listed) throw new NaryxEvidenceError(`quotes[${index}] key is not registered in the solver's manifest`);
          if (registered.manifest.environment !== quote.environment) throw new NaryxEvidenceError(`quotes[${index}] binds a manifest for another environment`);
        }
        signatureVerified = verdict === true && registered !== undefined && registered.operatorSignatureVerified;
      }
      quotes.push(Object.freeze({ quoteHash: computedQuoteHash, routeHash: computedRouteHash, quote, route, receivedAtMs: count(served.receivedAtMs, 'receivedAtMs'), signatureVerified }));
    }
    return Object.freeze(quotes);
  }

  /** Measured execution quality; every figure comes from stored outcomes and receipts. */
  /**
   * One solver's raw performance dimensions. Every basis-point figure is recomputed here from the
   * served counts and must match exactly; percentiles must be ordered; there is no composite score.
   */
  async getSolverPerformance(solverId: string): Promise<SolverPerformanceView> {
    const id = checkId(solverId, 'solver id');
    const body = record(await this.#request('GET', `/v1/solvers/${id}/performance`), 'solver performance');
    if (body.label !== 'OBSERVED' || typeof body.methodology !== 'string') throw new NaryxEvidenceError('solver performance must be labeled OBSERVED with its methodology');
    if (body.solverId !== id) throw new NaryxEvidenceError('solver performance is for another solver');
    const eligibleDomainIds = list(body.eligibleDomainIds, 'eligibleDomainIds').map((domain, index) => checkId(String(domain), `eligibleDomainIds[${index}]`));
    const ratio = (part: number, whole: number) => (whole === 0 ? 0 : Math.floor((part * 10_000) / whole));
    const exact = (served: unknown, part: number, whole: number, name: string) => {
      if (count(served, name) !== ratio(part, whole)) throw new NaryxEvidenceError(`${name} does not match its counts`);
      return ratio(part, whole);
    };
    const coverageBody = record(body.coverage, 'coverage');
    const eligibleOrders = count(coverageBody.eligibleOrders, 'coverage.eligibleOrders');
    const quotedOrders = count(coverageBody.quotedOrders, 'coverage.quotedOrders');
    if (quotedOrders > eligibleOrders) throw new NaryxEvidenceError('a solver cannot quote more orders than were eligible');
    const coverage = Object.freeze({ eligibleOrders, quotedOrders, coverageBps: exact(coverageBody.coverageBps, quotedOrders, eligibleOrders, 'coverage.coverageBps') });
    let firstQuoteLatencyMs: SolverPerformanceView['firstQuoteLatencyMs'];
    if (body.firstQuoteLatencyMs !== undefined) {
      const served = record(body.firstQuoteLatencyMs, 'firstQuoteLatencyMs');
      const median = count(served.median, 'firstQuoteLatencyMs.median');
      const p95 = count(served.p95, 'firstQuoteLatencyMs.p95');
      const max = count(served.max, 'firstQuoteLatencyMs.max');
      if (quotedOrders === 0 || median > p95 || p95 > max) throw new NaryxEvidenceError('latency percentiles are not ordered or have no quotes behind them');
      firstQuoteLatencyMs = Object.freeze({ median, p95, max });
    } else if (quotedOrders > 0) throw new NaryxEvidenceError('quoted orders were served without their latency');
    const outcomesBody = record(body.outcomes, 'outcomes');
    const total = count(outcomesBody.total, 'outcomes.total');
    const servedStates = record(outcomesBody.byTerminalState, 'outcomes.byTerminalState');
    const byTerminalState = {} as Record<TerminalState, number>;
    let sum = 0;
    for (const state of Object.keys(TERMINAL_STATE) as TerminalState[]) {
      byTerminalState[state] = count(servedStates[state], `outcomes.byTerminalState.${state}`);
      sum += byTerminalState[state];
    }
    if (sum !== total) throw new NaryxEvidenceError('terminal state counts do not sum to the outcome count');
    const settled = byTerminalState.FINALIZED_COMPLETE + byTerminalState.FINALIZED_BOUNDED + byTerminalState.RECOVERED_COMPLETE + byTerminalState.RECOVERED_BOUNDED;
    const recovered = byTerminalState.RECOVERED_COMPLETE + byTerminalState.RECOVERED_BOUNDED + byTerminalState.RECOVERED_FLAT;
    const outcomes = Object.freeze({
      total,
      byTerminalState: Object.freeze(byTerminalState),
      settledBps: exact(outcomesBody.settledBps, settled, total, 'outcomes.settledBps'),
      fadeBps: exact(outcomesBody.fadeBps, byTerminalState.NO_EFFECT, total, 'outcomes.fadeBps'),
      recoveredBps: exact(outcomesBody.recoveredBps, recovered, total, 'outcomes.recoveredBps'),
      boundedResidualBps: exact(outcomesBody.boundedResidualBps, byTerminalState.FINALIZED_BOUNDED + byTerminalState.RECOVERED_BOUNDED, total, 'outcomes.boundedResidualBps'),
      manualInterventionBps: exact(outcomesBody.manualInterventionBps, byTerminalState.MANUAL_INTERVENTION, total, 'outcomes.manualInterventionBps'),
    });
    let priceImprovementBps: SolverPerformanceView['priceImprovementBps'];
    if (body.priceImprovementBps !== undefined) {
      const served = record(body.priceImprovementBps, 'priceImprovementBps');
      const measured = count(served.measured, 'priceImprovementBps.measured');
      const signedInteger = (value: unknown, name: string) => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new NaryxEvidenceError(`${name} must be an integer`);
        return value;
      };
      const median = signedInteger(served.median, 'priceImprovementBps.median');
      const min = signedInteger(served.min, 'priceImprovementBps.min');
      const max = signedInteger(served.max, 'priceImprovementBps.max');
      if (measured === 0 || measured > settled || min > median || median > max) throw new NaryxEvidenceError('price improvement is unordered or measured beyond the settled outcomes');
      priceImprovementBps = Object.freeze({ measured, median, min, max });
    }
    return Object.freeze({
      label: 'OBSERVED' as const,
      methodology: body.methodology,
      solverId: id,
      eligibleDomainIds: Object.freeze(eligibleDomainIds),
      coverage,
      ...(firstQuoteLatencyMs === undefined ? {} : { firstQuoteLatencyMs }),
      outcomes,
      ...(priceImprovementBps === undefined ? {} : { priceImprovementBps }),
    });
  }

  async getExecutionQuality(filter: { readonly solverId?: string } = {}): Promise<ExecutionQualityView> {
    const query = filter.solverId === undefined ? '' : `?solverId=${checkId(filter.solverId, 'solver id')}`;
    const body = record(await this.#request('GET', `/v1/analytics/execution-quality${query}`), 'execution quality');
    if (body.label !== 'OBSERVED' || typeof body.methodology !== 'string') throw new NaryxEvidenceError('execution quality must be labeled OBSERVED with its methodology');
    if (filter.solverId !== undefined && body.solverId !== filter.solverId) throw new NaryxEvidenceError('execution quality is for another solver');
    const terminalOutcomes = count(body.terminalOutcomes, 'terminalOutcomes');
    const served = record(body.byTerminalState, 'byTerminalState');
    const byTerminalState = {} as Record<TerminalState, number>;
    let total = 0;
    for (const state of Object.keys(TERMINAL_STATE) as TerminalState[]) {
      byTerminalState[state] = count(served[state], `byTerminalState.${state}`);
      total += byTerminalState[state];
    }
    if (total !== terminalOutcomes) throw new NaryxEvidenceError('terminal state counts do not sum to the outcome count');
    const bps = (value: unknown, name: string) => {
      const parsed = count(value, name);
      if (parsed > 10_000) throw new NaryxEvidenceError(`${name} exceeds 10000 basis points`);
      return parsed;
    };
    let timeUnhedgedMs: ExecutionQualityView['timeUnhedgedMs'];
    if (body.timeUnhedgedMs !== undefined) {
      const served = record(body.timeUnhedgedMs, 'timeUnhedgedMs');
      const median = big(served.median, 'timeUnhedgedMs.median');
      const p95 = big(served.p95, 'timeUnhedgedMs.p95');
      const max = big(served.max, 'timeUnhedgedMs.max');
      if (median < 0n || median > p95 || p95 > max) throw new NaryxEvidenceError('time unhedged percentiles are not ordered');
      timeUnhedgedMs = Object.freeze({ median, p95, max });
    }
    const grades = record(body.receiptFieldEvidence, 'receiptFieldEvidence');
    const receiptFieldEvidence: Record<string, number> = {};
    for (const [grade, value] of Object.entries(grades)) receiptFieldEvidence[grade] = count(value, `receiptFieldEvidence.${grade}`);
    return Object.freeze({
      label: 'OBSERVED' as const,
      methodology: body.methodology,
      ...(filter.solverId === undefined ? {} : { solverId: filter.solverId }),
      terminalOutcomes,
      byTerminalState: Object.freeze(byTerminalState),
      successfulBps: bps(body.successfulBps, 'successfulBps'),
      recoveredBps: bps(body.recoveredBps, 'recoveredBps'),
      ...(timeUnhedgedMs === undefined ? {} : { timeUnhedgedMs }),
      receiptFieldEvidence: Object.freeze(receiptFieldEvidence),
    });
  }

  // ---------------------------------------------------------------- private delivery

  /**
   * Submits envelopes the caller encrypted with the pinned suite. Each envelope's `senderKeyId` is
   * the sender's base58 Ed25519 public key, and `signSender` signs each locally computed envelope
   * hash with it, so no other party can spend the sender's nonces. The relay stores ciphertext and
   * canonical metadata only; being stored is not being delivered.
   */
  async submitPrivateRfq(
    envelopes: readonly { readonly envelope: PrivateRfqEnvelopeInput; readonly ciphertext: Uint8Array }[],
    signSender: (envelopeHash: Uint8Array) => Promise<Uint8Array>,
  ): Promise<readonly Record<string, unknown>[]> {
    if (envelopes.length === 0 || envelopes.length > 16) throw new TypeError('submit 1 to 16 envelopes');
    if (typeof signSender !== 'function') throw new TypeError('a sender signer is required');
    const signed: { envelope: PrivateRfqEnvelopeInput; ciphertext: Uint8Array; senderSignature: Uint8Array }[] = [];
    for (const entry of envelopes) {
      const senderSignature = await signSender(privateRfqEnvelopeHash(entry.envelope));
      if (!(senderSignature instanceof Uint8Array) || senderSignature.length !== 64) throw new TypeError('the signer must return a 64-byte signature');
      signed.push({ envelope: entry.envelope, ciphertext: entry.ciphertext, senderSignature });
    }
    const results = list(record(await this.#request('POST', '/v1/rfqs/private', { envelopes: signed }), 'rfq').results, 'results');
    if (results.length !== signed.length) throw new NaryxEvidenceError('the relay answered a different number of envelopes');
    return results.map((entry, index) => {
      const result = record(entry, `results[${index}]`);
      if (result.admitted === true && result.envelopeHashHex !== toHex(privateRfqEnvelopeHash((signed[index] as (typeof signed)[number]).envelope))) {
        throw new NaryxEvidenceError(`results[${index}] names another envelope`);
      }
      return result;
    });
  }

  /** Delivery counts only once the recipient acknowledged; the response is ciphertext for the taker. */
  async getPrivateRfqStatus(envelopeHash: string): Promise<{ readonly acknowledged: boolean; readonly response?: unknown }> {
    const body = record(await this.#request('GET', `/v1/rfqs/private/${hashHex(envelopeHash, 'envelope hash')}`), 'rfq status');
    if (body.envelopeHash !== envelopeHash || typeof body.acknowledged !== 'boolean') throw new NaryxEvidenceError('rfq status is malformed');
    return Object.freeze({ acknowledged: body.acknowledged, ...(body.response === undefined ? {} : { response: body.response }) });
  }

  async createSealedAuction(definition: SealedAuctionDefinitionInput): Promise<string> {
    return hashHex(record(await this.#request('POST', '/v1/auctions/sealed', { definition }), 'auction').auctionHashHex, 'auctionHashHex');
  }

  /**
   * Reads an auction. Before close only the phase and commitment count are public. After close
   * the result is recomputed locally from the published event log and must match exactly.
   */
  async getSealedAuction(auctionHash: string): Promise<Record<string, unknown>> {
    const requested = hashHex(auctionHash, 'auction hash');
    const body = record(await this.#request('GET', `/v1/auctions/sealed/${requested}`), 'auction');
    // Whatever the phase, a served definition must be the auction that was asked for.
    const definitionMatches = (definition: SealedAuctionDefinitionInput) => {
      try {
        return toHex(sealedAuctionHash(definition)) === requested;
      } catch {
        return false;
      }
    };
    if (body.definition !== undefined && !definitionMatches(body.definition as SealedAuctionDefinitionInput)) {
      throw new NaryxEvidenceError('the served auction definition does not hash to the requested auction');
    }
    if (body.phase !== 'CLOSED') return body;
    if (body.definition === undefined) throw new NaryxEvidenceError('a closed auction must publish its definition');
    const definition = body.definition as SealedAuctionDefinitionInput;
    const served = record(body.result, 'auction.result');
    const events = list(body.events, 'auction.events') as readonly SealedAuctionEvent[];
    let replayed: ReturnType<typeof replaySealedAuction>['result'];
    try {
      replayed = replaySealedAuction(definition, events, definition.revealDeadlineValue).result;
    } catch {
      throw new NaryxEvidenceError('the published auction event log does not replay');
    }
    let matches = false;
    try {
      matches = bytesEqual(replayed.resultHash, commitmentHash(served.resultHash as Uint8Array | string, 'auction.result.resultHash'));
    } catch {
      matches = false;
    }
    if (!matches) throw new NaryxEvidenceError('the published auction result does not replay from its event log');
    // Return the locally replayed result, never the server's copy of the other fields.
    return Object.freeze({ ...body, result: replayed });
  }

  // ---------------------------------------------------------------- computation

  /** Validates an order on the server and locally; the two verdicts and hashes must agree. */
  async validateOrder(order: PackageOrderInput): Promise<{ readonly valid: true; readonly orderHash: string } | { readonly valid: false; readonly code: string; readonly detail: string }> {
    let local: { valid: true; orderHash: string } | { valid: false; code: string; detail: string };
    try {
      local = { valid: true, orderHash: toHex(packageOrderHash(validatePackageOrderProfile(order))) };
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      local = { valid: false, code: error.code, detail: error.detail };
    }
    const remote = record(await this.#request('POST', '/v1/orders/validate', { order }), 'validation');
    if (remote.valid !== local.valid || (local.valid && remote.orderHash !== local.orderHash)) {
      throw new NaryxEvidenceError('server order validation disagrees with local validation');
    }
    return Object.freeze(local);
  }

  /** Replays a route decision on the server and locally; the verdicts and hashes must agree. */
  async replayRouteDecision(decision: RouteDecisionInput): Promise<RouteDecisionReplay> {
    const local = replayRouteDecision(decision);
    const remote = record(await this.#request('POST', '/v1/routes/replay-decision', { decision }), 'replay');
    const remoteHash = remote.decisionHash instanceof Uint8Array ? toHex(remote.decisionHash) : undefined;
    if (remote.valid !== local.valid || remoteHash !== toHex(local.decisionHash)) {
      throw new NaryxEvidenceError('server route replay disagrees with local replay');
    }
    return local;
  }

  async compareRoutes(request: RfqRequest, responses: readonly RfqResponse[], capacities: readonly RfqSolverCapacity[] = []): Promise<RfqDecision> {
    return (await this.#request('POST', '/v1/routes/compare', { request, responses, capacities })) as RfqDecision;
  }

  /** Simulates an order against the current book; nothing is submitted, reserved, or persisted. */
  async simulateClearing(packageMarketId: string, order: PackageTakerOrderInput): Promise<Record<string, unknown>> {
    const body = record(await this.#request('POST', '/v1/clearing/simulate', { packageMarketId: checkId(packageMarketId, 'package market id'), order }), 'simulation');
    if (body.simulated !== true) throw new NaryxEvidenceError('clearing response is not marked as a simulation');
    return body;
  }

  /** Simulates deterministic cross-user netting and rejects any server result that differs locally. */
  async simulateNetting(
    obligations: readonly NettingObligationInput[],
    policy: NettingPolicyManifestInput,
  ): Promise<NettingResult> {
    const local = netObligations(obligations, policy);
    const body = record(
      await this.#request('POST', '/v1/netting/simulate', { obligations, policy }),
      'netting simulation',
    );
    if (body.simulated !== true || typeof body.result !== 'object' || body.result === null) {
      throw new NaryxEvidenceError('netting response is not marked as a simulation');
    }
    const result = body.result as NettingResult;
    try {
      verifyNettingResultAgainstPolicy(result, policy);
    } catch (error) {
      throw new NaryxEvidenceError(`netting result failed verification: ${(error as Error).message}`);
    }
    if (!bytesEqual(result.proofHash, local.proofHash)) {
      throw new NaryxEvidenceError('server netting result disagrees with local deterministic allocation');
    }
    return result;
  }

  async validateDeRisk(input: { readonly positions: readonly unknown[]; readonly policy: unknown; readonly stateCertain: boolean; readonly openRiskIncreasingOrderIds?: readonly string[] }): Promise<readonly unknown[]> {
    return list(record(await this.#request('POST', '/v1/de-risk/validate', input), 'de-risk').actions, 'actions');
  }
}

/**
 * Verifies served allocation evidence without trusting the server: the allocation must belong to
 * the expected order, bind the served policy by hash, and satisfy every matching invariant.
 */
export function verifyAllocationEvidence(takerOrderId: string, allocationInput: unknown, policyInput: unknown): VerifiedAllocation {
  let allocation: PackageAllocation;
  let policy: PackageMatchingPolicy;
  try {
    allocation = packageAllocation(allocationInput as PackageAllocation);
    policy = packageMatchingPolicy(policyInput as PackageMatchingPolicy);
  } catch (error) {
    throw new NaryxEvidenceError(`evidence is malformed: ${(error as Error).message}`);
  }
  if (!bytesEqual(allocation.takerOrderId, commitmentHash(takerOrderId))) throw new NaryxEvidenceError('allocation belongs to another order');
  if (!bytesEqual(packageMatchingPolicyHash(policy), allocation.matchingPolicyHash)) {
    throw new NaryxEvidenceError('served policy is not the policy the allocation binds');
  }
  try {
    verifyPackageAllocation(policy, allocation);
  } catch (error) {
    throw new NaryxEvidenceError(`allocation failed verification: ${(error as Error).message}`);
  }
  return Object.freeze({ allocation, matchingPolicy: policy, allocationHash: toHex(packageAllocationHash(allocation)) });
}

/** Re-hashes a served manifest and outcome and checks they name the requested order and each other. */
function verifiedOutcomeParts(orderHash: string, served: Record<string, unknown>) {
  const requested = hashHex(orderHash, 'order hash');
  let manifest: EvidenceManifest;
  let outcome: TerminalOutcomeRecord;
  let manifestHash: string;
  let outcomeHash: string;
  try {
    manifest = evidenceManifest(served.evidenceManifest as EvidenceManifestInput);
    manifestHash = toHex(evidenceManifestHash(served.evidenceManifest as EvidenceManifestInput));
    outcome = terminalOutcomeRecord(served.outcome as TerminalOutcomeInput);
    outcomeHash = toHex(terminalOutcomeHash(served.outcome as TerminalOutcomeInput));
  } catch (error) {
    throw new NaryxEvidenceError(`terminal evidence is malformed: ${(error as Error).message}`);
  }
  if (served.evidenceManifestHash !== manifestHash) throw new NaryxEvidenceError('the evidence manifest does not hash to its served hash');
  if (served.outcomeHash !== outcomeHash) throw new NaryxEvidenceError('the terminal outcome does not hash to its served hash');
  if (toHex(manifest.orderHash) !== requested || toHex(outcome.orderHash) !== requested) throw new NaryxEvidenceError('the evidence names another order');
  if (toHex(outcome.evidenceManifestHash) !== manifestHash) throw new NaryxEvidenceError('the outcome does not bind the served evidence manifest');
  if (served.terminalState !== outcome.terminalState) throw new NaryxEvidenceError('the served terminal state is not the outcome state');
  return { requested, manifest, manifestHash, outcome, outcomeHash };
}

/**
 * Verifies a served terminal outcome without its receipt: the manifest and outcome re-hash to
 * their served hashes and name the requested order, and a named receipt hash must be exactly the
 * one the outcome links, present only for successful terminal states.
 */
export function verifyOutcomeEvidence(orderHash: string, served: Record<string, unknown>): VerifiedOutcome {
  const { requested, manifest, manifestHash, outcome, outcomeHash } = verifiedOutcomeParts(orderHash, served);
  const linked = outcome.successfulReceiptHash === undefined ? undefined : toHex(outcome.successfulReceiptHash);
  if (requiresSuccessfulReceipt(outcome.terminalState) ? served.receiptHash !== linked : served.receiptHash !== undefined || linked !== undefined) {
    throw new NaryxEvidenceError('the served receipt hash is not the one the outcome links');
  }
  return Object.freeze({
    orderHash: requested,
    terminalState: outcome.terminalState,
    evidenceManifest: manifest,
    evidenceManifestHash: manifestHash,
    outcome,
    outcomeHash,
    ...(linked === undefined ? {} : { receiptHash: linked }),
    recordedAtMs: count(served.recordedAtMs, 'recordedAtMs'),
  });
}

/**
 * Verifies served terminal evidence without trusting the server: every record re-hashes to its
 * served hash, the manifest and outcome name the requested order, the outcome binds the manifest,
 * and a receipt is present exactly for successful states and links to the outcome both ways.
 */
export function verifyTerminalEvidence(
  orderHash: string,
  served: Record<string, unknown>,
  acceptedQuoteFeeTerms?: AcceptedQuoteFeeTerms,
): VerifiedTerminalEvidence {
  const { requested, manifest, manifestHash, outcome, outcomeHash } = verifiedOutcomeParts(orderHash, served);
  let receipt: PackageReceipt | undefined;
  let receiptHash: string | undefined;
  let feesVerified = false;
  if (requiresSuccessfulReceipt(outcome.terminalState)) {
    if (served.receipt === undefined) throw new NaryxEvidenceError('a successful outcome must be served with its receipt');
    try {
      receipt = packageReceipt(served.receipt as PackageReceiptInput);
      receiptHash = toHex(packageReceiptHash(served.receipt as PackageReceiptInput));
    } catch (error) {
      throw new NaryxEvidenceError(`receipt is malformed: ${(error as Error).message}`);
    }
    if (served.receiptHash !== receiptHash) throw new NaryxEvidenceError('the receipt does not hash to its served hash');
    const link = verifyOutcomeReceiptLink(served.outcome as TerminalOutcomeInput, served.receipt as PackageReceiptInput);
    if (!link.valid) throw new NaryxEvidenceError(`the outcome and receipt do not link: ${link.violations.join(', ')}`);
    if (acceptedQuoteFeeTerms !== undefined) {
      const fees = verifyReceiptFees(served.receipt as PackageReceiptInput, acceptedQuoteFeeTerms);
      if (!fees.valid) throw new NaryxEvidenceError(`the receipt charged outside the accepted quote: ${fees.violations.join(', ')}`);
      feesVerified = true;
    }
  } else if (served.receipt !== undefined || served.receiptHash !== undefined || outcome.successfulReceiptHash !== undefined) {
    throw new NaryxEvidenceError(`${outcome.terminalState} is not a successful outcome and has no receipt`);
  }
  return Object.freeze({
    orderHash: requested,
    terminalState: outcome.terminalState,
    evidenceManifest: manifest,
    evidenceManifestHash: manifestHash,
    outcome,
    outcomeHash,
    ...(receipt === undefined ? {} : { receipt, receiptHash: receiptHash as string }),
    feesVerified,
    recordedAtMs: count(served.recordedAtMs, 'recordedAtMs'),
  });
}

/** Rebuilds observed candles from tape pages, so an integrator can check a served series. */
export function candlesFromTape(trades: readonly PackageTapeTrade[], interval: CandleInterval, window?: { readonly fromMs: number; readonly toMs: number }): CandleSeries {
  return aggregateCandles(
    trades.flatMap((trade) => trade.fills.map((fill) => ({ timeMs: trade.recordedAtMs, priceTicks: fill.priceTicks, quantity: fill.quantity }))),
    interval,
    'OBSERVED',
    window,
  );
}
