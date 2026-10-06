import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompiledStrategyExecution } from '@naryx/adapter-core';
import type { DomainRef } from '@naryx/protocol-types';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  compileSolanaMultiStrategyAccountEnvelope,
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
    nonce: 1n,
    deadlineSlot: 500n,
    policies: [policy(true)],
  };
}

test('compiles a solver-authorized typed strategy instruction', () => {
  const envelope = compileSolanaMultiStrategyAccountEnvelope(baseInput());
  assert.equal(envelope.instruction.programId.toBase58(), multiStrategyProgram.toBase58());
  assert.equal(envelope.instruction.data.subarray(0, 8).toString('hex'), '4ca9b2623392f612');
  assert.deepEqual(envelope.requiredSignerPubkeys, [owner.toBase58(), solver.toBase58()].sort());
  assert.equal(envelope.instruction.keys[12]?.pubkey.toBase58(), strategyAccount.toBase58());
  assert.equal(envelope.instruction.keys[12]?.isSigner, false);
  assert.equal(envelope.executionHash.length, 32);
  assert.equal(envelope.callsHash.length, 32);
});

test('compiles owner-only recovery and rejects malformed economic bounds', () => {
  const { solver: _solver, ...recoveryInput } = baseInput();
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
