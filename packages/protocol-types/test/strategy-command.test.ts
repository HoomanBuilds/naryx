import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyStrategyCommand,
  strategyCommandHash,
  strategyCommandSubjects,
  strategyState,
  strategyStateHash,
  toHex,
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
});
