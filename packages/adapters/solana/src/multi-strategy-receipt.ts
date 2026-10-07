import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

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
const ACCOUNT_BYTES = 379;
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
    nonce,
    solver,
    executionSlot,
    bump,
  });
}
