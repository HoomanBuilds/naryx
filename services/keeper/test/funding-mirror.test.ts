import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  BASE_SEPOLIA_CHAIN_REF,
  evmRateFromHourlyFunding,
  FundingSubmissionRecordFile,
  parseExactDecimal,
  runFundingMirrorPass,
  SOLANA_DEVNET_CHAIN_REF,
  solanaRateFromHourlyFunding,
  type FundingMarketConfig,
  type FundingMarketPort,
  type FundingSource,
  type MarketState,
} from '../src/funding-mirror.js';

const decimal = (value: string) => parseExactDecimal(value, 'test');

test('hourly venue funding converts exactly to each market unit, truncating toward zero', () => {
  // 0.0000125 * 3000.5 / 3600 = 1.04184027777...e-5 quote per base per second.
  assert.equal(evmRateFromHourlyFunding(decimal('0.0000125'), decimal('3000.5')), 10_418_402_777_777n);
  // 0.0000125 / 3600 * 1e12 = 3472.22...
  assert.equal(solanaRateFromHourlyFunding(decimal('0.0000125')), 3472n);
  assert.equal(solanaRateFromHourlyFunding(decimal('-0.0000125')), -3472n);
  assert.throws(() => parseExactDecimal('1.25e-5', 'funding'), /not a plain decimal/);
  assert.throws(() => parseExactDecimal(0.0000125, 'funding'), /decimal string/);
});

function fakePort(state: MarketState, options: { identityError?: Error } = {}) {
  const submitted: bigint[] = [];
  const port: FundingMarketPort = {
    async verifyIdentity() {
      if (options.identityError !== undefined) throw options.identityError;
    },
    async readMarket() {
      return state;
    },
    async submit(rate) {
      submitted.push(rate);
      return `tx-${rate}`;
    },
  };
  return { port, submitted };
}

const source: FundingSource = {
  async read() {
    return new Map([
      ['ETH', { funding: decimal('0.01'), oraclePx: decimal('3000'), fundingText: '0.01', oraclePxText: '3000' }],
      ['SOL', { funding: decimal('0.0000125'), oraclePx: decimal('150'), fundingText: '0.0000125', oraclePxText: '150' }],
    ]);
  },
};

const markets: FundingMarketConfig[] = [
  { id: 'base-eth', chainRef: BASE_SEPOLIA_CHAIN_REF, market: '0x0000000000000000000000000000000000000001', coin: 'ETH', minChange: 1n },
  { id: 'solana-sol', chainRef: SOLANA_DEVNET_CHAIN_REF, market: 'm', programId: 'p', coin: 'SOL', minChange: 100n },
  { id: 'base-wrong-chain', chainRef: BASE_SEPOLIA_CHAIN_REF, market: '0x0000000000000000000000000000000000000002', coin: 'ETH', minChange: 1n },
];

test('pass clamps and logs, skips small changes, refuses an unverified chain, and records submissions durably', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naryx-funding-'));
  try {
    const evm = fakePort({ keeperAuthorized: true, bound: 10n ** 15n, currentRate: 0n });
    const solana = fakePort({ keeperAuthorized: true, bound: 1_000_000n, currentRate: 3400n });
    const wrong = fakePort({ keeperAuthorized: true, bound: 10n ** 15n, currentRate: 0n }, { identityError: new Error('RPC endpoint configured for eip155:84532 serves eip155:8453') });
    const record = new FundingSubmissionRecordFile(join(directory, 'record.json'));
    const logs: string[] = [];
    const results = await runFundingMirrorPass({
      markets,
      source,
      ports: new Map([['base-eth', evm.port], ['solana-sol', solana.port], ['base-wrong-chain', wrong.port]]),
      record,
      writesEnabled: true,
      nowMs: () => 1_700_000_000_000,
      log: (line) => logs.push(line),
    });
    // 0.01 * 3000 / 3600 * 1e18 = 8.33e15, above the 1e15 bound.
    assert.deepEqual(evm.submitted, [10n ** 15n]);
    assert.equal(results[0]?.status, 'SUBMITTED');
    assert.equal(results[0]?.clamped, true);
    assert.match(logs.join('\n'), /base-eth: ETH funding 0\.01\/h converts to 8333333333333333, clamped to market bound 1000000000000000/);
    // |3472 - 3400| = 72 < 100.
    assert.equal(results[1]?.status, 'SKIPPED_BELOW_THRESHOLD');
    assert.deepEqual(solana.submitted, []);
    assert.equal(results[2]?.status, 'FAILED');
    assert.deepEqual(wrong.submitted, []);
    assert.deepEqual(record.read(), {
      'base-eth': { rate: '1000000000000000', transaction: 'tx-1000000000000000', submittedAtMs: 1_700_000_000_000, sourceFunding: '0.01', sourceOraclePx: '3000', clamped: true },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('writes stay off unless explicitly enabled', async () => {
  const evm = fakePort({ keeperAuthorized: true, bound: 10n ** 17n, currentRate: 0n });
  const unauthorized = fakePort({ keeperAuthorized: false, bound: 1_000_000n, currentRate: 0n });
  const writes: string[] = [];
  const results = await runFundingMirrorPass({
    markets: markets.slice(0, 2),
    source,
    ports: new Map([['base-eth', evm.port], ['solana-sol', unauthorized.port]]),
    record: { write: (id) => void writes.push(id) },
    writesEnabled: false,
    nowMs: () => 0,
    log: () => {},
  });
  assert.equal(results[0]?.status, 'DRY_RUN');
  assert.equal(results[0]?.targetRate, 8_333_333_333_333_333n);
  // A dry run loads no key, so keeper authorization is checked only before a real submission.
  assert.equal(results[1]?.status, 'DRY_RUN');
  assert.deepEqual(evm.submitted, []);
  assert.deepEqual(writes, []);
});
