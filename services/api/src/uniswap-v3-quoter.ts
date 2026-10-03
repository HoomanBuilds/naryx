import { equalAddress, equalHash, requiredEvmAddress, type EvmContractIdentity } from "@naryx/adapter-evm";
import { exactPrice, type AssetRef, type ExactPrice } from "@naryx/protocol-types";
import { parseAbi, type Abi, type Address, type Hex } from "viem";
import { EntryOrderValidationError } from "./canonical-entry-order.js";

/**
 * The canonical Uniswap V3 QuoterV2. Its quote functions simulate the swap and revert with the result,
 * so on chain they are not view functions; they are declared view here because Naryx only ever reaches
 * them through a signerless eth_call.
 */
export const UNISWAP_V3_QUOTER_V2_ABI = parseAbi([
  "function factory() view returns (address)",
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const POOL_ABI = parseAbi(["function factory() view returns (address)"]);
// The price limits the spot port swaps to; with no limit the quoter swaps to the same ones.
const MIN_SQRT_RATIO_PLUS_ONE = 4_295_128_740n;
const MAX_SQRT_RATIO_MINUS_ONE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n;
const U128_MAX = (1n << 128n) - 1n;

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

/** The lane's pinned quoter and the pool its spot port swaps through, named by the pool's tokens and fee. */
export type UniswapV3SpotQuoteTarget = Readonly<{
  chainId: bigint;
  quoter: EvmContractIdentity;
  baseToken: Address;
  quoteToken: Address;
  poolFee: bigint;
}>;

async function requireChain(port: Pick<UniswapV3QuoterReadPort, "chainId">, chainId: bigint): Promise<void> {
  if (await port.chainId() !== chainId) throw new Error(`Uniswap V3 quoter RPC eth_chainId is not ${chainId}.`);
}

/**
 * Startup check of the quoter identity: the chain, the reviewed runtime code (which embeds the
 * quoter's factory), and that this factory created the pool the spot port swaps through, so the
 * quoter simulates exactly that pool.
 */
export async function verifyUniswapV3Quoter(
  port: UniswapV3QuoterReadPort,
  target: Pick<UniswapV3SpotQuoteTarget, "chainId" | "quoter">,
  pool: Address,
): Promise<void> {
  await requireChain(port, target.chainId);
  const quoter = requiredEvmAddress(target.quoter.address, "spotQuoter.address");
  const [code, quoterFactory, poolFactory] = await Promise.all([
    port.codeHash(quoter),
    port.readContract({ address: quoter, abi: UNISWAP_V3_QUOTER_V2_ABI, functionName: "factory" }),
    port.readContract({ address: requiredEvmAddress(pool, "spot pool"), abi: POOL_ABI, functionName: "factory" }),
  ]);
  if (code === undefined || !equalHash(code, target.quoter.expectedCodeHash)) {
    throw new Error("Uniswap V3 quoter code does not match the reviewed identity.");
  }
  if (!equalAddress(requiredEvmAddress(String(quoterFactory), "quoter.factory"),
    requiredEvmAddress(String(poolFactory), "pool.factory"))) {
    throw new Error("Uniswap V3 quoter does not quote the spot pool's factory.");
  }
}

function insufficientLiquidity(message: string): EntryOrderValidationError {
  return new EntryOrderValidationError("INSUFFICIENT_LIQUIDITY", message);
}

// Matched by name along the cause chain, not instanceof, so a read port built on another copy of
// viem still reports its revert as one.
function isRevert(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < 8 && cause instanceof Error; depth += 1, cause = cause.cause) {
    if (cause.name === "ContractFunctionRevertedError") return true;
  }
  return false;
}

async function quote(
  port: UniswapV3QuoterReadPort,
  target: UniswapV3SpotQuoteTarget,
  functionName: "quoteExactInputSingle" | "quoteExactOutputSingle",
  params: Readonly<Record<string, unknown>>,
  refusal: string,
): Promise<readonly unknown[]> {
  await requireChain(port, target.chainId);
  if (target.poolFee <= 0n || target.poolFee >= 1_000_000n) throw new Error("Uniswap V3 pool fee is invalid.");
  try {
    return await port.readContract({
      address: requiredEvmAddress(target.quoter.address, "spotQuoter.address"),
      abi: UNISWAP_V3_QUOTER_V2_ABI,
      functionName,
      args: [{ ...params, fee: Number(target.poolFee), sqrtPriceLimitX96: 0n }],
    }) as readonly unknown[];
  } catch (error) {
    // The quoter reverts when the pool cannot deliver the exact amount; other failures stay failures.
    if (isRevert(error)) throw insufficientLiquidity(refusal);
    throw error;
  }
}

/** Quote atoms an exact-output buy of exactly `baseAtoms` costs now, pool fee and price impact included. */
export async function quoteUniswapV3Buy(
  port: UniswapV3QuoterReadPort,
  target: UniswapV3SpotQuoteTarget,
  baseAtoms: bigint,
): Promise<bigint> {
  if (typeof baseAtoms !== "bigint" || baseAtoms <= 0n) throw new Error("Spot quote size must be positive.");
  const [amountIn] = await quote(port, target, "quoteExactOutputSingle", {
    tokenIn: target.quoteToken, tokenOut: target.baseToken, amount: baseAtoms,
  }, "The spot pool cannot fill this size within its liquidity right now. Nothing was signed; try a smaller size.");
  if (typeof amountIn !== "bigint" || amountIn <= 0n) throw new Error("Uniswap V3 quoter returned an invalid amount.");
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
  if (typeof baseAtoms !== "bigint" || baseAtoms <= 0n) throw new Error("Spot quote size must be positive.");
  const refusal = "The spot pool cannot absorb this package's spot sale right now. Nothing was signed; try the exit again later.";
  const [amountOut, sqrtPriceX96After] = await quote(port, target, "quoteExactInputSingle", {
    tokenIn: target.baseToken, tokenOut: target.quoteToken, amountIn: baseAtoms,
  }, refusal);
  if (typeof amountOut !== "bigint" || typeof sqrtPriceX96After !== "bigint") {
    throw new Error("Uniswap V3 quoter returned an invalid amount.");
  }
  const zeroForOne = BigInt(target.baseToken) < BigInt(target.quoteToken);
  if (amountOut <= 0n || sqrtPriceX96After === (zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE)) {
    throw insufficientLiquidity(refusal);
  }
  return amountOut;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/**
 * `quoteAtoms / baseAtoms` as a reduced CEIL price. Terms too wide for u128 shrink the denominator and
 * round the numerator up, so the price only ever rounds against the trader's quote budget, never below.
 */
export function executableSpotPrice(
  baseAsset: AssetRef,
  quoteAsset: AssetRef,
  quoteAtoms: bigint,
  baseAtoms: bigint,
): ExactPrice {
  if (quoteAtoms <= 0n || baseAtoms <= 0n) throw new Error("Executable spot price terms must be positive.");
  let divisor = gcd(quoteAtoms, baseAtoms);
  let numerator = quoteAtoms / divisor;
  let denominator = baseAtoms / divisor;
  if (numerator > U128_MAX || denominator > U128_MAX) {
    const shift = BigInt((numerator > denominator ? numerator : denominator).toString(2).length - 127);
    const scaled = denominator >> shift;
    if (scaled === 0n) throw new Error("Executable spot price exceeds u128 terms.");
    numerator = (numerator * scaled + denominator - 1n) / denominator;
    denominator = scaled;
    divisor = gcd(numerator, denominator);
    numerator /= divisor;
    denominator /= divisor;
  }
  return exactPrice({ baseAsset, quoteAsset, quoteAtoms: numerator, baseAtoms: denominator, roundingDirection: "CEIL" });
}
