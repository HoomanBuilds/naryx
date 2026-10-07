import type { DomainRef } from '@naryx/protocol-types';
import type {
  PreparedStrategyDomainExecution,
  PreparedStrategyExecution,
} from './strategy-execution-preparer.js';

export interface SolanaInstructionTransport {
  readonly programId: string;
  readonly accounts: readonly Readonly<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>[];
  readonly data: Uint8Array;
}

export type PreparedStrategyDomainTransport =
  | Readonly<{
      kind: 'SOLANA_MULTI_STRATEGY_ACCOUNT';
      domain: DomainRef;
      routeSettlementClass: PreparedStrategyDomainExecution['routeSettlementClass'];
      localGuarantee: 'ATOMIC_POSTCONDITION';
      legIds: readonly string[];
      envelope: Readonly<{
        instruction: SolanaInstructionTransport;
        executionHash: Uint8Array;
        callsHash: Uint8Array;
        strategyAccount: string;
        position: string;
        receipt: string;
        fees?: Readonly<{
          quoteAssetSubjectId: Uint8Array;
          quoteAssetManifestVersion: number;
          quoteAssetManifestHash: Uint8Array;
          policyVersion: number;
          policyManifestHash: Uint8Array;
          mint: string;
          protocolRecipient: string;
          protocolFeeAtoms: bigint;
          solverFeeAtoms: bigint;
        }>;
        requiredSignerPubkeys: readonly string[];
      }>;
    }>
  | Exclude<PreparedStrategyDomainExecution, Readonly<{ kind: 'SOLANA_MULTI_STRATEGY_ACCOUNT' }>>;

export interface PreparedStrategyExecutionTransport {
  readonly version: 1;
  readonly identity: PreparedStrategyExecution['identity'];
  readonly settlementClass: PreparedStrategyExecution['settlementClass'];
  readonly coordination: PreparedStrategyExecution['coordination'];
  readonly orderHash: Uint8Array;
  readonly graphHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly routeHash: Uint8Array;
  readonly crossDomainPlanHash?: Uint8Array;
  readonly domains: readonly PreparedStrategyDomainTransport[];
}

function transportDomain(domain: PreparedStrategyDomainExecution): PreparedStrategyDomainTransport {
  if (domain.kind !== 'SOLANA_MULTI_STRATEGY_ACCOUNT') return domain;
  const instruction = domain.envelope.instruction;
  return Object.freeze({
    kind: domain.kind,
    domain: domain.domain,
    routeSettlementClass: domain.routeSettlementClass,
    localGuarantee: domain.localGuarantee,
    legIds: domain.legIds,
    envelope: Object.freeze({
      instruction: Object.freeze({
        programId: instruction.programId.toBase58(),
        accounts: Object.freeze(instruction.keys.map((account) => Object.freeze({
          pubkey: account.pubkey.toBase58(),
          isSigner: account.isSigner,
          isWritable: account.isWritable,
        }))),
        data: Uint8Array.from(instruction.data),
      }),
      executionHash: Uint8Array.from(domain.envelope.executionHash),
      callsHash: Uint8Array.from(domain.envelope.callsHash),
      strategyAccount: domain.envelope.strategyAccount.toBase58(),
      position: domain.envelope.position.toBase58(),
      receipt: domain.envelope.receipt.toBase58(),
      ...(domain.envelope.fees === undefined ? {} : {
        fees: Object.freeze({
          quoteAssetSubjectId: Uint8Array.from(domain.envelope.fees.quoteAssetSubjectId),
          quoteAssetManifestVersion: domain.envelope.fees.quoteAssetManifestVersion,
          quoteAssetManifestHash: Uint8Array.from(domain.envelope.fees.quoteAssetManifestHash),
          policyVersion: domain.envelope.fees.policyVersion,
          policyManifestHash: Uint8Array.from(domain.envelope.fees.policyManifestHash),
          mint: domain.envelope.fees.mint.toBase58(),
          protocolRecipient: domain.envelope.fees.protocolRecipient.toBase58(),
          protocolFeeAtoms: domain.envelope.fees.protocolFeeAtoms,
          solverFeeAtoms: domain.envelope.fees.solverFeeAtoms,
        }),
      }),
      requiredSignerPubkeys: Object.freeze([...domain.envelope.requiredSignerPubkeys]),
    }),
  });
}

export function preparedStrategyExecutionTransport(
  prepared: PreparedStrategyExecution,
): PreparedStrategyExecutionTransport {
  return Object.freeze({
    version: prepared.version,
    identity: prepared.identity,
    settlementClass: prepared.settlementClass,
    coordination: prepared.coordination,
    orderHash: Uint8Array.from(prepared.orderHash),
    graphHash: Uint8Array.from(prepared.graphHash),
    quoteHash: Uint8Array.from(prepared.quoteHash),
    routeHash: Uint8Array.from(prepared.routeHash),
    ...(prepared.crossDomainPlanHash === undefined
      ? {}
      : { crossDomainPlanHash: Uint8Array.from(prepared.crossDomainPlanHash) }),
    domains: Object.freeze(prepared.domains.map(transportDomain)),
  });
}
