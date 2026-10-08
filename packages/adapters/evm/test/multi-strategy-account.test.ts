import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompiledStrategyExecution } from '@naryx/adapter-core';
import {
  assetRef,
  commitmentHash,
  domainRef,
  hash32,
  protocolId,
  type DomainRef,
  type Hash32,
  type NettingAllocationExecutionAuthorization,
} from '@naryx/protocol-types';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  hashTypedData,
  hexToBytes,
  keccak256,
  parseAbi,
  parseAbiParameters,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import {
  compileEvmNettingAllocationEnvelope,
  compileEvmMultiStrategyAccountEnvelope,
  encodeEvmNettingAllocationExecution,
  encodeEvmMultiStrategyAccountExecution,
  encodeEvmMultiStrategyAccountRecovery,
} from '../src/multi-strategy-account.js';
import {
  evmNettingAllocationObservationBinding,
  observeEvmNettingAllocation,
  verifyEvmNettingAllocationObservationBinding,
} from '../src/multi-strategy-observation.js';
import type { EvmReadPort } from '../src/readPort.js';
import type { EvmStrategyExecutionPlan } from '../src/strategy-plan.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const SOLVER = '0x2222222222222222222222222222222222222222' as Address;
const ADAPTER = '0x3333333333333333333333333333333333333333' as Address;
const TOKEN = '0x4444444444444444444444444444444444444444' as Address;
const OWNER = '0x5555555555555555555555555555555555555555' as Address;
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

const commitment = (value: Hex) => commitmentHash(value);

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
      packageId: HASH_F,
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
    fees: {
      policyVersion: 1,
      policyManifestHash: HASH_C,
      token: TOKEN,
      protocolFeeAtoms: 25_000n,
      solverFeeAtoms: 15_000n,
    },
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

