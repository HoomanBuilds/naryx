import { requiredEvmAddress } from "@naryx/adapter-evm";
import { encodeAbiParameters, hashTypedData, keccak256, parseAbi, type Address, type Hex } from "viem";
import {
  arbitrumSepoliaAccountOf,
  type ArbitrumSepoliaAsyncDeploymentConfiguration,
} from "./arbitrum-sepolia-async-context-provider.js";
import { ArbitrumSepoliaMarketFeed, gmxPositionFeeFactorKey } from "./arbitrum-sepolia-market-source.js";
import {
  arbitrumSepoliaSpotQuoteTarget,
  type ArbitrumSepoliaOrderRuntime,
  type ArbitrumSepoliaPriceReadPort,
  type ArbitrumSepoliaReferencePriceSnapshot,
} from "./arbitrum-sepolia-order-context.js";
import { createCanonicalExitOrder } from "./canonical-entry-order.js";
import type { InternalOrderCreateResult, InternalOrderStore } from "./internal-order-store.js";
import { quoteUniswapV3Sell } from "./uniswap-v3-quoter.js";

const BPS = 10_000n;
const POOL_FEE_SCALE = 1_000_000n;
const GMX_FLOAT_PRECISION = 10n ** 30n;
const GMX_USD_DECIMALS = 30;
const Q192 = 2n ** 192n;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/;
const ENTRY_EXECUTED = 2;
export const ARBITRUM_EXIT_EIP712_NAME = "Naryx GMX V2 Exit";

const ADAPTER_ABI = parseAbi([
  "function activePackageOf(address account) view returns (bytes32)",
  "function activeRequestKeyOf(address account) view returns (bytes32)",
  "function requestEvidence(bytes32 requestKey) view returns (uint8 status, bytes32 evidenceHash, uint256 positionSizeBefore, uint256 positionSizeAfter, uint64 revision)",
]);
const ACCOUNT_ABI = parseAbi([
  "struct SpotEntryRegistration { bytes32 packageId; bytes32 requestPayloadHash; address fundingOwner; address port; bytes32 portCodeHash; address baseToken; address quoteToken; uint256 packageNonce; bytes32 orderHash; bytes32 quoteHash; bytes32 routeHash; bytes32 entryFillCommitment; bytes32 rollbackFillCommitment; uint256 baseAtoms; uint256 maxQuoteAtoms; uint256 rollbackMinQuoteAtoms; }",
  "function positionSize(bool isLong) view returns (uint256)",
  "function hasActiveSpotInventory() view returns (bool)",
  "function activeSpotRequestKey() view returns (bytes32)",
  "function activeSpotRegistration() view returns (SpotEntryRegistration)",
]);
const EXIT_CONTROLLER_ABI = parseAbi(["function activeExitRequestKey(address account) view returns (bytes32)"]);
const DATA_STORE_ABI = parseAbi(["function getUint(bytes32 key) view returns (uint256)"]);

/** The EIP-712 fields of `GmxV2ExitController.ExitAuthorization`, in its typehash order. */
export const ARBITRUM_EXIT_AUTHORIZATION_FIELDS = Object.freeze([
  ["packageId", "bytes32"], ["entryRequestKey", "bytes32"], ["spotRegistrationHash", "bytes32"],
  ["account", "address"], ["owner", "address"], ["receiver", "address"], ["spotProceedsRecipient", "address"],
  ["feePayer", "address"], ["executionFeeRefundRecipient", "address"], ["market", "address"],
  ["collateralToken", "address"], ["isLong", "bool"], ["fullCloseSizeUsd", "uint256"], ["spotBaseAtoms", "uint256"],
  ["spotMinQuoteAtoms", "uint256"], ["packageNonce", "uint256"], ["exitOrderHash", "bytes32"],
  ["exitQuoteHash", "bytes32"], ["exitRouteHash", "bytes32"], ["exitFillCommitment", "bytes32"],
  ["acceptablePrice", "uint256"], ["minOutputAmount", "uint256"], ["executionFeeWei", "uint256"],
  ["callbackGasLimit", "uint256"], ["authorizationExpiry", "uint64"], ["cancelAfter", "uint64"], ["nonce", "uint256"],
] as const);

export class ArbitrumSepoliaExitError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArbitrumSepoliaExitError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ArbitrumSepoliaExitError(code, message);
}

function stringKey(name: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }], [name]));
}

