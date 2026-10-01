import assert from "node:assert/strict";
import test from "node:test";
import { EVM_RUNTIME_IDENTITY } from "@naryx/adapter-evm";
import { adapterRef, assetRef, domainManifest, type Hash32 } from "@naryx/protocol-types";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { encodeFunctionData, hashTypedData, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ARBITRUM_SEPOLIA_GMX_DEPENDENCIES,
  arbitrumSepoliaAccountCodeHash,
  arbitrumSepoliaAccountOf,
  type ArbitrumSepoliaAsyncDeploymentConfiguration,
} from "../src/arbitrum-sepolia-async-context-provider.js";
import {
  HttpArbitrumSepoliaAttemptExecutor,
  withArbitrumSepoliaExecutionHandoff,
} from "../src/arbitrum-sepolia-executor-client.js";
import { createArbitrumSepoliaOwnerRoutes } from "../src/arbitrum-sepolia-owner-routes.js";
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
    accountFactory: identity(evmAddress(3), 3),
    accountImplementation: identity(evmAddress(8), 8),
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
    codeHash: async (address) => address === priceFeed.address ? priceFeed.expectedCodeHash
      : address === evmAddress(3) ? identity(evmAddress(3), 3).expectedCodeHash : undefined,
    latestBlockTimestamp: async () => state.now,
    readContract: async ({ functionName }) => {
      if (functionName === "decimals") return 8;
      if (functionName === "latestRoundData") return [5n, 250_012_345_678n, state.updatedAt, state.updatedAt, 5n];
      throw new Error(`unexpected read ${functionName}`);
    },
  };
}

