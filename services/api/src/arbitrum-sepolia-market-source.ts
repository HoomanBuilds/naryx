import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from "viem";
import type { ArbitrumSepoliaAsyncDeploymentConfiguration } from "./arbitrum-sepolia-async-context-provider.js";
import type {
  ArbitrumSepoliaOrderContextConfig,
  ArbitrumSepoliaPriceReadPort,
  ArbitrumSepoliaReferencePriceFeed,
} from "./arbitrum-sepolia-order-context.js";
import { equalHash, GMX_V2_READER_ABI, requiredEvmAddress } from "@naryx/adapter-evm";
import { decimalString, terminalAssetSymbol, type TerminalMarketDescriptor, type TerminalMarketObservation, type TerminalMarketSource } from "./private-terminal-manifest.js";

const FACTORY_ABI = parseAbi([
  "function spotPort() view returns (address)",
  "function spotPortCodeHash() view returns (bytes32)",
]);
const SPOT_PORT_ABI = parseAbi([
  "function pool() view returns (address)",
  "function poolFee() view returns (uint24)",
  "function baseToken() view returns (address)",
  "function quoteToken() view returns (address)",
]);
const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
]);
const DATA_STORE_ABI = parseAbi(["function getUint(bytes32 key) view returns (uint256)"]);
const GMX_FLOAT_PRECISION = 10n ** 30n;
const Q192 = 2n ** 192n;

/** GMX `keccak256(abi.encode(POSITION_FEE_FACTOR, market, forPositiveImpact))`, read live from the DataStore. */
export function gmxPositionFeeFactorKey(market: Address, forPositiveImpact: boolean): Hex {
  const name = keccak256(encodeAbiParameters([{ type: "string" }], ["POSITION_FEE_FACTOR"]));
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "bool" }],
    [name, market, forPositiveImpact],
  ));
}

export type GmxShortExecutionPrice = Readonly<{
  /** 30-decimal USD per base atom, the price GMX checks against the order's acceptable price. */
  executionPrice: bigint;
  priceImpactUsd: bigint;
  /**
   * What a decrease pays out or charges for impact: its own plus the position's pending impact. GMX
   * credits at most MAX_POSITION_IMPACT_FACTOR of a negative total and takes the rest from the
   * position as claimable collateral, which the Naryx account never claims, so the close output
   * carries the full negative total (Reader `totalImpactUsd - priceImpactDiffUsd`).
   */
  closeImpactUsd: bigint;
}>;

/**
 * GMX's own execution price for a short of `sizeDeltaUsd` (positive increases, negative decreases
 * `position`), from the pinned GMX Reader, whose code hash is checked at every use. The ETH/USD
 * market's index and long token are priced at `indexPrice` and its short token, the collateral, at par.
 */
export async function readGmxShortExecutionPrice(
  port: ArbitrumSepoliaPriceReadPort,
  deployment: Pick<ArbitrumSepoliaAsyncDeploymentConfiguration, "market" | "gmx">,
  input: Readonly<{
    indexPrice: bigint;
    quoteDecimals: number;
    sizeDeltaUsd: bigint;
    position?: Readonly<{ sizeInUsd: bigint; sizeInTokens: bigint; pendingImpactAmount: bigint }>;
  }>,
): Promise<GmxShortExecutionPrice> {
  if (input.indexPrice <= 0n || input.sizeDeltaUsd === 0n || input.quoteDecimals < 0 || input.quoteDecimals > 30
    || (input.sizeDeltaUsd < 0n) !== (input.position !== undefined)) {
    throw new Error("GMX execution price inputs are invalid.");
  }
  const reader = requiredEvmAddress(deployment.gmx.reader.address, "gmx.reader");
  const code = await port.codeHash(reader);
  if (code === undefined || !equalHash(code, deployment.gmx.reader.expectedCodeHash)) {
    throw new Error("GMX reader code does not match the reviewed identity.");
  }
  const index = { min: input.indexPrice, max: input.indexPrice };
  const collateral = 10n ** BigInt(30 - input.quoteDecimals);
  const result = await port.readContract({
    address: reader,
    abi: GMX_V2_READER_ABI,
    functionName: "getExecutionPrice",
    args: [
      requiredEvmAddress(deployment.gmx.dataStore.address, "gmx.dataStore"),
      requiredEvmAddress(deployment.market.address, "market"),
      { indexTokenPrice: index, longTokenPrice: index, shortTokenPrice: { min: collateral, max: collateral } },
      input.position?.sizeInUsd ?? 0n, input.position?.sizeInTokens ?? 0n, input.sizeDeltaUsd,
      input.position?.pendingImpactAmount ?? 0n, false,
    ],
  }) as Record<string, unknown> | undefined;
  const executionPrice = result?.executionPrice;
  const priceImpactUsd = result?.priceImpactUsd;
  const totalImpactUsd = result?.totalImpactUsd;
  const priceImpactDiffUsd = result?.priceImpactDiffUsd;
  if (typeof executionPrice !== "bigint" || executionPrice <= 0n || typeof priceImpactUsd !== "bigint"
    || typeof totalImpactUsd !== "bigint" || typeof priceImpactDiffUsd !== "bigint" || priceImpactDiffUsd < 0n) {
    throw new Error("GMX reader returned an invalid execution price.");
  }
  return Object.freeze({ executionPrice, priceImpactUsd, closeImpactUsd: totalImpactUsd - priceImpactDiffUsd });
}

