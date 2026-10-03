import type { IncomingMessage, ServerResponse } from "node:http";
import {
  NARYX_TEST_PERP_MARKET_ABI,
  PACKAGE_VERIFIER_ACCOUNT_ABI,
  equalAddress,
  packageVerifierOpenPackage,
  requiredEvmAddress,
  testPerpCloseSettlement,
  testPerpFeeWad,
  type TestPerpMarketParameters,
  type TestPerpPositionState,
} from "@naryx/adapter-evm";
import { scaleDecimals } from "@naryx/protocol-types";
import type { Address } from "viem";
import {
  resolveBaseSepoliaStrategyAccount,
  type BaseSepoliaAtomicDeploymentConfiguration,
} from "./base-sepolia-atomic-context-provider.js";
import {
  baseSepoliaSpotQuoteTarget,
  type BaseSepoliaMarketSnapshot,
  type BaseSepoliaOrderReadPort,
  type BaseSepoliaOrderRuntime,
} from "./base-sepolia-order-context.js";
import { createCanonicalExitOrder, EntryOrderValidationError } from "./canonical-entry-order.js";
import {
  InternalOrderConflictError,
  type InternalOrderCreateResult,
  type InternalOrderStore,
} from "./internal-order-store.js";
import { BASE_SEPOLIA_CHAIN_REFERENCE, EvmTestnetTerminalValidationError } from "./evm-testnet-runtime-ports.js";
import { isAllowedTerminalOrigin, type TerminalOrigins } from "./terminal-origin.js";
import { quoteUniswapV3Sell } from "./uniswap-v3-quoter.js";

export const BASE_SEPOLIA_EXIT_ORDER_PATH = "/internal/terminal/base-sepolia/exit-order";

const BPS = 10_000n;
const FEE_SCALE = 1_000_000n;
const Q192 = 1n << 192n;
const MAX_BODY_BYTES = 1_024;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;

/** Exit limits from live state, in integer atoms, every one rounded against the trader. */
export type BaseSepoliaExitLimits = Readonly<{
  quantityAtoms: bigint;
  /** The open package's entry notional floored to quote atoms, as the order commits it. */
  entryNotionalAtoms: bigint;
  minSpotQuoteOutAtoms: bigint;
  minExitQuoteOutcomeAtoms: bigint;
}>;

export class BaseSepoliaExitOrderError extends EvmTestnetTerminalValidationError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "BaseSepoliaExitOrderError";
  }
}

function fail(code: string, message: string): never {
  throw new BaseSepoliaExitOrderError(code, message);
}

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator % denominator !== 0n && (numerator < 0n) !== (denominator < 0n) ? quotient - 1n : quotient;
}

/**
 * Exit minimums for the owner's open package. The spot leg sells the exact base through the pinned
 * Uniswap pool, so its floor is the lower of the slot0 mid less the pool fee and the quoter's
 * executable proceeds for exactly that base (price impact included), less the trader's slippage,
 * rounded down. The outcome is exitQuoteOutcome v1, the wallet-side quote delta
 * plus the venue-side delta: that spot floor plus what the close credits to the reserve less the
 * position margin, with the market's own buy-back notional moved against the trader by the same
 * slippage and the taker fee at that notional, rounded down and floored at zero.
 */
