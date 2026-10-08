import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { CompiledStrategyExecution } from '@naryx/adapter-core';
import {
  assetRef,
  commitmentHash,
  protocolId,
  type DomainRef,
  type NettingAllocationExecutionAuthorization,
} from '@naryx/protocol-types';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  compileSolanaMultiStrategyAccountEnvelope,
  compileSolanaNettingAllocationEnvelope,
  deriveSolanaMultiStrategyAccount,
  observeSolanaNettingAllocation,
  solanaNettingAllocationObservationBinding,
  solanaMultiStrategyReceiptHash,
  verifySolanaNettingAllocationObservationBinding,
  type SolanaStrategyAdapterPolicy,
  type SolanaStrategyInstructionPlan,
} from '../src/index.js';

const address = (byte: number): PublicKey => new PublicKey(new Uint8Array(32).fill(byte));
const hash = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const domain = {
  domainId: 'svm:local-strategy',
  domainManifestVersion: 1,
  domainManifestHash: hash(1),
} as unknown as DomainRef;
const coreProgram = address(2);
const multiStrategyProgram = address(3);
const owner = address(4);
const solver = address(5);
const adapterProgram = address(6);
const adapterProgramData = address(7);
const packageId = hash(8);
const strategyAccount = PublicKey.findProgramAddressSync(
  [Buffer.from('multi-strategy-account'), owner.toBuffer()],
  multiStrategyProgram,
)[0];

function compiled(stage = 0): CompiledStrategyExecution<SolanaStrategyInstructionPlan> {
  const instruction = new TransactionInstruction({
    programId: adapterProgram,
    keys: [
      { pubkey: strategyAccount, isSigner: true, isWritable: false },
      { pubkey: address(9), isSigner: false, isWritable: true },
    ],
    data: Buffer.from([10, 11, 12]),
  });
  return {
    domains: [domain],
    orderHash: hash(10),
    graphHash: hash(11),
    quoteHash: hash(12),
    routeHash: hash(13),
    payload: {
      version: 1,
      planKind: 'SVM_ATOMIC_CPI',
      guarantee: 'ATOMIC_POSTCONDITION',
      domain,
      packageId,
      feePayer: owner.toBase58(),
      requiredSignerPubkeys: [owner.toBase58(), strategyAccount.toBase58()],
      instructions: [{
        legId: 'spot-leg',
        stage,
        materializationClassId: 'naryx.solana.spot-exact',
        programId: adapterProgram.toBase58(),
        expectedProgramDataHash: hash(14),
        computeUnitLimit: 200_000,
        instruction,
      }],
      totalComputeUnitLimit: 200_000,
    },
  } as unknown as CompiledStrategyExecution<SolanaStrategyInstructionPlan>;
}

function policy(riskIncreasing: boolean, grossNotionalAtoms = 100n): SolanaStrategyAdapterPolicy {
  return {
    legId: 'spot-leg',
    adapterSubjectId: hash(15),
    adapterManifestVersion: 1,
    adapterManifestHash: hash(16),
    adapterProgram,
    adapterProgramData,
    riskIncreasing,
    grossNotionalAtoms,
  };
}

function baseInput() {
  return {
    compiled: compiled(),
    coreProgramId: coreProgram,
    multiStrategyProgramId: multiStrategyProgram,
    owner,
    solver,
    operation: 'ENTRY' as const,
    packageId,
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    templateManifestHash: hash(17),
    settlementManifestHash: hash(18),
    nextStateHash: hash(19),
    totalGrossNotionalAtoms: 100n,
    fees: {
      quoteAssetSubjectId: hash(20),
      quoteAssetManifestVersion: 1,
      quoteAssetManifestHash: hash(21),
      policyVersion: 1,
      policyManifestHash: hash(22),
      mint: address(23),
      protocolRecipient: address(24),
      protocolFeeAtoms: 1n,
      solverFeeAtoms: 2n,
    },
    nonce: 1n,
    deadlineSlot: 500n,
    policies: [policy(true)],
  };
}

