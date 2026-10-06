import assert from 'node:assert/strict';
import test from 'node:test';
import type { HyperliquidExecutionPlan } from '@naryx/adapter-hyperliquid';
import {
  HYPERLIQUID_TESTNET_MARKET_INFO_URL,
  HyperliquidTestnetMarketPreflight,
  qualifyHyperliquidPerpetualStrategyMarkets,
  type HyperliquidTestnetMarketQualificationConfig,
  type HyperliquidTestnetMarketReadPort,
  type HyperliquidTestnetMarketSnapshot,
} from '../src/index.js';

const binding = {
  spotUniverseIndex: 7,
  spotTokenIndex: 69,
  perpetualAssetIndex: 3,
  quoteTokenIndex: 0,
} as const;

function plan(): HyperliquidExecutionPlan {
  return {
    legs: [
      { legId: 'spot', role: 'SPOT', order: { a: 10_007, b: true, p: '60100', s: '0.002', r: false } },
      { legId: 'perp', role: 'PERPETUAL', order: { a: 3, b: false, p: '58000', s: '0.002', r: false } },
    ],
  } as unknown as HyperliquidExecutionPlan;
}

function snapshot(overrides: Partial<HyperliquidTestnetMarketSnapshot> = {}):
HyperliquidTestnetMarketSnapshot {
  const base = {
    environment: 'testnet' as const,
    apiUrl: HYPERLIQUID_TESTNET_MARKET_INFO_URL,
    requestedAtMs: 999_800,
    receivedAtMs: 1_000_000,
    spotMeta: {
      universe: [{ tokens: [69, 0], name: '@7', index: 7, isCanonical: true }],
      tokens: [
        {
          name: 'USDC', szDecimals: 8, weiDecimals: 8, index: 0,
          tokenId: `0x${'00'.repeat(16)}`, isCanonical: true, evmContract: null,
          fullName: 'USD Coin', deployerTradingFeeShare: '0',
        },
        {
          name: 'BTC', szDecimals: 5, weiDecimals: 5, index: 69,
          tokenId: `0x${'11'.repeat(16)}`, isCanonical: true, evmContract: null,
          fullName: 'Bitcoin', deployerTradingFeeShare: '0',
        },
      ],
    },
    perpetualMeta: {
      universe: [
        { name: 'A', szDecimals: 2, maxLeverage: 1, marginTableId: 1 },
        { name: 'B', szDecimals: 2, maxLeverage: 1, marginTableId: 1 },
        { name: 'C', szDecimals: 2, maxLeverage: 1, marginTableId: 1 },
        { name: 'BTC', szDecimals: 5, maxLeverage: 40, marginTableId: 1 },
      ],
      marginTables: [], collateralToken: 0,
    },
    spotBook: {
      coin: '@7', time: 999_900,
      levels: [
        [{ px: '59990', sz: '0.01', n: 2 }],
        [{ px: '60010', sz: '0.01', n: 2 }],
      ],
    },
    perpetualBook: {
      coin: 'BTC', time: 999_950,
      levels: [
        [{ px: '59980', sz: '0.01', n: 3 }],
        [{ px: '60020', sz: '0.01', n: 3 }],
      ],
    },
  } satisfies HyperliquidTestnetMarketSnapshot;
  return { ...base, ...overrides };
}

function reader(value: HyperliquidTestnetMarketSnapshot): HyperliquidTestnetMarketReadPort {
  return {
    environment: 'testnet',
    apiUrl: HYPERLIQUID_TESTNET_MARKET_INFO_URL,
    async read(spotCoin, perpetualCoin) {
      assert.equal(spotCoin, '@7');
      assert.equal(perpetualCoin, 'BTC');
      return value;
    },
  };
}

function preflight(
  value: HyperliquidTestnetMarketSnapshot,
  overrides: Partial<HyperliquidTestnetMarketQualificationConfig> = {},
) {
  return new HyperliquidTestnetMarketPreflight(reader(value), {
    spotUniverseName: '@7', spotTokenName: 'BTC', quoteTokenName: 'USDC',
    perpetualName: 'BTC', spotSizeDecimals: 5, perpetualSizeDecimals: 5,
    spotUniverseCanonical: true, spotTokenCanonical: true, quoteTokenCanonical: true,
    spotTokenId: `0x${'11'.repeat(16)}`, quoteTokenId: `0x${'00'.repeat(16)}`,
    maxBookAgeMs: 1_000, maxSnapshotSkewMs: 500,
    maxReferenceDivergenceBps: 50,
    minimumSpotDepth: '0.001', minimumPerpetualDepth: '0.001',
    ...overrides,
  }, () => 1_000_000);
}