function nettingAuthorization(
  envelope: ReturnType<typeof compileEvmMultiStrategyAccountEnvelope>,
): NettingAllocationExecutionAuthorization {
  return Object.freeze({
    version: 1,
    authorizationHash: commitment(HASH_A),
    environment: protocolId('testnet'),
    executionClassId: protocolId('spot-netting'),
    finalAllocationReceiptHash: commitment(HASH_B),
    allocationReceiptHash: commitment(HASH_C),
    nettingProofHash: commitment(HASH_D),
    settlementCommitmentHash: commitment(HASH_E),
    obligationId: commitment(HASH_F),
    packageOrderId: commitment(HASH_A),
    strategyOrderHash: commitment(envelope.execution.orderHash),
    ownerId: protocolId(OWNER),
    settlementAccount: protocolId(ACCOUNT),
    domain: domain(),
    instrumentId: protocolId('sol-spot'),
    instrumentHash: commitment(HASH_B),
    quantityAsset: assetRef('sol', HASH_C, 9),
    quoteAsset: assetRef('usdc', HASH_D, 6),
    stateKind: 'ASSET_BALANCE',
    settledQuantityAtoms: 1_000_000_000n,
    settledQuoteDeltaAtoms: -100_000_000n,
    executionPlanHash: commitment(envelope.callsHash),
    solverId: protocolId(SOLVER),
    protocolFeeAtoms: envelope.execution.fees.protocolFeeAtoms,
    solverFeeAtoms: envelope.execution.fees.solverFeeAtoms,
    nonce: envelope.execution.nonce,
    validUntilUnit: 'EVM_UNIX_SECONDS',
    validUntilValue: envelope.execution.deadline,
  });
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
  assert.equal(envelope.calls[0]?.target, ADAPTER);
  assert.equal(envelope.calls[0]?.riskIncreasing, true);
  assert.equal(envelope.calls[0]?.payload, '0x12345678abcdef');
  assert.notEqual(envelope.ownerDigest, envelope.solverDigest);
  assert.equal(envelope.ownerDigest, hashTypedData(envelope.ownerTypedData));
  assert.equal(envelope.solverDigest, hashTypedData(envelope.solverTypedData));

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
          { name: 'fees', type: 'tuple', components: [
            { name: 'policyVersion', type: 'uint32' }, { name: 'policyManifestHash', type: 'bytes32' },
            { name: 'token', type: 'address' }, { name: 'protocolFeeAtoms', type: 'uint256' },
            { name: 'solverFeeAtoms', type: 'uint256' },
          ] },
          { name: 'solver', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
        ] },
        { name: 'calls', type: 'tuple[]', components: [
          { name: 'adapter', type: 'tuple', components: [{ name: 'subjectId', type: 'bytes32' }, { name: 'manifestVersion', type: 'uint32' }, { name: 'manifestHash', type: 'bytes32' }] },
          { name: 'target', type: 'address' },
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

test('binds a final allocation authorization to exact EVM execution calldata', () => {
  const envelope = compileEvmMultiStrategyAccountEnvelope(input());
  const netting = compileEvmNettingAllocationEnvelope({
    envelope,
    authorization: nettingAuthorization(envelope),
    owner: OWNER,
  });
  assert.equal(netting.authorizationHash, HASH_A);
  assert.equal(netting.ownerDigest, hashTypedData(netting.ownerTypedData));
  assert.equal(netting.solverDigest, hashTypedData(netting.solverTypedData));
  assert.notEqual(netting.ownerDigest, netting.solverDigest);
  const encoded = encodeEvmNettingAllocationExecution({
    netting,
    ownerSignature: '0x0102',
    solverSignature: '0x0304',
  });
  assert.equal(
    encoded.slice(0, 10),
    keccak256(stringToHex('executeNettingAllocation((bytes32,uint32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,(bytes32,uint32,bytes32),(bytes32,uint32),uint8,bytes32,bytes32,uint256,(uint32,bytes32,address,uint256,uint256),address,uint256,uint256),((bytes32,uint32,bytes32),address,uint8,bool,address,uint256,uint256,uint256,bytes)[],bytes32,bytes,bytes)')).slice(0, 10),
  );
});

test('rejects a netting authorization for another call plan', () => {
  const envelope = compileEvmMultiStrategyAccountEnvelope(input());
  assert.throws(() => compileEvmNettingAllocationEnvelope({
    envelope,
    authorization: { ...nettingAuthorization(envelope), executionPlanHash: commitment(HASH_F) },
    owner: OWNER,
  }), /execution plan mismatch/);
  assert.throws(() => compileEvmNettingAllocationEnvelope({
    envelope,
    authorization: nettingAuthorization(envelope),
    owner: SOLVER,
  }), /owner mismatch/);
});

test('observes only the exact finalized EVM netting execution', async () => {
  const envelope = compileEvmMultiStrategyAccountEnvelope(input());
  const netting = compileEvmNettingAllocationEnvelope({
    envelope,
    authorization: nettingAuthorization(envelope),
    owner: OWNER,
  });
  const evidenceRoot = HASH_F;
  const receiptHash = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32 executionHash,bytes32 callsHash,bytes32 evidenceRoot'),
    [envelope.executionHash, envelope.callsHash, evidenceRoot],
  ));
  const eventAbi = parseAbi([
    'event NettingAllocationExecuted(bytes32 indexed receiptHash,bytes32 indexed authorizationHash)',
  ]);
  const receipt = {
    packageId: envelope.execution.packageId,
    orderHash: envelope.execution.orderHash,
    graphHash: envelope.execution.graphHash,
    quoteHash: envelope.execution.quoteHash,
    routeHash: envelope.execution.routeHash,
    operation: envelope.execution.operation,
    previousStateHash: envelope.execution.previousStateHash,
    nextStateHash: envelope.execution.nextStateHash,
    callsHash: envelope.callsHash,
    evidenceRoot,
    fees: envelope.execution.fees,
    nonce: envelope.execution.nonce,
    solver: envelope.execution.solver,
  };
  const port = (storedAuthorization: Hex): EvmReadPort => ({
    chainId: async () => 84_532n,
    transactionReceipt: async () => ({
      status: 'success',
      blockNumber: 100n,
      logs: [{
        address: ACCOUNT,
        topics: encodeEventTopics({
          abi: eventAbi,
          eventName: 'NettingAllocationExecuted',
          args: { receiptHash, authorizationHash: netting.authorizationHash },
        }) as unknown as readonly Hex[],
        data: '0x',
      }],
    }),
    readContract: async (read) => read.functionName === 'nettingAuthorizationOf' ? storedAuthorization : receipt,
    chainHead: async () => ({ latestBlock: 110n, finalizedBlock: 105n }),
  });
  const binding = evmNettingAllocationObservationBinding(netting);
  verifyEvmNettingAllocationObservationBinding(binding, nettingAuthorization(envelope));
  const observed = await observeEvmNettingAllocation(port(netting.authorizationHash), {
    binding,
    transactionHash: HASH_E,
    finality: { requiredConfirmations: 2, requireFinalized: true },
  });
  assert.equal(observed.lifecycle, 'FINALIZED');
  assert.equal(observed.receipt?.receiptHash, receiptHash);
  const refused = await observeEvmNettingAllocation(port(HASH_B), {
    binding,
    transactionHash: HASH_E,
    finality: { requiredConfirmations: 2, requireFinalized: true },
  });
  assert.equal(refused.lifecycle, 'EVIDENCE_MISMATCH');
  assert.match(refused.reason ?? '', /stored authorization differs/);
});

test('rejects a package identity that differs from the compiled leg payloads', () => {
  const candidate = input();
  assert.throws(
    () => compileEvmMultiStrategyAccountEnvelope({ ...candidate, packageId: HASH_E }),
    /plan package id mismatch/,
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
    fees: {
      policyVersion: 0,
      policyManifestHash: ZERO_HASH,
      token: '0x0000000000000000000000000000000000000000',
      protocolFeeAtoms: 0n,
      solverFeeAtoms: 0n,
    },
    previousStateHash: HASH_B,
    nextStateHash: ZERO_HASH,
    callPolicies: [{ ...candidate.callPolicies[0]!, riskIncreasing: false }],
  });
  const encoded = encodeEvmMultiStrategyAccountRecovery({ envelope, ownerSignature: '0x0102' });
  assert.equal(
    encoded.slice(0, 10),
    keccak256(stringToHex('executeRecovery((bytes32,uint32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,(bytes32,uint32,bytes32),(bytes32,uint32),uint8,bytes32,bytes32,uint256,(uint32,bytes32,address,uint256,uint256),address,uint256,uint256),((bytes32,uint32,bytes32),address,uint8,bool,address,uint256,uint256,uint256,bytes)[],bytes)')).slice(0, 10),
  );
});
