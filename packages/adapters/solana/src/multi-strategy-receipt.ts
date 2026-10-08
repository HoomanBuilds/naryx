import { createHash } from 'node:crypto';
import type { DomainRef } from '@naryx/protocol-types';
import { PublicKey } from '@solana/web3.js';
import type {
  SolanaNettingAllocationEnvelope,
  SolanaStrategyOperation,
} from './multi-strategy-account.js';

const ACCOUNT_DISCRIMINATOR = createHash('sha256')
  .update('account:StrategyReceipt', 'ascii')
  .digest()
  .subarray(0, 8);
const RECEIPT_HASH_DOMAIN = Buffer.from('naryx.solana.multi-strategy.receipt.v1', 'ascii');
const EVIDENCE_ROOT_DOMAIN = Buffer.from('naryx.solana.multi-strategy.evidence.v1', 'ascii');
const LEG_EVENT_DISCRIMINATOR = createHash('sha256')
  .update('event:StrategyAdapterLegExecuted', 'ascii')
  .digest()
  .subarray(0, 8);
const ACCOUNT_BYTES = 532;
const LEG_EVENT_BYTES = 106;

export type SolanaStrategyReceiptOperation =
  | 'ENTRY'
  | 'INCREASE'
  | 'DECREASE'
  | 'REBALANCE'
  | 'ROLL'
  | 'MIGRATE'
  | 'EXIT'
  | 'EMERGENCY_UNWIND';

const OPERATIONS: readonly SolanaStrategyReceiptOperation[] = Object.freeze([
  'ENTRY',
  'INCREASE',
  'DECREASE',
  'REBALANCE',
  'ROLL',
  'MIGRATE',
  'EXIT',
  'EMERGENCY_UNWIND',
]);

export interface DecodedSolanaStrategyReceipt {
  readonly version: 1;
  readonly packageId: Uint8Array;
  readonly orderHash: Uint8Array;
  readonly graphHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly routeHash: Uint8Array;
  readonly operation: SolanaStrategyReceiptOperation;
  readonly previousStateHash: Uint8Array;
  readonly nextStateHash: Uint8Array;
  readonly callsHash: Uint8Array;
  readonly evidenceRoot: Uint8Array;
  readonly receiptHash: Uint8Array;
  readonly nettingAuthorizationHash: Uint8Array;
  readonly fees: Readonly<{
    direction: 'ENTRY' | 'EXIT';
    quoteAssetSubjectId: Uint8Array;
    quoteAssetManifestVersion: number;
    quoteAssetManifestHash: Uint8Array;
    policyVersion: number;
    policyManifestHash: Uint8Array;
    protocolFeeAtoms: bigint;
    solverFeeAtoms: bigint;
  }>;
  readonly nonce: bigint;
  readonly solver: PublicKey;
  readonly executionSlot: bigint;
  readonly bump: number;
}

export interface DecodedSolanaStrategyAdapterLegEvent {
  readonly receipt: PublicKey;
  readonly callIndex: number;
  readonly adapterSubjectId: Uint8Array;
  readonly stage: number;
  readonly evidenceHash: Uint8Array;
}

export interface SolanaObservedNettingInstruction {
  readonly programId: string;
  readonly accounts: readonly string[];
  readonly data: Uint8Array;
}

export interface SolanaNettingAllocationObservation {
  readonly observedAtUnit: 'SOLANA_SLOT';
  readonly observedAtValue: bigint;
  readonly receiptAccount: string;
  readonly receiptHash: Uint8Array;
  readonly evidenceRoot: Uint8Array;
  readonly authorizationHash: Uint8Array;
}