/** GMX `keccak256(abi.encode(account, market, collateralToken, isLong))` position field key. */
export function gmxShortPositionKey(account: Address, market: Address, collateralToken: Address, field: string): Hex {
  const positionKey = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "bool" }],
    [account, market, collateralToken, false],
  ));
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [positionKey, stringKey(field)]));
}

function hashValue(value: unknown, name: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail("CHAIN_MISMATCH", `${name} is invalid.`);
  return value.toLowerCase() as Hex;
}

function uintValue(value: unknown, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n) fail("CHAIN_MISMATCH", `${name} is invalid.`);
  return value;
}

/** The owner's open package as the adapter, the account, and the exit controller report it. */
export type ArbitrumSepoliaOpenPackage = Readonly<{
  packageId: Hex;
  entryRequestKey: Hex | null;
  entryExecuted: boolean;
  positionSizeUsd: bigint;
  spotBaseAtoms: bigint;
  /** An exit already submitted and not yet terminal; a second exit waits for it. */
  activeExitRequestKey: Hex | null;
  exitable: boolean;
}>;

/** Signerless reads; null when the owner's account holds no package. */
export async function readArbitrumSepoliaOpenPackage(
  port: Pick<ArbitrumSepoliaPriceReadPort, "readContract">,
  deployment: ArbitrumSepoliaAsyncDeploymentConfiguration,
  owner: Address,
): Promise<ArbitrumSepoliaOpenPackage | null> {
  const account = arbitrumSepoliaAccountOf(deployment, owner);
  const adapter = requiredEvmAddress(deployment.entryAdapter.address, "entryAdapter");
  const read = (address: Address, abi: typeof ADAPTER_ABI | typeof ACCOUNT_ABI | typeof EXIT_CONTROLLER_ABI, functionName: string, args?: readonly unknown[]) =>
    port.readContract({ address, abi, functionName, ...(args === undefined ? {} : { args }) });
  const packageId = hashValue(await read(adapter, ADAPTER_ABI, "activePackageOf", [account]), "active package");
  if (packageId === ZERO_HASH) return null;
  const requestKey = hashValue(await read(adapter, ADAPTER_ABI, "activeRequestKeyOf", [account]), "active request key");
  if (requestKey === ZERO_HASH) {
    // Funded but not yet submitted: there is nothing on GMX to close.
    return Object.freeze({
      packageId, entryRequestKey: null, entryExecuted: false, positionSizeUsd: 0n, spotBaseAtoms: 0n,
      activeExitRequestKey: null, exitable: false,
    });
  }
  const exitController = deployment.exitController === undefined
    ? undefined
    : requiredEvmAddress(deployment.exitController.address, "exitController");
  const [evidence, shortSize, longSize, hasSpot, spotRequestKey, registration, activeExit] = await Promise.all([
    read(adapter, ADAPTER_ABI, "requestEvidence", [requestKey]),
    read(account, ACCOUNT_ABI, "positionSize", [false]),
    read(account, ACCOUNT_ABI, "positionSize", [true]),
    read(account, ACCOUNT_ABI, "hasActiveSpotInventory"),
    read(account, ACCOUNT_ABI, "activeSpotRequestKey"),
    read(account, ACCOUNT_ABI, "activeSpotRegistration"),
    exitController === undefined ? Promise.resolve(ZERO_HASH) : read(exitController, EXIT_CONTROLLER_ABI, "activeExitRequestKey", [account]),
  ]);
  const record = evidence as readonly unknown[];
  const spot = registration as { packageId?: unknown; baseAtoms?: unknown };
  const positionSizeUsd = uintValue(shortSize, "short position size");
  const entryExecuted = Number(record[0]) === ENTRY_EXECUTED;
  const exitKey = hashValue(activeExit, "active exit request key");
  const spotBaseAtoms = hasSpot === true ? uintValue(spot.baseAtoms, "spot base atoms") : 0n;
  const consistent = entryExecuted && positionSizeUsd > 0n && uintValue(record[3], "entry position size") === positionSizeUsd
    && uintValue(longSize, "long position size") === 0n && hasSpot === true
    && hashValue(spotRequestKey, "spot request key") === requestKey
    && hashValue(spot.packageId, "spot package") === packageId && spotBaseAtoms > 0n;
  return Object.freeze({
    packageId,
    entryRequestKey: requestKey,
    entryExecuted,
    positionSizeUsd,
    spotBaseAtoms,
    activeExitRequestKey: exitKey === ZERO_HASH ? null : exitKey,
    exitable: consistent && exitKey === ZERO_HASH && exitController !== undefined,
  });
}

