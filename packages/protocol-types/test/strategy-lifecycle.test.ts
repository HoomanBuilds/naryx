import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  adoptObservedBaseline,
  applyPackageStateTransition,
  assignInternal,
  delegateManagement,
  exitStrategy,
  mergeStrategies,
  moveLeg,
  novateStrategy,
  rebalanceStrategy,
  resizeStrategy,
  revokeDelegation,
  splitStrategy,
  strategyDiverges,
  strategyState,
  strategyStateHash,
  toHex,
  type StrategyState,
  type StrategyTransitionContext,
  type StrategyTransitionReceipt,
  type StrategyTransitionResult,
} from '../src/index.js';

const base: StrategyState = strategyState({
  version: 1,
  strategyId: 'carry-1',
  ownerId: 'owner',
  subaccountId: 'desk-a',
  seriesId: 'sol-cash-carry',
  executionClassId: 'sequenced-recoverable',
  open: true,
  stateVersion: 4n,
  legs: [
    { legId: 'spot', underlyingId: 'sol', instrumentId: 'sol-spot', venueId: 'solana', signedQuantityAtoms: 100n, lotAtoms: 10n, ratioNumerator: 1n, ratioDenominator: 1n },
    { legId: 'perp', underlyingId: 'sol', instrumentId: 'sol-perp', venueId: 'hyperliquid', signedQuantityAtoms: -100n, lotAtoms: 10n, ratioNumerator: -1n, ratioDenominator: 1n },
  ],
  liabilities: [{ liabilityId: 'loan', kind: 'MARGIN_LOAN', assetId: 'usdc', atoms: 5_000n, transferable: true }],
  delegations: [{ delegateId: 'bot', authorities: ['REBALANCE', 'ROLL', 'DECREASE', 'EXIT'], expiresAtValue: 1_000n }],
  venuePositionsTransferable: false,
  legalTransferRestricted: false,
});

const ctx = (state: StrategyState, actorId: string, atValue = 100n): StrategyTransitionContext => ({
  actorId,
  expectedStateVersion: state.stateVersion,
  expectedStateHash: strategyStateHash(state),
  atValue,
});

function accepted(result: StrategyTransitionResult): { states: readonly StrategyState[]; receipt: StrategyTransitionReceipt } {
  if (!result.accepted) assert.fail(`expected acceptance, got ${result.rejection}`);
  return result;
}

function rejected(result: StrategyTransitionResult): string {
  if (result.accepted) assert.fail('expected a rejection');
  return result.rejection;
}

const quantities = (state: StrategyState): Record<string, bigint> =>
  Object.fromEntries(state.legs.map((leg) => [leg.legId, leg.signedQuantityAtoms]));

describe('strategy state', () => {
  test('rejects malformed exposure, identities, and self delegation', () => {
    const leg = base.legs.find((value) => value.legId === 'spot') as StrategyState['legs'][number];
    assert.throws(() => strategyState({ ...base, legs: [{ ...leg, signedQuantityAtoms: 15n }] }), /lot lattice/);
    assert.throws(() => strategyState({ ...base, legs: [{ ...leg, signedQuantityAtoms: -10n }] }), /disagrees with the series ratio/);
    assert.throws(() => strategyState({ ...base, legs: [leg, leg] }), /repeat/);
    assert.throws(() => strategyState({ ...base, stateVersion: 0n }), /state version is zero/);
    assert.throws(
      () => strategyState({ ...base, delegations: [{ delegateId: 'owner', authorities: ['EXIT'], expiresAtValue: 5n }] }),
      /its own delegate/,
    );
    assert.throws(() => strategyState({ ...base, open: false }), /closed strategy keeps no exposure/);
  });

  test('state hash is order independent and binds every field', () => {
    const reordered = strategyState({ ...base, legs: [...base.legs].reverse() });
    assert.equal(toHex(strategyStateHash(reordered)), toHex(strategyStateHash(base)));
    assert.notEqual(toHex(strategyStateHash({ ...base, subaccountId: 'desk-b' })), toHex(strategyStateHash(base)));
  });
});

