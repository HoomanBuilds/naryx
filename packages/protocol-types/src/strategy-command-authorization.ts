import { toHex } from './bytes.js';
import { strategyCommandHash, type StrategyCommandInput } from './strategy-command.js';

const EVM_ACTOR = /^0x(?!0{40}$)[0-9a-f]{40}$/;

export function isEvmStrategyActor(value: string): boolean {
  return EVM_ACTOR.test(value);
}

export function strategyCommandAuthorizationTypedData(
  command: StrategyCommandInput,
  signerId: string,
) {
  if (!isEvmStrategyActor(signerId)) {
    throw new TypeError('strategy command EVM signer must be a canonical lowercase address');
  }
  return Object.freeze({
    domain: Object.freeze({ name: 'Naryx Strategy Lifecycle', version: '1' }),
    types: Object.freeze({
      StrategyCommandAuthorization: Object.freeze([
        { name: 'commandHash', type: 'bytes32' },
        { name: 'environment', type: 'string' },
        { name: 'strategyId', type: 'string' },
        { name: 'commandKind', type: 'string' },
        { name: 'expectedStateVersion', type: 'uint64' },
        { name: 'atValue', type: 'uint64' },
        { name: 'actor', type: 'string' },
        { name: 'signer', type: 'address' },
      ]),
    }),
    primaryType: 'StrategyCommandAuthorization' as const,
    message: Object.freeze({
      commandHash: `0x${toHex(strategyCommandHash(command))}`,
      environment: command.environment,
      strategyId: command.strategyId,
      commandKind: command.parameters.kind,
      expectedStateVersion: command.expectedStateVersion,
      atValue: command.atValue,
      actor: command.actorId,
      signer: signerId,
    }),
  });
}
