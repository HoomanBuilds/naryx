import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeFunctionResult, encodeFunctionResult, type Abi, type AbiParameter } from 'viem';
import { NARYX_MULTI_STRATEGY_ACCOUNT_STATE_ABI } from '../src/multi-strategy-state.js';

const published = JSON.parse(readFileSync(new URL('../../../../../deployments/evm/conformance/abi/NaryxMultiStrategyAccount.abi.json', import.meta.url), 'utf8')) as Abi;
function value(parameter: AbiParameter): unknown {
  if (parameter.type === 'tuple' && 'components' in parameter) {
    return Object.fromEntries(parameter.components.map((component) => [component.name, value(component)]));
  }
  if (parameter.type === 'bool') return true;
  if (parameter.type === 'address') return `0x${'11'.repeat(20)}`;
  if (parameter.type === 'bytes32') return `0x${'ab'.repeat(32)}`;
  return parameter.type === 'uint256' ? 2n ** 255n : 1;
}

test('strategy state and receipt decoders match the published risk-aware contract ABI', () => {
  for (const functionName of ['packageState', 'receipt'] as const) {
    const fn = published.find((item) => item.type === 'function' && item.name === functionName);
    assert.ok(fn?.type === 'function');
    const expected = value(fn.outputs[0]!);
    const encoded = encodeFunctionResult({ abi: [fn], functionName, result: expected as never });
    const decoded = decodeFunctionResult({ abi: NARYX_MULTI_STRATEGY_ACCOUNT_STATE_ABI, functionName, data: encoded });
    assert.deepEqual(decoded, expected);
  }
});
