import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  CHAINLINK_AGGREGATOR_ABI,
  ERC20_ABI,
  NARYX_STRATEGY_ACCOUNT_FACTORY_ABI,
  NARYX_STRATEGY_ACCOUNT_OWNER_ABI,
  NARYX_TEST_PERP_MARKET_ABI,
  PACKAGE_VERIFIER_ACCOUNT_ABI,
  UNISWAP_V3_POOL_ABI,
  equalAddress,
  packageVerifierOpenPackage,
  requiredEvmAddress,
  type EvmContractIdentity,
} from "@naryx/adapter-evm";
import {
  bytesEqual,
  domainRefFromManifest,
  exactPrice,
  exactSignedRate,
  parseProtocolJson,
  type AdapterRef,
  type AssetRef,
  type ExactPrice,
  type ExactSignedRate,
  type FeeCap,
} from "@naryx/protocol-types";
import { encodeFunctionData, keccak256, stringToHex, type Address, type Hex } from "viem";
import {
  resolveBaseSepoliaStrategyAccount,
  validateBaseSepoliaAtomicDeploymentConfiguration,
  type BaseSepoliaAtomicDeploymentConfiguration,
  type BaseSepoliaAtomicLiveReads,
} from "./base-sepolia-atomic-context-provider.js";
import {
  EntryOrderValidationError,
  venueFeeCapsWithBase,
  type ActiveOrderContext,
  type ActiveOrderContextProvider,
} from "./canonical-entry-order.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import {
  BASE_SEPOLIA_CHAIN_REFERENCE,
  BASE_SEPOLIA_DOMAIN_ID,
  EvmTestnetTerminalValidationError,
  type EvmTestnetAccountPort,
} from "./evm-testnet-runtime-ports.js";
import type { InternalOrderClockPort, InternalOrderSpotPricePort } from "./terminal-orders.js";
import {
  executableSpotPrice,
  quoteUniswapV3Buy,
  verifyUniswapV3Quoter,
  type UniswapV3SpotQuoteTarget,
} from "./uniswap-v3-quoter.js";

const CONTEXT_ID = /^[A-Za-z0-9:_.-]{1,128}$/;
const Q192 = 1n << 192n;
const FEE_SCALE = 1_000_000n;

/** Reviewed order limits for Base Sepolia. Prices are never configured; they are read live. */
export interface BaseSepoliaOrderContextConfig {
  readonly schemaVersion: 1;
  readonly contextId: string;
  readonly orderVersion: number;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly spotAdapter: AdapterRef;
  readonly perpetualAdapter: AdapterRef;
  /** The canonical Uniswap V3 QuoterV2; entry and exit bounds come from its quote for the exact size. */
  readonly spotQuoter: EvmContractIdentity;
  readonly maxStalenessSeconds: bigint;
  readonly pollIntervalMs: number;
  readonly expiryTtlSeconds: bigint;
  readonly maxEntrySpread: ExactSignedRate;
  readonly maximumQuantityAtoms: bigint;
  readonly maxSlippageBps: number;
  readonly maxVenueFeeAtomsByAsset: readonly FeeCap[];
  readonly maxMarginAddedAtoms: bigint;
  readonly maxProtocolFeeAtoms: bigint;
  readonly maxSolverFeeAtoms: bigint;
  readonly maxPriorityFeeAtoms: bigint;
  /** Upper bound, in quote atoms, on one wallet funding transaction the terminal may propose. */
  readonly maxAccountFundingAtoms: bigint;
}

/** Signerless reads. Chain identity always comes from eth_chainId, never from the RPC URL. */
export interface BaseSepoliaOrderReadPort extends BaseSepoliaAtomicLiveReads {
  chainId(): Promise<bigint>;
  latestBlockTimestamp(): Promise<bigint>;
}

/** One observation of the Uniswap pool, the market's Chainlink feed, and the market's fee terms. */
export type BaseSepoliaMarketSnapshot = Readonly<{
  observedAt: bigint;
  observedAtMs: number;
  oracleAnswer: bigint;
  oracleDecimals: number;
  oracleUpdatedAt: bigint;
  sqrtPriceX96: bigint;
  baseIsToken0: boolean;
  poolFee: bigint;
  takerFeeBps: bigint;
  halfSpreadBps: bigint;
}>;

