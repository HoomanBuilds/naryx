import assert from "node:assert/strict";
import test from "node:test";
import { EVM_RUNTIME_IDENTITY } from "@naryx/adapter-evm";
import { adapterRef, assetRef, domainManifest, type Hash32 } from "@naryx/protocol-types";
import { hashTypedData, type Address, type Hex } from "viem";
import {
  ARBITRUM_SEPOLIA_GMX_DEPENDENCIES,
  arbitrumSepoliaAccountOf,
  type ArbitrumSepoliaAsyncDeploymentConfiguration,
} from "../src/arbitrum-sepolia-async-context-provider.js";
import {
  ARBITRUM_EXIT_AUTHORIZATION_FIELDS,
  ArbitrumSepoliaExitError,
  arbitrumExitTypedMessage,
  arbitrumSepoliaExitLimits,
  createArbitrumSepoliaExitOrder,
  gmxShortPositionKey,
  requireArbitrumSepoliaExitBinding,
  validateArbitrumSepoliaExitAuthorization,
} from "../src/arbitrum-sepolia-exit.js";
import { gmxPositionFeeFactorKey } from "../src/arbitrum-sepolia-market-source.js";
import {
  createArbitrumSepoliaOrderRuntime,
  type ArbitrumSepoliaOrderContextConfig,
  type ArbitrumSepoliaPriceReadPort,
} from "../src/arbitrum-sepolia-order-context.js";
import type { InternalOrderInput } from "../src/internal-order-store.js";

