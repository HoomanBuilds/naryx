import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, resolve } from "node:path";
import {
  exactPrice,
  parseProtocolJson,
  type AdapterRef,
  type AssetRef,
  type ExactPrice,
  type ExactSignedRate,
  type FeeCap,
} from "@naryx/protocol-types";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { ActiveOrderContext, ActiveOrderContextProvider } from "./canonical-entry-order.js";
import type { SolanaDevnetRuntimeManifest } from "./solana-devnet-runtime.js";
import {
  anchorInstructionDiscriminator,
  decodeTestPerpMarket,
  decodeTestPerpPosition,
  decodeTestPerpStrategy,
  decodeTokenAccount,
  deriveSolanaDevnetTraderAccounts,
  priceTestPerpShortEntry,
  testPerpOraclePricePerLot,
  type SolanaDevnetTraderAccounts,
  type TestPerpMarketState,
} from "./solana-devnet-test-perp.js";
import { SOLANA_DEVNET_GENESIS_HASH } from "./terminal-execution.js";
import type { InternalOrderClockPort } from "./terminal-orders.js";

const CONTEXT_ID = /^[A-Za-z0-9:_.-]{1,128}$/;
const BPS = 10_000n;
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** Reviewed Devnet order limits. Prices are never configured; they come from the live Pyth account. */
export interface SolanaDevnetOrderContextConfig {
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
  /** Finalized slots an order context observation may age before order creation refuses it. */
  readonly maxStalenessSlots: bigint;
  readonly expiryTtlSlots: bigint;
  readonly pollIntervalMs: number;
  /** The solver's inventory spread over the oracle, in bps; the indicative spot ask. */
  readonly inventorySpreadBps: number;
  readonly maxEntrySpread: ExactSignedRate;
  readonly maximumQuantityAtoms: bigint;
  readonly maxSlippageBps: number;
  readonly maxVenueFeeAtomsByAsset: readonly FeeCap[];
  readonly maxMarginAddedAtoms: bigint;
  readonly maxProtocolFeeAtoms: bigint;
  readonly maxSolverFeeAtoms: bigint;
  readonly maxPriorityFeeAtoms: bigint;
  /** Upper bound, in collateral atoms, on one deposit step the onboarding read may propose. */
  readonly maxDepositAtoms: bigint;
  readonly strategyMaxBaseLots: bigint;
  /** Core registry accounts `initialize_cash_carry_strategy` reads for the two assets. */
  readonly registry: Readonly<{
    baseAssetIndex: string;
    baseAssetRecord: string;
    quoteAssetIndex: string;
    quoteAssetRecord: string;
  }>;
}

export type SolanaDevnetAccount = Readonly<{ owner: string; data: Uint8Array; lamports: bigint }>;

/** Signerless Devnet reads. Network identity always comes from getGenesisHash, never the URL. */
export interface SolanaDevnetMarketReadPort {
  getGenesisHash(): Promise<string>;
  getFinalizedSlot(): Promise<bigint>;
  getBlockTime(slot: bigint): Promise<bigint>;
  getAccounts(addresses: readonly string[], minContextSlot: bigint): Promise<readonly (SolanaDevnetAccount | null)[]>;
}

export type SolanaDevnetMarketSnapshot = Readonly<{
  slot: bigint;
  blockTime: bigint;
  observedAtMs: number;
  market: TestPerpMarketState;
  oraclePricePerLot: bigint;
  oraclePublishTime: bigint;
}>;

function fail(message: string): never {
  throw new Error(`Solana Devnet order context: ${message}`);
}

function positive(value: unknown, name: string): bigint {
  if (typeof value !== "bigint" || value <= 0n) fail(`${name} must be a positive integer`);
  return value;
}

function nonnegative(value: unknown, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n) fail(`${name} must be a nonnegative integer`);
  return value;
}

function address(value: unknown, name: string): string {
  try {
    return new PublicKey(String(value)).toBase58();
  } catch {
    fail(`${name} is not a Solana address`);
  }
}

