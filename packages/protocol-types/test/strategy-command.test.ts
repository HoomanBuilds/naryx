import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyStrategyCommand,
  strategyCommandHash,
  strategyCommandSubjects,
  strategyExecutionMatches,
  strategyState,
  strategyStateHash,
  toHex,
  type PackageReceiptInput,
  type StrategyCommandInput,
  type StrategyState,
} from '../src/index.js';

const opened: StrategyState = strategyState({
  version: 1,
  strategyId: 'strategy-1',
  ownerId: 'owner-1',
  subaccountId: 'desk-1',
  seriesId: 'sol-cash-carry',
  executionClassId: 'sequenced-recoverable',
  open: true,
  stateVersion: 1n,
  legs: [
    { legId: 'spot', underlyingId: 'sol', instrumentId: 'sol-spot', venueId: 'solana', signedQuantityAtoms: 100n, lotAtoms: 10n, ratioNumerator: 1n, ratioDenominator: 1n },
    { legId: 'perp', underlyingId: 'sol', instrumentId: 'sol-perp', venueId: 'hyperliquid', signedQuantityAtoms: -100n, lotAtoms: 10n, ratioNumerator: -1n, ratioDenominator: 1n },
  ],
  liabilities: [],
  delegations: [],
  venuePositionsTransferable: false,
  legalTransferRestricted: false,
});

const command = (parameters: StrategyCommandInput['parameters'], overrides: Partial<StrategyCommandInput> = {}): StrategyCommandInput => ({
  commandVersion: 1,
  environment: 'testnet',
  strategyId: 'strategy-1',
  actorId: 'owner-1',
  expectedStateVersion: 1n,
  expectedStateHash: strategyStateHash(opened),
  atValue: 1_790_000_000_000n,
  parameters,
  ...overrides,
});

