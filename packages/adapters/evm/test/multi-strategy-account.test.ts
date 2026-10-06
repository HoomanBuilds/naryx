import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompiledStrategyExecution } from '@naryx/adapter-core';
import {
  domainRef,
  hash32,
  type DomainRef,
  type Hash32,
} from '@naryx/protocol-types';
import {
  decodeFunctionData,
  hexToBytes,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import {
  compileEvmMultiStrategyAccountEnvelope,
  encodeEvmMultiStrategyAccountExecution,
  encodeEvmMultiStrategyAccountRecovery,
} from '../src/multi-strategy-account.js';
import type { EvmStrategyExecutionPlan } from '../src/strategy-plan.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const SOLVER = '0x2222222222222222222222222222222222222222' as Address;
const ADAPTER = '0x3333333333333333333333333333333333333333' as Address;
const TOKEN = '0x4444444444444444444444444444444444444444' as Address;
const HASH_A = `0x${'11'.repeat(32)}` as Hex;
const HASH_B = `0x${'22'.repeat(32)}` as Hex;
const HASH_C = `0x${'33'.repeat(32)}` as Hex;
const HASH_D = `0x${'44'.repeat(32)}` as Hex;
const HASH_E = `0x${'55'.repeat(32)}` as Hex;
const HASH_F = `0x${'66'.repeat(32)}` as Hex;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;

function bytes(value: Hex): Hash32 {
  return hash32(hexToBytes(value));
}

function domain(): DomainRef {
  return domainRef('eip155:84532', 3, HASH_A);
}

function compiled(): CompiledStrategyExecution<EvmStrategyExecutionPlan> {
  const executionDomain = domain();
  return Object.freeze({
    domains: Object.freeze([executionDomain]),
    orderHash: bytes(HASH_B),
    graphHash: bytes(HASH_C),
    quoteHash: bytes(HASH_D),
    routeHash: bytes(HASH_E),
    payload: Object.freeze({
      version: 1 as const,
      planKind: 'EVM_ATOMIC_BATCH' as const,
      guarantee: 'ATOMIC_POSTCONDITION' as const,
      domain: executionDomain,
      strategyAccount: ACCOUNT,
      stages: Object.freeze([
        Object.freeze({
          stage: 0,
          calls: Object.freeze([
            Object.freeze({
              legId: 'funding-long',
              stage: 0,
              materializationClassId: 'typed-perp-leg-v1',
              adapter: ADAPTER,
              adapterCodeHash: HASH_F,
              gasLimit: 400_000n,
              value: 0n as const,
              data: '0x12345678abcdef' as Hex,
              dataHash: keccak256('0x12345678abcdef'),
            }),
          ]),
        }),
      ]),
      totalGasLimit: 400_000n,
    }),
  });
}

function input() {
  return {
    compiled: compiled(),
    account: ACCOUNT,
    chainId: 84_532,
    operation: 'ENTRY' as const,
    packageId: HASH_F,
    templateId: 'perpetual-funding-spread-v1',
    templateVersion: 1,
    templateManifestHash: HASH_A,
    nextStateHash: HASH_B,
    totalGrossNotionalAtoms: 100_000_000n,
    solver: SOLVER,
    nonce: 0n,
    deadline: 2_000_000_000n,
    callPolicies: Object.freeze([
      Object.freeze({
        legId: 'funding-long',
        adapter: Object.freeze({ subjectId: HASH_C, manifestVersion: 1, manifestHash: HASH_D }),
        expectedAdapterAddress: ADAPTER,
        expectedAdapterCodeHash: HASH_F,
        riskIncreasing: true,
        approvalToken: TOKEN,
        approvalAtoms: 50_000_000n,
        grossNotionalAtoms: 100_000_000n,
      }),
    ]),
  };
}

test('binds a compiled atomic strategy plan to the multi-strategy account signatures and calldata', () => {
  const envelope = compileEvmMultiStrategyAccountEnvelope(input());
  assert.equal(envelope.execution.domainIdHash, keccak256(stringToHex('eip155:84532')));
  assert.equal(envelope.execution.orderHash, HASH_B);
  assert.equal(envelope.execution.graphHash, HASH_C);
  assert.equal(envelope.execution.quoteHash, HASH_D);
  assert.equal(envelope.execution.routeHash, HASH_E);
  assert.equal(envelope.execution.operation, 1);
  assert.equal(envelope.calls.length, 1);
  assert.equal(envelope.calls[0]?.riskIncreasing, true);
  assert.equal(envelope.calls[0]?.payload, '0x12345678abcdef');
  assert.notEqual(envelope.ownerDigest, envelope.solverDigest);

  const encoded = encodeEvmMultiStrategyAccountExecution({
    envelope,
    ownerSignature: '0x0102',
    solverSignature: '0x0304',
  });
  const decoded = decodeFunctionData({
    abi: [{
      type: 'function',
      name: 'execute',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'execution', type: 'tuple', components: [
          { name: 'domainIdHash', type: 'bytes32' }, { name: 'domainManifestVersion', type: 'uint32' },
          { name: 'domainManifestHash', type: 'bytes32' }, { name: 'packageId', type: 'bytes32' },
          { name: 'orderHash', type: 'bytes32' }, { name: 'graphHash', type: 'bytes32' },
          { name: 'quoteHash', type: 'bytes32' }, { name: 'routeHash', type: 'bytes32' },
          { name: 'template', type: 'tuple', components: [{ name: 'templateId', type: 'bytes32' }, { name: 'templateVersion', type: 'uint32' }, { name: 'templateManifestHash', type: 'bytes32' }] },
          { name: 'settlementClass', type: 'tuple', components: [{ name: 'classId', type: 'bytes32' }, { name: 'classVersion', type: 'uint32' }] },
          { name: 'operation', type: 'uint8' }, { name: 'previousStateHash', type: 'bytes32' },
          { name: 'nextStateHash', type: 'bytes32' }, { name: 'totalGrossNotionalAtoms', type: 'uint256' },
          { name: 'solver', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
        ] },
        { name: 'calls', type: 'tuple[]', components: [
          { name: 'adapter', type: 'tuple', components: [{ name: 'subjectId', type: 'bytes32' }, { name: 'manifestVersion', type: 'uint32' }, { name: 'manifestHash', type: 'bytes32' }] },
          { name: 'stage', type: 'uint8' }, { name: 'riskIncreasing', type: 'bool' },
          { name: 'approvalToken', type: 'address' }, { name: 'approvalAtoms', type: 'uint256' },
          { name: 'grossNotionalAtoms', type: 'uint256' }, { name: 'gasLimit', type: 'uint256' },
          { name: 'payload', type: 'bytes' },
        ] },
        { name: 'ownerSignature', type: 'bytes' }, { name: 'solverSignature', type: 'bytes' },
      ],
      outputs: [{ name: 'receiptHash', type: 'bytes32' }],
    }],
    data: encoded,
  });
  assert.equal(decoded.functionName, 'execute');
});

