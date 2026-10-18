import type { EvmAtomicPackageReceipt, EvmFirmReservationCrossDomainPort } from './evm-firm-reservation-cross-domain-lane.js';
import type { Address, Hex } from 'viem';
import type { EvmRecoveryAdapterPolicy, EvmRecoveryAdapterState } from './evm-full-reversal-policy.js';

export interface EvmRecoveredPackageReceipt extends EvmAtomicPackageReceipt {
  readonly operation: number;
  readonly previousStateHash: Hex;
  readonly callsHash: Hex;
}

export type EvmCrossDomainSubmissionObservation = Readonly<
  | { status: 'ABSENT' | 'PENDING' }
  | { status: 'REVERTED'; transactionHash: Hex }
  | { status: 'SUCCESS'; transactionHash: Hex; to: Address; data: Hex; receipt: EvmRecoveredPackageReceipt; tokenDeltas: ReadonlyMap<Address, bigint> }
>;

export interface EvmRecoverableCrossDomainPort extends EvmFirmReservationCrossDomainPort {
  finalizedTime(): Promise<bigint>;
  observeSubmission(operationId: string, account: Address): Promise<EvmCrossDomainSubmissionObservation>;
  recoveryAdapterState(policy: EvmRecoveryAdapterPolicy): Promise<EvmRecoveryAdapterState>;
}
