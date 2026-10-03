import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { equalHash, requiredEvmAddress, type EvmContractIdentity } from "@naryx/adapter-evm";
import {
  domainRefFromManifest,
  exactPrice,
  parseProtocolJson,
  type AdapterRef,
  type AssetRef,
  type ExactPrice,
  type ExactSignedRate,
  type FeeCap,
} from "@naryx/protocol-types";
import { createPublicClient, http, keccak256, parseAbi, type Abi, type Address, type Hex } from "viem";
import {
  ARBITRUM_SEPOLIA_CHAIN_REFERENCE,
  validateArbitrumSepoliaAsyncDeploymentConfiguration,
  type ArbitrumSepoliaAsyncDeploymentConfiguration,
} from "./arbitrum-sepolia-async-context-provider.js";
import { ArbitrumSepoliaMarketFeed, type ArbitrumSepoliaMarketRead } from "./arbitrum-sepolia-market-source.js";
import { venueFeeCapsWithBase, type ActiveOrderContext, type ActiveOrderContextProvider } from "./canonical-entry-order.js";
import type { InternalOrderClockPort, InternalOrderSpotPricePort } from "./terminal-orders.js";
import {
  executableSpotPrice,
  quoteUniswapV3Buy,
  verifyUniswapV3Quoter,
  type UniswapV3SpotQuoteTarget,
} from "./uniswap-v3-quoter.js";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const CONTEXT_ID = /^[A-Za-z0-9:_.-]{1,128}$/;
const PRICE_FEED_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** Reviewed order limits for Arbitrum Sepolia. Any wallet trades through its own factory account. */
export interface ArbitrumSepoliaOrderContextConfig {
  readonly schemaVersion: 1;
  readonly contextId: string;
  readonly orderVersion: number;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly spotAdapter: AdapterRef;
  readonly perpetualAdapter: AdapterRef;
  readonly priceFeed: EvmContractIdentity;
  readonly priceFeedDecimals: number;
  /** The canonical Uniswap V3 QuoterV2; entry and exit bounds come from its quote for the exact size. */
  readonly spotQuoter: EvmContractIdentity;
  readonly maxStalenessSeconds: bigint;
  readonly pollIntervalMs: number;
  readonly expiryTtlSeconds: bigint;
  readonly maxEntrySpread: ExactSignedRate;
  readonly maximumQuantityAtoms: bigint;
  readonly maxSlippageBps: number;
  readonly maxVenueFeeAtomsByAsset: readonly FeeCap[];
  readonly maxMarginAddedAtoms: bigint;
  readonly maxProtocolFeeAtoms: bigint;
  readonly maxSolverFeeAtoms: bigint;
  readonly maxPriorityFeeAtoms: bigint;
}

/** Signerless reads. Chain identity always comes from eth_chainId, never from the RPC URL. */
export interface ArbitrumSepoliaPriceReadPort {
  chainId(): Promise<bigint>;
  codeHash(address: Address): Promise<Hex | undefined>;
  latestBlockTimestamp(): Promise<bigint>;
  readContract(request: Readonly<{
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }>): Promise<unknown>;
}

export type ArbitrumSepoliaReferencePriceSnapshot = Readonly<{
  answer: bigint;
  decimals: number;
  updatedAt: bigint;
  observedAt: bigint;
}>;

export type ArbitrumSepoliaOrderRuntime = Readonly<{
  contexts: ActiveOrderContextProvider;
  clock: InternalOrderClockPort;
  spotPrice: InternalOrderSpotPricePort;
  feed: ArbitrumSepoliaReferencePriceFeed;
  config: ArbitrumSepoliaOrderContextConfig;
}>;

function positive(value: unknown, name: string): bigint {
  if (typeof value !== "bigint" || value <= 0n) throw new Error(`Arbitrum order context ${name} must be positive.`);
  return value;
}