export type ArbitrumSepoliaMarketSnapshot = Readonly<{
  sqrtPriceX96: bigint;
  baseIsToken0: boolean;
  poolFee: bigint;
  /** The GMX position fee factor for a price-impact-increasing trade, the higher of the two, in 1e30. */
  positionFeeFactor: bigint;
  /**
   * GMX's own execution prices, 30-decimal USD per base atom, at the reference for a short of the
   * largest order size: opening it (the bid) and buying it back (the ask), price impact included.
   */
  gmxShortOpenPrice?: bigint;
  gmxShortClosePrice?: bigint;
  observedAtMs: number;
}>;

/** What the terminal's GMX prices are read for: the largest order, at the live reference. */
export type ArbitrumSepoliaGmxQuoteSize = Readonly<{
  reference: Pick<ArbitrumSepoliaReferencePriceFeed, "latest">;
  sizeAtoms: bigint;
  baseDecimals: number;
  quoteDecimals: number;
}>;

/** A refresh also names the pool and its tokens, which the spot quoter needs. */
export type ArbitrumSepoliaMarketRead = ArbitrumSepoliaMarketSnapshot & Readonly<{
  pool: Address;
  baseToken: Address;
  quoteToken: Address;
}>;

/**
 * The spot pool and GMX fee behind the Arbitrum Sepolia terminal market: the factory's spot port
 * (checked against the code hash the factory pinned), its Uniswap V3 pool price and fee, and the GMX
 * market's position fee factor. Reads only; a failed refresh clears the snapshot.
 */
