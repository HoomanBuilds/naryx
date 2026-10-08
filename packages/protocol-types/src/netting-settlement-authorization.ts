import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { enumDiscriminant, EXPIRY_UNIT, type ExpiryUnit } from './enums.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  NETTING_SETTLEMENT_STATE_KIND,
  nettingSettlementStateKind,
  type NettingSettlementStateKind,
} from './netting-asset-settlement.js';
import type {
  NettingExternalExecutionEvidence,
  NettingExternalExecutionIntent,
} from './netting-execution.js';
import {
  nettingPolicyManifest,
  type NettingPolicyManifest,
  type NettingPolicyManifestInput,
} from './netting-policy-manifest.js';
import {
  verifyNettingFinalAllocationReceipt,
  type CrossBatchNettingResolution,
  type NettingFinalAllocation,
  type NettingFinalAllocationReceipt,
} from './netting-settlement.js';
import type { NettingResult } from './package-netting.js';
import {
  packageSettlementCommitment,
  packageSettlementCommitmentHash,
  type PackageSettlementCommitment,
  type PackageSettlementCommitmentInput,
} from './package-settlement.js';
import {
  commitmentHash,
  encodeCommitmentHash,
  type CommitmentHash,
} from './package-order-primitives.js';
import {
  encodeAssetRef,
  encodeDomainRef,
  encodeProtocolId,
  protocolId,
  type AssetRef,
  type DomainRef,
  type ProtocolId,
} from './primitives.js';

export const NETTING_ALLOCATION_EXECUTION_AUTHORIZATION_VERSION = 1;

const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;
const I256_BITS = 256;

export interface NettingAllocationExecutionAuthorizationInput {
  readonly version: number;
  readonly finalAllocationReceiptHash: Uint8Array | string;
  readonly allocationReceiptHash: Uint8Array | string;
  readonly settlementCommitmentHash: Uint8Array | string;
  readonly executionPlanHash: Uint8Array | string;
  readonly solverId: string;
  readonly protocolFeeAtoms: bigint;
  readonly solverFeeAtoms: bigint;
  readonly nonce: bigint;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
}

export interface NettingAllocationExecutionAuthorization {
  readonly version: 1;
  readonly authorizationHash: CommitmentHash;
  readonly environment: ProtocolId;
  readonly executionClassId: ProtocolId;
  readonly finalAllocationReceiptHash: CommitmentHash;
  readonly allocationReceiptHash: CommitmentHash;
  readonly nettingProofHash: CommitmentHash;
  readonly settlementCommitmentHash: CommitmentHash;
  readonly obligationId: CommitmentHash;
  readonly packageOrderId: CommitmentHash;
  readonly strategyOrderHash: CommitmentHash;
  readonly ownerId: ProtocolId;
  readonly settlementAccount: ProtocolId;
  readonly domain: DomainRef;
  readonly instrumentId: ProtocolId;
  readonly instrumentHash: CommitmentHash;
  readonly quantityAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly stateKind: NettingSettlementStateKind;
  readonly settledQuantityAtoms: bigint;
  readonly settledQuoteDeltaAtoms: bigint;
  readonly executionPlanHash: CommitmentHash;
  readonly solverId: ProtocolId;
  readonly protocolFeeAtoms: bigint;
  readonly solverFeeAtoms: bigint;
  readonly nonce: bigint;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
}

type AuthorizationPayload = Omit<NettingAllocationExecutionAuthorization, 'authorizationHash'>;

function version(value: number, context: string): 1 {
  if (typeof value !== 'number'
    || Number(checkedUnsigned(value, U32_BITS, context)) !== NETTING_ALLOCATION_EXECUTION_AUTHORIZATION_VERSION) {
    throw new MalformedInputError(
      context,
      `version must equal ${NETTING_ALLOCATION_EXECUTION_AUTHORIZATION_VERSION}`,
    );
  }
  return 1;
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && compareBytes(left.assetManifestHash, right.assetManifestHash) === 0;
}

