import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyTypedData, type Hex } from "viem";
import {
  canonicalBytes,
  fromProtocolJson,
  hash32,
  packageOrderBytes,
  packageOrderHash,
  solverQuote,
  validatePackageOrderProfile,
  type PackageOrder,
  type PackageOrderInput,
  type SolverQuoteInput,
} from "@naryx/protocol-types";
import type { ActiveOrderContextProvider } from "./canonical-entry-order.js";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import {
  HYPERLIQUID_TESTNET_OWNER_PATTERN,
  deriveHyperliquidTestnetExitLimits,
} from "./hyperliquid-testnet-order-context.js";
import {
  HyperliquidOwnerLedgerError,
  type HyperliquidOmnibusLimits,
  type HyperliquidOwnerPackage,
  type HyperliquidTestnetOwnerLedger,
} from "./hyperliquid-testnet-owner-ledger.js";
import type { HyperliquidTestnetPriceSource } from "./hyperliquid-testnet-price-feed.js";
import type { HyperliquidTestnetOrderContextConfig } from "./hyperliquid-testnet-runtime-client.js";
import {
  HYPERLIQUID_TESTNET_DOMAIN,
  HyperliquidTestnetTerminalValidationError,
  parseHyperliquidTestnetTerminalExecutionRequest,
  type HyperliquidTestnetTerminalExecutionRequest,
  type HyperliquidTestnetTerminalExecutionResult,
} from "./hyperliquid-testnet-terminal.js";
import type {
  HyperliquidTestnetAttemptState,
  HyperliquidTestnetExecutionGuard,
} from "./hyperliquid-testnet-terminal-execution.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import { buildHyperliquidStrategyPackageReceipt } from "./hyperliquid-strategy-receipt.js";
import type { SqliteStrategyPackageStore } from "./strategy-package-store.js";
import type { InternalOrderClockPort } from "./terminal-orders.js";

export const HYPERLIQUID_TESTNET_ACCOUNT_PATH = "/internal/terminal/hyperliquid-testnet/account";
export const HYPERLIQUID_TESTNET_AUTHORIZATION_PATH = "/internal/terminal/hyperliquid-testnet/authorization";
export const HYPERLIQUID_TESTNET_AUTHORIZE_PATH = "/internal/terminal/hyperliquid-testnet/authorize";
export const HYPERLIQUID_TESTNET_EXIT_ORDER_PATH = "/internal/terminal/hyperliquid-testnet/exit-order";
export const HYPERLIQUID_TESTNET_ATTEMPT_STATUS_PATH = "/internal/terminal/hyperliquid-testnet/attempt-status";

const MAX_BODY_BYTES = 2_048;
const ATTEMPT_ID = /^hyperliquid-testnet-[0-9a-f]{48}$/;
const STRATEGY_ATTEMPT_ID = /^strategy-hl-[0-9a-f]{48}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const U64_MAX = 18446744073709551615n;
const EXIT_REQUEST_DOMAIN = "NARYX/hyperliquid-testnet-exit-order-request/v1";

class OwnerRouteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * What the owner's wallet signs: the canonical order hash, which commits to the owner, the
 * settlement account, every limit, and the action. No chain id is bound because Hyperliquid
 * Testnet orders are not EVM transactions; the wallet may sit on any network.
 */
export function hyperliquidTestnetAuthorizationTypedData(input: Readonly<{
  orderHash: string;
  action: PackageOrder["action"];
  owner: string;
  tradingAccount: string;
}>) {
  return Object.freeze({
    domain: Object.freeze({ name: "Naryx Hyperliquid Testnet", version: "1" }),
    types: Object.freeze({
      PackageAuthorization: Object.freeze([
        { name: "orderHash", type: "bytes32" },
        { name: "action", type: "string" },
        { name: "owner", type: "address" },
        { name: "tradingAccount", type: "address" },
        { name: "domainId", type: "string" },
      ]),
    }),
    primaryType: "PackageAuthorization" as const,
    message: Object.freeze({
      orderHash: `0x${input.orderHash}`,
      action: input.action,
      owner: input.owner,
      tradingAccount: input.tradingAccount,
      domainId: HYPERLIQUID_TESTNET_DOMAIN,
    }),
  });
}

