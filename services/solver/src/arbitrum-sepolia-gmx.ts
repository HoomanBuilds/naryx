import {
  concat,
  createPublicClient,
  encodeAbiParameters,
  getContractAddress,
  http,
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { GMX_V2_READER_ABI } from '@naryx/adapter-evm';
import type { UniswapV3SpotQuoteTarget } from './uniswap-v3-quoter.js';

export const ARBITRUM_SEPOLIA_CHAIN_ID = 421_614n;
export const ARBITRUM_SEPOLIA_DOMAIN_ID = 'eip155:421614';
export const GMX_FLOAT_PRECISION = 10n ** 30n;
const BPS_SCALE = 10_000n;
// GMX estimates the oracle price count of a swap-free order as index, long, and short token.
const GMX_ORDER_ORACLE_PRICE_COUNT = 3n;

function stringKey(name: string): Hex {
  return keccak256(encodeAbiParameters([{ type: 'string' }], [name]));
}

export const GMX_DATA_STORE_KEYS = Object.freeze({
  positionFeeFactor: stringKey('POSITION_FEE_FACTOR'),
  increaseOrderGasLimit: stringKey('INCREASE_ORDER_GAS_LIMIT'),
  decreaseOrderGasLimit: stringKey('DECREASE_ORDER_GAS_LIMIT'),
  estimatedGasFeeBaseAmount: stringKey('ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1'),
  estimatedGasFeePerOraclePrice: stringKey('ESTIMATED_GAS_FEE_PER_ORACLE_PRICE'),
  estimatedGasFeeMultiplierFactor: stringKey('ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR'),
  requestExpirationTime: stringKey('REQUEST_EXPIRATION_TIME'),
  minCollateralUsd: stringKey('MIN_COLLATERAL_USD'),
  minPositionSizeUsd: stringKey('MIN_POSITION_SIZE_USD'),
});

export function gmxPositionFeeFactorKey(market: Address, forPositiveImpact: boolean): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'bool' }],
    [GMX_DATA_STORE_KEYS.positionFeeFactor, market, forPositiveImpact],
  ));
}

function gmxMarketKey(name: string, market: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], [stringKey(name), market]));
}

export const GMX_DATA_STORE_ABI = parseAbi([
  'function getUint(bytes32 key) view returns (uint256)',
  'function getInt(bytes32 key) view returns (int256)',
]);

export const REFERENCE_PRICE_FEED_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

export interface ArbitrumSepoliaContractIdentity {
  readonly address: Address;
  readonly expectedCodeHash: Hex;
}

export interface ArbitrumSepoliaReadRequest {
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args?: readonly unknown[];
}

/** Signerless Arbitrum Sepolia reads. Chain identity always comes from eth_chainId. */
export interface ArbitrumSepoliaReadPort {
  chainId(): Promise<bigint>;
  codeHash(address: Address): Promise<Hex | undefined>;
  latestBlockTimestamp(): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  readContract(request: ArbitrumSepoliaReadRequest): Promise<unknown>;
}

export interface ArbitrumSepoliaReferencePriceFeed {
  readonly feed: ArbitrumSepoliaContractIdentity;
  readonly decimals: number;
  readonly maxAgeSeconds: bigint;
}

export interface ArbitrumSepoliaReferencePrice {
  readonly answer: bigint;
  readonly decimals: number;
  readonly updatedAt: bigint;
  readonly observedAt: bigint;
}

export async function requireArbitrumSepoliaChain(port: ArbitrumSepoliaReadPort): Promise<void> {
  if (await port.chainId() !== ARBITRUM_SEPOLIA_CHAIN_ID) {
    throw new Error('RPC eth_chainId is not Arbitrum Sepolia 421614');
  }
}

export async function requireArbitrumSepoliaCode(
  port: ArbitrumSepoliaReadPort,
  identity: ArbitrumSepoliaContractIdentity,
  name: string,
): Promise<void> {
  const observed = await port.codeHash(identity.address);
  if (observed === undefined || observed.toLowerCase() !== identity.expectedCodeHash.toLowerCase()) {
    throw new Error(`${name} code hash does not match the reviewed identity`);
  }
}

function uintValue(value: unknown, name: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`${name} is not an unsigned integer`);
  return value;
}

