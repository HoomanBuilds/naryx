import { createHash } from 'node:crypto';
import type { CompiledStrategyExecution } from '@naryx/adapter-core';
import type { DomainRef } from '@naryx/protocol-types';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import type { SolanaStrategyInstructionPlan } from './strategy-plan.js';

const EXECUTE_DISCRIMINATOR = Buffer.from('4ca9b2623392f612', 'hex');
const RECOVERY_DISCRIMINATOR = Buffer.from('b0a04e24e8d78f91', 'hex');
const EXECUTION_HASH_DOMAIN = Buffer.from('naryx.solana.multi-strategy.execution.v1', 'ascii');
const CALLS_HASH_DOMAIN = Buffer.from('naryx.solana.multi-strategy.calls.v1', 'ascii');
const ZERO_HASH = new Uint8Array(32);
const U64_MAX = (1n << 64n) - 1n;

export type SolanaStrategyOperation =
  | 'ENTRY'
  | 'INCREASE'
  | 'DECREASE'
  | 'REBALANCE'
  | 'ROLL'
  | 'MIGRATE'
  | 'EXIT'
  | 'EMERGENCY_UNWIND';

const OPERATION: Readonly<Record<SolanaStrategyOperation, number>> = Object.freeze({
  ENTRY: 0,
  INCREASE: 1,
  DECREASE: 2,
  REBALANCE: 3,
  ROLL: 4,
  MIGRATE: 5,
  EXIT: 6,
  EMERGENCY_UNWIND: 7,
});

export interface SolanaStrategyAdapterPolicy {
  readonly legId: string;
  readonly adapterSubjectId: Uint8Array;
  readonly adapterManifestVersion: number;
  readonly adapterManifestHash: Uint8Array;
  readonly adapterProgram: PublicKey | string;
  readonly adapterProgramData: PublicKey | string;
  readonly riskIncreasing: boolean;
  readonly grossNotionalAtoms: bigint;
}

export interface SolanaMultiStrategyEnvelope {
  readonly instruction: TransactionInstruction;
  readonly executionHash: Uint8Array;
  readonly callsHash: Uint8Array;
  readonly strategyAccount: PublicKey;
  readonly position: PublicKey;
  readonly receipt: PublicKey;
  readonly requiredSignerPubkeys: readonly string[];
}

class Encoder {
  readonly #parts: Buffer[] = [];

  bytes(value: Uint8Array): this {
    this.#parts.push(Buffer.from(value));
    return this;
  }

  bool(value: boolean): this {
    this.#parts.push(Buffer.from([value ? 1 : 0]));
    return this;
  }

  u8(value: number, context: string): this {
    requireCondition(Number.isInteger(value) && value >= 0 && value <= 0xff, `${context} must fit u8`);
    this.#parts.push(Buffer.from([value]));
    return this;
  }

  u32(value: number, context: string): this {
    requireCondition(Number.isInteger(value) && value > 0 && value <= 0xffff_ffff, `${context} must fit nonzero u32`);
    const encoded = Buffer.allocUnsafe(4);
    encoded.writeUInt32LE(value);
    this.#parts.push(encoded);
    return this;
  }

  u64(value: bigint, context: string): this {
    requireCondition(value >= 0n && value <= U64_MAX, `${context} must fit u64`);
    const encoded = Buffer.allocUnsafe(8);
    encoded.writeBigUInt64LE(value);
    this.#parts.push(encoded);
    return this;
  }

  string(value: string, context: string): this {
    requireCondition(value.length > 0 && /^[\x20-\x7e]+$/.test(value), `${context} must be nonempty ASCII`);
    const encoded = Buffer.from(value, 'ascii');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32LE(encoded.length);
    this.#parts.push(length, encoded);
    return this;
  }

  vector(value: Uint8Array): this {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32LE(value.length);
    this.#parts.push(length, Buffer.from(value));
    return this;
  }