export async function verifyHyperliquidTestnetAuthorization(
  input: Parameters<typeof hyperliquidTestnetAuthorizationTypedData>[0],
  signature: string,
): Promise<boolean> {
  if (!SIGNATURE.test(signature) || !HYPERLIQUID_TESTNET_OWNER_PATTERN.test(input.owner)) return false;
  const typed = hyperliquidTestnetAuthorizationTypedData(input);
  try {
    return await verifyTypedData({
      address: input.owner as Hex,
      domain: typed.domain,
      types: { PackageAuthorization: [...typed.types.PackageAuthorization] },
      primaryType: typed.primaryType,
      message: { ...typed.message, orderHash: typed.message.orderHash as Hex, owner: input.owner as Hex,
        tradingAccount: input.tradingAccount as Hex },
      signature: signature as Hex,
    });
  } catch {
    return false;
  }
}

type StrategyAttemptLookup = Readonly<{
  anyStrategyExecutionAttempt(attemptId: string): Readonly<{
    sourceOrderHashHex?: string;
    orderHashHex: string;
    quoteHashHex: string;
  }> | undefined;
}>;

type AttemptBinding = Readonly<{
  attemptId: string;
  orderHash: string;
  order: PackageOrder | null;
  selectedQuoteAttemptId: string | null;
  strategyOrderHash: string | null;
  strategyQuoteHash: string | null;
}>;

function attemptBinding(
  attemptId: string,
  intents: Pick<ExecutionIntentStore, "getAttempt"> & Partial<Pick<ExecutionIntentStore, "getAttemptForOrder">>,
  orders: Pick<InternalOrderStore, "getCanonicalOrderByHash">,
  strategyAttempts?: StrategyAttemptLookup,
): AttemptBinding {
  let attempt: ReturnType<ExecutionIntentStore["getAttempt"]>;
  try {
    attempt = ATTEMPT_ID.test(attemptId) ? intents.getAttempt(attemptId) : undefined;
  } catch {
    attempt = undefined;
  }
  if (attempt !== undefined && attempt.status === "HYPERLIQUID_TESTNET_QUOTE_SELECTED") {
    const order = orders.getCanonicalOrderByHash(attempt.orderHash);
    if (order !== undefined) {
      return Object.freeze({
        attemptId,
        orderHash: attempt.orderHash,
        order,
        selectedQuoteAttemptId: attempt.attemptId,
        strategyOrderHash: null,
        strategyQuoteHash: null,
      });
    }
  }
  const strategyAttempt = STRATEGY_ATTEMPT_ID.test(attemptId)
    ? strategyAttempts?.anyStrategyExecutionAttempt(attemptId)
    : undefined;
  const sourceAttempt = strategyAttempt?.sourceOrderHashHex === undefined
    ? undefined
    : intents.getAttemptForOrder?.(strategyAttempt.sourceOrderHashHex);
  const sourceOrderHash = strategyAttempt?.sourceOrderHashHex;
  const sourceOrder = sourceAttempt?.status === "HYPERLIQUID_TESTNET_QUOTE_SELECTED"
    && sourceAttempt.domainId === HYPERLIQUID_TESTNET_DOMAIN && sourceOrderHash !== undefined
    ? orders.getCanonicalOrderByHash(sourceOrderHash)
    : undefined;
  if (strategyAttempt === undefined
    || (sourceOrderHash !== undefined && (sourceAttempt === undefined || sourceOrder === undefined))) {
    throw new HyperliquidTestnetTerminalValidationError("ATTEMPT_NOT_FOUND", "Hyperliquid attempt was not found.");
  }
  return Object.freeze({
    attemptId,
    orderHash: sourceOrderHash ?? strategyAttempt.orderHashHex,
    order: sourceOrder ?? null,
    selectedQuoteAttemptId: sourceAttempt?.attemptId ?? null,
    strategyOrderHash: strategyAttempt.orderHashHex,
    strategyQuoteHash: strategyAttempt.quoteHashHex,
  });
}

function ledgerRefusal(error: unknown): never {
  if (error instanceof HyperliquidOwnerLedgerError) {
    throw new HyperliquidTestnetTerminalValidationError(error.code, error.message);
  }
  throw error;
}

/**
 * Refuses a handoff unless the order's owner signed it and it settles in the trading account;
 * then reserves the owner's package slot and the account's notional for an entry, or claims the
 * exact open package an exit closes.
 */