function validateConfig(config: ArbitrumSepoliaOrderContextConfig): void {
  if (config?.schemaVersion !== 1 || typeof config.contextId !== "string" || !CONTEXT_ID.test(config.contextId)
    || !Number.isSafeInteger(config.priceFeedDecimals) || config.priceFeedDecimals < 0 || config.priceFeedDecimals > 36
    || !Number.isSafeInteger(config.pollIntervalMs) || config.pollIntervalMs < 250
    || !Number.isSafeInteger(config.maxSlippageBps) || config.maxSlippageBps < 1 || config.maxSlippageBps > 10_000
    || !Array.isArray(config.maxVenueFeeAtomsByAsset) || config.maxVenueFeeAtomsByAsset.length === 0) {
    throw new Error("Arbitrum Sepolia order context configuration is invalid.");
  }
  for (const [name, identity] of [["priceFeed", config.priceFeed], ["spotQuoter", config.spotQuoter]] as const) {
    requiredEvmAddress(identity?.address, `${name}.address`);
    if (!/^0x[0-9a-f]{64}$/.test(identity.expectedCodeHash) || /^0x0+$/.test(identity.expectedCodeHash)) {
      throw new Error(`Arbitrum order context ${name} code hash is invalid.`);
    }
  }
  positive(config.maxStalenessSeconds, "maxStalenessSeconds");
  positive(config.expiryTtlSeconds, "expiryTtlSeconds");
  positive(config.maximumQuantityAtoms, "maximumQuantityAtoms");
  for (const [name, value] of [
    ["maxMarginAddedAtoms", config.maxMarginAddedAtoms],
    ["maxProtocolFeeAtoms", config.maxProtocolFeeAtoms],
    ["maxSolverFeeAtoms", config.maxSolverFeeAtoms],
    ["maxPriorityFeeAtoms", config.maxPriorityFeeAtoms],
  ] as const) {
    if (typeof value !== "bigint" || value < 0n) throw new Error(`Arbitrum order context ${name} must be nonnegative.`);
  }
}

