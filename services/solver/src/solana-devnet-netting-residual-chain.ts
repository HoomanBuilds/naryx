import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
} from '@solana/web3.js';
import {
  bytesEqual,
} from '@naryx/protocol-types';
import {
  SOLANA_DEVNET_GENESIS_HASH,
  createBoundedSolanaConnection,
  type SolanaTestPerpNettingResidualObservation,
  type SolanaTestPerpNettingResidualPlan,
} from '@naryx/adapter-solana';
import type {
  SolanaNettingResidualChainObservation,
  SolanaNettingResidualChainPort,
  SolanaNettingResidualSubmission,
} from './solana-netting-residual-runtime.js';

const RECEIPT_DISCRIMINATOR = Buffer.from('01ef7e15b71c45df', 'hex');
const RECEIPT_DATA_LENGTH = 211;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function u64be(value: bigint): Buffer {
  requireCondition(value >= 0n && value <= (1n << 64n) - 1n, 'Solana evidence integer exceeds u64');
  const result = Buffer.allocUnsafe(8);
  result.writeBigUInt64BE(value);
  return result;
}

function digest(domain: string, values: readonly Uint8Array[]): Uint8Array {
  const hash = createHash('sha256').update(domain, 'ascii');
  for (const value of values) hash.update(value);
  return new Uint8Array(hash.digest());
}

function signatureBytes(value: string): Uint8Array {
  try {
    const decoded = bs58.decode(value);
    requireCondition(decoded.length === 64 && bs58.encode(decoded) === value,
      'Solana residual signature is not canonical');
    return Uint8Array.from(decoded);
  } catch {
    throw new Error('Solana residual signature is invalid');
  }
}

function transactionReference(signature: string): Uint8Array {
  return digest('NARYX/solana-netting-residual/signature/v1', [signatureBytes(signature)]);
}

function publicKeyAt(data: Buffer, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

function decodeReceipt(dataValue: Uint8Array) {
  const data = Buffer.from(dataValue);
  requireCondition(data.length === RECEIPT_DATA_LENGTH
    && data.subarray(0, 8).equals(RECEIPT_DISCRIMINATOR),
  'Solana residual receipt layout is invalid');
  const side = data[137];
  requireCondition(data[8] === 1 && (side === 0 || side === 1),
    'Solana residual receipt version or side is invalid');
  return Object.freeze({
    raw: Uint8Array.from(data),
    intentHash: Uint8Array.from(data.subarray(9, 41)),
    authority: publicKeyAt(data, 41),
    market: publicKeyAt(data, 73),
    position: publicKeyAt(data, 105),
    side: side === 0 ? 'BUY' as const : 'SELL' as const,
    baseLots: data.readBigUInt64LE(138),
    limitPriceTicks: data.readBigUInt64LE(146),
    maximumFeeAtoms: data.readBigUInt64LE(154),
    fillPricePerLot: data.readBigUInt64LE(162),
    grossQuoteAtoms: data.readBigUInt64LE(170),
    feeAtoms: data.readBigUInt64LE(178),
    postBaseLots: data.readBigInt64LE(186),
    postCollateralAtoms: data.readBigUInt64LE(194),
    executionSlot: data.readBigUInt64LE(202),
  });
}

function planAccount(plan: SolanaTestPerpNettingResidualPlan, index: number, context: string): string {
  const account = plan.instruction.keys[index];
  requireCondition(account !== undefined, `Solana residual ${context} account is missing`);
  return account.pubkey.toBase58();
}

function rejectedObservation(input: Readonly<{
  plan: SolanaTestPerpNettingResidualPlan;
  submission: SolanaNettingResidualSubmission;
  observedAtSlot: bigint;
  evidenceHash: Uint8Array;
}>): SolanaTestPerpNettingResidualObservation {
  return Object.freeze({
    intentHash: input.plan.intentHash,
    authority: input.plan.executionAccount,
    market: planAccount(input.plan, 1, 'market'),
    position: planAccount(input.plan, 2, 'position'),
    terminalStatus: 'REJECTED' as const,
    side: input.plan.side,
    baseLots: 0n,
    fillPricePerLot: 0n,
    grossQuoteAtoms: 0n,
    feeQuoteAtoms: 0n,
    executionSlot: 0n,
    submittedAtSlot: input.submission.submittedAtSlot ?? input.submission.signedAtSlot,
    observedAtSlot: input.observedAtSlot,
    executionReferenceHash: transactionReference(input.submission.signature),
    authoritativeEvidenceHash: input.evidenceHash,
  });
}

function ambiguousBroadcast(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = (current as Error & { cause?: unknown }).cause) {
    if (/already processed|blockhash not found|fetch failed|timed? ?out|econnreset|http (?:429|502|503|504)/i.test(current.message)) {
      return true;
    }
  }
  return false;
}