export type ArbitrumSepoliaExitPosition = Readonly<{
  quantityAtoms: bigint;
  sizeInUsd: bigint;
  sizeInTokens: bigint;
  collateralAtoms: bigint;
}>;

export type ArbitrumSepoliaExitLimits = Readonly<{
  quantityAtoms: bigint;
  entryNotionalAtoms: bigint;
  minSpotQuoteOutAtoms: bigint;
  minPerpOutputAtoms: bigint;
  minExitQuoteOutcomeAtoms: bigint;
}>;

/**
 * Exit minimums, every amount rounded against the trader. The spot leg must return at least the
 * lower of the pool mid and the reference price less the pool fee, and of the quoter's executable
 * proceeds for exactly that base (price impact included), less the trader's slippage. The
 * GMX decrease, which pays collateral plus the short's PnL less fees to the owner, must return at
 * least its value with the short bought back at the reference plus slippage, less the larger
 * position fee factor; the slippage is applied once more to that value as the allowance for
 * borrowing and funding fees accrued since entry and for the USDC oracle. The exit outcome is the
 * sum of both legs paid to the owner.
 */
export function arbitrumSepoliaExitLimits(input: Readonly<{
  position: ArbitrumSepoliaExitPosition;
  baseDecimals: number;
  quoteDecimals: number;
  reference: Pick<ArbitrumSepoliaReferencePriceSnapshot, "answer" | "decimals">;
  pool: Readonly<{ sqrtPriceX96: bigint; baseIsToken0: boolean; poolFee: bigint }>;
  /** The quoter's proceeds for an exact-input sale of exactly `position.quantityAtoms`. */
  spotQuoteOutAtoms: bigint;
  positionFeeFactor: bigint;
  slippageBps: number;
}>): ArbitrumSepoliaExitLimits {
  const { position, reference, pool } = input;
  const slippage = BigInt(input.slippageBps);
  if (!Number.isSafeInteger(input.slippageBps) || slippage < 1n || slippage >= BPS
    || position.quantityAtoms <= 0n || position.sizeInUsd <= 0n || position.sizeInTokens <= 0n
    || position.collateralAtoms < 0n || reference.answer <= 0n || pool.sqrtPriceX96 <= 0n
    || pool.poolFee < 0n || pool.poolFee >= POOL_FEE_SCALE
    || typeof input.spotQuoteOutAtoms !== "bigint" || input.spotQuoteOutAtoms <= 0n
    || input.positionFeeFactor < 0n || input.positionFeeFactor >= GMX_FLOAT_PRECISION
    || input.quoteDecimals < 0 || input.quoteDecimals > GMX_USD_DECIMALS) {
    fail("INVALID_EXIT", "Exit pricing inputs are invalid.");
  }
  const usdScale = 10n ** BigInt(GMX_USD_DECIMALS - input.quoteDecimals);
  if (position.sizeInUsd % usdScale !== 0n) fail("INVALID_EXIT", "Position size is not an exact quote-atom amount.");
  // Quote atoms per base atom as numerator over denominator.
  const referenceNumerator = reference.answer * 10n ** BigInt(input.quoteDecimals);
  const referenceDenominator = 10n ** BigInt(reference.decimals + input.baseDecimals);
  const squared = pool.sqrtPriceX96 * pool.sqrtPriceX96;
  const [poolNumerator, poolDenominator] = pool.baseIsToken0 ? [squared, Q192] : [Q192, squared];
  const [numerator, denominator] = poolNumerator * referenceDenominator < referenceNumerator * poolDenominator
    ? [poolNumerator, poolDenominator]
    : [referenceNumerator, referenceDenominator];
  const priceNumeratorOut = position.quantityAtoms * numerator * (POOL_FEE_SCALE - pool.poolFee);
  const priceDenominatorOut = denominator * POOL_FEE_SCALE;
  const [spotNumerator, spotDenominator] = input.spotQuoteOutAtoms * priceDenominatorOut < priceNumeratorOut
    ? [input.spotQuoteOutAtoms, 1n]
    : [priceNumeratorOut, priceDenominatorOut];
  const minSpotQuoteOutAtoms = (spotNumerator * (BPS - slippage)) / (spotDenominator * BPS);
  if (minSpotQuoteOutAtoms <= 0n) fail("INVALID_EXIT", "The spot leg's minimum proceeds round to zero.");

  // GMX prices are USD per base atom with 30 decimals; the buy-back price rounds up.
  const priceDenominator = 10n ** BigInt(reference.decimals + input.baseDecimals) * BPS;
  const worstPrice = (reference.answer * GMX_FLOAT_PRECISION * (BPS + slippage) + priceDenominator - 1n) / priceDenominator;
  const pnlUsd = position.sizeInUsd - position.sizeInTokens * worstPrice;
  const closeFeeUsd = (position.sizeInUsd * input.positionFeeFactor + GMX_FLOAT_PRECISION - 1n) / GMX_FLOAT_PRECISION;
  const valueUsd = position.collateralAtoms * usdScale + pnlUsd - closeFeeUsd;
  const minPerpOutputAtoms = valueUsd <= 0n ? 0n : (valueUsd * (BPS - slippage)) / (BPS * usdScale);
  if (minPerpOutputAtoms <= 0n) {
    fail("POSITION_UNDERWATER", "The short's worst-case close output is not positive; it cannot be exited with this slippage.");
  }
  return Object.freeze({
    quantityAtoms: position.quantityAtoms,
    entryNotionalAtoms: position.sizeInUsd / usdScale,
    minSpotQuoteOutAtoms,
    minPerpOutputAtoms,
    minExitQuoteOutcomeAtoms: minSpotQuoteOutAtoms + minPerpOutputAtoms,
  });
}

