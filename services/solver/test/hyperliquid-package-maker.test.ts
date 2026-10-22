import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef, domainRef } from '@naryx/protocol-types';
import { TESTNET_API_URL } from '@nktkas/hyperliquid';
import { createHyperliquidMakerReader } from '../src/hyperliquid-package-maker.js';

function fixture(templateId = 'perpetual-funding-spread-v1') {
  const account = `0x${'11'.repeat(20)}` as const;
  let balance = 199_000_000n;
  let time = 1_000_000;
  const market = { templateId, solverId: 'solver', domain: domainRef('hypercore:testnet', 1, '22'.repeat(32)),
    baseAsset: assetRef('base', '33'.repeat(32), 10), quoteAsset: assetRef('quote', '44'.repeat(32), 8),
    spot: { coin: '@2072', sizeDecimals: 5 }, perpetual: { coin: 'BTC', sizeDecimals: 5 },
    counterPerpetual: { coin: 'other:BTC', sizeDecimals: 4 }, marginBps: 500, maxBookAgeMs: 15000, maxBookSpreadBps: 200 };
  const input = { marketId: 'market', market, fundingAccount: account, maximumCapacityAtoms: 199_00000000n,
    quantity: 1_000_000n, levels: 16, backingAtomsPerWholeAsset: 10_000_00000000n, clockMs: () => 1_000_000,
    funding: { flat: async () => ({ environment: 'TESTNET' as const, account, equityQuoteAtoms: balance,
      withdrawableQuoteAtoms: balance, requestedAtMs: 999_999, observedAtMs: 1_000_000 }) },
    books: { environment: 'testnet' as const, apiUrl: TESTNET_API_URL as typeof TESTNET_API_URL,
      userFees: async () => ({ userCrossRate: '0.00045', userSpotCrossRate: '0.0007' }),
      l2Book: async (coin: string) => ({ coin, time, levels: [[{ px: '83000', sz: '1', n: 1 }],
        [{ px: '83001', sz: '1', n: 1 }]] as [{px:string;sz:string;n:number}[], {px:string;sz:string;n:number}[]] }) } };
  return { input, setBalance: (n: bigint) => { balance = n; }, setTime: (n: number) => { time = n; } };
}

test('funded Hyperliquid ladders reserve exact venue margin and normalize USDC decimals', async () => {
  const f = fixture();
  const source = createHyperliquidMakerReader(f.input);
  const result = await source.read(1n);
  assert.equal(result.quotes.length, 32);
  assert.equal(result.capacity.availableAtoms, 199_00000000n);
  assert.equal(result.quotes.reduce((n, q) => n + q.backingAtoms, 0n), 32_00000000n);
  for (const side of ['BID', 'ASK']) assert.equal(new Set(result.quotes.filter(q => q.quote.side === side)
    .map(q => q.quote.legSources[0]!.priceTicks - q.quote.legSources[1]!.priceTicks)).size, 16);
  f.setBalance(1_000_000n);
  await assert.rejects(source.read(2n), /collateral/);
  f.setBalance(199_000_000n); f.setTime(980_000);
  await assert.rejects(source.read(3n), /stale/);
});

test('cash carry reserves full spot capital and only publishes supported entry offers', async () => {
  const f = fixture('cash-and-carry-v1');
  await assert.rejects(createHyperliquidMakerReader(f.input).read(1n), /reserve/);
  const result = await createHyperliquidMakerReader({ ...f.input, quantity: 2_000_000n, levels: 1,
    backingAtomsPerWholeAsset: 110_000_00000000n }).read(1n);
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0]!.quote.side, 'ASK');
  assert.equal(result.quotes[0]!.backingAtoms, 22_00000000n);
});

test('maker refuses unknown domains, invalid lots and insufficient reserve policies', async () => {
  const f = fixture();
  assert.throws(() => createHyperliquidMakerReader({ ...f.input, quantity: 100_000n }), /lot/);
  assert.throws(() => createHyperliquidMakerReader({ ...f.input, market: { ...f.input.market,
    domain: domainRef('hypercore:mainnet', 1, '22'.repeat(32)) } }), /testnet/);
  await assert.rejects(createHyperliquidMakerReader({ ...f.input, backingAtomsPerWholeAsset: 1n }).read(1n), /reserve/);
  const migration = await createHyperliquidMakerReader(fixture('hedge-migration-v1').input).read(1n);
  assert.deepEqual(migration.quotes[0]!.quote.legRatios.map(r => r.numerator), [1n, -1n]);
});
