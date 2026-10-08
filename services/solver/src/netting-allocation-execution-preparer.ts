import {
  compileEvmNettingAllocationEnvelope,
  evmNettingAllocationObservationBinding,
  type EvmNettingAllocationEnvelope,
  type EvmNettingAllocationObservationBinding,
} from '@naryx/adapter-evm';
import {
  compileSolanaNettingAllocationEnvelope,
  solanaNettingAllocationObservationBinding,
  type SolanaNettingAllocationEnvelope,
  type SolanaNettingAllocationObservationBinding,
} from '@naryx/adapter-solana';
import {
  nettingAllocationExecutionAuthorization,
  packageSettlementCommitmentHash,
  type NettingAllocationExecutionAuthorization,
  type NettingExternalExecutionEvidence,
  type NettingExternalExecutionIntent,
  type NettingFinalAllocationReceipt,
  type NettingPolicyManifest,
  type NettingPolicyManifestInput,
  type NettingResult,
  type PackageSettlementCommitment,
  type PackageSettlementCommitmentInput,
} from '@naryx/protocol-types';
import type { Address } from 'viem';
import type { PreparedStrategyDomainExecution } from './strategy-execution-preparer.js';

interface NettingAllocationExecutionInput {
  readonly finalAllocationReceipt: NettingFinalAllocationReceipt;
  readonly allocationReceiptHash: Uint8Array | string;
  readonly result: NettingResult;
  readonly policy: NettingPolicyManifestInput | NettingPolicyManifest;
  readonly intents: readonly NettingExternalExecutionIntent[];
  readonly externalEvidence: readonly NettingExternalExecutionEvidence[];
  readonly settlement: PackageSettlementCommitmentInput | PackageSettlementCommitment;
  readonly domainExecution: PreparedStrategyDomainExecution;
}

export type PreparedNettingAllocationExecution =
  | Readonly<{
      kind: 'EVM_MULTI_STRATEGY_ACCOUNT';
      authorization: NettingAllocationExecutionAuthorization;
      netting: EvmNettingAllocationEnvelope;
      observation: Readonly<{
        runtimeClass: 'EVM';
        binding: EvmNettingAllocationObservationBinding;
      }>;
    }>
  | Readonly<{
      kind: 'SOLANA_MULTI_STRATEGY_ACCOUNT';
      authorization: NettingAllocationExecutionAuthorization;
      netting: SolanaNettingAllocationEnvelope;
      observation: Readonly<{
        runtimeClass: 'SVM';
        binding: SolanaNettingAllocationObservationBinding;
      }>;
    }>;

function authorization(
  input: NettingAllocationExecutionInput,
  execution: Readonly<{
    executionPlanHash: Uint8Array | string;
    solverId: string;
    protocolFeeAtoms: bigint;
    solverFeeAtoms: bigint;
    nonce: bigint;
    validUntilUnit: 'EVM_UNIX_SECONDS' | 'SOLANA_SLOT';
    validUntilValue: bigint;
  }>,
): NettingAllocationExecutionAuthorization {
  return nettingAllocationExecutionAuthorization({
    version: 1,
    finalAllocationReceiptHash: input.finalAllocationReceipt.receiptHash,
    allocationReceiptHash: input.allocationReceiptHash,
    settlementCommitmentHash: packageSettlementCommitmentHash(input.settlement),
    ...execution,
  }, input.finalAllocationReceipt, input.result, input.policy, input.intents, input.externalEvidence, input.settlement);
}

export function prepareNettingAllocationExecution(
  input: NettingAllocationExecutionInput,
): PreparedNettingAllocationExecution {
  const prepared = input.domainExecution;
  if (prepared.kind === 'EVM_MULTI_STRATEGY_ACCOUNT') {
    const envelope = prepared.envelope;
    const authorized = authorization(input, {
      executionPlanHash: envelope.callsHash,
      solverId: envelope.execution.solver,
      protocolFeeAtoms: envelope.execution.fees.protocolFeeAtoms,
      solverFeeAtoms: envelope.execution.fees.solverFeeAtoms,
      nonce: envelope.execution.nonce,
      validUntilUnit: 'EVM_UNIX_SECONDS',
      validUntilValue: envelope.execution.deadline,
    });
    const netting = compileEvmNettingAllocationEnvelope({
      envelope,
      authorization: authorized,
      owner: authorized.ownerId as Address,
    });
    return Object.freeze({
      kind: prepared.kind,
      authorization: authorized,
      netting,
      observation: Object.freeze({
        runtimeClass: 'EVM',
        binding: evmNettingAllocationObservationBinding(netting),
      }),
    });
  }
  if (prepared.kind === 'SOLANA_MULTI_STRATEGY_ACCOUNT') {
    const envelope = prepared.envelope;
    if (envelope.fees === undefined) {
      throw new Error('Solana netting allocation execution requires fee terms');
    }
    const authorized = authorization(input, {
      executionPlanHash: envelope.callsHash,
      solverId: envelope.solver.toBase58(),
      protocolFeeAtoms: envelope.fees.protocolFeeAtoms,
      solverFeeAtoms: envelope.fees.solverFeeAtoms,
      nonce: envelope.nonce,
      validUntilUnit: 'SOLANA_SLOT',
      validUntilValue: envelope.deadlineSlot,
    });
    const netting = compileSolanaNettingAllocationEnvelope({ envelope, authorization: authorized });
    return Object.freeze({
      kind: prepared.kind,
      authorization: authorized,
      netting,
      observation: Object.freeze({
        runtimeClass: 'SVM',
        binding: solanaNettingAllocationObservationBinding(netting),
      }),
    });
  }
  throw new Error(`Netting allocation settlement does not support ${prepared.kind}`);
}