function allocation(
  receipt: NettingFinalAllocationReceipt,
  allocationReceiptHash: Uint8Array | string,
): NettingFinalAllocation {
  const hash = commitmentHash(
    allocationReceiptHash,
    'nettingAllocationExecutionAuthorization.allocationReceiptHash',
  );
  const value = receipt.allocations.find((candidate) => compareBytes(candidate.allocationReceiptHash, hash) === 0);
  if (value === undefined) {
    throw new MalformedInputError(
      'nettingAllocationExecutionAuthorization.allocationReceiptHash',
      'allocation is not in the final allocation receipt',
    );
  }
  return value;
}

function checkedPayload(
  input: NettingAllocationExecutionAuthorizationInput | NettingAllocationExecutionAuthorization,
  receipt: NettingFinalAllocationReceipt,
  result: NettingResult,
  policyInput: NettingPolicyManifestInput | NettingPolicyManifest,
  intents: readonly NettingExternalExecutionIntent[],
  externalEvidence: readonly NettingExternalExecutionEvidence[],
  settlement: PackageSettlementCommitmentInput | PackageSettlementCommitment,
  crossBatchResolutions: readonly CrossBatchNettingResolution[],
): AuthorizationPayload {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError('nettingAllocationExecutionAuthorization', 'expected an object');
  }
  verifyNettingFinalAllocationReceipt(
    receipt,
    result,
    policyInput,
    intents,
    externalEvidence,
    crossBatchResolutions,
  );
  const policy = nettingPolicyManifest(policyInput, 'nettingAllocationExecutionAuthorization.policy');
  const finalAllocationReceiptHash = commitmentHash(
    input.finalAllocationReceiptHash,
    'nettingAllocationExecutionAuthorization.finalAllocationReceiptHash',
  );
  if (compareBytes(finalAllocationReceiptHash, receipt.receiptHash) !== 0) {
    throw new MalformedInputError(
      'nettingAllocationExecutionAuthorization.finalAllocationReceiptHash',
      'authorization cites another final allocation receipt',
    );
  }
  const selected = allocation(receipt, input.allocationReceiptHash);
  const instrument = policy.instruments.find((candidate) =>
    candidate.instrumentId === selected.instrumentId
      && compareBytes(candidate.instrumentHash, selected.instrumentHash) === 0);
  if (instrument === undefined) {
    throw new MalformedInputError(
      'nettingAllocationExecutionAuthorization.instrumentId',
      'allocation instrument is not in the netting policy',
    );
  }
  const checkedSettlement = packageSettlementCommitment(
    settlement,
    'nettingAllocationExecutionAuthorization.settlementCommitment',
  );
  const expectedSettlementHash = packageSettlementCommitmentHash(checkedSettlement);
  const settlementCommitmentHash = commitmentHash(
    input.settlementCommitmentHash,
    'nettingAllocationExecutionAuthorization.settlementCommitmentHash',
  );
  if (compareBytes(settlementCommitmentHash, expectedSettlementHash) !== 0) {
    throw new MalformedInputError(
      'nettingAllocationExecutionAuthorization.settlementCommitmentHash',
      'authorization cites another settlement commitment',
    );
  }
  if (
    checkedSettlement.environment !== policy.environment
    || checkedSettlement.executionClassId !== policy.executionClassId
    || compareBytes(checkedSettlement.packageOrderId, selected.packageOrderId) !== 0
    || compareBytes(checkedSettlement.strategyOrderHash, selected.strategyOrderHash) !== 0
    || checkedSettlement.participantId !== selected.ownerId
  ) {
    throw new MalformedInputError(
      'nettingAllocationExecutionAuthorization.settlementCommitment',
      'settlement commitment does not own the allocation',
    );
  }
  enumDiscriminant(EXPIRY_UNIT, input.validUntilUnit, 'nettingAllocationExecutionAuthorization.validUntilUnit');
  const validUntilValue = checkedUnsigned(
    input.validUntilValue,
    U64_BITS,
    'nettingAllocationExecutionAuthorization.validUntilValue',
  );
  if (
    validUntilValue === 0n
    || input.validUntilUnit !== checkedSettlement.validUntilUnit
    || validUntilValue > checkedSettlement.validUntilValue
  ) {
    throw new MalformedInputError(
      'nettingAllocationExecutionAuthorization.validUntilValue',
      'execution authorization outlives its settlement commitment',
    );
  }
  if (!sameAsset(selected.quoteAsset, instrument.quoteAsset)) {
    throw new MalformedInputError(
      'nettingAllocationExecutionAuthorization.quoteAsset',
      'allocation quote asset differs from its instrument',
    );
  }
  return Object.freeze({
    version: version(input.version, 'nettingAllocationExecutionAuthorization.version'),
    environment: policy.environment,
    executionClassId: policy.executionClassId,
    finalAllocationReceiptHash,
    allocationReceiptHash: selected.allocationReceiptHash,
    nettingProofHash: receipt.nettingProofHash,
    settlementCommitmentHash,
    obligationId: selected.obligationId,
    packageOrderId: selected.packageOrderId,
    strategyOrderHash: selected.strategyOrderHash,
    ownerId: selected.ownerId,
    settlementAccount: protocolId(
      checkedSettlement.settlementAccount,
      'nettingAllocationExecutionAuthorization.settlementAccount',
    ),
    domain: instrument.domain,
    instrumentId: instrument.instrumentId,
    instrumentHash: instrument.instrumentHash,
    quantityAsset: instrument.quantityAsset,
    quoteAsset: instrument.quoteAsset,
    stateKind: nettingSettlementStateKind(instrument.legFamily),
    settledQuantityAtoms: checkedSigned(
      selected.totalQuantityAtoms,
      I128_BITS,
      'nettingAllocationExecutionAuthorization.settledQuantityAtoms',
    ),
    settledQuoteDeltaAtoms: checkedSigned(
      selected.totalQuoteDeltaAtoms,
      I256_BITS,
      'nettingAllocationExecutionAuthorization.settledQuoteDeltaAtoms',
    ),
    executionPlanHash: commitmentHash(
      input.executionPlanHash,
      'nettingAllocationExecutionAuthorization.executionPlanHash',
    ),
    solverId: protocolId(input.solverId, 'nettingAllocationExecutionAuthorization.solverId'),
    protocolFeeAtoms: checkedUnsigned(
      input.protocolFeeAtoms,
      U128_BITS,
      'nettingAllocationExecutionAuthorization.protocolFeeAtoms',
    ),
    solverFeeAtoms: checkedUnsigned(
      input.solverFeeAtoms,
      U128_BITS,
      'nettingAllocationExecutionAuthorization.solverFeeAtoms',
    ),
    nonce: checkedUnsigned(input.nonce, U64_BITS, 'nettingAllocationExecutionAuthorization.nonce'),
    validUntilUnit: input.validUntilUnit,
    validUntilValue,
  });
}