export interface SolanaNettingAllocationObservationBinding {
  readonly authorizationHash: Uint8Array;
  readonly domain: DomainRef;
  readonly programId: string;
  readonly instructionAccounts: readonly string[];
  readonly instructionData: Uint8Array;
  readonly executionHash: Uint8Array;
  readonly callsHash: Uint8Array;
  readonly owner: string;
  readonly solver: string;
  readonly strategyAccount: string;
  readonly receiptAccount: string;
  readonly packageId: Uint8Array;
  readonly orderHash: Uint8Array;
  readonly graphHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly routeHash: Uint8Array;
  readonly operation: SolanaStrategyOperation;
  readonly previousStateHash: Uint8Array;
  readonly nextStateHash: Uint8Array;
  readonly nonce: bigint;
  readonly deadlineSlot: bigint;
  readonly fees: Readonly<{
    quoteAssetSubjectId: Uint8Array;
    quoteAssetManifestVersion: number;
    quoteAssetManifestHash: Uint8Array;
    policyVersion: number;
    policyManifestHash: Uint8Array;
    protocolFeeAtoms: bigint;
    solverFeeAtoms: bigint;
  }>;
}

function fail(message: string): never {
  throw new Error(`Solana strategy receipt: ${message}`);
}

function readBytes(data: Buffer, offset: number, length: number): Uint8Array {
  return Uint8Array.from(data.subarray(offset, offset + length));
}

export function solanaMultiStrategyReceiptHash(input: Readonly<{
  executionHash: Uint8Array;
  callsHash: Uint8Array;
  evidenceRoot: Uint8Array;
}>): Uint8Array {
  for (const [name, value] of Object.entries(input)) {
    if (value.length !== 32) fail(`${name} must be 32 bytes`);
  }
  return Uint8Array.from(createHash('sha256')
    .update(RECEIPT_HASH_DOMAIN)
    .update(input.executionHash)
    .update(input.callsHash)
    .update(input.evidenceRoot)
    .digest());
}

export function solanaMultiStrategyEvidenceRoot(evidence: readonly Uint8Array[]): Uint8Array {
  if (evidence.length === 0) fail('evidence sequence must not be empty');
  const hash = createHash('sha256').update(EVIDENCE_ROOT_DOMAIN);
  for (const [index, value] of evidence.entries()) {
    if (value.length !== 32 || value.every((byte) => byte === 0)) {
      fail(`evidence ${index} must be 32 nonzero bytes`);
    }
    hash.update(value);
  }
  return Uint8Array.from(hash.digest());
}

export function decodeSolanaStrategyAdapterLegEvent(
  value: Uint8Array,
): DecodedSolanaStrategyAdapterLegEvent | undefined {
  const data = Buffer.from(value);
  if (data.length < 8 || !data.subarray(0, 8).equals(LEG_EVENT_DISCRIMINATOR)) return undefined;
  if (data.length !== LEG_EVENT_BYTES) fail(`adapter leg event must be exactly ${LEG_EVENT_BYTES} bytes`);
  const receipt = new PublicKey(data.subarray(8, 40));
  const callIndex = data[40]!;
  const adapterSubjectId = readBytes(data, 41, 32);
  const stage = data[73]!;
  const evidenceHash = readBytes(data, 74, 32);
  if (evidenceHash.every((byte) => byte === 0)) fail('adapter leg evidence hash is zero');
  return Object.freeze({ receipt, callIndex, adapterSubjectId, stage, evidenceHash });
}