export function baseSepoliaExitLimits(input: Readonly<{
  quantityAtoms: bigint;
  quoteDecimals: number;
  pool: Pick<BaseSepoliaMarketSnapshot, "sqrtPriceX96" | "baseIsToken0" | "poolFee">;
  /** The quoter's proceeds for an exact-input sale of exactly `quantityAtoms`. */
  spotQuoteOutAtoms: bigint;
  position: TestPerpPositionState;
  entryPerpNotionalWad: bigint;
  previewCloseNotionalWad: bigint;
  currentFundingIndex: bigint;
  market: TestPerpMarketParameters;
  slippageBps: number;
}>): BaseSepoliaExitLimits {
  const { quantityAtoms, pool, position, market } = input;
  if (typeof quantityAtoms !== "bigint" || quantityAtoms <= 0n) fail("INVALID_EXIT", "Open package quantity is invalid.");
  if (position.sizeWad !== -quantityAtoms || position.entryNotionalWad !== input.entryPerpNotionalWad) {
    fail("PERP_POSITION_MISMATCH", "The test perpetual position is not the open package's exact short.");
  }
  if (!Number.isSafeInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps >= 10_000) {
    fail("INVALID_SLIPPAGE", "Slippage must be a positive integer below 10000 bps.");
  }
  if (pool.sqrtPriceX96 <= 0n || pool.poolFee < 0n || pool.poolFee >= FEE_SCALE) fail("MARKET_INVALID", "Uniswap pool state is invalid.");
  if (input.previewCloseNotionalWad <= 0n) fail("MARKET_INVALID", "Market buy-back preview is invalid.");
  if (typeof input.spotQuoteOutAtoms !== "bigint" || input.spotQuoteOutAtoms <= 0n) {
    fail("MARKET_INVALID", "Uniswap quoter proceeds are invalid.");
  }
  const slippage = BigInt(input.slippageBps);
  const squared = pool.sqrtPriceX96 * pool.sqrtPriceX96;
  const [midNumerator, midDenominator] = pool.baseIsToken0 ? [squared, Q192] : [Q192, squared];
  // The lower of the mid figure and the quoted proceeds, compared as exact fractions.
  const midNumeratorOut = quantityAtoms * midNumerator * (FEE_SCALE - pool.poolFee);
  const midDenominatorOut = midDenominator * FEE_SCALE;
  const [spotNumerator, spotDenominator] = input.spotQuoteOutAtoms * midDenominatorOut < midNumeratorOut
    ? [input.spotQuoteOutAtoms, 1n]
    : [midNumeratorOut, midDenominatorOut];
  const minSpotQuoteOutAtoms = (spotNumerator * (BPS - slippage)) / (spotDenominator * BPS);
  if (minSpotQuoteOutAtoms <= 0n) fail("EXIT_TOO_SMALL", "The exit's spot proceeds round to zero.");
  const entryNotionalAtoms = scaleDecimals(input.entryPerpNotionalWad, 18, input.quoteDecimals, "FLOOR", "entryNotionalAtoms");
  if (entryNotionalAtoms <= 0n) fail("INVALID_EXIT", "Open package entry notional is invalid.");
  const worstCloseNotionalWad = (input.previewCloseNotionalWad * (BPS + slippage) + BPS - 1n) / BPS;
  const close = testPerpCloseSettlement({
    position,
    exitNotionalWad: worstCloseNotionalWad,
    feeWad: testPerpFeeWad(worstCloseNotionalWad, market),
    currentFundingIndex: input.currentFundingIndex,
    collateralScale: market.collateralScale,
  });
  const outcome = minSpotQuoteOutAtoms + floorDiv(close.payoutWad - position.balanceWad, market.collateralScale);
  return Object.freeze({
    quantityAtoms,
    entryNotionalAtoms,
    minSpotQuoteOutAtoms,
    minExitQuoteOutcomeAtoms: outcome > 0n ? outcome : 0n,
  });
}

export type BaseSepoliaExitOrderRequest = Readonly<{ owner: string; slippageBps: number; idempotencyKey: string }>;

export type BaseSepoliaExitOrderService = Readonly<{
  createExitOrder(request: BaseSepoliaExitOrderRequest): Promise<InternalOrderCreateResult & Readonly<{ quantityAtoms: bigint }>>;
}>;

/**
 * Builds and stores the canonical EXIT order for the owner's open package. Every input comes from
 * chain: the factory account, the verifier's open package record, the market position, the pool,
 * and the market's own preview of the buy-back. No open package fails closed.
 */