export function loadArbitrumSepoliaOrderContextConfig(path: string): ArbitrumSepoliaOrderContextConfig {
  if (!isAbsolute(path)) throw new Error("NARYX_ARBITRUM_SEPOLIA_ORDER_CONTEXT must be an absolute path.");
  const config = parseProtocolJson(readFileSync(resolve(path), "utf8"), "arbitrumSepoliaOrderContext");
  validateConfig(config as ArbitrumSepoliaOrderContextConfig);
  return config as ArbitrumSepoliaOrderContextConfig;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** Quote atoms per base atom at the feed price; the quote asset is the feed's USD unit at par. */
export function arbitrumSepoliaReferencePrice(
  baseAsset: AssetRef,
  quoteAsset: AssetRef,
  snapshot: Pick<ArbitrumSepoliaReferencePriceSnapshot, "answer" | "decimals">,
): ExactPrice {
  const quoteAtoms = snapshot.answer * 10n ** BigInt(quoteAsset.decimals);
  const baseAtoms = 10n ** BigInt(snapshot.decimals + baseAsset.decimals);
  const divisor = gcd(quoteAtoms, baseAtoms);
  return exactPrice({
    baseAsset,
    quoteAsset,
    quoteAtoms: quoteAtoms / divisor,
    baseAtoms: baseAtoms / divisor,
    roundingDirection: "CEIL",
  });
}

export class ArbitrumSepoliaReferencePriceFeed {
  readonly #config: ArbitrumSepoliaOrderContextConfig;
  readonly #port: ArbitrumSepoliaPriceReadPort;
  #latest: ArbitrumSepoliaReferencePriceSnapshot | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(config: ArbitrumSepoliaOrderContextConfig, port: ArbitrumSepoliaPriceReadPort) {
    validateConfig(config);
    this.#config = config;
    this.#port = port;
  }

  latest(): ArbitrumSepoliaReferencePriceSnapshot | undefined {
    return this.#latest;
  }

  /** Any failed or stale read clears the snapshot, so the order context reports itself unknown. */
  async refresh(): Promise<ArbitrumSepoliaReferencePriceSnapshot> {
    try {
      const feed = requiredEvmAddress(this.#config.priceFeed.address, "priceFeed.address");
      if (await this.#port.chainId() !== BigInt(ARBITRUM_SEPOLIA_CHAIN_REFERENCE)) {
        throw new Error("Arbitrum Sepolia RPC eth_chainId is not 421614.");
      }
      const codeHash = await this.#port.codeHash(feed);
      if (codeHash === undefined || !equalHash(codeHash, this.#config.priceFeed.expectedCodeHash)) {
        throw new Error("Arbitrum Sepolia price feed code does not match the reviewed identity.");
      }
      const [decimals, round, observedAt] = await Promise.all([
        this.#port.readContract({ address: feed, abi: PRICE_FEED_ABI, functionName: "decimals" }),
        this.#port.readContract({ address: feed, abi: PRICE_FEED_ABI, functionName: "latestRoundData" }),
        this.#port.latestBlockTimestamp(),
      ]);
      const [roundId, answer, , updatedAt, answeredInRound] = round as readonly bigint[];
      if (Number(decimals) !== this.#config.priceFeedDecimals || typeof answer !== "bigint" || answer <= 0n
        || typeof updatedAt !== "bigint" || updatedAt <= 0n || updatedAt > observedAt
        || typeof answeredInRound !== "bigint" || typeof roundId !== "bigint" || answeredInRound < roundId
        || observedAt - updatedAt > this.#config.maxStalenessSeconds) {
        throw new Error("Arbitrum Sepolia reference price is invalid, incomplete, or stale.");
      }
      this.#latest = Object.freeze({ answer, decimals: this.#config.priceFeedDecimals, updatedAt, observedAt });
      return this.#latest;
    } catch (error) {
      this.#latest = undefined;
      throw error;
    }
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => { void this.refresh().catch(() => undefined); }, this.#config.pollIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/** The pinned quoter and the factory spot port's pool tokens and fee, as the market feed read them. */
export function arbitrumSepoliaSpotQuoteTarget(
  config: Pick<ArbitrumSepoliaOrderContextConfig, "spotQuoter">,
  pool: Pick<ArbitrumSepoliaMarketRead, "baseToken" | "quoteToken" | "poolFee">,
): UniswapV3SpotQuoteTarget {
  return Object.freeze({
    chainId: BigInt(ARBITRUM_SEPOLIA_CHAIN_REFERENCE),
    quoter: config.spotQuoter,
    baseToken: pool.baseToken,
    quoteToken: pool.quoteToken,
    poolFee: pool.poolFee,
  });
}

/**
 * Builds the Arbitrum Sepolia entry context. Any wallet may trade through its own factory account;
 * the settlement account is enforced against `accountOf(owner)` by the solver quote and executor,
 * by the async attempt context, and on chain by the adapter, which only ever uses that account.
 */
export async function createArbitrumSepoliaOrderRuntime(input: Readonly<{
  config: ArbitrumSepoliaOrderContextConfig;
  deployment: ArbitrumSepoliaAsyncDeploymentConfiguration;
  port: ArbitrumSepoliaPriceReadPort;
}>): Promise<ArbitrumSepoliaOrderRuntime> {
  const { config, deployment, port } = input;
  validateConfig(config);
  validateArbitrumSepoliaAsyncDeploymentConfiguration(deployment);
  if (await port.chainId() !== BigInt(ARBITRUM_SEPOLIA_CHAIN_REFERENCE)) {
    throw new Error("Arbitrum Sepolia RPC eth_chainId is not 421614.");
  }
  const factory = requiredEvmAddress(deployment.accountFactory.address, "accountFactory");
  const factoryCode = await port.codeHash(factory);
  if (factoryCode === undefined || !equalHash(factoryCode, deployment.accountFactory.expectedCodeHash)) {
    throw new Error("Arbitrum Sepolia account factory code does not match the reviewed identity.");
  }
  const feed = new ArbitrumSepoliaReferencePriceFeed(config, port);
  await feed.refresh();
  const readSpotPool = () => new ArbitrumSepoliaMarketFeed(deployment, port, config.pollIntervalMs).refresh();
  const initialPool = await readSpotPool();
  await verifyUniswapV3Quoter(port, arbitrumSepoliaSpotQuoteTarget(config, initialPool), initialPool.pool);
  const domain = domainRefFromManifest(deployment.domainManifest);
  const maximumQuantityAtoms = config.maximumQuantityAtoms < deployment.bounds.maximumPackageQuantityAtoms
    ? config.maximumQuantityAtoms
    : deployment.bounds.maximumPackageQuantityAtoms;
  let cached: Readonly<{ snapshot: ArbitrumSepoliaReferencePriceSnapshot; context: ActiveOrderContext }> | undefined;
  const contexts: ActiveOrderContextProvider = (contextId) => {
    if (contextId !== config.contextId) return undefined;
    const snapshot = feed.latest();
    if (snapshot === undefined) return undefined;
    if (cached?.snapshot === snapshot) return cached.context;
    const context: ActiveOrderContext = Object.freeze({
      contextId: config.contextId,
      state: "ACTIVE",
      // The feed's own update time, so order creation enforces staleness against chain time.
      capturedAtClock: snapshot.updatedAt,
      maxStaleness: config.maxStalenessSeconds,
      domain,
      environment: "testnet",
      orderVersion: config.orderVersion,
      templateId: config.templateId,
      templateVersion: config.templateVersion,
      packageTemplateManifestHash: config.packageTemplateManifestHash,
      baseAsset: config.baseAsset,
      quoteAsset: config.quoteAsset,
      spotAdapters: [config.spotAdapter],
      perpAdapters: [config.perpetualAdapter],
      settlementClass: "ASYNC_BONDED_SOLVER",
      expiryUnit: "EVM_UNIX_SECONDS",
      expiryTtl: config.expiryTtlSeconds,
      spotReferencePrice: arbitrumSepoliaReferencePrice(config.baseAsset, config.quoteAsset, snapshot),
      maxEntrySpread: config.maxEntrySpread,
      maximumQuantityAtoms,
      maxSlippageBps: config.maxSlippageBps,
      // GMX charges the position fee in the quote asset; every quote also lists a zero base fee.
      maxVenueFeeAtomsByAsset: venueFeeCapsWithBase(config.baseAsset, config.maxVenueFeeAtomsByAsset),
      maxMarginAddedAtoms: config.maxMarginAddedAtoms,
      maxProtocolFeeAtoms: config.maxProtocolFeeAtoms,
      maxSolverFeeAtoms: config.maxSolverFeeAtoms,
      maxPriorityFeeAtoms: config.maxPriorityFeeAtoms,
      minVenueReserveReturnedAtoms: 0n,
      minWalletQuoteBalanceDeltaAtoms: 0n,
      maxResidualBaseQuantityAtoms: 0n,
    });
    cached = Object.freeze({ snapshot, context });
    return context;
  };
  const clock: InternalOrderClockPort = Object.freeze({
    currentClock: async (context: ActiveOrderContext) => {
      if (context.contextId !== config.contextId) throw new Error("Arbitrum Sepolia order context is unknown.");
      if (await port.chainId() !== BigInt(ARBITRUM_SEPOLIA_CHAIN_REFERENCE)) {
        throw new Error("Arbitrum Sepolia RPC eth_chainId is not 421614.");
      }
      return port.latestBlockTimestamp();
    },
  });
  // The solver quotes the spot leg at the pool's exact-output cost for this size but the GMX hedge
  // and the rollback floor at the reference, so the entry bound covers the larger of the two costs
  // and the rollback floor stays within it while the pool trades below the reference.
  const spotPrice: InternalOrderSpotPricePort = Object.freeze({
    entrySpotPrice: async (context: ActiveOrderContext, sizeAtoms: bigint) => {
      if (context.contextId !== config.contextId) throw new Error("Arbitrum Sepolia order context is unknown.");
      const amountIn = await quoteUniswapV3Buy(port, arbitrumSepoliaSpotQuoteTarget(config, await readSpotPool()), sizeAtoms);
      const reference = context.spotReferencePrice;
      return amountIn * reference.baseAtoms <= sizeAtoms * reference.quoteAtoms
        ? reference
        : executableSpotPrice(config.baseAsset, config.quoteAsset, amountIn, sizeAtoms);
    },
  });
  return Object.freeze({ contexts, clock, spotPrice, feed, config });
}

export function createViemArbitrumSepoliaPriceReadPort(rpcUrl: string): ArbitrumSepoliaPriceReadPort {
  if (typeof rpcUrl !== "string" || !/^https?:\/\//.test(rpcUrl)) {
    throw new Error("Arbitrum Sepolia RPC URL must be an HTTP or HTTPS URL.");
  }
  const client = createPublicClient({ transport: http(rpcUrl) });
  return Object.freeze({
    chainId: async () => BigInt(await client.getChainId()),
    codeHash: async (address: Address) => {
      const code = await client.getCode({ address });
      return code === undefined || code === "0x" ? undefined : keccak256(code);
    },
    latestBlockTimestamp: async () => (await client.getBlock({ blockTag: "latest" })).timestamp,
    readContract: async (request: Parameters<ArbitrumSepoliaPriceReadPort["readContract"]>[0]) => client.readContract({
      address: request.address,
      abi: request.abi,
      functionName: request.functionName,
      ...(request.args === undefined ? {} : { args: request.args }),
    } as never),
  });
}
