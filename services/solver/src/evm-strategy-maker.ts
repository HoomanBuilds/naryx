import { createHash } from 'node:crypto';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import { getAddress, parseAbi } from 'viem';
import { readEvmOptionPoolSnapshot, readEvmOptionReferencePrice, type EvmOptionSpreadPricingInput } from './evm-option-spread-quote.js';
import { readEvmTreasuryHedgeMarketSnapshot, type EvmTreasuryHedgePricingInput } from './evm-treasury-hedge-quote.js';
import { readEvmCollateralConversionSpotSnapshot, type EvmCollateralConversionPricingInput } from './evm-collateral-conversion-quote.js';
import { reverseBasisCollateralPricing, reverseBasisPerpPricing, type EvmReverseBasisPricingInput } from './evm-reverse-basis-quote.js';
import { PACKAGE_MAKER_LEVELS, makerPriceTicks, readMakerLevels, type PackageMakerSnapshot } from './package-maker.js';

type Pricing = { kind: 'option'; pricing: EvmOptionSpreadPricingInput }
  | { kind: 'treasury'; pricing: EvmTreasuryHedgePricingInput }
  | { kind: 'conversion'; pricing: EvmCollateralConversionPricingInput }
  | { kind: 'reverse'; pricing: EvmReverseBasisPricingInput };
const TOKEN = parseAbi(['function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)']);
const MARKET = parseAbi(['function insuranceWad() view returns(uint256)', 'function opensPaused() view returns(bool)',
  'function maxPositionSizeWad() view returns(uint128)']);
const WAD = 10n ** 18n;
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;