export async function readArbitrumSepoliaReferencePrice(
  port: ArbitrumSepoliaReadPort,
  config: ArbitrumSepoliaReferencePriceFeed,
): Promise<ArbitrumSepoliaReferencePrice> {
  await requireArbitrumSepoliaChain(port);
  await requireArbitrumSepoliaCode(port, config.feed, 'reference price feed');
  const [decimals, round, observedAt] = await Promise.all([
    port.readContract({ address: config.feed.address, abi: REFERENCE_PRICE_FEED_ABI, functionName: 'decimals' }),
    port.readContract({ address: config.feed.address, abi: REFERENCE_PRICE_FEED_ABI, functionName: 'latestRoundData' }),
    port.latestBlockTimestamp(),
  ]);
  if (Number(decimals) !== config.decimals) throw new Error('reference price feed decimals changed');
  const [roundId, answer, , updatedAt, answeredInRound] = round as readonly [bigint, bigint, bigint, bigint, bigint];
  if (typeof answer !== 'bigint' || answer <= 0n) throw new Error('reference price is not positive');
  if (uintValue(answeredInRound, 'answeredInRound') < uintValue(roundId, 'roundId')) {
    throw new Error('reference price round is incomplete');
  }
  const updated = uintValue(updatedAt, 'updatedAt');
  if (updated === 0n || updated > observedAt || observedAt - updated > config.maxAgeSeconds) {
    throw new Error('reference price is stale or future-dated');
  }
  return Object.freeze({ answer, decimals: config.decimals, updatedAt: updated, observedAt });
}

export async function readGmxUint(
  port: ArbitrumSepoliaReadPort,
  dataStore: Address,
  key: Hex,
): Promise<bigint> {
  return uintValue(
    await port.readContract({ address: dataStore, abi: GMX_DATA_STORE_ABI, functionName: 'getUint', args: [key] }),
    'GMX data store value',
  );
}

export async function readGmxInt(
  port: ArbitrumSepoliaReadPort,
  dataStore: Address,
  key: Hex,
): Promise<bigint> {
  const value = await port.readContract({ address: dataStore, abi: GMX_DATA_STORE_ABI, functionName: 'getInt', args: [key] });
  if (typeof value !== 'bigint') throw new Error('GMX data store value is not an integer');
  return value;
}

/** The larger of the market's two position fee factors, so the quoted fee never understates GMX. */
export async function readGmxPositionFeeFactor(
  port: ArbitrumSepoliaReadPort,
  dataStore: Address,
  market: Address,
): Promise<bigint> {
  const [positive, negative] = await Promise.all([
    readGmxUint(port, dataStore, gmxPositionFeeFactorKey(market, true)),
    readGmxUint(port, dataStore, gmxPositionFeeFactorKey(market, false)),
  ]);
  const factor = positive > negative ? positive : negative;
  if (factor >= GMX_FLOAT_PRECISION) throw new Error('GMX position fee factor is not below one');
  return factor;
}

/** GMX's price unit, 30-decimal USD per base atom, at the reference answer (rounded down). */
export function gmxIndexPrice(reference: Pick<ArbitrumSepoliaReferencePrice, 'answer' | 'decimals'>, baseDecimals: number): bigint {
  const price = (reference.answer * GMX_FLOAT_PRECISION) / 10n ** BigInt(reference.decimals + baseDecimals);
  if (price <= 0n) throw new Error('GMX index price rounds to zero');
  return price;
}

/** The GMX short's size: exactly the package quantity at the reference, in whole quote atoms, rounded down. */
export function arbitrumHedgeSizeAtoms(
  quantityAtoms: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  reference: Pick<ArbitrumSepoliaReferencePrice, 'answer' | 'decimals'>,
): bigint {
  if (quantityAtoms <= 0n || reference.answer <= 0n) throw new Error('hedge size inputs are invalid');
  const size = (quantityAtoms * reference.answer * 10n ** BigInt(quoteDecimals))
    / 10n ** BigInt(reference.decimals + baseDecimals);
  if (size <= 0n) throw new Error('entry notional rounds to zero');
  return size;
}

export type GmxExecutionPriceRead = Readonly<{
  /** 30-decimal USD per base atom, the price GMX checks against the order's acceptable price. */
  executionPrice: bigint;
  /** The impact of this change alone, 30-decimal USD; negative is a cost. */
  priceImpactUsd: bigint;
  /**
   * What a decrease pays out or charges for impact: this change's impact plus the position's
   * pending impact. GMX credits at most MAX_POSITION_IMPACT_FACTOR of a negative total and takes the
   * rest from the position as claimable collateral, which the Naryx account never claims, so the
   * close output carries the full negative total (Reader `totalImpactUsd - priceImpactDiffUsd`).
   */
  closeImpactUsd: bigint;
}>;

