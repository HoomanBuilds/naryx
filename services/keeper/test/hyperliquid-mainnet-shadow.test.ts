import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  MetaAndAssetCtxsResponse,
  SpotMetaAndAssetCtxsResponse,
  UserFeesResponse,
} from '@nktkas/hyperliquid/api/info';
import {
  HYPERLIQUID_MAINNET_INFO_URL,
  HyperliquidMainnetShadowReader,
  type HyperliquidMainnetShadowConfig,
  type HyperliquidMainnetShadowReadPort,
  type HyperliquidMainnetShadowSnapshot,
} from '../src/index.js';

const spotTokenId = `0x${'11'.repeat(16)}` as const;
const quoteTokenId = `0x${'22'.repeat(16)}` as const;

const feeSchedule = {
  cross: '0.001',
  add: '0.0001',
  spotCross: '0.001',
  spotAdd: '0.0001',
  tiers: { vip: [], mm: [] },
  referralDiscount: '0',
  stakingDiscountTiers: [],
} as UserFeesResponse['feeSchedule'];

function spotResponse(): SpotMetaAndAssetCtxsResponse {
  return [
    {
      universe: [{ tokens: [5, 0], name: '@2', index: 2, isCanonical: true }],
      tokens: [
        {
          name: 'USDC', szDecimals: 8, weiDecimals: 2, index: 0,
          tokenId: quoteTokenId, isCanonical: true, evmContract: null,
          fullName: 'USD Coin', deployerTradingFeeShare: '0',
        },
        {
          name: 'SOL', szDecimals: 3, weiDecimals: 3, index: 5,
          tokenId: spotTokenId, isCanonical: true, evmContract: null,
          fullName: 'Solana', deployerTradingFeeShare: '0',
        },
      ],
    },
    [
      {
        prevDayPx: '99', dayNtlVlm: '100000', markPx: '100', midPx: '100',
        circulatingSupply: '1000', coin: '@0', totalSupply: '1000', dayBaseVlm: '1000',
      },
      {
        prevDayPx: '99', dayNtlVlm: '100000', markPx: '100', midPx: '100',
        circulatingSupply: '1000', coin: '@1', totalSupply: '1000', dayBaseVlm: '1000',
      },
      {
        prevDayPx: '99', dayNtlVlm: '100000', markPx: '100', midPx: '100',
        circulatingSupply: '1000', coin: '@2', totalSupply: '1000', dayBaseVlm: '1000',
      },
    ],
  ];
}

function perpetualResponse(): MetaAndAssetCtxsResponse {
  return [
    {
      universe: [
        { name: 'BTC', szDecimals: 3, maxLeverage: 20, marginTableId: 1 },
        { name: 'SOL', szDecimals: 3, maxLeverage: 20, marginTableId: 1 },
      ],
      marginTables: [],
      collateralToken: 0,
    },
    [
      {
        prevDayPx: '100', dayNtlVlm: '100000', markPx: '101', midPx: '101',
        funding: '0.00001', openInterest: '1000', premium: '0', oraclePx: '101',
        impactPxs: ['100.9', '101.1'], dayBaseVlm: '1000',
      },
      {
        prevDayPx: '100', dayNtlVlm: '100000', markPx: '101', midPx: '101',
        funding: '0.00001', openInterest: '1000', premium: '0', oraclePx: '101',
        impactPxs: ['100.9', '101.1'], dayBaseVlm: '1000',
      },
    ],
  ];
}

function snapshot(overrides: Partial<HyperliquidMainnetShadowSnapshot> = {}):
HyperliquidMainnetShadowSnapshot {
  return {
    environment: 'mainnet',
    apiUrl: HYPERLIQUID_MAINNET_INFO_URL,
    requestedAtMs: 999_800,
    receivedAtMs: 1_000_000,
    spot: spotResponse(),
    perpetual: perpetualResponse(),
    spotBook: {
      coin: '@2', time: 999_900,
      levels: [
        [{ px: '99.9', sz: '5', n: 2 }],
        [{ px: '100', sz: '1', n: 2 }, { px: '100.1', sz: '2', n: 3 }],
      ],
    },
    perpetualBook: {
      coin: 'SOL', time: 999_950,
      levels: [
        [{ px: '101', sz: '1', n: 3 }, { px: '100.9', sz: '2', n: 2 }],
        [{ px: '101.1', sz: '5', n: 3 }],
      ],
    },
    feeSchedule,
    ...overrides,
  };
}

