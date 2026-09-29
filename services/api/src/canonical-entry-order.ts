import { createHash } from "node:crypto";
import {
  bytesEqual,
  canonicalBytes,
  hash32,
  packageOrderBytes,
  packageOrderHash,
  validatePackageOrderProfile,
} from "@naryx/protocol-types";
import type {
  AdapterRef,
  AssetRef,
  DomainRef,
  ExactPrice,
  ExactSignedRate,
  ExpiryUnit,
  FeeCap,
  Hash32,
  PackageOrder,
  PackageOrderInput,
  QuantityPolicyClass,
  RecoveryAction,
  RegistryState,
  SettlementClass,
} from "@naryx/protocol-types";

export type ActiveOrderContextProvider = (
  contextId: string,
) => ActiveOrderContext | undefined;

export interface ActiveOrderContext {
  readonly contextId: string;
  readonly state: RegistryState;
  readonly capturedAtClock: bigint;
  readonly maxStaleness: bigint;
  readonly domain: DomainRef;
  readonly environment: string;
  readonly orderVersion: number;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array | string;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly spotAdapters: readonly AdapterRef[];
  readonly perpAdapters: readonly AdapterRef[];
  readonly settlementClass: SettlementClass;
  readonly expiryUnit: ExpiryUnit;
  readonly expiryTtl: bigint;
  readonly spotReferencePrice: ExactPrice;
  readonly maxEntrySpread: ExactSignedRate;
  readonly maximumQuantityAtoms: bigint;
  readonly maxSlippageBps: number;
  readonly maxVenueFeeAtomsByAsset: readonly FeeCap[];
  readonly maxMarginAddedAtoms: bigint;
  readonly maxProtocolFeeAtoms: bigint;
  readonly maxSolverFeeAtoms: bigint;
  readonly maxPriorityFeeAtoms: bigint;
  readonly minVenueReserveReturnedAtoms: bigint;
  readonly minWalletQuoteBalanceDeltaAtoms: bigint;
  readonly maxResidualBaseQuantityAtoms: bigint;
  readonly requiredOwner?: string;
  readonly requiredSettlementAccount?: string;
  readonly hyperliquidQuantityPolicy?: Exclude<QuantityPolicyClass, "EXACT_ATOMIC">;
  readonly hyperliquidMaxNetSpotShortfallAtoms?: bigint;
  readonly hyperliquidMaxNetSpotExcessAtoms?: bigint;
  readonly hyperliquidMaxTerminalResidualBaseQuantityAtoms?: bigint;
  readonly hyperliquidMaxTerminalResidualQuoteValueAtoms?: bigint;
  readonly hyperliquidResidualValuationReferencePrice?: ExactPrice;
  readonly hyperliquidMinPerpSellPrice?: ExactPrice;
  readonly hyperliquidRecoveryExpiryTtl?: bigint;
  readonly hyperliquidRecoveryDeadlineTtl?: bigint;
  readonly hyperliquidMinRecoveryWindowMs?: bigint;
  readonly maxRecoverySpotBuyPrice?: ExactPrice;
  readonly minRecoverySpotSellPrice?: ExactPrice;
  readonly minRecoveryPerpSellPrice?: ExactPrice;
  readonly maxRecoveryPerpBuyPrice?: ExactPrice;
  readonly maxRecoveryCostAtomsByAsset?: readonly FeeCap[];
  readonly maxAggregateRecoveryLossQuoteAtoms?: bigint;
  readonly allowedRecoveryActions?: readonly RecoveryAction[];
}

export interface CanonicalEntryRequest {
  readonly contextId: string;
  readonly owner: string;
  readonly settlementAccount: string;
  readonly sizeAtoms: bigint;
  readonly slippageBps: number;
  readonly idempotencyKey: string;
  readonly currentClock: bigint;
}

export interface CanonicalExitRequest {
  readonly contextId: string;
  readonly owner: string;
  readonly settlementAccount: string;
  readonly entryReceiptHash: Uint8Array;
  readonly positionSizeAtoms: bigint;
  readonly positionEntryNotionalAtoms: bigint;
  readonly minSpotQuoteOutAtoms: bigint;
  readonly minExitQuoteOutcomeAtoms: bigint;
  readonly idempotencyKey: string;
  readonly currentClock: bigint;
}