/**
 * GMX's own execution price for a short of `sizeDeltaUsd` (positive increases, negative decreases
 * `position`), from the pinned GMX Reader, checked against its reviewed code hash at every use. The
 * ETH/USD market's index and long token are priced at `indexPrice` and its short token, the
 * collateral, at par.
 */
export async function readGmxShortExecutionPrice(
  port: ArbitrumSepoliaReadPort,
  reader: ArbitrumSepoliaContractIdentity,
  dataStore: Address,
  market: Address,
  input: Readonly<{
    indexPrice: bigint;
    quoteDecimals: number;
    sizeDeltaUsd: bigint;
    position?: Readonly<{ sizeInUsd: bigint; sizeInTokens: bigint; pendingImpactAmount: bigint }>;
  }>,
): Promise<GmxExecutionPriceRead> {
  if (input.indexPrice <= 0n || input.sizeDeltaUsd === 0n || input.quoteDecimals < 0 || input.quoteDecimals > 30
    || (input.sizeDeltaUsd < 0n) !== (input.position !== undefined)) {
    throw new Error('GMX execution price inputs are invalid');
  }
  await requireArbitrumSepoliaCode(port, reader, 'GMX reader');
  const index = { min: input.indexPrice, max: input.indexPrice };
  const collateral = 10n ** BigInt(30 - input.quoteDecimals);
  const result = await port.readContract({
    address: reader.address,
    abi: GMX_V2_READER_ABI,
    functionName: 'getExecutionPrice',
    args: [
      dataStore, market,
      { indexTokenPrice: index, longTokenPrice: index, shortTokenPrice: { min: collateral, max: collateral } },
      input.position?.sizeInUsd ?? 0n, input.position?.sizeInTokens ?? 0n, input.sizeDeltaUsd,
      input.position?.pendingImpactAmount ?? 0n, false,
    ],
  }) as Record<string, unknown>;
  const { executionPrice, priceImpactUsd, totalImpactUsd, priceImpactDiffUsd } = result ?? {};
  if (typeof executionPrice !== 'bigint' || executionPrice <= 0n || typeof priceImpactUsd !== 'bigint'
    || typeof totalImpactUsd !== 'bigint' || typeof priceImpactDiffUsd !== 'bigint' || priceImpactDiffUsd < 0n) {
    throw new Error('GMX reader returned an invalid execution price');
  }
  return Object.freeze({ executionPrice, priceImpactUsd, closeImpactUsd: totalImpactUsd - priceImpactDiffUsd });
}

export type GmxEntryCollateralLimits = Readonly<{
  minCollateralUsd: bigint;
  minPositionSizeUsd: bigint;
  minCollateralFactor: bigint;
}>;

/** The DataStore values GMX validates a new position against right after it increases it. */
export async function readGmxEntryCollateralLimits(
  port: ArbitrumSepoliaReadPort,
  dataStore: Address,
  market: Address,
): Promise<GmxEntryCollateralLimits> {
  const [minCollateralUsd, minPositionSizeUsd, minCollateralFactor] = await Promise.all([
    readGmxUint(port, dataStore, GMX_DATA_STORE_KEYS.minCollateralUsd),
    readGmxUint(port, dataStore, GMX_DATA_STORE_KEYS.minPositionSizeUsd),
    readGmxUint(port, dataStore, gmxMarketKey('MIN_COLLATERAL_FACTOR', market)),
  ]);
  if (minCollateralFactor >= GMX_FLOAT_PRECISION) throw new Error('GMX minimum collateral factor is out of range');
  return Object.freeze({ minCollateralUsd, minPositionSizeUsd, minCollateralFactor });
}