function nettingAuthorization(
  envelope: ReturnType<typeof compileSolanaMultiStrategyAccountEnvelope>,
): NettingAllocationExecutionAuthorization {
  return Object.freeze({
    version: 1,
    authorizationHash: commitmentHash(hash(30)),
    environment: protocolId('testnet'),
    executionClassId: protocolId('svm-multi-strategy'),
    finalAllocationReceiptHash: commitmentHash(hash(31)),
    allocationReceiptHash: commitmentHash(hash(32)),
    nettingProofHash: commitmentHash(hash(33)),
    settlementCommitmentHash: commitmentHash(hash(34)),
    obligationId: commitmentHash(hash(35)),
    packageOrderId: commitmentHash(hash(36)),
    strategyOrderHash: commitmentHash(envelope.orderHash),
    ownerId: protocolId(owner.toBase58()),
    settlementAccount: protocolId(envelope.strategyAccount.toBase58()),
    domain,
    instrumentId: protocolId('sol-spot'),
    instrumentHash: commitmentHash(hash(37)),
    quantityAsset: assetRef('sol', hash(38), 9),
    quoteAsset: assetRef('usdc', hash(39), 6),
    stateKind: 'ASSET_BALANCE',
    settledQuantityAtoms: 1_000_000_000n,
    settledQuoteDeltaAtoms: -100_000_000n,
    executionPlanHash: commitmentHash(envelope.callsHash),
    solverId: protocolId(solver.toBase58()),
    protocolFeeAtoms: 1n,
    solverFeeAtoms: 2n,
    nonce: 1n,
    validUntilUnit: 'SOLANA_SLOT',
    validUntilValue: 500n,
  });
}

function receiptData(
  netting: ReturnType<typeof compileSolanaNettingAllocationEnvelope>,
  slot: bigint,
): Uint8Array {
  const { envelope } = netting;
  const evidenceRoot = hash(41);
  const receiptHash = solanaMultiStrategyReceiptHash({
    executionHash: envelope.executionHash,
    callsHash: envelope.callsHash,
    evidenceRoot,
  });
  const data = Buffer.alloc(532);
  createHash('sha256').update('account:StrategyReceipt', 'ascii').digest().copy(data, 0, 0, 8);
  let offset = 8;
  data[offset++] = 1;
  for (const value of [
    envelope.packageId,
    envelope.orderHash,
    envelope.graphHash,
    envelope.quoteHash,
    envelope.routeHash,
  ]) {
    Buffer.from(value).copy(data, offset);
    offset += 32;
  }
  data[offset++] = 0;
  for (const value of [
    envelope.previousStateHash,
    envelope.nextStateHash,
    envelope.callsHash,
    evidenceRoot,
    receiptHash,
    netting.authorizationHash,
  ]) {
    Buffer.from(value).copy(data, offset);
    offset += 32;
  }
  const fees = envelope.fees!;
  data[offset++] = 0;
  Buffer.from(fees.quoteAssetSubjectId).copy(data, offset);
  offset += 32;
  data.writeUInt32LE(fees.quoteAssetManifestVersion, offset);
  offset += 4;
  Buffer.from(fees.quoteAssetManifestHash).copy(data, offset);
  offset += 32;
  data.writeUInt32LE(fees.policyVersion, offset);
  offset += 4;
  Buffer.from(fees.policyManifestHash).copy(data, offset);
  offset += 32;
  data.writeBigUInt64LE(fees.protocolFeeAtoms, offset);
  offset += 8;
  data.writeBigUInt64LE(fees.solverFeeAtoms, offset);
  offset += 8;
  data.writeBigUInt64LE(envelope.nonce, offset);
  offset += 8;
  envelope.solver.toBuffer().copy(data, offset);
  offset += 32;
  data.writeBigUInt64LE(slot, offset);
  offset += 8;
  data[offset++] = 1;
  assert.equal(offset, data.length);
  return Uint8Array.from(data);
}

test('compiles a solver-authorized typed strategy instruction', () => {
  assert.equal(
    deriveSolanaMultiStrategyAccount({ programId: multiStrategyProgram, owner }).toBase58(),
    strategyAccount.toBase58(),
  );
  const envelope = compileSolanaMultiStrategyAccountEnvelope(baseInput());
  assert.equal(envelope.instruction.programId.toBase58(), multiStrategyProgram.toBase58());
  assert.equal(envelope.instruction.data.subarray(0, 8).toString('hex'), '4ca9b2623392f612');
  assert.deepEqual(envelope.requiredSignerPubkeys, [owner.toBase58(), solver.toBase58()].sort());
  assert.equal(envelope.instruction.keys[20]?.pubkey.toBase58(), strategyAccount.toBase58());
  assert.equal(envelope.instruction.keys[20]?.isSigner, false);
  assert.equal(envelope.fees?.protocolFeeAtoms, 1n);
  assert.equal(envelope.executionHash.length, 32);
  assert.equal(envelope.callsHash.length, 32);
});

