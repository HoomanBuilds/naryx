import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import { getAddress, parseAbi } from 'viem';
import type { loadEvmCalendarSpreadRuntime } from './evm-calendar-spread-config.js';
import { readEvmCalendarFutureSnapshot, type EvmCalendarSpreadPricingInput } from './evm-calendar-spread-quote.js';
import { HttpPackageMakerGateway, PackageMaker, PackageMakerJournal, type PackageMakerSnapshot } from './package-maker.js';
import type { MakerControlSigner } from './maker-control.js';

const TOKEN = parseAbi(['function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)']);
const MARKET = parseAbi(['function insuranceWad() view returns(uint256)', 'function opensPaused() view returns(bool)',
  'function maxPositionSizeWad() view returns(uint128)']);
const WAD = 10n ** 18n;
const TTL = 60n;
const positive = (value: unknown): value is bigint => typeof value === 'bigint' && value > 0n && value < (1n << 128n);
const ceil = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;

export function createCalendarMakerReader(input: Readonly<{
  pricing: EvmCalendarSpreadPricingInput;
  marketId: string;
  solverId: string;
  fundingAccount: string;
  quantities: readonly bigint[];
  backingAtomsPerWholeAsset: bigint;
  maximumCapacityAtoms: bigint;
  clockMs?: () => number;
}>) {
  const { pricing } = input;
  const fundingAccount = getAddress(input.fundingAccount);
  const near = pricing.markets.find(market => market.role === 'near-future')!;
  const far = pricing.markets.find(market => market.role === 'far-future')!;
  if (![84532n, 421614n].includes(pricing.chainId) || pricing.baseAsset.decimals !== 18
    || pricing.quoteAsset.decimals !== 6 || !near || !far || !positive(input.backingAtomsPerWholeAsset)
    || !positive(input.maximumCapacityAtoms) || input.quantities.length < 1 || input.quantities.length > 4
    || input.quantities.some(q => !positive(q) || q > WAD || q % 1000n !== 0n)
    || new Set(input.quantities).size !== input.quantities.length) throw new Error('Calendar maker funding or quantities are invalid.');
  const sourceId = (index: number, leg: number) => `${input.solverId}:${input.marketId}:${index}:${leg}`;
  const sourceIds = input.quantities.flatMap((_, i) => [sourceId(i, 0), sourceId(i, 1)]);
  const read = async (sourceVersion: bigint): Promise<PackageMakerSnapshot> => {
    const reads = new Map<string, Promise<unknown>>();
    const snapshotPricing = { ...pricing, chain: { ...pricing.chain, readContract: (request: Parameters<typeof pricing.chain.readContract>[0]) => {
      const key = stringifyProtocolJson({ address: request.address, functionName: request.functionName, args: request.args ?? [] });
      if (!reads.has(key)) reads.set(key, pricing.chain.readContract(request));
      return reads.get(key)!;
    } } };
    const nowMs = BigInt((input.clockMs ?? Date.now)());
    const [chainId, observedAt, balance, decimals, codeHash] = await Promise.all([
      pricing.chain.chainId(), pricing.chain.latestBlockTimestamp(),
      pricing.chain.readContract({ address: pricing.quoteToken.address, abi: TOKEN, functionName: 'balanceOf', args: [fundingAccount] }),
      pricing.chain.readContract({ address: pricing.quoteToken.address, abi: TOKEN, functionName: 'decimals' }),
      pricing.chain.codeHash(pricing.quoteToken.address),
    ]);
    if (chainId !== pricing.chainId || codeHash?.toLowerCase() !== pricing.quoteToken.expectedCodeHash.toLowerCase()
      || Number(decimals) !== pricing.quoteAsset.decimals || typeof balance !== 'bigint' || balance < 0n
      || observedAt > nowMs / 1000n + 5n || nowMs / 1000n - observedAt > 30n) {
      throw new Error('Calendar maker collateral identity, balance, or chain clock is invalid.');
    }
    const quotes: PackageMakerSnapshot['quotes'][number][] = [];
    const observations: unknown[] = [];
    const marketCapacity = await Promise.all([near, far].map(async market => {
      const read = (functionName: string) => pricing.chain.readContract({ address: market.contract.address, abi: MARKET, functionName });
      const [insurance, paused, maximum] = await Promise.all([read('insuranceWad'), read('opensPaused'), read('maxPositionSizeWad')]);
      if (typeof insurance !== 'bigint' || insurance <= 0n || paused !== false || typeof maximum !== 'bigint'
        || input.quantities.some(quantity => quantity > maximum)) throw new Error('Calendar venue is paused or has insufficient risk capacity.');
      return insurance;
    }));
    let grossNotional = 0n;
    for (const [index, quantity] of input.quantities.entries()) {
      const [nearBuy, nearSell, farBuy, farSell] = await Promise.all([
        readEvmCalendarFutureSnapshot(snapshotPricing, near, quantity), readEvmCalendarFutureSnapshot(snapshotPricing, near, -quantity),
        readEvmCalendarFutureSnapshot(snapshotPricing, far, quantity), readEvmCalendarFutureSnapshot(snapshotPricing, far, -quantity),
      ]);
      if (nearBuy.expiry <= observedAt + TTL || nearBuy.expiry >= farBuy.expiry) throw new Error('Calendar maker maturity is unavailable.');
      const worstNotional = [nearBuy.notionalWad, nearSell.notionalWad, farBuy.notionalWad, farSell.notionalWad]
        .reduce((maximum, value) => value > maximum ? value : maximum, 0n);
      const backingAtoms = ceil(quantity * input.backingAtomsPerWholeAsset, WAD);
      grossNotional += worstNotional * 2n;
      if (backingAtoms < ceil(worstNotional * 2n, nearBuy.collateralScale)) {
        throw new Error('Calendar maker backing policy is below two-leg gross exposure.');
      }
      for (const side of ['BID', 'ASK'] as const) {
        const selected = side === 'ASK' ? [nearBuy, farSell] : [nearSell, farBuy];
        quotes.push({ key: `${index}:${side}`, backingAtoms, quote: {
          executionClassId: input.marketId, side,
          legRatios: [{ numerator: 1n, denominator: 1n }, { numerator: -1n, denominator: 1n }],
          legSources: selected.map((snapshot, legIndex) => {
            const legSide = legIndex === 0 ? side : side === 'BID' ? 'ASK' as const : 'BID' as const;
            const scaled = snapshot.fillPriceWad * 10n ** BigInt(pricing.quoteAsset.decimals);
            return { sourceId: sourceId(index, legIndex), sourceVersion, side: legSide,
              priceTicks: legSide === 'ASK' ? ceil(scaled, WAD) : scaled / WAD, quantity };
          }),
        } });
      }
      observations.push({ quantity, nearBuy, nearSell, farBuy, farSell });
    }
    if (marketCapacity.some(insurance => insurance < grossNotional)) throw new Error('Calendar venue payout reserve is below published gross exposure.');
    const availableAtoms = balance < input.maximumCapacityAtoms ? balance : input.maximumCapacityAtoms;
    if (quotes.reduce((sum, item) => sum + item.backingAtoms, 0n) > availableAtoms) {
      throw new Error('Calendar maker account cannot back both sides of all configured sizes.');
    }
    return { bookNow: observedAt, quotes, capacity: {
      version: 1, environment: 'testnet', solverId: input.solverId, domain: pricing.domain, asset: pricing.quoteAsset,
      availableAtoms, maximumConcurrentRecoveryAtoms: 0n, evidenceGrade: 'ONCHAIN_AVAILABLE',
      evidenceCommitment: createHash('sha256').update(stringifyProtocolJson({ chainId, observedAt, fundingAccount,
        quoteToken: pricing.quoteToken, balance, availableAtoms, observations })).digest('hex'),
      observedAtValue: nowMs, expiresAtValue: nowMs + 120_000n,
    } };
  };
  return { sourceIds, read };
}

