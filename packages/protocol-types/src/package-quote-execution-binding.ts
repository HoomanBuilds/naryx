import { checkedUnsigned } from './arithmetic.js';
import { assertUint8Array, bytesEqual } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  EXPIRY_UNIT,
  SOLVER_SIGNATURE_SCHEME,
  type ExpiryUnit,
  type SolverSignatureScheme,
} from './enums.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  commitmentHash,
  encodeCommitmentHash,
  type CommitmentHash,
} from './package-order-primitives.js';
import {
  packageSettlementReadiness,
  packageSettlementReadinessHash,
  type PackageSettlementReadinessInput,
} from './package-settlement.js';
import {
  encodeProtocolId,
  protocolId,
  type ProtocolId,
} from './primitives.js';
import {
  strategyPackageQuote,
  strategyPackageQuoteHash,
  type StrategyPackageQuoteInput,
} from './strategy-package-quote.js';

export const PACKAGE_QUOTE_EXECUTION_BINDING_VERSION = 1;
const U32_BITS = 32;
const U64_BITS = 64;
const MAX_KEY_BYTES = 128;
const MAX_SIGNATURE_BYTES = 128;

export interface PackageQuoteExecutionBindingInput {
  readonly version: number;
  readonly packageOrderId: Uint8Array | string;
  readonly settlementReadinessHash: Uint8Array | string;
  readonly strategyOrderHash: Uint8Array | string;
  readonly strategyQuoteHash: Uint8Array | string;
  readonly routeHash: Uint8Array | string;
  readonly executionClassId: string;
  readonly solverId: string;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
  readonly solverSignatureScheme: SolverSignatureScheme;
  readonly solverVerificationKey: Uint8Array;
  readonly signature: Uint8Array;
}

export interface PackageQuoteExecutionBinding extends Omit<
  PackageQuoteExecutionBindingInput,
  | 'packageOrderId'
  | 'settlementReadinessHash'
  | 'strategyOrderHash'
  | 'strategyQuoteHash'
  | 'routeHash'
  | 'executionClassId'
  | 'solverId'
  | 'solverVerificationKey'
  | 'signature'
> {
  readonly version: 1;
  readonly packageOrderId: CommitmentHash;
  readonly settlementReadinessHash: CommitmentHash;
  readonly strategyOrderHash: CommitmentHash;
  readonly strategyQuoteHash: CommitmentHash;
  readonly routeHash: CommitmentHash;
  readonly executionClassId: ProtocolId;
  readonly solverId: ProtocolId;
  readonly solverVerificationKey: Uint8Array;
  readonly signature: Uint8Array;
}

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an object');
  }
}

export function packageQuoteExecutionBinding(
  input: PackageQuoteExecutionBindingInput,
  context = 'packageQuoteExecutionBinding',
): PackageQuoteExecutionBinding {
  object(input, context);
  const version = Number(checkedUnsigned(input.version, U32_BITS, `${context}.version`));
  if (version !== PACKAGE_QUOTE_EXECUTION_BINDING_VERSION) {
    throw new MalformedInputError(`${context}.version`, `version must equal ${PACKAGE_QUOTE_EXECUTION_BINDING_VERSION}`);
  }
  enumDiscriminant(EXPIRY_UNIT, input.validUntilUnit, `${context}.validUntilUnit`);
  enumDiscriminant(SOLVER_SIGNATURE_SCHEME, input.solverSignatureScheme, `${context}.solverSignatureScheme`);
  const validUntilValue = checkedUnsigned(input.validUntilValue, U64_BITS, `${context}.validUntilValue`);
  if (validUntilValue === 0n) throw new MalformedInputError(`${context}.validUntilValue`, 'expiry is zero');
  assertUint8Array(input.solverVerificationKey, `${context}.solverVerificationKey`);
  assertUint8Array(input.signature, `${context}.signature`);
  if (input.solverVerificationKey.length === 0 || input.solverVerificationKey.length > MAX_KEY_BYTES) {
    throw new MalformedInputError(`${context}.solverVerificationKey`, `verification key length is outside 1 to ${MAX_KEY_BYTES} bytes`);
  }
  if (input.signature.length > MAX_SIGNATURE_BYTES) {
    throw new MalformedInputError(`${context}.signature`, `signature exceeds ${MAX_SIGNATURE_BYTES} bytes`);
  }
  return Object.freeze({
    version: PACKAGE_QUOTE_EXECUTION_BINDING_VERSION,
    packageOrderId: commitmentHash(input.packageOrderId, `${context}.packageOrderId`),
    settlementReadinessHash: commitmentHash(input.settlementReadinessHash, `${context}.settlementReadinessHash`),
    strategyOrderHash: commitmentHash(input.strategyOrderHash, `${context}.strategyOrderHash`),
    strategyQuoteHash: commitmentHash(input.strategyQuoteHash, `${context}.strategyQuoteHash`),
    routeHash: commitmentHash(input.routeHash, `${context}.routeHash`),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    solverId: protocolId(input.solverId, `${context}.solverId`),
    validUntilUnit: input.validUntilUnit,
    validUntilValue,
    solverSignatureScheme: input.solverSignatureScheme,
    solverVerificationKey: Uint8Array.from(input.solverVerificationKey),
    signature: Uint8Array.from(input.signature),
  });
}