function port(value: HyperliquidMainnetShadowSnapshot): HyperliquidMainnetShadowReadPort {
  return {
    environment: 'mainnet',
    apiUrl: HYPERLIQUID_MAINNET_INFO_URL,
    async read(spotCoin, perpetualCoin) {
      assert.equal(spotCoin, '@2');
      assert.equal(perpetualCoin, 'SOL');
      return value;
    },
  };
}

function config(overrides: Partial<HyperliquidMainnetShadowConfig> = {}):
HyperliquidMainnetShadowConfig {
  return {
    spotUniverseIndex: 2,
    spotUniverseName: '@2',
    spotUniverseCanonical: true,
    spotTokenIndex: 5,
    spotTokenName: 'SOL',
    spotTokenId,
    spotTokenCanonical: true,
    quoteTokenIndex: 0,
    quoteTokenName: 'USDC',
    quoteTokenId,
    quoteTokenCanonical: true,
    perpetualAssetIndex: 1,
    perpetualName: 'SOL',
    spotSizeDecimals: 3,
    perpetualSizeDecimals: 3,
    quoteDecimals: 2,
    baseQuantity: '2',
    minimumOpenInterest: '100',
    maxEntryCostQuoteAtoms: 0n,
    maxBookAgeMs: 1_000,
    maxSnapshotSkewMs: 200,
    maxMarkOracleDivergenceBps: 50,
    ...overrides,
  };
}

function shadow(
  value: HyperliquidMainnetShadowSnapshot,
  overrides: Partial<HyperliquidMainnetShadowConfig> = {},
) {
  return new HyperliquidMainnetShadowReader(port(value), config(overrides), () => 1_000_000);
}

test('returns committed exact mainnet package economics', async () => {
  const evidence = await shadow(snapshot()).observe();

  assert.equal(evidence.environment, 'mainnet');
  assert.equal(evidence.market.spotTokenId, spotTokenId);
  assert.equal(evidence.marketState.perpetualFundingRate, '0.00001');
  assert.equal(evidence.economics.baseQuantityAtoms, 2_000n);
  assert.equal(evidence.economics.spotCostQuoteAtoms, 20_010n);
  assert.equal(evidence.economics.perpetualProceedsQuoteAtoms, 20_190n);
  assert.equal(evidence.economics.spotFeeQuoteAtoms, 21n);
  assert.equal(evidence.economics.perpetualFeeQuoteAtoms, 21n);
  assert.equal(evidence.economics.entryCostQuoteAtoms, -138n);
  assert.match(evidence.sourceCommitmentSha256, /^0x[0-9a-f]{64}$/);
});

test('rejects stale mainnet book evidence', async () => {
  const value = snapshot();
  await assert.rejects(shadow(snapshot({
    spotBook: { ...value.spotBook!, time: 998_000 },
  })).observe(), /spot book is stale or future-dated/);
});

test('rejects exact token identity mismatch', async () => {
  const [meta, contexts] = spotResponse();
  const changed = {
    ...meta,
    tokens: meta.tokens.map((token) => token.index === 5
      ? { ...token, tokenId: `0x${'33'.repeat(16)}` as const }
      : token),
  };
  await assert.rejects(shadow(snapshot({ spot: [changed, contexts] })).observe(),
    /spot token identity mismatch/);
});

test('rejects a one-sided book', async () => {
  const value = snapshot();
  await assert.rejects(shadow(snapshot({
    perpetualBook: { ...value.perpetualBook!, levels: [value.perpetualBook!.levels[0], []] },
  })).observe(), /perpetual book must be two-sided/);
});

test('rejects unfavorable executable economics after conservative fees', async () => {
  const value = snapshot();
  await assert.rejects(shadow(snapshot({
    perpetualBook: {
      ...value.perpetualBook!,
      levels: [
        [{ px: '99.9', sz: '5', n: 2 }],
        value.perpetualBook!.levels[1],
      ],
    },
  })).observe(), /executable package economics exceed/);
});
