import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompiledStrategyExecution } from '@naryx/adapter-core';
import {
  compileEvmMultiStrategyAccountEnvelope,
  compileEvmNettingAllocationEnvelope,
  type EvmStrategyExecutionPlan,
} from '@naryx/adapter-evm';
import {
  assetRef,
  commitmentHash,
  domainRef,
  hash32,
  protocolId,
  type NettingAllocationExecutionAuthorization,
} from '@naryx/protocol-types';
import {
  hexToBytes,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmNettingAllocationAuthorizationService } from '../src/index.js';

const OWNER = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const SOLVER = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const ACCOUNT = '0x4444444444444444444444444444444444444444' as Address;
const ADAPTER = '0x5555555555555555555555555555555555555555' as Address;
const TOKEN = '0x6666666666666666666666666666666666666666' as Address;
const value = (byte: number): Hex => `0x${byte.toString(16).padStart(2, '0').repeat(32)}`;
const bytes = (byte: number) => hash32(hexToBytes(value(byte)));

function fixture() {
  const domain = domainRef('eip155:84532', 1, bytes(1));
  const compiled: CompiledStrategyExecution<EvmStrategyExecutionPlan> = {
    domains: [domain],
    orderHash: bytes(2),
    graphHash: bytes(3),
    quoteHash: bytes(4),
    routeHash: bytes(5),
    payload: {
      version: 1,
      planKind: 'EVM_ATOMIC_BATCH',
      guarantee: 'ATOMIC_POSTCONDITION',
      domain,
      strategyAccount: ACCOUNT,
      packageId: value(6),
      stages: [{
        stage: 0,
        calls: [{
          legId: 'spot-leg',
          stage: 0,
          materializationClassId: 'typed-spot-leg-v1',
          adapter: ADAPTER,
          adapterCodeHash: value(7),
          gasLimit: 300_000n,
          value: 0n,
          data: '0x12345678',
          dataHash: keccak256('0x12345678'),
        }],
      }],
      totalGasLimit: 300_000n,
    },
  };
  const envelope = compileEvmMultiStrategyAccountEnvelope({
    compiled,
    account: ACCOUNT,
    chainId: 84_532,
    operation: 'ENTRY',
    packageId: value(6),
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    templateManifestHash: value(8),
    nextStateHash: value(9),
    totalGrossNotionalAtoms: 100n,
    fees: {
      policyVersion: 1,
      policyManifestHash: value(10),
      token: TOKEN,
      protocolFeeAtoms: 1n,
      solverFeeAtoms: 2n,
    },
    solver: SOLVER.address,
    nonce: 3n,
    deadline: 2_000_000_000n,
    callPolicies: [{
      legId: 'spot-leg',
      adapter: { subjectId: value(11), manifestVersion: 1, manifestHash: value(12) },
      expectedAdapterAddress: ADAPTER,
      expectedAdapterCodeHash: value(7),
      riskIncreasing: true,
      approvalToken: TOKEN,
      approvalAtoms: 10n,
      grossNotionalAtoms: 100n,
    }],
  });
  const authorization: NettingAllocationExecutionAuthorization = Object.freeze({
    version: 1,
    authorizationHash: commitmentHash(bytes(13)),
    environment: protocolId('testnet'),
    executionClassId: protocolId('atomic-strategy-netting'),
    finalAllocationReceiptHash: commitmentHash(bytes(14)),
    allocationReceiptHash: commitmentHash(bytes(15)),
    nettingProofHash: commitmentHash(bytes(16)),
    settlementCommitmentHash: commitmentHash(bytes(17)),
    obligationId: commitmentHash(bytes(18)),
    packageOrderId: commitmentHash(bytes(19)),
    strategyOrderHash: commitmentHash(envelope.execution.orderHash),
    ownerId: protocolId(OWNER.address),
    settlementAccount: protocolId(ACCOUNT),
    domain,
    instrumentId: protocolId('sol-spot'),
    instrumentHash: commitmentHash(bytes(20)),
    quantityAsset: assetRef('sol', bytes(21), 9),
    quoteAsset: assetRef('usdc', bytes(22), 6),
    stateKind: 'ASSET_BALANCE',
    settledQuantityAtoms: 10n,
    settledQuoteDeltaAtoms: -100n,
    executionPlanHash: commitmentHash(envelope.callsHash),
    solverId: protocolId(SOLVER.address),
    protocolFeeAtoms: 1n,
    solverFeeAtoms: 2n,
    nonce: 3n,
    validUntilUnit: 'EVM_UNIX_SECONDS',
    validUntilValue: 2_000_000_000n,
  });
  const netting = compileEvmNettingAllocationEnvelope({
    envelope,
    authorization,
    owner: OWNER.address,
  });
  const prepared = {
    kind: 'EVM_MULTI_STRATEGY_ACCOUNT',
    authorization,
    netting,
    observation: { runtimeClass: 'EVM', binding: {} },
  } as const;
  return { prepared, authorization };
}

test('returns exact testnet EVM calldata only after owner and solver authorization', async () => {
  const { prepared, authorization } = fixture();
  const service = new EvmNettingAllocationAuthorizationService({
    prepareAndRegister: async () => ({
      proofHashHex: 'aa'.repeat(32),
      allocationReceiptHashHex: 'bb'.repeat(32),
      prepared,
      attempt: {
        attemptId: 'allocation-attempt-0001',
        idempotencyKey: 'cc'.repeat(32),
        authorizationHashHex: 'dd'.repeat(32),
        observation: prepared.observation,
        recordedAtMs: 1,
      },
    }) as never,
  }, SOLVER);
  const request = {
    proofHash: bytes(23),
    allocationReceiptHash: bytes(24),
    quoteHash: bytes(25),
    domainId: 'eip155:84532',
    attemptId: 'allocation-attempt-0001',
  };
  const challenge = await service.challenge(request);
  const ownerSignature = await OWNER.signTypedData(challenge.ownerTypedData);
  const authorized = await service.authorize({ ...request, ownerSignature });

  assert.equal(authorized.authorizationHash, `0x${Buffer.from(authorization.authorizationHash).toString('hex')}`);
  assert.equal(authorized.owner, OWNER.address);
  assert.equal(authorized.to, ACCOUNT);
  assert.equal(authorized.value, 0n);
  assert.match(authorized.data, /^0x[0-9a-f]+$/);
  assert.equal(authorized.ownerSignature, ownerSignature);
  assert.equal(authorized.solverSignature.length, 132);

  const wrongSignature = await OTHER.signTypedData(challenge.ownerTypedData);
  await assert.rejects(
    service.authorize({ ...request, ownerSignature: wrongSignature }),
    /owner signature does not authorize the netting allocation/,
  );
});