/** A ratio as a decimal with two places, rounded toward zero, for refusal messages. */
export function decimalText(numerator: bigint, denominator: bigint): string {
  const negative = numerator !== 0n && (numerator < 0n) !== (denominator < 0n);
  const cents = ((numerator < 0n ? -numerator : numerator) * 100n) / (denominator < 0n ? -denominator : denominator);
  return `${negative ? '-' : ''}${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

function usdText(usd30: bigint, roundUp: boolean): string {
  const scale = 10n ** 28n;
  return decimalText(usd30 > 0n && roundUp ? usd30 + scale - 1n : usd30, 10n ** 30n);
}

/**
 * The validation GMX runs on a fresh short right after the increase: the position size at least
 * MIN_POSITION_SIZE_USD, and its collateral after the opening and closing fees and the pending
 * negative impact at least MIN_COLLATERAL_USD and the market's MIN_COLLATERAL_FACTOR of the size.
 * GMX itself caps that impact by MAX_POSITION_IMPACT_FACTOR_FOR_LIQUIDATIONS here, but V2.2 takes
 * all of it from the position when it closes, so the full impact is counted and the package stays
 * closable. Fees use the larger fee factor and any positive close impact is left out, so the check
 * never passes a position GMX refuses. Returns the refusal to show the trader, or undefined.
 */
export function gmxEntryCollateralRefusal(input: Readonly<{
  sizeAtoms: bigint;
  marginAtoms: bigint;
  positionFeeAtoms: bigint;
  priceImpactUsd: bigint;
  quoteDecimals: number;
  limits: GmxEntryCollateralLimits;
}>): string | undefined {
  const usdScale = 10n ** BigInt(30 - input.quoteDecimals);
  const sizeUsd = input.sizeAtoms * usdScale;
  if (sizeUsd < input.limits.minPositionSizeUsd) {
    return `the GMX short of ${usdText(sizeUsd, false)} USD is below GMX's minimum position size of ${usdText(input.limits.minPositionSizeUsd, true)} USD; nothing was signed. Increase the size`;
  }
  const impact = input.priceImpactUsd < 0n ? input.priceImpactUsd : 0n;
  const afterFees = (input.marginAtoms - 2n * input.positionFeeAtoms) * usdScale;
  const remaining = afterFees + impact;
  const forLeverage = (sizeUsd * input.limits.minCollateralFactor) / GMX_FLOAT_PRECISION;
  const required = input.limits.minCollateralUsd > forLeverage ? input.limits.minCollateralUsd : forLeverage;
  if (afterFees <= 0n || afterFees < required) {
    return `GMX would hold ${usdText(afterFees, false)} USD of collateral for this short after fees, below its minimum of ${usdText(required, true)} USD; nothing was signed. Increase the size`;
  }
  if (remaining <= 0n || remaining < required) {
    return `GMX's price impact of ${usdText(-impact, true)} USD on this short, charged when it closes, leaves ${usdText(remaining, false)} USD of collateral after fees, below its minimum of ${usdText(required, true)} USD; nothing was signed`;
  }
  return undefined;
}

const SPOT_PORT_VIEWS_ABI = parseAbi([
  'function spotPort() view returns (address)',
  'function spotPortCodeHash() view returns (bytes32)',
  'function pool() view returns (address)',
  'function poolFee() view returns (uint24)',
  'function baseToken() view returns (address)',
  'function quoteToken() view returns (address)',
]);

function addressValue(value: unknown, name: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) {
    throw new Error(`${name} is not a nonzero address`);
  }
  return value.toLowerCase() as Address;
}

/**
 * What the pinned quoter must simulate: the factory's spot port, checked against the code hash the
 * factory pinned, and the pool, token order, and fee that port swaps through.
 */
export async function readArbitrumSepoliaSpotQuoteTarget(
  port: ArbitrumSepoliaReadPort,
  factory: Address,
  quoter: ArbitrumSepoliaContractIdentity,
): Promise<UniswapV3SpotQuoteTarget> {
  const view = (address: Address, functionName: string) =>
    port.readContract({ address, abi: SPOT_PORT_VIEWS_ABI, functionName });
  const [spotPortValue, pinnedHash] = await Promise.all([view(factory, 'spotPort'), view(factory, 'spotPortCodeHash')]);
  const spotPort = addressValue(spotPortValue, 'factory spotPort');
  const liveHash = await port.codeHash(spotPort);
  if (liveHash === undefined || typeof pinnedHash !== 'string' || liveHash.toLowerCase() !== pinnedHash.toLowerCase()) {
    throw new Error('spot port code does not match the factory pinned hash');
  }
  const [pool, poolFee, baseToken, quoteToken] = await Promise.all([
    view(spotPort, 'pool'), view(spotPort, 'poolFee'), view(spotPort, 'baseToken'), view(spotPort, 'quoteToken'),
  ]);
  if (typeof poolFee !== 'number') throw new Error('spot pool fee is invalid');
  return Object.freeze({
    chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
    quoter,
    pool: addressValue(pool, 'spot pool'),
    baseToken: addressValue(baseToken, 'spot base token'),
    quoteToken: addressValue(quoteToken, 'spot quote token'),
    poolFee: BigInt(poolFee),
  });
}