function authorizationBytes(input: AuthorizationPayload): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeProtocolId(writer, input.environment, 'environment');
    encodeProtocolId(writer, input.executionClassId, 'executionClassId');
    encodeCommitmentHash(writer, input.finalAllocationReceiptHash, 'finalAllocationReceiptHash');
    encodeCommitmentHash(writer, input.allocationReceiptHash, 'allocationReceiptHash');
    encodeCommitmentHash(writer, input.nettingProofHash, 'nettingProofHash');
    encodeCommitmentHash(writer, input.settlementCommitmentHash, 'settlementCommitmentHash');
    encodeCommitmentHash(writer, input.obligationId, 'obligationId');
    encodeCommitmentHash(writer, input.packageOrderId, 'packageOrderId');
    encodeCommitmentHash(writer, input.strategyOrderHash, 'strategyOrderHash');
    encodeProtocolId(writer, input.ownerId, 'ownerId');
    encodeProtocolId(writer, input.settlementAccount, 'settlementAccount');
    encodeDomainRef(writer, input.domain);
    encodeProtocolId(writer, input.instrumentId, 'instrumentId');
    encodeCommitmentHash(writer, input.instrumentHash, 'instrumentHash');
    encodeAssetRef(writer, input.quantityAsset);
    encodeAssetRef(writer, input.quoteAsset);
    writer.writeEnum(
      NETTING_SETTLEMENT_STATE_KIND,
      input.stateKind,
      'stateKind',
    );
    writer.writeI128(input.settledQuantityAtoms, 'settledQuantityAtoms');
    writer.writeI256(input.settledQuoteDeltaAtoms, 'settledQuoteDeltaAtoms');
    encodeCommitmentHash(writer, input.executionPlanHash, 'executionPlanHash');
    encodeProtocolId(writer, input.solverId, 'solverId');
    writer.writeU128(input.protocolFeeAtoms, 'protocolFeeAtoms');
    writer.writeU128(input.solverFeeAtoms, 'solverFeeAtoms');
    writer.writeU64(input.nonce, 'nonce');
    writer.writeEnum(EXPIRY_UNIT, input.validUntilUnit, 'validUntilUnit');
    writer.writeU64(input.validUntilValue, 'validUntilValue');
  });
}