  finish(): Buffer {
    return Buffer.concat(this.#parts);
  }
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function key(value: PublicKey | string, context: string): PublicKey {
  try {
    return value instanceof PublicKey ? value : new PublicKey(value);
  } catch {
    throw new Error(`${context} must be a Solana public key`);
  }
}

function hash32(value: Uint8Array, context: string, allowZero = false): Uint8Array {
  requireCondition(value.length === 32 && (allowZero || value.some((byte) => byte !== 0)), `${context} must be ${allowZero ? 'a' : 'a nonzero'} 32-byte value`);
  return Uint8Array.from(value);
}

function hash(domain: Buffer, payload: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(domain).update(payload).digest());
}

function encodeDomain(encoder: Encoder, domain: DomainRef): void {
  encoder
    .string(domain.domainId, 'domain id')
    .u32(domain.domainManifestVersion, 'domain manifest version')
    .bytes(hash32(domain.domainManifestHash, 'domain manifest hash'));
}

function encodeDescriptor(
  encoder: Encoder,
  id: string,
  version: number,
  manifestHash: Uint8Array,
  context: string,
): void {
  encoder
    .string(id, `${context} id`)
    .u32(version, `${context} version`)
    .bytes(hash32(manifestHash, `${context} manifest hash`));
}

function pda(program: PublicKey, seeds: readonly Uint8Array[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds.map((seed) => Buffer.from(seed)), program)[0];
}

function u32be(value: number): Uint8Array {
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32BE(value);
  return result;
}

function u64be(value: bigint): Uint8Array {
  requireCondition(value >= 0n && value <= U64_MAX, 'nonce must fit u64');
  const result = Buffer.allocUnsafe(8);
  result.writeBigUInt64BE(value);
  return result;
}

function policyFor(legId: string, values: readonly SolanaStrategyAdapterPolicy[]): SolanaStrategyAdapterPolicy {
  const matches = values.filter((value) => value.legId === legId);
  requireCondition(matches.length === 1, `leg ${legId} must resolve to exactly one account policy`);
  return matches[0]!;
}

function riskDirectionAllowed(operation: SolanaStrategyOperation, riskIncreasing: boolean): boolean {
  if (operation === 'ENTRY' || operation === 'INCREASE') return riskIncreasing;
  if (operation === 'DECREASE' || operation === 'EXIT' || operation === 'EMERGENCY_UNWIND') return !riskIncreasing;
  return true;
}

export function compileSolanaMultiStrategyAccountEnvelope(input: Readonly<{
  compiled: CompiledStrategyExecution<SolanaStrategyInstructionPlan>;
  coreProgramId: PublicKey | string;
  multiStrategyProgramId: PublicKey | string;
  owner: PublicKey | string;
  solver?: PublicKey | string;
  operation: SolanaStrategyOperation;
  packageId: Uint8Array;
  templateId: string;
  templateVersion: number;
  templateManifestHash: Uint8Array;
  settlementManifestHash: Uint8Array;
  previousStateHash?: Uint8Array;
  nextStateHash?: Uint8Array;
  totalGrossNotionalAtoms: bigint;
  nonce: bigint;
  deadlineSlot: bigint;
  policies: readonly SolanaStrategyAdapterPolicy[];
}>): SolanaMultiStrategyEnvelope {
  const { compiled, operation } = input;
  const plan = compiled.payload;
  requireCondition(plan.version === 1 && plan.planKind === 'SVM_ATOMIC_CPI' && plan.guarantee === 'ATOMIC_POSTCONDITION', 'multi-strategy account requires an atomic SVM plan');
  requireCondition(plan.instructions.length > 0 && plan.instructions.length <= 8, 'multi-strategy account requires 1 to 8 calls');
  requireCondition(plan.instructions.length === input.policies.length, 'adapter policies do not cover the plan exactly');
  requireCondition(input.totalGrossNotionalAtoms > 0n && input.totalGrossNotionalAtoms <= U64_MAX, 'total gross notional must fit nonzero u64');
  requireCondition(input.deadlineSlot > 0n && input.deadlineSlot <= U64_MAX, 'deadline slot must fit nonzero u64');
  const coreProgram = key(input.coreProgramId, 'core program');
  const program = key(input.multiStrategyProgramId, 'multi-strategy program');
  const owner = key(input.owner, 'owner');
  const recovery = operation === 'DECREASE' || operation === 'EXIT' || operation === 'EMERGENCY_UNWIND'
    ? input.solver === undefined
    : false;
  const solver = recovery
    ? PublicKey.default
    : key(input.solver ?? PublicKey.default, 'solver');
  requireCondition(recovery || !solver.equals(PublicKey.default), 'normal execution requires a solver');
  const strategyAccount = pda(program, [Buffer.from('multi-strategy-account'), owner.toBuffer()]);
  requireCondition(key(plan.feePayer, 'plan fee payer').equals(owner), 'plan fee payer must be the strategy owner');
  const packageId = hash32(input.packageId, 'package id');
  requireCondition(Buffer.from(plan.packageId).equals(Buffer.from(packageId)), 'compiled plan package id mismatch');
  const position = pda(program, [Buffer.from('strategy-position'), strategyAccount.toBuffer(), packageId]);
  const receipt = pda(program, [Buffer.from('strategy-receipt'), strategyAccount.toBuffer(), u64be(input.nonce)]);
  const config = pda(coreProgram, [Buffer.from('naryx-protocol-config')]);
  const solverRegistry = pda(coreProgram, [Buffer.from('conformance-solver')]);
  const previousStateHash = hash32(input.previousStateHash ?? ZERO_HASH, 'previous state hash', true);
  const nextStateHash = hash32(input.nextStateHash ?? ZERO_HASH, 'next state hash', true);
  requireCondition((operation === 'ENTRY') === previousStateHash.every((byte) => byte === 0), 'entry is the only operation without a previous state');
  requireCondition((operation === 'EXIT' || operation === 'EMERGENCY_UNWIND') === nextStateHash.every((byte) => byte === 0), 'only terminal operations produce a zero next state');

  const callsEncoder = new Encoder().u32(plan.instructions.length, 'call count');
  const remainingKeys: AccountMeta[] = [];
  let grossNotional = 0n;
  let previousStage = 0;
  for (const [index, record] of plan.instructions.entries()) {
    requireCondition(index === 0 ? record.stage === 0 : record.stage >= previousStage && record.stage <= previousStage + 1, 'strategy call stages must be contiguous from zero');
    previousStage = record.stage;
    const policy = policyFor(record.legId, input.policies);
    const adapterProgram = key(policy.adapterProgram, `leg ${record.legId} adapter program`);
    requireCondition(adapterProgram.equals(record.instruction.programId), `leg ${record.legId} adapter program mismatch`);
    requireCondition(riskDirectionAllowed(operation, policy.riskIncreasing), `leg ${record.legId} risk direction conflicts with the lifecycle operation`);
    requireCondition(policy.grossNotionalAtoms > 0n && policy.grossNotionalAtoms <= U64_MAX, `leg ${record.legId} gross notional must fit nonzero u64`);
    requireCondition(record.instruction.keys.length > 0 && record.instruction.keys.length <= 24, `leg ${record.legId} has an invalid account count`);
    const strategySigners = record.instruction.keys.filter((meta) => meta.isSigner && meta.pubkey.equals(strategyAccount));
    requireCondition(strategySigners.length === 1 && record.instruction.keys.every((meta) => !meta.isSigner || meta.pubkey.equals(strategyAccount)), `leg ${record.legId} must use only the strategy account as signer`);
    const adapterSubjectId = hash32(policy.adapterSubjectId, `leg ${record.legId} adapter subject`);
    const adapterManifestHash = hash32(policy.adapterManifestHash, `leg ${record.legId} adapter manifest`);
    callsEncoder
      .bytes(adapterSubjectId)
      .u32(policy.adapterManifestVersion, `leg ${record.legId} adapter version`)
      .bytes(adapterManifestHash)
      .u8(record.stage, `leg ${record.legId} stage`)
      .bool(policy.riskIncreasing)
      .u64(policy.grossNotionalAtoms, `leg ${record.legId} gross notional`)
      .u8(record.instruction.keys.length, `leg ${record.legId} account count`)
      .vector(record.instruction.data);
    const resourceIndex = pda(coreProgram, [Buffer.from('naryx-resource-index'), Buffer.from('adapter'), adapterSubjectId]);
    const resourceRecord = pda(coreProgram, [Buffer.from('naryx-resource-record'), Buffer.from('adapter'), adapterSubjectId, u32be(policy.adapterManifestVersion)]);
    remainingKeys.push(
      { pubkey: resourceIndex, isSigner: false, isWritable: false },
      { pubkey: resourceRecord, isSigner: false, isWritable: false },
      { pubkey: adapterProgram, isSigner: false, isWritable: false },
      { pubkey: key(policy.adapterProgramData, `leg ${record.legId} adapter program data`), isSigner: false, isWritable: false },
      ...record.instruction.keys.map((meta) => ({ ...meta, isSigner: false })),
    );
    grossNotional += policy.grossNotionalAtoms;
  }
  requireCondition(grossNotional === input.totalGrossNotionalAtoms, 'execution gross notional must equal the sum of call notionals');

  const executionEncoder = new Encoder();
  encodeDomain(executionEncoder, plan.domain);
  executionEncoder
    .bytes(packageId)
    .bytes(hash32(compiled.orderHash, 'order hash'))
    .bytes(hash32(compiled.graphHash, 'graph hash'))
    .bytes(hash32(compiled.quoteHash, 'quote hash'))
    .bytes(hash32(compiled.routeHash, 'route hash'));
  encodeDescriptor(executionEncoder, input.templateId, input.templateVersion, input.templateManifestHash, 'template');
  executionEncoder
    .u8(0, 'atomic settlement discriminant')
    .u32(1, 'atomic settlement version')
    .bytes(hash32(input.settlementManifestHash, 'settlement manifest hash'))
    .u8(OPERATION[operation], 'strategy operation')
    .bytes(previousStateHash)
    .bytes(nextStateHash)
    .u64(input.totalGrossNotionalAtoms, 'total gross notional')
    .bytes(solver.toBuffer())
    .u64(input.nonce, 'nonce')
    .u64(input.deadlineSlot, 'deadline slot');
  const executionBytes = executionEncoder.finish();
  const callsBytes = callsEncoder.finish();
  const baseKeys: AccountMeta[] = recovery
    ? [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: strategyAccount, isSigner: false, isWritable: true },
        { pubkey: position, isSigner: false, isWritable: true },
        { pubkey: receipt, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ]
    : [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: solver, isSigner: true, isWritable: false },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: solverRegistry, isSigner: false, isWritable: false },
        { pubkey: strategyAccount, isSigner: false, isWritable: true },
        { pubkey: position, isSigner: false, isWritable: true },
        { pubkey: receipt, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
  const instruction = new TransactionInstruction({
    programId: program,
    keys: [...baseKeys, ...remainingKeys],
    data: Buffer.concat([recovery ? RECOVERY_DISCRIMINATOR : EXECUTE_DISCRIMINATOR, executionBytes, callsBytes]),
  });
  return Object.freeze({
    instruction,
    executionHash: hash(EXECUTION_HASH_DOMAIN, executionBytes),
    callsHash: hash(CALLS_HASH_DOMAIN, callsBytes),
    strategyAccount,
    position,
    receipt,
    requiredSignerPubkeys: Object.freeze(recovery ? [owner.toBase58()] : [owner.toBase58(), solver.toBase58()].sort()),
  });
}
