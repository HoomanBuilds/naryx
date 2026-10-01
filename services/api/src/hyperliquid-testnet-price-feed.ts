import type {
  HyperliquidTestnetLivePricingConfig,
  HyperliquidTestnetRuntimeConfig,
} from "./hyperliquid-testnet-runtime-client.js";

export const HYPERLIQUID_TESTNET_INFO_URL = "https://api.hyperliquid-testnet.xyz/info";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
// Testnet spot metadata lists every deployed token, so metadata gets a larger bound than books.
const MAX_METADATA_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_BOOK_LEVELS = 100;
const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?$/;
const COIN = /^[A-Za-z0-9@._:/-]{1,64}$/;
const BPS_SCALE = 10_000n;

export type HyperliquidTestnetInfoRequest =
  | Readonly<{ type: "meta" }>
  | Readonly<{ type: "spotMeta" }>
  | Readonly<{ type: "l2Book"; coin: string }>
  | Readonly<{ type: "userFees"; user: string }>;

export interface HyperliquidTestnetInfoPort {
  info(request: HyperliquidTestnetInfoRequest): Promise<unknown>;
}

export type HyperliquidTestnetInfoHttpOptions = Readonly<{
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}>;

export type HyperliquidTestnetBookTop = Readonly<{ bid: string; ask: string }>;

export type HyperliquidTestnetPriceSnapshot = Readonly<{
  capturedAtMs: number;
  spot: HyperliquidTestnetBookTop;
  perp: HyperliquidTestnetBookTop;
  spotTakerRate: string;
  perpTakerRate: string;
}>;

export interface HyperliquidTestnetPriceSource {
  latest(): HyperliquidTestnetPriceSnapshot | undefined;
}

export type HyperliquidTestnetPriceFeedOptions = Readonly<{
  info?: HyperliquidTestnetInfoPort;
  currentTimeMs?: () => number;
  report?: (message: string) => void;
}>;

export type HyperliquidDecimal = Readonly<{ digits: bigint; scale: number }>;

export class HyperliquidTestnetPriceFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HyperliquidTestnetPriceFeedError";
  }
}