export function createBaseSepoliaExitOrderService(input: Readonly<{
  runtime: Pick<BaseSepoliaOrderRuntime, "contexts" | "feed" | "config">;
  deployment: BaseSepoliaAtomicDeploymentConfiguration;
  port: BaseSepoliaOrderReadPort;
  orders: Pick<InternalOrderStore, "createOrGet">;
}>): BaseSepoliaExitOrderService {
  const { runtime, port, orders } = input;
  const identity = input.deployment.deployment;
  const config = runtime.config;
  const verifier = requiredEvmAddress(identity.packageVerifier.address, "packageVerifier");
  const market = requiredEvmAddress(identity.perpetual.market.address, "perpetual.market");
  const baseToken = requiredEvmAddress(identity.baseAsset.address, "baseAsset");
  const quoteToken = requiredEvmAddress(identity.quoteAsset.address, "quoteAsset");
  const readMarket = (functionName: string, args?: readonly unknown[]) => port.readContract({
    address: market, abi: NARYX_TEST_PERP_MARKET_ABI, functionName, ...(args === undefined ? {} : { args }),
  });

  async function createExitOrder(request: BaseSepoliaExitOrderRequest) {
    if (!Number.isSafeInteger(request.slippageBps) || request.slippageBps < 1 || request.slippageBps > config.maxSlippageBps) {
      fail("INVALID_SLIPPAGE", "Slippage is outside the reviewed limit.");
    }
    if (await port.chainId() !== BigInt(BASE_SEPOLIA_CHAIN_REFERENCE)) {
      fail("WRONG_CHAIN", "Base Sepolia RPC eth_chainId is not 84532.");
    }
    const resolved = await resolveBaseSepoliaStrategyAccount(port, identity, request.owner);
    if (!resolved.deployed) fail("NO_OPEN_PACKAGE", "The owner has no strategy account, so no open package.");
    const account: Address = resolved.account;
    const open = packageVerifierOpenPackage(await port.readContract({
      address: verifier, abi: PACKAGE_VERIFIER_ACCOUNT_ABI, functionName: "openPackage", args: [account],
    }));
    if (open === null) fail("NO_OPEN_PACKAGE", "The strategy account has no open package to exit.");
    const expiry = Number(await readMarket("expiry"));
    if (!equalAddress(open.perpInstrument, market) || open.perpExpiry !== expiry
      || !equalAddress(open.baseToken, baseToken) || !equalAddress(open.quoteToken, quoteToken)
      || open.baseQuantityAtoms !== open.perpQuantityWad) {
      fail("OPEN_PACKAGE_MISMATCH", "The open package is not on the reviewed Base Sepolia market.");
    }
    const snapshot = await runtime.feed.refresh();
    const [rawPosition, preview, fundingIndex, collateralScale, takerFeeBps, initialMarginBps, spotQuoteOutAtoms] = await Promise.all([
      readMarket("getPosition", [market, expiry, account]),
      readMarket("previewOpen", [open.baseQuantityAtoms, 0n]),
      readMarket("currentFundingIndex"),
      readMarket("collateralScale"),
      readMarket("takerFeeBps"),
      readMarket("initialMarginBps"),
      quoteUniswapV3Sell(
        port,
        baseSepoliaSpotQuoteTarget(config, input.deployment, snapshot.poolFee),
        open.baseQuantityAtoms,
      ),
    ]);
    const position = rawPosition as Record<string, unknown> | undefined;
    const previewNotional = (preview as readonly unknown[] | undefined)?.[1];
    if (typeof position?.balance !== "bigint" || typeof position.size !== "bigint"
      || typeof position.entryNotional !== "bigint" || typeof position.entryFundingIndex !== "bigint"
      || typeof previewNotional !== "bigint" || typeof fundingIndex !== "bigint" || typeof collateralScale !== "bigint"
      || collateralScale !== 10n ** BigInt(18 - config.quoteAsset.decimals)) {
      fail("MARKET_INVALID", "Test perpetual reads are malformed.");
    }
    const limits = baseSepoliaExitLimits({
      quantityAtoms: open.baseQuantityAtoms,
      quoteDecimals: config.quoteAsset.decimals,
      pool: snapshot,
      spotQuoteOutAtoms,
      position: {
        balanceWad: position.balance,
        sizeWad: position.size,
        entryNotionalWad: position.entryNotional,
        entryFundingIndex: position.entryFundingIndex,
      },
      entryPerpNotionalWad: open.entryPerpNotionalWad,
      previewCloseNotionalWad: previewNotional,
      currentFundingIndex: fundingIndex,
      market: {
        takerFeeBps: BigInt(Number(takerFeeBps)),
        initialMarginBps: BigInt(Number(initialMarginBps)),
        collateralScale,
      },
      slippageBps: request.slippageBps,
    });
    const currentClock = await port.latestBlockTimestamp();
    const order = createCanonicalExitOrder(runtime.contexts, {
      contextId: config.contextId,
      owner: resolved.owner,
      settlementAccount: account,
      entryReceiptHash: Uint8Array.from(Buffer.from(open.entryReceiptHash.slice(2), "hex")),
      positionSizeAtoms: limits.quantityAtoms,
      positionEntryNotionalAtoms: limits.entryNotionalAtoms,
      minSpotQuoteOutAtoms: limits.minSpotQuoteOutAtoms,
      minExitQuoteOutcomeAtoms: limits.minExitQuoteOutcomeAtoms,
      idempotencyKey: request.idempotencyKey,
      currentClock,
    });
    const stored = orders.createOrGet({
      order,
      request: Object.freeze({
        contextId: config.contextId,
        owner: resolved.owner,
        settlementAccount: account,
        sizeAtoms: limits.quantityAtoms,
        slippageBps: request.slippageBps,
        idempotencyKey: request.idempotencyKey,
        currentClock,
      }),
    });
    return Object.freeze({ ...stored, quantityAtoms: limits.quantityAtoms });
  }

  return Object.freeze({ createExitOrder });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

function reject(response: ServerResponse, status: number, code: string, message: string): void {
  send(response, status, { error: { code, message } });
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new BaseSepoliaExitOrderError("INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) throw new BaseSepoliaExitOrderError("BODY_TOO_LARGE", "Request body is too large.");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new BaseSepoliaExitOrderError("INVALID_JSON", "Request body must contain valid JSON.");
  }
}

/**
 * POST /internal/terminal/base-sepolia/exit-order {owner, slippageBps, idempotencyKey}, under the
 * same exact-origin browser policy as the private terminal routes.
 */
export function createBaseSepoliaExitOrderRoutes(input: Readonly<{
  terminalOrigin: TerminalOrigins;
  service: BaseSepoliaExitOrderService;
}>): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://private-terminal.local");
    if (url.pathname !== BASE_SEPOLIA_EXIT_ORDER_PATH) return false;
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (!isAllowedTerminalOrigin(input.terminalOrigin, origin)) {
        reject(response, 403, "ORIGIN_NOT_ALLOWED", "Browser origin is not allowed.");
        return true;
      }
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      if (origin === undefined) {
        reject(response, 403, "ORIGIN_REQUIRED", "Preflight requires an allowed browser origin.");
      } else {
        response.statusCode = 204;
        response.end();
      }
      return true;
    }
    if (request.method !== "POST" || url.search !== "") {
      response.setHeader("Allow", "POST, OPTIONS");
      reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      return true;
    }
    void (async () => {
      try {
        const body = await readBody(request) as Record<string, unknown> | null;
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).sort().join(",") !== "idempotencyKey,owner,slippageBps"
          || typeof body.owner !== "string" || typeof body.slippageBps !== "number"
          || typeof body.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(body.idempotencyKey)) {
          reject(response, 400, "INVALID_FIELDS", "Request must contain only owner, slippageBps, and idempotencyKey.");
          return;
        }
        const result = await input.service.createExitOrder({
          owner: body.owner,
          slippageBps: body.slippageBps,
          idempotencyKey: body.idempotencyKey,
        });
        send(response, result.created ? 201 : 200, {
          status: "UNSIGNED_CREATED",
          created: result.created,
          order: result.record,
          quantityAtoms: result.quantityAtoms.toString(),
          traderAuthorization: "REQUIRED",
          solverQuoting: "REQUIRED",
        });
      } catch (error) {
        if (error instanceof InternalOrderConflictError) {
          reject(response, 409, error.code, error.message);
        } else if (error instanceof EvmTestnetTerminalValidationError || error instanceof EntryOrderValidationError) {
          const conflict = error.code === "NO_OPEN_PACKAGE" || error.code === "INSUFFICIENT_LIQUIDITY";
          reject(response, conflict ? 409 : 400, error.code, error.message);
        } else {
          reject(response, 502, "EXIT_ORDER_FAILED", "Base Sepolia exit order creation failed closed.");
        }
      }
    })();
    return true;
  };
}