export function createEvmStrategyMakerReader(input: Pricing & Readonly<{
  marketId: string; solverId: string; fundingAccount: string; quantities: readonly bigint[];
  backingAtomsPerWholeAsset: bigint; maximumCapacityAtoms: bigint; clockMs?: () => number;
}>) {
  const { pricing } = input;
  const base = 'inventoryAsset' in pricing ? pricing.inventoryAsset : 'collateralAsset' in pricing ? pricing.collateralAsset : pricing.baseAsset;
  const fundingAccount = getAddress(input.fundingAccount);
  const signs = input.kind === 'reverse' ? [-1n, -1n, 1n] : input.kind === 'conversion' ? [1n, 1n, -1n] : [1n, -1n];
  if (![84532n, 421614n].includes(pricing.chainId) || base.decimals !== 18 || pricing.quoteAsset.decimals !== 6
    || input.backingAtomsPerWholeAsset <= 0n || input.maximumCapacityAtoms <= 0n || input.quantities.length < 1
    || input.quantities.length > PACKAGE_MAKER_LEVELS || new Set(input.quantities).size !== input.quantities.length
    || input.quantities.some(q => q <= 0n || q > WAD || q % 1000n !== 0n)) throw new Error('Strategy maker quantities or funding are invalid.');
  const id = (i: number, j: number) => `${input.solverId}:${input.marketId}:${i}:${j}`;
  const sourceIds = signs.map((_, j) => id(0, j));
  const total = input.quantities.reduce((sum, q) => sum + q, 0n);
  return { sourceIds, read: async (sourceVersion: bigint): Promise<PackageMakerSnapshot> => {
    const cache = new Map<string, Promise<unknown>>();
    const codes = new Map<string, ReturnType<typeof pricing.chain.codeHash>>();
    const chain = { ...pricing.chain, codeHash: (address: Parameters<typeof pricing.chain.codeHash>[0]) => {
      if (!codes.has(address)) codes.set(address, pricing.chain.codeHash(address));
      return codes.get(address)!;
    }, readContract: (request: Parameters<typeof pricing.chain.readContract>[0]) => {
      const key = stringifyProtocolJson({ address: request.address, functionName: request.functionName, args: request.args ?? [] });
      if (!cache.has(key)) cache.set(key, pricing.chain.readContract(request));
      return cache.get(key)!;
    } };
    const now = BigInt((input.clockMs ?? Date.now)());
    const [chainId, observedAt, balance, decimals, code] = await Promise.all([
      chain.chainId(), chain.latestBlockTimestamp(),
      chain.readContract({ address: pricing.quoteToken.address, abi: TOKEN, functionName: 'balanceOf', args: [fundingAccount] }),
      chain.readContract({ address: pricing.quoteToken.address, abi: TOKEN, functionName: 'decimals' }),
      chain.codeHash(pricing.quoteToken.address),
    ]);
    if (chainId !== pricing.chainId || code?.toLowerCase() !== pricing.quoteToken.expectedCodeHash.toLowerCase()
      || Number(decimals) !== 6 || typeof balance !== 'bigint' || balance < 0n
      || observedAt > now / 1000n + 5n || now / 1000n - observedAt > 30n) throw new Error('Strategy maker collateral or clock is invalid.');
    const quotes: PackageMakerSnapshot['quotes'][number][] = [];
    const observations: unknown[] = [];
    let gross = 0n;
    let insurance: bigint | undefined;
    const conversion = input.kind === 'conversion' ? { ...input.pricing, chain }
      : input.kind === 'reverse' ? reverseBasisCollateralPricing({ ...input.pricing, chain }) : undefined;
    const perp = input.kind === 'treasury' ? { ...input.pricing, chain }
      : input.kind === 'reverse' ? reverseBasisPerpPricing({ ...input.pricing, chain })
        : conversion === undefined ? undefined : { ...conversion, inventoryAsset: conversion.collateralAsset,
          inventoryToken: conversion.collateralToken, market: conversion.perpetualMarket, inventory: conversion.swap };
    if (perp) {
      const read = (functionName: string) => chain.readContract({ address: perp.market.address, abi: MARKET, functionName });
      const [reserve, paused, maximum] = await Promise.all([read('insuranceWad'), read('opensPaused'), read('maxPositionSizeWad')]);
      // Sibling strategies share this venue. Reserve ten ladders' gross exposure, not one ladder twice.
      if (typeof reserve !== 'bigint' || reserve <= 0n || paused !== false || typeof maximum !== 'bigint'
        || total * 10n > maximum) throw new Error('Strategy maker venue risk capacity is unavailable.');
      insurance = reserve;
    }
    const previews = perp === undefined ? [] : await readMakerLevels(input.quantities, async quantity => {
      const sized = total * 10n + quantity;
      const [buy, sell, spotBuy, spotSell] = await Promise.all([
        readEvmTreasuryHedgeMarketSnapshot(perp, sized), readEvmTreasuryHedgeMarketSnapshot(perp, -sized),
        conversion === undefined ? undefined : readEvmCollateralConversionSpotSnapshot(conversion, sized, true),
        conversion === undefined ? undefined : readEvmCollateralConversionSpotSnapshot(conversion, sized, false),
      ]);
      return { buy, sell, spotBuy, spotSell };
    });
    for (const [i, quantity] of input.quantities.entries()) {
      const previousGross = gross;
      const prices: Record<'BID' | 'ASK', bigint[]> = { BID: [], ASK: [] };
      if (input.kind === 'option') {
        const option = { ...input.pricing, chain };
        const [reference, ...pools] = await Promise.all([readEvmOptionReferencePrice(option, observedAt),
          ...['option-long', 'option-short'].map(role => readEvmOptionPoolSnapshot(option, option.pools.find(p => p.role === role)!))]);
        for (const [j, pool] of pools.entries()) {
          if (pool.maturity <= observedAt + 60n) throw new Error('Option maker maturity is unavailable.');
          const available = await chain.readContract({ address: option.baseToken.address, abi: TOKEN, functionName: 'balanceOf', args: [pool.pool] });
          if (typeof available !== 'bigint' || available < total * 10n) throw new Error('Option maker payout inventory is insufficient.');
          const premiumBase = ceil(quantity * pool.premiumBps, 10_000n);
          const n = premiumBase * reference.answer * 1_000_000n;
          const d = WAD * 10n ** BigInt(reference.decimals);
          const buy = ceil(ceil(n, d) * WAD, quantity);
          const sell = (n / d) * WAD / quantity;
          prices.ASK[j] = j === 0 ? buy : sell;
          prices.BID[j] = j === 0 ? sell : buy;
        }
        gross += ceil(quantity * reference.answer * 2n, 10n ** BigInt(reference.decimals));
        observations.push({ quantity, reference, pools });
      } else {
        const pricingQuantity = total * 10n + quantity;
        const { buy, sell } = previews[i]!;
        if (buy.expiry <= observedAt + 60n) throw new Error('Strategy maker derivative expired.');
        const buyPrice = ceil(buy.fillPriceWad, 10n ** 12n);
        const sellPrice = sell.fillPriceWad / (10n ** 12n);
        if (input.kind === 'treasury') {
          prices.ASK = [ceil(buy.oraclePriceWad, 10n ** 12n), sellPrice];
          prices.BID = [sell.oraclePriceWad / (10n ** 12n), buyPrice];
        } else {
          const spotBuy = previews[i]!.spotBuy!;
          const spotSell = previews[i]!.spotSell!;
          const spotAsk = ceil(spotBuy.quoteAtoms * WAD, pricingQuantity);
          const spotBid = spotSell.quoteAtoms * WAD / pricingQuantity;
          prices.ASK = input.kind === 'conversion' ? [spotAsk, 0n, sellPrice] : [0n, spotBid, buyPrice];
          prices.BID = input.kind === 'conversion' ? [spotBid, 0n, buyPrice] : [0n, spotAsk, sellPrice];
          if (input.kind === 'reverse') {
            const reserve = await chain.readContract({ address: input.pricing.baseToken.address, abi: TOKEN,
              functionName: 'balanceOf', args: [input.pricing.lendingPool.address] });
            if (typeof reserve !== 'bigint' || reserve < total * 10n) throw new Error('Reverse basis lending inventory is insufficient.');
          }
          observations.push({ quantity, pricingQuantity, spotBuy, spotSell });
        }
        gross += ceil(quantity * buy.fillPriceWad * 2n, WAD);
        observations.push({ quantity, buy, sell });
      }
      const backingAtoms = ceil(quantity * input.backingAtomsPerWholeAsset, WAD);
      const largest = [...prices.BID, ...prices.ASK].reduce((a, b) => a > b ? a : b, 0n);
      if (backingAtoms < ceil(quantity * largest * 2n, WAD) || backingAtoms < ceil(gross - previousGross, 10n ** 12n)) {
        throw new Error('Strategy maker backing is below gross exposure.');
      }
      for (const side of ['BID', 'ASK'] as const) quotes.push({ key: `${i}:${side}`, backingAtoms, quote: {
        executionClassId: input.marketId, side, legRatios: signs.map(numerator => ({ numerator, denominator: 1n })),
        legSources: signs.map((sign, j) => ({ sourceId: id(0, j), sourceVersion, quantity,
          side: sign > 0n ? side : side === 'ASK' ? 'BID' : 'ASK',
          priceTicks: makerPriceTicks(prices[side][j]!, sign > 0n ? side : side === 'ASK' ? 'BID' : 'ASK', i) })),
      } });
    }
    if (insurance !== undefined && insurance < gross * 10n) throw new Error('Strategy maker payout reserve is below shared gross exposure.');
    const availableAtoms = balance < input.maximumCapacityAtoms ? balance : input.maximumCapacityAtoms;
    if (quotes.reduce((sum, q) => sum + q.backingAtoms, 0n) > availableAtoms) throw new Error('Strategy maker capacity is insufficient.');
    return { bookNow: observedAt, quotes, capacity: { version: 1, environment: 'testnet', solverId: input.solverId,
      domain: pricing.domain, asset: pricing.quoteAsset, availableAtoms, maximumConcurrentRecoveryAtoms: 0n,
      evidenceGrade: 'ONCHAIN_AVAILABLE', observedAtValue: now, expiresAtValue: now + 120_000n,
      evidenceCommitment: createHash('sha256').update(stringifyProtocolJson({ chainId, observedAt, fundingAccount,
        token: pricing.quoteToken, balance, observations })).digest('hex') } };
  } };
}
