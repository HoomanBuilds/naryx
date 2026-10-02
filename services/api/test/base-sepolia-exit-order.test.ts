import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adapterRef, assetRef, domainRef, exactPrice, exactSignedRate, toHex } from "@naryx/protocol-types";
import { ContractFunctionRevertedError, getAddress, type Address } from "viem";
import {
  BaseSepoliaExitOrderError,
  baseSepoliaExitLimits,
  createBaseSepoliaExitOrderService,
} from "../src/base-sepolia-exit-order.js";
import type { BaseSepoliaAtomicDeploymentConfiguration } from "../src/base-sepolia-atomic-context-provider.js";
import type { BaseSepoliaOrderRuntime } from "../src/base-sepolia-order-context.js";
import { EntryOrderValidationError, type ActiveOrderContext } from "../src/canonical-entry-order.js";
import { SqliteInternalOrderStore } from "../src/internal-order-store.js";

const Q96 = 1n << 96n;
const SCALE = 1_000_000_000_000n;
const QUANTITY = 10_000_000n;
const ENTRY_NOTIONAL_WAD = 2_600_000n * SCALE + 123n;
const market = { takerFeeBps: 5n, initialMarginBps: 1_000n, collateralScale: SCALE };
// Base is token1 at sqrtP = 2, so the mid is a quarter quote atom per base atom; the fee is 0.3%.
const pool = { sqrtPriceX96: 2n * Q96, baseIsToken0: false, poolFee: 3_000n };
const position = { balanceWad: 1_000_000n * SCALE, sizeWad: -QUANTITY, entryNotionalWad: ENTRY_NOTIONAL_WAD, entryFundingIndex: 0n };
// The pool mid less the 0.3% fee: what a sale with no price impact would return.
const MID_PROCEEDS = 2_492_500n;
const limitsInput = {
  quantityAtoms: QUANTITY,
  quoteDecimals: 6,
  pool,
  spotQuoteOutAtoms: MID_PROCEEDS,
  position,
  entryPerpNotionalWad: ENTRY_NOTIONAL_WAD,
  previewCloseNotionalWad: 2_500_000n * SCALE,
  currentFundingIndex: 0n,
  market,
  slippageBps: 50,
};

const rejectsWith = (code: string) => (error: unknown) => error instanceof BaseSepoliaExitOrderError && error.code === code;

test("prices exit minimums from the pool and the market buy-back, rounded against the trader", () => {
  const limits = baseSepoliaExitLimits(limitsInput);
  // 10,000,000 base atoms at a quarter, less the 0.3% pool fee and 50 bps: 2,480,037.5 floors.
  assert.equal(limits.minSpotQuoteOutAtoms, 2_480_037n);
  // The order commits the WAD entry notional floored to quote atoms.
  assert.equal(limits.entryNotionalAtoms, 2_600_000n);
  // Buy-back at 2,512,500 (2,500,000 plus 50 bps) and a 1,257-atom fee leave a payout of 1,086,243
  // atoms against 1,000,000 of margin: 86,243 atoms of perp outcome on top of the spot floor.
  assert.equal(limits.minExitQuoteOutcomeAtoms, 2_480_037n + 86_243n);
  // A thin pool's executable proceeds below the mid figure set the floor: 2,400,000 less 50 bps.
  const thin = baseSepoliaExitLimits({ ...limitsInput, spotQuoteOutAtoms: 2_400_000n });
  assert.equal(thin.minSpotQuoteOutAtoms, 2_388_000n);
  assert.equal(thin.minExitQuoteOutcomeAtoms, 2_388_000n + 86_243n);
  // Quoted proceeds above the mid figure never raise the floor.
  assert.equal(baseSepoliaExitLimits({ ...limitsInput, spotQuoteOutAtoms: 3_000_000n }).minSpotQuoteOutAtoms, 2_480_037n);
  // A wiped-out margin larger than the spot floor never signs a negative outcome.
  const underwater = baseSepoliaExitLimits({
    ...limitsInput,
    position: { ...position, balanceWad: 3_000_000n * SCALE },
    previewCloseNotionalWad: 9_000_000n * SCALE,
  });
  assert.equal(underwater.minExitQuoteOutcomeAtoms, 0n);
});

test("refuses an exit whose short or entry notional is not the open package's, or out-of-range slippage", () => {
  assert.throws(() => baseSepoliaExitLimits({ ...limitsInput, position: { ...position, sizeWad: -QUANTITY + 1n } }), rejectsWith("PERP_POSITION_MISMATCH"));
  assert.throws(() => baseSepoliaExitLimits({ ...limitsInput, entryPerpNotionalWad: ENTRY_NOTIONAL_WAD + 1n }), rejectsWith("PERP_POSITION_MISMATCH"));
  assert.throws(() => baseSepoliaExitLimits({ ...limitsInput, slippageBps: 0 }), rejectsWith("INVALID_SLIPPAGE"));
  assert.throws(() => baseSepoliaExitLimits({ ...limitsInput, quantityAtoms: 1n, position: { ...position, sizeWad: -1n } }), rejectsWith("EXIT_TOO_SMALL"));
});

const address = (byte: number) => getAddress(`0x${byte.toString(16).padStart(2, "0").repeat(20)}`);
const owner = address(0x11);
const account = address(0x12);
const factory = address(0x13);
const verifier = address(0x14);
const marketAddress = address(0x15);
const baseToken = address(0x16);
const quoteToken = address(0x17);
const quoter = address(0x18);
const accountCodeHash = `0x${"aa".repeat(32)}`;
const entryReceiptHash = `0x${"5e".repeat(32)}`;

