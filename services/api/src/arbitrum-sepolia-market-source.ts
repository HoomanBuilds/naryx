import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from "viem";
import type { ArbitrumSepoliaAsyncDeploymentConfiguration } from "./arbitrum-sepolia-async-context-provider.js";
import type {
  ArbitrumSepoliaOrderContextConfig,
  ArbitrumSepoliaPriceReadPort,
  ArbitrumSepoliaReferencePriceFeed,
} from "./arbitrum-sepolia-order-context.js";
import { requiredEvmAddress } from "@naryx/adapter-evm";
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

export type ArbitrumSepoliaMarketSnapshot = Readonly<{
  sqrtPriceX96: bigint;
  baseIsToken0: boolean;
  poolFee: bigint;
  /** The GMX position fee factor for a price-impact-increasing trade, the higher of the two, in 1e30. */
  positionFeeFactor: bigint;
  observedAtMs: number;
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
  #latest: ArbitrumSepoliaMarketSnapshot | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    deployment: Pick<ArbitrumSepoliaAsyncDeploymentConfiguration, "accountFactory" | "collateralToken" | "market" | "gmx">,
    port: ArbitrumSepoliaPriceReadPort,
    pollIntervalMs: number,
  ) {
    this.#deployment = deployment;
    this.#port = port;
    this.#pollIntervalMs = pollIntervalMs;
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
      const [slot0, token0, positionFeeFactor] = await Promise.all([
        read(pool, POOL_ABI, "slot0"),
        read(pool, POOL_ABI, "token0"),
        read(requiredEvmAddress(this.#deployment.gmx.dataStore.address, "gmx.dataStore"), DATA_STORE_ABI, "getUint", [gmxPositionFeeFactorKey(market, false)]),
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
 * perpetual is GMX V2, shown at the Chainlink reference the order context prices from, with the GMX
 * market's live position fee factor as its taker rate (GMX fills at its oracle price plus price
 * impact, so no spread is shown). Every value comes from live reads.
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
      return Object.freeze({
        spotBid: spot,
        spotAsk: spot,
        perpBid: perp,
        perpAsk: perp,
        spotTakerRate: decimalString(pool.poolFee, 1_000_000n),
        perpTakerRate: decimalString(pool.positionFeeFactor, GMX_FLOAT_PRECISION),
        capturedAtMs: pool.observedAtMs,
      });
    },
  });
}