test("Arbitrum order context prices from the live feed, enforces chain-time staleness, and admits any owner", async () => {
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
    settlementAccount: arbitrumSepoliaAccountOf(deployment(), owner),
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
  const second = evmAddress(0x44);
  const secondOrder = createCanonicalEntryOrder(runtime.contexts, request({
    owner: second, settlementAccount: arbitrumSepoliaAccountOf(deployment(), second), idempotencyKey: "arbitrum-entry-000002",
  }));
  assert.equal(secondOrder.order.owner.toLowerCase(), second);
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

test("Arbitrum owner routes return wallet work bound to the attempt owner and relay only the owner signature", async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const walletOwner = wallet.address.toLowerCase() as Address;
  const configuration = deployment();
  const account = arbitrumSepoliaAccountOf(configuration, walletOwner);
  const attemptId = `arbitrum-async-${"b".repeat(48)}`;
  const packageId = `0x${"9".repeat(64)}` as Hex;
  const typedData = {
    domain: { name: "Naryx Async Bonded Package", version: "1", chainId: 421614, verifyingContract: configuration.coordinator.address },
    types: { ReserveAsyncPackage: [{ name: "termsHash", type: "bytes32" }] },
    primaryType: "ReserveAsyncPackage",
    message: { termsHash: `0x${"8".repeat(64)}` },
  } as const;
  const venueAbi = parseAbi([
    "struct SpotEntry { address fundingOwner; address port; bytes32 portCodeHash; address baseToken; address quoteToken; uint256 baseAtoms; uint256 maxQuoteAtoms; uint256 rollbackMinQuoteAtoms; bytes32 entryFillCommitment; bytes32 rollbackFillCommitment; }",
    "struct VenueRequest { bytes32 marketId; address collateralToken; int256 sizeDelta; uint256 collateralAtoms; uint256 acceptablePrice; uint256 executionFeeWei; uint256 callbackGasLimit; uint256 packageNonce; bytes32 orderHash; bytes32 quoteHash; bytes32 routeHash; SpotEntry spot; uint64 submissionDeadline; uint64 venueDeadline; uint64 recoveryDeadline; }",
    "function fundRequest(bytes32 packageId, VenueRequest venueRequest) payable",
  ]);
  const zero = `0x${"0".repeat(64)}` as Hex;
  const fundRequest = (fundingOwner: Address) => encodeFunctionData({
    abi: venueAbi, functionName: "fundRequest", args: [packageId, {
      marketId: zero, collateralToken: configuration.collateralToken.address, sizeDelta: -1n, collateralAtoms: 2n,
      acceptablePrice: 1n, executionFeeWei: 7n, callbackGasLimit: 1n, packageNonce: 0n,
      orderHash: zero, quoteHash: zero, routeHash: zero,
      spot: {
        fundingOwner, port: evmAddress(9), portCodeHash: zero, baseToken: evmAddress(10),
        quoteToken: configuration.collateralToken.address, baseAtoms: 1n, maxQuoteAtoms: 3n, rollbackMinQuoteAtoms: 1n,
        entryFillCommitment: zero, rollbackFillCommitment: zero,
      },
      submissionDeadline: 1n, venueDeadline: 2n, recoveryDeadline: 3n,
    }],
  });
  let fundingOwner = walletOwner;
  const relayed: string[] = [];
  const authorization = (signed: boolean) => ({
    version: 1, attemptId, packageId, chainId: 421614, owner: walletOwner, account,
    accountFactory: configuration.accountFactory.address, coordinator: configuration.coordinator.address,
    adapter: configuration.entryAdapter.address, typedData, digest: hashTypedData(typedData), signed,
    funding: {
      token: configuration.collateralToken.address, spender: configuration.entryAdapter.address,
      approveAtoms: "5", collateralAtoms: "2", spotQuoteAtoms: "3", executionFeeWei: "7",
      fundRequest: { to: configuration.entryAdapter.address, data: fundRequest(fundingOwner), value: "7" },
      reclaimAfterUnixSeconds: "1",
    },
    summary: {
      nonce: "0", sizeDeltaUsd: "1", acceptablePrice: "1", spotBaseAtoms: "1", rollbackMinQuoteAtoms: "1",
      bondAtoms: "1", solver: evmAddress(11), submissionDeadline: "1", venueDeadline: "2", recoveryDeadline: "3",
    },
  });
  const fetchImplementation = (async (url: string, init: RequestInit) => {
    relayed.push(`${String(url).replace("http://127.0.0.1:8793", "")} ${String(init.body)}`);
    const body = JSON.parse(String(init.body)) as { ownerSignature?: string };
    return new Response(JSON.stringify(authorization(body.ownerSignature !== undefined)), { status: 200 });
  }) as typeof fetch;
  const routes = createArbitrumSepoliaOwnerRoutes({
    terminalOrigin: "http://localhost:3000",
    deployment: configuration,
    executor: new HttpArbitrumSepoliaAttemptExecutor({ executorOrigin: "http://127.0.0.1:8793", fetchImplementation }),
    port: { chainId: async () => 421_614n, codeHash: async () => arbitrumSepoliaAccountCodeHash(configuration) },
    intents: {
      getAttempt: () => ({ status: "ARBITRUM_ASYNC_QUOTE_SELECTED", domainId: "eip155:421614", orderHash: "1".repeat(64) }),
    } as never,
    orders: { getCanonicalOrderByHash: () => ({ owner: walletOwner }) } as never,
  });
  const call = async (method: string, path: string, body?: unknown, origin = "http://localhost:3000") => {
    const request = Object.assign(new PassThrough(), {
      method, url: path, headers: { origin, "content-type": "application/json" },
    }) as unknown as IncomingMessage;
    (request as unknown as PassThrough).end(body === undefined ? "" : JSON.stringify(body));
    const headers = new Map<string, string>();
    return new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
      const response: { statusCode: number; setHeader(name: string, value: string): void; end(text: string): void } = {
        statusCode: 0,
        setHeader: (name, value) => { headers.set(name, value); },
        end: (text) => resolve({ status: response.statusCode, body: JSON.parse(text) as Record<string, unknown> }),
      };
      assert.equal(routes(request, response as unknown as ServerResponse), true);
    });
  };

  const status = await call("GET", `/internal/terminal/arbitrum-sepolia/account?owner=${walletOwner}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.account, account);
  assert.equal(status.body.deployed, true);
  assert.equal((await call("GET", `/internal/terminal/arbitrum-sepolia/account?owner=${walletOwner}`, undefined, "https://evil.example")).status, 403);

  const prepared = await call("POST", "/internal/terminal/arbitrum-sepolia/prepare-owner-authorization", { attemptId });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.account, account);
  const signature = await wallet.signTypedData(typedData);
  const authorized = await call("POST", "/internal/terminal/arbitrum-sepolia/authorize-owner", { attemptId, ownerSignature: signature });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.body.signed, true);
  assert.deepEqual(relayed, [
    `/internal/solver/arbitrum-sepolia/prepare {"attemptId":"${attemptId}"}`,
    `/internal/solver/arbitrum-sepolia/authorize {"attemptId":"${attemptId}","ownerSignature":"${signature}"}`,
  ]);
  // Wallet work funded by anyone but the attempt owner is refused before it reaches the browser.
  fundingOwner = evmAddress(0x44);
  const mismatched = await call("POST", "/internal/terminal/arbitrum-sepolia/prepare-owner-authorization", { attemptId });
  assert.equal(mismatched.status, 502);
  assert.equal((mismatched.body.error as { code: string }).code, "AUTHORIZATION_MISMATCH");
});
