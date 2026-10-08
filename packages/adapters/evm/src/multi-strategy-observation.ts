import {
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
} from 'viem';
import type {
  EvmMultiStrategyExecution,
  EvmNettingAllocationEnvelope,
  EvmStrategyFeeTerms,
} from './multi-strategy-account.js';
import {
  equalAddress,
  equalHash,
  hash32,
  requiredEvmAddress,
  safeCount,
  structField,
  validateFinalityPolicy,
  type EvmEvidenceGrade,
  type EvmFinalityPolicy,
  type EvmReadPort,
} from './readPort.js';

const OBSERVATION_ABI = parseAbi([
  'event NettingAllocationExecuted(bytes32 indexed receiptHash,bytes32 indexed authorizationHash)',
  'function nettingAuthorizationOf(bytes32 receiptHash) view returns (bytes32 authorizationHash)',
  'function receipt(bytes32 receiptHash) view returns ((bytes32 packageId,bytes32 orderHash,bytes32 graphHash,bytes32 quoteHash,bytes32 routeHash,uint8 operation,bytes32 previousStateHash,bytes32 nextStateHash,bytes32 callsHash,bytes32 evidenceRoot,(uint32 policyVersion,bytes32 policyManifestHash,address token,uint256 protocolFeeAtoms,uint256 solverFeeAtoms) fees,uint256 nonce,address solver) value)',
]);
const RECEIPT_HASH_PARAMETERS = parseAbiParameters('bytes32 executionHash,bytes32 callsHash,bytes32 evidenceRoot');

export type EvmNettingAllocationLifecycle =
  | 'NOT_FOUND'
  | 'REVERTED'
  | 'CONFIRMING'
  | 'CONFIRMED'
  | 'FINALIZED'
  | 'EVIDENCE_MISMATCH';

export interface EvmNettingAllocationReceipt {
  readonly receiptHash: Hex;
  readonly packageId: Hex;
  readonly orderHash: Hex;
  readonly graphHash: Hex;
  readonly quoteHash: Hex;
  readonly routeHash: Hex;
  readonly operation: number;
  readonly previousStateHash: Hex;
  readonly nextStateHash: Hex;
  readonly callsHash: Hex;
  readonly evidenceRoot: Hex;
  readonly fees: EvmStrategyFeeTerms;
  readonly nonce: bigint;
  readonly solver: Address;
}

export interface EvmNettingAllocationObservation {
  readonly lifecycle: EvmNettingAllocationLifecycle;
  readonly evidenceGrade: EvmEvidenceGrade;
  readonly chainReference: bigint;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint | null;
  readonly confirmations: number | null;
  readonly authorizationHash: Hex;
  readonly receipt: EvmNettingAllocationReceipt | null;
  readonly reason: string | null;
}

export interface EvmNettingAllocationObservationBinding {
  readonly chainReference: bigint;
  readonly account: Address;
  readonly authorizationHash: Hex;
  readonly executionHash: Hex;
  readonly callsHash: Hex;
  readonly execution: EvmMultiStrategyExecution;
}

function mismatch(
  chainReference: bigint,
  transactionHash: Hex,
  authorizationHash: Hex,
  grade: EvmEvidenceGrade,
  reason: string,
  blockNumber: bigint | null = null,
  confirmations: number | null = null,
): EvmNettingAllocationObservation {
  return Object.freeze({
    lifecycle: 'EVIDENCE_MISMATCH',
    evidenceGrade: grade,
    chainReference,
    transactionHash,
    blockNumber,
    confirmations,
    authorizationHash,
    receipt: null,
    reason,
  });
}

function unsigned(value: unknown, context: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`${context} must be a non-negative integer`);
  return value;
}

function normalizedFees(value: unknown): EvmStrategyFeeTerms {
  return Object.freeze({
    policyVersion: safeCount(structField(value, 0, 'policyVersion'), 'receipt fee policy version'),
    policyManifestHash: hash32(String(structField(value, 1, 'policyManifestHash')).toLowerCase(), 'receipt fee policy hash'),
    token: requiredEvmAddress(structField(value, 2, 'token'), 'receipt fee token'),
    protocolFeeAtoms: unsigned(structField(value, 3, 'protocolFeeAtoms'), 'receipt protocol fee'),
    solverFeeAtoms: unsigned(structField(value, 4, 'solverFeeAtoms'), 'receipt solver fee'),
  });
}

