import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from 'viem';

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
  estimatedGasFeeBaseAmount: stringKey('ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1'),
  estimatedGasFeePerOraclePrice: stringKey('ESTIMATED_GAS_FEE_PER_ORACLE_PRICE'),
  estimatedGasFeeMultiplierFactor: stringKey('ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR'),
  requestExpirationTime: stringKey('REQUEST_EXPIRATION_TIME'),
});

export function gmxPositionFeeFactorKey(market: Address, forPositiveImpact: boolean): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'bool' }],
    [GMX_DATA_STORE_KEYS.positionFeeFactor, market, forPositiveImpact],
  ));
}

export const GMX_DATA_STORE_ABI = parseAbi(['function getUint(bytes32 key) view returns (uint256)']);
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

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('invalid unsigned division');
  return (numerator + denominator - 1n) / denominator;
}

export interface ArbitrumEntryPricingInput {
  readonly quantityAtoms: bigint;
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
  readonly reference: Pick<ArbitrumSepoliaReferencePrice, 'answer' | 'decimals'>;
  readonly positionFeeFactor: bigint;
  readonly marginBps: bigint;
}

export interface ArbitrumEntryPricing {
  readonly spotNotionalAtoms: bigint;
  readonly perpNotionalAtoms: bigint;
  readonly positionFeeAtoms: bigint;
  readonly marginAtoms: bigint;
}

/**
 * Prices both legs at the live reference price in quote atoms. Amounts round against the trader:
 * spot cost, the GMX position fee, and margin up; perpetual proceeds down.
 */
export function priceArbitrumEntry(input: ArbitrumEntryPricingInput): ArbitrumEntryPricing {
  if (input.quantityAtoms <= 0n || input.reference.answer <= 0n
    || input.positionFeeFactor < 0n || input.positionFeeFactor >= GMX_FLOAT_PRECISION
    || input.marginBps <= 0n || input.marginBps > BPS_SCALE) {
    throw new Error('entry pricing inputs are invalid');
  }
  const numerator = input.quantityAtoms * input.reference.answer * 10n ** BigInt(input.quoteDecimals);
  const denominator = 10n ** BigInt(input.reference.decimals + input.baseDecimals);
  const spotNotionalAtoms = ceilDiv(numerator, denominator);
  const perpNotionalAtoms = numerator / denominator;
  if (perpNotionalAtoms <= 0n) throw new Error('entry notional rounds to zero');
  return Object.freeze({
    spotNotionalAtoms,
    perpNotionalAtoms,
    positionFeeAtoms: ceilDiv(perpNotionalAtoms * input.positionFeeFactor, GMX_FLOAT_PRECISION),
    marginAtoms: ceilDiv(perpNotionalAtoms * input.marginBps, BPS_SCALE),
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
