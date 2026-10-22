import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef, domainRef } from '@naryx/protocol-types';
import { createEvmStrategyMakerReader } from '../src/evm-strategy-maker.js';
import type { EvmTreasuryHedgePricingInput } from '../src/evm-treasury-hedge-quote.js';
import type { EvmOptionSpreadPricingInput } from '../src/evm-option-spread-quote.js';

const wad = 10n ** 18n;
const address = (n: string) => `0x${n.repeat(40)}` as const;
const hash = `0x${'ab'.repeat(32)}` as const;
const identity = (n: string) => ({ address: address(n), expectedCodeHash: hash });
const common = { marketId: 'strategy', solverId: 'solver', fundingAccount: address('9'),
  quantities: Array.from({ length: 16 }, (_, i) => BigInt(i + 1) * wad / 10000n), backingAtomsPerWholeAsset: 10_000_000_000n,
  maximumCapacityAtoms: 100_000_000_000n, clockMs: () => 1_000_000 };

function fixture() {
  const state = { paused: false, chainId: 84532n, reserve: 100_000n * wad, poolBalance: wad * 100n };
  const pricing = {
    chainId: 84532n, domain: domainRef('eip155:84532', 1, '66'.repeat(32)),
    inventoryAsset: assetRef('base', '77'.repeat(32), 18), quoteAsset: assetRef('quote', '88'.repeat(32), 6),
    inventoryToken: identity('1'), quoteToken: identity('2'), oracle: identity('3'), market: identity('4'),
    chain: { chainId: async () => state.chainId, latestBlockTimestamp: async () => 1000n, codeHash: async () => hash,
      readContract: async ({ address: target, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }) => {
        switch (functionName) {
          case 'balanceOf': return target === address('1') ? state.poolBalance : 100_000_000_000n;
          case 'decimals': return target === address('3') ? 8 : 6;
          case 'insuranceWad': return state.reserve;
          case 'opensPaused': return state.paused;
          case 'maxPositionSizeWad': return 10n * wad;
          case 'collateral': return address('2');
          case 'oracle': return address('3');
          case 'expiry': return 100_000n;
          case 'takerFeeBps': return 5n;
          case 'initialMarginBps': return 1000n;
          case 'maintenanceMarginBps': return 500n;
          case 'collateralScale': return 10n ** 12n;
          case 'oraclePriceWad': return 2000n * wad;
          case 'currentFundingIndex': return 0n;
          case 'previewOpen': {
            const q = args![0] as bigint;
            const price = 2000n * wad + q;
            return [price, (q < 0n ? -q : q) * price / wad, 1n, 1n];
          }
          case 'latestRoundData': return [1n, 2000n * 10n ** 8n, 990n, 990n, 1n];
          case 'getPoolSettings': return [address('1'), address('2'), address('3'), target === address('5') ? 1900n : 2100n, 100_000n, true];
          case 'poolToken': return address('1');
          case 'premiumBps': return target === address('5') ? 100n : 50n;
          default: throw new Error(`Unexpected read: ${functionName}`);
        }
      } },
  } as unknown as EvmTreasuryHedgePricingInput;
  return { pricing, state };
}

test('treasury ladder prices real inventory reference against the hedge and fails closed on capacity', async () => {
  const { pricing, state } = fixture();
  const reader = createEvmStrategyMakerReader({ ...common, kind: 'treasury', pricing });
  const snapshot = await reader.read(4n);
  assert.equal(snapshot.quotes.length, 32);
  for (const side of ['BID', 'ASK']) assert.equal(new Set(snapshot.quotes.filter(q => q.quote.side === side)
    .map(q => q.quote.legSources[0]!.priceTicks - q.quote.legSources[1]!.priceTicks)).size, 16);
  for (const item of snapshot.quotes) {
    const [inventory, hedge] = item.quote.legSources;
    const spread = inventory!.priceTicks - hedge!.priceTicks;
    assert.ok(item.quote.side === 'ASK' ? spread > 0n : spread < 0n);
    assert.equal(inventory!.sourceVersion, 4n);
  }
  state.paused = true;
  await assert.rejects(reader.read(5n), /risk capacity/);
  state.paused = false;
  state.reserve = 1n;
  await assert.rejects(reader.read(6n), /payout reserve/);
  state.chainId = 1n;
  await assert.rejects(reader.read(7n), /collateral or clock/);
});

test('option ladder binds actual pool premiums and refuses unbacked payouts', async () => {
  const { pricing: treasury, state } = fixture();
  const pricing = { ...treasury, baseAsset: treasury.inventoryAsset, baseToken: treasury.inventoryToken,
    maximumOracleAgeSeconds: 60n, pools: [
      { role: 'option-long', pool: identity('5'), expectedStrike: 1900n, expectedMaturity: 100_000n },
      { role: 'option-short', pool: identity('6'), expectedStrike: 2100n, expectedMaturity: 100_000n },
    ] } as unknown as EvmOptionSpreadPricingInput;
  const reader = createEvmStrategyMakerReader({ ...common, kind: 'option', pricing });
  const result = await reader.read(1n);
  assert.equal(result.quotes.length, 32);
  const price = (i: number) => result.quotes[i]!.quote.legSources[0]!.priceTicks - result.quotes[i]!.quote.legSources[1]!.priceTicks;
  assert.ok(price(0) < 10_000_000n && price(1) > 10_000_000n);
  assert.ok(price(2) < price(0) && price(3) > price(1));
  state.poolBalance = 1n;
  await assert.rejects(reader.read(2n), /payout inventory/);
});