describe('authorization and staleness', () => {
  test('a stale version or hash rejects', () => {
    assert.equal(rejected(assignInternal(base, { ...ctx(base, 'owner'), expectedStateVersion: 3n }, 'desk-b')), 'STALE_STATE');
    const other = strategyStateHash({ ...base, subaccountId: 'desk-z' });
    assert.equal(rejected(assignInternal(base, { ...ctx(base, 'owner'), expectedStateHash: other }, 'desk-b')), 'STALE_STATE');
    const [moved] = accepted(assignInternal(base, ctx(base, 'owner'), 'desk-b')).states as [StrategyState];
    assert.equal(rejected(exitStrategy(moved, ctx(base, 'owner'))), 'STALE_STATE');
  });

  test('delegates hold only granted, unexpired, risk-reducing authority', () => {
    for (const result of [
      assignInternal(base, ctx(base, 'bot'), 'desk-b'),
      splitStrategy(base, ctx(base, 'bot'), { childStrategyIds: ['a', 'b'], firstShareBps: 5_000n }),
      novateStrategy(base, ctx(base, 'bot'), { newOwnerId: 'bot', consentingOwnerIds: ['owner', 'bot'], confirmingVenueIds: ['solana', 'hyperliquid'] }),
      resizeStrategy(base, ctx(base, 'bot'), { operation: 'INCREASE', changeBps: 1_000n }),
      adoptObservedBaseline(base, ctx(base, 'bot'), [{ legId: 'spot', signedQuantityAtoms: 90n }, { legId: 'perp', signedQuantityAtoms: -90n }]),
      exitStrategy(base, ctx(base, 'stranger')),
    ]) {
      assert.equal(rejected(result), 'UNAUTHORIZED');
    }
    accepted(resizeStrategy(base, ctx(base, 'bot'), { operation: 'DECREASE', changeBps: 5_000n }));
    assert.equal(rejected(exitStrategy(base, ctx(base, 'bot', 1_000n))), 'DELEGATION_EXPIRED');

    const [narrow] = accepted(
      delegateManagement(base, ctx(base, 'owner'), { delegateId: 'bot', authorities: ['REBALANCE'], expiresAtValue: 500n }),
    ).states as [StrategyState];
    assert.equal(narrow.delegations.length, 1);
    assert.equal(rejected(exitStrategy(narrow, ctx(narrow, 'bot'))), 'UNAUTHORIZED');
    const [revoked] = accepted(revokeDelegation(narrow, ctx(narrow, 'owner'), 'bot')).states as [StrategyState];
    assert.equal(revoked.delegations.length, 0);
    assert.throws(() => revokeDelegation(revoked, ctx(revoked, 'owner'), 'bot'), /no such delegation/);
  });

  test('ownership-moving authority cannot be delegated and delegations must be live', () => {
    assert.throws(
      () => delegateManagement(base, ctx(base, 'owner'), { delegateId: 'bot', authorities: ['NOVATE' as never], expiresAtValue: 500n }),
      /NOVATE/,
    );
    assert.throws(
      () => delegateManagement(base, ctx(base, 'owner'), { delegateId: 'bot', authorities: ['EXIT'], expiresAtValue: 100n }),
      /expire in the future/,
    );
  });
});