export type ArbitrumSepoliaExitOrderResult = InternalOrderCreateResult & Readonly<{
  packageId: Hex;
  limits: ArbitrumSepoliaExitLimits;
}>;

/**
 * Builds and stores the canonical EXIT order for the owner's open package. The order binds the entry
 * package id as its entry receipt provenance and the exact open short and spot inventory as its
 * expected pre-position, both read from chain.
 */
export async function createArbitrumSepoliaExitOrder(input: Readonly<{
  deployment: ArbitrumSepoliaAsyncDeploymentConfiguration;
  port: ArbitrumSepoliaPriceReadPort;
  runtime: ArbitrumSepoliaOrderRuntime;
  orders: Pick<InternalOrderStore, "createOrGet">;
  owner: Address;
  slippageBps: number;
  idempotencyKey: string;
}>): Promise<ArbitrumSepoliaExitOrderResult> {
  const { deployment, port, runtime, owner } = input;
  const config = runtime.config;
  if (!Number.isSafeInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > config.maxSlippageBps) {
    fail("EXCESS_SLIPPAGE", "Slippage is out of bounds.");
  }
  const open = await readArbitrumSepoliaOpenPackage(port, deployment, owner);
  if (open === null || !open.exitable) {
    fail("NO_EXITABLE_PACKAGE", open?.activeExitRequestKey ? "An exit for this package is already in progress."
      : "The owner has no executed open package to exit.");
  }
  const account = arbitrumSepoliaAccountOf(deployment, owner);
  const market = requiredEvmAddress(deployment.market.address, "market");
  const collateral = requiredEvmAddress(deployment.collateralToken.address, "collateralToken");
  const dataStore = requiredEvmAddress(deployment.gmx.dataStore.address, "gmx.dataStore");
  const getUint = async (key: Hex, name: string) => uintValue(
    await port.readContract({ address: dataStore, abi: DATA_STORE_ABI, functionName: "getUint", args: [key] }),
    name,
  );
  const [reference, pool, sizeInUsd, sizeInTokens, collateralAtoms, positiveFee, negativeFee] = await Promise.all([
    runtime.feed.refresh(),
    new ArbitrumSepoliaMarketFeed(deployment, port, config.pollIntervalMs).refresh(),
    getUint(gmxShortPositionKey(account, market, collateral, "SIZE_IN_USD"), "position size"),
    getUint(gmxShortPositionKey(account, market, collateral, "SIZE_IN_TOKENS"), "position tokens"),
    getUint(gmxShortPositionKey(account, market, collateral, "COLLATERAL_AMOUNT"), "position collateral"),
    getUint(gmxPositionFeeFactorKey(market, true), "position fee factor"),
    getUint(gmxPositionFeeFactorKey(market, false), "position fee factor"),
  ]);
  if (sizeInUsd !== open.positionSizeUsd) fail("CHAIN_MISMATCH", "GMX position size changed while reading.");
  const spotQuoteOutAtoms = await quoteUniswapV3Sell(port, arbitrumSepoliaSpotQuoteTarget(config, pool), open.spotBaseAtoms);
  const limits = arbitrumSepoliaExitLimits({
    position: { quantityAtoms: open.spotBaseAtoms, sizeInUsd, sizeInTokens, collateralAtoms },
    baseDecimals: config.baseAsset.decimals,
    quoteDecimals: config.quoteAsset.decimals,
    reference,
    pool,
    spotQuoteOutAtoms,
    positionFeeFactor: positiveFee > negativeFee ? positiveFee : negativeFee,
    slippageBps: input.slippageBps,
  });
  const context = runtime.contexts(config.contextId);
  if (context === undefined) fail("UNKNOWN_CONTEXT", "Arbitrum Sepolia order context is unavailable.");
  const currentClock = await runtime.clock.currentClock(context);
  const order = createCanonicalExitOrder(runtime.contexts, {
    contextId: config.contextId,
    owner,
    settlementAccount: account,
    entryReceiptHash: Uint8Array.from(Buffer.from(open.packageId.slice(2), "hex")),
    positionSizeAtoms: limits.quantityAtoms,
    positionEntryNotionalAtoms: limits.entryNotionalAtoms,
    minSpotQuoteOutAtoms: limits.minSpotQuoteOutAtoms,
    minExitQuoteOutcomeAtoms: limits.minExitQuoteOutcomeAtoms,
    idempotencyKey: input.idempotencyKey,
    currentClock,
  });
  const stored = input.orders.createOrGet({
    order,
    request: Object.freeze({
      contextId: config.contextId,
      owner,
      settlementAccount: account,
      sizeAtoms: limits.quantityAtoms,
      slippageBps: input.slippageBps,
      idempotencyKey: input.idempotencyKey,
      currentClock,
    }),
  });
  return Object.freeze({ ...stored, packageId: open.packageId, limits });
}