export interface CanonicalEntryOrder {
  readonly order: PackageOrder;
  readonly orderBytes: Uint8Array;
  readonly orderHash: Hash32;
  readonly requestCommitment: Hash32;
}

export class EntryOrderValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EntryOrderValidationError";
    this.code = code;
  }
}

const REQUEST_KEYS = [
  "contextId",
  "currentClock",
  "idempotencyKey",
  "owner",
  "settlementAccount",
  "sizeAtoms",
  "slippageBps",
] as const;
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const BPS_SCALE = 10_000n;
const U64_MAX = 18446744073709551615n;
const INTERNAL_REQUEST_DOMAIN = "NARYX/internal-order-request/v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId &&
    left.decimals === right.decimals &&
    bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function hashToNonce(value: Hash32): bigint {
  let result = 0n;
  for (const byte of value.subarray(0, 8)) {
    result = (result << 8n) + BigInt(byte);
  }
  return result === 0n ? 1n : result;
}

function requireNonemptyString(value: unknown, code: string, message: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new EntryOrderValidationError(code, message);
  }
  return value;
}

function parseRequest(value: unknown): CanonicalEntryRequest {
  if (!isRecord(value)) {
    throw new EntryOrderValidationError("INVALID_BODY", "Request body must be a JSON object.");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== REQUEST_KEYS.length ||
      !REQUEST_KEYS.every((key, index) => keys[index] === key)) {
    throw new EntryOrderValidationError(
      "INVALID_FIELDS",
      "Request must contain only contextId, owner, settlementAccount, sizeAtoms, slippageBps, idempotencyKey, and currentClock.",
    );
  }
  const contextId = requireNonemptyString(value.contextId, "INVALID_CONTEXT_ID", "Context ID is invalid.");
  if (!CONTEXT_ID_PATTERN.test(contextId)) {
    throw new EntryOrderValidationError("INVALID_CONTEXT_ID", "Context ID is invalid.");
  }
  const owner = requireNonemptyString(value.owner, "INVALID_OWNER", "Owner is invalid.");
  const settlementAccount = requireNonemptyString(
    value.settlementAccount,
    "INVALID_SETTLEMENT_ACCOUNT",
    "Settlement account is invalid.",
  );
  if (typeof value.sizeAtoms !== "bigint" || value.sizeAtoms <= 0n) {
    throw new EntryOrderValidationError("INVALID_SIZE", "Size must be positive bigint atoms.");
  }
  if (typeof value.slippageBps !== "number" ||
      !Number.isSafeInteger(value.slippageBps) ||
      value.slippageBps <= 0) {
    throw new EntryOrderValidationError("INVALID_SLIPPAGE", "Slippage must be a positive integer.");
  }
  if (typeof value.idempotencyKey !== "string" ||
      !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey)) {
    throw new EntryOrderValidationError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency key must use 16 to 64 URL-safe characters.",
    );
  }
  if (typeof value.currentClock !== "bigint" ||
      value.currentClock <= 0n ||
      value.currentClock > U64_MAX) {
    throw new EntryOrderValidationError("INVALID_CLOCK", "Current clock must be a positive u64.");
  }
  return Object.freeze({
    contextId,
    owner,
    settlementAccount,
    sizeAtoms: value.sizeAtoms,
    slippageBps: value.slippageBps,
    idempotencyKey: value.idempotencyKey,
    currentClock: value.currentClock,
  });
}

function requireU32Version(value: number, code: string, message: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new EntryOrderValidationError(code, message);
  }
  return value;
}

function requireNonnegative(value: bigint, code: string, message: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new EntryOrderValidationError(code, message);
  }
  return value;
}