describe('internal transfer, split, and merge', () => {
  test('internal assignment moves no external position', () => {
    const { states, receipt } = accepted(assignInternal(base, ctx(base, 'owner'), 'desk-b'));
    const [next] = states as [StrategyState];
    assert.equal(next.subaccountId, 'desk-b');
    assert.equal(next.stateVersion, 5n);
    assert.deepEqual(quantities(next), quantities(base));
    assert.equal(receipt.externalPositionsMoved, false);
  });

  test('split conserves every leg and liability exactly', () => {
    const { states, receipt } = accepted(splitStrategy(base, ctx(base, 'owner'), { childStrategyIds: ['carry-1a', 'carry-1b'], firstShareBps: 3_333n }));
    const [first, second] = states as [StrategyState, StrategyState];
    assert.deepEqual(quantities(first), { perp: -30n, spot: 30n });
    assert.deepEqual(quantities(second), { perp: -70n, spot: 70n });
    assert.equal((first.liabilities[0]?.atoms ?? 0n) + (second.liabilities[0]?.atoms ?? 0n), 5_000n);
    // Liabilities follow the realized 30/70 exposure split, not the nominal 33.33 percent share.
    assert.deepEqual([first.liabilities[0]?.atoms, second.liabilities[0]?.atoms], [1_500n, 3_500n]);
    for (const child of [first, second]) {
      assert.equal(child.stateVersion, 1n);
      assert.equal(child.delegations.length, 0);
      assert.equal(child.ownerId, 'owner');
    }
    assert.equal(receipt.priorStateHashes.length, 1);
    assert.equal(receipt.nextStateHashes.length, 2);
    assert.equal(receipt.externalPositionsMoved, false);
    assert.equal(rejected(splitStrategy(base, ctx(base, 'owner'), { childStrategyIds: ['a', 'b'], firstShareBps: 50n })), 'SPLIT_TOO_SMALL');
    assert.throws(() => splitStrategy(base, ctx(base, 'owner'), { childStrategyIds: ['a', 'a'], firstShareBps: 5_000n }), /distinct/);
  });

  test('merge requires identical terms and restores the combined exposure', () => {
    const [first, second] = accepted(splitStrategy(base, ctx(base, 'owner'), { childStrategyIds: ['a', 'b'], firstShareBps: 4_000n })).states as [StrategyState, StrategyState];
    const { states, receipt } = accepted(mergeStrategies(first, second, [ctx(first, 'owner'), ctx(second, 'owner')], 'carry-2'));
    const [merged] = states as [StrategyState];
    assert.deepEqual(quantities(merged), quantities(base));
    assert.equal(merged.liabilities[0]?.atoms, 5_000n);
    assert.equal(receipt.priorStateHashes.length, 2);

    const [relabeled] = accepted(assignInternal(second, ctx(second, 'owner'), 'desk-b')).states as [StrategyState];
    assert.equal(rejected(mergeStrategies(first, relabeled, [ctx(first, 'owner'), ctx(relabeled, 'owner')], 'carry-2')), 'TERMS_DIFFER');
    assert.equal(rejected(mergeStrategies(first, second, [ctx(first, 'bot'), ctx(second, 'bot')], 'carry-2')), 'UNAUTHORIZED');
  });

  test('merge compares terms field by field, so separator characters cannot collide', () => {
    const leg = (underlyingId: string, instrumentId: string) => ({
      legId: 'x', underlyingId, instrumentId, venueId: 'v', signedQuantityAtoms: 10n, lotAtoms: 10n, ratioNumerator: 1n, ratioDenominator: 1n,
    });
    const shape = { ...base, legs: [leg('b|c', 'd')], liabilities: [], delegations: [] };
    const first = strategyState({ ...shape, strategyId: 's1' });
    const second = strategyState({ ...shape, strategyId: 's2', legs: [leg('b', 'c|d')] });
    assert.equal(rejected(mergeStrategies(first, second, [ctx(first, 'owner'), ctx(second, 'owner')], 's3')), 'TERMS_DIFFER');
  });
});

describe('novation', () => {
  const transferable = strategyState({ ...base, venuePositionsTransferable: true });
  const full = { newOwnerId: 'buyer', consentingOwnerIds: ['owner', 'buyer'], confirmingVenueIds: ['solana', 'hyperliquid'] };

  test('non-transferable positions or liabilities direct the owner to exit and re-enter', () => {
    for (const state of [
      base,
      strategyState({ ...transferable, legalTransferRestricted: true }),
      strategyState({ ...transferable, liabilities: [{ ...(base.liabilities[0] as StrategyState['liabilities'][number]), transferable: false }] }),
    ]) {
      const result = novateStrategy(state, ctx(state, 'owner'), full);
      assert.deepEqual(result, { accepted: false, rejection: 'NOT_TRANSFERABLE', remedy: 'EXIT_AND_REENTER' });
    }
  });

  test('needs both consents and every venue confirmation, then clears delegations', () => {
    assert.equal(rejected(novateStrategy(transferable, ctx(transferable, 'owner'), { ...full, consentingOwnerIds: ['owner'] })), 'CONSENT_MISSING');
    assert.equal(
      rejected(novateStrategy(transferable, ctx(transferable, 'owner'), { ...full, confirmingVenueIds: ['solana'] })),
      'VENUE_CONFIRMATION_MISSING',
    );
    const { states, receipt } = accepted(novateStrategy(transferable, ctx(transferable, 'owner'), full));
    const [next] = states as [StrategyState];
    assert.equal(next.ownerId, 'buyer');
    assert.equal(next.delegations.length, 0);
    assert.deepEqual(quantities(next), quantities(base));
    assert.equal(receipt.externalPositionsMoved, true);
    assert.equal(rejected(exitStrategy(next, ctx(next, 'bot'))), 'UNAUTHORIZED');
  });
});

