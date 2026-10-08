import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isEvmStrategyActor,
  strategyCommandAuthorizationTypedData,
  type StrategyCommandInput,
} from '../src/index.js';

const actor = '0x1111111111111111111111111111111111111111';

function command(): StrategyCommandInput {
  return {
    commandVersion: 1,
    environment: 'testnet',
    strategyId: 'carry-1',
    actorId: actor,
    expectedStateVersion: 4n,
    expectedStateHash: '22'.repeat(32),
    atValue: 1_800_000_000_000n,
    parameters: { kind: 'ASSIGN_INTERNAL', subaccountId: 'treasury' },
  };
}

test('builds a chainless EIP-712 authorization around the canonical command hash', () => {
  const typedData = strategyCommandAuthorizationTypedData(command(), actor);
  assert.deepEqual(typedData.domain, { name: 'Naryx Strategy Lifecycle', version: '1' });
  assert.equal(typedData.primaryType, 'StrategyCommandAuthorization');
  assert.match(typedData.message.commandHash, /^0x[0-9a-f]{64}$/);
  assert.equal(typedData.message.commandKind, 'ASSIGN_INTERNAL');
  assert.equal(typedData.message.expectedStateVersion, 4n);
  assert.equal(typedData.message.actor, actor);
  assert.equal(typedData.message.signer, actor);
});

test('rejects noncanonical or zero EVM identities', () => {
  assert.equal(isEvmStrategyActor(actor), true);
  assert.equal(isEvmStrategyActor(actor.toUpperCase()), false);
  assert.equal(isEvmStrategyActor(`0x${'0'.repeat(40)}`), false);
  assert.throws(
    () => strategyCommandAuthorizationTypedData(command(), 'not-an-address'),
    /canonical lowercase address/,
  );
});