export type BaseSepoliaOrderRuntime = Readonly<{
  contexts: ActiveOrderContextProvider;
  clock: InternalOrderClockPort;
  spotPrice: InternalOrderSpotPricePort;
  feed: BaseSepoliaMarketFeed;
  account: EvmTestnetAccountPort;
  config: BaseSepoliaOrderContextConfig;
}>;

function nonnegative(value: unknown, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n) throw new Error(`Base order context ${name} must be nonnegative.`);
  return value;
}

function positive(value: unknown, name: string): bigint {
  if (nonnegative(value, name) === 0n) throw new Error(`Base order context ${name} must be positive.`);
  return value as bigint;
}

function sameAsset(left: AssetRef, right: Readonly<{ subjectId: string; decimals: number; manifestHash: Uint8Array }>): boolean {
  return left.assetId === right.subjectId && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.manifestHash);
}

function sameAdapter(left: AdapterRef, right: Readonly<{ subjectId: string; manifestVersion: number; manifestHash: Uint8Array }>): boolean {
  return left.adapterId === right.subjectId && left.adapterManifestVersion === right.manifestVersion
    && bytesEqual(left.adapterManifestHash, right.manifestHash);
}

function validateConfig(config: BaseSepoliaOrderContextConfig, deployment?: BaseSepoliaAtomicDeploymentConfiguration): void {
  if (config?.schemaVersion !== 1 || typeof config.contextId !== "string" || !CONTEXT_ID.test(config.contextId)
    || !Number.isSafeInteger(config.pollIntervalMs) || config.pollIntervalMs < 1_000
    || !Number.isSafeInteger(config.maxSlippageBps) || config.maxSlippageBps < 1 || config.maxSlippageBps > 10_000
    || !Array.isArray(config.maxVenueFeeAtomsByAsset) || config.maxVenueFeeAtomsByAsset.length === 0) {
    throw new Error("Base Sepolia order context configuration is invalid.");
  }
  requiredEvmAddress(config.spotQuoter?.address, "spotQuoter.address");
  if (!/^0x[0-9a-f]{64}$/.test(config.spotQuoter.expectedCodeHash) || /^0x0+$/.test(config.spotQuoter.expectedCodeHash)) {
    throw new Error("Base order context spot quoter code hash is invalid.");
  }
  positive(config.maxStalenessSeconds, "maxStalenessSeconds");
  positive(config.expiryTtlSeconds, "expiryTtlSeconds");
  positive(config.maximumQuantityAtoms, "maximumQuantityAtoms");
  positive(config.maxMarginAddedAtoms, "maxMarginAddedAtoms");
  positive(config.maxAccountFundingAtoms, "maxAccountFundingAtoms");
  nonnegative(config.maxProtocolFeeAtoms, "maxProtocolFeeAtoms");
  nonnegative(config.maxSolverFeeAtoms, "maxSolverFeeAtoms");
  nonnegative(config.maxPriorityFeeAtoms, "maxPriorityFeeAtoms");
  // Every order signs the spread cap, so a non-canonical rate (for example not in lowest terms) is
  // refused here, at load, instead of failing each order.
  try {
    exactSignedRate(config.maxEntrySpread, "maxEntrySpread");
  } catch (error) {
    throw new Error(`Base Sepolia order context maxEntrySpread is invalid: ${error instanceof Error ? error.message : "malformed"}`);
  }
  if (deployment === undefined) return;
  const identity = deployment.deployment;
  if (!sameAsset(config.baseAsset, identity.baseAsset) || !sameAsset(config.quoteAsset, identity.quoteAsset)
    || !sameAdapter(config.spotAdapter, identity.spot.adapter)
    || !sameAdapter(config.perpetualAdapter, identity.perpetual.adapter)) {
    throw new Error("Base Sepolia order context assets or adapters do not match the deployment.");
  }
}

