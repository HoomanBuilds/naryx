import type { CompiledExecution } from '@naryx/adapter-core';
import {
  bytesEqual,
  type DomainRef,
  type Hash32,
  type PackageAdmission,
} from '@naryx/protocol-types';
import {
  bytesToHex,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { ATOMIC_PACKAGE_EXECUTOR_ABI } from './abi.js';

export interface EvmLocalAtomicBinding {
  readonly chainReference: bigint;
  readonly domain: DomainRef;
  readonly executor: Address;
  readonly venue: Address;
  readonly solver: Address;
}

export interface EvmLocalAtomicBounds {
  readonly recipient: Address;
  readonly collateralAtoms: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly traderSignature: Hex;
  readonly solverSignature: Hex;
}

export interface EvmLocalAtomicExecution {
  readonly domainIdHash: Hex;
  readonly domainManifestVersion: number;
  readonly domainManifestHash: Hex;
  readonly orderHash: Hex;
  readonly quoteHash: Hex;
  readonly routeHash: Hex;
  readonly action: 1 | 2;
  readonly quantity: bigint;
  readonly limitQuote: bigint;
  readonly collateral: bigint;
  readonly trader: Address;
  readonly recipient: Address;
  readonly solver: Address;
  readonly venue: Address;
  readonly executor: Address;
  readonly chainId: bigint;
  readonly entryReceiptHash: Hex;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

export interface EvmLocalAtomicPayload {
  readonly chainReference: bigint;
  readonly to: Address;
  readonly value: 0n;
  readonly data: Hex;
  readonly execution: EvmLocalAtomicExecution;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function address(value: unknown, name: string): Address {
  requireCondition(typeof value === 'string' && isAddress(value, { strict: false }), `${name} must be an EVM address`);
  return getAddress(value);
}

function signature(value: unknown, name: string): Hex {
  requireCondition(typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value), `${name} must be 65 bytes`);
  return value as Hex;
}

function hash(value: Hash32, name: string): Hex {
  requireCondition(value instanceof Uint8Array && value.length === 32 && value.some((byte) => byte !== 0), `${name} must be nonzero`);
  return bytesToHex(value);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

export function compileEvmLocalAtomicExecution(
  admission: PackageAdmission,
  binding: EvmLocalAtomicBinding,
  bounds: EvmLocalAtomicBounds,
): CompiledExecution<EvmLocalAtomicPayload> {
  requireCondition(binding.chainReference > 0n, 'chain reference must be positive');
  requireCondition(sameDomain(admission.order.domain, binding.domain), 'order domain mismatch');
  requireCondition(sameDomain(admission.quote.domain, binding.domain), 'quote domain mismatch');
  requireCondition(sameDomain(admission.route.domain, binding.domain), 'route domain mismatch');
  requireCondition(admission.order.environment === 'local', 'order environment must be local');
  requireCondition(admission.quote.environment === 'local', 'quote environment must be local');
  requireCondition(admission.route.environment === 'local', 'route environment must be local');
  requireCondition(admission.order.action === admission.route.action, 'route action mismatch');
  requireCondition(admission.order.quantity.atoms > 0n, 'quantity must be positive');
  requireCondition(bounds.collateralAtoms > 0n, 'collateral must be positive');
  requireCondition(bounds.nonce >= 0n, 'nonce must be nonnegative');
  requireCondition(bounds.deadline > 0n, 'deadline must be positive');
  const trader = address(admission.order.owner, 'trader');
  const recipient = address(bounds.recipient, 'recipient');
  const executor = address(binding.executor, 'executor');
  const venue = address(binding.venue, 'venue');
  const solver = address(binding.solver, 'solver');
  const quotedSolver = address(bytesToHex(admission.quote.solverVerificationKey), 'quoted solver');
  requireCondition(quotedSolver === solver, 'quoted solver mismatch');
  requireCondition(admission.order.settlementAccount.toLowerCase() === executor.toLowerCase(), 'settlement account mismatch');
  const entry = admission.order.action === 'ENTRY';
  const limit = entry ? admission.order.maxSpotQuoteIn : admission.order.minSpotQuoteOut;
  requireCondition(limit !== undefined && limit.atoms > 0n, 'action quote limit is missing');
  const entryReceiptHash = entry
    ? zeroHash
    : hash(admission.order.entryReceiptHash as Hash32, 'entry receipt hash');
  const execution: EvmLocalAtomicExecution = {
    domainIdHash: keccak256(stringToHex(binding.domain.domainId)),
    domainManifestVersion: binding.domain.domainManifestVersion,
    domainManifestHash: hash(binding.domain.domainManifestHash, 'domain manifest hash'),
    orderHash: hash(admission.orderHash, 'order hash'),
    quoteHash: hash(admission.quoteHash, 'quote hash'),
    routeHash: hash(admission.routeHash, 'route hash'),
    action: entry ? 1 : 2,
    quantity: admission.order.quantity.atoms,
    limitQuote: limit.atoms,
    collateral: bounds.collateralAtoms,
    trader,
    recipient,
    solver,
    venue,
    executor,
    chainId: binding.chainReference,
    entryReceiptHash,
    nonce: bounds.nonce,
    deadline: bounds.deadline,
  };
  const data = encodeFunctionData({
    abi: ATOMIC_PACKAGE_EXECUTOR_ABI,
    functionName: 'execute',
    args: [execution, signature(bounds.traderSignature, 'trader signature'), signature(bounds.solverSignature, 'solver signature')],
  });
  return {
    domain: binding.domain,
    orderHash: admission.orderHash,
    quoteHash: admission.quoteHash,
    routeHash: admission.routeHash,
    payload: { chainReference: binding.chainReference, to: executor, value: 0n, data, execution },
  };
}