export function createHyperliquidTestnetExecutionGuard(options: Readonly<{
  ledger: HyperliquidTestnetOwnerLedger;
  intents: Pick<ExecutionIntentStore, "getAttempt" | "getSelectedQuote" | "getAttemptForOrder">;
  orders: Pick<InternalOrderStore, "getCanonicalOrderByHash">;
  strategyAttempts?: StrategyAttemptLookup;
  strategyReceipts?: Pick<
    SqliteStrategyPackageStore,
    "anyStrategyExecutionAttempt" | "admissionByQuote" | "ownerAuthorization" | "recordReceipt"
  >;
  tradingAccount: string;
  limits: HyperliquidOmnibusLimits | undefined;
  /** Base atoms per spot size unit; an exit sells the package spot floored to it. */
  spotLotAtoms: bigint;
}>): HyperliquidTestnetExecutionGuard {
  const entryNotional = (attemptId: string): bigint => {
    const selected = options.intents.getSelectedQuote(attemptId);
    if (selected === undefined) return 0n;
    try {
      return solverQuote(fromProtocolJson(selected.quote, "selected.quote") as SolverQuoteInput)
        .expectedPerpNotional.atoms;
    } catch {
      return 0n;
    }
  };
  const authorized = (request: HyperliquidTestnetTerminalExecutionRequest): AttemptBinding => {
    const binding = attemptBinding(request.attemptId, options.intents, options.orders, options.strategyAttempts);
    if (binding.strategyOrderHash !== null) {
      const admission = binding.strategyQuoteHash === null
        ? undefined : options.strategyReceipts?.admissionByQuote(binding.strategyQuoteHash);
      const authorization = options.strategyReceipts?.ownerAuthorization(binding.strategyOrderHash);
      if (admission === undefined || admission.orderHashHex !== binding.strategyOrderHash
        || authorization?.owner !== admission.order.owner) {
        throw new HyperliquidTestnetTerminalValidationError(
          "OWNER_AUTHORIZATION_REQUIRED",
          "The package owner must sign the generalized package authorization before execution.",
        );
      }
      if (admission.order.settlementAccount !== options.tradingAccount) {
        throw new HyperliquidTestnetTerminalValidationError(
          "SETTLEMENT_ACCOUNT_MISMATCH",
          "The generalized order does not settle in the configured trading account.",
        );
      }
      return binding;
    }
    if (binding.order === null || binding.order.settlementAccount !== options.tradingAccount) {
      throw new HyperliquidTestnetTerminalValidationError(
        "SETTLEMENT_ACCOUNT_MISMATCH",
        "The order does not settle in the configured trading account.",
      );
    }
    if (options.ledger.authorization(binding.orderHash)?.owner !== binding.order.owner) {
      throw new HyperliquidTestnetTerminalValidationError(
        "OWNER_AUTHORIZATION_REQUIRED",
        "The package owner must sign the package authorization before execution.",
      );
    }
    return binding;
  };
  return Object.freeze({
    requireOwnerAuthorization(request: HyperliquidTestnetTerminalExecutionRequest) {
      authorized(request);
    },
    admit(request: HyperliquidTestnetTerminalExecutionRequest) {
      const { order, orderHash, strategyOrderHash } = authorized(request);
      if (strategyOrderHash !== null) return;
      if (order === null) throw new HyperliquidTestnetTerminalValidationError("ATTEMPT_NOT_FOUND", "Hyperliquid order was not found.");
      try {
        if (order.action === "ENTRY") {
          if (options.limits === undefined) {
            throw new HyperliquidTestnetTerminalValidationError(
              "OMNIBUS_LIMITS_UNCONFIGURED",
              "Hyperliquid testnet entries are closed until the shared account limits are configured.",
            );
          }
          options.ledger.reserveEntry({
            attemptId: request.attemptId,
            owner: order.owner,
            orderHash,
            notionalAtoms: order.maxSpotQuoteIn!.atoms,
            limits: options.limits,
          });
          return;
        }
        options.ledger.beginExit(request.attemptId, {
          owner: order.owner,
          orderHash,
          perpQuantityAtoms: order.quantity.atoms,
          grossSpotQuantityAtoms: order.hyperliquidGrossSpotQuantity?.atoms ?? 0n,
          spotLotAtoms: options.spotLotAtoms,
          entryReceiptHash: order.entryReceiptHash === undefined ? "" : hex(order.entryReceiptHash),
        });
      } catch (error) {
        ledgerRefusal(error);
      }
    },
    settle(request: HyperliquidTestnetTerminalExecutionRequest, result: HyperliquidTestnetTerminalExecutionResult) {
      const binding = attemptBinding(request.attemptId, options.intents, options.orders, options.strategyAttempts);
      const strategyAttempt = options.strategyReceipts?.anyStrategyExecutionAttempt(request.attemptId);
      let strategyReceipt: ReturnType<typeof buildHyperliquidStrategyPackageReceipt> = undefined;
      if (strategyAttempt !== undefined) {
        const admission = options.strategyReceipts?.admissionByQuote(strategyAttempt.quoteHashHex);
        if (admission === undefined) {
          throw new HyperliquidTestnetTerminalValidationError(
            "STRATEGY_ADMISSION_NOT_FOUND",
            "The selected strategy admission was not found.",
          );
        }
        strategyReceipt = buildHyperliquidStrategyPackageReceipt({
          attemptId: request.attemptId,
          admission,
          result,
        });
        if (strategyReceipt !== undefined) options.strategyReceipts!.recordReceipt(strategyReceipt);
        return;
      }
      const { order } = binding;
      if (order === null) throw new HyperliquidTestnetTerminalValidationError("ATTEMPT_NOT_FOUND", "Hyperliquid order was not found.");
      if (order.action === "ENTRY") {
        if (binding.selectedQuoteAttemptId === null) throw new HyperliquidTestnetTerminalValidationError("ATTEMPT_NOT_FOUND", "Hyperliquid quote attempt was not found.");
        options.ledger.settleEntry(request.attemptId, result, entryNotional(binding.selectedQuoteAttemptId));
      } else {
        options.ledger.settleExit(request.attemptId, result);
      }
    },
  });
}

