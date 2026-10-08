import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assetRef,
  commitmentHash,
  domainRef,
  hash32,
  protocolId,
  type NettingAllocationExecutionAuthorization,
} from '@naryx/protocol-types';
import {
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  parseAbiParameters,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import type {
  EvmMultiStrategyExecution,
  EvmNettingAllocationObservationBinding,
} from '@naryx/adapter-evm';
import {
  NettingAllocationAttemptStoreError,
  SqliteNettingAllocationAttemptStore,
} from '../src/netting-allocation-attempt-store.js';

const EXECUTION_PARAMETERS = parseAbiParameters(
  '(bytes32 domainIdHash,uint32 domainManifestVersion,bytes32 domainManifestHash,bytes32 packageId,bytes32 orderHash,bytes32 graphHash,bytes32 quoteHash,bytes32 routeHash,(bytes32 templateId,uint32 templateVersion,bytes32 templateManifestHash) template,(bytes32 classId,uint32 classVersion) settlementClass,uint8 operation,bytes32 previousStateHash,bytes32 nextStateHash,uint256 totalGrossNotionalAtoms,(uint32 policyVersion,bytes32 policyManifestHash,address token,uint256 protocolFeeAtoms,uint256 solverFeeAtoms) fees,address solver,uint256 nonce,uint256 deadline)',
);
const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const SOLVER = '0x2222222222222222222222222222222222222222' as Address;
const TOKEN = '0x3333333333333333333333333333333333333333' as Address;

function hex(byte: number): Hex {
  return `0x${byte.toString(16).padStart(2, '0').repeat(32)}` as Hex;
}

function bytes(byte: number) {
  return hash32(hexToBytes(hex(byte)));
}

function fixture(): Readonly<{
  authorization: NettingAllocationExecutionAuthorization;
  binding: EvmNettingAllocationObservationBinding;
}> {
  const domain = domainRef('eip155:84532', 3, bytes(1));
  const execution: EvmMultiStrategyExecution = Object.freeze({
    domainIdHash: keccak256(stringToHex(domain.domainId)),
    domainManifestVersion: domain.domainManifestVersion,
    domainManifestHash: hex(1),
    packageId: hex(2),
    orderHash: hex(3),
    graphHash: hex(4),
    quoteHash: hex(5),
    routeHash: hex(6),
    template: Object.freeze({ templateId: hex(7), templateVersion: 1, templateManifestHash: hex(8) }),
    settlementClass: Object.freeze({ classId: hex(9), classVersion: 1 }),
    operation: 1,
    previousStateHash: hex(0),
    nextStateHash: hex(10),
    totalGrossNotionalAtoms: 100_000_000n,
    fees: Object.freeze({
      policyVersion: 1,
      policyManifestHash: hex(11),
      token: TOKEN,
      protocolFeeAtoms: 25_000n,
      solverFeeAtoms: 15_000n,
    }),
    solver: SOLVER,
    nonce: 4n,
    deadline: 2_000_000_000n,
  });
  const authorization: NettingAllocationExecutionAuthorization = Object.freeze({
    version: 1,
    authorizationHash: commitmentHash(bytes(12)),
    environment: protocolId('testnet'),
    executionClassId: protocolId('spot-netting'),
    finalAllocationReceiptHash: commitmentHash(bytes(13)),
    allocationReceiptHash: commitmentHash(bytes(14)),
    nettingProofHash: commitmentHash(bytes(15)),
    settlementCommitmentHash: commitmentHash(bytes(16)),
    obligationId: commitmentHash(bytes(17)),
    packageOrderId: commitmentHash(bytes(18)),
    strategyOrderHash: commitmentHash(bytes(3)),
    ownerId: protocolId('0x4444444444444444444444444444444444444444'),
    settlementAccount: protocolId(ACCOUNT),
    domain,
    instrumentId: protocolId('sol-spot'),
    instrumentHash: commitmentHash(bytes(19)),
    quantityAsset: assetRef('sol', bytes(20), 9),
    quoteAsset: assetRef('usdc', bytes(21), 6),
    stateKind: 'ASSET_BALANCE',
    settledQuantityAtoms: 1_000_000_000n,
    settledQuoteDeltaAtoms: -100_000_000n,
    executionPlanHash: commitmentHash(bytes(22)),
    solverId: protocolId(SOLVER),
    protocolFeeAtoms: execution.fees.protocolFeeAtoms,
    solverFeeAtoms: execution.fees.solverFeeAtoms,
    nonce: execution.nonce,
    validUntilUnit: 'EVM_UNIX_SECONDS',
    validUntilValue: execution.deadline,
  });
  const binding: EvmNettingAllocationObservationBinding = Object.freeze({
    chainReference: 84_532n,
    account: ACCOUNT,
    authorizationHash: hex(12),
    executionHash: keccak256(encodeAbiParameters(EXECUTION_PARAMETERS, [execution])),
    callsHash: hex(22),
    execution,
  });
  return Object.freeze({ authorization, binding });
}

test('persists one canonical execution reference per netting allocation attempt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-netting-attempt-'));
  const database = join(directory, 'attempts.sqlite');
  const { authorization, binding } = fixture();
  const attemptId = 'attempt-00000001';
  const idempotencyKey = 'allocation-attempt-00000001';
  const transactionHash = hex(23);
  let store = new SqliteNettingAllocationAttemptStore(database, () => 1_000);
  try {
    const created = store.save({
      attemptId,
      idempotencyKey,
      authorization,
      observation: { runtimeClass: 'EVM', binding },
    });
    assert.equal(created.executionReference, undefined);
    assert.equal(store.save({
      attemptId,
      idempotencyKey,
      authorization,
      observation: { runtimeClass: 'EVM', binding },
    }).attemptId, attemptId);
    assert.equal(
      store.bindExecutionReference(attemptId, authorization, transactionHash).executionReference,
      transactionHash,
    );
    assert.throws(
      () => store.bindExecutionReference(attemptId, authorization, hex(24)),
      (error: unknown) => error instanceof NettingAllocationAttemptStoreError
        && error.code === 'EXECUTION_REFERENCE_CONFLICT',
    );
  } finally {
    store.close();
  }
  store = new SqliteNettingAllocationAttemptStore(database);
  try {
    assert.equal(store.get(attemptId, authorization)?.executionReference, transactionHash);
    assert.equal(store.attemptsForAuthorization(authorization).length, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
