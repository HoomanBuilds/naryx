import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  EMPTY_RECOVERY_RESERVE,
  assetRef,
  commitmentHash,
  compressPackageLegs,
  domainRef,
  fundRecoveryReserve,
  netObligations,
  nettingPolicyManifest,
  recoveryReserveAvailable,
  reserveRecoveryCapital,
  settleRecoveryClaim,
  toHex,
  verifyNetting,
  verifyNettingResult,
  verifyNettingResultAgainstPolicy,
  versionedManifestRef,
  type NettingObligationInput,
  type NettingPolicyManifestInput,
} from '../src/index.js';

const id = (n: number): string => n.toString(16).padStart(64, '0');

function instrument(instrumentId: string, hashSeed: number, quantityIncrementAtoms: bigint) {
  return {
    instrumentId,
    domain: domainRef(`svm:${instrumentId}`, 1, id(hashSeed)),
    adapter: {
      adapterId: `adapter-${instrumentId}`,
      adapterManifestVersion: 1,
      adapterManifestHash: id(hashSeed + 1),
    },
    venue: versionedManifestRef(`venue-${instrumentId}`, 1, id(hashSeed + 2)),
    market: versionedManifestRef(`market-${instrumentId}`, 1, id(hashSeed + 3)),
    quantityAsset: assetRef(`asset-${instrumentId}`, id(hashSeed + 4), 6),
    quoteAsset: assetRef('usdc', id(99), 6),
    legFamily: 'PERP_OPEN' as const,
    quantityIncrementAtoms,
    priceTickQuoteAtoms: 1n,
  };
}

function policy(
  solIncrement = 10n,
  ethIncrement = 5n,
  overrides: Partial<NettingPolicyManifestInput> = {},
): NettingPolicyManifestInput {
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    nettingPolicyVersion: 2,
    environment: 'testnet',
    executionClassId: 'cross-user-netting-v1',
    executionClassVersion: 1,
    executionClassManifestHash: id(80),
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
    allocationRule: 'PRO_RATA_SEQUENCE',
    externalExecutionMode: 'EXACT_NET_ONLY',
    clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
    maximumObligations: 32,
    maximumBatchWindowMilliseconds: 500n,
    instruments: [instrument('sol', 10, solIncrement), instrument('eth', 20, ethIncrement)],
    ...overrides,
  };
}

