import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { bytesEqual, manifestHash, parseProtocolJson, stringifyProtocolJson, type AssetRef, type DomainRef } from '@naryx/protocol-types';
import { TESTNET_API_URL } from '@nktkas/hyperliquid';
import { quoteConfiguration } from './hyperliquid-testnet-quote-config.js';
import { checkedHyperliquidTestnetBook, hyperliquidTestnetDecimal, HyperliquidSdkTestnetMarketReadClient,
  type HyperliquidTestnetQuoteMarketReadPort } from './hyperliquid-testnet-market-preflight.js';
import { hyperliquidTestnetPoolFundingReads } from './hyperliquid-pool-funding-reads.js';
import type { HyperliquidPoolFundingReadPort } from './hyperliquid-pool-funding.js';
import type { GeneralizedStrategyQuoteLane } from './strategy-quote-context-registry.js';
import type { MakerControlSigner } from './maker-control.js';
import { HttpPackageMakerGateway, PackageMaker, PackageMakerJournal, PACKAGE_MAKER_LEVELS,
  makerPriceTicks, type PackageMakerSnapshot } from './package-maker.js';

type Instrument = Readonly<{ coin: string; sizeDecimals: number }>;
export interface HyperliquidMakerMarket {
  readonly templateId: string;
  readonly solverId: string;
  readonly domain: DomainRef;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly perpetual: Instrument;
  readonly spot: Instrument;
  readonly counterPerpetual?: Instrument;
  readonly marginBps: number;
  readonly maxBookAgeMs: number;
  readonly maxBookSpreadBps: number;
}
interface MakerFunding {
  readonly fundingAccount: `0x${string}`;
  readonly maximumCapacityAtoms: bigint;
  readonly quantity: bigint;
  readonly levels: number;
  readonly backingAtomsPerWholeAsset: bigint;
}
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
const positive = (n: unknown): n is bigint => typeof n === 'bigint' && n > 0n && n < (1n << 128n);

