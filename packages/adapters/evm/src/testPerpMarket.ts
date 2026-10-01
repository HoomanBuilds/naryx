import { mulDiv, type Hash32 } from '@naryx/protocol-types';
import { parseAbi } from 'viem';

const BPS = 10_000n;
const UINT64_MAX = (1n << 64n) - 1n;
const INT128_MAX = (1n << 127n) - 1n;
const UINT128_MASK = (1n << 128n) - 1n;

/** Reads and owner calls of `NaryxStrategyAccountFactory` and `NaryxStrategyAccount`. */
export const NARYX_STRATEGY_ACCOUNT_FACTORY_ABI = parseAbi([
  'function accountOf(address owner) view returns (address)',
  'function create(address owner) returns (address account)',
  'function accountCodeHash() view returns (bytes32)',
  'function verifier() view returns (address)',
]);

export const NARYX_STRATEGY_ACCOUNT_OWNER_ABI = parseAbi([
  'function owner() view returns (address)',
  'function verifier() view returns (address)',
  'function depositPerpMargin(bytes32 venueSubjectId, uint256 amount)',
  'function withdrawPerpMargin(bytes32 venueSubjectId, uint256 amount)',
]);

/** Reads of the Base Sepolia `NaryxTestPerpMarket`. Balances, notionals, and prices are WAD. */
export const NARYX_TEST_PERP_MARKET_ABI = parseAbi([
  'struct Position { int128 balance; int128 size; uint128 entryNotional; int128 entrySocialLossIndex; int128 entryFundingIndex; }',
  'function getPosition(address instrument, uint32 requestedExpiry, address target) view returns (Position)',
  'function reserveOf(address trader) view returns (uint256)',
  'function previewOpen(int128 sizeDelta, uint256 balanceWad) view returns (uint256 fillPriceWad, uint256 entryNotionalWad, uint256 feeWad, uint256 marginWad)',
  'function oraclePriceWad() view returns (uint256)',
  'function oracle() view returns (address)',
  'function collateral() view returns (address)',
  'function expiry() view returns (uint32)',
  'function takerFeeBps() view returns (uint16)',
  'function halfSpreadBps() view returns (uint16)',
  'function initialMarginBps() view returns (uint16)',
  'function maxOracleAgeSeconds() view returns (uint32)',
  'function collateralScale() view returns (uint256)',
  'function opensPaused() view returns (bool)',
]);

export const CHAINLINK_AGGREGATOR_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

export const UNISWAP_V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function fee() view returns (uint24)',
]);

export const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address recipient, uint256 amount) returns (bool)',
]);

export interface TestPerpMarketParameters {
  readonly takerFeeBps: bigint;
  readonly initialMarginBps: bigint;
  /** WAD per collateral atom (`10 ** (18 - collateralDecimals)`). */
  readonly collateralScale: bigint;
}