const obligation = (
  n: number,
  ownerId: string,
  quantity: bigint,
  instrumentId = 'sol',
  limitPriceTicks = quantity > 0n ? 12n : 8n,
): NettingObligationInput => ({
  ownerId,
  strategyOrderHash: id(100 + n),
  packageOrderId: id(200 + n),
  settlementReadinessHash: id(300 + n),
  legId: `leg-${n}`,
  instrumentId,
  signedQuantityAtoms: quantity,
  limitPriceTicks,
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
  const book = [
    obligation(1, 'alice', 30n),
    obligation(2, 'bob', 20n),
    obligation(3, 'carol', -40n),
    obligation(4, 'dave', 10n, 'eth'),
  ];
  const nettingPolicy = policy();

  test('crosses exact instruments and routes only the net externally', () => {
    const result = netObligations(book, nettingPolicy);
    assert.equal(result.version, 4);
    assert.deepEqual(
      result.allocations.map((item) => [item.ownerId, item.legId, item.internalQuantityAtoms, item.externalQuantityAtoms]),
      [
        ['alice', 'leg-1', 30n, 0n],
        ['bob', 'leg-2', 10n, 10n],
        ['carol', 'leg-3', -40n, 0n],
        ['dave', 'leg-4', 0n, 10n],
      ],
    );
    assert.deepEqual(
      result.allocations.map((item) => [item.ownerId, item.internalQuoteDeltaAtoms]),
      [['alice', -30n], ['bob', -10n], ['carol', 40n], ['dave', 0n]],
    );
    assert.deepEqual(
      result.underlyings.map((item) => [item.instrumentId, item.internalClearingPriceTicks, item.externalLimitPriceTicks, item.internalQuoteAtoms]),
      [['eth', undefined, 12n, 0n], ['sol', 10n, 12n, 40n]],
    );
    assert.deepEqual(
      result.underlyings.map((item) => [item.instrumentId, item.internalMatchedAtoms, item.externalNetAtoms, item.quantityIncrementAtoms]),
      [
        ['eth', 0n, 10n, 5n],
        ['sol', 40n, 10n, 10n],
      ],
    );
    const reversedPolicy = { ...nettingPolicy, instruments: [...nettingPolicy.instruments].reverse() };
    assert.equal(toHex(netObligations([...book].reverse(), reversedPolicy).proofHash), toHex(result.proofHash));
    verifyNettingResult(result);
    verifyNettingResultAgainstPolicy(result, nettingPolicy);
    assert.notEqual(
      toHex(netObligations(book.map((item) => item.ownerId === 'alice' ? { ...item, packageOrderId: id(999) } : item), nettingPolicy).proofHash),
      toHex(result.proofHash),
    );
    assert.throws(() => verifyNettingResult({ ...result, proofHash: commitmentHash(new Uint8Array(32).fill(99)) }), /proof hash/);
  });

  test('tampering with an allocation or its signed source identity rejects', () => {
    const result = netObligations(book, nettingPolicy);
    const alice = result.allocations[0]!;
    const rest = result.allocations.slice(1);
    const tampered = { ...alice, internalQuantityAtoms: 20n, externalQuantityAtoms: 10n };
    assert.throws(() => verifyNetting(result.nettingPolicyHash, [tampered, ...rest], result.underlyings), /unbalanced/);
    const flipped = { ...alice, internalQuantityAtoms: 40n, externalQuantityAtoms: -10n };
    assert.throws(() => verifyNetting(result.nettingPolicyHash, [flipped, ...rest], result.underlyings), /exceeds its obligation/);
    assert.throws(
      () => verifyNetting(result.nettingPolicyHash, [{ ...alice, strategyOrderHash: commitmentHash(id(999)) }, ...rest], result.underlyings),
      /obligation id/,
    );
    assert.throws(
      () => verifyNetting(result.nettingPolicyHash, [{ ...alice, internalQuoteDeltaAtoms: -29n }, ...rest], result.underlyings),
      /unbalanced|does not follow/,
    );
    const [, bob, carol, dave] = result.allocations;
    const wrongPriority = [
      { ...alice, internalQuantityAtoms: 20n, externalQuantityAtoms: 10n },
      { ...bob!, internalQuantityAtoms: 20n, externalQuantityAtoms: 0n },
      carol!,
      dave!,
    ];
    assert.throws(() => verifyNetting(result.nettingPolicyHash, wrongPriority, result.underlyings), /deterministic pro-rata/);
  });

  test('every netted instrument needs one exact summary', () => {
    const result = netObligations(book, nettingPolicy);
    assert.throws(() => verifyNetting(result.nettingPolicyHash, result.allocations, []), /has no summary/);
    assert.throws(() => verifyNetting(result.nettingPolicyHash, result.allocations, result.underlyings.slice(1)), /has no summary/);
    assert.throws(
      () => verifyNetting(result.nettingPolicyHash, result.allocations, [...result.underlyings, result.underlyings[0]!]),
      /canonically ordered|summarized twice/,
    );
    const inflated = result.underlyings.map((summary) => ({
      ...summary,
      grossBuyAtoms: summary.grossBuyAtoms + 5n,
      grossSellAtoms: summary.grossSellAtoms + 5n,
    }));
    assert.throws(() => verifyNetting(result.nettingPolicyHash, result.allocations, inflated), /do not follow from the allocations/);
  });

  test('malformed or unauthorized obligation sets reject', () => {
    assert.throws(() => netObligations([obligation(1, 'alice', 15n)], nettingPolicy), /increment lattice/);
    assert.throws(() => netObligations([obligation(1, 'alice', 10n), obligation(1, 'alice', 10n)], nettingPolicy), /repeat/);
    assert.throws(() => netObligations([obligation(1, 'alice', 0n)], nettingPolicy), /zero/);
    assert.throws(() => netObligations([obligation(1, 'alice', 10n, 'btc')], nettingPolicy), /not permitted/);
    assert.throws(
      () => netObligations([obligation(1, 'alice', 10n), { ...obligation(2, 'bob', -10n), sequence: 1n }], nettingPolicy),
      /sequences repeat/,
    );
    assert.throws(
      () => netObligations([obligation(1, 'alice', 10n), obligation(2, 'bob', -10n)], policy(10n, 5n, { maximumObligations: 1 })),
      /policy maximum/,
    );
    assert.throws(
      () => netObligations([obligation(1, 'alice', 10n, 'sol', 7n), obligation(2, 'bob', -10n, 'sol', 8n)], nettingPolicy),
      /limits do not overlap/,
    );
  });

  test('a seeded run conserves every obligation, side, and instrument', () => {
    let seed = 7n;
    const next = (modulus: bigint): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      return (seed >> 33n) % modulus;
    };
    const seededPolicy = policy(5n, 5n);
    for (let round = 0; round < 50; round += 1) {
      const count = Number(next(12n)) + 1;
      const obligations = Array.from({ length: count }, (_, index) => {
        const size = (next(9n) + 1n) * 5n;
        return obligation(index + 1, `u-${next(4n)}`, next(2n) === 0n ? size : -size, next(2n) === 0n ? 'sol' : 'eth');
      });
      const result = netObligations(obligations, seededPolicy);
      verifyNetting(result.nettingPolicyHash, result.allocations, result.underlyings);
      for (const item of result.allocations) assert.equal(item.internalQuantityAtoms % 5n, 0n);
    }
  });

  test('a proof is bound to the complete netting policy', () => {
    const result = netObligations(book, nettingPolicy);
    const changed = nettingPolicyManifest({ ...nettingPolicy, maximumBatchWindowMilliseconds: 750n });
    assert.throws(() => verifyNettingResultAgainstPolicy(result, changed), /another netting policy/);
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