function fail(message: string): never {
  throw new HyperliquidTestnetPriceFeedError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHyperliquidDecimal(value: unknown, name: string): HyperliquidDecimal {
  if (typeof value !== "string" || value.length > 40) fail(`${name} is not a bounded decimal string`);
  const match = DECIMAL.exec(value);
  if (match === null) fail(`${name} is malformed`);
  const fraction = match[2] ?? "";
  return Object.freeze({ digits: BigInt(`${match[1] as string}${fraction}`), scale: fraction.length });
}

function compareDecimals(left: HyperliquidDecimal, right: HyperliquidDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const normalizedLeft = left.digits * 10n ** BigInt(scale - left.scale);
  const normalizedRight = right.digits * 10n ** BigInt(scale - right.scale);
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const lengthHeader = response.headers.get("content-length");
  if (contentType !== "application/json" || response.body === null
    || (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > maxBytes))) {
    fail("info response is invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.length;
    if (length > maxBytes) {
      await reader.cancel();
      fail("info response is too large");
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    fail("info response is not JSON");
  }
}

// The info endpoint is pinned: there is no URL parameter, no signer, and no exchange path.
export function createFetchHyperliquidTestnetInfoPort(
  options: HyperliquidTestnetInfoHttpOptions = {},
): HyperliquidTestnetInfoPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    fail("info timeout must be a bounded positive integer");
  }
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return Object.freeze({
    async info(request: HyperliquidTestnetInfoRequest): Promise<unknown> {
      let response: Response;
      try {
        response = await fetchImplementation(HYPERLIQUID_TESTNET_INFO_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        fail(`${request.type} info request failed`);
      }
      if (!response.ok) fail(`${request.type} info request failed with HTTP ${response.status}`);
      const metadata = request.type === "meta" || request.type === "spotMeta";
      return readBoundedJson(response, metadata ? MAX_METADATA_RESPONSE_BYTES : MAX_RESPONSE_BYTES);
    },
  });
}

function perpetualCoin(value: unknown, assetIndex: number): string {
  const universe = isRecord(value) ? value.universe : undefined;
  const entry: unknown = Array.isArray(universe) ? universe[assetIndex] : undefined;
  if (!isRecord(entry) || typeof entry.name !== "string" || !COIN.test(entry.name)
    || entry.isDelisted === true) {
    fail("perpetual metadata does not contain the configured active asset");
  }
  return entry.name;
}

function spotCoin(value: unknown, universeIndex: number, tokens: readonly [number, number]): string {
  const universe = isRecord(value) ? value.universe : undefined;
  const entries = Array.isArray(universe)
    ? universe.filter((entry) => isRecord(entry) && entry.index === universeIndex)
    : [];
  const entry: unknown = entries[0];
  if (entries.length !== 1 || !isRecord(entry) || typeof entry.name !== "string" || !COIN.test(entry.name)
    || !Array.isArray(entry.tokens) || entry.tokens.length !== 2
    || entry.tokens[0] !== tokens[0] || entry.tokens[1] !== tokens[1]) {
    fail("spot metadata does not contain the configured token pair");
  }
  return entry.name;
}

function bookTop(
  value: unknown,
  coin: string,
  name: string,
  receivedAtMs: number,
  pricing: HyperliquidTestnetLivePricingConfig,
): HyperliquidTestnetBookTop {
  if (!isRecord(value) || value.coin !== coin) fail(`${name} identity does not match the configured coin`);
  const time = value.time;
  if (typeof time !== "number" || !Number.isSafeInteger(time) || time <= 0) {
    fail(`${name} timestamp is invalid`);
  }
  if (time > receivedAtMs || receivedAtMs - time > pricing.maxBookAgeMs) {
    fail(`${name} is stale or future-dated`);
  }
  const levels = value.levels;
  if (!Array.isArray(levels) || levels.length !== 2) fail(`${name} levels are invalid`);
  const best: HyperliquidDecimal[] = [];
  const bestText: string[] = [];
  for (const [sideIndex, side] of (levels as unknown[]).entries()) {
    if (!Array.isArray(side) || side.length === 0 || side.length > MAX_BOOK_LEVELS) {
      fail(`${name} must have bounded bids and asks`);
    }
    let previous: HyperliquidDecimal | undefined;
    for (const level of side as unknown[]) {
      if (!isRecord(level) || typeof level.n !== "number" || !Number.isSafeInteger(level.n) || level.n <= 0) {
        fail(`${name} level is invalid`);
      }
      const price = parseHyperliquidDecimal(level.px, `${name} price`);
      const size = parseHyperliquidDecimal(level.sz, `${name} size`);
      if (price.digits === 0n || size.digits === 0n) fail(`${name} level must be positive`);
      // Bids descend and asks ascend strictly, so the first level of each side is the best.
      if (previous !== undefined
        && (sideIndex === 0 ? compareDecimals(previous, price) <= 0 : compareDecimals(previous, price) >= 0)) {
        fail(`${name} levels are not strictly price ordered`);
      }
      if (previous === undefined) {
        best.push(price);
        bestText.push(level.px as string);
      }
      previous = price;
    }
  }
  const bid = best[0] as HyperliquidDecimal;
  const ask = best[1] as HyperliquidDecimal;
  if (compareDecimals(bid, ask) >= 0) fail(`${name} is crossed or locked`);
  const scale = Math.max(bid.scale, ask.scale);
  const bidAtoms = bid.digits * 10n ** BigInt(scale - bid.scale);
  const askAtoms = ask.digits * 10n ** BigInt(scale - ask.scale);
  if ((askAtoms - bidAtoms) * BPS_SCALE > bidAtoms * BigInt(pricing.maxBookSpreadBps)) {
    fail(`${name} bid-ask spread exceeds the configured cap`);
  }
  return Object.freeze({ bid: bestText[0] as string, ask: bestText[1] as string });
}

// A taker rate at or above 1% is outside every Hyperliquid fee tier and is treated as malformed.
function takerRate(value: unknown, name: string): string {
  const rate = parseHyperliquidDecimal(value, name);
  if (rate.digits * 100n >= 10n ** BigInt(rate.scale)) fail(`${name} is outside the accepted fee range`);
  return value as string;
}

function failureMessage(error: unknown): string {
  return error instanceof HyperliquidTestnetPriceFeedError ? error.message : "info request failed";
}

export class HyperliquidTestnetPriceFeed implements HyperliquidTestnetPriceSource {
  readonly #info: HyperliquidTestnetInfoPort;
  readonly #currentTimeMs: () => number;
  readonly #report: (message: string) => void;
  readonly #pricing: HyperliquidTestnetLivePricingConfig;
  readonly #tradingAccount: string;
  readonly #spotUniverseIndex: number;
  readonly #spotTokens: readonly [number, number];
  readonly #perpetualAssetIndex: number;
  #coins: Readonly<{ spot: string; perp: string }> | undefined;
  #snapshot: HyperliquidTestnetPriceSnapshot | undefined;
  #inFlight: Promise<boolean> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #started = false;
  #failing = false;

  constructor(config: HyperliquidTestnetRuntimeConfig, options: HyperliquidTestnetPriceFeedOptions = {}) {
    const order = config.orderContext;
    if (order === undefined) throw new Error("Hyperliquid Testnet order context is missing.");
    this.#info = options.info ?? createFetchHyperliquidTestnetInfoPort();
    this.#currentTimeMs = options.currentTimeMs ?? Date.now;
    this.#report = options.report
      ?? ((message) => { process.stderr.write(`Naryx API Hyperliquid Testnet price feed: ${message}\n`); });
    this.#pricing = order.livePricing;
    this.#tradingAccount = order.tradingAccount;
    this.#spotUniverseIndex = config.market.spot.universeIndex;
    this.#spotTokens = Object.freeze([config.market.spot.tokenIndex, config.market.quoteTokenIndex] as const);
    this.#perpetualAssetIndex = config.market.perpetual.assetIndex;
  }

  latest(): HyperliquidTestnetPriceSnapshot | undefined {
    return this.#snapshot;
  }

  // Resolves after the first refresh attempt and never rejects; a failed attempt leaves no snapshot.
  start(): Promise<boolean> {
    if (this.#started) return this.#inFlight ?? Promise.resolve(this.#snapshot !== undefined);
    this.#started = true;
    const first = this.refresh();
    void first.then(() => this.#schedule());
    return first;
  }

  stop(): void {
    this.#started = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  refresh(): Promise<boolean> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    const attempt = this.#refreshOnce().then(
      () => {
        if (this.#failing) this.#report("refresh recovered");
        this.#failing = false;
        return true;
      },
      (error: unknown) => {
        if (!this.#failing) this.#report(`refresh failed, keeping the previous snapshot: ${failureMessage(error)}`);
        this.#failing = true;
        return false;
      },
    ).finally(() => {
      this.#inFlight = undefined;
    });
    this.#inFlight = attempt;
    return attempt;
  }

  #schedule(): void {
    if (!this.#started || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.refresh().then(() => this.#schedule());
    }, this.#pricing.refreshIntervalMs);
    this.#timer.unref();
  }

  #now(): number {
    const value = this.#currentTimeMs();
    if (!Number.isSafeInteger(value) || value <= 0) fail("local millisecond clock is invalid");
    return value;
  }

  async #refreshOnce(): Promise<void> {
    if (this.#coins === undefined) {
      const [meta, spotMeta] = await Promise.all([
        this.#info.info({ type: "meta" }),
        this.#info.info({ type: "spotMeta" }),
      ]);
      this.#coins = Object.freeze({
        spot: spotCoin(spotMeta, this.#spotUniverseIndex, this.#spotTokens),
        perp: perpetualCoin(meta, this.#perpetualAssetIndex),
      });
    }
    const coins = this.#coins;
    const [spotBook, perpBook, fees] = await Promise.all([
      this.#info.info({ type: "l2Book", coin: coins.spot }),
      this.#info.info({ type: "l2Book", coin: coins.perp }),
      this.#info.info({ type: "userFees", user: this.#tradingAccount }),
    ]);
    const receivedAtMs = this.#now();
    const spot = bookTop(spotBook, coins.spot, "spot book", receivedAtMs, this.#pricing);
    const perp = bookTop(perpBook, coins.perp, "perpetual book", receivedAtMs, this.#pricing);
    if (!isRecord(fees)) fail("user fees are invalid");
    this.#snapshot = Object.freeze({
      capturedAtMs: receivedAtMs,
      spot,
      perp,
      spotTakerRate: takerRate(fees.userSpotCrossRate, "userSpotCrossRate"),
      perpTakerRate: takerRate(fees.userCrossRate, "userCrossRate"),
    });
  }
}
