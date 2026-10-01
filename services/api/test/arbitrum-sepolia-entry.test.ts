import assert from "node:assert/strict";
import test from "node:test";
import { EVM_RUNTIME_IDENTITY } from "@naryx/adapter-evm";
import { adapterRef, assetRef, domainManifest, type Hash32 } from "@naryx/protocol-types";
import type { Address, Hex } from "viem";
import {
  ARBITRUM_SEPOLIA_GMX_DEPENDENCIES,
  type ArbitrumSepoliaAsyncDeploymentConfiguration,
} from "../src/arbitrum-sepolia-async-context-provider.js";
import {
  HttpArbitrumSepoliaAttemptExecutor,
  withArbitrumSepoliaExecutionHandoff,
} from "../src/arbitrum-sepolia-executor-client.js";
import {
  createArbitrumSepoliaOrderRuntime,
  type ArbitrumSepoliaOrderContextConfig,
  type ArbitrumSepoliaPriceReadPort,
} from "../src/arbitrum-sepolia-order-context.js";
import { createCanonicalEntryOrder, EntryOrderValidationError } from "../src/canonical-entry-order.js";
import type { EvmTestnetAsyncObservationDto } from "../src/evm-testnet-runtime-ports.js";

const hash = (byte: number): Hash32 => new Uint8Array(32).fill(byte) as Hash32;
const evmAddress = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(20)}` as Address;
const identity = (address: Address, byte: number) => ({
  address,
  expectedCodeHash: `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex,
});
const owner = evmAddress(0x33);
const isolatedAccount = evmAddress(3);
const priceFeed = identity(evmAddress(0x55), 0x55);
const base = assetRef("eip155:421614:weth", hash(2), 18);
const quote = assetRef("eip155:421614:usdc", hash(3), 6);

function deployment(): ArbitrumSepoliaAsyncDeploymentConfiguration {
  const manifest = domainManifest({
    manifestVersion: 1,
    environment: "testnet",
    domainId: "eip155:421614",
    runtimeClassId: EVM_RUNTIME_IDENTITY.runtimeClassId,
    runtimeClassVersion: EVM_RUNTIME_IDENTITY.runtimeClassVersion,
    chainNamespace: EVM_RUNTIME_IDENTITY.chainNamespace,
    chainReference: "421614",
    executionVerifierId: EVM_RUNTIME_IDENTITY.executionVerifierId,
    executionVerifierCodeHash: hash(70),
    clockModelId: EVM_RUNTIME_IDENTITY.clockModelId,
    finalityPolicyHash: hash(71),
    addressCodecId: EVM_RUNTIME_IDENTITY.addressCodecId,
    supportedSettlementClasses: ["ASYNC_BONDED_SOLVER"],
  });
  return {
    admission: {} as ArbitrumSepoliaAsyncDeploymentConfiguration["admission"],
    domainManifest: manifest,
    protocolConfig: identity(evmAddress(1), 1),
    coordinator: identity(evmAddress(2), 2),
    isolatedAccount: identity(isolatedAccount, 3),
    entryAdapter: identity(evmAddress(4), 4),
    orderVerifier: identity(evmAddress(5), 5),
    market: identity(evmAddress(6), 6),
    collateralToken: identity(evmAddress(7), 7),
    gmx: Object.fromEntries(Object.entries(ARBITRUM_SEPOLIA_GMX_DEPENDENCIES).map(
      ([name, dependency], index) => [name, identity(dependency, 20 + index)],
    )) as ArbitrumSepoliaAsyncDeploymentConfiguration["gmx"],
    executionClassManifestHash: hash(30),
    route: {
      perpetualAdapterId: "gmx-v2-arbitrum",
      perpetualMarketId: "gmx-eth-usd",
      perpetualVenueId: "gmx-v2",
      evidenceProfileId: "gmx-v2-callback-v1",
      seriesIdentityKey: hash(31),
      seriesBindingVersion: 1,
      seriesBindingHash: hash(32),
      stateReferenceSchemaHash: hash(33),
      receiptSchemaHash: hash(34),
      outcomeSchemaHash: hash(35),
      coordinatorEvidenceSchemaHash: hash(36),
    },
    bounds: {
      maximumRouteExpiryValue: 2_000_000_000n,
      maximumRecoveryDeadlineValue: 2_000_000_000n,
      maximumPackageQuantityAtoms: 10n ** 18n,
    },
    finality: {
      policy: { requiredConfirmations: 20, requireFinalized: true },
      manifestHash: manifest.finalityPolicyHash,
    },
  };
}

function config(): ArbitrumSepoliaOrderContextConfig {
  return {
    schemaVersion: 1,
    contextId: "arbitrum-sepolia:eth-usdc:gmx",
    orderVersion: 1,
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: hash(9),
    baseAsset: base,
    quoteAsset: quote,
    spotAdapter: adapterRef({ adapterId: "uniswap-v3-spot", adapterManifestVersion: 1, adapterManifestHash: hash(4) }),
    perpetualAdapter: adapterRef({ adapterId: "gmx-v2-arbitrum", adapterManifestVersion: 1, adapterManifestHash: hash(5) }),
    owner,
    priceFeed,
    priceFeedDecimals: 8,
    maxStalenessSeconds: 60n,
    pollIntervalMs: 5_000,
    expiryTtlSeconds: 600n,
    maxEntrySpread: { baseAsset: base, quoteAsset: quote, quoteAtoms: 1n, baseAtoms: 10n ** 12n, roundingDirection: "CEIL" },
    maximumQuantityAtoms: 10n ** 17n,
    maxSlippageBps: 100,
    maxVenueFeeAtomsByAsset: [{ asset: quote, maxAtoms: 20_000n }, { asset: base, maxAtoms: 0n }],
    maxMarginAddedAtoms: 3_000_000n,
    maxProtocolFeeAtoms: 0n,
    maxSolverFeeAtoms: 0n,
    maxPriorityFeeAtoms: 0n,
  };
}

