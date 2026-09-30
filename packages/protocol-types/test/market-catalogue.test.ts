import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { marketCatalogueCurrent, marketCatalogueHash, searchMarketCatalogue, toHex, type MarketCatalogueEntryInput, type MarketCatalogueInput } from '../src/index.js';

const entry = (packageMarketId: string, overrides: Partial<MarketCatalogueEntryInput> = {}): MarketCatalogueEntryInput => ({
  packageMarketId,
  executionClassVersion: 1,
  seriesId: 'sol-basis-30d',
  seriesVersion: 1,
  templateId: 'cash-and-carry-v1',
  templateVersion: 1,
  underlyingRefs: ['sol'],
  quoteAsset: 'usdc',
  settlementClass: 'ATOMIC_POSTCONDITION',
  firmnessClass: 'implied',
  collateralMode: 'isolated',
  domainIds: ['svm:devnet'],
  halted: false,
  ...overrides,
});

const catalogue = (overrides: Partial<MarketCatalogueInput> = {}): MarketCatalogueInput => ({
  catalogueVersion: 1,
  environment: 'testnet',
  sequence: 7n,
  issuedAtMs: 1_000n,
  expiresAtMs: 61_000n,
  entries: [
    entry('sol-atomic'),
    entry('btc-coordinated', { seriesId: 'btc-basis', underlyingRefs: ['btc'], settlementClass: 'BATCHED_IOC_WITH_RECOVERY', domainIds: ['hypercore:testnet'] }),
    entry('eth-halted', { underlyingRefs: ['eth'], halted: true }),
  ],
  solverIds: ['solver-b', 'solver-a'],
  authority: 'catalogue-key-1',
  signature: new Uint8Array(64).fill(3),
  ...overrides,
});

describe('market catalogue', () => {
  test('one catalogue has one hash whatever order it lists markets in, and the signature is not hashed', () => {
    const base = toHex(marketCatalogueHash(catalogue()));
    assert.equal(toHex(marketCatalogueHash(catalogue({ entries: [...catalogue().entries].reverse(), signature: new Uint8Array(64).fill(9) }))), base);
    assert.notEqual(toHex(marketCatalogueHash(catalogue({ sequence: 8n }))), base);
    assert.notEqual(toHex(marketCatalogueHash(catalogue({ entries: [entry('sol-atomic', { halted: true })] }))), base);
    assert.throws(() => marketCatalogueHash(catalogue({ entries: [entry('sol-atomic'), entry('sol-atomic')] })), /listed twice/);
    assert.throws(() => marketCatalogueHash(catalogue({ expiresAtMs: 1_000n })), /expire after/);
  });

  test('searches run locally over the held catalogue and leave halted markets out unless asked', () => {
    assert.deepEqual(searchMarketCatalogue(catalogue(), { text: 'BTC' }).map((found) => found.packageMarketId), ['btc-coordinated']);
    assert.deepEqual(searchMarketCatalogue(catalogue(), { settlementClass: 'ATOMIC_POSTCONDITION' }).map((found) => found.packageMarketId), ['sol-atomic']);
    assert.deepEqual(searchMarketCatalogue(catalogue(), { underlying: 'eth', includeHalted: true }).map((found) => found.packageMarketId), ['eth-halted']);
    assert.deepEqual(searchMarketCatalogue(catalogue(), { domainId: 'hypercore:testnet' }).map((found) => found.packageMarketId), ['btc-coordinated']);
    assert.equal(marketCatalogueCurrent(catalogue(), 60_999n), true);
    assert.equal(marketCatalogueCurrent(catalogue(), 61_000n), false);
  });
});