describe('strategy commands', () => {
  test('the command hash matches an independent encoding and binds every term', () => {
    const assign = command({ kind: 'ASSIGN_INTERNAL', subaccountId: 'desk-2' }, { expectedStateHash: 'ab'.repeat(32) });
    // sha256("CON/v1/strategy-command" || u32 1 || "testnet" || "strategy-1" || "owner-1" || u64 1 || hash || u64 at || u8 2 || "desk-2")
    assert.equal(toHex(strategyCommandHash(assign)), '2c460f72d193a414fb741352d1b32fc30408cfac863c2163fe43a756d84b110c');
    const base = toHex(strategyCommandHash(assign));
    for (const change of [{ environment: 'devnet' }, { strategyId: 'strategy-2' }, { actorId: 'owner-2' }, { expectedStateVersion: 2n }, { atValue: 1n }, { parameters: { kind: 'ASSIGN_INTERNAL' as const, subaccountId: 'desk-3' } }]) {
      assert.notEqual(toHex(strategyCommandHash({ ...assign, ...change })), base);
    }
  });

  test('opening binds no prior state and yields the signer-owned state at version one', () => {
    const open = command({ kind: 'OPEN', originReceiptHash: '11'.repeat(32), state: opened }, { expectedStateVersion: 0n, expectedStateHash: '00'.repeat(32) });
    const outcome = applyStrategyCommand(open, new Map());
    assert.equal(outcome.kind, 'OPENED');
    assert.throws(() => strategyCommandHash({ ...open, expectedStateVersion: 1n }), /version zero/);
    assert.throws(() => applyStrategyCommand({ ...open, actorId: 'owner-2' }, new Map()), /owned by its signer/);
    assert.throws(() => applyStrategyCommand(command({ kind: 'OPEN', originReceiptHash: '11'.repeat(32), state: { ...opened, stateVersion: 2n } }, { expectedStateVersion: 0n, expectedStateHash: '00'.repeat(32) }), new Map()), /version one/);
  });

  test('transitions run through the kernel rules and bind the exact prior state', () => {
    const states = new Map([['strategy-1', opened]]);
    const delegate = applyStrategyCommand(command({ kind: 'DELEGATE', delegateId: 'bot-1', authorities: ['EXIT', 'REBALANCE'], expiresAtValue: 1_800_000_000_000n }), states);
    assert.ok(delegate.kind === 'TRANSITIONED' && delegate.result.accepted);
    assert.deepEqual(delegate.result.states[0]?.delegations[0]?.authorities, ['REBALANCE', 'EXIT']);
    const stale = applyStrategyCommand(command({ kind: 'ASSIGN_INTERNAL', subaccountId: 'desk-2' }, { expectedStateVersion: 2n }), states);
    assert.ok(stale.kind === 'TRANSITIONED' && !stale.result.accepted && stale.result.rejection === 'STALE_STATE');
    const outsider = applyStrategyCommand(command({ kind: 'SPLIT', childStrategyIds: ['strategy-1a', 'strategy-1b'], firstShareBps: 5_000n }, { actorId: 'bot-1' }), states);
    assert.ok(outsider.kind === 'TRANSITIONED' && !outsider.result.accepted && outsider.result.rejection === 'UNAUTHORIZED');
    const split = applyStrategyCommand(command({ kind: 'SPLIT', childStrategyIds: ['strategy-1a', 'strategy-1b'], firstShareBps: 5_000n }), states);
    assert.ok(split.kind === 'TRANSITIONED' && split.result.accepted && split.result.states.length === 2);
    assert.throws(() => applyStrategyCommand(command({ kind: 'MERGE', otherStrategyId: 'strategy-9', otherExpectedStateVersion: 1n, otherExpectedStateHash: '22'.repeat(32), mergedStrategyId: 'strategy-m' }), states), /no such strategy/);
    assert.deepEqual(strategyCommandSubjects(command({ kind: 'MERGE', otherStrategyId: 'strategy-9', otherExpectedStateVersion: 1n, otherExpectedStateHash: '22'.repeat(32), mergedStrategyId: 'strategy-m' })), ['strategy-1', 'strategy-9']);
    assert.throws(() => strategyCommandHash(command({ kind: 'DELEGATE', delegateId: 'bot-1', authorities: ['EXIT', 'EXIT'], expiresAtValue: 1n })), /repeat/);
  });
  test('position moves bind settled receipts whose per-venue deltas are exactly the change', () => {
    const states = new Map([['strategy-1', opened]]);
    const receipt = (overrides: Partial<PackageReceiptInput>) => ({
      terminalState: 'FINALIZED_COMPLETE', owner: 'owner-1', packageMarketId: 'sequenced-recoverable', action: 'EXIT',
      spotVenue: 'solana', perpVenue: 'hyperliquid', netSpotDelta: -50n, perpPositionDelta: 50n, ...overrides,
    }) as unknown as PackageReceiptInput;
    const decrease = command({ kind: 'DECREASE', changeBps: 5_000n, executionReceiptHashes: ['21'.repeat(32)] });
    const outcome = applyStrategyCommand(decrease, states);
    assert.ok(outcome.kind === 'TRANSITIONED' && outcome.result.accepted);
    const next = outcome.result.states[0] as StrategyState;
    assert.equal(outcome.result.receipt.externalPositionsMoved, true);
    assert.deepEqual(strategyExecutionMatches('DECREASE', opened, next, [receipt({})]), { matches: true });
    assert.deepEqual(strategyExecutionMatches('DECREASE', opened, next, [receipt({ netSpotDelta: -40n })]), { matches: false, mismatch: 'EXECUTION_MISMATCH' });
    assert.deepEqual(strategyExecutionMatches('DECREASE', opened, next, [receipt({ action: 'ENTRY' })]), { matches: false, mismatch: 'RECEIPT_ACTION_MISMATCH' });
    assert.deepEqual(strategyExecutionMatches('DECREASE', opened, next, [receipt({ owner: 'owner-2' })]), { matches: false, mismatch: 'RECEIPT_OWNER_MISMATCH' });
    assert.deepEqual(strategyExecutionMatches('DECREASE', opened, next, [receipt({ terminalState: 'RECOVERED_FLAT' })]), { matches: false, mismatch: 'RECEIPT_NOT_SETTLED' });
    assert.deepEqual(strategyExecutionMatches('DECREASE', opened, next, [receipt({ packageMarketId: 'other' })]), { matches: false, mismatch: 'RECEIPT_MARKET_MISMATCH' });
    assert.deepEqual(strategyExecutionMatches('DECREASE', opened, next, []), { matches: false, mismatch: 'EXECUTION_MISMATCH' });

    // A migration closes the leg on one venue and opens it on another; the totals balance per venue.
    const migrate = applyStrategyCommand(command({ kind: 'MIGRATE', legId: 'perp', newLegId: 'perp-base', newInstrumentId: 'sol-perp-base', newVenueId: 'base', newLotAtoms: 10n, executionReceiptHashes: ['22'.repeat(32), '23'.repeat(32)] }), states);
    assert.ok(migrate.kind === 'TRANSITIONED' && migrate.result.accepted);
    const moved = migrate.result.states[0] as StrategyState;
    const close = receipt({ netSpotDelta: 0n, perpPositionDelta: 100n });
    const reopen = receipt({ action: 'ENTRY', netSpotDelta: 0n, perpVenue: 'base', perpPositionDelta: -100n, packageMarketId: 'base-market' });
    assert.deepEqual(strategyExecutionMatches('MIGRATE', opened, moved, [close, reopen]), { matches: true });
    assert.deepEqual(strategyExecutionMatches('MIGRATE', opened, moved, [close]), { matches: false, mismatch: 'EXECUTION_MISMATCH' });
    assert.deepEqual(strategyExecutionMatches('MIGRATE', opened, moved, [receipt({ netSpotDelta: 0n, perpPositionDelta: 100n, packageMarketId: 'hl-market' }), reopen]), { matches: false, mismatch: 'RECEIPT_MARKET_MISMATCH' });
    // A roll nets to zero per venue, so it must show the exact close and reopen, not any zero-sum pair.
    const roll = applyStrategyCommand(command({ kind: 'ROLL', legId: 'perp', newLegId: 'perp-next', newInstrumentId: 'sol-perp-next', newVenueId: 'hyperliquid', newLotAtoms: 10n, executionReceiptHashes: ['25'.repeat(32), '26'.repeat(32)] }), states);
    assert.ok(roll.kind === 'TRANSITIONED' && roll.result.accepted);
    const rolled = roll.result.states[0] as StrategyState;
    const unrelatedEntry = receipt({ action: 'ENTRY', netSpotDelta: 7n, perpPositionDelta: -7n, spotVenue: 'orca', perpVenue: 'drift', packageMarketId: 'other' });
    const unrelatedExit = receipt({ netSpotDelta: -7n, perpPositionDelta: 7n, spotVenue: 'orca', perpVenue: 'drift' });
    assert.deepEqual(strategyExecutionMatches('ROLL', opened, rolled, [unrelatedEntry, unrelatedExit]), { matches: false, mismatch: 'EXECUTION_MISMATCH' });
    const rollExit = receipt({ netSpotDelta: 0n, perpPositionDelta: 100n });
    const rollEntry = receipt({ action: 'ENTRY', netSpotDelta: 0n, perpPositionDelta: -100n, packageMarketId: 'next-market' });
    assert.deepEqual(strategyExecutionMatches('ROLL', opened, rolled, [rollExit, rollEntry]), { matches: true });
    // Two legs on one venue make a per-venue delta ambiguous, so it is refused.
    const shared = strategyState({ ...opened, legs: opened.legs.map((leg) => ({ ...leg, venueId: 'hyperliquid' })) });
    assert.deepEqual(strategyExecutionMatches('DECREASE', shared, shared, [receipt({ spotVenue: 'hyperliquid-spot' })]), { matches: false, mismatch: 'EXECUTION_AMBIGUOUS' });

    // An exit zeroes every leg and closes the strategy.
    const exit = applyStrategyCommand(command({ kind: 'EXIT', settlements: [], executionReceiptHashes: ['24'.repeat(32)] }), states);
    assert.ok(exit.kind === 'TRANSITIONED' && exit.result.accepted && exit.result.states[0]?.open === false);
    assert.deepEqual(strategyExecutionMatches('EXIT', opened, exit.result.states[0] as StrategyState, [receipt({ netSpotDelta: -100n, perpPositionDelta: 100n })]), { matches: true });

    // Receipt order does not change the command hash; the receipt set does.
    const one = strategyCommandHash(command({ kind: 'MIGRATE', legId: 'perp', newLegId: 'p', newInstrumentId: 'i', newVenueId: 'base', newLotAtoms: 10n, executionReceiptHashes: ['22'.repeat(32), '23'.repeat(32)] }));
    const two = strategyCommandHash(command({ kind: 'MIGRATE', legId: 'perp', newLegId: 'p', newInstrumentId: 'i', newVenueId: 'base', newLotAtoms: 10n, executionReceiptHashes: ['23'.repeat(32), '22'.repeat(32)] }));
    const three = strategyCommandHash(command({ kind: 'MIGRATE', legId: 'perp', newLegId: 'p', newInstrumentId: 'i', newVenueId: 'base', newLotAtoms: 10n, executionReceiptHashes: ['23'.repeat(32)] }));
    assert.equal(toHex(one), toHex(two));
    assert.notEqual(toHex(one), toHex(three));
    assert.throws(() => strategyCommandHash(command({ kind: 'DECREASE', changeBps: 1n, executionReceiptHashes: [] })), /1 to 8/);
    assert.throws(() => strategyCommandHash(command({ kind: 'DECREASE', changeBps: 1n, executionReceiptHashes: ['22'.repeat(32), '22'.repeat(32)] })), /twice/);
  });

  test('novation counts only verified consent and venue transfer evidence', () => {
    const transferable = strategyState({ ...opened, venuePositionsTransferable: true });
    const states = new Map([['strategy-1', transferable]]);
    const novate = command({ kind: 'NOVATE', newOwnerId: 'owner-2', venueConfirmations: [{ venueId: 'solana', evidenceHash: '31'.repeat(32) }, { venueId: 'hyperliquid', evidenceHash: '32'.repeat(32) }] }, { expectedStateHash: strategyStateHash(transferable) });
    const claimed = applyStrategyCommand(novate, states);
    assert.ok(claimed.kind === 'TRANSITIONED' && !claimed.result.accepted && claimed.result.rejection === 'CONSENT_MISSING');
    const partial = applyStrategyCommand(novate, states, { consentingOwnerIds: ['owner-2'], confirmedVenueIds: ['solana'] });
    assert.ok(partial.kind === 'TRANSITIONED' && !partial.result.accepted && partial.result.rejection === 'VENUE_CONFIRMATION_MISSING');
    const novated = applyStrategyCommand(novate, states, { consentingOwnerIds: ['owner-2'], confirmedVenueIds: ['solana', 'hyperliquid'] });
    assert.ok(novated.kind === 'TRANSITIONED' && novated.result.accepted && novated.result.states[0]?.ownerId === 'owner-2');
    const restricted = applyStrategyCommand(command({ ...novate.parameters } as StrategyCommandInput['parameters']), new Map([['strategy-1', opened]]), { consentingOwnerIds: ['owner-2'], confirmedVenueIds: ['solana', 'hyperliquid'] });
    assert.ok(restricted.kind === 'TRANSITIONED' && !restricted.result.accepted && restricted.result.rejection === 'NOT_TRANSFERABLE' && restricted.result.remedy === 'EXIT_AND_REENTER');
  });
});