export interface GmxExecutionFeeParameters {
  readonly baseAmount: bigint;
  readonly perOraclePrice: bigint;
  readonly multiplierFactor: bigint;
  readonly increaseOrderGasLimit: bigint;
}

export async function readGmxExecutionFeeParameters(
  port: ArbitrumSepoliaReadPort,
  dataStore: Address,
): Promise<GmxExecutionFeeParameters> {
  const [baseAmount, perOraclePrice, multiplierFactor, increaseOrderGasLimit] = await Promise.all([
    readGmxUint(port, dataStore, GMX_DATA_STORE_KEYS.estimatedGasFeeBaseAmount),
    readGmxUint(port, dataStore, GMX_DATA_STORE_KEYS.estimatedGasFeePerOraclePrice),
    readGmxUint(port, dataStore, GMX_DATA_STORE_KEYS.estimatedGasFeeMultiplierFactor),
    readGmxUint(port, dataStore, GMX_DATA_STORE_KEYS.increaseOrderGasLimit),
  ]);
  // A zero multiplier or order gas limit means the data store is not the reviewed GMX version.
  if (multiplierFactor === 0n || increaseOrderGasLimit === 0n) {
    throw new Error('GMX execution fee parameters are unavailable');
  }
  return Object.freeze({ baseAmount, perOraclePrice, multiplierFactor, increaseOrderGasLimit });
}

/** Mirrors GMX GasUtils for a swap-free MarketIncrease order, rounded up with a solver buffer. */
export function gmxIncreaseExecutionFeeWei(
  parameters: GmxExecutionFeeParameters,
  callbackGasLimit: bigint,
  gasPriceWei: bigint,
  bufferBps: bigint,
): bigint {
  if (callbackGasLimit <= 0n || gasPriceWei <= 0n || bufferBps < 0n) {
    throw new Error('execution fee inputs must be positive');
  }
  const estimated = parameters.increaseOrderGasLimit + callbackGasLimit;
  const gasLimit = parameters.baseAmount
    + GMX_ORDER_ORACLE_PRICE_COUNT * parameters.perOraclePrice
    + (estimated * parameters.multiplierFactor) / GMX_FLOAT_PRECISION;
  return ceilDiv(gasLimit * gasPriceWei * (BPS_SCALE + bufferBps), BPS_SCALE);
}

/** Mirrors GMX GasUtils for a swap-free MarketDecrease order, which estimates with its own order gas limit. */
export function gmxDecreaseExecutionFeeWei(
  parameters: GmxExecutionFeeParameters,
  decreaseOrderGasLimit: bigint,
  callbackGasLimit: bigint,
  gasPriceWei: bigint,
  bufferBps: bigint,
): bigint {
  if (decreaseOrderGasLimit <= 0n) throw new Error('GMX decrease order gas limit is unavailable');
  return gmxIncreaseExecutionFeeWei(
    { ...parameters, increaseOrderGasLimit: decreaseOrderGasLimit },
    callbackGasLimit,
    gasPriceWei,
    bufferBps,
  );
}

/** GMX `keccak256(abi.encode(keccak256(abi.encode(account, market, collateral, isLong)), FIELD))`. */
export function gmxPositionFieldKey(account: Address, market: Address, collateral: Address, isLong: boolean, field: string): Hex {
  const positionKey = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bool' }],
    [account, market, collateral, isLong],
  ));
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [positionKey, stringKey(field)]));
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('invalid unsigned division');
  return (numerator + denominator - 1n) / denominator;
}

export interface ArbitrumEntryPricingInput {
  readonly quantityAtoms: bigint;
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
  readonly reference: Pick<ArbitrumSepoliaReferencePrice, 'answer' | 'decimals'>;
  /** The pinned quoter's exact-output cost of `quantityAtoms` from the spot port's pool. */
  readonly spotQuoteAtoms: bigint;
  /** GMX's own execution price for a short of exactly the hedge size, 30-decimal USD per base atom. */
  readonly gmxExecutionPrice: bigint;
  readonly positionFeeFactor: bigint;
  readonly marginBps: bigint;
}

export interface ArbitrumEntryPricing {
  readonly spotNotionalAtoms: bigint;
  /** The GMX short's size: the quantity at the reference. GMX charges its fee on it; the margin covers it. */
  readonly positionSizeAtoms: bigint;
  /** The quantity at GMX's execution price, so GMX's price impact is part of the quoted spread. */
  readonly perpNotionalAtoms: bigint;
  readonly positionFeeAtoms: bigint;
  readonly marginAtoms: bigint;
}

