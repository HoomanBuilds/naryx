import {
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { bytesEqual, type DomainRef, type Hash32 } from '@naryx/protocol-types';
import { compileSolanaMultiStrategyStagePlan, type SolanaMultiStrategyEnvelope } from '@naryx/adapter-solana';
import type { SolanaTreasuryHedgeExecutionLane } from './solana-treasury-hedge-config.js';
import { observeSolanaStrategyStage } from './solana-strategy-execution-stage.js';
import type { PreparedStrategyExecutionTransport } from './strategy-execution-transport.js';
import type { StrategyPreparationService } from './strategy-preparation-service.js';
import type { SolanaStrategyAuthorizationJournal } from './solana-strategy-authorization-journal.js';

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

export interface SolanaStrategyStagePreparation {
  readonly version: 1;
  readonly owner: string;
  readonly solver: string;
  readonly programId: string;
  readonly orderHash: string;
  readonly quoteHash: string;
  readonly stageAddress: string;
  readonly payloadHash: string;
  readonly ready: boolean;
  readonly steps: readonly Readonly<{
    kind: 'INITIALIZE_STAGE' | 'WRITE_STAGE' | 'SEAL_STAGE' | 'CANCEL_STAGE';
    label: string;
    instructions: readonly Readonly<{
      programId: string;
      accounts: readonly Readonly<{ pubkey: string; isSigner: boolean; isWritable: boolean }>[];
      dataBase64: string;
    }>[];
  }>[];
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

export function solanaStrategyExecutionEnvelope(
  prepared: PreparedStrategyExecutionTransport | undefined,
): Readonly<{ domain: DomainRef; legIds: readonly string[]; envelope: SolanaMultiStrategyEnvelope }> {
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
    legIds: domainExecution.legIds,
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
      domain: domainExecution.envelope.domain,
      owner: publicKey(domainExecution.envelope.owner, 'strategy owner'),
      solver: publicKey(domainExecution.envelope.solver, 'strategy solver'),
      packageId: Uint8Array.from(domainExecution.envelope.packageId),
      orderHash: Uint8Array.from(domainExecution.envelope.orderHash),
      graphHash: Uint8Array.from(domainExecution.envelope.graphHash),
      quoteHash: Uint8Array.from(domainExecution.envelope.quoteHash),
      routeHash: Uint8Array.from(domainExecution.envelope.routeHash),
      operation: domainExecution.envelope.operation,
      previousStateHash: Uint8Array.from(domainExecution.envelope.previousStateHash),
      nextStateHash: Uint8Array.from(domainExecution.envelope.nextStateHash),
      nonce: domainExecution.envelope.nonce,
      deadlineSlot: domainExecution.envelope.deadlineSlot,
      strategyAccount: publicKey(domainExecution.envelope.strategyAccount, 'strategy account'),
      position: publicKey(domainExecution.envelope.position, 'strategy position'),
      receipt: publicKey(domainExecution.envelope.receipt, 'strategy receipt'),
      ...(domainExecution.envelope.fees === undefined ? {} : {
        fees: Object.freeze({
          quoteAssetSubjectId: Uint8Array.from(domainExecution.envelope.fees.quoteAssetSubjectId),
          quoteAssetManifestVersion: domainExecution.envelope.fees.quoteAssetManifestVersion,
          quoteAssetManifestHash: Uint8Array.from(domainExecution.envelope.fees.quoteAssetManifestHash),
          policyVersion: domainExecution.envelope.fees.policyVersion,
          policyManifestHash: Uint8Array.from(domainExecution.envelope.fees.policyManifestHash),
          mint: publicKey(domainExecution.envelope.fees.mint, 'fee mint'),
          protocolRecipient: publicKey(
            domainExecution.envelope.fees.protocolRecipient,
            'protocol fee recipient',
          ),
          protocolFeeAtoms: domainExecution.envelope.fees.protocolFeeAtoms,
          solverFeeAtoms: domainExecution.envelope.fees.solverFeeAtoms,
        }),
      }),
      requiredSignerPubkeys: Object.freeze([...domainExecution.envelope.requiredSignerPubkeys]),
    }),
  });
}

export class SolanaStrategyExecutionAuthorizationService {
  readonly #preparations: Pick<StrategyPreparationService, 'prepareByQuote'>;
  readonly #lanes: readonly SolanaTreasuryHedgeExecutionLane[];
  readonly #signer: SolanaStrategyTransactionSigner;
  readonly #journal: SolanaStrategyAuthorizationJournal;

  constructor(input: Readonly<{
    preparations: Pick<StrategyPreparationService, 'prepareByQuote'>;
    lanes: readonly SolanaTreasuryHedgeExecutionLane[];
    signer: SolanaStrategyTransactionSigner;
    journal: SolanaStrategyAuthorizationJournal;
  }>) {
    requireCondition(input.lanes.length > 0, 'at least one execution lane is required');
    this.#preparations = input.preparations;
    this.#lanes = Object.freeze([...input.lanes]);
    this.#signer = input.signer;
    this.#journal = input.journal;
  }

