export function sealedAuctionDeadlines(
  timeUnit: 'EVM_UNIX_SECONDS' | 'HYPERLIQUID_UNIX_MILLISECONDS',
  nowMs: number,
) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('Invalid auction clock');
  if (timeUnit !== 'EVM_UNIX_SECONDS' && timeUnit !== 'HYPERLIQUID_UNIX_MILLISECONDS') {
    throw new Error('Unsupported auction clock unit');
  }
  const milliseconds = timeUnit === 'HYPERLIQUID_UNIX_MILLISECONDS';
  const now = milliseconds ? BigInt(nowMs) : BigInt(nowMs) / 1000n;
  const second = milliseconds ? 1000n : 1n;
  return Object.freeze({
    commitDeadlineValue: now + (milliseconds ? 5n : 20n) * second,
    revealDeadlineValue: now + (milliseconds ? 12n : 35n) * second,
    settlementDeadlineValue: now + (milliseconds ? 20n : 50n) * second,
  });
}