function pricePort(state: { chainId: bigint; now: bigint; updatedAt: bigint }): ArbitrumSepoliaPriceReadPort {
  return {
    chainId: async () => state.chainId,
    codeHash: async (address) => address === priceFeed.address ? priceFeed.expectedCodeHash : undefined,
    latestBlockTimestamp: async () => state.now,
    readContract: async ({ functionName }) => {
      if (functionName === "owner") return owner;
      if (functionName === "decimals") return 8;
      if (functionName === "latestRoundData") return [5n, 250_012_345_678n, state.updatedAt, state.updatedAt, 5n];
      throw new Error(`unexpected read ${functionName}`);
    },
  };
}

test("Arbitrum order context prices from the live feed, enforces chain-time staleness, and admits only the account owner", async () => {
  const state = { chainId: 421_614n, now: 1_000_000n, updatedAt: 999_990n };
  const runtime = await createArbitrumSepoliaOrderRuntime({ config: config(), deployment: deployment(), port: pricePort(state) });
  const context = runtime.contexts("arbitrum-sepolia:eth-usdc:gmx");
  assert.equal(context?.settlementClass, "ASYNC_BONDED_SOLVER");
  assert.equal(context?.capturedAtClock, 999_990n);
  // 2500.12345678 USD per 10^18 base atoms is 250012345678 / 10^20 quote atoms per base atom.
  assert.deepEqual([context?.spotReferencePrice.quoteAtoms, context?.spotReferencePrice.baseAtoms], [
    125_006_172_839n, 50_000_000_000_000_000_000n,
  ]);
  const currentClock = await runtime.clock.currentClock(context!);
  const request = (overrides: Record<string, unknown>) => ({
    contextId: "arbitrum-sepolia:eth-usdc:gmx",
    owner,
    settlementAccount: isolatedAccount,
    sizeAtoms: 10n ** 16n,
    slippageBps: 100,
    idempotencyKey: "arbitrum-entry-000001",
    currentClock,
    ...overrides,
  });
  const created = createCanonicalEntryOrder(runtime.contexts, request({}));
  assert.equal(created.order.settlementClass, "ASYNC_BONDED_SOLVER");
  assert.equal(created.order.expiryValue, 1_000_600n);
  // Ceil of 0.01 ETH at the reference price plus 1% slippage: 25.251246913478 USDC.
  assert.equal(created.order.maxSpotQuoteIn?.atoms, 25_251_247n);
  const rejects = (overrides: Record<string, unknown>, code: string) => assert.throws(
    () => createCanonicalEntryOrder(runtime.contexts, overrides as never),
    (error: unknown) => error instanceof EntryOrderValidationError && error.code === code,
  );
  rejects(request({ owner: evmAddress(0x44) }), "ACCOUNT_MISMATCH");
  rejects(request({ currentClock: 999_990n + 61n }), "STALE_CONTEXT");

  state.now = 1_000_100n;
  await assert.rejects(runtime.feed.refresh(), /stale/);
  assert.equal(runtime.contexts("arbitrum-sepolia:eth-usdc:gmx"), undefined);
  await assert.rejects(
    createArbitrumSepoliaOrderRuntime({ config: config(), deployment: deployment(), port: pricePort({ ...state, chainId: 42_161n }) }),
    /421614/,
  );
});

test("Arbitrum handoff advances the solver executor before observing and fails closed on a failed attempt", async () => {
  const attemptId = `arbitrum-async-${"a".repeat(48)}`;
  const calls: string[] = [];
  let status = "VENUE_PENDING";
  const fetchImplementation = (async (url: string, init: RequestInit) => {
    calls.push(`${String(url)} ${String(init.body)}`);
    return new Response(JSON.stringify({
      version: 1,
      attemptId,
      status,
      packageId: `0x${"5".repeat(64)}`,
      coordinatorState: "VENUE_PENDING",
      requestKey: `0x${"6".repeat(64)}`,
      transactions: [{ step: "RESERVE", txHash: `0x${"7".repeat(64)}`, status: "CONFIRMED" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const observed = { attemptId } as unknown as EvmTestnetAsyncObservationDto;
  const port = withArbitrumSepoliaExecutionHandoff({
    observe: async () => {
      calls.push("observe");
      return observed;
    },
  }, new HttpArbitrumSepoliaAttemptExecutor({ executorOrigin: "http://127.0.0.1:8793", fetchImplementation }));

  assert.equal(await port.observe({ attemptId, idempotencyKey: "arbitrum-observe-0001" }), observed);
  assert.deepEqual(calls, [
    `http://127.0.0.1:8793/internal/solver/arbitrum-sepolia/execute {"attemptId":"${attemptId}"}`,
    "observe",
  ]);
  status = "FAILED";
  await assert.rejects(port.observe({ attemptId, idempotencyKey: "arbitrum-observe-0002" }), /failed closed/);
  assert.equal(calls.filter((call) => call === "observe").length, 1);
  assert.throws(() => new HttpArbitrumSepoliaAttemptExecutor({ executorOrigin: "http://10.0.0.1:8793" }), /loopback/);
});