describe('roll, migration, rebalance, and resize', () => {
  test('a roll stays on its venue; a migration is owner-only and respects the new lot', () => {
    const roll = { operation: 'ROLL' as const, legId: 'perp', newLegId: 'perp-2', newInstrumentId: 'sol-perp-next', newVenueId: 'hyperliquid', newLotAtoms: 10n };
    const [rolled] = accepted(moveLeg(base, ctx(base, 'bot'), roll)).states as [StrategyState];
    assert.deepEqual(quantities(rolled), { 'perp-2': -100n, spot: 100n });
    assert.equal(rolled.legs.find((leg) => leg.legId === 'perp-2')?.instrumentId, 'sol-perp-next');
    assert.throws(() => moveLeg(base, ctx(base, 'bot'), { ...roll, newVenueId: 'arbitrum' }), /stays on its venue/);

    const migrate = { ...roll, operation: 'MIGRATE' as const, newVenueId: 'arbitrum', newLotAtoms: 20n };
    assert.equal(rejected(moveLeg(base, ctx(base, 'bot'), migrate)), 'UNAUTHORIZED');
    const { states, receipt } = accepted(moveLeg(base, ctx(base, 'owner'), migrate));
    assert.equal((states[0] as StrategyState).legs.find((leg) => leg.legId === 'perp-2')?.venueId, 'arbitrum');
    assert.equal(receipt.externalPositionsMoved, true);
    assert.throws(() => moveLeg(base, ctx(base, 'owner'), { ...migrate, newLotAtoms: 30n }), /lot lattice/);
  });

  test('rebalance keeps the ratio, direction, and per-leg bound', () => {
    const target = (spot: bigint, perp: bigint, bound = 20n) => [
      { legId: 'spot', signedQuantityAtoms: spot, maximumChangeAtoms: bound },
      { legId: 'perp', signedQuantityAtoms: perp, maximumChangeAtoms: bound },
    ];
    const [next] = accepted(rebalanceStrategy(base, ctx(base, 'owner'), target(120n, -120n))).states as [StrategyState];
    assert.deepEqual(quantities(next), { perp: -120n, spot: 120n });
    const [smaller] = accepted(rebalanceStrategy(base, ctx(base, 'bot'), target(90n, -90n))).states as [StrategyState];
    assert.deepEqual(quantities(smaller), { perp: -90n, spot: 90n });
    assert.equal(rejected(rebalanceStrategy(base, ctx(base, 'bot'), target(120n, -110n))), 'RATIO_BROKEN');
    assert.equal(rejected(rebalanceStrategy(base, ctx(base, 'bot'), target(100n, 10n, 200n))), 'DIRECTION_FLIP');
    assert.equal(rejected(rebalanceStrategy(base, ctx(base, 'owner'), target(150n, -150n))), 'CHANGE_EXCEEDS_BOUND');
  });

  test('a rebalance delegate cannot grow exposure with a self-supplied change bound', () => {
    const huge = (2n ** 128n) - 1n;
    const targets = [
      { legId: 'spot', signedQuantityAtoms: 100_000n, maximumChangeAtoms: huge },
      { legId: 'perp', signedQuantityAtoms: -100_000n, maximumChangeAtoms: huge },
    ];
    assert.equal(rejected(rebalanceStrategy(base, ctx(base, 'bot'), targets)), 'UNAUTHORIZED');
    assert.equal(rejected(resizeStrategy(base, ctx(base, 'bot'), { operation: 'INCREASE', changeBps: 5_000n })), 'UNAUTHORIZED');
  });

  test('resize scales every leg and rejects a change that breaks the ratio', () => {
    const [smaller] = accepted(resizeStrategy(base, ctx(base, 'bot'), { operation: 'DECREASE', changeBps: 5_000n })).states as [StrategyState];
    assert.deepEqual(quantities(smaller), { perp: -50n, spot: 50n });
    assert.equal(smaller.liabilities[0]?.atoms, 2_500n);
    const [larger] = accepted(resizeStrategy(base, ctx(base, 'owner'), { operation: 'INCREASE', changeBps: 5_000n })).states as [StrategyState];
    assert.deepEqual(quantities(larger), { perp: -150n, spot: 150n });
    assert.equal(larger.liabilities[0]?.atoms, 7_500n);
    assert.throws(() => resizeStrategy(base, ctx(base, 'owner'), { operation: 'DECREASE', changeBps: 10_000n }), /use exit/);
    assert.equal(rejected(resizeStrategy(base, ctx(base, 'owner'), { operation: 'DECREASE', changeBps: 50n })), 'CHANGE_BELOW_LOT');

    const uneven = strategyState({
      ...base,
      legs: [
        { legId: 'spot', underlyingId: 'sol', instrumentId: 'sol-spot', venueId: 'solana', signedQuantityAtoms: 100n, lotAtoms: 10n, ratioNumerator: 2n, ratioDenominator: 1n },
        { legId: 'perp', underlyingId: 'sol', instrumentId: 'sol-perp', venueId: 'hyperliquid', signedQuantityAtoms: -50n, lotAtoms: 25n, ratioNumerator: -1n, ratioDenominator: 1n },
      ],
    });
    accepted(resizeStrategy(uneven, ctx(uneven, 'owner'), { operation: 'DECREASE', changeBps: 5_000n }));
    assert.equal(rejected(resizeStrategy(uneven, ctx(uneven, 'owner'), { operation: 'DECREASE', changeBps: 6_000n })), 'RATIO_BROKEN');
  });

  test('a settled package can replace a liability only through an owner-authorized migration', () => {
    const refinanced = {
      ...base,
      stateVersion: base.stateVersion + 1n,
      liabilities: [{ liabilityId: 'fixed-loan', kind: 'BORROW' as const, assetId: 'usdc', atoms: 4_500n, transferable: true }],
    };
    const [next] = accepted(applyPackageStateTransition(base, ctx(base, 'owner'), 'MIGRATE', refinanced)).states as [StrategyState];
    assert.deepEqual(next.liabilities.map((liability) => [liability.liabilityId, liability.atoms]), [['fixed-loan', 4_500n]]);
    assert.equal(rejected(applyPackageStateTransition(base, ctx(base, 'bot'), 'MIGRATE', refinanced)), 'UNAUTHORIZED');
    assert.throws(
      () => applyPackageStateTransition(base, ctx(base, 'owner'), 'MIGRATE', {
        ...refinanced,
        liabilities: [{ ...base.liabilities[0]!, kind: 'BORROW' }],
      }),
      /new liability identity/,
    );
  });

  test('settled quantity changes may refine but never widen the accounting lot', () => {
    const refined = strategyState({
      ...base,
      stateVersion: base.stateVersion + 1n,
      legs: base.legs.map((leg) => ({
        ...leg,
        signedQuantityAtoms: leg.signedQuantityAtoms > 0n ? 125n : -125n,
        lotAtoms: 5n,
      })),
    });
    accepted(applyPackageStateTransition(base, ctx(base, 'owner'), 'INCREASE', refined));
    const widened = strategyState({
      ...base,
      stateVersion: base.stateVersion + 1n,
      legs: base.legs.map((leg) => ({
        ...leg,
        signedQuantityAtoms: leg.signedQuantityAtoms > 0n ? 120n : -120n,
        lotAtoms: 20n,
      })),
    });
    assert.throws(() => applyPackageStateTransition(base, ctx(base, 'owner'), 'INCREASE', widened), /changed leg terms/);
  });
});