function loadContext(
  provider: ActiveOrderContextProvider,
  request: CanonicalEntryRequest,
): ActiveOrderContext {
  if (typeof provider !== "function") {
    throw new EntryOrderValidationError("INVALID_PROVIDER", "Context provider is invalid.");
  }
  const context = provider(request.contextId);
  if (context === undefined) {
    throw new EntryOrderValidationError("UNKNOWN_CONTEXT", "Order context is unknown.");
  }
  if (context.contextId !== request.contextId) {
    throw new EntryOrderValidationError("CONTEXT_MISMATCH", "Order context ID does not match.");
  }
  if (context.state !== "ACTIVE") {
    throw new EntryOrderValidationError("INACTIVE_CONTEXT", "Order context is not active.");
  }
  if (context.settlementClass !== "ATOMIC_POSTCONDITION"
      && context.settlementClass !== "BATCHED_IOC_WITH_RECOVERY") {
    throw new EntryOrderValidationError(
      "UNSUPPORTED_SETTLEMENT",
      "Settlement class is unsupported for entry.",
    );
  }
  const hyperliquid = context.settlementClass === "BATCHED_IOC_WITH_RECOVERY";
  if ((!hyperliquid && context.expiryUnit !== "SOLANA_SLOT" && context.expiryUnit !== "EVM_UNIX_SECONDS")
      || (hyperliquid && context.expiryUnit !== "HYPERLIQUID_UNIX_MILLISECONDS")) {
    throw new EntryOrderValidationError("UNSAFE_EXPIRY", "Settlement clock does not match its profile.");
  }
  if (typeof context.expiryTtl !== "bigint" || context.expiryTtl <= 0n || context.expiryTtl > U64_MAX) {
    throw new EntryOrderValidationError("UNSAFE_EXPIRY", "Expiry TTL must be a positive u64.");
  }
  if (typeof context.capturedAtClock !== "bigint" ||
      context.capturedAtClock < 0n ||
      context.capturedAtClock > U64_MAX) {
    throw new EntryOrderValidationError("STALE_CONTEXT", "Order context clock is invalid.");
  }
  if (typeof context.maxStaleness !== "bigint" || context.maxStaleness < 0n) {
    throw new EntryOrderValidationError("STALE_CONTEXT", "Order context staleness bound is invalid.");
  }
  if (request.currentClock < context.capturedAtClock ||
      request.currentClock - context.capturedAtClock > context.maxStaleness) {
    throw new EntryOrderValidationError("STALE_CONTEXT", "Order context is stale.");
  }
  if (typeof context.maximumQuantityAtoms !== "bigint" || context.maximumQuantityAtoms <= 0n) {
    throw new EntryOrderValidationError("INVALID_CONTEXT", "Maximum quantity must be positive.");
  }
  if (request.sizeAtoms > context.maximumQuantityAtoms) {
    throw new EntryOrderValidationError("OVERSIZED", "Size exceeds the active context maximum.");
  }
  if (!Number.isSafeInteger(context.maxSlippageBps) ||
      context.maxSlippageBps < 1 ||
      context.maxSlippageBps > 10_000) {
    throw new EntryOrderValidationError("INVALID_CONTEXT", "Maximum slippage is invalid.");
  }
  if (request.slippageBps > context.maxSlippageBps) {
    throw new EntryOrderValidationError("EXCESS_SLIPPAGE", "Slippage exceeds the active context maximum.");
  }
  if ((context.requiredOwner !== undefined && request.owner !== context.requiredOwner)
      || (context.requiredSettlementAccount !== undefined
        && request.settlementAccount !== context.requiredSettlementAccount)) {
    throw new EntryOrderValidationError(
      "ACCOUNT_MISMATCH",
      "Owner and settlement account must match the configured hosted account.",
    );
  }
  requireU32Version(context.orderVersion, "INVALID_CONTEXT", "Order version is invalid.");
  requireU32Version(context.templateVersion, "INVALID_CONTEXT", "Template version is invalid.");
  requireNonemptyString(context.environment, "INVALID_CONTEXT", "Environment is invalid.");
  requireNonemptyString(context.templateId, "INVALID_CONTEXT", "Template ID is invalid.");
  if (!Array.isArray(context.spotAdapters) || context.spotAdapters.length === 0) {
    throw new EntryOrderValidationError("INVALID_CONTEXT", "Spot adapters are missing.");
  }
  if (!Array.isArray(context.perpAdapters) || context.perpAdapters.length === 0) {
    throw new EntryOrderValidationError("INVALID_CONTEXT", "Perp adapters are missing.");
  }
  if (!Array.isArray(context.maxVenueFeeAtomsByAsset)) {
    throw new EntryOrderValidationError("INVALID_CONTEXT", "Venue fee caps are invalid.");
  }
  requireNonnegative(context.maxMarginAddedAtoms, "INVALID_CONTEXT", "Margin cap must be nonnegative.");
  requireNonnegative(context.maxProtocolFeeAtoms, "INVALID_CONTEXT", "Protocol fee cap must be nonnegative.");
  requireNonnegative(context.maxSolverFeeAtoms, "INVALID_CONTEXT", "Solver fee cap must be nonnegative.");
  requireNonnegative(context.maxPriorityFeeAtoms, "INVALID_CONTEXT", "Priority fee cap must be nonnegative.");
  requireNonnegative(
    context.maxResidualBaseQuantityAtoms,
    "INVALID_CONTEXT",
    "Residual cap must be nonnegative.",
  );
  if (typeof context.minVenueReserveReturnedAtoms !== "bigint" ||
      typeof context.minWalletQuoteBalanceDeltaAtoms !== "bigint") {
    throw new EntryOrderValidationError("INVALID_CONTEXT", "Quote bound is invalid.");
  }
  if (!sameAsset(context.spotReferencePrice.baseAsset, context.baseAsset) ||
      !sameAsset(context.spotReferencePrice.quoteAsset, context.quoteAsset)) {
    throw new EntryOrderValidationError("INVALID_CONTEXT", "Spot reference price assets do not match.");
  }
  if (context.spotReferencePrice.quoteAtoms <= 0n || context.spotReferencePrice.baseAtoms <= 0n) {
    throw new EntryOrderValidationError("INVALID_CONTEXT", "Spot reference price must be positive.");
  }
  if (!sameAsset(context.maxEntrySpread.baseAsset, context.baseAsset) ||
      !sameAsset(context.maxEntrySpread.quoteAsset, context.quoteAsset)) {
    throw new EntryOrderValidationError("INVALID_CONTEXT", "Entry spread assets do not match.");
  }
  return context;
}