/** The owner-signed full close, as the solver prepares it. Integers are decimal strings. */
export type ArbitrumSepoliaExitAuthorization = Readonly<{
  version: 1;
  attemptId: string;
  packageId: Hex;
  chainId: 421614;
  owner: Address;
  account: Address;
  exitController: Address;
  typedData: Readonly<{
    domain: Readonly<{ name: typeof ARBITRUM_EXIT_EIP712_NAME; version: "1"; chainId: 421614; verifyingContract: Address }>;
    types: Readonly<{ ExitAuthorization: readonly Readonly<{ name: string; type: string }>[] }>;
    primaryType: "ExitAuthorization";
    message: Readonly<Record<string, string | boolean>>;
  }>;
  digest: Hex;
  signed: boolean;
}>;

function invalid(): never {
  fail("INVALID_EXECUTOR_RESPONSE", "Arbitrum exit authorization response is invalid.");
}

function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) invalid();
  return value as Record<string, unknown>;
}

/** The typed message with integer fields as bigint, ready for EIP-712 hashing. */
export function arbitrumExitTypedMessage(message: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(ARBITRUM_EXIT_AUTHORIZATION_FIELDS.map(([name, type]) => {
    const value = message[name];
    if (type === "bytes32") {
      if (typeof value !== "string" || !HASH.test(value)) invalid();
      return [name, value];
    }
    if (type === "address") {
      if (typeof value !== "string" || !ADDRESS.test(value)) invalid();
      return [name, value];
    }
    if (type === "bool") {
      if (typeof value !== "boolean") invalid();
      return [name, value];
    }
    if (typeof value !== "string" || !DECIMAL.test(value)) invalid();
    const integer = BigInt(value);
    if (type === "uint64" && integer >= 1n << 64n) invalid();
    return [name, integer];
  }));
}

/**
 * Structural and cryptographic check of the solver's prepared exit authorization: exact fields, the
 * controller's EIP-712 domain, and a digest recomputed from the typed message.
 */
