import { HttpTransport, InfoClient, TESTNET_API_URL } from '@nktkas/hyperliquid';
import { decimalToAtoms } from '@naryx/adapter-hyperliquid';
import { stringifyProtocolJson, type NettingPolicyManifest } from '@naryx/protocol-types';
import type { HyperliquidPoolExecutionReadPort } from './hyperliquid-pool-netting-execution.js';

export interface HyperliquidPoolMarketBinding {
  readonly instrumentId: string;
  readonly coin: string;
  readonly assetId: number;
  readonly sizeDecimals: number;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Pool market evidence: ${message}`);
}

export function hyperliquidTestnetPoolExecutionReads(account: `0x${string}`, policy: NettingPolicyManifest,
  bindings: readonly HyperliquidPoolMarketBinding[], collateralTokenId: string): HyperliquidPoolExecutionReadPort {
  return createHyperliquidPoolExecutionReads(account, policy, bindings, collateralTokenId,
    new InfoClient({ transport: new HttpTransport({ isTestnet: true, apiUrl: TESTNET_API_URL, timeout: 5_000 }) }));
}

export function createHyperliquidPoolExecutionReads(account: `0x${string}`, policy: NettingPolicyManifest,
  bindings: readonly HyperliquidPoolMarketBinding[], collateralTokenId: string,
  info: Pick<InfoClient, 'meta' | 'spotMeta' | 'l2Book' | 'userFunding'>, clock = Date.now,
): HyperliquidPoolExecutionReadPort {
  check(/^0x(?!0{40}$)[0-9a-f]{40}$/.test(account) && /^0x[0-9a-f]{32}$/.test(collateralTokenId)
    && policy.environment === 'testnet' && policy.instruments.every(row => row.domain.domainId === 'hypercore:testnet')
    && bindings.length === policy.instruments.length && bindings.length > 0 && bindings.length <= 8
    && new Set(bindings.map(row => row.instrumentId)).size === bindings.length
    && new Set(bindings.map(row => row.assetId)).size === bindings.length
    && bindings.every(row => /^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(row.coin)
      && Number.isInteger(row.assetId) && row.assetId >= 0 && row.assetId < 10_000
      && Number.isInteger(row.sizeDecimals) && row.sizeDecimals >= 0 && row.sizeDecimals <= 8
      && policy.instruments.some(instrument => instrument.instrumentId === row.instrumentId)), 'invalid default-DEX bindings');
  const original = stringifyProtocolJson(policy.instruments.map(({ legFamily: _family, instrumentHash: _hash, ...row }) => row));
  return {
    async closePrices(requested) {
      check(original === stringifyProtocolJson(requested.instruments.map(({ legFamily: _family, instrumentHash: _hash, ...row }) => row)),
        'requested instruments differ from the pool');
      const started = clock();
      const [meta, spot, books] = await Promise.all([info.meta({ dex: '' }), info.spotMeta(),
        Promise.all(bindings.map(row => info.l2Book({ coin: row.coin }))) ]);
      const collateral = spot.tokens.find(row => row.index === meta.collateralToken);
      check(meta.collateralToken === 0 && collateral?.tokenId.toLowerCase() === collateralTokenId
        && collateral.name === 'USDC' && collateral.isCanonical, 'perpetual collateral changed');
      const now = clock();
      check(now - started <= 5_000, 'market reads exceeded freshness bound');
      return { observedAtMs: started, prices: bindings.map((binding, i) => {
        const market = meta.universe[binding.assetId];
        const book = books[i];
        check(market?.name === binding.coin && market.szDecimals === binding.sizeDecimals && !market.isDelisted
          && book?.coin === binding.coin && Number.isSafeInteger(book.time) && book.time >= started - 5_000 && book.time <= now,
        'market identity or book freshness differs');
        const bid = book.levels[0][0];
        const ask = book.levels[1][0];
        check(bid !== undefined && ask !== undefined && decimalToAtoms(bid.sz, 8, 'bid size') > 0n
          && decimalToAtoms(ask.sz, 8, 'ask size') > 0n, 'both sides need observed liquidity');
        const instrument = requested.instruments.find(row => row.instrumentId === binding.instrumentId)!;
        const denominator = 10n ** BigInt(instrument.quantityAsset.decimals) * instrument.priceTickQuoteAtoms;
        const ticks = (price: string, ceil: boolean) => {
          const numerator = decimalToAtoms(price, 6, 'book price') * instrument.quantityIncrementAtoms;
          return numerator / denominator + (ceil && numerator % denominator !== 0n ? 1n : 0n);
        };
        const sellLimitPriceTicks = ticks(bid.px, false);
        const buyLimitPriceTicks = ticks(ask.px, true);
        check(sellLimitPriceTicks > 0n && buyLimitPriceTicks >= sellLimitPriceTicks, 'invalid price lattice');
        return { instrumentId: binding.instrumentId, buyLimitPriceTicks, sellLimitPriceTicks };
      }) };
    },
    async funding(plan, startTimeMs, endTimeMs) {
      check(Number.isSafeInteger(startTimeMs) && Number.isSafeInteger(endTimeMs) && startTimeMs > 0
        && endTimeMs >= startTimeMs && endTimeMs <= clock() && endTimeMs - startTimeMs <= 86_400_000,
      'funding window is outside the bounded epoch');
      const entries = await info.userFunding({ user: account, startTime: startTimeMs, endTime: endTimeMs });
      check(entries.length < 500, 'funding response may be truncated');
      return entries.map(entry => {
        const binding = bindings.find(row => row.coin === entry.delta.coin);
        const instrument = plan.entryPolicy.instruments.find(row => row.instrumentId === binding?.instrumentId);
        check(binding !== undefined && instrument !== undefined && entry.delta.type === 'funding'
          && Number.isSafeInteger(entry.time) && entry.time >= startTimeMs && entry.time <= endTimeMs
          && /^0x[0-9a-f]{64}$/i.test(entry.hash), 'funding cites an unsupported position');
        return { hash: entry.hash.toLowerCase() as `0x${string}`, instrumentId: instrument.instrumentId, timeMs: entry.time,
          netPositionAtoms: decimalToAtoms(entry.delta.szi, instrument.quantityAsset.decimals, 'funding position'),
          quoteDeltaAtoms: decimalToAtoms(entry.delta.usdc, 6, 'funding cash') };
      });
    },
  };
}
