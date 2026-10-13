import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  SOLANA_DEVNET_GENESIS_HASH,
  type SolanaMultiStrategyEnvelope,
  type SolanaMultiStrategyStagePlan,
} from '@naryx/adapter-solana';
import type { SolanaDevnetSolverReadPort } from './solana-devnet-rpc.js';

const STAGE_DISCRIMINATOR = createHash('sha256').update('account:StrategyExecutionStage').digest().subarray(0, 8);
const STAGE_HEADER_BYTES = 128;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Solana strategy stage refused: ${message}`);
}

export interface SolanaStrategyStageObservation {
  readonly exists: boolean;
  readonly sealed: boolean;
  readonly writtenBytes: number;
  readonly stale: boolean;
}

export async function observeSolanaStrategyStage(
  reader: SolanaDevnetSolverReadPort,
  envelope: SolanaMultiStrategyEnvelope,
  plan: SolanaMultiStrategyStagePlan,
): Promise<SolanaStrategyStageObservation> {
  requireCondition(await reader.getGenesisHash() === SOLANA_DEVNET_GENESIS_HASH, 'RPC is not Solana Devnet');
  const slot = await reader.getFinalizedSlot();
  requireCondition(slot < envelope.deadlineSlot, 'execution deadline has passed');
  const [account] = await reader.getAccounts([plan.address.toBase58()], slot);
  if (account === null || account === undefined) return Object.freeze({ exists: false, sealed: false, writtenBytes: 0, stale: false });
  requireCondition(account.owner === envelope.instruction.programId.toBase58(), 'stage program owner mismatch');
  const data = Buffer.from(account.data);
  requireCondition(data.length >= STAGE_HEADER_BYTES && data.subarray(0, 8).equals(STAGE_DISCRIMINATOR),
    'stage account discriminator mismatch');
  const owner = new PublicKey(data.subarray(8, 40));
  const solver = new PublicKey(data.subarray(40, 72));
  const nonce = data.readBigUInt64LE(72);
  const deadline = data.readBigUInt64LE(80);
  const expectedHash = data.subarray(88, 120);
  const payloadLength = data.readUInt16LE(120);
  const sealed = data[122];
  const writtenBytes = data.readUInt32LE(124);
  const expectedPayload = envelope.instruction.data.subarray(8);
  requireCondition(owner.equals(envelope.owner) && nonce === envelope.nonce,
    'stage owner or nonce differs from the strategy account');
  const stale = !solver.equals(envelope.solver)
    || deadline !== envelope.deadlineSlot
    || !expectedHash.equals(Buffer.from(plan.payloadHash))
    || payloadLength !== expectedPayload.length
    || (sealed !== 0 && sealed !== 1)
    || writtenBytes > payloadLength
    || data.length < STAGE_HEADER_BYTES + writtenBytes
    || (writtenBytes !== payloadLength && writtenBytes % 512 !== 0)
    || (sealed === 1 && writtenBytes !== payloadLength)
    || !data.subarray(STAGE_HEADER_BYTES, STAGE_HEADER_BYTES + writtenBytes)
      .equals(Buffer.from(expectedPayload.subarray(0, writtenBytes)));
  return Object.freeze({ exists: true, sealed: sealed === 1 && !stale, writtenBytes, stale });
}