export function loadEvmPackageMaker(input: Readonly<{
  path: string | undefined;
  runtime: ReturnType<typeof loadEvmCalendarSpreadRuntime> | undefined;
  origin: string;
  signer: MakerControlSigner;
}>) {
  if (!input.path) return undefined;
  if (!isAbsolute(input.path) || statSync(input.path).size > 65536) throw new Error('Package maker configuration path is invalid.');
  const config = parseProtocolJson(readFileSync(input.path, 'utf8')) as {
    version: number; environment: string; journalPath: string; intervalMs: number;
    markets: { laneId: string; keyId: string; fundingAccount: string; quantities: bigint[];
      backingAtomsPerWholeAsset: bigint; maximumCapacityAtoms: bigint }[];
  };
  if (config.version !== 1 || config.environment !== 'testnet' || !isAbsolute(config.journalPath)
    || !Number.isSafeInteger(config.intervalMs) || config.intervalMs < 10000 || config.intervalMs > 30000
    || !Array.isArray(config.markets) || config.markets.length < 1 || config.markets.length > 8
    || new Set(config.markets.map(m => m.laneId)).size !== config.markets.length || input.runtime === undefined) {
    throw new Error('Package maker configuration must select supported testnet calendar lanes.');
  }
  const journal = new PackageMakerJournal(config.journalPath);
  try {
    const makers = config.markets.map(market => {
      const index = input.runtime!.quoteLanes.findIndex(lane => lane.laneId === market.laneId);
      const lane = input.runtime!.quoteLanes[index];
      const pricing = input.runtime!.preparationLanes[index]?.pricing;
      if (!lane || !pricing) throw new Error('Package maker lane is not registered.');
      const source = createCalendarMakerReader({ ...market, pricing, marketId: lane.executionClassId, solverId: lane.solverId });
      const gateway = new HttpPackageMakerGateway({ origin: input.origin, solverId: lane.solverId,
        keyId: market.keyId, signer: input.signer });
      const maker = new PackageMaker({ marketId: lane.executionClassId, solverId: lane.solverId, sourceIds: source.sourceIds,
        binding: { ...market, domain: pricing.domain, token: pricing.quoteToken, executionClassManifestHash: lane.executionClassManifestHash },
        quoteLifetime: TTL, journal, gateway, read: source.read });
      return { maker, marketId: lane.executionClassId };
    });
    let stopped = true;
    let running: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      for (const { maker, marketId } of makers) {
        if (stopped) return;
        try {
          const result = await maker.tick();
          process.stdout.write(JSON.stringify({ event: 'package-maker', marketId, ...result }) + '\n');
        } catch (error) {
          process.stderr.write(JSON.stringify({ event: 'package-maker-refused', marketId,
            error: error instanceof Error ? error.message : 'unknown error' }) + '\n');
        }
      }
    };
    const schedule = () => {
      running = tick().finally(() => {
        running = undefined;
        if (!stopped) timer = setTimeout(schedule, config.intervalMs);
      });
    };
    return {
      start: () => { if (stopped) { stopped = false; schedule(); } },
      close: async () => { stopped = true; if (timer !== undefined) clearTimeout(timer); await running; journal.close(); },
    };
  } catch (error) { journal.close(); throw error; }
}
