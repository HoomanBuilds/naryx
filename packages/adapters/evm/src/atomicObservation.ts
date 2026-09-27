import { decodeEventLog, getAddress, zeroHash, type Address, type Hex } from 'viem';
import { PACKAGE_VERIFIER_OBSERVATION_ABI } from './abi.js';
import {
  chainReference,
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

export type EvmAtomicLifecycle =
  | 'NOT_FOUND'
  | 'SUBMITTED'
  | 'REVERTED'
  | 'CONFIRMED'
  | 'FINALIZED'
  | 'EVIDENCE_MISMATCH';

export interface EvmAtomicObservationBinding {
  readonly chainReference: bigint;
  readonly packageVerifier: Address;
  readonly strategyAccount: Address;
  readonly orderHash: Hex;
  readonly quoteHash: Hex;
  readonly routeHash: Hex;
  readonly executionPlanKind: 'EVM_ATOMIC_BATCH';
}

export interface EvmAtomicPackageReceipt {
  readonly receiptHash: Hex;
  readonly domainIdHash: Hex;
  readonly domainManifestVersion: number;
  readonly domainManifestHash: Hex;
  readonly orderHash: Hex;
  readonly quoteHash: Hex;
  readonly routeHash: Hex;
  readonly spotFillCommitment: Hex;
  readonly seriesIdentityKey: Hex;
  readonly seriesBindingVersion: number;
  readonly seriesBindingHash: Hex;
  readonly action: number;
  readonly strategyAccount: Address;
  readonly solver: Address;
  readonly recovery: boolean;
  readonly baseQuantityAtoms: bigint;
  readonly spotQuoteAtoms: bigint;
  readonly packageSizeUnits: bigint;
  readonly nonce: bigint;
}

export interface EvmAtomicOpenPackage {
  readonly entryReceiptHash: Hex;
  readonly routeHash: Hex;
  readonly baseQuantityAtoms: bigint;
  readonly packageSizeUnits: bigint;
}

export interface EvmAtomicObservation {
  readonly lifecycle: EvmAtomicLifecycle;
  readonly evidenceGrade: EvmEvidenceGrade;
  readonly chainReference: bigint;
  readonly transactionHash: Hex | null;
  readonly blockNumber: bigint | null;
  readonly confirmations: number | null;
  readonly receiptHash: Hex | null;
  readonly packageReceipt: EvmAtomicPackageReceipt | null;
  readonly openPackage: EvmAtomicOpenPackage | null;
  readonly reason: string | null;
}

function lowerHash(value: unknown, name: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte hash`);
  }
  return value.toLowerCase() as Hex;
}

function requireBool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function normalizeReceipt(receiptHash: Hex, record: unknown): EvmAtomicPackageReceipt {
  const quantity = (index: number, name: string): bigint => {
    const value = structField(record, index, name);
    if (typeof value !== 'bigint' || value < 0n) throw new Error(`receipt field ${name} must be a non-negative integer`);
    return value;
  };
  return Object.freeze({
    receiptHash,
    domainIdHash: lowerHash(structField(record, 0, 'domainIdHash'), 'receipt.domainIdHash'),
    domainManifestVersion: safeCount(structField(record, 1, 'domainManifestVersion'), 'receipt.domainManifestVersion'),
    domainManifestHash: lowerHash(structField(record, 2, 'domainManifestHash'), 'receipt.domainManifestHash'),
    orderHash: lowerHash(structField(record, 3, 'orderHash'), 'receipt.orderHash'),
    quoteHash: lowerHash(structField(record, 4, 'quoteHash'), 'receipt.quoteHash'),
    routeHash: lowerHash(structField(record, 5, 'routeHash'), 'receipt.routeHash'),
    spotFillCommitment: lowerHash(structField(record, 6, 'spotFillCommitment'), 'receipt.spotFillCommitment'),
    seriesIdentityKey: lowerHash(structField(record, 9, 'seriesIdentityKey'), 'receipt.seriesIdentityKey'),
    seriesBindingVersion: safeCount(structField(record, 10, 'seriesBindingVersion'), 'receipt.seriesBindingVersion'),
    seriesBindingHash: lowerHash(structField(record, 11, 'seriesBindingHash'), 'receipt.seriesBindingHash'),
    action: safeCount(structField(record, 12, 'action'), 'receipt.action'),
    strategyAccount: getAddress(String(structField(record, 13, 'strategyAccount'))),
    solver: getAddress(String(structField(record, 14, 'solver'))),
    recovery: requireBool(structField(record, 15, 'recovery'), 'receipt.recovery'),
    baseQuantityAtoms: quantity(16, 'baseQuantityAtoms'),
    spotQuoteAtoms: quantity(17, 'spotQuoteAtoms'),
    packageSizeUnits: quantity(18, 'packageSizeUnits'),
    nonce: quantity(26, 'nonce'),
  });
}

function normalizeOpenPackage(record: unknown): EvmAtomicOpenPackage {
  const quantity = (index: number, name: string): bigint => {
    const value = structField(record, index, name);
    if (typeof value !== 'bigint' || value < 0n) throw new Error(`open package field ${name} must be a non-negative integer`);
    return value;
  };
  return Object.freeze({
    entryReceiptHash: lowerHash(structField(record, 0, 'entryReceiptHash'), 'openPackage.entryReceiptHash'),
    routeHash: lowerHash(structField(record, 4, 'routeHash'), 'openPackage.routeHash'),
    baseQuantityAtoms: quantity(11, 'baseQuantityAtoms'),
    packageSizeUnits: quantity(13, 'packageSizeUnits'),
  });
}

function baseObservation(
  lifecycle: EvmAtomicLifecycle,
  grade: EvmEvidenceGrade,
  binding: EvmAtomicObservationBinding,
  transactionHash: Hex | null,
  extra: Partial<EvmAtomicObservation>,
): EvmAtomicObservation {
  return Object.freeze({
    lifecycle,
    evidenceGrade: grade,
    chainReference: binding.chainReference,
    transactionHash,
    blockNumber: null,
    confirmations: null,
    receiptHash: null,
    packageReceipt: null,
    openPackage: null,
    reason: null,
    ...extra,
  });
}

export async function observeEvmAtomicPackage(
  port: EvmReadPort,
  binding: EvmAtomicObservationBinding,
  transactionHash: Hex,
  finality: EvmFinalityPolicy,
): Promise<EvmAtomicObservation> {
  const expectedChain = chainReference(binding.chainReference, 'chainReference');
  const verifier = requiredEvmAddress(binding.packageVerifier, 'packageVerifier');
  const strategyAccount = requiredEvmAddress(binding.strategyAccount, 'strategyAccount');
  const orderHash = hash32(binding.orderHash, 'orderHash');
  const quoteHash = hash32(binding.quoteHash, 'quoteHash');
  const routeHash = hash32(binding.routeHash, 'routeHash');
  if (binding.executionPlanKind !== 'EVM_ATOMIC_BATCH') {
    throw new Error('asynchronous routes require the async bonded observer, never the atomic observer');
  }
  const transaction = hash32(transactionHash, 'transactionHash');
  validateFinalityPolicy(finality);

  const observedChain = await port.chainId();
  if (observedChain !== expectedChain) {
    return baseObservation('EVIDENCE_MISMATCH', 'none', { ...binding, chainReference: expectedChain }, transaction, {
      reason: 'observed chain ID does not match the expected chain reference',
    });
  }

  const receipt = await port.transactionReceipt(transaction);
  if (receipt === null) {
    return baseObservation('NOT_FOUND', 'none', { ...binding, chainReference: expectedChain }, transaction, {
      reason: 'transaction receipt is unknown to the read port',
    });
  }
  if (receipt.status !== 'success' && receipt.status !== 'reverted') {
    return baseObservation('EVIDENCE_MISMATCH', 'transaction-receipt', { ...binding, chainReference: expectedChain }, transaction, {
      reason: 'transaction receipt carries an unknown status',
    });
  }
  if (typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber < 0n) {
    return baseObservation('EVIDENCE_MISMATCH', 'transaction-receipt', { ...binding, chainReference: expectedChain }, transaction, {
      reason: 'transaction receipt carries an invalid block number',
    });
  }

  const head = await port.chainHead();
  const latestBlock = (head as { latestBlock?: unknown } | null | undefined)?.latestBlock;
  const finalizedBlock = (head as { finalizedBlock?: unknown } | null | undefined)?.finalizedBlock;
  if (typeof latestBlock !== 'bigint' || latestBlock < 0n) {
    return baseObservation('EVIDENCE_MISMATCH', 'transaction-receipt', { ...binding, chainReference: expectedChain }, transaction, {
      blockNumber: receipt.blockNumber,
      reason: 'chain head carries an invalid latest block',
    });
  }
  if (finalizedBlock !== null && (typeof finalizedBlock !== 'bigint' || finalizedBlock < 0n || finalizedBlock > latestBlock)) {
    return baseObservation('EVIDENCE_MISMATCH', 'transaction-receipt', { ...binding, chainReference: expectedChain }, transaction, {
      blockNumber: receipt.blockNumber,
      reason: 'chain head carries an invalid finalized block',
    });
  }
  if (latestBlock < receipt.blockNumber) {
    return baseObservation('EVIDENCE_MISMATCH', 'transaction-receipt', { ...binding, chainReference: expectedChain }, transaction, {
      blockNumber: receipt.blockNumber,
      reason: 'chain head is behind the transaction block',
    });
  }
  const depth = latestBlock - receipt.blockNumber + 1n;
  const confirmations = depth > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(depth);
  const meetsConfirmations = confirmations >= finality.requiredConfirmations;
  const isFinalized = finalizedBlock !== null && receipt.blockNumber <= finalizedBlock;

  if (receipt.status === 'reverted') {
    return baseObservation('REVERTED', 'transaction-receipt', { ...binding, chainReference: expectedChain }, transaction, {
      blockNumber: receipt.blockNumber,
      confirmations,
      reason: 'transaction reverted on chain',
    });
  }

  const candidates: Hex[] = [];
  for (const log of receipt.logs) {
    let decoded: { eventName?: string; args?: Record<string, unknown> };
    try {
      decoded = decodeEventLog({
        abi: PACKAGE_VERIFIER_OBSERVATION_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      }) as unknown as { eventName?: string; args?: Record<string, unknown> };
    } catch {
      continue;
    }
    if (decoded.eventName !== 'PackageVerified' || decoded.args === undefined) continue;
    if (!equalAddress(log.address, verifier)) continue;
    if (!equalAddress(getAddress(String(decoded.args.strategyAccount)), strategyAccount)) continue;
    candidates.push(lowerHash(decoded.args.receiptHash, 'PackageVerified.receiptHash'));
  }

  if (candidates.length === 0) {
    return baseObservation('EVIDENCE_MISMATCH', 'transaction-receipt', { ...binding, chainReference: expectedChain }, transaction, {
      blockNumber: receipt.blockNumber,
      confirmations,
      reason: 'transaction succeeded but carries no matching PackageVerified log',
    });
  }

  let matched: EvmAtomicPackageReceipt | null = null;
  let matchedHash: Hex | null = null;
  let receiptReadable = false;
  for (const candidate of candidates) {
    let record: unknown;
    try {
      record = await port.readContract({ address: verifier, abi: PACKAGE_VERIFIER_OBSERVATION_ABI, functionName: 'receipt', args: [candidate] });
    } catch {
      continue;
    }
    receiptReadable = true;
    let normalized: EvmAtomicPackageReceipt;
    try {
      normalized = normalizeReceipt(candidate, record);
    } catch {
      continue;
    }
    if (normalized.orderHash === zeroHash) continue;
    if (!equalHash(normalized.orderHash, orderHash) || !equalHash(normalized.quoteHash, quoteHash) || !equalHash(normalized.routeHash, routeHash)) {
      continue;
    }
    if (!equalAddress(normalized.strategyAccount, strategyAccount)) continue;
    matched = normalized;
    matchedHash = candidate;
    break;
  }

  let open: EvmAtomicOpenPackage | null = null;
  if (matched === null && !receiptReadable) {
    let record: unknown;
    try {
      record = await port.readContract({ address: verifier, abi: PACKAGE_VERIFIER_OBSERVATION_ABI, functionName: 'openPackage', args: [strategyAccount] });
    } catch {
      record = null;
    }
    if (record !== null && record !== undefined) {
      try {
        const candidate = normalizeOpenPackage(record);
        if (candidate.entryReceiptHash !== zeroHash && candidates.includes(candidate.entryReceiptHash) && equalHash(candidate.routeHash, routeHash)) {
          open = candidate;
          matchedHash = candidate.entryReceiptHash;
        }
      } catch {
        open = null;
      }
    }
  }

  if (matched === null && open === null) {
    return baseObservation('EVIDENCE_MISMATCH', receiptReadable ? 'contract-state' : 'transaction-receipt', { ...binding, chainReference: expectedChain }, transaction, {
      blockNumber: receipt.blockNumber,
      confirmations,
      receiptHash: candidates[0] ?? null,
      reason: 'PackageVerified log commitments do not match the bound order, quote, route, or strategy account',
    });
  }

  if (!meetsConfirmations) {
    return baseObservation('SUBMITTED', 'contract-state', { ...binding, chainReference: expectedChain }, transaction, {
      blockNumber: receipt.blockNumber,
      confirmations,
      receiptHash: matchedHash,
      packageReceipt: matched,
      openPackage: open,
      reason: 'package evidence is visible but required confirmations are not met',
    });
  }
  if (isFinalized) {
    return baseObservation('FINALIZED', 'finalized-contract-receipt', { ...binding, chainReference: expectedChain }, transaction, {
      blockNumber: receipt.blockNumber,
      confirmations,
      receiptHash: matchedHash,
      packageReceipt: matched,
      openPackage: open,
      reason: null,
    });
  }
  return baseObservation('CONFIRMED', 'contract-state', { ...binding, chainReference: expectedChain }, transaction, {
    blockNumber: receipt.blockNumber,
    confirmations,
    receiptHash: matchedHash,
    packageReceipt: matched,
    openPackage: open,
    reason: finality.requireFinalized ? 'package is confirmed but not yet covered by a finalized block' : null,
  });
}
