import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import {
  observeEvmNettingAllocation,
  type EvmFinalityPolicy,
  type EvmReadPort,
} from '@naryx/adapter-evm';
import {
  observeSolanaNettingAllocation as observeSolanaAllocation,
  type SolanaNettingAllocationObservation,
  type SolanaObservedNettingInstruction,
} from '@naryx/adapter-solana';
import {
  bytesEqual,
  toHex,
  type DomainRef,
  type NettingAllocationExecutionAuthorization,
} from '@naryx/protocol-types';
import type {
  NettingAllocationExecutionAttempt,
  SqliteNettingAllocationAttemptStore,
} from './netting-allocation-attempt-store.js';
import type {
  NettingAllocationExecutionObservation,
} from './package-exchange-store.js';
import type { NettingAllocationObservationPort } from './netting-allocation-settlement-coordinator.js';

export interface NettingAllocationAttemptReadPort {
  attemptsForAuthorization(
    authorization: NettingAllocationExecutionAuthorization,
  ): readonly NettingAllocationExecutionAttempt[];
}

export interface SolanaFinalizedNettingTransaction {
  readonly slot: bigint;
  readonly successful: boolean;
  readonly instructions: readonly SolanaObservedNettingInstruction[];
}

export interface SolanaNettingAllocationReadPort {
  genesisHash(): Promise<string>;
  finalizedTransaction(signature: string): Promise<SolanaFinalizedNettingTransaction | null>;
  finalizedAccount(address: string): Promise<Readonly<{
    address: string;
    owner: string;
    data: Uint8Array;
  }> | null>;
}

type ObserveEvm = typeof observeEvmNettingAllocation;
type ObserveSolana = typeof observeSolanaAllocation;

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function requireRouteId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{3,96}$/.test(value)) {
    throw new Error('netting allocation route ID is invalid');
  }
  return value;
}

function requireIdempotencyKey(
  authorization: NettingAllocationExecutionAuthorization,
  idempotencyKey: string,
): void {
  if (idempotencyKey !== toHex(authorization.authorizationHash)) {
    throw new Error('netting allocation idempotency key differs from the authorization hash');
  }
}

function attemptsForRuntime(
  store: NettingAllocationAttemptReadPort,
  authorization: NettingAllocationExecutionAuthorization,
  runtimeClass: 'EVM' | 'SVM',
): readonly NettingAllocationExecutionAttempt[] {
  const attempts = store.attemptsForAuthorization(authorization);
  if (attempts.some((attempt) => attempt.observation.runtimeClass !== runtimeClass)) {
    throw new Error('netting allocation attempt runtime differs from its settlement route');
  }
  return attempts.filter((attempt) => attempt.executionReference !== undefined);
}

function oneObservation(
  values: readonly NettingAllocationExecutionObservation[],
): NettingAllocationExecutionObservation | undefined {
  if (values.length > 1) {
    throw new Error('multiple finalized executions exist for one netting allocation authorization');
  }
  return values[0];
}

export class EvmNettingAllocationObservationRoute implements NettingAllocationObservationPort {
  readonly routeId: string;
  readonly #domain: DomainRef;
  readonly #attempts: NettingAllocationAttemptReadPort;
  readonly #reads: EvmReadPort;
  readonly #finality: EvmFinalityPolicy;
  readonly #blockTimestamp: (blockNumber: bigint) => Promise<bigint>;
  readonly #observe: ObserveEvm;

  constructor(options: Readonly<{
    routeId: string;
    domain: DomainRef;
    attempts: NettingAllocationAttemptReadPort;
    reads: EvmReadPort;
    finality: EvmFinalityPolicy;
    blockTimestamp(blockNumber: bigint): Promise<bigint>;
    observe?: ObserveEvm;
  }>) {
    this.routeId = requireRouteId(options.routeId);
    this.#domain = options.domain;
    this.#attempts = options.attempts;
    this.#reads = options.reads;
    this.#finality = options.finality;
    this.#blockTimestamp = options.blockTimestamp;
    this.#observe = options.observe ?? observeEvmNettingAllocation;
  }