describe('exit and external divergence', () => {
  test('exit keeps an unsettled liability visible on the closed strategy', () => {
    const { states, receipt } = accepted(exitStrategy(base, ctx(base, 'bot')));
    const [closed] = states as [StrategyState];
    assert.equal(closed.open, false);
    assert.deepEqual(closed.liabilities.map((liability) => [liability.liabilityId, liability.atoms]), [['loan', 5_000n]]);
    assert.equal(receipt.liabilitySettlements.length, 0);
    assert.throws(() => exitStrategy(base, ctx(base, 'bot'), [{ liabilityId: 'loan', settledAtoms: 4_999n, evidenceHash: new Uint8Array(32).fill(3) }]), /full liability/);
    assert.throws(() => exitStrategy(base, ctx(base, 'bot'), [{ liabilityId: 'other', settledAtoms: 1n, evidenceHash: new Uint8Array(32).fill(3) }]), /no such liability/);
  });

  test('exit closes every leg and settled liability, then nothing else is accepted', () => {
    const settlement = { liabilityId: 'loan', settledAtoms: 5_000n, evidenceHash: new Uint8Array(32).fill(3) };
    const { states, receipt } = accepted(exitStrategy(base, ctx(base, 'bot'), [settlement]));
    const [closed] = states as [StrategyState];
    assert.equal(closed.open, false);
    assert.deepEqual(quantities(closed), { perp: 0n, spot: 0n });
    assert.equal(closed.liabilities.length, 0);
    assert.equal(receipt.liabilitySettlements[0]?.settledAtoms, 5_000n);
    const unsettledReceipt = accepted(exitStrategy(base, ctx(base, 'bot'))).receipt;
    assert.notEqual(toHex(receipt.receiptHash), toHex(unsettledReceipt.receiptHash));
    assert.equal(closed.delegations.length, 0);
    assert.equal(receipt.externalPositionsMoved, true);
    assert.equal(rejected(assignInternal(closed, ctx(closed, 'owner'), 'desk-b')), 'STRATEGY_CLOSED');
    assert.equal(rejected(exitStrategy(closed, ctx(closed, 'owner'))), 'STRATEGY_CLOSED');
  });

  test('observed divergence stops automation until the owner adopts a new baseline', () => {
    const observed = [{ legId: 'spot', signedQuantityAtoms: 100n }, { legId: 'perp', signedQuantityAtoms: -90n }];
    assert.equal(strategyDiverges(base, [{ legId: 'spot', signedQuantityAtoms: 100n }, { legId: 'perp', signedQuantityAtoms: -100n }]), false);
    assert.equal(strategyDiverges(base, observed), true);
    assert.equal(strategyDiverges(base, observed.slice(0, 1)), true);

    const prepared = ctx(base, 'bot');
    const { states, receipt } = accepted(adoptObservedBaseline(base, ctx(base, 'owner'), observed));
    const [adopted] = states as [StrategyState];
    assert.equal(strategyDiverges(adopted, observed), false);
    assert.equal(receipt.externalPositionsMoved, false);
    assert.equal(rejected(exitStrategy(adopted, prepared)), 'STALE_STATE');
    accepted(exitStrategy(adopted, ctx(adopted, 'bot')));
  });
});

describe('transition receipts', () => {
  test('bind operation, actor, prior and next states, and time deterministically', () => {
    const first = accepted(assignInternal(base, ctx(base, 'owner'), 'desk-b')).receipt;
    const again = accepted(assignInternal(base, ctx(base, 'owner'), 'desk-b')).receipt;
    const later = accepted(assignInternal(base, ctx(base, 'owner', 101n), 'desk-b')).receipt;
    assert.equal(toHex(first.receiptHash), toHex(again.receiptHash));
    assert.notEqual(toHex(first.receiptHash), toHex(later.receiptHash));
    assert.equal(toHex(first.priorStateHashes[0] as Uint8Array), toHex(strategyStateHash(base)));
    assert.equal(first.operation, 'ASSIGN_INTERNAL');
    assert.equal(first.actorId, 'owner');
  });
});
