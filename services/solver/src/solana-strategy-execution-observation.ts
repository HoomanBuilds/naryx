import bs58 from 'bs58';
import {
  bytesEqual,
  type DomainRef,
  type Hash32,
} from '@naryx/protocol-types';
import {
  decodeSolanaMultiStrategyReceipt,
  solanaMultiStrategyReceiptHash,
} from '@naryx/adapter-solana';
import type { SolanaTreasuryHedgeExecutionLane } from './solana-treasury-hedge-config.js';
import { requireSolanaDevnet } from './solana-devnet-rpc.js';
import {
  solanaStrategyExecutionEnvelope,
} from './solana-strategy-execution-authorization.js';
import type { StrategyPreparationService } from './strategy-preparation-service.js';

export type SolanaStrategyExecutionObservation = Readonly<
  | { version: 1; status: 'PENDING' | 'FAILED'; signature: string }
  | {
      version: 1;
      status: 'FINALIZED';
      signature: string;
      domain: DomainRef;
      slot: bigint;
      strategyAccount: string;
      position: string;
      receiptAccount: string;
      packageId: string;
      orderHash: string;
      graphHash: string;
      quoteHash: string;
      routeHash: string;
      operation: string;
      previousStateHash: string;
      nextStateHash: string;
      callsHash: string;
      evidenceRoot: string;
      onchainReceiptHash: string;
      solver: string;
      nonce: bigint;
    }
>;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Solana strategy execution observation refused: ${message}`);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function sameAddresses(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalSignature(value: string): string {
  try {
    const decoded = bs58.decode(value);
    requireCondition(decoded.length === 64 && bs58.encode(decoded) === value, 'signature is invalid');
    return value;
  } catch {
    throw new Error('Solana strategy execution observation refused: signature is invalid');
  }
}

export class SolanaStrategyExecutionObservationService {
  readonly #preparations: Pick<StrategyPreparationService, 'prepareByQuote'>;
  readonly #lanes: readonly SolanaTreasuryHedgeExecutionLane[];

  constructor(input: Readonly<{
    preparations: Pick<StrategyPreparationService, 'prepareByQuote'>;
    lanes: readonly SolanaTreasuryHedgeExecutionLane[];
  }>) {
    requireCondition(input.lanes.length > 0, 'at least one execution lane is required');
    this.#preparations = input.preparations;
    this.#lanes = Object.freeze([...input.lanes]);
  }

  async observe(input: Readonly<{
    quoteHash: Hash32;
    signature: string;
  }>): Promise<SolanaStrategyExecutionObservation | undefined> {
    const signature = canonicalSignature(input.signature);
    const prepared = await this.#preparations.prepareByQuote(input.quoteHash);
    if (prepared === undefined) return undefined;
    requireCondition(bytesEqual(prepared.quoteHash, input.quoteHash), 'preparation returned another quote');
    const compiled = solanaStrategyExecutionEnvelope(prepared);
    requireCondition(prepared.identity.nextStateHash !== undefined,
      'prepared strategy execution has no next state hash');
    const lanes = this.#lanes.filter((lane) => sameDomain(lane.domain, compiled.domain));
    requireCondition(lanes.length === 1, 'prepared domain does not resolve to exactly one execution lane');
    const lane = lanes[0]!;
    await requireSolanaDevnet(lane.reader);
    const transaction = await lane.reader.getTransactionObservation(signature);
    if (transaction.status !== 'FINALIZED') {
      return Object.freeze({ version: 1, status: transaction.status, signature });
    }
    const expectedInstruction = compiled.envelope.instruction;
    const expectedAccounts = expectedInstruction.keys.map((account) => account.pubkey.toBase58());
    const matches = transaction.instructions.filter((instruction) =>
      instruction.programId === expectedInstruction.programId.toBase58()
      && sameAddresses(instruction.accounts, expectedAccounts)
      && bytesEqual(instruction.data, expectedInstruction.data));
    requireCondition(matches.length === 1, 'transaction does not contain the exact prepared strategy instruction');
    const [account] = await lane.reader.getAccounts(
      [compiled.envelope.receipt.toBase58()],
      transaction.slot,
    );
    requireCondition(account !== null && account !== undefined, 'strategy receipt account is absent');
    requireCondition(account.owner === expectedInstruction.programId.toBase58(), 'strategy receipt owner is invalid');
    const receipt = decodeSolanaMultiStrategyReceipt(account.data);
    requireCondition(bytesEqual(receipt.packageId, prepared.identity.packageId)
      && bytesEqual(receipt.orderHash, prepared.orderHash)
      && bytesEqual(receipt.graphHash, prepared.graphHash)
      && bytesEqual(receipt.quoteHash, prepared.quoteHash)
      && bytesEqual(receipt.routeHash, prepared.routeHash)
      && receipt.operation === prepared.identity.operation
      && bytesEqual(receipt.nextStateHash, prepared.identity.nextStateHash)
      && bytesEqual(receipt.callsHash, compiled.envelope.callsHash)
      && receipt.solver.toBase58() === lane.solver,
    'stored receipt differs from the prepared strategy execution');
    requireCondition(receipt.executionSlot === transaction.slot, 'receipt execution slot differs from the transaction');
    const expectedReceiptHash = solanaMultiStrategyReceiptHash({
      executionHash: compiled.envelope.executionHash,
      callsHash: compiled.envelope.callsHash,
      evidenceRoot: receipt.evidenceRoot,
    });
    requireCondition(bytesEqual(receipt.receiptHash, expectedReceiptHash), 'stored receipt hash is invalid');
    return Object.freeze({
      version: 1,
      status: 'FINALIZED',
      signature,
      domain: compiled.domain,
      slot: transaction.slot,
      strategyAccount: compiled.envelope.strategyAccount.toBase58(),
      position: compiled.envelope.position.toBase58(),
      receiptAccount: compiled.envelope.receipt.toBase58(),
      packageId: hex(receipt.packageId),
      orderHash: hex(receipt.orderHash),
      graphHash: hex(receipt.graphHash),
      quoteHash: hex(receipt.quoteHash),
      routeHash: hex(receipt.routeHash),
      operation: receipt.operation,
      previousStateHash: hex(receipt.previousStateHash),
      nextStateHash: hex(receipt.nextStateHash),
      callsHash: hex(receipt.callsHash),
      evidenceRoot: hex(receipt.evidenceRoot),
      onchainReceiptHash: hex(receipt.receiptHash),
      solver: receipt.solver.toBase58(),
      nonce: receipt.nonce,
    });
  }
}