/**
 * Builds and stores the canonical EXIT of the owner's open package from the live books: sell the
 * package's spot floored to the spot lot and buy back exactly its short, executed by the trading
 * account. HyperCore sells whole size units only, so the sub-lot remainder (the base-token fee
 * dust of the entry) stays in the trading account, bounded by the terminal residual caps.
 */
export function createHyperliquidTestnetExitOrderFactory(options: Readonly<{
  config: HyperliquidTestnetOrderContextConfig;
  /** Base atoms per spot size unit. */
  spotLotAtoms: bigint;
  contexts: ActiveOrderContextProvider;
  clock: InternalOrderClockPort;
  prices: HyperliquidTestnetPriceSource;
  ledger: HyperliquidTestnetOwnerLedger;
  orders: Pick<InternalOrderStore, "createOrGet">;
}>) {
  const { config } = options;
  return async (request: Readonly<{ owner: string; slippageBps: number; idempotencyKey: string }>) => {
    if (!HYPERLIQUID_TESTNET_OWNER_PATTERN.test(request.owner)) {
      throw new OwnerRouteError(400, "INVALID_OWNER", "Owner must be a lowercase nonzero 0x address.");
    }
    if (!Number.isSafeInteger(request.slippageBps) || request.slippageBps < 1
      || request.slippageBps > config.maxSlippageBps) {
      throw new OwnerRouteError(400, "INVALID_SLIPPAGE", "Slippage is outside the context bound.");
    }
    if (!IDEMPOTENCY_KEY.test(request.idempotencyKey)) {
      throw new OwnerRouteError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency key must use 16 to 64 URL-safe characters.");
    }
    const open = options.ledger.openPackage(request.owner);
    if (open === undefined || open.perpQuantityAtoms === null || open.spotQuantityAtoms === null
      || open.entryNotionalAtoms === null || open.entryReceiptHash === null) {
      throw new OwnerRouteError(404, "NO_OPEN_PACKAGE", "This wallet has no open Hyperliquid testnet package.");
    }
    const snapshot = options.prices.latest();
    const context = options.contexts(config.contextId);
    if (snapshot === undefined || context === undefined || context.state !== "ACTIVE"
      || context.capturedAtClock !== BigInt(snapshot.capturedAtMs)) {
      throw new OwnerRouteError(503, "CONTEXT_UNAVAILABLE", "Live Hyperliquid testnet prices are unavailable.");
    }
    const currentClock = await options.clock.currentClock(context);
    if (currentClock < context.capturedAtClock || currentClock - context.capturedAtClock > context.maxStaleness) {
      throw new OwnerRouteError(503, "STALE_CONTEXT", "Live Hyperliquid testnet prices are stale.");
    }
    if (typeof options.spotLotAtoms !== "bigint" || options.spotLotAtoms <= 0n) {
      throw new OwnerRouteError(503, "CONTEXT_UNAVAILABLE", "The Hyperliquid spot lot is not configured.");
    }
    const spotSellAtoms = open.spotQuantityAtoms - open.spotQuantityAtoms % options.spotLotAtoms;
    if (spotSellAtoms <= 0n) {
      throw new OwnerRouteError(409, "EXIT_BELOW_SPOT_LOT", "The package spot is smaller than one spot lot.");
    }
    const limits = deriveHyperliquidTestnetExitLimits(
      config.baseAsset, config.quoteAsset, snapshot,
      spotSellAtoms, open.perpQuantityAtoms, open.entryNotionalAtoms, request.slippageBps,
    );
    const residual = open.perpQuantityAtoms - spotSellAtoms;
    if ((residual < 0n ? -residual : residual) > config.maxTerminalResidualBaseQuantityAtoms) {
      throw new OwnerRouteError(409, "EXIT_RESIDUAL_EXCEEDS_CAP", "The package spot and short differ by more than the residual cap.");
    }
    const requestPayload = canonicalBytes((writer) => {
      writer.writeString(config.contextId, "exitRequest.contextId");
      writer.writeString(request.owner, "exitRequest.owner");
      writer.writeString(config.tradingAccount, "exitRequest.settlementAccount");
      writer.writeString(open.entryReceiptHash!, "exitRequest.entryReceiptHash");
      writer.writeU256(open.perpQuantityAtoms!, "exitRequest.perpQuantityAtoms");
      writer.writeU256(open.spotQuantityAtoms!, "exitRequest.spotQuantityAtoms");
      writer.writeU32(request.slippageBps, "exitRequest.slippageBps");
      writer.writeString(request.idempotencyKey, "exitRequest.idempotencyKey");
    });
    const requestCommitment = hash32(
      createHash("sha256").update(EXIT_REQUEST_DOMAIN, "ascii").update(requestPayload).digest(),
      "exitRequestCommitment",
    );
    let nonce = 0n;
    for (const byte of requestCommitment.subarray(0, 8)) nonce = (nonce << 8n) + BigInt(byte);
    const expiryValue = currentClock + config.expiryTtlMs;
    if (expiryValue > U64_MAX) throw new OwnerRouteError(409, "UNSAFE_EXPIRY", "Exit expiry is outside the safe window.");
    const input: PackageOrderInput = {
      version: config.orderVersion,
      environment: context.environment,
      domain: context.domain,
      templateId: config.templateId,
      templateVersion: config.templateVersion,
      packageTemplateManifestHash: config.packageTemplateManifestHash,
      owner: request.owner,
      settlementAccount: config.tradingAccount,
      nonce: nonce === 0n ? 1n : nonce,
      expiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS",
      expiryValue,
      direction: "LONG_SPOT_SHORT_PERP",
      action: "EXIT",
      packageOrderType: "MARKETABLE_LIMIT",
      packageTimeInForce: "IOC",
      partialFillPolicy: "EXACT_ALL_LEGS",
      quantity: { asset: config.baseAsset, atoms: open.perpQuantityAtoms },
      hyperliquidQuantityPolicy: "BOUNDED_NET",
      hyperliquidGrossSpotQuantity: { asset: config.baseAsset, atoms: spotSellAtoms },
      // HyperCore charges a spot sell's fee in quote, so the base delta is exactly the spot sold.
      hyperliquidMinNetSpotDelta: { asset: config.baseAsset, atoms: -spotSellAtoms },
      hyperliquidMaxNetSpotDelta: { asset: config.baseAsset, atoms: -spotSellAtoms },
      hyperliquidMaxTerminalResidualBaseQuantity: {
        asset: config.baseAsset, atoms: config.maxTerminalResidualBaseQuantityAtoms,
      },
      hyperliquidResidualValuationSchemaVersion: 1,
      hyperliquidResidualValuationReferencePrice: context.hyperliquidResidualValuationReferencePrice!,
      hyperliquidMaxTerminalResidualQuoteValue: {
        asset: config.quoteAsset, atoms: config.maxTerminalResidualQuoteValueAtoms,
      },
      expectedPreStrategySpotQuantity: { asset: config.baseAsset, atoms: open.spotQuantityAtoms },
      hyperliquidRecoveryExpiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS",
      hyperliquidMaxRecoveryActionExpiryValue: currentClock + config.recoveryActionExpiryTtlMs,
      hyperliquidRecoveryDeadlineValue: currentClock + config.recoveryDeadlineTtlMs,
      hyperliquidMinRecoveryWindowMs: config.minRecoveryWindowMs,
      hyperliquidMaxPerpBuyPrice: limits.maxPerpBuyPrice,
      maxRecoverySpotBuyPrice: context.maxRecoverySpotBuyPrice!,
      minRecoverySpotSellPrice: context.minRecoverySpotSellPrice!,
      minRecoveryPerpSellPrice: context.minRecoveryPerpSellPrice!,
      maxRecoveryPerpBuyPrice: context.maxRecoveryPerpBuyPrice!,
      exitOutcomeSchemaVersion: 1,
      entryReceiptHash: hash32(open.entryReceiptHash, "entryReceiptHash"),
      expectedPrePositionSize: { asset: config.baseAsset, atoms: -open.perpQuantityAtoms },
      expectedPrePositionEntryNotional: { asset: config.quoteAsset, atoms: open.entryNotionalAtoms },
      minExitQuoteOutcome: { asset: config.quoteAsset, atoms: limits.minExitQuoteOutcomeAtoms },
      minSpotQuoteOut: { asset: config.quoteAsset, atoms: limits.minSpotQuoteOutAtoms },
      maxMarginAdded: { asset: config.quoteAsset, atoms: 0n },
      minVenueReserveReturned: { asset: config.quoteAsset, atoms: config.minVenueReserveReturnedAtoms },
      minWalletQuoteBalanceDelta: { asset: config.quoteAsset, atoms: config.minWalletQuoteBalanceDeltaAtoms },
      maxVenueFeeAtomsByAsset: [...config.maxVenueFeeAtomsByAsset],
      maxProtocolFee: { asset: config.quoteAsset, atoms: config.maxProtocolFeeAtoms },
      maxSolverFee: { asset: config.quoteAsset, atoms: config.maxSolverFeeAtoms },
      maxPriorityFee: { asset: config.quoteAsset, atoms: config.maxPriorityFeeAtoms },
      maxRecoveryCostAtomsByAsset: [...config.maxRecoveryCostAtomsByAsset],
      permittedSpotAdapters: [config.spotAdapter],
      permittedPerpAdapters: [config.perpetualAdapter],
      settlementClass: "BATCHED_IOC_WITH_RECOVERY",
      maxAggregateRecoveryLossQuote: { asset: config.quoteAsset, atoms: config.maxAggregateRecoveryLossQuoteAtoms },
      maxResidualBaseQuantity: { asset: config.baseAsset, atoms: config.maxResidualBaseQuantityAtoms },
      allowedRecoveryActions: ["CANCEL_OPEN_ORDERS", "COMPLETE_SPOT", "COMPLETE_PERP", "ROLLBACK_SPOT", "ROLLBACK_PERP"],
    };
    const order = validatePackageOrderProfile(input, "packageOrder");
    const orderHash = packageOrderHash(input);
    const stored = options.orders.createOrGet({
      order: { order, orderBytes: packageOrderBytes(input), orderHash, requestCommitment },
      request: {
        contextId: config.contextId,
        owner: request.owner,
        settlementAccount: config.tradingAccount,
        sizeAtoms: open.perpQuantityAtoms,
        slippageBps: request.slippageBps,
        idempotencyKey: request.idempotencyKey,
        currentClock,
      },
    });
    options.ledger.bindExitOrder(open.entryAttemptId, request.owner, stored.record.orderHashHex);
    return Object.freeze({ ...stored, package: open });
  };
}