export function validateArbitrumSepoliaExitAuthorization(value: unknown, attemptId: string): ArbitrumSepoliaExitAuthorization {
  const record = exactKeys(value, [
    "version", "attemptId", "packageId", "chainId", "owner", "account", "exitController", "typedData", "digest", "signed",
  ]);
  const typedData = exactKeys(record.typedData, ["domain", "types", "primaryType", "message"]);
  const domain = exactKeys(typedData.domain, ["name", "version", "chainId", "verifyingContract"]);
  const types = exactKeys(typedData.types, ["ExitAuthorization"]);
  const fields = types.ExitAuthorization;
  const message = exactKeys(typedData.message, ARBITRUM_EXIT_AUTHORIZATION_FIELDS.map(([name]) => name));
  if (record.version !== 1 || record.attemptId !== attemptId || record.chainId !== 421614
    || typeof record.signed !== "boolean" || typeof record.packageId !== "string" || !HASH.test(record.packageId)
    || typeof record.digest !== "string" || !HASH.test(record.digest)
    || typeof record.owner !== "string" || !ADDRESS.test(record.owner)
    || typeof record.account !== "string" || !ADDRESS.test(record.account)
    || typeof record.exitController !== "string" || !ADDRESS.test(record.exitController)
    || domain.name !== ARBITRUM_EXIT_EIP712_NAME || domain.version !== "1" || domain.chainId !== 421614
    || domain.verifyingContract !== record.exitController || typedData.primaryType !== "ExitAuthorization"
    || !Array.isArray(fields) || fields.length !== ARBITRUM_EXIT_AUTHORIZATION_FIELDS.length
    || fields.some((field: unknown, index) => {
      const entry = field as Record<string, unknown>;
      const [name, type] = ARBITRUM_EXIT_AUTHORIZATION_FIELDS[index]!;
      return typeof field !== "object" || field === null || Object.keys(entry).length !== 2
        || entry.name !== name || entry.type !== type;
    })
    || message.packageId !== record.packageId || message.owner !== record.owner || message.account !== record.account) {
    invalid();
  }
  const digest = hashTypedData({
    domain: { name: ARBITRUM_EXIT_EIP712_NAME, version: "1", chainId: 421614, verifyingContract: record.exitController as Address },
    types: { ExitAuthorization: ARBITRUM_EXIT_AUTHORIZATION_FIELDS.map(([name, type]) => ({ name, type })) },
    primaryType: "ExitAuthorization",
    message: arbitrumExitTypedMessage(message),
  } as never);
  if (digest !== record.digest) invalid();
  return Object.freeze(record) as unknown as ArbitrumSepoliaExitAuthorization;
}

/**
 * Binds a validated exit authorization to the attempt it was prepared for: the canonical EXIT order's
 * owner, settlement account, and entry package, the attempt's own hashes, this deployment's
 * controller and market, and an owner-only proceeds path.
 */
export function requireArbitrumSepoliaExitBinding(
  authorization: ArbitrumSepoliaExitAuthorization,
  expected: Readonly<{
    deployment: ArbitrumSepoliaAsyncDeploymentConfiguration;
    owner: string;
    settlementAccount: string;
    packageId: string;
    orderHash: string;
    quoteHash: string;
    routeHash: string;
  }>,
): ArbitrumSepoliaExitAuthorization {
  const { deployment } = expected;
  const message = authorization.typedData.message;
  const lower = (value: string) => value.toLowerCase();
  if (deployment.exitController === undefined
    || authorization.exitController !== lower(deployment.exitController.address)
    || authorization.owner !== lower(expected.owner) || authorization.account !== lower(expected.settlementAccount)
    || authorization.account !== arbitrumSepoliaAccountOf(deployment, authorization.owner)
    || authorization.packageId !== lower(expected.packageId)
    || message.exitOrderHash !== lower(expected.orderHash) || message.exitQuoteHash !== lower(expected.quoteHash)
    || message.exitRouteHash !== lower(expected.routeHash)
    || message.receiver !== authorization.owner || message.spotProceedsRecipient !== authorization.owner
    || message.market !== lower(deployment.market.address)
    || message.collateralToken !== lower(deployment.collateralToken.address) || message.isLong !== false) {
    fail("AUTHORIZATION_MISMATCH", "Prepared exit authorization does not match this attempt and deployment.");
  }
  return authorization;
}

export function requireOwnerSignature(value: unknown): string {
  if (typeof value !== "string" || !SIGNATURE.test(value)) {
    fail("INVALID_SIGNATURE", "Owner signature must be a lowercase 65-byte hex string.");
  }
  return value;
}