export function decodeSolanaMultiStrategyReceipt(value: Uint8Array): DecodedSolanaStrategyReceipt {
  const data = Buffer.from(value);
  if (data.length !== ACCOUNT_BYTES) fail(`account must be exactly ${ACCOUNT_BYTES} bytes`);
  if (!data.subarray(0, 8).equals(ACCOUNT_DISCRIMINATOR)) fail('account discriminator is invalid');
  let offset = 8;
  const version = data[offset++];
  if (version !== 1) fail('version is unsupported');
  const takeHash = () => {
    const result = readBytes(data, offset, 32);
    offset += 32;
    return result;
  };
  const packageId = takeHash();
  const orderHash = takeHash();
  const graphHash = takeHash();
  const quoteHash = takeHash();
  const routeHash = takeHash();
  const operation = OPERATIONS[data[offset++]!];
  if (operation === undefined) fail('operation is unsupported');
  const previousStateHash = takeHash();
  const nextStateHash = takeHash();
  const callsHash = takeHash();
  const evidenceRoot = takeHash();
  const receiptHash = takeHash();
  const nettingAuthorizationHash = takeHash();
  const feeDirectionDiscriminant = data[offset++]!;
  if (feeDirectionDiscriminant > 1) fail('fee direction is unsupported');
  const quoteAssetSubjectId = takeHash();
  const quoteAssetManifestVersion = data.readUInt32LE(offset);
  offset += 4;
  const quoteAssetManifestHash = takeHash();
  const policyVersion = data.readUInt32LE(offset);
  offset += 4;
  const policyManifestHash = takeHash();
  const protocolFeeAtoms = data.readBigUInt64LE(offset);
  offset += 8;
  const solverFeeAtoms = data.readBigUInt64LE(offset);
  offset += 8;
  const nonce = data.readBigUInt64LE(offset);
  offset += 8;
  const solver = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const executionSlot = data.readBigUInt64LE(offset);
  offset += 8;
  const bump = data[offset++]!;
  if (offset !== data.length) fail('account contains trailing bytes');
  return Object.freeze({
    version,
    packageId,
    orderHash,
    graphHash,
    quoteHash,
    routeHash,
    operation,
    previousStateHash,
    nextStateHash,
    callsHash,
    evidenceRoot,
    receiptHash,
    nettingAuthorizationHash,
    fees: Object.freeze({
      direction: feeDirectionDiscriminant === 0 ? 'ENTRY' : 'EXIT',
      quoteAssetSubjectId,
      quoteAssetManifestVersion,
      quoteAssetManifestHash,
      policyVersion,
      policyManifestHash,
      protocolFeeAtoms,
      solverFeeAtoms,
    }),
    nonce,
    solver,
    executionSlot,
    bump,
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function sameAddresses(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function solanaNettingAllocationObservationBinding(
  netting: SolanaNettingAllocationEnvelope,
): SolanaNettingAllocationObservationBinding {
  const envelope = netting.envelope;
  if (envelope.fees === undefined) fail('authorized netting execution has no fee terms');
  return Object.freeze({
    authorizationHash: Uint8Array.from(netting.authorizationHash),
    domain: envelope.domain,
    programId: netting.instruction.programId.toBase58(),
    instructionAccounts: Object.freeze(netting.instruction.keys.map((account) => account.pubkey.toBase58())),
    instructionData: Uint8Array.from(netting.instruction.data),
    executionHash: Uint8Array.from(envelope.executionHash),
    callsHash: Uint8Array.from(envelope.callsHash),
    owner: envelope.owner.toBase58(),
    solver: envelope.solver.toBase58(),
    strategyAccount: envelope.strategyAccount.toBase58(),
    receiptAccount: envelope.receipt.toBase58(),
    packageId: Uint8Array.from(envelope.packageId),
    orderHash: Uint8Array.from(envelope.orderHash),
    graphHash: Uint8Array.from(envelope.graphHash),
    quoteHash: Uint8Array.from(envelope.quoteHash),
    routeHash: Uint8Array.from(envelope.routeHash),
    operation: envelope.operation,
    previousStateHash: Uint8Array.from(envelope.previousStateHash),
    nextStateHash: Uint8Array.from(envelope.nextStateHash),
    nonce: envelope.nonce,
    deadlineSlot: envelope.deadlineSlot,
    fees: Object.freeze({
      quoteAssetSubjectId: Uint8Array.from(envelope.fees.quoteAssetSubjectId),
      quoteAssetManifestVersion: envelope.fees.quoteAssetManifestVersion,
      quoteAssetManifestHash: Uint8Array.from(envelope.fees.quoteAssetManifestHash),
      policyVersion: envelope.fees.policyVersion,
      policyManifestHash: Uint8Array.from(envelope.fees.policyManifestHash),
      protocolFeeAtoms: envelope.fees.protocolFeeAtoms,
      solverFeeAtoms: envelope.fees.solverFeeAtoms,
    }),
  });
}

export function observeSolanaNettingAllocation(input: Readonly<{
  binding: SolanaNettingAllocationObservationBinding;
  slot: bigint;
  instructions: readonly SolanaObservedNettingInstruction[];
  receiptAccount: Readonly<{ address: string; owner: string; data: Uint8Array }>;
}>): SolanaNettingAllocationObservation {
  if (input.slot <= 0n) fail('observation slot must be positive');
  const expected = input.binding;
  const matchingInstructions = input.instructions.filter((instruction) =>
    instruction.programId === expected.programId
      && sameAddresses(instruction.accounts, expected.instructionAccounts)
      && sameBytes(instruction.data, expected.instructionData));
  if (matchingInstructions.length !== 1) fail('finalized transaction must contain the exact netting instruction once');
  if (input.receiptAccount.address !== expected.receiptAccount) {
    fail('receipt account address is invalid');
  }
  if (input.receiptAccount.owner !== expected.programId) fail('receipt account owner is invalid');
  const receipt = decodeSolanaMultiStrategyReceipt(input.receiptAccount.data);
  if (
    !sameBytes(receipt.packageId, expected.packageId)
      || !sameBytes(receipt.orderHash, expected.orderHash)
      || !sameBytes(receipt.graphHash, expected.graphHash)
      || !sameBytes(receipt.quoteHash, expected.quoteHash)
      || !sameBytes(receipt.routeHash, expected.routeHash)
      || receipt.operation !== expected.operation
      || !sameBytes(receipt.previousStateHash, expected.previousStateHash)
      || !sameBytes(receipt.nextStateHash, expected.nextStateHash)
      || !sameBytes(receipt.callsHash, expected.callsHash)
      || !sameBytes(receipt.nettingAuthorizationHash, expected.authorizationHash)
      || receipt.nonce !== expected.nonce
      || receipt.solver.toBase58() !== expected.solver
      || receipt.executionSlot !== input.slot
  ) {
    fail('stored receipt differs from the authorized netting execution');
  }
  const fees = expected.fees;
  const direction = expected.operation === 'ENTRY' || expected.operation === 'INCREASE' ? 'ENTRY' : 'EXIT';
  if (
    receipt.fees.direction !== direction
      || !sameBytes(receipt.fees.quoteAssetSubjectId, fees.quoteAssetSubjectId)
      || receipt.fees.quoteAssetManifestVersion !== fees.quoteAssetManifestVersion
      || !sameBytes(receipt.fees.quoteAssetManifestHash, fees.quoteAssetManifestHash)
      || receipt.fees.policyVersion !== fees.policyVersion
      || !sameBytes(receipt.fees.policyManifestHash, fees.policyManifestHash)
      || receipt.fees.protocolFeeAtoms !== fees.protocolFeeAtoms
      || receipt.fees.solverFeeAtoms !== fees.solverFeeAtoms
  ) {
    fail('stored receipt fee terms differ from the authorized netting execution');
  }
  const expectedReceiptHash = solanaMultiStrategyReceiptHash({
    executionHash: expected.executionHash,
    callsHash: expected.callsHash,
    evidenceRoot: receipt.evidenceRoot,
  });
  if (!sameBytes(receipt.receiptHash, expectedReceiptHash)) fail('stored receipt hash is invalid');
  return Object.freeze({
    observedAtUnit: 'SOLANA_SLOT',
    observedAtValue: input.slot,
    receiptAccount: input.receiptAccount.address,
    receiptHash: Uint8Array.from(receipt.receiptHash),
    evidenceRoot: Uint8Array.from(receipt.evidenceRoot),
    authorizationHash: Uint8Array.from(receipt.nettingAuthorizationHash),
  });
}