function validateConfig(config: SolanaDevnetOrderContextConfig): SolanaDevnetOrderContextConfig {
  if (config?.schemaVersion !== 1 || typeof config.contextId !== "string" || !CONTEXT_ID.test(config.contextId)
    || !Number.isSafeInteger(config.pollIntervalMs) || config.pollIntervalMs < 1_000
    || !Number.isSafeInteger(config.inventorySpreadBps) || config.inventorySpreadBps < 0 || config.inventorySpreadBps > 1_000
    || !Number.isSafeInteger(config.maxSlippageBps) || config.maxSlippageBps < 1 || config.maxSlippageBps > 10_000
    || !Array.isArray(config.maxVenueFeeAtomsByAsset) || config.maxVenueFeeAtomsByAsset.length === 0
    || typeof config.registry !== "object" || config.registry === null) {
    fail("configuration is invalid");
  }
  positive(config.maxStalenessSlots, "maxStalenessSlots");
  positive(config.expiryTtlSlots, "expiryTtlSlots");
  positive(config.maximumQuantityAtoms, "maximumQuantityAtoms");
  positive(config.maxMarginAddedAtoms, "maxMarginAddedAtoms");
  positive(config.maxDepositAtoms, "maxDepositAtoms");
  positive(config.strategyMaxBaseLots, "strategyMaxBaseLots");
  nonnegative(config.maxProtocolFeeAtoms, "maxProtocolFeeAtoms");
  nonnegative(config.maxSolverFeeAtoms, "maxSolverFeeAtoms");
  nonnegative(config.maxPriorityFeeAtoms, "maxPriorityFeeAtoms");
  for (const [name, value] of Object.entries(config.registry)) address(value, `registry.${name}`);
  address(config.baseAsset.assetId, "baseAsset.assetId");
  address(config.quoteAsset.assetId, "quoteAsset.assetId");
  return config;
}

export function loadSolanaDevnetOrderContextConfig(path: string): SolanaDevnetOrderContextConfig {
  if (!isAbsolute(path)) fail("NARYX_SOLANA_DEVNET_ORDER_CONTEXT must be an absolute path");
  return validateConfig(parseProtocolJson(readFileSync(resolve(path), "utf8"), "solanaDevnetOrderContext") as SolanaDevnetOrderContextConfig);
}

/** A fixed-endpoint JSON-RPC reader. It has no signer and calls only read methods. */
export class HttpSolanaDevnetMarketReadPort implements SolanaDevnetMarketReadPort {
  readonly #url: string;

  constructor(rpcUrl: string) {
    const url = new URL(rpcUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) {
      fail("RPC URL must be HTTPS");
    }
    this.#url = url.toString();
  }

  async #call(method: string, params: readonly unknown[]): Promise<unknown> {
    const response = await fetch(this.#url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) fail(`RPC ${method} returned HTTP ${response.status}`);
    const envelope = await response.json() as { result?: unknown; error?: unknown };
    if (envelope.error !== undefined || !("result" in envelope)) fail(`RPC ${method} failed`);
    return envelope.result;
  }

  async getGenesisHash(): Promise<string> {
    return String(await this.#call("getGenesisHash", []));
  }

  async getFinalizedSlot(): Promise<bigint> {
    const slot = await this.#call("getSlot", [{ commitment: "finalized" }]);
    if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0) fail("finalized slot is invalid");
    return BigInt(slot);
  }

  async getBlockTime(slot: bigint): Promise<bigint> {
    const time = await this.#call("getBlockTime", [Number(slot)]);
    if (typeof time !== "number" || !Number.isSafeInteger(time) || time <= 0) fail("block time is unavailable");
    return BigInt(time);
  }

  async getAccounts(addresses: readonly string[], minContextSlot: bigint): Promise<readonly (SolanaDevnetAccount | null)[]> {
    const result = await this.#call("getMultipleAccounts", [
      [...addresses],
      { encoding: "base64", commitment: "finalized", minContextSlot: Number(minContextSlot) },
    ]) as { value?: unknown };
    if (!Array.isArray(result?.value) || result.value.length !== addresses.length) fail("account read is malformed");
    return result.value.map((entry: unknown) => {
      if (entry === null) return null;
      const account = entry as { owner?: unknown; data?: unknown; lamports?: unknown };
      if (typeof account.owner !== "string" || !Array.isArray(account.data) || typeof account.data[0] !== "string"
        || typeof account.lamports !== "number") {
        fail("account encoding is invalid");
      }
      return Object.freeze({
        owner: account.owner,
        data: Uint8Array.from(Buffer.from(account.data[0], "base64")),
        lamports: BigInt(account.lamports),
      });
    });
  }
}