/**
 * Prices the spot leg at what the pool charges for exactly this quantity (the quoter's exact-output
 * cost, pool fee and price impact included) and the GMX short at GMX's own execution price for the
 * hedge size (GMX price impact included), in quote atoms. GMX V2.2 opens the short at the reference
 * size, quantity tokens, and keeps the impact as the position's pending impact, so the size, fee,
 * and margin use the reference size and the proceeds use the execution price. The rest rounds
 * against the trader: the GMX position fee and margin up, perpetual proceeds down.
 */
export function priceArbitrumEntry(input: ArbitrumEntryPricingInput): ArbitrumEntryPricing {
  if (input.quantityAtoms <= 0n || input.reference.answer <= 0n || input.spotQuoteAtoms <= 0n
    || input.gmxExecutionPrice <= 0n || input.quoteDecimals < 0 || input.quoteDecimals > 30
    || input.positionFeeFactor < 0n || input.positionFeeFactor >= GMX_FLOAT_PRECISION
    || input.marginBps <= 0n || input.marginBps > BPS_SCALE) {
    throw new Error('entry pricing inputs are invalid');
  }
  const positionSizeAtoms = arbitrumHedgeSizeAtoms(input.quantityAtoms, input.baseDecimals, input.quoteDecimals, input.reference);
  const perpNotionalAtoms = (input.quantityAtoms * input.gmxExecutionPrice) / 10n ** BigInt(30 - input.quoteDecimals);
  if (perpNotionalAtoms <= 0n) throw new Error('entry notional at the GMX execution price rounds to zero');
  return Object.freeze({
    spotNotionalAtoms: input.spotQuoteAtoms,
    positionSizeAtoms,
    perpNotionalAtoms,
    positionFeeAtoms: ceilDiv(positionSizeAtoms * input.positionFeeFactor, GMX_FLOAT_PRECISION),
    marginAtoms: ceilDiv(positionSizeAtoms * input.marginBps, BPS_SCALE),
  });
}

export function createViemArbitrumSepoliaReadPort(rpcUrl: string): ArbitrumSepoliaReadPort {
  if (typeof rpcUrl !== 'string' || !/^https?:\/\//.test(rpcUrl)) {
    throw new Error('NARYX_ARBITRUM_SEPOLIA_RPC_URL must be an HTTP or HTTPS URL');
  }
  const client = createPublicClient({ transport: http(rpcUrl) });
  return Object.freeze({
    chainId: async () => BigInt(await client.getChainId()),
    codeHash: async (address: Address) => {
      const code = await client.getCode({ address });
      return code === undefined || code === '0x' ? undefined : keccak256(code);
    },
    latestBlockTimestamp: async () => (await client.getBlock({ blockTag: 'latest' })).timestamp,
    gasPrice: async () => client.getGasPrice(),
    readContract: async (request: ArbitrumSepoliaReadRequest) => client.readContract({
      address: request.address,
      abi: request.abi,
      functionName: request.functionName,
      ...(request.args === undefined ? {} : { args: request.args }),
    } as never),
  });
}

const CLONE_INIT_PREFIX = '0x3d602d80600a3d3981f3363d3d373d3d3d363d73';
const CLONE_RUNTIME_PREFIX = '0x363d3d373d3d3d363d73';
const CLONE_SUFFIX = '0x5af43d82803e903d91602b57fd5bf3';

/**
 * The GmxV2IsolatedAccountFactory account of `owner`: the CREATE2 address of an ERC-1167 clone of the
 * reviewed implementation, salted by `keccak256(abi.encode(owner))`. Pure, so it needs no RPC.
 */
export function arbitrumSepoliaAccountOf(factory: Address, implementation: Address, owner: Address): Address {
  return getContractAddress({
    opcode: 'CREATE2',
    from: factory,
    salt: keccak256(encodeAbiParameters([{ type: 'address' }], [owner])),
    bytecode: concat([CLONE_INIT_PREFIX, implementation, CLONE_SUFFIX]),
  }).toLowerCase() as Address;
}

/** The runtime code hash every factory account shares. */
export function arbitrumSepoliaAccountCodeHash(implementation: Address): Hex {
  return keccak256(concat([CLONE_RUNTIME_PREFIX, implementation, CLONE_SUFFIX]));
}