const hash = (byte: number): Hash32 => new Uint8Array(32).fill(byte) as Hash32;
const evmAddress = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(20)}` as Address;
const word = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex;
const identity = (address: Address, byte: number) => ({ address, expectedCodeHash: word(byte) });
const base = assetRef("eip155:421614:weth", hash(2), 18);
const quote = assetRef("eip155:421614:usdc", hash(3), 6);
const owner = evmAddress(0x33);
const NOW = 1_000_000n;
const QUANTITY = 10n ** 16n;
const SIZE_USD = 25_001_234n * 10n ** 24n;
const COLLATERAL = 2_500_124n;
const ANSWER = 250_012_345_678n;
// A pool mid of 10000 USD per ETH, above the reference, so the reference prices the spot leg.
const POOL = Object.freeze({ sqrtPriceX96: 2n ** 96n / 10_000n, baseIsToken0: true, poolFee: 3_000n });

function deployment(): ArbitrumSepoliaAsyncDeploymentConfiguration {
  const manifest = domainManifest({
    manifestVersion: 1, environment: "testnet", domainId: "eip155:421614",
    runtimeClassId: EVM_RUNTIME_IDENTITY.runtimeClassId, runtimeClassVersion: EVM_RUNTIME_IDENTITY.runtimeClassVersion,
    chainNamespace: EVM_RUNTIME_IDENTITY.chainNamespace, chainReference: "421614",
    executionVerifierId: EVM_RUNTIME_IDENTITY.executionVerifierId, executionVerifierCodeHash: hash(70),
    clockModelId: EVM_RUNTIME_IDENTITY.clockModelId, finalityPolicyHash: hash(71),
    addressCodecId: EVM_RUNTIME_IDENTITY.addressCodecId, supportedSettlementClasses: ["ASYNC_BONDED_SOLVER"],
  });
  return {
    admission: {} as ArbitrumSepoliaAsyncDeploymentConfiguration["admission"],
    domainManifest: manifest,
    protocolConfig: identity(evmAddress(1), 1),
    coordinator: identity(evmAddress(2), 2),
    accountFactory: identity(evmAddress(3), 3),
    accountImplementation: identity(evmAddress(8), 8),
    entryAdapter: identity(evmAddress(4), 4),
    exitController: identity(evmAddress(9), 9),
    spotPort: identity(evmAddress(10), 10),
    orderVerifier: identity(evmAddress(5), 5),
    market: identity(evmAddress(6), 6),
    collateralToken: identity(evmAddress(7), 7),
    gmx: Object.fromEntries(Object.entries(ARBITRUM_SEPOLIA_GMX_DEPENDENCIES).map(
      ([name, dependency], index) => [name, identity(dependency, 20 + index)],
    )) as ArbitrumSepoliaAsyncDeploymentConfiguration["gmx"],
    executionClassManifestHash: hash(30),
    route: {
      perpetualAdapterId: "gmx-v2-arbitrum", perpetualMarketId: "gmx-eth-usd", perpetualVenueId: "gmx-v2",
      evidenceProfileId: "gmx-v2-callback-v1", seriesIdentityKey: hash(31), seriesBindingVersion: 1,
      seriesBindingHash: hash(32), stateReferenceSchemaHash: hash(33), receiptSchemaHash: hash(34),
      outcomeSchemaHash: hash(35), coordinatorEvidenceSchemaHash: hash(36),
    },
    bounds: { maximumRouteExpiryValue: 2_000_000_000n, maximumRecoveryDeadlineValue: 2_000_000_000n, maximumPackageQuantityAtoms: 10n ** 18n },
    finality: { policy: { requiredConfirmations: 20, requireFinalized: true }, manifestHash: manifest.finalityPolicyHash },
  };
}

function config(): ArbitrumSepoliaOrderContextConfig {
  return {
    schemaVersion: 1, contextId: "arbitrum-sepolia:eth-usdc:gmx", orderVersion: 1,
    templateId: "cash-and-carry-v1", templateVersion: 1, packageTemplateManifestHash: hash(9),
    baseAsset: base, quoteAsset: quote,
    spotAdapter: adapterRef({ adapterId: "uniswap-v3-spot", adapterManifestVersion: 1, adapterManifestHash: hash(4) }),
    perpetualAdapter: adapterRef({ adapterId: "gmx-v2-arbitrum", adapterManifestVersion: 1, adapterManifestHash: hash(5) }),
    priceFeed: identity(evmAddress(0x55), 0x55), priceFeedDecimals: 8, maxStalenessSeconds: 60n, pollIntervalMs: 5_000,
    expiryTtlSeconds: 600n,
    maxEntrySpread: { baseAsset: base, quoteAsset: quote, quoteAtoms: 1n, baseAtoms: 10n ** 12n, roundingDirection: "CEIL" },
    maximumQuantityAtoms: 10n ** 17n, maxSlippageBps: 100,
    maxVenueFeeAtomsByAsset: [{ asset: quote, maxAtoms: 20_000n }, { asset: base, maxAtoms: 0n }],
    maxMarginAddedAtoms: 3_000_000n, maxProtocolFeeAtoms: 0n, maxSolverFeeAtoms: 0n, maxPriorityFeeAtoms: 0n,
  };
}

/** The owner's executed package, its GMX short, the reference feed, and the factory's spot pool. */
function chain(state: { activePackage: Hex; activeExit: Hex }): ArbitrumSepoliaPriceReadPort {
  const configuration = deployment();
  const account = arbitrumSepoliaAccountOf(configuration, owner);
  const market = configuration.market.address;
  const collateral = configuration.collateralToken.address;
  const uints = new Map<string, bigint>([
    [gmxShortPositionKey(account, market, collateral, "SIZE_IN_USD"), SIZE_USD],
    [gmxShortPositionKey(account, market, collateral, "SIZE_IN_TOKENS"), QUANTITY],
    [gmxShortPositionKey(account, market, collateral, "COLLATERAL_AMOUNT"), COLLATERAL],
    [gmxPositionFeeFactorKey(market, true), 3n * 10n ** 26n],
    [gmxPositionFeeFactorKey(market, false), 5n * 10n ** 26n],
  ]);
  const codes = new Map<string, Hex>([
    [configuration.accountFactory.address, configuration.accountFactory.expectedCodeHash],
    [evmAddress(0x55), word(0x55)],
    [configuration.spotPort!.address, configuration.spotPort!.expectedCodeHash],
  ]);
  return {
    chainId: async () => 421_614n,
    codeHash: async (address) => codes.get(address.toLowerCase()),
    latestBlockTimestamp: async () => NOW,
    readContract: async ({ functionName, args }) => {
      switch (functionName) {
        case "decimals": return 8;
        case "latestRoundData": return [5n, ANSWER, NOW - 10n, NOW - 10n, 5n];
        case "activePackageOf": return state.activePackage;
        case "activeRequestKeyOf": case "activeSpotRequestKey": return word(0x66);
        case "requestEvidence": return [2, word(0x77), 0n, SIZE_USD, 2n];
        case "positionSize": return args?.[0] === false ? SIZE_USD : 0n;
        case "hasActiveSpotInventory": return true;
        case "activeSpotRegistration": return { packageId: state.activePackage, baseAtoms: QUANTITY };
        case "activeExitRequestKey": return state.activeExit;
        case "getUint": return uints.get(String(args?.[0])) ?? 0n;
        case "spotPort": return configuration.spotPort!.address;
        case "spotPortCodeHash": return configuration.spotPort!.expectedCodeHash;
        case "pool": return evmAddress(0x88);
        case "poolFee": return Number(POOL.poolFee);
        case "baseToken": case "token0": return evmAddress(0x99);
        case "quoteToken": return collateral;
        case "slot0": return [POOL.sqrtPriceX96, 0, 0, 0, 0, 0, true];
        default: throw new Error(`unexpected read ${functionName}`);
      }
    },
  };
}

test("Arbitrum exit limits round against the trader and refuse an underwater short", () => {
  const input = {
    position: { quantityAtoms: QUANTITY, sizeInUsd: SIZE_USD, sizeInTokens: QUANTITY, collateralAtoms: COLLATERAL },
    baseDecimals: 18, quoteDecimals: 6, reference: { answer: ANSWER, decimals: 8 }, pool: POOL,
    positionFeeFactor: 5n * 10n ** 26n, slippageBps: 100,
  };
  const limits = arbitrumSepoliaExitLimits(input);
  // Spot: 0.01 ETH at the 2500.12345678 reference less the 0.3% pool fee and 1% slippage, rounded down.
  assert.equal(limits.minSpotQuoteOutAtoms, 24_676_968n);
  // Perp: collateral plus the short bought back at the reference plus 1% (rounded up), less the 0.05%
  // fee (rounded up), less 1% more for accrued fees, rounded down.
  assert.equal(limits.minPerpOutputAtoms, 2_215_234n);
  assert.equal(limits.minExitQuoteOutcomeAtoms, 26_892_202n);
  assert.equal(limits.entryNotionalAtoms, 25_001_234n);
  assert.throws(
    () => arbitrumSepoliaExitLimits({ ...input, position: { ...input.position, collateralAtoms: 1n } }),
    (error: unknown) => error instanceof ArbitrumSepoliaExitError && error.code === "POSITION_UNDERWATER",
  );
  assert.throws(
    () => arbitrumSepoliaExitLimits({ ...input, position: { ...input.position, sizeInUsd: SIZE_USD + 1n } }),
    (error: unknown) => error instanceof ArbitrumSepoliaExitError && error.code === "INVALID_EXIT",
  );
});

test("Arbitrum exit order reads the open package from chain and stores a canonical async EXIT order", async () => {
  const configuration = deployment();
  const packageId = word(0x5a);
  const state = { activePackage: packageId, activeExit: word(0) };
  const port = chain(state);
  const runtime = await createArbitrumSepoliaOrderRuntime({ config: config(), deployment: configuration, port });
  const stored: InternalOrderInput[] = [];
  const orders = {
    createOrGet: (input: InternalOrderInput) => {
      stored.push(input);
      return { record: {} as never, created: true };
    },
  };
  const create = (slippageBps = 100) => createArbitrumSepoliaExitOrder({
    deployment: configuration, port, runtime, orders, owner, slippageBps, idempotencyKey: "arbitrum-exit-000001",
  });
  const result = await create();
  const order = stored[0]!.order.order;
  assert.equal(result.packageId, packageId);
  assert.equal(order.action, "EXIT");
  assert.equal(order.settlementClass, "ASYNC_BONDED_SOLVER");
  assert.equal(order.settlementAccount, arbitrumSepoliaAccountOf(configuration, owner));
  assert.equal(Buffer.from(order.entryReceiptHash!).toString("hex"), packageId.slice(2));
  assert.deepEqual(
    [order.quantity.atoms, order.expectedPrePositionSize.atoms, order.expectedPrePositionEntryNotional.atoms],
    [QUANTITY, -QUANTITY, 25_001_234n],
  );
  assert.deepEqual([order.minSpotQuoteOut?.atoms, order.minExitQuoteOutcome?.atoms, order.maxMarginAdded.atoms],
    [24_676_968n, 26_892_202n, 0n]);

  const refused = (code: string) => (error: unknown) => error instanceof ArbitrumSepoliaExitError && error.code === code;
  await assert.rejects(create(101), refused("EXCESS_SLIPPAGE"));
  state.activeExit = word(0xee);
  await assert.rejects(create(), (error: unknown) => refused("NO_EXITABLE_PACKAGE")(error) && /in progress/.test(String(error)));
  state.activePackage = word(0);
  await assert.rejects(create(), refused("NO_EXITABLE_PACKAGE"));
  assert.equal(stored.length, 1);
});

test("Arbitrum exit authorization is bound to its digest, the attempt hashes, and an owner-only proceeds path", () => {
  const configuration = deployment();
  const account = arbitrumSepoliaAccountOf(configuration, owner);
  const exitController = configuration.exitController!.address;
  const values: Record<string, string | boolean> = Object.fromEntries(ARBITRUM_EXIT_AUTHORIZATION_FIELDS.map(([name, type]) => [
    name, type === "bytes32" ? word(0x11) : type === "address" ? owner : type === "bool" ? false : "7",
  ]));
  const message = {
    ...values, packageId: word(0x5a), account, market: configuration.market.address,
    collateralToken: configuration.collateralToken.address, exitOrderHash: word(0x01), exitQuoteHash: word(0x02),
    exitRouteHash: word(0x03), feePayer: evmAddress(0xdd),
  };
  const typedData = {
    domain: { name: "Naryx GMX V2 Exit", version: "1", chainId: 421614, verifyingContract: exitController },
    types: { ExitAuthorization: ARBITRUM_EXIT_AUTHORIZATION_FIELDS.map(([name, type]) => ({ name, type })) },
    primaryType: "ExitAuthorization",
    message,
  };
  const prepared = {
    version: 1, attemptId: `arbitrum-async-${"c".repeat(48)}`, packageId: word(0x5a), chainId: 421614, owner, account,
    exitController, typedData, signed: false,
    digest: hashTypedData({ ...typedData, message: arbitrumExitTypedMessage(message) } as never),
  };
  const validated = validateArbitrumSepoliaExitAuthorization(prepared, prepared.attemptId);
  const expected = {
    deployment: configuration, owner, settlementAccount: account, packageId: word(0x5a),
    orderHash: word(0x01), quoteHash: word(0x02), routeHash: word(0x03),
  };
  assert.equal(requireArbitrumSepoliaExitBinding(validated, expected), validated);
  // A changed field without a matching digest, another attempt's order, or a foreign proceeds path is refused.
  assert.throws(() => validateArbitrumSepoliaExitAuthorization({
    ...prepared, typedData: { ...typedData, message: { ...message, minOutputAmount: "1" } },
  }, prepared.attemptId), ArbitrumSepoliaExitError);
  assert.throws(() => requireArbitrumSepoliaExitBinding(validated, { ...expected, orderHash: word(0x04) }),
    (error: unknown) => error instanceof ArbitrumSepoliaExitError && error.code === "AUTHORIZATION_MISMATCH");
  const foreign = { ...message, spotProceedsRecipient: evmAddress(0x44) };
  const rebound = validateArbitrumSepoliaExitAuthorization({
    ...prepared, typedData: { ...typedData, message: foreign },
    digest: hashTypedData({ ...typedData, message: arbitrumExitTypedMessage(foreign) } as never),
  }, prepared.attemptId);
  assert.throws(() => requireArbitrumSepoliaExitBinding(rebound, expected),
    (error: unknown) => error instanceof ArbitrumSepoliaExitError && error.code === "AUTHORIZATION_MISMATCH");
});