test('compiles owner-only recovery and rejects malformed economic bounds', () => {
  const { solver: _solver, fees: _fees, ...recoveryInput } = baseInput();
  const recovery = compileSolanaMultiStrategyAccountEnvelope({
    ...recoveryInput,
    operation: 'EXIT',
    previousStateHash: hash(20),
    nextStateHash: new Uint8Array(32),
    policies: [policy(false)],
  });
  assert.equal(recovery.instruction.data.subarray(0, 8).toString('hex'), 'b0a04e24e8d78f91');
  assert.deepEqual(recovery.requiredSignerPubkeys, [owner.toBase58()]);
  assert.throws(
    () => compileSolanaMultiStrategyAccountEnvelope({
      ...baseInput(),
      totalGrossNotionalAtoms: 99n,
    }),
    /gross notional must equal the sum of call notionals/,
  );
  assert.throws(
    () => compileSolanaMultiStrategyAccountEnvelope({
      ...baseInput(),
      operation: 'EXIT',
      previousStateHash: hash(20),
      nextStateHash: new Uint8Array(32),
      policies: [policy(true)],
    }),
    /risk direction conflicts/,
  );
  assert.throws(
    () => compileSolanaMultiStrategyAccountEnvelope({
      ...baseInput(),
      packageId: hash(21),
    }),
    /compiled plan package id mismatch/,
  );
});

test('binds a final allocation authorization to exact Solana execution data', () => {
  const envelope = compileSolanaMultiStrategyAccountEnvelope(baseInput());
  const authorization = nettingAuthorization(envelope);
  const netting = compileSolanaNettingAllocationEnvelope({ envelope, authorization });
  assert.equal(netting.instruction.data.subarray(0, 8).toString('hex'), '7029a21484063beb');
  assert.equal(
    netting.instruction.data.subarray(-32).toString('hex'),
    Buffer.from(authorization.authorizationHash).toString('hex'),
  );
  assert.deepEqual(netting.requiredSignerPubkeys, [owner.toBase58(), solver.toBase58()].sort());
  assert.equal(netting.instruction.keys[20]?.pubkey.toBase58(), strategyAccount.toBase58());
});

test('rejects a netting authorization for another Solana call plan', () => {
  const envelope = compileSolanaMultiStrategyAccountEnvelope(baseInput());
  assert.throws(
    () => compileSolanaNettingAllocationEnvelope({
      envelope,
      authorization: {
        ...nettingAuthorization(envelope),
        executionPlanHash: commitmentHash(hash(40)),
      },
    }),
    /execution plan mismatch/,
  );
});

test('observes only the exact finalized Solana netting execution', () => {
  const envelope = compileSolanaMultiStrategyAccountEnvelope(baseInput());
  const netting = compileSolanaNettingAllocationEnvelope({
    envelope,
    authorization: nettingAuthorization(envelope),
  });
  const slot = 490n;
  const instruction = {
    programId: netting.instruction.programId.toBase58(),
    accounts: netting.instruction.keys.map((account) => account.pubkey.toBase58()),
    data: Uint8Array.from(netting.instruction.data),
  };
  const account = {
    address: envelope.receipt.toBase58(),
    owner: netting.instruction.programId.toBase58(),
    data: receiptData(netting, slot),
  };
  const binding = solanaNettingAllocationObservationBinding(netting);
  verifySolanaNettingAllocationObservationBinding(binding, nettingAuthorization(envelope));
  const observation = observeSolanaNettingAllocation({
    binding,
    slot,
    instructions: [instruction],
    receiptAccount: account,
  });
  assert.equal(observation.observedAtValue, slot);
  assert.deepEqual(observation.authorizationHash, netting.authorizationHash);
  assert.throws(
    () => observeSolanaNettingAllocation({
      binding,
      slot,
      instructions: [instruction],
      receiptAccount: { ...account, data: receiptData(netting, slot + 1n) },
    }),
    /receipt differs/,
  );
});