  async stage(quoteHash: Hash32): Promise<SolanaStrategyStagePreparation | undefined> {
    const prepared = await this.#preparations.prepareByQuote(quoteHash);
    if (prepared === undefined) return undefined;
    requireCondition(bytesEqual(prepared.quoteHash, quoteHash), 'preparation returned another quote');
    const compiled = solanaStrategyExecutionEnvelope(prepared);
    const lanes = this.#lanes.filter((lane) => sameDomain(lane.domain, compiled.domain));
    requireCondition(lanes.length === 1, 'prepared domain does not resolve to exactly one execution lane');
    const lane = lanes[0]!;
    requireCondition(lane.solver === compiled.envelope.solver.toBase58()
      && lane.solver === this.#signer.publicKey, 'stage solver differs from the configured signer');
    const plan = compileSolanaMultiStrategyStagePlan(compiled.envelope);
    const observed = await observeSolanaStrategyStage(lane.reader, compiled.envelope, plan);
    const nextInstruction = !observed.exists ? 0 : 1 + Math.ceil(observed.writtenBytes / 512);
    const pending = observed.stale ? [plan.cancelInstruction]
      : observed.sealed ? [] : plan.instructions.slice(nextInstruction);
    return Object.freeze({
      version: 1,
      owner: compiled.envelope.owner.toBase58(),
      solver: compiled.envelope.solver.toBase58(),
      programId: compiled.envelope.instruction.programId.toBase58(),
      orderHash: hex(prepared.orderHash),
      quoteHash: hex(prepared.quoteHash),
      stageAddress: plan.address.toBase58(),
      payloadHash: hex(plan.payloadHash),
      ready: observed.sealed,
      steps: Object.freeze(pending.map((instruction, index) => {
        const number = nextInstruction + index;
        const kind = observed.stale ? 'CANCEL_STAGE' : number === 0 ? 'INITIALIZE_STAGE'
          : number === plan.instructions.length - 1 ? 'SEAL_STAGE' : 'WRITE_STAGE';
        return Object.freeze({
          kind: kind as SolanaStrategyStagePreparation['steps'][number]['kind'],
          label: kind === 'INITIALIZE_STAGE' ? 'Create immutable execution stage'
            : kind === 'SEAL_STAGE' ? 'Seal the complete execution payload'
              : kind === 'CANCEL_STAGE' ? 'Cancel stale execution stage' : `Upload execution chunk ${number}`,
          instructions: Object.freeze([Object.freeze({
            programId: instruction.programId.toBase58(),
            accounts: Object.freeze(instruction.keys.map((account) => Object.freeze({
              pubkey: account.pubkey.toBase58(),
              isSigner: account.isSigner,
              isWritable: account.isWritable,
            }))),
            dataBase64: Buffer.from(instruction.data).toString('base64'),
          })]),
        });
      })),
    });
  }

  async authorize(quoteHash: Hash32): Promise<AuthorizedSolanaStrategyExecution | undefined> {
    const prepared = await this.#preparations.prepareByQuote(quoteHash);
    if (prepared === undefined) return undefined;
    requireCondition(bytesEqual(prepared.quoteHash, quoteHash), 'preparation returned another quote');
    const compiled = solanaStrategyExecutionEnvelope(prepared);
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
    const stagePlan = compileSolanaMultiStrategyStagePlan(compiled.envelope);
    const stage = await observeSolanaStrategyStage(lane.reader, compiled.envelope, stagePlan);
    requireCondition(stage.sealed, 'execution stage is not sealed');
    const materialized = await lane.materializer.materialize({
      domain: compiled.domain,
      payer: owner.pubkey,
      envelope: stagePlan.finalEnvelope,
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
    const domainExecution = prepared.domains[0];
    requireCondition(domainExecution?.kind === 'SOLANA_MULTI_STRATEGY_ACCOUNT',
      'authorized execution has no Solana strategy domain');
    const stagedInstruction = stagePlan.finalEnvelope.instruction;
    await this.#journal.record(Object.freeze({
      ...prepared,
      domains: Object.freeze([Object.freeze({
        ...domainExecution,
        envelope: Object.freeze({
          ...domainExecution.envelope,
          instruction: Object.freeze({
            programId: stagedInstruction.programId.toBase58(),
            accounts: Object.freeze(stagedInstruction.keys.map((account) => Object.freeze({
              pubkey: account.pubkey.toBase58(),
              isSigner: account.isSigner,
              isWritable: account.isWritable,
            }))),
            data: Uint8Array.from(stagedInstruction.data),
          }),
        }),
      })]),
    }));
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