export function createCanonicalEntryOrder(
  provider: ActiveOrderContextProvider,
  request: unknown,
): CanonicalEntryOrder {
  const parsed = parseRequest(request);
  const context = loadContext(provider, parsed);
  const slippage = BigInt(parsed.slippageBps);
  const denominator = context.spotReferencePrice.baseAtoms * BPS_SCALE;
  if (denominator <= 0n) {
    throw new EntryOrderValidationError("INVALID_CONTEXT", "Spot reference price must be positive.");
  }
  const numerator = parsed.sizeAtoms *
    context.spotReferencePrice.quoteAtoms *
    (BPS_SCALE + slippage);
  const maxSpotQuoteInAtoms = (numerator + denominator - 1n) / denominator;
  if (maxSpotQuoteInAtoms <= 0n) {
    throw new EntryOrderValidationError("INVALID_SIZE", "Quoted entry bound must be positive.");
  }
  const expiryValue = parsed.currentClock + context.expiryTtl;
  if (expiryValue <= parsed.currentClock || expiryValue > U64_MAX) {
    throw new EntryOrderValidationError("UNSAFE_EXPIRY", "Entry expiry is outside the safe window.");
  }
  const requestPayload = canonicalBytes((writer) => {
    writer.writeString(parsed.contextId, "request.contextId");
    writer.writeString(parsed.owner, "request.owner");
    writer.writeString(parsed.settlementAccount, "request.settlementAccount");
    writer.writeU256(parsed.sizeAtoms, "request.sizeAtoms");
    writer.writeU32(parsed.slippageBps, "request.slippageBps");
    writer.writeString(parsed.idempotencyKey, "request.idempotencyKey");
  });
  const requestCommitment = hash32(
    createHash("sha256").update(INTERNAL_REQUEST_DOMAIN, "ascii").update(requestPayload).digest(),
    "requestCommitment",
  );
  const nonce = hashToNonce(requestCommitment);
  const hyperliquid = context.settlementClass === "BATCHED_IOC_WITH_RECOVERY";
  const maxNetSpotShortfall = context.hyperliquidMaxNetSpotShortfallAtoms ?? 0n;
  if (maxNetSpotShortfall > parsed.sizeAtoms) {
    throw new EntryOrderValidationError(
      "INVALID_CONTEXT",
      "Hyperliquid net spot shortfall cannot exceed package quantity.",
    );
  }
  const minNetSpotDelta = parsed.sizeAtoms - maxNetSpotShortfall;
  const maxNetSpotDelta = parsed.sizeAtoms
    + (context.hyperliquidMaxNetSpotExcessAtoms ?? 0n);
  const input: PackageOrderInput = {
    version: context.orderVersion,
    environment: context.environment,
    domain: context.domain,
    templateId: context.templateId,
    templateVersion: context.templateVersion,
    packageTemplateManifestHash: context.packageTemplateManifestHash,
    owner: parsed.owner,
    settlementAccount: parsed.settlementAccount,
    nonce,
    expiryUnit: context.expiryUnit,
    expiryValue,
    direction: "LONG_SPOT_SHORT_PERP",
    action: "ENTRY",
    packageOrderType: "MARKETABLE_LIMIT",
    packageTimeInForce: hyperliquid ? "IOC" : "FOK",
    partialFillPolicy: "EXACT_ALL_LEGS",
    quantity: { asset: context.baseAsset, atoms: parsed.sizeAtoms },
    ...(hyperliquid ? {
      hyperliquidQuantityPolicy: context.hyperliquidQuantityPolicy,
      hyperliquidGrossSpotQuantity: { asset: context.baseAsset, atoms: parsed.sizeAtoms },
      hyperliquidMinNetSpotDelta: { asset: context.baseAsset, atoms: minNetSpotDelta },
      hyperliquidMaxNetSpotDelta: { asset: context.baseAsset, atoms: maxNetSpotDelta },
      hyperliquidMaxTerminalResidualBaseQuantity: {
        asset: context.baseAsset,
        atoms: context.hyperliquidMaxTerminalResidualBaseQuantityAtoms ?? 0n,
      },
      ...(context.hyperliquidQuantityPolicy === "BOUNDED_NET" ? {
        hyperliquidResidualValuationSchemaVersion: 1,
        hyperliquidResidualValuationReferencePrice:
          context.hyperliquidResidualValuationReferencePrice,
      } : {}),
      hyperliquidMaxTerminalResidualQuoteValue: {
        asset: context.quoteAsset,
        atoms: context.hyperliquidMaxTerminalResidualQuoteValueAtoms ?? 0n,
      },
      expectedPreStrategySpotQuantity: { asset: context.baseAsset, atoms: 0n },
      hyperliquidRecoveryExpiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS" as const,
      hyperliquidMaxRecoveryActionExpiryValue:
        parsed.currentClock + (context.hyperliquidRecoveryExpiryTtl ?? 0n),
      hyperliquidRecoveryDeadlineValue:
        parsed.currentClock + (context.hyperliquidRecoveryDeadlineTtl ?? 0n),
      hyperliquidMinRecoveryWindowMs: context.hyperliquidMinRecoveryWindowMs,
      hyperliquidMinPerpSellPrice: context.hyperliquidMinPerpSellPrice,
      maxRecoverySpotBuyPrice: context.maxRecoverySpotBuyPrice,
      minRecoverySpotSellPrice: context.minRecoverySpotSellPrice,
      minRecoveryPerpSellPrice: context.minRecoveryPerpSellPrice,
      maxRecoveryPerpBuyPrice: context.maxRecoveryPerpBuyPrice,
    } : {}),
    exitOutcomeSchemaVersion: 0,
    expectedPrePositionSize: { asset: context.baseAsset, atoms: 0n },
    expectedPrePositionEntryNotional: { asset: context.quoteAsset, atoms: 0n },
    maxEntrySpread: context.maxEntrySpread,
    maxSpotQuoteIn: { asset: context.quoteAsset, atoms: maxSpotQuoteInAtoms },
    maxMarginAdded: { asset: context.quoteAsset, atoms: context.maxMarginAddedAtoms },
    minVenueReserveReturned: { asset: context.quoteAsset, atoms: context.minVenueReserveReturnedAtoms },
    minWalletQuoteBalanceDelta: {
      asset: context.quoteAsset,
      atoms: context.minWalletQuoteBalanceDeltaAtoms,
    },
    maxVenueFeeAtomsByAsset: [...context.maxVenueFeeAtomsByAsset],
    maxProtocolFee: { asset: context.quoteAsset, atoms: context.maxProtocolFeeAtoms },
    maxSolverFee: { asset: context.quoteAsset, atoms: context.maxSolverFeeAtoms },
    maxPriorityFee: { asset: context.quoteAsset, atoms: context.maxPriorityFeeAtoms },
    maxRecoveryCostAtomsByAsset: hyperliquid
      ? [...(context.maxRecoveryCostAtomsByAsset ?? [])]
      : [],
    permittedSpotAdapters: [...context.spotAdapters],
    permittedPerpAdapters: [...context.perpAdapters],
    settlementClass: context.settlementClass,
    maxAggregateRecoveryLossQuote: {
      asset: context.quoteAsset,
      atoms: hyperliquid ? context.maxAggregateRecoveryLossQuoteAtoms ?? 0n : 0n,
    },
    maxResidualBaseQuantity: { asset: context.baseAsset, atoms: context.maxResidualBaseQuantityAtoms },
    allowedRecoveryActions: hyperliquid ? [...(context.allowedRecoveryActions ?? [])] : [],
  };
  const order = validatePackageOrderProfile(input, "packageOrder");
  const orderBytes = packageOrderBytes(input);
  const orderHash = packageOrderHash(input);
  return Object.freeze({ order, orderBytes, orderHash, requestCommitment });
}

