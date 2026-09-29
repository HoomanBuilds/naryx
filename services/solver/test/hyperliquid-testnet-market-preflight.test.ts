import assert from 'node:assert/strict';
import test from 'node:test';
import type { HyperliquidExecutionPlan } from '@naryx/adapter-hyperliquid';
import {
  HYPERLIQUID_TESTNET_MARKET_INFO_URL,
  HyperliquidTestnetMarketPreflight,
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
      { role: 'SPOT', order: { a: 10_007, b: true, p: '60100', s: '0.002', r: false } },
      { role: 'PERPETUAL', order: { a: 3, b: false, p: '58000', s: '0.002', r: false } },
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

function preflight(value: HyperliquidTestnetMarketSnapshot) {
  return new HyperliquidTestnetMarketPreflight(reader(value), {
    spotUniverseName: '@7', spotTokenName: 'BTC', quoteTokenName: 'USDC',
    perpetualName: 'BTC', spotSizeDecimals: 5, perpetualSizeDecimals: 5,
    maxBookAgeMs: 1_000, maxSnapshotSkewMs: 500,
    maxReferenceDivergenceBps: 50,
    minimumSpotDepth: '0.001', minimumPerpetualDepth: '0.001',
  }, () => 1_000_000);
}

test('accepts exact Testnet market identities with executable two-sided depth', async () => {
  await preflight(snapshot()).qualify({ plan: plan(), binding });
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
        ? { ...token, name: 'WBTC' }
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