export class ArbitrumSepoliaMarketFeed {
  readonly #deployment: Pick<ArbitrumSepoliaAsyncDeploymentConfiguration, "accountFactory" | "collateralToken" | "market" | "gmx">;
  readonly #port: ArbitrumSepoliaPriceReadPort;
  readonly #pollIntervalMs: number;
  readonly #gmxQuote: ArbitrumSepoliaGmxQuoteSize | undefined;
  #latest: ArbitrumSepoliaMarketSnapshot | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    deployment: Pick<ArbitrumSepoliaAsyncDeploymentConfiguration, "accountFactory" | "collateralToken" | "market" | "gmx">,
    port: ArbitrumSepoliaPriceReadPort,
    pollIntervalMs: number,
    gmxQuote?: ArbitrumSepoliaGmxQuoteSize,
  ) {
    this.#deployment = deployment;
    this.#port = port;
    this.#pollIntervalMs = pollIntervalMs;
    this.#gmxQuote = gmxQuote;
  }

  /** GMX's execution prices for opening and closing a short of the configured size at the reference. */
  async #gmxPrices(): Promise<Readonly<{ gmxShortOpenPrice?: bigint; gmxShortClosePrice?: bigint }>> {
    const quote = this.#gmxQuote;
    const reference = quote?.reference.latest();
    if (quote === undefined) return {};
    if (reference === undefined) throw new Error("Arbitrum Sepolia reference price is unavailable.");
    const indexPrice = (reference.answer * GMX_FLOAT_PRECISION) / 10n ** BigInt(reference.decimals + quote.baseDecimals);
    const sizeInUsd = (quote.sizeAtoms * indexPrice) / 10n ** BigInt(30 - quote.quoteDecimals) * 10n ** BigInt(30 - quote.quoteDecimals);
    const [open, close] = await Promise.all([
      readGmxShortExecutionPrice(this.#port, this.#deployment, { indexPrice, quoteDecimals: quote.quoteDecimals, sizeDeltaUsd: sizeInUsd }),
      readGmxShortExecutionPrice(this.#port, this.#deployment, {
        indexPrice, quoteDecimals: quote.quoteDecimals, sizeDeltaUsd: -sizeInUsd,
        position: { sizeInUsd, sizeInTokens: quote.sizeAtoms, pendingImpactAmount: 0n },
      }),
    ]);
    return { gmxShortOpenPrice: open.executionPrice, gmxShortClosePrice: close.executionPrice };
  }

  latest(): ArbitrumSepoliaMarketSnapshot | undefined {
    return this.#latest;
  }

  async refresh(): Promise<ArbitrumSepoliaMarketRead> {
    try {
      const read = (address: Address, abi: typeof FACTORY_ABI | typeof SPOT_PORT_ABI | typeof POOL_ABI | typeof DATA_STORE_ABI, functionName: string, args?: readonly unknown[]) =>
        this.#port.readContract({ address, abi, functionName, ...(args === undefined ? {} : { args }) });
      const factory = requiredEvmAddress(this.#deployment.accountFactory.address, "accountFactory");
      const [spotPortValue, pinnedHash] = await Promise.all([
        read(factory, FACTORY_ABI, "spotPort"),
        read(factory, FACTORY_ABI, "spotPortCodeHash"),
      ]);
      const spotPort = requiredEvmAddress(String(spotPortValue), "spotPort");
      const liveHash = await this.#port.codeHash(spotPort);
      if (liveHash === undefined || liveHash.toLowerCase() !== String(pinnedHash).toLowerCase()) {
        throw new Error("Arbitrum Sepolia spot port code does not match the factory's pinned hash.");
      }
      const [poolValue, poolFee, baseValue, quoteValue] = await Promise.all([
        read(spotPort, SPOT_PORT_ABI, "pool"),
        read(spotPort, SPOT_PORT_ABI, "poolFee"),
        read(spotPort, SPOT_PORT_ABI, "baseToken"),
        read(spotPort, SPOT_PORT_ABI, "quoteToken"),
      ]);
      const quote = requiredEvmAddress(String(quoteValue), "spotPort.quoteToken");
      if (quote !== requiredEvmAddress(this.#deployment.collateralToken.address, "collateralToken")) {
        throw new Error("Arbitrum Sepolia spot quote token is not the GMX collateral token.");
      }
      const pool = requiredEvmAddress(String(poolValue), "spotPort.pool");
      const market = requiredEvmAddress(this.#deployment.market.address, "market");
      const [slot0, token0, positionFeeFactor, gmxPrices] = await Promise.all([
        read(pool, POOL_ABI, "slot0"),
        read(pool, POOL_ABI, "token0"),
        read(requiredEvmAddress(this.#deployment.gmx.dataStore.address, "gmx.dataStore"), DATA_STORE_ABI, "getUint", [gmxPositionFeeFactorKey(market, false)]),
        this.#gmxPrices(),
      ]);
      const sqrtPriceX96 = (slot0 as readonly unknown[])[0];
      if (typeof sqrtPriceX96 !== "bigint" || sqrtPriceX96 <= 0n || typeof poolFee !== "number"
        || typeof positionFeeFactor !== "bigint" || positionFeeFactor >= GMX_FLOAT_PRECISION) {
        throw new Error("Arbitrum Sepolia spot pool or GMX fee read is invalid.");
      }
      const baseToken = requiredEvmAddress(String(baseValue), "spotPort.baseToken");
      const snapshot: ArbitrumSepoliaMarketRead = Object.freeze({
        sqrtPriceX96,
        baseIsToken0: requiredEvmAddress(String(token0), "pool.token0") === baseToken,
        poolFee: BigInt(poolFee),
        positionFeeFactor,
        ...gmxPrices,
        observedAtMs: Date.now(),
        pool,
        baseToken,
        quoteToken: quote,
      });
      this.#latest = snapshot;
      return snapshot;
    } catch (error) {
      this.#latest = undefined;
      throw error;
    }
  }

  start(): void {
    if (this.#timer !== undefined) return;
    void this.refresh().catch(() => undefined);
    this.#timer = setInterval(() => { void this.refresh().catch(() => undefined); }, this.#pollIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/**
 * Arbitrum Sepolia: spot is the Uniswap V3 pool mid with the pool fee as its taker rate; the
 * perpetual is GMX V2, shown at GMX's own execution prices for opening (bid) and closing (ask) a
 * short of the largest order size when the market feed reads them, price impact included, else at
 * the Chainlink reference the order context prices from, with the GMX market's live position fee
 * factor as its taker rate. Every value comes from live reads.
 */
export function createArbitrumSepoliaMarketSource(
  config: Pick<ArbitrumSepoliaOrderContextConfig, "contextId" | "baseAsset" | "quoteAsset" | "maximumQuantityAtoms" | "maxSlippageBps" | "maxStalenessSeconds">,
  reference: Pick<ArbitrumSepoliaReferencePriceFeed, "latest">,
  market: Pick<ArbitrumSepoliaMarketFeed, "latest">,
): TerminalMarketSource {
  const base = terminalAssetSymbol(config.baseAsset.assetId, "WETH");
  const quote = terminalAssetSymbol(config.quoteAsset.assetId, "USDC");
  const descriptor: TerminalMarketDescriptor = Object.freeze({
    environment: "TESTNET",
    packageId: config.contextId,
    baseSymbol: base,
    quoteSymbol: quote,
    baseDecimals: config.baseAsset.decimals,
    quoteDecimals: config.quoteAsset.decimals,
    maximumSizeAtoms: config.maximumQuantityAtoms,
    maxSlippageBps: config.maxSlippageBps,
    maxStalenessMs: Number(config.maxStalenessSeconds) * 1_000,
    settlement: Object.freeze({ label: "Bonded async", detail: "Solver-bonded, GMX keeper-executed" }),
    spot: Object.freeze({ instrument: `${base} / ${quote}`, venue: "Uniswap V3 on Arbitrum Sepolia" }),
    perp: Object.freeze({ instrument: `${base}-PERP`, venue: "GMX V2 on Arbitrum Sepolia" }),
  });
  const baseScale = 10n ** BigInt(config.baseAsset.decimals);
  const quoteScale = 10n ** BigInt(config.quoteAsset.decimals);
  return Object.freeze({
    descriptor,
    latest(): TerminalMarketObservation | undefined {
      const price = reference.latest();
      const pool = market.latest();
      if (price === undefined || pool === undefined) return undefined;
      const squared = pool.sqrtPriceX96 * pool.sqrtPriceX96;
      // Quote units per base unit from token1-per-token0 atoms.
      const spot = pool.baseIsToken0
        ? decimalString(squared * baseScale, Q192 * quoteScale)
        : decimalString(Q192 * baseScale, squared * quoteScale);
      const perp = decimalString(price.answer, 10n ** BigInt(price.decimals));
      const gmxPrice = (value: bigint | undefined) => value === undefined ? perp : decimalString(value * baseScale, GMX_FLOAT_PRECISION);
      return Object.freeze({
        spotBid: spot,
        spotAsk: spot,
        perpBid: gmxPrice(pool.gmxShortOpenPrice),
        perpAsk: gmxPrice(pool.gmxShortClosePrice),
        spotTakerRate: decimalString(pool.poolFee, 1_000_000n),
        perpTakerRate: decimalString(pool.positionFeeFactor, GMX_FLOAT_PRECISION),
        capturedAtMs: pool.observedAtMs,
      });
    },
  });
}
