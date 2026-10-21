import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef, domainRef } from '@naryx/protocol-types';
import { createCalendarMakerReader } from '../src/evm-package-maker.js';
import type { EvmCalendarSpreadPricingInput } from '../src/evm-calendar-spread-quote.js';

test('calendar maker quotes aggregate impact and refuses unavailable venue reserves', async () => {
  const wad = 10n ** 18n;
  const near = `0x${'11'.repeat(20)}`;
  const far = `0x${'22'.repeat(20)}`;
  const token = `0x${'33'.repeat(20)}`;
  const oracle = `0x${'44'.repeat(20)}`;
  const codeHash = `0x${'55'.repeat(32)}`;
  let insurance = 100_000n * wad;
  const previewSizes: bigint[] = [];
  const quantities = [wad / 100n, wad / 20n];
  const pricing = {
    chainId: 84532n, domain: domainRef('eip155:84532', 1, '66'.repeat(32)),
    baseAsset: assetRef('base', '77'.repeat(32), 18), quoteAsset: assetRef('quote', '88'.repeat(32), 6),
    quoteToken: { address: token, expectedCodeHash: codeHash }, oracle: { address: oracle, expectedCodeHash: codeHash },
    markets: [{ role: 'near-future', contract: { address: near, expectedCodeHash: codeHash } },
      { role: 'far-future', contract: { address: far, expectedCodeHash: codeHash } }],
    chain: { chainId: async () => 84532n, latestBlockTimestamp: async () => 1000n, codeHash: async () => codeHash,
      readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }) => {
        switch (functionName) {
          case 'balanceOf': return 100_000_000_000n;
          case 'decimals': return 6;
          case 'insuranceWad': return insurance;
          case 'opensPaused': return false;
          case 'maxPositionSizeWad': return wad;
          case 'collateral': return token;
          case 'oracle': return oracle;
          case 'expiry': return address === near ? 100_000n : 200_000n;
          case 'takerFeeBps': return 5n;
          case 'initialMarginBps': return 1000n;
          case 'maintenanceMarginBps': return 500n;
          case 'collateralScale': return 10n ** 12n;
          case 'oraclePriceWad': return 2000n * wad;
          case 'currentFundingIndex': return 0n;
          case 'previewOpen': {
            const size = args![0] as bigint;
            const magnitude = size < 0n ? -size : size;
            previewSizes.push(magnitude);
            const price = 2000n * wad + size;
            return [price, magnitude * price / wad, 1n, magnitude / 10n];
          }
          default: throw new Error('Unexpected read');
        }
      } },
  } as unknown as EvmCalendarSpreadPricingInput;
  const reader = createCalendarMakerReader({ pricing, marketId: 'calendar', solverId: 'solver',
    fundingAccount: `0x${'99'.repeat(20)}`, quantities, backingAtomsPerWholeAsset: 10_000_000_000n,
    maximumCapacityAtoms: 100_000_000_000n, clockMs: () => 1_000_000 });
  const result = await reader.read(1n);
  assert.equal(result.quotes.length, 4);
  assert.ok(previewSizes.every(size => size > quantities.reduce((sum, quantity) => sum + quantity, 0n)));
  const asks = result.quotes.filter(row => row.quote.side === 'ASK');
  const aggregatePrice = asks.reduce((sum, row, index) => sum + quantities[index]! *
    (row.quote.legSources[0]!.priceTicks - row.quote.legSources[1]!.priceTicks), 0n);
  const total = quantities.reduce((sum, quantity) => sum + quantity, 0n);
  assert.ok(aggregatePrice >= total * (2n * total / (10n ** 12n)));
  insurance = 1n;
  await assert.rejects(reader.read(2n), /payout reserve/);
});
