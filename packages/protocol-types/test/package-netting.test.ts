import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  EMPTY_RECOVERY_RESERVE,
  compressPackageLegs,
  fundRecoveryReserve,
  netObligations,
  recoveryReserveAvailable,
  reserveRecoveryCapital,
  settleRecoveryClaim,
  toHex,
  verifyNetting,
  type NettingObligation,
} from '../src/index.js';

const id = (n: number): string => n.toString(16).padStart(64, '0');
const obligation = (n: number, userId: string, quantity: bigint, underlyingId = 'sol'): NettingObligation => ({
  obligationId: id(n),
  userId,
  packageId: `pkg-${n}`,
  underlyingId,
  signedQuantityAtoms: quantity,
  sequence: BigInt(n),
});

describe('package compression', () => {
  test('redundant legs cancel while the original graph is preserved', () => {
    const result = compressPackageLegs([
      { instrumentId: 'sol-perp', signedQuantityAtoms: 10n },
      { instrumentId: 'eth-perp', signedQuantityAtoms: 3n },
      { instrumentId: 'sol-perp', signedQuantityAtoms: -4n },
      { instrumentId: 'eth-perp', signedQuantityAtoms: -3n },
    ]);
    assert.equal(result.original.length, 4);
    assert.deepEqual(result.compressed, [{ instrumentId: 'sol-perp', signedQuantityAtoms: 6n }]);
  });
});

describe('cross-user netting', () => {
  const book = [obligation(1, 'alice', 30n), obligation(2, 'bob', 20n), obligation(3, 'carol', -40n), obligation(4, 'dave', 10n, 'eth')];

  test('crosses opposite obligations pro rata and routes only the net externally', () => {
    const result = netObligations(book, 10n);
    assert.deepEqual(
      result.allocations.map((item) => [item.userId, item.internalQuantityAtoms, item.externalQuantityAtoms]),
      [
        ['alice', 30n, 0n],
        ['bob', 10n, 10n],
        ['carol', -40n, 0n],
        ['dave', 0n, 10n],
      ],
    );
    assert.deepEqual(
      result.underlyings.map((item) => [item.underlyingId, item.internalMatchedAtoms, item.externalNetAtoms]),
      [
        ['eth', 0n, 10n],
        ['sol', 40n, 10n],
      ],
    );
    assert.equal(toHex(netObligations([...book].reverse(), 10n).proofHash), toHex(result.proofHash));
  });

  test('tampering with any allocation breaks conservation', () => {
    const result = netObligations(book, 10n);
    const [alice, ...rest] = result.allocations as [never, ...never[]];
    const tampered = { ...(alice as object), internalQuantityAtoms: 20n, externalQuantityAtoms: 10n } as never;
    assert.throws(() => verifyNetting([tampered, ...rest], result.underlyings), /unbalanced/);
    const flipped = { ...(alice as object), internalQuantityAtoms: 40n, externalQuantityAtoms: -10n } as never;
    assert.throws(() => verifyNetting([flipped, ...rest], result.underlyings), /exceeds its obligation/);
  });

  test('every netted underlying needs one summary recomputed from its allocations', () => {
    const result = netObligations(book, 10n);
    assert.throws(() => verifyNetting(result.allocations, []), /has no summary/);
    assert.throws(() => verifyNetting(result.allocations, result.underlyings.slice(1)), /has no summary/);
    assert.throws(() => verifyNetting(result.allocations, [...result.underlyings, result.underlyings[0]!]), /summarized twice/);
    const inflated = result.underlyings.map((summary) => ({ ...summary, grossBuyAtoms: summary.grossBuyAtoms + 5n, grossSellAtoms: summary.grossSellAtoms + 5n }));
    assert.throws(() => verifyNetting(result.allocations, inflated), /do not follow from the allocations/);
  });

  test('malformed obligation sets reject', () => {
    assert.throws(() => netObligations([obligation(1, 'alice', 15n)], 10n), /increment lattice/);
    assert.throws(() => netObligations([obligation(1, 'alice', 10n), obligation(1, 'bob', -10n)], 10n), /repeat/);
    assert.throws(() => netObligations([obligation(1, 'alice', 0n)], 10n), /zero/);
  });

  test('a seeded run conserves every obligation, side, and underlying', () => {
    let seed = 7n;
    const next = (modulus: bigint): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      return (seed >> 33n) % modulus;
    };
    for (let round = 0; round < 50; round += 1) {
      const count = Number(next(12n)) + 1;
      const obligations = Array.from({ length: count }, (_, index) => {
        const size = (next(9n) + 1n) * 5n;
        return obligation(index + 1, `u-${next(4n)}`, next(2n) === 0n ? size : -size, next(2n) === 0n ? 'sol' : 'eth');
      });
      const result = netObligations(obligations, 5n);
      verifyNetting(result.allocations, result.underlyings);
      for (const item of result.allocations) assert.equal(item.internalQuantityAtoms % 5n, 0n);
    }
  });
});

describe('isolated recovery capital', () => {
  test('a risk domain can only spend its own reserve', () => {
    let ledger = fundRecoveryReserve(fundRecoveryReserve(EMPTY_RECOVERY_RESERVE, 'sol-carry', 100n), 'hype-carry', 50n);
    ledger = reserveRecoveryCapital(ledger, 'sol-carry', id(1), 80n);
    assert.throws(() => reserveRecoveryCapital(ledger, 'sol-carry', id(2), 21n), /insufficient/);
    assert.equal(recoveryReserveAvailable(ledger, 'hype-carry'), 50n);
    assert.throws(() => reserveRecoveryCapital(ledger, 'hype-carry', id(1), 1n), /already reserved/);
    assert.throws(() => reserveRecoveryCapital(ledger, 'eth-carry', id(3), 1n), /no recovery reserve/);
    assert.throws(() => settleRecoveryClaim(ledger, 'sol-carry', id(1), 81n), /exceeds the reserved claim/);
    ledger = settleRecoveryClaim(ledger, 'sol-carry', id(1), 60n);
    assert.equal(recoveryReserveAvailable(ledger, 'sol-carry'), 40n);
    assert.throws(() => settleRecoveryClaim(ledger, 'sol-carry', id(1), 0n), /not reserved/);
  });
});