test('rejects an adapter identity policy that does not match the compiled call', () => {
  const candidate = input();
  assert.throws(
    () => compileEvmMultiStrategyAccountEnvelope({
      ...candidate,
      callPolicies: [{ ...candidate.callPolicies[0]!, expectedAdapterAddress: ACCOUNT }],
    }),
    /adapter address mismatch/,
  );
});

test('rejects a risk-reducing leg inside an entry operation', () => {
  const candidate = input();
  assert.throws(
    () => compileEvmMultiStrategyAccountEnvelope({
      ...candidate,
      callPolicies: [{ ...candidate.callPolicies[0]!, riskIncreasing: false }],
    }),
    /risk direction conflicts/,
  );
});

test('encodes owner-only recovery for a fully risk-reducing plan', () => {
  const candidate = input();
  const envelope = compileEvmMultiStrategyAccountEnvelope({
    ...candidate,
    operation: 'EXIT',
    solver: '0x0000000000000000000000000000000000000000',
    previousStateHash: HASH_B,
    nextStateHash: ZERO_HASH,
    callPolicies: [{ ...candidate.callPolicies[0]!, riskIncreasing: false }],
  });
  const encoded = encodeEvmMultiStrategyAccountRecovery({ envelope, ownerSignature: '0x0102' });
  assert.equal(
    encoded.slice(0, 10),
    keccak256(stringToHex('executeRecovery((bytes32,uint32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,(bytes32,uint32,bytes32),(bytes32,uint32),uint8,bytes32,bytes32,uint256,address,uint256,uint256),((bytes32,uint32,bytes32),uint8,bool,address,uint256,uint256,uint256,bytes)[],bytes)')).slice(0, 10),
  );
});
