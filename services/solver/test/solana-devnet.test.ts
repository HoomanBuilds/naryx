import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firmReservationId } from '@naryx/protocol-types';
import type { DomainRef } from '@naryx/protocol-types';
import { priceSolanaDevnetEntry, selectFirmLevel } from '../src/solana-devnet-firm-quote.js';
import {
  BorshWriter,
  accountDiscriminator,
  decodeFirmReservation,
  reservationIdFor,
  type QuoteLevelState,
  type TestPerpMarketState,
} from '../src/solana-devnet-wire.js';

const domain = { domainId: 'svm:devnet', domainManifestVersion: 1, domainManifestHash: new Uint8Array(32).fill(7) } as DomainRef;
const market: TestPerpMarketState = {
  oracle: 'o', feedIdHex: 'f', collateralMint: 'c', collateralVault: 'v', feeVault: 'fv', insuranceVault: 'iv',
  collateralDecimals: 6, baseDecimals: 9, maxPriceAgeSeconds: 60, maxConfidenceBps: 50, takerFeeBps: 5, halfSpreadBps: 2,
  impactBpsPerUnit: 1, maxSlippageBps: 100, initialMarginBps: 1000, impactUnitLots: 10_000n, baseLotAtoms: 1_000_000n,
  quoteTickAtomsPerBaseLot: 1n, maxPositionLots: 1_000_000n, pauseOpens: false,
};

test('reservation ids match the protocol firm reservation identity', () => {
  const nonce = new Uint8Array(32).fill(3);
  const orderHash = new Uint8Array(32).fill(9);
  const solverId = '11111111111111111111111111111112';
  assert.deepEqual(
    reservationIdFor(domain, solverId, orderHash, nonce),
    Uint8Array.from(firmReservationId({ domain, solverId, orderHash, reservationNonce: BigInt(`0x${Buffer.from(nonce).toString('hex')}`) })),
  );
});

test('prices a firm inventory spot leg and a test perp short in integer atoms', () => {
  // 2 SOL at 150000 atoms per 0.001 SOL lot, 10 bps inventory spread, 5 bps perp limit tolerance.
  const pricing = priceSolanaDevnetEntry({ inventorySpreadBps: 10, perpLimitToleranceBps: 5, spotBaseLotAtoms: 1_000_000n }, market, 150_000n, 2_000_000_000n);
  assert.equal(pricing.firmQuoteAtoms, 300_300_000n);
  assert.equal(pricing.spotLots * pricing.spotLimitPerLot >= pricing.firmQuoteAtoms, true);
  assert.equal(pricing.perpNotionalAtoms, 299_910_000n);
  assert.equal(pricing.perpFeeAtoms, 149_955n);
  assert.equal(pricing.perpLimitPerLot, 149_880n);
  assert.throws(() => priceSolanaDevnetEntry({ inventorySpreadBps: 10, perpLimitToleranceBps: 5, spotBaseLotAtoms: 1_000_000n }, market, 150_000n, 1_500_000n), /exact/);
});

test('selects only a live firm ask level with the reviewed policy, capacity, and expiry window', () => {
  const policy = new Uint8Array(32).fill(4);
  const settlement = new Uint8Array(32).fill(5);
  const level: QuoteLevelState = {
    slotIndex: 3, settlementClassIdentityHash: settlement, reservationPolicyHash: policy, referenceOffset: 0n, levelId: 77n,
    epoch: 2n, levelSequence: 1n, minPackageSizeUnits: 1n, maxPackageSizeUnits: 10n, maxFeeAtoms: 0n, expirySlot: 500n,
    remainingCapacity: 10n, active: true, side: 2, quoteMode: 2,
  };
  const state = {
    slot: 400n, market, oraclePricePerLot: 150_000n,
    reservationClass: { policyHash: policy } as never,
    shard: { epoch: 2n, heartbeatExpirySlot: 600n } as never,
    levels: [level],
  };
  const config = { series: { settlementClassIdentityHash: settlement } } as never;
  assert.equal(selectFirmLevel(state, config, 2n, 450n, 550n)?.levelId, 77n);
  assert.equal(selectFirmLevel(state, config, 11n, 450n, 550n), undefined);
  assert.equal(selectFirmLevel(state, config, 2n, 500n, 550n), undefined);
  assert.equal(selectFirmLevel({ ...state, levels: [{ ...level, quoteMode: 1 }] }, config, 2n, 450n, 550n), undefined);
});

test('decodes the inventory reservation account layout', () => {
  const key = (byte: number) => new Uint8Array(32).fill(byte);
  const data = new BorshWriter()
    .bytes(accountDiscriminator('FirmReservation')).bytes(Buffer.from([2, 0])).bytes(key(1)).domain(domain).bytes(key(2))
    .string('solver-a').bytes(key(3)).bytes(key(4)).u64(9n).bytes(key(5)).bytes(key(6)).bytes(key(7)).bytes(key(8))
    .bytes(key(10)).bytes(key(11)).bytes(key(12)).bytes(key(13)).bytes(key(14)).bytes(key(15)).u64(2_000n).u64(300n).u64(900n)
    .u8(1).u8(1).u8(255).u8(254)
    .done();
  const reservation = decodeFirmReservation(data);
  assert.equal(reservation.state, 'LIVE');
  assert.equal(reservation.solverId, 'solver-a');
  assert.equal(reservation.baseAtoms, 2_000n);
  assert.equal(reservation.expirySlot, 900n);
});