export function createSolanaDevnetNettingResidualChain(input: Readonly<{
  rpcUrl: string;
  signer: Keypair;
}>): SolanaNettingResidualChainPort {
  const connection = createBoundedSolanaConnection(input.rpcUrl, 'finalized');
  const account = input.signer.publicKey.toBase58();
  const requireDevnet = async (): Promise<void> => {
    requireCondition(await connection.getGenesisHash() === SOLANA_DEVNET_GENESIS_HASH,
      'Solana residual RPC is not Devnet');
  };
  const chain: SolanaNettingResidualChainPort = {
    account,
    genesisHash: () => connection.getGenesisHash(),
    currentSlot: async () => BigInt(await connection.getSlot('finalized')),
    sign: async ({ plan }) => {
      await requireDevnet();
      const payer = plan.instruction.keys[0];
      requireCondition(plan.executionAccount === account
        && payer !== undefined
        && payer.pubkey.equals(input.signer.publicKey)
        && payer.isSigner,
      'Solana residual plan is not bound to this signer');
      const latest = await connection.getLatestBlockhashAndContext('finalized');
      const signedAtSlot = BigInt(latest.context.slot);
      requireCondition(signedAtSlot < plan.requestExpirySlot,
        'Solana residual expired before signing');
      const message = new TransactionMessage({
        payerKey: input.signer.publicKey,
        recentBlockhash: latest.value.blockhash,
        instructions: [plan.instruction],
      }).compileToV0Message();
      const transaction = new VersionedTransaction(message);
      transaction.sign([input.signer]);
      const signature = bs58.encode(transaction.signatures[0]!);
      return Object.freeze({
        rawTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
        signature,
        recentBlockhash: latest.value.blockhash,
        lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
        signedAtSlot,
      });
    },
    broadcast: async (rawTransactionBase64, expectedSignature) => {
      await requireDevnet();
      const raw = Buffer.from(rawTransactionBase64, 'base64');
      requireCondition(raw.length > 0 && raw.toString('base64') === rawTransactionBase64,
        'Solana residual raw transaction is not canonical base64');
      const transaction = VersionedTransaction.deserialize(raw);
      const signature = bs58.encode(transaction.signatures[0]!);
      requireCondition(signature === expectedSignature
        && transaction.message.staticAccountKeys[0]?.equals(input.signer.publicKey) === true,
      'Solana residual raw transaction differs from its durable signature or signer');
      try {
        const submitted = await connection.sendRawTransaction(raw, {
          skipPreflight: true,
          maxRetries: 0,
          preflightCommitment: 'confirmed',
        });
        requireCondition(submitted === expectedSignature,
          'Solana RPC returned another residual signature');
      } catch (error) {
        if (!ambiguousBroadcast(error)) throw error;
      }
      return expectedSignature;
    },
    observe: async ({ plan, submission }): Promise<SolanaNettingResidualChainObservation> => {
      await requireDevnet();
      const statusResponse = await connection.getSignatureStatuses(
        [submission.signature],
        { searchTransactionHistory: true },
      );
      const status = statusResponse.value[0];
      const currentBlockHeight = BigInt(await connection.getBlockHeight('finalized'));
      if (status == null) {
        if (currentBlockHeight <= submission.lastValidBlockHeight) {
          return Object.freeze({ status: 'PENDING' as const, currentBlockHeight });
        }
        const observedAtSlot = BigInt(await connection.getSlot('finalized'));
        const evidenceHash = digest('NARYX/solana-netting-residual/expired-unseen/v1', [
          signatureBytes(submission.signature),
          u64be(submission.lastValidBlockHeight),
          u64be(currentBlockHeight),
          u64be(observedAtSlot),
        ]);
        return Object.freeze({
          status: 'EXPIRED_UNSEEN' as const,
          currentBlockHeight,
          observation: rejectedObservation({ plan, submission, observedAtSlot, evidenceHash }),
        });
      }
      if (status.confirmationStatus !== 'finalized') {
        return Object.freeze({ status: 'PENDING' as const, currentBlockHeight });
      }
      const executionSlot = BigInt(status.slot);
      const observedAtSlot = BigInt(await connection.getSlot('finalized'));
      requireCondition(observedAtSlot >= executionSlot,
        'Solana residual observation predates execution');
      if (status.err !== null) {
        const evidenceHash = digest('NARYX/solana-netting-residual/rejected/v1', [
          signatureBytes(submission.signature),
          u64be(executionSlot),
        ]);
        return Object.freeze({
          status: 'TERMINAL' as const,
          observation: rejectedObservation({ plan, submission, observedAtSlot, evidenceHash }),
        });
      }
      const receiptAddress = new PublicKey(plan.receiptAddress);
      const accountResponse = await connection.getAccountInfoAndContext(receiptAddress, {
        commitment: 'finalized',
        minContextSlot: status.slot,
      });
      const accountInfo = accountResponse.value;
      requireCondition(accountInfo !== null
        && accountInfo.owner.equals(plan.instruction.programId),
      'successful Solana residual has no program-owned receipt');
      const receipt = decodeReceipt(accountInfo.data);
      requireCondition(bytesEqual(receipt.intentHash, plan.intentHash)
        && receipt.authority === plan.executionAccount
        && receipt.market === planAccount(plan, 1, 'market')
        && receipt.position === planAccount(plan, 2, 'position')
        && receipt.side === plan.side
        && receipt.baseLots === plan.baseLots
        && receipt.limitPriceTicks === plan.limitPriceTicks
        && receipt.maximumFeeAtoms === plan.maximumFeeQuoteAtoms
        && receipt.executionSlot === executionSlot
        && receipt.grossQuoteAtoms === receipt.fillPricePerLot * receipt.baseLots
        && receipt.feeAtoms <= plan.maximumFeeQuoteAtoms,
      'Solana residual receipt differs from the compiled bounded trade');
      const authoritativeEvidenceHash = digest('NARYX/solana-netting-residual/receipt/v1', [
        signatureBytes(submission.signature),
        u64be(executionSlot),
        receipt.raw,
      ]);
      return Object.freeze({
        status: 'TERMINAL' as const,
        observation: Object.freeze({
          intentHash: receipt.intentHash,
          authority: receipt.authority,
          market: receipt.market,
          position: receipt.position,
          terminalStatus: 'SUCCEEDED' as const,
          side: receipt.side,
          baseLots: receipt.baseLots,
          fillPricePerLot: receipt.fillPricePerLot,
          grossQuoteAtoms: receipt.grossQuoteAtoms,
          feeQuoteAtoms: receipt.feeAtoms,
          executionSlot: receipt.executionSlot,
          submittedAtSlot: submission.submittedAtSlot ?? submission.signedAtSlot,
          observedAtSlot,
          executionReferenceHash: transactionReference(submission.signature),
          authoritativeEvidenceHash,
        }),
      });
    },
  };
  return Object.freeze(chain);
}