export function createHyperliquidMakerReader(input: MakerFunding & Readonly<{
  marketId: string; market: HyperliquidMakerMarket; books: HyperliquidTestnetQuoteMarketReadPort;
  funding: Pick<HyperliquidPoolFundingReadPort, 'flat'>; clockMs?: () => number;
}>) {
  const { market } = input;
  const cash = market.templateId === 'cash-and-carry-v1';
  const twoPerps = ['perpetual-funding-spread-v1', 'hedge-migration-v1'].includes(market.templateId);
  const single = ['external-inventory-hedge-v1', 'delta-neutral-rebalance-v1'].includes(market.templateId);
  if ((!cash && !twoPerps && !single) || market.domain.domainId !== 'hypercore:testnet'
    || input.books.environment !== 'testnet' || input.books.apiUrl !== TESTNET_API_URL
    || market.baseAsset.decimals !== 10 || market.quoteAsset.decimals !== 8
    || !/^0x(?!0{40}$)[0-9a-f]{40}$/.test(input.fundingAccount)
    || !positive(input.quantity) || !positive(input.backingAtomsPerWholeAsset) || !positive(input.maximumCapacityAtoms)
    || !Number.isInteger(input.levels) || input.levels < 1 || input.levels > PACKAGE_MAKER_LEVELS
    || !Number.isInteger(market.marginBps) || market.marginBps < 500 || market.marginBps > 10_000
    || !Number.isInteger(market.maxBookAgeMs) || market.maxBookAgeMs < 1 || market.maxBookAgeMs > 15_000
    || !Number.isInteger(market.maxBookSpreadBps) || market.maxBookSpreadBps < 1 || market.maxBookSpreadBps > 3000
    || (twoPerps && (!market.counterPerpetual || market.counterPerpetual.coin === market.perpetual.coin))) {
    throw new Error('Hyperliquid maker requires bounded, recognized testnet markets and funded capacity.');
  }
  const instruments = cash ? [market.spot, market.perpetual]
    : twoPerps ? [market.perpetual, market.counterPerpetual!] : [market.perpetual];
  if (instruments.some(i => !Number.isInteger(i.sizeDecimals) || i.sizeDecimals < 0 || i.sizeDecimals > 6
    || !/^[A-Za-z0-9@._:/-]{1,64}$/.test(i.coin)
    || input.quantity % (10n ** BigInt(market.baseAsset.decimals - i.sizeDecimals)) !== 0n)) {
    throw new Error('Maker quantities must respect every venue lot size.');
  }
  const signs = single ? [-1n] : [1n, -1n];
  const sourceIds = instruments.map((_, i) => `${market.solverId}:${input.marketId}:0:${i}`);
  const baseScale = 10n ** BigInt(market.baseAsset.decimals);
  return { sourceIds, read: async (sourceVersion: bigint): Promise<PackageMakerSnapshot> => {
    const [proof, ...values] = await Promise.all([input.funding.flat(input.fundingAccount),
      ...instruments.map(instrument => input.books.l2Book(instrument.coin))]);
    const now = BigInt((input.clockMs ?? Date.now)());
    if (proof.environment !== 'TESTNET' || proof.account !== input.fundingAccount
      || proof.requestedAtMs > proof.observedAtMs || BigInt(proof.observedAtMs) > now
      || now - BigInt(proof.requestedAtMs) > 15_000n || proof.withdrawableQuoteAtoms !== proof.equityQuoteAtoms
      || proof.equityQuoteAtoms < 0n) throw new Error('Maker backing is not freshly flat and withdrawable.');
    const available = proof.withdrawableQuoteAtoms * 100n;
    const capacity = available < input.maximumCapacityAtoms ? available : input.maximumCapacityAtoms;
    const totalQuantity = input.quantity * BigInt(input.levels);
    const prices = values.map((value, j) => {
      const book = checkedHyperliquidTestnetBook(value, instruments[j]!.coin, 'maker book');
      if (BigInt(book.time) > now || now - BigInt(book.time) > BigInt(market.maxBookAgeMs)) throw new Error('Maker book is stale.');
      const price = (text: string, up: boolean) => {
        const d = hyperliquidTestnetDecimal(text, 'maker price');
        const n = d.atoms * 10n ** BigInt(market.quoteAsset.decimals);
        return up ? ceil(n, 10n ** BigInt(d.scale)) : n / 10n ** BigInt(d.scale);
      };
      const bid = price(book.levels[0][0]!.px, false);
      const ask = price(book.levels[1][0]!.px, true);
      if (bid <= 0n || ask <= bid || (ask - bid) * 10_000n > bid * BigInt(market.maxBookSpreadBps)) {
        throw new Error('Maker book is crossed or too wide.');
      }
      return { BID: sweep(false), ASK: sweep(true) };
      function sweep(buy: boolean): bigint {
        let remaining = totalQuantity;
        let worst = 0n;
        for (const level of book.levels[buy ? 1 : 0]) {
          const size = hyperliquidTestnetDecimal(level.sz, 'maker size');
          const atoms = size.atoms * baseScale / (10n ** BigInt(size.scale));
          remaining -= atoms < remaining ? atoms : remaining;
          worst = price(level.px, buy);
          if (remaining === 0n) return worst;
        }
        throw new Error('Venue depth cannot cover the published ladder.');
      }
    });
    const quotes: PackageMakerSnapshot['quotes'][number][] = [];
    const backingAtoms = ceil(input.quantity * input.backingAtomsPerWholeAsset, baseScale);
    for (let level = 0; level < input.levels; level++) {
      // Cash-and-carry's generalized compiler currently supports entry, not reverse entry.
      for (const side of cash ? ['ASK' as const] : ['BID' as const, 'ASK' as const]) {
        const legSources = instruments.map((_, j) => {
          const legSide = signs[j]! > 0n ? side : side === 'ASK' ? 'BID' as const : 'ASK' as const;
          return { sourceId: sourceIds[j]!, sourceVersion, side: legSide, quantity: input.quantity,
            priceTicks: makerPriceTicks(prices[j]![legSide], legSide, level) };
        });
        const capital = legSources.reduce((sum, leg, j) => sum + ceil(input.quantity * leg.priceTicks
          * BigInt(cash && j === 0 ? 10_000 : market.marginBps), baseScale * 10_000n), 0n);
        if (backingAtoms < capital) throw new Error('Maker reserve is below configured spot cost and perpetual margin.');
        quotes.push({ key: `${level}:${side}`, backingAtoms, quote: { executionClassId: input.marketId, side,
          legRatios: signs.map(numerator => ({ numerator, denominator: 1n })), legSources } });
      }
    }
    if (quotes.reduce((sum, quote) => sum + quote.backingAtoms, 0n) > capacity) throw new Error('Maker collateral cannot back this ladder.');
    return { bookNow: now, quotes, capacity: { version: 1, environment: 'testnet', solverId: market.solverId,
      domain: market.domain, asset: market.quoteAsset, availableAtoms: capacity, maximumConcurrentRecoveryAtoms: 0n,
      evidenceGrade: 'ONCHAIN_AVAILABLE', observedAtValue: now, expiresAtValue: now + 120_000n,
      evidenceCommitment: createHash('sha256').update(stringifyProtocolJson({ proof, values, market,
        backingAtomsPerWholeAsset: input.backingAtomsPerWholeAsset })).digest('hex') } };
  } };
}

