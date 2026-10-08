import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  EMPTY_RECOVERY_RESERVE,
  commitmentHash,
  compressPackageLegs,
  fundRecoveryReserve,
  netObligations,
  recoveryReserveAvailable,
  reserveRecoveryCapital,
  settleRecoveryClaim,
  toHex,
  verifyNetting,
  verifyNettingResult,
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
  const increments = [
    { underlyingId: 'eth', quantityIncrementAtoms: 5n },
    { underlyingId: 'sol', quantityIncrementAtoms: 10n },
  ];

  test('crosses opposite obligations pro rata and routes only the net externally', () => {
    const result = netObligations(book, increments);
    assert.equal(result.version, 2);
    assert.deepEqual(
      result.allocations.map((item) => [item.userId, item.packageId, item.internalQuantityAtoms, item.externalQuantityAtoms]),
      [
        ['alice', 'pkg-1', 30n, 0n],
        ['bob', 'pkg-2', 10n, 10n],
        ['carol', 'pkg-3', -40n, 0n],
        ['dave', 'pkg-4', 0n, 10n],
      ],
    );
    assert.deepEqual(
      result.underlyings.map((item) => [item.underlyingId, item.internalMatchedAtoms, item.externalNetAtoms, item.quantityIncrementAtoms]),
      [
        ['eth', 0n, 10n, 5n],
        ['sol', 40n, 10n, 10n],
      ],
    );
    assert.equal(toHex(netObligations([...book].reverse(), [...increments].reverse()).proofHash), toHex(result.proofHash));
    verifyNettingResult(result);
    assert.notEqual(
      toHex(netObligations(book.map((item) => item.userId === 'alice' ? { ...item, packageId: 'pkg-other' } : item), increments).proofHash),
      toHex(result.proofHash),
    );
    assert.throws(() => verifyNettingResult({ ...result, proofHash: commitmentHash(new Uint8Array(32).fill(99)) }), /proof hash/);
  });

  test('tampering with any allocation breaks conservation', () => {
    const result = netObligations(book, increments);
    const alice = result.allocations[0]!;
    const rest = result.allocations.slice(1);
    const tampered = { ...alice, internalQuantityAtoms: 20n, externalQuantityAtoms: 10n };
    assert.throws(() => verifyNetting([tampered, ...rest], result.underlyings), /unbalanced/);
    const flipped = { ...alice, internalQuantityAtoms: 40n, externalQuantityAtoms: -10n };
    assert.throws(() => verifyNetting([flipped, ...rest], result.underlyings), /exceeds its obligation/);
    const [, bob, carol, dave] = result.allocations;
    const wrongPriority = [
      { ...alice!, internalQuantityAtoms: 20n, externalQuantityAtoms: 10n },
      { ...bob!, internalQuantityAtoms: 20n, externalQuantityAtoms: 0n },
      carol!,
      dave!,
    ];
    assert.throws(() => verifyNetting(wrongPriority, result.underlyings), /deterministic pro-rata/);
  });

  test('every netted underlying needs one summary recomputed from its allocations', () => {
    const result = netObligations(book, increments);
    assert.throws(() => verifyNetting(result.allocations, []), /has no summary/);
    assert.throws(() => verifyNetting(result.allocations, result.underlyings.slice(1)), /has no summary/);
    assert.throws(() => verifyNetting(result.allocations, [...result.underlyings, result.underlyings[0]!]), /canonically ordered|summarized twice/);
    const inflated = result.underlyings.map((summary) => ({ ...summary, grossBuyAtoms: summary.grossBuyAtoms + 5n, grossSellAtoms: summary.grossSellAtoms + 5n }));
    assert.throws(() => verifyNetting(result.allocations, inflated), /do not follow from the allocations/);
  });

  test('malformed obligation sets reject', () => {
    const solIncrement = [{ underlyingId: 'sol', quantityIncrementAtoms: 10n }];
    assert.throws(() => netObligations([obligation(1, 'alice', 15n)], solIncrement), /increment lattice/);
    assert.throws(() => netObligations([obligation(1, 'alice', 10n), obligation(1, 'bob', -10n)], solIncrement), /repeat/);
    assert.throws(() => netObligations([obligation(1, 'alice', 0n)], solIncrement), /zero/);
    assert.throws(() => netObligations([obligation(1, 'alice', 10n)], []), /no quantity increment/);
    assert.throws(() => netObligations([obligation(1, 'alice', 10n)], [...solIncrement, ...solIncrement]), /repeat/);
    assert.throws(() => netObligations([obligation(1, 'alice', 10n)], [...solIncrement, { underlyingId: 'eth', quantityIncrementAtoms: 1n }]), /every netted underlying/);
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
      const result = netObligations(obligations, [
        { underlyingId: 'eth', quantityIncrementAtoms: 5n },
        { underlyingId: 'sol', quantityIncrementAtoms: 5n },
      ].filter((increment) => obligations.some((item) => item.underlyingId === increment.underlyingId)));
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
