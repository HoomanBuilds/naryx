import {
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { bytesEqual, type DomainRef, type Hash32 } from '@naryx/protocol-types';
import type { SolanaMultiStrategyEnvelope } from '@naryx/adapter-solana';
import type { SolanaTreasuryHedgeExecutionLane } from './solana-treasury-hedge-config.js';
import type { StrategyPreparationService } from './strategy-preparation-service.js';

export interface SolanaStrategyTransactionSigner {
  readonly publicKey: string;
  sign(transaction: VersionedTransaction): void;
}

export interface AuthorizedSolanaStrategyExecution {
  readonly version: 1;
  readonly domain: DomainRef;
  readonly owner: string;
  readonly solver: string;
  readonly transactionBase64: string;
  readonly messageBase64: string;
  readonly requiredSignerPubkeys: readonly string[];
  readonly recentBlockhash: string;
  readonly blockhashContextSlot: number;
  readonly lastValidBlockHeight: number;
  readonly strategyAccount: string;
  readonly position: string;
  readonly receipt: string;
  readonly packageId: string;
  readonly orderHash: string;
  readonly quoteHash: string;
  readonly routeHash: string;
  readonly executionHash: string;
  readonly callsHash: string;
  readonly materializationCommitment: string;
  readonly lookupTables: readonly Readonly<{
    address: string;
    addresses: readonly string[];
    contentCommitment: string;
    contextSlot: number;
  }>[];
  readonly evidence: Readonly<{
    resolvedAddressCount: number;
    serializedMessageBytes: number;
    serializedTransactionBytes: number;
    packetDataLimit: number;
    computeUnitLimit: number;
  }>;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Solana strategy authorization refused: ${message}`);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function publicKey(value: string, context: string): PublicKey {
  try {
    const checked = new PublicKey(value);
    requireCondition(checked.toBase58() === value, `${context} is not canonical`);
    return checked;
  } catch {
    throw new Error(`Solana strategy authorization refused: ${context} is invalid`);
  }
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function envelopeFromTransport(
  prepared: Awaited<ReturnType<StrategyPreparationService['prepareByQuote']>>,
): Readonly<{ domain: DomainRef; envelope: SolanaMultiStrategyEnvelope }> {
  requireCondition(prepared !== undefined, 'prepared package is missing');
  requireCondition(prepared.identity.templateId === 'treasury-inventory-hedge-v1',
    'prepared package is not a treasury hedge');
  requireCondition(prepared.settlementClass === 'ATOMIC_POSTCONDITION'
    && prepared.coordination === 'SINGLE_DOMAIN_ATOMIC'
    && prepared.domains.length === 1,
  'prepared package is not a single-domain atomic execution');
  const domainExecution = prepared.domains[0]!;
  requireCondition(domainExecution.kind === 'SOLANA_MULTI_STRATEGY_ACCOUNT'
    && domainExecution.domain.domainId === 'svm:devnet'
    && domainExecution.routeSettlementClass === 'ATOMIC_POSTCONDITION',
  'prepared package is not a Solana Devnet strategy account execution');
  const instruction = domainExecution.envelope.instruction;
  return Object.freeze({
    domain: domainExecution.domain,
    envelope: Object.freeze({
      instruction: new TransactionInstruction({
        programId: publicKey(instruction.programId, 'instruction program'),
        keys: instruction.accounts.map((account) => ({
          pubkey: publicKey(account.pubkey, 'instruction account'),
          isSigner: account.isSigner,
          isWritable: account.isWritable,
        })),
        data: Buffer.from(instruction.data),
      }),
      executionHash: Uint8Array.from(domainExecution.envelope.executionHash),
      callsHash: Uint8Array.from(domainExecution.envelope.callsHash),
      strategyAccount: publicKey(domainExecution.envelope.strategyAccount, 'strategy account'),
      position: publicKey(domainExecution.envelope.position, 'strategy position'),
      receipt: publicKey(domainExecution.envelope.receipt, 'strategy receipt'),
      requiredSignerPubkeys: Object.freeze([...domainExecution.envelope.requiredSignerPubkeys]),
    }),
  });
}

export class SolanaStrategyExecutionAuthorizationService {
  readonly #preparations: Pick<StrategyPreparationService, 'prepareByQuote'>;
  readonly #lanes: readonly SolanaTreasuryHedgeExecutionLane[];
  readonly #signer: SolanaStrategyTransactionSigner;

  constructor(input: Readonly<{
    preparations: Pick<StrategyPreparationService, 'prepareByQuote'>;
    lanes: readonly SolanaTreasuryHedgeExecutionLane[];
    signer: SolanaStrategyTransactionSigner;
  }>) {
    requireCondition(input.lanes.length > 0, 'at least one execution lane is required');
    this.#preparations = input.preparations;
    this.#lanes = Object.freeze([...input.lanes]);
    this.#signer = input.signer;
  }

  async authorize(quoteHash: Hash32): Promise<AuthorizedSolanaStrategyExecution | undefined> {
    const prepared = await this.#preparations.prepareByQuote(quoteHash);
    if (prepared === undefined) return undefined;
    requireCondition(bytesEqual(prepared.quoteHash, quoteHash), 'preparation returned another quote');
    const compiled = envelopeFromTransport(prepared);
    const lanes = this.#lanes.filter((lane) => sameDomain(lane.domain, compiled.domain));
    requireCondition(lanes.length === 1, 'prepared domain does not resolve to exactly one execution lane');
    const lane = lanes[0]!;
    const solver = publicKey(this.#signer.publicKey, 'configured solver');
    requireCondition(lane.solver === solver.toBase58(), 'execution lane solver differs from the signing account');
    requireCondition(compiled.envelope.requiredSignerPubkeys.includes(solver.toBase58()),
      'prepared execution does not require the configured solver');
    const owner = compiled.envelope.instruction.keys[0];
    requireCondition(owner !== undefined && owner.isSigner && !owner.pubkey.equals(solver),
      'prepared execution owner signer is invalid');
    const materialized = await lane.materializer.materialize({
      domain: compiled.domain,
      payer: owner.pubkey,
      envelope: compiled.envelope,
      computeUnitLimit: lane.computeUnitLimit,
    });
    const transaction = VersionedTransaction.deserialize(materialized.transactionBytes);
    this.#signer.sign(transaction);
    const signerKeys = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
    const solverIndex = signerKeys.findIndex((key) => key.equals(solver));
    requireCondition(solverIndex >= 0, 'solver is absent from the materialized signer set');
    for (const [index, signature] of transaction.signatures.entries()) {
      const present = signature.some((byte) => byte !== 0);
      requireCondition(index === solverIndex ? present : !present,
        index === solverIndex ? 'solver signature is absent' : 'transaction contains an unexpected signature');
    }
    return Object.freeze({
      version: 1,
      domain: materialized.domain,
      owner: owner.pubkey.toBase58(),
      solver: solver.toBase58(),
      transactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
      messageBase64: materialized.messageBase64,
      requiredSignerPubkeys: materialized.requiredSignerPubkeys,
      recentBlockhash: materialized.recentBlockhash,
      blockhashContextSlot: materialized.blockhashContextSlot,
      lastValidBlockHeight: materialized.lastValidBlockHeight,
      strategyAccount: compiled.envelope.strategyAccount.toBase58(),
      position: compiled.envelope.position.toBase58(),
      receipt: compiled.envelope.receipt.toBase58(),
      packageId: hex(prepared.identity.packageId),
      orderHash: hex(prepared.orderHash),
      quoteHash: hex(prepared.quoteHash),
      routeHash: hex(prepared.routeHash),
      executionHash: hex(compiled.envelope.executionHash),
      callsHash: hex(compiled.envelope.callsHash),
      materializationCommitment: hex(materialized.materializationCommitment),
      lookupTables: Object.freeze(materialized.lookupTables.map((table) => Object.freeze({
        address: table.address,
        addresses: table.addresses,
        contentCommitment: hex(table.contentCommitment),
        contextSlot: table.contextSlot,
      }))),
      evidence: materialized.evidence,
    });
  }
}
