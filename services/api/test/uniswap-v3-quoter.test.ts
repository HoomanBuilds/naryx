import assert from "node:assert/strict";
import test from "node:test";
import { adapterRef, assetRef, domainRef, exactPrice, exactSignedRate } from "@naryx/protocol-types";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
} from "viem";
import { EntryOrderValidationError, type ActiveOrderContext } from "../src/canonical-entry-order.js";
import type { InternalOrderInput, InternalOrderStore } from "../src/internal-order-store.js";
import { InternalOrderCoordinator } from "../src/terminal-orders.js";
import {
  UNISWAP_V3_QUOTER_V2_ABI,
  executableSpotPrice,
  quoteUniswapV3Buy,
  quoteUniswapV3Sell,
  verifyUniswapV3Quoter,
  type UniswapV3QuoterReadPort,
  type UniswapV3SpotQuoteTarget,
} from "../src/uniswap-v3-quoter.js";

const address = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(20)}` as Address;
const word = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex;
const base = assetRef("eip155:84532:weth", "22".repeat(32), 18);
const quote = assetRef("eip155:84532:usdc", "33".repeat(32), 6);
// Base sorts below quote, so a sale is zeroForOne and its price limit is MIN_SQRT_RATIO + 1.
const target: UniswapV3SpotQuoteTarget = Object.freeze({
  chainId: 84_532n,
  quoter: { address: address(0x18), expectedCodeHash: word(0xcc) },
  baseToken: address(0x16),
  quoteToken: address(0x17),
  poolFee: 500n,
});
const SIZE = 10n ** 16n;
const reverted = (functionName: string) => new ContractFunctionRevertedError({
  abi: UNISWAP_V3_QUOTER_V2_ABI, functionName, message: "Unexpected error",
});
const insufficient = (error: unknown) => error instanceof EntryOrderValidationError && error.code === "INSUFFICIENT_LIQUIDITY";

type Call = Readonly<{ address: Address; functionName: string; args?: readonly unknown[] }>;

function port(answer: (call: Call) => unknown, chainId = 84_532n): UniswapV3QuoterReadPort & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    chainId: async () => chainId,
    codeHash: async (target) => target === address(0x18) ? word(0xcc) : undefined,
    readContract: async (call) => {
      calls.push(call);
      return answer(call);
    },
  };
}

function context(): ActiveOrderContext {
  return Object.freeze({
    contextId: "base-sepolia-cash-carry",
    state: "ACTIVE",
    capturedAtClock: 1_000n,
    maxStaleness: 60n,
    domain: domainRef("eip155:84532", 2, "11".repeat(32)),
    environment: "testnet",
    orderVersion: 1,
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: "44".repeat(32),
    baseAsset: base,
    quoteAsset: quote,
    spotAdapters: [adapterRef({ adapterId: "uniswap-v3-spot", adapterManifestVersion: 1, adapterManifestHash: "55".repeat(32) })],
    perpAdapters: [adapterRef({ adapterId: "package-verifier-perp", adapterManifestVersion: 1, adapterManifestHash: "66".repeat(32) })],
    settlementClass: "ATOMIC_POSTCONDITION",
    expiryUnit: "EVM_UNIX_SECONDS",
    expiryTtl: 300n,
    // A 2500 USDC mid ask: 0.01 WETH would cost 25 USDC with no price impact.
    spotReferencePrice: exactPrice({ baseAsset: base, quoteAsset: quote, quoteAtoms: 1n, baseAtoms: 400_000_000n, roundingDirection: "CEIL" }),
    maxEntrySpread: exactSignedRate({ baseAsset: base, quoteAsset: quote, quoteAtoms: 1n, baseAtoms: 400n, roundingDirection: "CEIL" }),
    maximumQuantityAtoms: 10n ** 18n,
    maxSlippageBps: 100,
    maxVenueFeeAtomsByAsset: [{ asset: quote, maxAtoms: 10_000_000n }],
    maxMarginAddedAtoms: 1_000_000_000n,
    maxProtocolFeeAtoms: 0n,
    maxSolverFeeAtoms: 0n,
    maxPriorityFeeAtoms: 0n,
    minVenueReserveReturnedAtoms: 0n,
    minWalletQuoteBalanceDeltaAtoms: 0n,
    maxResidualBaseQuantityAtoms: 0n,
  });
}

function coordinator(reads: UniswapV3QuoterReadPort) {
  const active = context();
  const stored: InternalOrderInput[] = [];
  const store = {
    createOrGet: (input: InternalOrderInput) => {
      stored.push(input);
      return { record: {} as never, created: true };
    },
  } as unknown as InternalOrderStore;
  const orders = new InternalOrderCoordinator({
    contexts: (contextId) => contextId === active.contextId ? active : undefined,
    store,
    clock: { currentClock: async () => 1_010n },
    spotPrice: {
      entrySpotPrice: async (_, sizeAtoms) =>
        executableSpotPrice(base, quote, await quoteUniswapV3Buy(reads, target, sizeAtoms), sizeAtoms),
    },
  });
  const create = () => orders.createOrder({
    contextId: active.contextId,
    owner: address(0x11),
    settlementAccount: address(0x12),
    size: "0.01",
    slippageBps: 100,
    idempotencyKey: "quoter-entry-000001",
  });
  return { create, stored };
}

test("entry bound is the quoter's exact-output cost for the exact size plus slippage, rounded up", async () => {
  // 4% price impact: the mid ask bound (25.25 USDC) would revert on chain after the user signed.
  const reads = port(() => [26_000_001n, 2n ** 96n, 1, 0n]);
  const { create, stored } = coordinator(reads);
  await create();
  assert.equal(stored[0]!.order.order.maxSpotQuoteIn?.atoms, 26_260_002n);
  assert.deepEqual(reads.calls, [{
    address: "0x1818181818181818181818181818181818181818",
    abi: UNISWAP_V3_QUOTER_V2_ABI,
    functionName: "quoteExactOutputSingle",
    args: [{ tokenIn: target.quoteToken, tokenOut: target.baseToken, amount: SIZE, fee: 500, sqrtPriceLimitX96: 0n }],
  }]);
});

test("an entry the pool cannot fill is refused before any order is stored; other failures stay failures", async () => {
  for (const error of [
    reverted("quoteExactOutputSingle"),
    // As viem's readContract reports a reverted eth_call.
    new ContractFunctionExecutionError(reverted("quoteExactOutputSingle"), {
      abi: UNISWAP_V3_QUOTER_V2_ABI,
      functionName: "quoteExactOutputSingle",
      args: [{ tokenIn: target.quoteToken, tokenOut: target.baseToken, amount: SIZE, fee: 500, sqrtPriceLimitX96: 0n }],
      contractAddress: target.quoter.address,
    }),
    // The same revert from a read port built on another copy of viem.
    new Error("call failed", { cause: Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" }) }),
  ]) {
    const { create, stored } = coordinator(port(() => { throw error; }));
    await assert.rejects(create(), (cause: unknown) => insufficient(cause) && /smaller size/.test(String(cause)));
    assert.equal(stored.length, 0);
  }
  const outage = new Error("fetch failed");
  await assert.rejects(coordinator(port(() => { throw outage; })).create(), (cause: unknown) => cause === outage);
  const wrongChain = port(() => [26_000_001n, 2n ** 96n, 1, 0n], 8_453n);
  await assert.rejects(coordinator(wrongChain).create(), /eth_chainId is not 84532/);
  assert.equal(wrongChain.calls.length, 0);
});

test("an exit sale returns the quoter's proceeds and is refused when the pool cannot absorb it whole", async () => {
  const reads = port(() => [24_000_000n, 2n ** 96n, 3, 0n]);
  assert.equal(await quoteUniswapV3Sell(reads, target, SIZE), 24_000_000n);
  assert.deepEqual(reads.calls[0]!.args, [{
    tokenIn: target.baseToken, tokenOut: target.quoteToken, amountIn: SIZE, fee: 500, sqrtPriceLimitX96: 0n,
  }]);
  // The swap ran to its price limit: liquidity ended before the whole quantity sold.
  await assert.rejects(quoteUniswapV3Sell(port(() => [1_000n, 4_295_128_740n, 9, 0n]), target, SIZE), insufficient);
  await assert.rejects(quoteUniswapV3Sell(port(() => [0n, 2n ** 96n, 0, 0n]), target, SIZE), insufficient);
  await assert.rejects(quoteUniswapV3Sell(port(() => { throw reverted("quoteExactInputSingle"); }), target, SIZE), insufficient);
});

test("executable spot price is exact when it fits and rounds up into u128 terms when it does not", () => {
  const exact = executableSpotPrice(base, quote, 26_000_000n, SIZE);
  assert.deepEqual([exact.quoteAtoms, exact.baseAtoms, exact.roundingDirection], [13n, 5_000_000_000n, "CEIL"]);
  const quoteAtoms = 3n ** 100n;
  const baseAtoms = (1n << 140n) + 1n;
  const wide = executableSpotPrice(base, quote, quoteAtoms, baseAtoms);
  assert.ok(wide.quoteAtoms < 1n << 128n && wide.baseAtoms < 1n << 128n);
  // Never below the exact price, and above it by less than one numerator atom.
  assert.ok(wide.quoteAtoms * baseAtoms >= quoteAtoms * wide.baseAtoms);
  assert.ok((wide.quoteAtoms - 1n) * baseAtoms < quoteAtoms * wide.baseAtoms);
});

test("the quoter identity is the pinned code on the lane's chain quoting the spot pool's factory", async () => {
  const pool = address(0x88);
  const factories = (quoterFactory: Address) => port((call) => call.address === pool ? address(0x57) : quoterFactory);
  await verifyUniswapV3Quoter(factories(address(0x57)), target, pool);
  await assert.rejects(verifyUniswapV3Quoter(factories(address(0x58)), target, pool), /factory/);
  await assert.rejects(
    verifyUniswapV3Quoter(factories(address(0x57)), { ...target, quoter: { ...target.quoter, expectedCodeHash: word(0xcd) } }, pool),
    /reviewed identity/,
  );
  await assert.rejects(verifyUniswapV3Quoter(port(() => address(0x57), 421_614n), target, pool), /eth_chainId/);
});