export function createCanonicalExitOrder(
  provider: ActiveOrderContextProvider,
  request: CanonicalExitRequest,
): CanonicalEntryOrder {
  if (typeof request !== "object" || request === null
    || typeof request.contextId !== "string" || !CONTEXT_ID_PATTERN.test(request.contextId)
    || typeof request.owner !== "string" || request.owner.length === 0
    || typeof request.settlementAccount !== "string" || request.settlementAccount.length === 0
    || !(request.entryReceiptHash instanceof Uint8Array) || request.entryReceiptHash.length !== 32
    || request.entryReceiptHash.every((byte) => byte === 0)
    || typeof request.positionSizeAtoms !== "bigint" || request.positionSizeAtoms <= 0n
    || typeof request.positionEntryNotionalAtoms !== "bigint" || request.positionEntryNotionalAtoms <= 0n
    || typeof request.minSpotQuoteOutAtoms !== "bigint" || request.minSpotQuoteOutAtoms < 0n
    || typeof request.minExitQuoteOutcomeAtoms !== "bigint" || request.minExitQuoteOutcomeAtoms < 0n
    || typeof request.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)
    || typeof request.currentClock !== "bigint" || request.currentClock <= 0n || request.currentClock > U64_MAX) {
    throw new EntryOrderValidationError("INVALID_EXIT", "Canonical exit inputs are invalid.");
  }
  const context = loadContext(provider, {
    contextId: request.contextId,
    owner: request.owner,
    settlementAccount: request.settlementAccount,
    sizeAtoms: request.positionSizeAtoms,
    slippageBps: 1,
    idempotencyKey: request.idempotencyKey,
    currentClock: request.currentClock,
  });
  const expiryValue = request.currentClock + context.expiryTtl;
  if (expiryValue <= request.currentClock || expiryValue > U64_MAX) {
    throw new EntryOrderValidationError("UNSAFE_EXPIRY", "Exit expiry is outside the safe window.");
  }
  const requestPayload = canonicalBytes((writer) => {
    writer.writeString(request.contextId, "exitRequest.contextId");
    writer.writeString(request.owner, "exitRequest.owner");
    writer.writeString(request.settlementAccount, "exitRequest.settlementAccount");
    writer.writeFixedBytes(request.entryReceiptHash, 32, "exitRequest.entryReceiptHash");
    writer.writeU256(request.positionSizeAtoms, "exitRequest.positionSizeAtoms");
    writer.writeU256(request.positionEntryNotionalAtoms, "exitRequest.positionEntryNotionalAtoms");
    writer.writeU256(request.minSpotQuoteOutAtoms, "exitRequest.minSpotQuoteOutAtoms");
    writer.writeU256(request.minExitQuoteOutcomeAtoms, "exitRequest.minExitQuoteOutcomeAtoms");
    writer.writeString(request.idempotencyKey, "exitRequest.idempotencyKey");
  });
  const requestCommitment = hash32(
    createHash("sha256").update("NARYX/internal-exit-order-request/v1", "ascii").update(requestPayload).digest(),
    "exitRequestCommitment",
  );
  const nonce = hashToNonce(requestCommitment);
  const input: PackageOrderInput = {
    version: context.orderVersion,
    environment: context.environment,
    domain: context.domain,
    templateId: context.templateId,
    templateVersion: context.templateVersion,
    packageTemplateManifestHash: context.packageTemplateManifestHash,
    owner: request.owner,
    settlementAccount: request.settlementAccount,
    nonce,
    expiryUnit: context.expiryUnit,
    expiryValue,
    direction: "LONG_SPOT_SHORT_PERP",
    action: "EXIT",
    packageOrderType: "MARKETABLE_LIMIT",
    packageTimeInForce: "FOK",
    partialFillPolicy: "EXACT_ALL_LEGS",
    quantity: { asset: context.baseAsset, atoms: request.positionSizeAtoms },
    exitOutcomeSchemaVersion: 1,
    entryReceiptHash: request.entryReceiptHash,
    expectedPrePositionSize: { asset: context.baseAsset, atoms: -request.positionSizeAtoms },
    expectedPrePositionEntryNotional: { asset: context.quoteAsset, atoms: request.positionEntryNotionalAtoms },
    minExitQuoteOutcome: { asset: context.quoteAsset, atoms: request.minExitQuoteOutcomeAtoms },
    minSpotQuoteOut: { asset: context.quoteAsset, atoms: request.minSpotQuoteOutAtoms },
    maxMarginAdded: { asset: context.quoteAsset, atoms: 0n },
    minVenueReserveReturned: { asset: context.quoteAsset, atoms: context.minVenueReserveReturnedAtoms },
    minWalletQuoteBalanceDelta: { asset: context.quoteAsset, atoms: context.minWalletQuoteBalanceDeltaAtoms },
    maxVenueFeeAtomsByAsset: [...context.maxVenueFeeAtomsByAsset],
    maxProtocolFee: { asset: context.quoteAsset, atoms: context.maxProtocolFeeAtoms },
    maxSolverFee: { asset: context.quoteAsset, atoms: context.maxSolverFeeAtoms },
    maxPriorityFee: { asset: context.quoteAsset, atoms: context.maxPriorityFeeAtoms },
    maxRecoveryCostAtomsByAsset: [],
    permittedSpotAdapters: [...context.spotAdapters],
    permittedPerpAdapters: [...context.perpAdapters],
    settlementClass: "ATOMIC_POSTCONDITION",
    maxAggregateRecoveryLossQuote: { asset: context.quoteAsset, atoms: 0n },
    maxResidualBaseQuantity: { asset: context.baseAsset, atoms: 0n },
    allowedRecoveryActions: [],
  };
  const order = validatePackageOrderProfile(input, "packageOrder");
  return Object.freeze({
    order,
    orderBytes: packageOrderBytes(input),
    orderHash: packageOrderHash(input),
    requestCommitment,
  });
}