function context(): ActiveOrderContext {
  const base = assetRef("base-weth", "22".repeat(32), 18);
  const quote = assetRef("base-usdc", "33".repeat(32), 6);
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
    spotReferencePrice: exactPrice({ baseAsset: base, quoteAsset: quote, quoteAtoms: 1n, baseAtoms: 4n, roundingDirection: "CEIL" }),
    maxEntrySpread: exactSignedRate({ baseAsset: base, quoteAsset: quote, quoteAtoms: 1n, baseAtoms: 400n, roundingDirection: "CEIL" }),
    maximumQuantityAtoms: 1_000_000_000_000_000_000n,
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

function service(orders: SqliteInternalOrderStore, open: Readonly<Record<string, unknown>>, quoted: () => unknown = () => [MID_PROCEEDS, Q96, 1, 0n]) {
  const active = context();
  const runtime = {
    contexts: (contextId: string) => contextId === active.contextId ? active : undefined,
    feed: { refresh: async () => ({ ...pool, observedAt: 1_000n }) },
    config: {
      contextId: active.contextId, maxSlippageBps: 100, quoteAsset: active.quoteAsset,
      spotQuoter: { address: quoter, expectedCodeHash: `0x${"cc".repeat(32)}` },
    },
  } as unknown as Pick<BaseSepoliaOrderRuntime, "contexts" | "feed" | "config">;
  const deployment = {
    deployment: {
      strategyAccountFactory: { address: factory },
      strategyAccountCodeHash: accountCodeHash,
      packageVerifier: { address: verifier },
      perpetual: { market: { address: marketAddress } },
      baseAsset: { address: baseToken },
      quoteAsset: { address: quoteToken },
    },
  } as unknown as BaseSepoliaAtomicDeploymentConfiguration;
  const port = {
    chainId: async () => 84_532n,
    latestBlockTimestamp: async () => 1_010n,
    codeHash: async (target: Address) => target === account ? accountCodeHash : undefined,
    readContract: async (read: { address: Address; functionName: string }) => {
      switch (read.functionName) {
        case "accountOf": return account;
        case "verifier": return verifier;
        case "owner": return owner;
        case "openPackage": return open;
        case "expiry": return 4_294_967_295;
        case "getPosition": return { balance: position.balanceWad, size: position.sizeWad, entryNotional: ENTRY_NOTIONAL_WAD, entrySocialLossIndex: 0n, entryFundingIndex: 0n };
        case "previewOpen": return [0n, 2_500_000n * SCALE, 0n, 0n];
        case "currentFundingIndex": return 0n;
        case "collateralScale": return SCALE;
        case "takerFeeBps": return 5;
        case "initialMarginBps": return 1_000;
        case "quoteExactInputSingle": return quoted();
        default: throw new Error(`unexpected read ${read.functionName}`);
      }
    },
  };
  return createBaseSepoliaExitOrderService({ runtime, deployment, port: port as never, orders });
}

const openPackage = {
  entryReceiptHash,
  routeHash: `0x${"77".repeat(32)}`,
  perpInstrument: marketAddress,
  perpExpiry: 4_294_967_295,
  baseToken,
  quoteToken,
  baseQuantityAtoms: QUANTITY,
  perpQuantityWad: QUANTITY,
  packageSizeUnits: 1n,
  entryPerpNotionalWad: ENTRY_NOTIONAL_WAD,
};

test("stores the canonical EXIT order for the owner's open package read from chain", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-base-exit-"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  try {
    const exits = service(orders, openPackage);
    const request = { owner: owner.toLowerCase(), slippageBps: 50, idempotencyKey: "base-exit-order-0001" };
    const created = await exits.createExitOrder(request);
    assert.equal(created.created, true);
    assert.equal(created.quantityAtoms, QUANTITY);
    const order = orders.getCanonicalOrderByHash(created.record.orderHashHex)!;
    assert.equal(order.action, "EXIT");
    assert.equal(order.owner, owner);
    assert.equal(order.settlementAccount, account);
    assert.equal(`0x${toHex(order.entryReceiptHash!)}`, entryReceiptHash);
    assert.equal(order.quantity.atoms, QUANTITY);
    assert.equal(order.expectedPrePositionSize.atoms, -QUANTITY);
    assert.equal(order.expectedPrePositionEntryNotional.atoms, 2_600_000n);
    assert.equal(order.minSpotQuoteOut?.atoms, 2_480_037n);
    assert.equal(order.minExitQuoteOutcome?.atoms, 2_566_280n);
    assert.equal(order.maxMarginAdded.atoms, 0n);
    assert.equal((await exits.createExitOrder(request)).created, false);
    await assert.rejects(exits.createExitOrder({ ...request, slippageBps: 101 }), rejectsWith("INVALID_SLIPPAGE"));
  } finally {
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("fails closed without an open package or with one on another market", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-base-exit-"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  try {
    const request = { owner, slippageBps: 50, idempotencyKey: "base-exit-order-0002" };
    await assert.rejects(
      service(orders, { ...openPackage, entryReceiptHash: `0x${"00".repeat(32)}` }).createExitOrder(request),
      rejectsWith("NO_OPEN_PACKAGE"),
    );
    await assert.rejects(
      service(orders, { ...openPackage, perpInstrument: address(0x19) }).createExitOrder(request),
      rejectsWith("OPEN_PACKAGE_MISMATCH"),
    );
    // A pool that cannot absorb the whole sale refuses before any order is stored.
    const reverted = () => { throw new ContractFunctionRevertedError({ abi: [], functionName: "quoteExactInputSingle", message: "Unexpected error" }); };
    await assert.rejects(
      service(orders, openPackage, reverted).createExitOrder(request),
      (error: unknown) => error instanceof EntryOrderValidationError && error.code === "INSUFFICIENT_LIQUIDITY",
    );
    assert.equal(orders.getByIdempotencyKey(request.idempotencyKey), undefined);
  } finally {
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