/**
 * The venue fee caps every Base order signs: the reviewed caps plus a zero base-asset cap when none
 * is configured, in canonical asset order. A solver quote always lists the base asset's fee, and the
 * Base route charges every venue fee in the quote asset.
 */
export function baseSepoliaVenueFeeCaps(
  config: Pick<BaseSepoliaOrderContextConfig, "baseAsset" | "maxVenueFeeAtomsByAsset">,
): readonly FeeCap[] {
  return venueFeeCapsWithBase(config.baseAsset, config.maxVenueFeeAtomsByAsset);
}

export function loadBaseSepoliaOrderContextConfig(path: string): BaseSepoliaOrderContextConfig {
  if (!isAbsolute(path)) throw new Error("NARYX_BASE_SEPOLIA_ORDER_CONTEXT must be an absolute path.");
  const config = parseProtocolJson(readFileSync(resolve(path), "utf8"), "baseSepoliaOrderContext");
  validateConfig(config as BaseSepoliaOrderContextConfig);
  return config as BaseSepoliaOrderContextConfig;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/**
 * The Uniswap V3 pool's executable ask: the slot0 mid plus the pool fee, as quote atoms per whole
 * base token, rounded up. Exact-output buys pay the fee on the quote input, so the fee scales the
 * price. The pool's exact ratio has a 2^192 denominator, far beyond an exact price's u128 terms
 * for any real pool, so it is expressed per whole token: one quote atom of precision per token.
 */
export function baseSepoliaSpotAsk(
  baseAsset: AssetRef,
  quoteAsset: AssetRef,
  snapshot: Pick<BaseSepoliaMarketSnapshot, "sqrtPriceX96" | "baseIsToken0" | "poolFee">,
): ExactPrice {
  const squared = snapshot.sqrtPriceX96 * snapshot.sqrtPriceX96;
  if (squared <= 0n) throw new Error("Uniswap pool price must be positive.");
  const [midNumerator, midDenominator] = snapshot.baseIsToken0 ? [squared, Q192] : [Q192, squared];
  const wholeToken = 10n ** BigInt(baseAsset.decimals);
  const numerator = midNumerator * (FEE_SCALE + snapshot.poolFee) * wholeToken;
  const denominator = midDenominator * FEE_SCALE;
  const quoteAtoms = (numerator + denominator - 1n) / denominator;
  const baseAtoms = wholeToken;
  const divisor = gcd(quoteAtoms, baseAtoms);
  return exactPrice({
    baseAsset,
    quoteAsset,
    quoteAtoms: quoteAtoms / divisor,
    baseAtoms: baseAtoms / divisor,
    roundingDirection: "CEIL",
  });
}

export class BaseSepoliaMarketFeed {
  readonly #config: BaseSepoliaOrderContextConfig;
  readonly #deployment: BaseSepoliaAtomicDeploymentConfiguration;
  readonly #port: BaseSepoliaOrderReadPort;
  readonly #currentTimeMs: () => number;
  #latest: BaseSepoliaMarketSnapshot | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    config: BaseSepoliaOrderContextConfig,
    deployment: BaseSepoliaAtomicDeploymentConfiguration,
    port: BaseSepoliaOrderReadPort,
    currentTimeMs: () => number = Date.now,
  ) {
    validateConfig(config, deployment);
    this.#config = config;
    this.#deployment = deployment;
    this.#port = port;
    this.#currentTimeMs = currentTimeMs;
  }

  latest(): BaseSepoliaMarketSnapshot | undefined {
    return this.#latest;
  }

  /** Any failed, stale, or inconsistent read clears the snapshot, so the context reports unknown. */
  async refresh(): Promise<BaseSepoliaMarketSnapshot> {
    try {
      if (await this.#port.chainId() !== BigInt(BASE_SEPOLIA_CHAIN_REFERENCE)) {
        throw new Error("Base Sepolia RPC eth_chainId is not 84532.");
      }
      const deployment = this.#deployment.deployment;
      const market = requiredEvmAddress(deployment.perpetual.market.address, "perpetual.market");
      const pool = requiredEvmAddress(deployment.spot.market.address, "spot.market");
      const baseToken = requiredEvmAddress(deployment.baseAsset.address, "baseAsset");
      const read = (address: Address, abi: typeof NARYX_TEST_PERP_MARKET_ABI | typeof UNISWAP_V3_POOL_ABI
        | typeof CHAINLINK_AGGREGATOR_ABI, functionName: string) =>
        this.#port.readContract({ address, abi, functionName });
      const [oracle, takerFeeBps, halfSpreadBps, maxOracleAgeSeconds, slot0, token0, poolFee, observedAt] =
        await Promise.all([
          read(market, NARYX_TEST_PERP_MARKET_ABI, "oracle"),
          read(market, NARYX_TEST_PERP_MARKET_ABI, "takerFeeBps"),
          read(market, NARYX_TEST_PERP_MARKET_ABI, "halfSpreadBps"),
          read(market, NARYX_TEST_PERP_MARKET_ABI, "maxOracleAgeSeconds"),
          read(pool, UNISWAP_V3_POOL_ABI, "slot0"),
          read(pool, UNISWAP_V3_POOL_ABI, "token0"),
          read(pool, UNISWAP_V3_POOL_ABI, "fee"),
          this.#port.latestBlockTimestamp(),
        ]);
      const feed = requiredEvmAddress(String(oracle), "market.oracle");
      const [decimals, round] = await Promise.all([
        read(feed, CHAINLINK_AGGREGATOR_ABI, "decimals"),
        read(feed, CHAINLINK_AGGREGATOR_ABI, "latestRoundData"),
      ]);
      const [roundId, answer, , updatedAt, answeredInRound] = round as readonly bigint[];
      const maxAge = BigInt(Number(maxOracleAgeSeconds));
      const oracleDecimals = Number(decimals);
      if (typeof answer !== "bigint" || answer <= 0n || typeof updatedAt !== "bigint" || updatedAt <= 0n
        || updatedAt > observedAt || typeof roundId !== "bigint" || typeof answeredInRound !== "bigint"
        || answeredInRound < roundId || observedAt - updatedAt > maxAge
        || !Number.isSafeInteger(oracleDecimals) || oracleDecimals < 0 || oracleDecimals > 18) {
        throw new Error("Base Sepolia Chainlink price is invalid, incomplete, or older than the market allows.");
      }
      const sqrtPriceX96 = (slot0 as readonly unknown[])[0];
      if (typeof sqrtPriceX96 !== "bigint" || sqrtPriceX96 <= 0n) throw new Error("Uniswap pool price is invalid.");
      this.#latest = Object.freeze({
        observedAt,
        observedAtMs: this.#currentTimeMs(),
        oracleAnswer: answer,
        oracleDecimals,
        oracleUpdatedAt: updatedAt,
        sqrtPriceX96,
        baseIsToken0: equalAddress(requiredEvmAddress(String(token0), "pool.token0"), baseToken),
        poolFee: BigInt(Number(poolFee)),
        takerFeeBps: BigInt(Number(takerFeeBps)),
        halfSpreadBps: BigInt(Number(halfSpreadBps)),
      });
      return this.#latest;
    } catch (error) {
      this.#latest = undefined;
      throw error;
    }
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => { void this.refresh().catch(() => undefined); }, this.#config.pollIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/** The pinned quoter and the deployment's pool tokens, at the pool fee the feed read live. */
export function baseSepoliaSpotQuoteTarget(
  config: Pick<BaseSepoliaOrderContextConfig, "spotQuoter">,
  deployment: BaseSepoliaAtomicDeploymentConfiguration,
  poolFee: bigint,
): UniswapV3SpotQuoteTarget {
  return Object.freeze({
    chainId: BigInt(BASE_SEPOLIA_CHAIN_REFERENCE),
    quoter: config.spotQuoter,
    baseToken: requiredEvmAddress(deployment.deployment.baseAsset.address, "baseAsset"),
    quoteToken: requiredEvmAddress(deployment.deployment.quoteAsset.address, "quoteAsset"),
    poolFee,
  });
}