function encodeUnsignedPackageQuoteExecutionBinding(
  writer: CanonicalWriter,
  binding: PackageQuoteExecutionBinding,
  context: string,
): void {
  writer.writeU32(binding.version, `${context}.version`);
  encodeCommitmentHash(writer, binding.packageOrderId, `${context}.packageOrderId`);
  encodeCommitmentHash(writer, binding.settlementReadinessHash, `${context}.settlementReadinessHash`);
  encodeCommitmentHash(writer, binding.strategyOrderHash, `${context}.strategyOrderHash`);
  encodeCommitmentHash(writer, binding.strategyQuoteHash, `${context}.strategyQuoteHash`);
  encodeCommitmentHash(writer, binding.routeHash, `${context}.routeHash`);
  encodeProtocolId(writer, binding.executionClassId, `${context}.executionClassId`);
  encodeProtocolId(writer, binding.solverId, `${context}.solverId`);
  writer.writeEnum(EXPIRY_UNIT, binding.validUntilUnit, `${context}.validUntilUnit`);
  writer.writeU64(binding.validUntilValue, `${context}.validUntilValue`);
  writer.writeEnum(SOLVER_SIGNATURE_SCHEME, binding.solverSignatureScheme, `${context}.solverSignatureScheme`);
  writer.writeByteString(binding.solverVerificationKey, `${context}.solverVerificationKey`);
}

export function unsignedPackageQuoteExecutionBindingBytes(
  input: PackageQuoteExecutionBindingInput,
  context = 'packageQuoteExecutionBinding',
): Uint8Array {
  const binding = packageQuoteExecutionBinding(input, context);
  return canonicalBytes((writer) => encodeUnsignedPackageQuoteExecutionBinding(writer, binding, context));
}

export function packageQuoteExecutionBindingBytes(
  input: PackageQuoteExecutionBindingInput,
  context = 'packageQuoteExecutionBinding',
): Uint8Array {
  const binding = packageQuoteExecutionBinding(input, context);
  return canonicalBytes((writer) => {
    encodeUnsignedPackageQuoteExecutionBinding(writer, binding, context);
    writer.writeByteString(binding.signature, `${context}.signature`);
  });
}

export function packageQuoteExecutionBindingHash(
  input: PackageQuoteExecutionBindingInput,
): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.PACKAGE_QUOTE_EXECUTION_BINDING, unsignedPackageQuoteExecutionBindingBytes(input)),
    'packageQuoteExecutionBindingHash',
  );
}

export function validatePackageQuoteExecutionBinding(
  bindingInput: PackageQuoteExecutionBindingInput,
  readinessInput: PackageSettlementReadinessInput,
  quoteInput: StrategyPackageQuoteInput,
  context = 'validatePackageQuoteExecutionBinding',
): PackageQuoteExecutionBinding {
  const binding = packageQuoteExecutionBinding(bindingInput, `${context}.binding`);
  const readiness = packageSettlementReadiness(readinessInput, `${context}.readiness`);
  const quote = strategyPackageQuote(quoteInput, `${context}.quote`);
  const valid = readiness.status === 'READY_FOR_OWNER_AUTHORIZATION'
    && bytesEqual(binding.packageOrderId, readiness.packageOrderId)
    && bytesEqual(binding.settlementReadinessHash, packageSettlementReadinessHash(readiness))
    && bytesEqual(binding.strategyOrderHash, readiness.strategyOrderHash)
    && bytesEqual(binding.strategyOrderHash, quote.orderHash)
    && bytesEqual(binding.strategyQuoteHash, strategyPackageQuoteHash(quote))
    && bytesEqual(binding.routeHash, quote.routeHash)
    && binding.executionClassId === readiness.executionClassId
    && binding.executionClassId === quote.executionClassId
    && binding.solverId === quote.solverId
    && binding.validUntilUnit === quote.validUntilUnit
    && binding.validUntilValue <= quote.validUntilValue
    && binding.solverSignatureScheme === quote.solverSignatureScheme
    && bytesEqual(binding.solverVerificationKey, quote.solverVerificationKey);
  if (!valid) throw new MalformedInputError(context, 'binding does not match final settlement readiness and strategy quote');
  return binding;
}