export function loadHyperliquidPackageMaker(input: Readonly<{
  path: string | undefined; env: NodeJS.ProcessEnv; lanes: readonly GeneralizedStrategyQuoteLane[];
  origin: string; signer: MakerControlSigner;
}>) {
  if (!input.path) return undefined;
  if (!isAbsolute(input.path) || statSync(input.path).size > 65536) throw new Error('Hyperliquid maker configuration path is invalid.');
  const config = parseProtocolJson(readFileSync(input.path, 'utf8')) as {
    version: number; environment: string; journalPath: string; collateralTokenId: `0x${string}`; intervalMs: number;
    markets: (MakerFunding & { quoteConfigPath: string; keyId: string })[];
  };
  if (config.version !== 1 || config.environment !== 'testnet' || !isAbsolute(config.journalPath)
    || !Number.isSafeInteger(config.intervalMs) || config.intervalMs < 5000 || config.intervalMs > 15000
    || !Array.isArray(config.markets) || config.markets.length < 1 || config.markets.length > 5) {
    throw new Error('Hyperliquid maker must select bounded testnet markets.');
  }
  const liveBooks = new HyperliquidSdkTestnetMarketReadClient();
  const liveFunding = hyperliquidTestnetPoolFundingReads(config.collateralTokenId);
  let fundingSnapshot: ReturnType<HyperliquidPoolFundingReadPort['flat']> | undefined;
  let fundingRequestedAt = 0;
  const bookSnapshots = new Map<string, { requestedAt: number; value: ReturnType<HyperliquidTestnetQuoteMarketReadPort['l2Book']> }>();
  const books: HyperliquidTestnetQuoteMarketReadPort = {
    environment: liveBooks.environment, apiUrl: liveBooks.apiUrl, userFees: account => liveBooks.userFees(account),
    l2Book: coin => {
      const existing = bookSnapshots.get(coin);
      if (!existing || Date.now() - existing.requestedAt >= 5000) {
        bookSnapshots.set(coin, { requestedAt: Date.now(), value: liveBooks.l2Book(coin) });
      }
      return bookSnapshots.get(coin)!.value;
    },
  };
  const funding = { flat: (account: `0x${string}`) => {
    if (!fundingSnapshot || Date.now() - fundingRequestedAt >= 10_000) {
      fundingRequestedAt = Date.now();
      fundingSnapshot = liveFunding.flat(account);
    }
    return fundingSnapshot;
  } };
  const journal = new PackageMakerJournal(config.journalPath);
  try {
    const seen = new Set<string>();
    let scope: string | undefined;
    const makers = config.markets.map(row => {
      const parsed = quoteConfiguration({ ...input.env, NARYX_HYPERLIQUID_TESTNET_QUOTE_CONFIG: row.quoteConfigPath });
      const market = parsed.market as unknown as HyperliquidMakerMarket;
      const lane = input.lanes.find(l => l.laneId === parsed.generalized?.laneId);
      if (!lane || !parsed.generalized || lane.environment !== 'testnet'
        || lane.executionClassId !== parsed.generalized.executionClassId
        || !bytesEqual(manifestHash(lane.executionClassManifestHash), parsed.generalized.executionClassManifestHash)
        || seen.has(lane.executionClassId)) throw new Error('Hyperliquid maker lane is missing, repeated or mismatched.');
      seen.add(lane.executionClassId);
      const binding = stringifyProtocolJson({ account: row.fundingAccount, domain: market.domain,
        solverId: market.solverId, asset: market.quoteAsset, cap: row.maximumCapacityAtoms });
      if (scope !== undefined && scope !== binding) throw new Error('Hyperliquid maker markets must share one collateral scope.');
      scope = binding;
      const reader = createHyperliquidMakerReader({ ...row, marketId: lane.executionClassId, market, books, funding });
      return { marketId: lane.executionClassId, maker: new PackageMaker({ marketId: lane.executionClassId,
        solverId: market.solverId, sourceIds: reader.sourceIds, binding: { row, market, classHash: lane.executionClassManifestHash },
        quoteLifetime: 60_000n, journal, read: reader.read,
        gateway: new HttpPackageMakerGateway({ origin: input.origin, solverId: market.solverId, keyId: row.keyId, signer: input.signer }) }) };
    });
    let stopped = true;
    let running: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      fundingSnapshot = undefined;
      bookSnapshots.clear();
      for (const { marketId, maker } of makers) {
        if (stopped) return;
        try { process.stdout.write(JSON.stringify({ event: 'hyperliquid-package-maker', marketId, ...await maker.tick() }) + '\n'); }
        catch (error) { process.stderr.write(JSON.stringify({ event: 'hyperliquid-package-maker-refused', marketId,
          error: error instanceof Error ? error.message : 'unknown error' }) + '\n'); }
      }
    };
    const schedule = () => {
      const start = Date.now();
      running = tick().finally(() => { running = undefined;
        if (!stopped) timer = setTimeout(schedule, Math.max(1000, config.intervalMs - (Date.now() - start))); });
    };
    return { start: () => { if (stopped) { stopped = false; schedule(); } },
      close: async () => { stopped = true; clearTimeout(timer); await running; journal.close(); } };
  } catch (error) { journal.close(); throw error; }
}