async function requireDevnet(port: SolanaDevnetMarketReadPort): Promise<void> {
  if (await port.getGenesisHash() !== SOLANA_DEVNET_GENESIS_HASH) fail("RPC genesis hash is not Solana Devnet");
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** Collateral atoms per base atom: the oracle per lot moved by `bps` (positive is up), rounded up. */
export function solanaDevnetOraclePrice(
  baseAsset: AssetRef,
  quoteAsset: AssetRef,
  snapshot: Pick<SolanaDevnetMarketSnapshot, "market" | "oraclePricePerLot">,
  bps: bigint,
): ExactPrice {
  const quoteAtoms = snapshot.oraclePricePerLot * (BPS + bps);
  const baseAtoms = snapshot.market.baseLotAtoms * BPS;
  if (quoteAtoms <= 0n) fail("price is not positive");
  const divisor = gcd(quoteAtoms, baseAtoms);
  return exactPrice({
    baseAsset,
    quoteAsset,
    quoteAtoms: quoteAtoms / divisor,
    baseAtoms: baseAtoms / divisor,
    roundingDirection: "CEIL",
  });
}

export class SolanaDevnetMarketFeed {
  readonly #manifest: SolanaDevnetRuntimeManifest;
  readonly #config: SolanaDevnetOrderContextConfig;
  readonly #port: SolanaDevnetMarketReadPort;
  readonly #currentTimeMs: () => number;
  #latest: SolanaDevnetMarketSnapshot | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    manifest: SolanaDevnetRuntimeManifest,
    config: SolanaDevnetOrderContextConfig,
    port: SolanaDevnetMarketReadPort,
    currentTimeMs: () => number = Date.now,
  ) {
    this.#manifest = manifest;
    this.#config = validateConfig(config);
    this.#port = port;
    this.#currentTimeMs = currentTimeMs;
  }

  latest(): SolanaDevnetMarketSnapshot | undefined {
    return this.#latest;
  }

  /** Any failed, stale, or mismatched read clears the snapshot, so the context reports unknown. */
  async refresh(): Promise<SolanaDevnetMarketSnapshot> {
    try {
      await requireDevnet(this.#port);
      const slot = await this.#port.getFinalizedSlot();
      const testPerp = this.#manifest.testPerp;
      const [accounts, blockTime] = await Promise.all([
        this.#port.getAccounts([testPerp.market, testPerp.oracle], slot),
        this.#port.getBlockTime(slot),
      ]);
      const venue = this.#manifest.programs.find((program) => program.name === "perp_venue");
      const marketAccount = accounts[0];
      const oracleAccount = accounts[1];
      if (venue === undefined || marketAccount === null || marketAccount === undefined
        || marketAccount.owner !== new PublicKey(venue.programId).toBase58()) {
        fail("test perp market is absent or not owned by the reviewed venue program");
      }
      if (oracleAccount === null || oracleAccount === undefined) fail("oracle account is absent");
      const market = decodeTestPerpMarket(marketAccount.data);
      if (market.oracle !== testPerp.oracle || market.feedIdHex !== testPerp.feedIdHex) {
        fail("test perp market does not pin the reviewed Pyth SOL/USD account and feed");
      }
      if (market.collateralMint !== address(this.#config.quoteAsset.assetId, "quoteAsset")
        || market.collateralDecimals !== this.#config.quoteAsset.decimals
        || market.baseDecimals !== this.#config.baseAsset.decimals) {
        fail("test perp market collateral or decimals do not match the order assets");
      }
      const priced = testPerpOraclePricePerLot(market, { address: testPerp.oracle, ...oracleAccount }, blockTime);
      this.#latest = Object.freeze({
        slot,
        blockTime,
        observedAtMs: this.#currentTimeMs(),
        market,
        oraclePricePerLot: priced.pricePerLot,
        oraclePublishTime: priced.message.publishTime,
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

export type SolanaDevnetInstruction = Readonly<{
  programId: string;
  accounts: readonly Readonly<{ pubkey: string; isSigner: boolean; isWritable: boolean }>[];
  dataBase64: string;
}>;

export type SolanaDevnetOnboardingStep = Readonly<{
  kind: "CREATE_TOKEN_ACCOUNTS" | "INITIALIZE_POSITION" | "DEPOSIT_COLLATERAL" | "SET_POSITION_DELEGATE"
    | "INITIALIZE_STRATEGY" | "INITIALIZE_EXECUTOR_AUTHORITY";
  label: string;
  instructions: readonly SolanaDevnetInstruction[];
}>;

export type SolanaDevnetAccountStatus = Readonly<{
  domainId: "svm:devnet";
  environment: "DEVNET";
  contextId: string;
  owner: string;
  settlementAccount: string;
  accounts: SolanaDevnetTraderAccounts;
  positionCollateralAtoms: string;
  positionBaseLots: string;
  traderQuoteAtoms: string;
  requiredCollateralAtoms: string;
  ready: boolean;
  steps: readonly SolanaDevnetOnboardingStep[];
}>;

export type SolanaDevnetOrderRuntime = Readonly<{
  contexts: ActiveOrderContextProvider;
  clock: InternalOrderClockPort;
  feed: SolanaDevnetMarketFeed;
  config: SolanaDevnetOrderContextConfig;
  accountStatus(owner: string, sizeAtoms: bigint): Promise<SolanaDevnetAccountStatus>;
  /** GET /internal/terminal/solana-devnet/account?owner=<base58>&sizeAtoms=<atoms>. Read-only. */
  handler(request: IncomingMessage, response: ServerResponse): boolean;
}>;

function meta(pubkey: string, isSigner: boolean, isWritable: boolean) {
  return Object.freeze({ pubkey, isSigner, isWritable });
}

function instruction(programId: string, accounts: ReturnType<typeof meta>[], data: Uint8Array): SolanaDevnetInstruction {
  return Object.freeze({ programId, accounts: Object.freeze(accounts), dataBase64: Buffer.from(data).toString("base64") });
}

function u64Le(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export async function createSolanaDevnetOrderRuntime(input: Readonly<{
  manifest: SolanaDevnetRuntimeManifest;
  config: SolanaDevnetOrderContextConfig;
  port: SolanaDevnetMarketReadPort;
}>): Promise<SolanaDevnetOrderRuntime> {
  const { manifest, port } = input;
  const config = validateConfig(input.config);
  if (manifest.domain.domainId !== "svm:devnet") fail("manifest domain must be svm:devnet");
  const feed = new SolanaDevnetMarketFeed(manifest, config, port);
  await feed.refresh();
  const program = (name: string) => {
    const found = manifest.programs.find((item) => item.name === name);
    if (found === undefined) fail(`program ${name} is missing from the manifest`);
    return new PublicKey(found.programId).toBase58();
  };
  const core = program("core");
  const perpAdapter = program("perp_adapter");
  const perpVenue = program("perp_venue");
  const baseMint = address(config.baseAsset.assetId, "baseAsset");
  const quoteMint = address(config.quoteAsset.assetId, "quoteAsset");
  let cached: Readonly<{ snapshot: SolanaDevnetMarketSnapshot; context: ActiveOrderContext }> | undefined;
  const contexts: ActiveOrderContextProvider = (contextId) => {
    if (contextId !== config.contextId) return undefined;
    const snapshot = feed.latest();
    if (snapshot === undefined) return undefined;
    if (cached?.snapshot === snapshot) return cached.context;
    const context: ActiveOrderContext = Object.freeze({
      contextId: config.contextId,
      state: "ACTIVE",
      // Finalized slot of the observation, so order creation enforces staleness in chain slots.
      capturedAtClock: snapshot.slot,
      maxStaleness: config.maxStalenessSlots,
      domain: manifest.domain,
      environment: "devnet",
      orderVersion: config.orderVersion,
      templateId: config.templateId,
      templateVersion: config.templateVersion,
      packageTemplateManifestHash: config.packageTemplateManifestHash,
      baseAsset: config.baseAsset,
      quoteAsset: config.quoteAsset,
      spotAdapters: [config.spotAdapter],
      perpAdapters: [config.perpetualAdapter],
      settlementClass: "ATOMIC_POSTCONDITION",
      expiryUnit: "SOLANA_SLOT",
      expiryTtl: config.expiryTtlSlots,
      spotReferencePrice: solanaDevnetOraclePrice(config.baseAsset, config.quoteAsset, snapshot, BigInt(config.inventorySpreadBps)),
      maxEntrySpread: config.maxEntrySpread,
      maximumQuantityAtoms: config.maximumQuantityAtoms,
      maxSlippageBps: config.maxSlippageBps,
      maxVenueFeeAtomsByAsset: config.maxVenueFeeAtomsByAsset,
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
  const clock: InternalOrderClockPort = Object.freeze({
    currentClock: async (context: ActiveOrderContext) => {
      if (context.contextId !== config.contextId) fail("context is unknown");
      await requireDevnet(port);
      return port.getFinalizedSlot();
    },
  });

  async function accountStatus(ownerInput: string, sizeAtoms: bigint): Promise<SolanaDevnetAccountStatus> {
    const owner = address(ownerInput, "owner");
    if (typeof sizeAtoms !== "bigint" || sizeAtoms < 0n || sizeAtoms > config.maximumQuantityAtoms) fail("size is out of bounds");
    const snapshot = feed.latest() ?? await feed.refresh();
    const market = snapshot.market;
    const derived = deriveSolanaDevnetTraderAccounts({
      owner, strategyIdHex: manifest.testPerp.strategyIdHex, market: manifest.testPerp.market,
      coreProgram: core, perpAdapterProgram: perpAdapter, perpVenueProgram: perpVenue, baseMint, quoteMint,
    });
    await requireDevnet(port);
    const slot = await port.getFinalizedSlot();
    const [position, strategy, executor, traderBase, traderQuote, executorBase, executorQuote] = await port.getAccounts([
      derived.position, derived.strategy, derived.executorAuthority, derived.traderBase, derived.traderQuote,
      derived.executorBase, derived.executorQuote,
    ], slot);
    const positionState = position === null || position === undefined || position.owner !== perpVenue
      ? undefined : decodeTestPerpPosition(position.data);
    const strategyState = strategy === null || strategy === undefined || strategy.owner !== perpAdapter
      ? undefined : decodeTestPerpStrategy(strategy.data);
    const traderQuoteAtoms = traderQuote === null || traderQuote === undefined || traderQuote.owner !== TOKEN_PROGRAM_ID
      ? 0n : decodeTokenAccount(traderQuote.data).amount;
    const entry = sizeAtoms === 0n ? undefined : priceTestPerpShortEntry(market, snapshot.oraclePricePerLot, sizeAtoms);
    // The core requires prefunded collateral at or above initial margin after the taker fee.
    const requiredCollateral = entry === undefined ? 0n : entry.initialMarginAtoms + entry.feeAtoms;
    const collateral = positionState?.collateralAtoms ?? 0n;
    const steps: SolanaDevnetOnboardingStep[] = [];
    const ataCreates = ([
      [traderBase, derived.traderBase, owner, baseMint],
      [traderQuote, derived.traderQuote, owner, quoteMint],
      [executorBase, derived.executorBase, derived.executorAuthority, baseMint],
      [executorQuote, derived.executorQuote, derived.executorAuthority, quoteMint],
    ] as const).filter(([account]) => account === null || account === undefined).map(([, ata, ataOwner, mint]) =>
      instruction(ASSOCIATED_TOKEN_PROGRAM_ID, [
        meta(owner, true, true), meta(ata, false, true), meta(ataOwner, false, false), meta(mint, false, false),
        meta(SystemProgram.programId.toBase58(), false, false), meta(TOKEN_PROGRAM_ID, false, false),
      ], Uint8Array.of(1)));
    if (ataCreates.length > 0) {
      steps.push({ kind: "CREATE_TOKEN_ACCOUNTS", label: "Create trader and executor token accounts", instructions: ataCreates });
    }
    if (positionState === undefined) {
      steps.push({
        kind: "INITIALIZE_POSITION",
        label: "Create test perp position",
        instructions: [instruction(perpVenue, [
          meta(owner, true, true), meta(manifest.testPerp.market, false, false), meta(derived.position, false, true),
          meta(SystemProgram.programId.toBase58(), false, false),
        ], anchorInstructionDiscriminator("initialize_position"))],
      });
    }
    if (collateral < requiredCollateral) {
      const shortfall = requiredCollateral - collateral;
      if (shortfall > config.maxDepositAtoms) fail("required collateral exceeds the reviewed deposit bound");
      steps.push({
        kind: "DEPOSIT_COLLATERAL",
        label: `Deposit ${shortfall} collateral atoms`,
        instructions: [instruction(perpVenue, [
          meta(owner, true, false), meta(manifest.testPerp.market, false, false), meta(derived.position, false, true),
          meta(market.collateralVault, false, true), meta(derived.traderQuote, false, true), meta(TOKEN_PROGRAM_ID, false, false),
        ], Buffer.concat([anchorInstructionDiscriminator("deposit"), u64Le(shortfall)]))],
      });
    }
    // The adapter requires the position to be delegated to the strategy before the strategy exists.
    if (positionState === undefined || positionState.delegate !== derived.strategy) {
      steps.push({
        kind: "SET_POSITION_DELEGATE",
        label: "Delegate position trading to the strategy",
        instructions: [instruction(perpVenue, [meta(owner, true, false), meta(derived.position, false, true)],
          Buffer.concat([anchorInstructionDiscriminator("set_delegate"), new PublicKey(derived.strategy).toBuffer()]))],
      });
    }
    if (strategyState === undefined) {
      steps.push({
        kind: "INITIALIZE_STRATEGY",
        label: "Create strategy with the Naryx executor as controller",
        instructions: [instruction(perpAdapter, [
          meta(owner, true, true), meta(derived.strategy, false, true), meta(manifest.testPerp.market, false, false),
          meta(derived.position, false, false), meta(SystemProgram.programId.toBase58(), false, false),
        ], Buffer.concat([
          anchorInstructionDiscriminator("initialize_test_perp_strategy"),
          Buffer.from(manifest.testPerp.strategyIdHex, "hex"),
          new PublicKey(derived.executorAuthority).toBuffer(),
          u64Le(config.strategyMaxBaseLots),
        ]))],
      });
    } else if (strategyState.controller !== derived.executorAuthority || strategyState.position !== derived.position
      || strategyState.market !== new PublicKey(manifest.testPerp.market).toBase58()) {
      fail("existing strategy is not controlled by the Naryx executor for this market");
    }
    if (executor === null || executor === undefined) {
      const configPda = PublicKey.findProgramAddressSync([Buffer.from("naryx-protocol-config")], new PublicKey(core))[0].toBase58();
      steps.push({
        kind: "INITIALIZE_EXECUTOR_AUTHORITY",
        label: "Register the strategy with Naryx",
        instructions: [instruction(core, [
          meta(owner, true, true), meta(configPda, false, false),
          meta(config.registry.baseAssetIndex, false, false), meta(config.registry.baseAssetRecord, false, false),
          meta(config.registry.quoteAssetIndex, false, false), meta(config.registry.quoteAssetRecord, false, false),
          meta(baseMint, false, false), meta(quoteMint, false, false), meta(derived.strategy, false, false),
          meta(derived.executorAuthority, false, true), meta(SystemProgram.programId.toBase58(), false, false),
        ], anchorInstructionDiscriminator("initialize_cash_carry_strategy"))],
      });
    } else if (executor.owner !== core) {
      fail("executor authority account has the wrong owner");
    }
    return Object.freeze({
      domainId: "svm:devnet",
      environment: "DEVNET",
      contextId: config.contextId,
      owner,
      settlementAccount: owner,
      accounts: derived,
      positionCollateralAtoms: collateral.toString(),
      positionBaseLots: (positionState?.baseLots ?? 0n).toString(),
      traderQuoteAtoms: traderQuoteAtoms.toString(),
      requiredCollateralAtoms: requiredCollateral.toString(),
      ready: steps.length === 0,
      steps: Object.freeze(steps),
    });
  }

  const handler = (request: IncomingMessage, response: ServerResponse): boolean => {
    const url = new URL(request.url ?? "/", "http://api.internal");
    if (url.pathname !== "/internal/terminal/solana-devnet/account") return false;
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is allowed." } });
      return true;
    }
    const owner = url.searchParams.get("owner") ?? "";
    const size = url.searchParams.get("sizeAtoms") ?? "0";
    if (!/^(?:0|[1-9][0-9]{0,30})$/.test(size)) {
      sendJson(response, 400, { error: { code: "INVALID_REQUEST", message: "sizeAtoms must be a decimal integer." } });
      return true;
    }
    void accountStatus(owner, BigInt(size)).then(
      (status) => sendJson(response, 200, status),
      () => sendJson(response, 502, { error: { code: "ACCOUNT_READ_FAILED", message: "Solana Devnet account read failed closed." } }),
    );
    return true;
  };

  return Object.freeze({ contexts, clock, feed, config, accountStatus, handler });
}