function packageView(entry: HyperliquidOwnerPackage) {
  const atoms = (value: bigint | null) => value === null ? null : value.toString();
  return {
    entryAttemptId: entry.entryAttemptId,
    entryOrderHash: entry.entryOrderHash,
    state: entry.state,
    perpQuantityAtoms: atoms(entry.perpQuantityAtoms),
    spotQuantityAtoms: atoms(entry.spotQuantityAtoms),
    exitSpotQuantityAtoms: atoms(entry.exitSpotQuantityAtoms),
    // Base-fee dust below one spot lot that the exit leaves in the shared trading account.
    retainedSpotDustAtoms: entry.exitSpotQuantityAtoms === null || entry.spotQuantityAtoms === null
      ? null : (entry.spotQuantityAtoms - entry.exitSpotQuantityAtoms).toString(),
    entryNotionalAtoms: atoms(entry.entryNotionalAtoms),
    entryReceiptHash: entry.entryReceiptHash,
    exitAttemptId: entry.exitAttemptId,
    openedAtMs: entry.openedAtMs,
    closedAtMs: entry.closedAtMs,
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new OwnerRouteError(400, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_BODY_BYTES) throw new OwnerRouteError(400, "BODY_TOO_LARGE", "Request body is too large.");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new OwnerRouteError(400, "INVALID_JSON", "Request body must contain valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OwnerRouteError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(body).sort().join(",") !== [...keys].sort().join(",")) {
    throw new OwnerRouteError(400, "INVALID_FIELDS", `Request must contain only ${keys.join(", ")}.`);
  }
}

export type HyperliquidTestnetOwnerRoutesOptions = Readonly<{
  tradingAccount: string;
  maxOpenPackagesPerOwner: number | null;
  /** Atom decimals of the package's base and quote assets, so the terminal can show sizes. */
  baseDecimals: number;
  quoteDecimals: number;
  ledger: HyperliquidTestnetOwnerLedger;
  intents: Pick<ExecutionIntentStore, "getAttempt"> & Partial<Pick<ExecutionIntentStore, "getAttemptForOrder">>;
  orders: Pick<InternalOrderStore, "getCanonicalOrderByHash">;
  strategyAttempts?: StrategyAttemptLookup;
  createExitOrder?: ReturnType<typeof createHyperliquidTestnetExitOrderFactory>;
  attemptStatus?: (request: HyperliquidTestnetTerminalExecutionRequest) => Promise<HyperliquidTestnetAttemptState>;
}>;

/**
 * Lane routes under the private server's one origin policy:
 * GET  account?owner=0x...                       the wallet's packages in the shared account
 * POST authorization {attemptId}                 the typed data the owner signs
 * POST authorize {attemptId, signature}          records the owner's signature
 * POST exit-order {owner, slippageBps, idempotencyKey}
 * POST attempt-status {attemptId, idempotencyKey}
 */
export function createHyperliquidTestnetOwnerRoutes(
  options: HyperliquidTestnetOwnerRoutesOptions,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  const cashOrder = (binding: AttemptBinding): PackageOrder => {
    if (binding.order === null) {
      throw new OwnerRouteError(
        409,
        "STRATEGY_AUTHORIZATION_REQUIRED",
        "Generalized strategies use the strategy package authorization endpoint.",
      );
    }
    return binding.order;
  };
  const typedDataFor = (binding: AttemptBinding) => {
    const order = cashOrder(binding);
    return hyperliquidTestnetAuthorizationTypedData({
      orderHash: binding.orderHash,
      action: order.action,
      owner: order.owner,
      tradingAccount: options.tradingAccount,
    });
  };
  const handlers: Readonly<Record<string, (request: IncomingMessage, url: URL) => Promise<unknown>>> = {
    [HYPERLIQUID_TESTNET_ACCOUNT_PATH]: async (request, url) => {
      if (request.method !== "GET") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
      const owner = url.searchParams.get("owner") ?? "";
      if ([...url.searchParams.keys()].join(",") !== "owner" || !HYPERLIQUID_TESTNET_OWNER_PATTERN.test(owner)) {
        throw new OwnerRouteError(400, "INVALID_OWNER", "Query must contain only a lowercase nonzero owner address.");
      }
      return {
        version: 1,
        owner,
        tradingAccount: options.tradingAccount,
        executionModel: "OMNIBUS_TESTNET_ACCOUNT",
        maxOpenPackagesPerOwner: options.maxOpenPackagesPerOwner,
        baseDecimals: options.baseDecimals,
        quoteDecimals: options.quoteDecimals,
        packages: options.ledger.packages(owner).map(packageView),
      };
    },
    [HYPERLIQUID_TESTNET_AUTHORIZATION_PATH]: async (request) => {
      if (request.method !== "POST") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      const body = await readJson(request);
      exactKeys(body, ["attemptId"]);
      const binding = attemptBinding(String(body.attemptId), options.intents, options.orders, options.strategyAttempts);
      return { attemptId: binding.attemptId, orderHash: binding.orderHash, typedData: typedDataFor(binding) };
    },
    [HYPERLIQUID_TESTNET_AUTHORIZE_PATH]: async (request) => {
      if (request.method !== "POST") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      const body = await readJson(request);
      exactKeys(body, ["attemptId", "signature"]);
      const binding = attemptBinding(String(body.attemptId), options.intents, options.orders, options.strategyAttempts);
      const order = cashOrder(binding);
      const signature = String(body.signature).toLowerCase();
      if (!await verifyHyperliquidTestnetAuthorization({
        orderHash: binding.orderHash, action: order.action,
        owner: order.owner, tradingAccount: options.tradingAccount,
      }, signature)) {
        throw new OwnerRouteError(400, "INVALID_SIGNATURE", "The signature is not the package owner's authorization.");
      }
      options.ledger.recordAuthorization(binding.orderHash, order.owner, signature);
      return { status: "OWNER_AUTHORIZED", attemptId: binding.attemptId, orderHash: binding.orderHash, owner: order.owner };
    },
    [HYPERLIQUID_TESTNET_EXIT_ORDER_PATH]: async (request) => {
      if (request.method !== "POST") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      if (options.createExitOrder === undefined) {
        throw new OwnerRouteError(503, "EXIT_UNAVAILABLE", "Hyperliquid testnet exits are unavailable.");
      }
      const body = await readJson(request);
      exactKeys(body, ["idempotencyKey", "owner", "slippageBps"]);
      if (typeof body.owner !== "string" || typeof body.idempotencyKey !== "string"
        || typeof body.slippageBps !== "number") {
        throw new OwnerRouteError(400, "INVALID_FIELDS", "owner, slippageBps, and idempotencyKey are required.");
      }
      const created = await options.createExitOrder({
        owner: body.owner, slippageBps: body.slippageBps, idempotencyKey: body.idempotencyKey,
      });
      return {
        status: "UNSIGNED_CREATED",
        created: created.created,
        order: created.record,
        package: packageView(created.package),
        executionModel: "OMNIBUS_TESTNET_ACCOUNT",
      };
    },
    [HYPERLIQUID_TESTNET_ATTEMPT_STATUS_PATH]: async (request) => {
      if (request.method !== "POST") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      if (options.attemptStatus === undefined) {
        throw new OwnerRouteError(503, "EXECUTION_UNAVAILABLE", "Hyperliquid testnet execution is unavailable.");
      }
      const identity = parseHyperliquidTestnetTerminalExecutionRequest(await readJson(request));
      const status = await options.attemptStatus(identity);
      return { ...identity, ...status };
    },
  };

  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://private-terminal.local");
    const handler = handlers[url.pathname];
    if (handler === undefined) return false;
    void handler(request, url).then(
      (body) => send(response, 200, body),
      (error: unknown) => {
        if (error instanceof OwnerRouteError) {
          send(response, error.status, { error: { code: error.code, message: error.message } });
        } else if (error instanceof HyperliquidTestnetTerminalValidationError) {
          send(response, error.code === "ATTEMPT_NOT_FOUND" ? 404 : 400, { error: { code: error.code, message: error.message } });
        } else if (error instanceof HyperliquidOwnerLedgerError) {
          send(response, error.code === "NO_OPEN_PACKAGE" ? 404 : 409, { error: { code: error.code, message: error.message } });
        } else {
          send(response, 502, { error: { code: "HYPERLIQUID_OWNER_ROUTE_FAILED", message: "Hyperliquid owner route failed closed." } });
        }
      },
    );
    return true;
  };
}