  supports(authorization: NettingAllocationExecutionAuthorization): boolean {
    return sameDomain(authorization.domain, this.#domain);
  }

  async observe(input: Readonly<{
    authorization: NettingAllocationExecutionAuthorization;
    idempotencyKey: string;
  }>): Promise<NettingAllocationExecutionObservation | undefined> {
    if (!this.supports(input.authorization)) throw new Error('EVM netting route does not support the authorization domain');
    requireIdempotencyKey(input.authorization, input.idempotencyKey);
    const completed: NettingAllocationExecutionObservation[] = [];
    for (const attempt of attemptsForRuntime(this.#attempts, input.authorization, 'EVM')) {
      const binding = attempt.observation.runtimeClass === 'EVM' ? attempt.observation.binding : undefined;
      if (binding === undefined || attempt.executionReference === undefined) continue;
      const observed = await this.#observe(this.#reads, {
        binding,
        transactionHash: attempt.executionReference as `0x${string}`,
        finality: this.#finality,
      });
      if (observed.lifecycle === 'EVIDENCE_MISMATCH') {
        throw new Error(`EVM netting allocation evidence mismatch: ${observed.reason ?? 'unknown mismatch'}`);
      }
      if ((observed.lifecycle !== 'CONFIRMED' && observed.lifecycle !== 'FINALIZED')
        || observed.blockNumber === null || observed.receipt === null) continue;
      const observedAtValue = await this.#blockTimestamp(observed.blockNumber);
      if (observedAtValue <= 0n) throw new Error('EVM netting allocation block timestamp is invalid');
      completed.push(Object.freeze({
        authorizationHash: input.authorization.authorizationHash,
        observedAtUnit: 'EVM_UNIX_SECONDS',
        observedAtValue,
        settlementReferenceHash: observed.transactionHash,
        authoritativeEvidenceHash: observed.receipt.receiptHash,
      }));
    }
    return oneObservation(completed);
  }
}

function solanaReferenceHash(signature: string): Uint8Array {
  return createHash('sha256')
    .update('naryx.solana.transaction-signature.v1', 'ascii')
    .update(bs58.decode(signature))
    .digest();
}

export class SolanaNettingAllocationObservationRoute implements NettingAllocationObservationPort {
  readonly routeId: string;
  readonly #domain: DomainRef;
  readonly #expectedGenesisHash: string;
  readonly #attempts: NettingAllocationAttemptReadPort;
  readonly #reads: SolanaNettingAllocationReadPort;
  readonly #observe: ObserveSolana;

  constructor(options: Readonly<{
    routeId: string;
    domain: DomainRef;
    expectedGenesisHash: string;
    attempts: NettingAllocationAttemptReadPort;
    reads: SolanaNettingAllocationReadPort;
    observe?: ObserveSolana;
  }>) {
    this.routeId = requireRouteId(options.routeId);
    if (typeof options.expectedGenesisHash !== 'string' || options.expectedGenesisHash.length < 32) {
      throw new Error('expected Solana genesis hash is invalid');
    }
    this.#domain = options.domain;
    this.#expectedGenesisHash = options.expectedGenesisHash;
    this.#attempts = options.attempts;
    this.#reads = options.reads;
    this.#observe = options.observe ?? observeSolanaAllocation;
  }

  supports(authorization: NettingAllocationExecutionAuthorization): boolean {
    return sameDomain(authorization.domain, this.#domain);
  }

  async observe(input: Readonly<{
    authorization: NettingAllocationExecutionAuthorization;
    idempotencyKey: string;
  }>): Promise<NettingAllocationExecutionObservation | undefined> {
    if (!this.supports(input.authorization)) throw new Error('Solana netting route does not support the authorization domain');
    requireIdempotencyKey(input.authorization, input.idempotencyKey);
    if (await this.#reads.genesisHash() !== this.#expectedGenesisHash) {
      throw new Error('Solana netting observation RPC genesis hash differs from the configured domain');
    }
    const completed: NettingAllocationExecutionObservation[] = [];
    for (const attempt of attemptsForRuntime(this.#attempts, input.authorization, 'SVM')) {
      const binding = attempt.observation.runtimeClass === 'SVM' ? attempt.observation.binding : undefined;
      if (binding === undefined || attempt.executionReference === undefined) continue;
      const transaction = await this.#reads.finalizedTransaction(attempt.executionReference);
      if (transaction === null || !transaction.successful) continue;
      const receiptAccount = await this.#reads.finalizedAccount(binding.receiptAccount);
      if (receiptAccount === null) {
        throw new Error('finalized Solana netting transaction has no receipt account');
      }
      const observed: SolanaNettingAllocationObservation = this.#observe({
        binding,
        slot: transaction.slot,
        instructions: transaction.instructions,
        receiptAccount,
      });
      completed.push(Object.freeze({
        authorizationHash: input.authorization.authorizationHash,
        observedAtUnit: observed.observedAtUnit,
        observedAtValue: observed.observedAtValue,
        settlementReferenceHash: solanaReferenceHash(attempt.executionReference),
        authoritativeEvidenceHash: observed.receiptHash,
      }));
    }
    return oneObservation(completed);
  }
}

export type NettingAllocationAttemptStore = Pick<
  SqliteNettingAllocationAttemptStore,
  'attemptsForAuthorization'
>;