function normalizedReceipt(receiptHash: Hex, value: unknown): EvmNettingAllocationReceipt {
  return Object.freeze({
    receiptHash,
    packageId: hash32(String(structField(value, 0, 'packageId')).toLowerCase(), 'receipt package id'),
    orderHash: hash32(String(structField(value, 1, 'orderHash')).toLowerCase(), 'receipt order hash'),
    graphHash: hash32(String(structField(value, 2, 'graphHash')).toLowerCase(), 'receipt graph hash'),
    quoteHash: hash32(String(structField(value, 3, 'quoteHash')).toLowerCase(), 'receipt quote hash'),
    routeHash: hash32(String(structField(value, 4, 'routeHash')).toLowerCase(), 'receipt route hash'),
    operation: safeCount(structField(value, 5, 'operation'), 'receipt operation'),
    previousStateHash: hash32(String(structField(value, 6, 'previousStateHash')).toLowerCase(), 'receipt previous state'),
    nextStateHash: hash32(String(structField(value, 7, 'nextStateHash')).toLowerCase(), 'receipt next state'),
    callsHash: hash32(String(structField(value, 8, 'callsHash')).toLowerCase(), 'receipt calls hash'),
    evidenceRoot: hash32(String(structField(value, 9, 'evidenceRoot')).toLowerCase(), 'receipt evidence root'),
    fees: normalizedFees(structField(value, 10, 'fees')),
    nonce: unsigned(structField(value, 11, 'nonce'), 'receipt nonce'),
    solver: requiredEvmAddress(structField(value, 12, 'solver'), 'receipt solver'),
  });
}

function matchesBinding(
  receipt: EvmNettingAllocationReceipt,
  binding: EvmNettingAllocationObservationBinding,
): boolean {
  const execution = binding.execution;
  const fees = receipt.fees;
  return equalHash(receipt.packageId, execution.packageId)
    && equalHash(receipt.orderHash, execution.orderHash)
    && equalHash(receipt.graphHash, execution.graphHash)
    && equalHash(receipt.quoteHash, execution.quoteHash)
    && equalHash(receipt.routeHash, execution.routeHash)
    && receipt.operation === execution.operation
    && equalHash(receipt.previousStateHash, execution.previousStateHash)
    && equalHash(receipt.nextStateHash, execution.nextStateHash)
    && equalHash(receipt.callsHash, binding.callsHash)
    && fees.policyVersion === execution.fees.policyVersion
    && equalHash(fees.policyManifestHash, execution.fees.policyManifestHash)
    && equalAddress(fees.token, execution.fees.token)
    && fees.protocolFeeAtoms === execution.fees.protocolFeeAtoms
    && fees.solverFeeAtoms === execution.fees.solverFeeAtoms
    && receipt.nonce === execution.nonce
    && equalAddress(receipt.solver, execution.solver);
}

export function evmNettingAllocationObservationBinding(
  netting: EvmNettingAllocationEnvelope,
): EvmNettingAllocationObservationBinding {
  return Object.freeze({
    chainReference: BigInt(netting.ownerTypedData.domain.chainId),
    account: netting.envelope.account,
    authorizationHash: netting.authorizationHash,
    executionHash: netting.envelope.executionHash,
    callsHash: netting.envelope.callsHash,
    execution: netting.envelope.execution,
  });
}

