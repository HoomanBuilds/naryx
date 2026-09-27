import { getAddress, isAddress, zeroAddress, type Abi, type Address, type Hex } from 'viem';

export interface EvmObservedLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export interface EvmObservedReceipt {
  readonly status: 'success' | 'reverted';
  readonly blockNumber: bigint;
  readonly logs: readonly EvmObservedLog[];
}

export interface EvmChainHead {
  readonly latestBlock: bigint;
  readonly finalizedBlock: bigint | null;
}

export interface EvmContractRead {
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args?: readonly unknown[];
}

export interface EvmReadPort {
  chainId(): Promise<bigint>;
  transactionReceipt(transactionHash: Hex): Promise<EvmObservedReceipt | null>;
  readContract(read: EvmContractRead): Promise<unknown>;
  chainHead(): Promise<EvmChainHead>;
}

export type EvmEvidenceGrade =
  | 'none'
  | 'transaction-receipt'
  | 'contract-state'
  | 'authenticated-callback-record'
  | 'finalized-contract-receipt';

export interface EvmFinalityPolicy {
  readonly requiredConfirmations: number;
  readonly requireFinalized: boolean;
}

export function validateFinalityPolicy(policy: EvmFinalityPolicy): void {
  if (
    typeof policy.requiredConfirmations !== 'number' || !Number.isSafeInteger(policy.requiredConfirmations)
    || policy.requiredConfirmations < 1
  ) {
    throw new Error('requiredConfirmations must be a safe integer >= 1');
  }
  if (typeof policy.requireFinalized !== 'boolean') throw new Error('requireFinalized must be a boolean');
}

export function hash32(value: unknown, name: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be a canonical lowercase 0x 32-byte hash`);
  }
  return value as Hex;
}

export function requiredEvmAddress(value: unknown, name: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new Error(`${name} must be an EVM address`);
  }
  const checked = getAddress(value);
  if (checked === zeroAddress) throw new Error(`${name} must be nonzero`);
  return checked;
}

export function chainReference(value: unknown, name: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n) throw new Error(`${name} must be a positive EIP-155 chain reference`);
  return value;
}

export function safeCount(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  throw new Error(`${name} must be a safe non-negative integer`);
}

export function structField(record: unknown, index: number, name: string): unknown {
  if (record !== null && typeof record === 'object') {
    const fields = record as Record<string, unknown>;
    const direct = fields[name];
    if (direct !== undefined) return direct;
    const dot = name.lastIndexOf('.');
    if (dot >= 0) {
      const bare = fields[name.slice(dot + 1)];
      if (bare !== undefined) return bare;
    }
    if (Array.isArray(record)) {
      const byIndex = record[index];
      if (byIndex !== undefined) return byIndex;
    }
  }
  throw new Error(`missing contract field ${name}`);
}

export function equalHash(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function equalAddress(left: Address, right: Address): boolean {
  return getAddress(left) === getAddress(right);
}