test('accepts exact Testnet market identities with executable two-sided depth', async () => {
  await preflight(snapshot()).qualify({ plan: plan(), binding });
});

test('accepts an exactly configured noncanonical builder spot market', async () => {
  const value = snapshot();
  await preflight(snapshot({
    spotMeta: {
      ...value.spotMeta,
      universe: value.spotMeta.universe.map((market) => ({ ...market, isCanonical: false })),
      tokens: value.spotMeta.tokens.map((token) => ({ ...token, isCanonical: false })),
    },
  }), {
    spotUniverseCanonical: false,
    spotTokenCanonical: false,
    quoteTokenCanonical: false,
  }).qualify({ plan: plan(), binding });
});

test('rejects a one-sided order book', async () => {
  const value = snapshot();
  await assert.rejects(preflight(snapshot({
    spotBook: { ...value.spotBook!, levels: [value.spotBook!.levels[0], []] },
  })).qualify({ plan: plan(), binding }), /must have both bids and asks/);
});

test('rejects market identity mismatch', async () => {
  const value = snapshot();
  await assert.rejects(preflight(snapshot({
    spotMeta: {
      ...value.spotMeta,
      tokens: value.spotMeta.tokens.map((token) => token.index === 69
        ? { ...token, tokenId: `0x${'22'.repeat(16)}` }
        : token),
    },
  })).qualify({ plan: plan(), binding }), /spot token identity mismatch/);
});

test('rejects excessive spot-perpetual reference divergence', async () => {
  const value = snapshot();
  await assert.rejects(preflight(snapshot({
    perpetualBook: {
      ...value.perpetualBook!,
      levels: [
        [{ px: '58980', sz: '0.01', n: 3 }],
        [{ px: '59020', sz: '0.01', n: 3 }],
      ],
    },
  })).qualify({ plan: plan(), binding }), /reference divergence exceeds/);
});

test('qualifies main and HIP-3 perpetual markets from their canonical asset IDs', async () => {
  const books = new Map<string, NonNullable<HyperliquidTestnetMarketSnapshot['perpetualBook']>>([
    ['BTC', {
      coin: 'BTC', time: 999_900,
      levels: [
        [{ px: '59990', sz: '0.01', n: 2 }],
        [{ px: '60010', sz: '0.01', n: 2 }],
      ],
    }],
    ['xyz:BTC', {
      coin: 'xyz:BTC', time: 999_950,
      levels: [
        [{ px: '59980', sz: '0.01', n: 2 }],
        [{ px: '60020', sz: '0.01', n: 2 }],
      ],
    }],
  ]);
  const marketReader: HyperliquidTestnetMarketReadPort = {
    environment: 'testnet',
    apiUrl: HYPERLIQUID_TESTNET_MARKET_INFO_URL,
    read: async () => snapshot(),
    perpetualDexs: async () => [null, {
      name: 'xyz', fullName: 'XYZ Markets', deployer: `0x${'33'.repeat(20)}`,
      oracleUpdater: null, feeRecipient: null, assetToStreamingOiCap: [], subDeployers: [],
      deployerFeeScale: '1', lastDeployerFeeScaleChangeTime: '2026-10-06T00:00:00',
      assetToFundingMultiplier: [], assetToFundingInterestRate: [],
    }],
    perpetualMeta: async (dex) => dex === 'xyz'
      ? {
          universe: [{ name: 'xyz:BTC', szDecimals: 5, maxLeverage: 20, marginTableId: 1 }],
          marginTables: [], collateralToken: 0,
        }
      : {
          universe: ['A', 'B', 'C', 'BTC'].map((name) => ({
            name, szDecimals: 5, maxLeverage: 40, marginTableId: 1,
          })),
          marginTables: [], collateralToken: 0,
        },
    l2Book: async (coin) => {
      const book = books.get(coin);
      assert.ok(book);
      return book;
    },
  };

  await qualifyHyperliquidPerpetualStrategyMarkets({
    reader: marketReader,
    plans: [{
      legs: [
        { role: 'PERPETUAL', order: {
          a: 3, b: true, p: '60010', s: '0.002', r: false,
          t: { limit: { tif: 'Ioc' } }, c: `0x${'41'.repeat(16)}`,
        } },
        { role: 'PERPETUAL', order: {
          a: 110_000, b: false, p: '59980', s: '0.002', r: false,
          t: { limit: { tif: 'Ioc' } }, c: `0x${'42'.repeat(16)}`,
        } },
      ],
    }],
    allowedCoins: ['BTC', 'xyz:BTC'], quoteTokenIndex: 0, minimumDepth: '0.001',
    maxBookAgeMs: 1_000, maxSnapshotSkewMs: 500, maxReferenceDivergenceBps: 50,
    currentTimeMs: () => 1_000_000,
  });
});