export async function observeEvmNettingAllocation(
  port: EvmReadPort,
  input: Readonly<{
    binding: EvmNettingAllocationObservationBinding;
    transactionHash: Hex;
    finality: EvmFinalityPolicy;
  }>,
): Promise<EvmNettingAllocationObservation> {
  const account = requiredEvmAddress(input.binding.account, 'multi-strategy account');
  const transactionHash = hash32(input.transactionHash, 'transaction hash');
  const authorizationHash = hash32(input.binding.authorizationHash, 'authorization hash');
  if (input.binding.chainReference <= 0n) throw new Error('chain reference must be positive');
  validateFinalityPolicy(input.finality);
  if (await port.chainId() !== input.binding.chainReference) {
    return mismatch(input.binding.chainReference, transactionHash, authorizationHash, 'none', 'observed chain ID differs');
  }
  const transaction = await port.transactionReceipt(transactionHash);
  if (transaction === null) {
    return Object.freeze({
      lifecycle: 'NOT_FOUND', evidenceGrade: 'none', chainReference: input.binding.chainReference,
      transactionHash, blockNumber: null, confirmations: null, authorizationHash, receipt: null,
      reason: 'transaction receipt is unavailable',
    });
  }
  if (transaction.blockNumber < 0n) {
    return mismatch(input.binding.chainReference, transactionHash, authorizationHash, 'transaction-receipt', 'transaction block is invalid');
  }
  const head = await port.chainHead();
  if (head.latestBlock < transaction.blockNumber
    || (head.finalizedBlock !== null && (head.finalizedBlock < 0n || head.finalizedBlock > head.latestBlock))) {
    return mismatch(input.binding.chainReference, transactionHash, authorizationHash, 'transaction-receipt', 'chain head is inconsistent', transaction.blockNumber);
  }
  const depth = head.latestBlock - transaction.blockNumber + 1n;
  const confirmations = depth > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(depth);
  if (transaction.status === 'reverted') {
    return Object.freeze({
      lifecycle: 'REVERTED', evidenceGrade: 'transaction-receipt', chainReference: input.binding.chainReference,
      transactionHash, blockNumber: transaction.blockNumber, confirmations, authorizationHash, receipt: null,
      reason: 'transaction reverted',
    });
  }
  const events: Hex[] = [];
  for (const log of transaction.logs) {
    if (!equalAddress(log.address, account)) continue;
    try {
      const decoded = decodeEventLog({
        abi: OBSERVATION_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== 'NettingAllocationExecuted') continue;
      if (!equalHash(decoded.args.authorizationHash, authorizationHash)) continue;
      events.push(hash32(decoded.args.receiptHash, 'netting receipt hash'));
    } catch {
      continue;
    }
  }
  if (events.length !== 1) {
    return mismatch(input.binding.chainReference, transactionHash, authorizationHash, 'transaction-receipt', 'transaction has no unique matching netting event', transaction.blockNumber, confirmations);
  }
  const receiptHash = events[0]!;
  let storedAuthorization: unknown;
  let storedReceipt: unknown;
  try {
    storedAuthorization = await port.readContract({
      address: account,
      abi: OBSERVATION_ABI,
      functionName: 'nettingAuthorizationOf',
      args: [receiptHash],
    });
    storedReceipt = await port.readContract({
      address: account,
      abi: OBSERVATION_ABI,
      functionName: 'receipt',
      args: [receiptHash],
    });
  } catch {
    return mismatch(input.binding.chainReference, transactionHash, authorizationHash, 'transaction-receipt', 'contract evidence is unavailable', transaction.blockNumber, confirmations);
  }
  if (!equalHash(hash32(String(storedAuthorization).toLowerCase(), 'stored authorization hash'), authorizationHash)) {
    return mismatch(input.binding.chainReference, transactionHash, authorizationHash, 'contract-state', 'stored authorization differs', transaction.blockNumber, confirmations);
  }
  let receipt: EvmNettingAllocationReceipt;
  try {
    receipt = normalizedReceipt(receiptHash, storedReceipt);
  } catch {
    return mismatch(input.binding.chainReference, transactionHash, authorizationHash, 'contract-state', 'stored receipt is malformed', transaction.blockNumber, confirmations);
  }
  const expectedReceiptHash = keccak256(encodeAbiParameters(RECEIPT_HASH_PARAMETERS, [
    input.binding.executionHash,
    input.binding.callsHash,
    receipt.evidenceRoot,
  ]));
  if (!matchesBinding(receipt, input.binding) || !equalHash(receipt.receiptHash, expectedReceiptHash)) {
    return mismatch(input.binding.chainReference, transactionHash, authorizationHash, 'contract-state', 'stored receipt differs from the authorized execution', transaction.blockNumber, confirmations);
  }
  const finalized = head.finalizedBlock !== null && transaction.blockNumber <= head.finalizedBlock;
  const confirmed = confirmations >= input.finality.requiredConfirmations;
  if (!confirmed || (input.finality.requireFinalized && !finalized)) {
    return Object.freeze({
      lifecycle: 'CONFIRMING', evidenceGrade: 'contract-state', chainReference: input.binding.chainReference,
      transactionHash, blockNumber: transaction.blockNumber, confirmations, authorizationHash, receipt,
      reason: null,
    });
  }
  return Object.freeze({
    lifecycle: finalized ? 'FINALIZED' : 'CONFIRMED',
    evidenceGrade: finalized ? 'finalized-contract-receipt' : 'contract-state',
    chainReference: input.binding.chainReference,
    transactionHash,
    blockNumber: transaction.blockNumber,
    confirmations,
    authorizationHash,
    receipt,
    reason: null,
  });
}
