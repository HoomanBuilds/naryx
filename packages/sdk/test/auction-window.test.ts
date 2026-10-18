import assert from 'node:assert/strict';
import test from 'node:test';
import { sealedAuctionDeadlines } from '../src/auction-window.js';

test('auction deadlines use the supplied click time and retain the quoted settlement window', () => {
  const renderedAt = 1_800_000_000_000;
  const clickedAt = renderedAt + 4_999;
  const hypercore = sealedAuctionDeadlines('HYPERLIQUID_UNIX_MILLISECONDS', clickedAt);
  assert.deepEqual(hypercore, {
    commitDeadlineValue: BigInt(clickedAt) + 5_000n,
    revealDeadlineValue: BigInt(clickedAt) + 12_000n,
    settlementDeadlineValue: BigInt(clickedAt) + 20_000n,
  });
  assert.deepEqual(sealedAuctionDeadlines('EVM_UNIX_SECONDS', clickedAt), {
    commitDeadlineValue: 1_800_000_024n,
    revealDeadlineValue: 1_800_000_039n,
    settlementDeadlineValue: 1_800_000_054n,
  });
});

test('auction clock validation rejects unsafe inputs and preserves exact arithmetic at the boundary', () => {
  for (const now of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => sealedAuctionDeadlines('EVM_UNIX_SECONDS', now), /Invalid auction clock/);
  }
  assert.equal(sealedAuctionDeadlines('HYPERLIQUID_UNIX_MILLISECONDS', Number.MAX_SAFE_INTEGER).settlementDeadlineValue,
    BigInt(Number.MAX_SAFE_INTEGER) + 20_000n);
  assert.throws(() => sealedAuctionDeadlines('SOLANA_SLOT' as never, 1_000), /Unsupported/);
});
