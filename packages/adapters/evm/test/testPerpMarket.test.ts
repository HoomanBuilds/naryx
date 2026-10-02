import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deriveTestPerpEntryLimits,
  encodeTestPerpTradeArgs,
  testPerpCloseSettlement,
  testPerpFeeWad,
} from '../src/index.js';

const market = { takerFeeBps: 5n, initialMarginBps: 1_000n, collateralScale: 1_000_000_000_000n };
const WAD = 1_000_000_000_000_000_000n;

test('rounds the taker fee up to a whole collateral atom', () => {
  assert.equal(testPerpFeeWad(0n, market), 0n);
  // 5 bps of 1 wei of notional is still one whole USDC atom.
  assert.equal(testPerpFeeWad(1n, market), market.collateralScale);
  // 3000 USDC notional: fee 1.5 USDC exactly.
  assert.equal(testPerpFeeWad(3_000n * WAD, market), 1_500_000n * market.collateralScale);
});

test('bounds the entry post balance across the oracle move allowance', () => {
  const balanceWad = 400n * WAD;
  const limits = deriveTestPerpEntryLimits({
    previewEntryNotionalWad: 3_000n * WAD,
    balanceWad,
    oracleMoveAllowanceBps: 100n,
    market,
  });
  assert.equal(limits.maximumPostPerpEntryNotionalWad, 3_030n * WAD);
  assert.equal(limits.minimumPostPerpBalanceWad, balanceWad - testPerpFeeWad(3_030n * WAD, market));
  assert.equal(limits.maximumPostPerpBalanceWad, balanceWad - testPerpFeeWad(2_970n * WAD, market));
  assert.ok(limits.minimumPostPerpBalanceWad <= limits.maximumPostPerpBalanceWad);
});

test('fails closed on fractional atoms and on margin below the worst-case initial margin', () => {
  assert.throws(() => deriveTestPerpEntryLimits({
    previewEntryNotionalWad: 3_000n * WAD, balanceWad: 400n * WAD + 1n, oracleMoveAllowanceBps: 0n, market,
  }), /whole collateral atoms/);
  // 10% initial margin of 3030 is 303; 303 plus the 1.515 fee needs more than 304.
  assert.throws(() => deriveTestPerpEntryLimits({
    previewEntryNotionalWad: 3_000n * WAD, balanceWad: 304n * WAD, oracleMoveAllowanceBps: 100n, market,
  }), /initial margin/);
  assert.doesNotThrow(() => deriveTestPerpEntryLimits({
    previewEntryNotionalWad: 3_000n * WAD, balanceWad: 305n * WAD, oracleMoveAllowanceBps: 100n, market,
  }));
});

test('packs the trade header and a negative size as two int128 halves', () => {
  const [header, packed] = encodeTestPerpTradeArgs({
    deadline: 2_000n, expiry: 4_294_967_295, sizeDeltaWad: -2n * WAD, balanceDeltaWad: 400n * WAD,
  });
  const headerValue = BigInt(`0x${Buffer.from(header).toString('hex')}`);
  assert.equal(headerValue >> 56n, 2_000n);
  assert.equal(headerValue & 0xffff_ffffn, 4_294_967_295n);
  const value = BigInt(`0x${Buffer.from(packed).toString('hex')}`);
  const mask = (1n << 128n) - 1n;
  assert.equal(BigInt.asIntN(128, value >> 128n), -2n * WAD);
  assert.equal(BigInt.asIntN(128, value & mask), 400n * WAD);
  assert.throws(() => encodeTestPerpTradeArgs({
    deadline: 2_000n, expiry: 1, sizeDeltaWad: 0n, balanceDeltaWad: 0n,
  }), /size delta must be nonzero/);
});

test('settles a short close like the market: funding against the trader, fee from positive equity only', () => {
  const scale = market.collateralScale;
  // Short 1 at 3000 with 400 margin; the buy-back costs 2990 plus a 1.495 fee and longs paid 2.5.
  const position = { balanceWad: 400n * WAD, sizeWad: -WAD, entryNotionalWad: 3_000n * WAD, entryFundingIndex: 7n };
  const exitNotionalWad = 2_990n * WAD;
  const feeWad = testPerpFeeWad(exitNotionalWad, market);
  const settled = testPerpCloseSettlement({
    position, exitNotionalWad, feeWad, currentFundingIndex: 7n + 2_500_000_000_000_000_000n, collateralScale: scale,
  });
  assert.equal(settled.fundingWad, 2_500_000_000_000_000_000n);
  assert.equal(settled.equityWad, 412_500_000_000_000_000_000n);
  assert.equal(settled.chargedWad, feeWad);
  assert.equal(settled.payoutWad, settled.equityWad - feeWad);
  // Half a unit short and one wei of index: received funding rounds down, paid funding rounds up.
  const half = { ...position, sizeWad: -WAD / 2n };
  assert.equal(testPerpCloseSettlement({ position: half, exitNotionalWad, feeWad, currentFundingIndex: 8n, collateralScale: scale }).fundingWad, 0n);
  assert.equal(testPerpCloseSettlement({ position: half, exitNotionalWad, feeWad, currentFundingIndex: 6n, collateralScale: scale }).fundingWad, -1n);
  // Equity of 1.5 atoms against a larger fee: the charge takes the whole atom and nothing pays out.
  const thin = testPerpCloseSettlement({
    position: { ...position, balanceWad: 2n * scale }, exitNotionalWad: 3_000n * WAD + scale / 2n, feeWad, currentFundingIndex: 7n, collateralScale: scale,
  });
  assert.equal(thin.chargedWad, scale);
  assert.equal(thin.payoutWad, 0n);
  const underwater = testPerpCloseSettlement({
    position, exitNotionalWad: 3_500n * WAD, feeWad, currentFundingIndex: 7n, collateralScale: scale,
  });
  assert.equal(underwater.payoutWad, 0n);
  assert.equal(underwater.chargedWad, 0n);
  assert.throws(() => testPerpCloseSettlement({
    position: { ...position, sizeWad: 0n }, exitNotionalWad, feeWad, currentFundingIndex: 7n, collateralScale: scale,
  }), /flat/);
});
