import { equalAddress, equalHash, requiredEvmAddress } from '@naryx/adapter-evm';
import { parseAbi, type Abi, type Address, type Hex } from 'viem';

/**
 * The canonical Uniswap V3 QuoterV2. Its quote functions simulate the swap and revert with the result,
 * so on chain they are not view functions; they are declared view here because the solver only ever
 * reaches them through a signerless eth_call.
 */
export const UNISWAP_V3_QUOTER_V2_ABI = parseAbi([
  'function factory() view returns (address)',
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
const POOL_ABI = parseAbi(['function factory() view returns (address)']);
// The price limits the spot port swaps to; with no limit the quoter swaps to the same ones.
const MIN_SQRT_RATIO_PLUS_ONE = 4_295_128_740n;
const MAX_SQRT_RATIO_MINUS_ONE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n;

/** Signerless reads. Chain identity always comes from eth_chainId, never from the RPC URL. */
export interface UniswapV3QuoterReadPort {
  chainId(): Promise<bigint>;
  codeHash(address: Address): Promise<Hex | undefined>;
  readContract(request: Readonly<{
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }>): Promise<unknown>;
}

/** The lane's pinned quoter and the exact pool, tokens, and fee its spot port swaps through. */
export type UniswapV3SpotQuoteTarget = Readonly<{
  chainId: bigint;
  quoter: Readonly<{ address: Address; expectedCodeHash: Hex }>;
  pool: Address;
  baseToken: Address;
  quoteToken: Address;
  poolFee: bigint;
}>;

// Matched by name along the cause chain, not instanceof, so a read port built on another copy of
// viem still reports its revert as one.
function isRevert(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < 8 && cause instanceof Error; depth += 1, cause = cause.cause) {
    if (cause.name === 'ContractFunctionRevertedError') return true;
  }
  return false;
}

/**
 * Checked before every quote, as the API checks it: the chain, the reviewed quoter runtime code
 * (which embeds its factory), and that this factory created the spot pool, so the quoter simulates
 * exactly that pool. Then one signerless eth_call; a revert means the pool cannot fill the size.
 */
async function quote(
  port: UniswapV3QuoterReadPort,
  target: UniswapV3SpotQuoteTarget,
  functionName: 'quoteExactInputSingle' | 'quoteExactOutputSingle',
  params: Readonly<Record<string, unknown>>,
  refusal: string,
): Promise<readonly unknown[]> {
  if (await port.chainId() !== target.chainId) throw new Error(`Uniswap V3 quoter RPC eth_chainId is not ${target.chainId}`);
  if (target.poolFee <= 0n || target.poolFee >= 1_000_000n) throw new Error('Uniswap V3 pool fee is invalid');
  const quoter = requiredEvmAddress(target.quoter.address, 'spotQuoter.address');
  const [code, quoterFactory, poolFactory] = await Promise.all([
    port.codeHash(quoter),
    port.readContract({ address: quoter, abi: UNISWAP_V3_QUOTER_V2_ABI, functionName: 'factory' }),
    port.readContract({ address: requiredEvmAddress(target.pool, 'spot pool'), abi: POOL_ABI, functionName: 'factory' }),
  ]);
  if (code === undefined || !equalHash(code, target.quoter.expectedCodeHash)) {
    throw new Error('Uniswap V3 quoter code does not match the reviewed identity');
  }
  if (!equalAddress(requiredEvmAddress(String(quoterFactory), 'quoter.factory'),
    requiredEvmAddress(String(poolFactory), 'pool.factory'))) {
    throw new Error('Uniswap V3 quoter does not quote the spot pool factory');
  }
  try {
    return await port.readContract({
      address: quoter,
      abi: UNISWAP_V3_QUOTER_V2_ABI,
      functionName,
      args: [{ ...params, fee: Number(target.poolFee), sqrtPriceLimitX96: 0n }],
    }) as readonly unknown[];
  } catch (error) {
    if (isRevert(error)) throw new Error(refusal);
    throw error;
  }
}

/** Quote atoms an exact-output buy of exactly `baseAtoms` costs now, pool fee and price impact included. */
export async function quoteUniswapV3Buy(
  port: UniswapV3QuoterReadPort,
  target: UniswapV3SpotQuoteTarget,
  baseAtoms: bigint,
): Promise<bigint> {
  if (typeof baseAtoms !== 'bigint' || baseAtoms <= 0n) throw new Error('spot quote size must be positive');
  const [amountIn] = await quote(port, target, 'quoteExactOutputSingle', {
    tokenIn: target.quoteToken, tokenOut: target.baseToken, amount: baseAtoms,
  }, 'spot pool cannot fill this size within its liquidity; nothing was signed');
  if (typeof amountIn !== 'bigint' || amountIn <= 0n) throw new Error('Uniswap V3 quoter returned an invalid amount');
  return amountIn;
}

/**
 * Quote atoms an exact-input sale of exactly `baseAtoms` returns now. The quoter returns a partial
 * result when the pool runs out of liquidity first; the spot port reverts that sale, so a sale that
 * ends at the swap's price limit is refused as well.
 */
export async function quoteUniswapV3Sell(
  port: UniswapV3QuoterReadPort,
  target: UniswapV3SpotQuoteTarget,
  baseAtoms: bigint,
): Promise<bigint> {
  if (typeof baseAtoms !== 'bigint' || baseAtoms <= 0n) throw new Error('spot quote size must be positive');
  const refusal = 'spot pool cannot absorb this spot sale within its liquidity; nothing was signed';
  const [amountOut, sqrtPriceX96After] = await quote(port, target, 'quoteExactInputSingle', {
    tokenIn: target.baseToken, tokenOut: target.quoteToken, amountIn: baseAtoms,
  }, refusal);
  if (typeof amountOut !== 'bigint' || typeof sqrtPriceX96After !== 'bigint') {
    throw new Error('Uniswap V3 quoter returned an invalid amount');
  }
  const zeroForOne = BigInt(target.baseToken) < BigInt(target.quoteToken);
  if (amountOut <= 0n || sqrtPriceX96After === (zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE)) {
    throw new Error(refusal);
  }
  return amountOut;
}
