import { VersionedTransaction } from '@solana/web3.js';
import { bytesEqual, type DomainRef } from '@naryx/protocol-types';
import type { SolanaMultiStrategyEnvelope } from '@naryx/adapter-solana';
import type {
  NettingAllocationExecutionRequest,
  NettingAllocationLifecycleService,
} from './netting-allocation-lifecycle.js';
import type { SolanaStrategyTransactionSigner } from './solana-strategy-execution-authorization.js';
import type { SolanaTreasuryHedgeExecutionLane } from './solana-treasury-hedge-config.js';

export interface AuthorizedSolanaNettingAllocation {
  readonly version: 1;
  readonly attemptId: string;
  readonly authorizationHash: string;
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
  readonly packageId: string;
  readonly quoteHash: string;
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

type LifecyclePort = Pick<NettingAllocationLifecycleService, 'prepareAndRegister'>;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Solana netting allocation authorization refused: ${message}`);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

export class SolanaNettingAllocationAuthorizationService {
  readonly #lifecycle: LifecyclePort;
  readonly #lanes: readonly SolanaTreasuryHedgeExecutionLane[];
  readonly #signer: SolanaStrategyTransactionSigner;

  constructor(input: Readonly<{
    lifecycle: LifecyclePort;
    lanes: readonly SolanaTreasuryHedgeExecutionLane[];
    signer: SolanaStrategyTransactionSigner;
  }>) {
    requireCondition(input.lanes.length > 0, 'at least one execution lane is required');
    this.#lifecycle = input.lifecycle;
    this.#lanes = Object.freeze([...input.lanes]);
    this.#signer = input.signer;
  }

  async authorize(input: NettingAllocationExecutionRequest): Promise<AuthorizedSolanaNettingAllocation> {
    const registered = await this.#lifecycle.prepareAndRegister(input);
    const prepared = registered.prepared;
    requireCondition(prepared.kind === 'SOLANA_MULTI_STRATEGY_ACCOUNT', 'prepared allocation is not Solana');
    const netting = prepared.netting;
    requireCondition(netting.envelope.domain.domainId === 'svm:devnet', 'execution domain is not Solana Devnet');
    const lanes = this.#lanes.filter((lane) => sameDomain(lane.domain, netting.envelope.domain));
    requireCondition(lanes.length === 1, 'prepared domain does not resolve to exactly one execution lane');
    const lane = lanes[0]!;
    requireCondition(lane.solver === this.#signer.publicKey
      && netting.envelope.solver.toBase58() === this.#signer.publicKey,
    'prepared solver differs from the configured signing account');
    requireCondition(netting.requiredSignerPubkeys.includes(this.#signer.publicKey),
      'prepared execution does not require the configured solver');
    const owner = netting.envelope.owner;
    const first = netting.instruction.keys[0];
    requireCondition(first !== undefined && first.isSigner && first.pubkey.equals(owner),
      'prepared execution owner signer is invalid');
    const envelope: SolanaMultiStrategyEnvelope = Object.freeze({
      ...netting.envelope,
      instruction: netting.instruction,
      requiredSignerPubkeys: netting.requiredSignerPubkeys,
    });
    const materialized = await lane.materializer.materialize({
      domain: envelope.domain,
      payer: owner,
      envelope,
      computeUnitLimit: lane.computeUnitLimit,
    });
    const transaction = VersionedTransaction.deserialize(materialized.transactionBytes);
    this.#signer.sign(transaction);
    const signerKeys = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
    const solverIndex = signerKeys.findIndex((key) => key.toBase58() === this.#signer.publicKey);
    requireCondition(solverIndex >= 0, 'solver is absent from the materialized signer set');
    for (const [index, signature] of transaction.signatures.entries()) {
      const present = signature.some((byte) => byte !== 0);
      requireCondition(index === solverIndex ? present : !present,
        index === solverIndex ? 'solver signature is absent' : 'transaction contains an unexpected signature');
    }
    return Object.freeze({
      version: 1,
      attemptId: registered.attempt.attemptId,
      authorizationHash: hex(prepared.authorization.authorizationHash),
      domain: materialized.domain,
      owner: owner.toBase58(),
      solver: this.#signer.publicKey,
      transactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
      messageBase64: materialized.messageBase64,
      requiredSignerPubkeys: materialized.requiredSignerPubkeys,
      recentBlockhash: materialized.recentBlockhash,
      blockhashContextSlot: materialized.blockhashContextSlot,
      lastValidBlockHeight: materialized.lastValidBlockHeight,
      strategyAccount: envelope.strategyAccount.toBase58(),
      packageId: hex(envelope.packageId),
      quoteHash: hex(envelope.quoteHash),
      executionHash: hex(envelope.executionHash),
      callsHash: hex(envelope.callsHash),
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