export interface TestPerpEntryLimits {
  readonly minimumPostPerpBalanceWad: bigint;
  readonly maximumPostPerpBalanceWad: bigint;
  readonly maximumPostPerpEntryNotionalWad: bigint;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parameters(market: TestPerpMarketParameters): TestPerpMarketParameters {
  requireCondition(
    typeof market.takerFeeBps === 'bigint' && market.takerFeeBps >= 0n && market.takerFeeBps <= 100n,
    'test perp taker fee is outside its range',
  );
  requireCondition(
    typeof market.initialMarginBps === 'bigint' && market.initialMarginBps > 0n && market.initialMarginBps <= BPS,
    'test perp initial margin is outside its range',
  );
  requireCondition(
    typeof market.collateralScale === 'bigint' && market.collateralScale > 0n,
    'test perp collateral scale must be positive',
  );
  return market;
}

/** The market's taker fee: rounded up in WAD, then up to a whole collateral atom. */
export function testPerpFeeWad(notionalWad: bigint, market: TestPerpMarketParameters): bigint {
  const checked = parameters(market);
  requireCondition(typeof notionalWad === 'bigint' && notionalWad >= 0n, 'notional must be nonnegative');
  const fee = mulDiv(notionalWad, checked.takerFeeBps, BPS, 'CEIL', 'testPerpFeeWad');
  return ((fee + checked.collateralScale - 1n) / checked.collateralScale) * checked.collateralScale;
}

/**
 * Entry postcondition ranges for an open drawing `balanceWad` from the reserve. The fill is priced
 * from the oracle at execution, so the entry notional may move by `oracleMoveAllowanceBps` from the
 * `previewOpen` notional; the post balance is the balance less the fee at either end of that range.
 * Fails closed when the worst case would not clear the market's initial margin.
 */
export function deriveTestPerpEntryLimits(input: Readonly<{
  previewEntryNotionalWad: bigint;
  balanceWad: bigint;
  oracleMoveAllowanceBps: bigint;
  market: TestPerpMarketParameters;
}>): TestPerpEntryLimits {
  const market = parameters(input.market);
  const allowance = input.oracleMoveAllowanceBps;
  requireCondition(typeof allowance === 'bigint' && allowance >= 0n && allowance < BPS, 'oracle move allowance is outside its range');
  requireCondition(
    typeof input.previewEntryNotionalWad === 'bigint' && input.previewEntryNotionalWad > 0n,
    'preview entry notional must be positive',
  );
  const balance = input.balanceWad;
  requireCondition(typeof balance === 'bigint' && balance > 0n && balance <= INT128_MAX, 'perp balance delta must be a positive int128');
  requireCondition(balance % market.collateralScale === 0n, 'perp balance delta must be whole collateral atoms');
  const maximumNotional = mulDiv(input.previewEntryNotionalWad, BPS + allowance, BPS, 'CEIL', 'maximumEntryNotional');
  const minimumNotional = mulDiv(input.previewEntryNotionalWad, BPS - allowance, BPS, 'FLOOR', 'minimumEntryNotional');
  requireCondition(maximumNotional <= UINT128_MASK, 'maximum entry notional exceeds uint128');
  const maximumFee = testPerpFeeWad(maximumNotional, market);
  const minimumFee = testPerpFeeWad(minimumNotional, market);
  requireCondition(balance > maximumFee, 'perp margin does not cover the worst-case taker fee');
  const requiredMargin = mulDiv(maximumNotional, market.initialMarginBps, BPS, 'CEIL', 'requiredInitialMargin');
  requireCondition(balance - maximumFee >= requiredMargin, 'perp margin does not clear initial margin at the oracle allowance');
  return Object.freeze({
    minimumPostPerpBalanceWad: balance - maximumFee,
    maximumPostPerpBalanceWad: balance - minimumFee,
    maximumPostPerpEntryNotionalWad: maximumNotional,
  });
}

function word(value: bigint): Hash32 {
  return Uint8Array.from(Buffer.from(value.toString(16).padStart(64, '0'), 'hex')) as Hash32;
}

/**
 * `trade(bytes32[2])` arguments: the header packs `deadline << 56 | expiry`; the second word packs
 * `uint128(sizeDelta) << 128 | uint128(balanceDelta)` as two's-complement int128 halves.
 */
export function encodeTestPerpTradeArgs(input: Readonly<{
  deadline: bigint;
  expiry: number;
  sizeDeltaWad: bigint;
  balanceDeltaWad: bigint;
}>): readonly [Hash32, Hash32] {
  requireCondition(typeof input.deadline === 'bigint' && input.deadline > 0n && input.deadline <= UINT64_MAX, 'trade deadline must be a positive uint64');
  requireCondition(Number.isSafeInteger(input.expiry) && input.expiry > 0 && input.expiry <= 0xffff_ffff, 'perp expiry must be a nonzero uint32');
  for (const [value, name] of [[input.sizeDeltaWad, 'sizeDeltaWad'], [input.balanceDeltaWad, 'balanceDeltaWad']] as const) {
    requireCondition(typeof value === 'bigint' && value >= -(1n << 127n) && value <= INT128_MAX, `${name} is outside int128`);
  }
  requireCondition(input.sizeDeltaWad !== 0n, 'size delta must be nonzero');
  const header = (input.deadline << 56n) | BigInt(input.expiry);
  const packed = ((input.sizeDeltaWad & UINT128_MASK) << 128n) | (input.balanceDeltaWad & UINT128_MASK);
  return Object.freeze([word(header), word(packed)] as const);
}