function setupStep(kind: string, label: string, to: Address, data: Hex) {
  return Object.freeze({ kind, label, to, data, value: "0" as const });
}

function formatAtoms(atoms: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (atoms % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length === 0 ? (atoms / scale).toString() : `${atoms / scale}.${fraction}`;
}

/**
 * Builds the Base Sepolia entry context. Any wallet may trade through its own factory account; the
 * settlement account is enforced against `accountOf(owner)` by the solver and the attempt context.
 */
export async function createBaseSepoliaOrderRuntime(input: Readonly<{
  config: BaseSepoliaOrderContextConfig;
  deployment: BaseSepoliaAtomicDeploymentConfiguration;
  port: BaseSepoliaOrderReadPort;
  orders: Pick<InternalOrderStore, "getCanonicalOrderByHash">;
}>): Promise<BaseSepoliaOrderRuntime> {
  const { config, deployment, port, orders } = input;
  validateBaseSepoliaAtomicDeploymentConfiguration(deployment);
  validateConfig(config, deployment);
  const identity = deployment.deployment;
  const feed = new BaseSepoliaMarketFeed(config, deployment, port);
  const venueFeeCaps = baseSepoliaVenueFeeCaps(config);
  const initial = await feed.refresh();
  await verifyUniswapV3Quoter(
    port,
    baseSepoliaSpotQuoteTarget(config, deployment, initial.poolFee),
    requiredEvmAddress(identity.spot.market.address, "spot.market"),
  );
  const domain = domainRefFromManifest(identity.domainManifest);
  let cached: Readonly<{ snapshot: BaseSepoliaMarketSnapshot; context: ActiveOrderContext }> | undefined;
  const contexts: ActiveOrderContextProvider = (contextId) => {
    if (contextId !== config.contextId) return undefined;
    const snapshot = feed.latest();
    if (snapshot === undefined) return undefined;
    if (cached?.snapshot === snapshot) return cached.context;
    const context: ActiveOrderContext = Object.freeze({
      contextId: config.contextId,
      state: "ACTIVE",
      // Chain time of the observation, so order creation enforces staleness against chain time.
      capturedAtClock: snapshot.observedAt,
      maxStaleness: config.maxStalenessSeconds,
      domain,
      environment: "testnet",
      orderVersion: config.orderVersion,
      templateId: config.templateId,
      templateVersion: config.templateVersion,
      packageTemplateManifestHash: config.packageTemplateManifestHash,
      baseAsset: config.baseAsset,
      quoteAsset: config.quoteAsset,
      spotAdapters: [config.spotAdapter],
      perpAdapters: [config.perpetualAdapter],
      settlementClass: "ATOMIC_POSTCONDITION",
      expiryUnit: "EVM_UNIX_SECONDS",
      expiryTtl: config.expiryTtlSeconds,
      spotReferencePrice: baseSepoliaSpotAsk(config.baseAsset, config.quoteAsset, snapshot),
      maxEntrySpread: config.maxEntrySpread,
      maximumQuantityAtoms: config.maximumQuantityAtoms,
      maxSlippageBps: config.maxSlippageBps,
      maxVenueFeeAtomsByAsset: venueFeeCaps,
      maxMarginAddedAtoms: config.maxMarginAddedAtoms,
      maxProtocolFeeAtoms: config.maxProtocolFeeAtoms,
      maxSolverFeeAtoms: config.maxSolverFeeAtoms,
      maxPriorityFeeAtoms: config.maxPriorityFeeAtoms,
      minVenueReserveReturnedAtoms: 0n,
      minWalletQuoteBalanceDeltaAtoms: 0n,
      maxResidualBaseQuantityAtoms: 0n,
    });
    cached = Object.freeze({ snapshot, context });
    return context;
  };
  const requireChain = async () => {
    if (await port.chainId() !== BigInt(BASE_SEPOLIA_CHAIN_REFERENCE)) {
      throw new Error("Base Sepolia RPC eth_chainId is not 84532.");
    }
  };
  const clock: InternalOrderClockPort = Object.freeze({
    currentClock: async (context: ActiveOrderContext) => {
      if (context.contextId !== config.contextId) throw new Error("Base Sepolia order context is unknown.");
      await requireChain();
      return port.latestBlockTimestamp();
    },
  });
  // The pool's exact-output cost for this size, fee and price impact included, replaces the mid ask.
  const spotPrice: InternalOrderSpotPricePort = Object.freeze({
    entrySpotPrice: async (context: ActiveOrderContext, sizeAtoms: bigint) => {
      const snapshot = feed.latest();
      if (context.contextId !== config.contextId || snapshot === undefined) {
        throw new EntryOrderValidationError("UNKNOWN_CONTEXT", "Order context is unknown.");
      }
      const target = baseSepoliaSpotQuoteTarget(config, deployment, snapshot.poolFee);
      return executableSpotPrice(config.baseAsset, config.quoteAsset, await quoteUniswapV3Buy(port, target, sizeAtoms), sizeAtoms);
    },
  });
  const factory = requiredEvmAddress(identity.strategyAccountFactory.address, "strategyAccountFactory");
  const market = requiredEvmAddress(identity.perpetual.market.address, "perpetual.market");
  const quoteToken = requiredEvmAddress(identity.quoteAsset.address, "quoteAsset");
  const baseToken = requiredEvmAddress(identity.baseAsset.address, "baseAsset");
  const verifier = requiredEvmAddress(identity.packageVerifier.address, "packageVerifier");
  const venueSubjectId = keccak256(stringToHex(identity.perpetual.venue.subjectId));
  const decimals = config.quoteAsset.decimals;
  const account: EvmTestnetAccountPort = Object.freeze({
    status: async (request: Parameters<EvmTestnetAccountPort["status"]>[0]) => {
      const { marginAtoms } = request;
      await requireChain();
      const resolved = await resolveBaseSepoliaStrategyAccount(port, identity, request.owner);
      let spotQuoteAtoms = 0n;
      if (request.orderHash !== undefined) {
        const order = orders.getCanonicalOrderByHash(request.orderHash);
        if (order === undefined || order.domain.domainId !== BASE_SEPOLIA_DOMAIN_ID
          || !equalAddress(requiredEvmAddress(order.owner, "order.owner"), resolved.owner)) {
          throw new EvmTestnetTerminalValidationError("ORDER_NOT_FOUND", "Base Sepolia order was not found for this owner.");
        }
        spotQuoteAtoms = order.maxSpotQuoteIn?.atoms ?? 0n;
      }
      if (spotQuoteAtoms > config.maxAccountFundingAtoms
        || typeof marginAtoms !== "bigint" || marginAtoms < 0n || marginAtoms > config.maxMarginAddedAtoms) {
        throw new EvmTestnetTerminalValidationError(
          "FUNDING_OUT_OF_BOUNDS",
          "Requested account funding is outside the reviewed testnet limits.",
        );
      }
      const balanceOf = (holder: Address, token: Address = quoteToken) => port.readContract({
        address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [holder],
      }) as Promise<bigint>;
      const [walletQuoteAtoms, accountQuoteAtoms, reserveAtoms, accountBaseAtoms, openRecord] = await Promise.all([
        balanceOf(resolved.owner),
        resolved.deployed ? balanceOf(resolved.account) : Promise.resolve(0n),
        resolved.deployed
          ? port.readContract({
            address: market, abi: NARYX_TEST_PERP_MARKET_ABI, functionName: "reserveOf", args: [resolved.account],
          }) as Promise<bigint>
          : Promise.resolve(0n),
        resolved.deployed ? balanceOf(resolved.account, baseToken) : Promise.resolve(0n),
        resolved.deployed
          ? port.readContract({
            address: verifier, abi: PACKAGE_VERIFIER_ACCOUNT_ABI, functionName: "openPackage", args: [resolved.account],
          })
          : Promise.resolve(undefined),
      ]);
      // From chain, never browser state, so an open package is found again from any device.
      const open = openRecord === undefined ? null : packageVerifierOpenPackage(openRecord);
      const marginShortfall = marginAtoms > reserveAtoms ? marginAtoms - reserveAtoms : 0n;
      const accountNeeds = spotQuoteAtoms + marginShortfall;
      const fundShortfall = accountNeeds > accountQuoteAtoms ? accountNeeds - accountQuoteAtoms : 0n;
      const steps = [];
      if (!resolved.deployed) {
        steps.push(setupStep("CREATE_ACCOUNT", "Create strategy account", factory, encodeFunctionData({
          abi: NARYX_STRATEGY_ACCOUNT_FACTORY_ABI, functionName: "create", args: [resolved.owner],
        })));
      }
      if (fundShortfall > 0n) {
        steps.push(setupStep(
          "FUND_ACCOUNT",
          `Move ${formatAtoms(fundShortfall, decimals)} USDC to strategy account`,
          quoteToken,
          encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [resolved.account, fundShortfall] }),
        ));
      }
      if (marginShortfall > 0n) {
        steps.push(setupStep(
          "DEPOSIT_MARGIN",
          `Deposit ${formatAtoms(marginShortfall, decimals)} USDC perp margin`,
          resolved.account,
          encodeFunctionData({
            abi: NARYX_STRATEGY_ACCOUNT_OWNER_ABI,
            functionName: "depositPerpMargin",
            args: [venueSubjectId, marginShortfall],
          }),
        ));
      }
      // After an exit the settled perp payout sits in the venue reserve and the proceeds in the
      // account. Owner-signed withdrawals return both to the wallet; the account allows idle
      // withdrawals only while no package is open.
      const withdrawals = [];
      if (resolved.deployed && open === null) {
        if (reserveAtoms > 0n) {
          withdrawals.push(setupStep(
            "WITHDRAW_MARGIN",
            `Withdraw ${formatAtoms(reserveAtoms, decimals)} USDC perp reserve to strategy account`,
            resolved.account,
            encodeFunctionData({
              abi: NARYX_STRATEGY_ACCOUNT_OWNER_ABI,
              functionName: "withdrawPerpMargin",
              args: [venueSubjectId, reserveAtoms],
            }),
          ));
        }
        for (const [token, atoms, label] of [
          [quoteToken, accountQuoteAtoms, `${formatAtoms(accountQuoteAtoms, decimals)} USDC`],
          [baseToken, accountBaseAtoms, `${formatAtoms(accountBaseAtoms, config.baseAsset.decimals)} base asset`],
        ] as const) {
          if (atoms <= 0n) continue;
          withdrawals.push(setupStep(
            token === quoteToken ? "WITHDRAW_QUOTE" : "WITHDRAW_BASE",
            `Withdraw ${label} to wallet`,
            resolved.account,
            encodeFunctionData({
              abi: NARYX_STRATEGY_ACCOUNT_OWNER_ABI,
              functionName: "withdrawIdleToken",
              args: [token, resolved.owner, atoms],
            }),
          ));
        }
      }
      return Object.freeze({
        domainId: BASE_SEPOLIA_DOMAIN_ID,
        chainReference: BASE_SEPOLIA_CHAIN_REFERENCE,
        environment: "TESTNET",
        contextId: config.contextId,
        owner: resolved.owner,
        account: resolved.account,
        deployed: resolved.deployed,
        quoteDecimals: decimals,
        walletQuoteAtoms: walletQuoteAtoms.toString(),
        accountQuoteAtoms: accountQuoteAtoms.toString(),
        reserveAtoms: reserveAtoms.toString(),
        requiredSpotQuoteAtoms: spotQuoteAtoms.toString(),
        requiredMarginAtoms: marginAtoms.toString(),
        fundingCovered: fundShortfall <= walletQuoteAtoms,
        steps: Object.freeze(steps),
        accountBaseAtoms: accountBaseAtoms.toString(),
        openPackage: open === null ? null : Object.freeze({
          entryReceiptHash: open.entryReceiptHash,
          baseQuantityAtoms: open.baseQuantityAtoms.toString(),
          packageSizeUnits: open.packageSizeUnits.toString(),
          entryPerpNotionalWad: open.entryPerpNotionalWad.toString(),
        }),
        withdrawals: Object.freeze(withdrawals),
      });
    },
  });
  return Object.freeze({ contexts, clock, spotPrice, feed, account, config });
}