export function nettingAllocationExecutionAuthorization(
  input: NettingAllocationExecutionAuthorizationInput,
  receipt: NettingFinalAllocationReceipt,
  result: NettingResult,
  policy: NettingPolicyManifestInput | NettingPolicyManifest,
  intents: readonly NettingExternalExecutionIntent[],
  externalEvidence: readonly NettingExternalExecutionEvidence[],
  settlement: PackageSettlementCommitmentInput | PackageSettlementCommitment,
  crossBatchResolutions: readonly CrossBatchNettingResolution[] = [],
): NettingAllocationExecutionAuthorization {
  const payload = checkedPayload(
    input,
    receipt,
    result,
    policy,
    intents,
    externalEvidence,
    settlement,
    crossBatchResolutions,
  );
  const authorizationHash = commitmentHash(
    domainHash(HASH_DOMAIN.NETTING_ALLOCATION_EXECUTION_AUTHORIZATION, authorizationBytes(payload)),
    'nettingAllocationExecutionAuthorization.authorizationHash',
  );
  return Object.freeze({ ...payload, authorizationHash });
}

export function nettingAllocationExecutionAuthorizationBytes(
  input: NettingAllocationExecutionAuthorization,
  receipt: NettingFinalAllocationReceipt,
  result: NettingResult,
  policy: NettingPolicyManifestInput | NettingPolicyManifest,
  intents: readonly NettingExternalExecutionIntent[],
  externalEvidence: readonly NettingExternalExecutionEvidence[],
  settlement: PackageSettlementCommitmentInput | PackageSettlementCommitment,
  crossBatchResolutions: readonly CrossBatchNettingResolution[] = [],
): Uint8Array {
  return authorizationBytes(checkedPayload(
    input,
    receipt,
    result,
    policy,
    intents,
    externalEvidence,
    settlement,
    crossBatchResolutions,
  ));
}

export function verifyNettingAllocationExecutionAuthorization(
  authorization: NettingAllocationExecutionAuthorization,
  receipt: NettingFinalAllocationReceipt,
  result: NettingResult,
  policy: NettingPolicyManifestInput | NettingPolicyManifest,
  intents: readonly NettingExternalExecutionIntent[],
  externalEvidence: readonly NettingExternalExecutionEvidence[],
  settlement: PackageSettlementCommitmentInput | PackageSettlementCommitment,
  crossBatchResolutions: readonly CrossBatchNettingResolution[] = [],
): void {
  const payload = checkedPayload(
    authorization,
    receipt,
    result,
    policy,
    intents,
    externalEvidence,
    settlement,
    crossBatchResolutions,
  );
  const expected = commitmentHash(
    domainHash(HASH_DOMAIN.NETTING_ALLOCATION_EXECUTION_AUTHORIZATION, authorizationBytes(payload)),
    'nettingAllocationExecutionAuthorization.authorizationHash',
  );
  if (compareBytes(expected, authorization.authorizationHash) !== 0) {
    throw new MalformedInputError(
      'nettingAllocationExecutionAuthorization.authorizationHash',
      'authorization hash does not match its contents',
    );
  }
}
