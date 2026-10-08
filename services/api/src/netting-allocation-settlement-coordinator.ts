import {
  bytesEqual,
  toHex,
  type NettingAllocationExecutionAuthorization,
} from '@naryx/protocol-types';
import type {
  NettingAllocationExecutionObservation,
  PreparedNettingBatch,
} from './package-exchange-store.js';

export interface NettingAllocationSettlementStorePort {
  nettingBatch(proofHash: Uint8Array | string): PreparedNettingBatch | undefined;
  nettingAllocationExecutionAuthorizations(
    proofHash: Uint8Array | string,
  ): readonly NettingAllocationExecutionAuthorization[];
  recordNettingAllocationExecutionObservation(
    observation: NettingAllocationExecutionObservation,
  ): { readonly replayed: boolean };
}

export interface NettingAllocationObservationPort {
  readonly routeId: string;
  supports(authorization: NettingAllocationExecutionAuthorization): boolean;
  observe(input: Readonly<{
    authorization: NettingAllocationExecutionAuthorization;
    idempotencyKey: string;
  }>): Promise<NettingAllocationExecutionObservation | undefined>;
}

export interface NettingAllocationSettlementResult {
  readonly batch: PreparedNettingBatch;
  readonly observedAuthorizationHashes: readonly string[];
  readonly pendingAllocationReceiptHashes: readonly string[];
}

export class NettingAllocationObservationRouter {
  readonly #routes: readonly NettingAllocationObservationPort[];

  constructor(routes: readonly NettingAllocationObservationPort[]) {
    if (!Array.isArray(routes) || routes.length === 0
      || routes.some((route) => typeof route?.routeId !== 'string' || route.routeId.length === 0
        || typeof route.supports !== 'function' || typeof route.observe !== 'function')
      || new Set(routes.map((route) => route.routeId)).size !== routes.length) {
      throw new Error('netting settlement routes must be nonempty, unique, and complete');
    }
    this.#routes = Object.freeze([...routes]);
  }

  async observe(input: Readonly<{
    authorization: NettingAllocationExecutionAuthorization;
    idempotencyKey: string;
  }>): Promise<NettingAllocationExecutionObservation | undefined> {
    const matches = this.#routes.filter((route) => route.supports(input.authorization));
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? 'netting allocation has no registered settlement route'
        : 'netting allocation matches multiple settlement routes');
    }
    return matches[0]!.observe(input);
  }
}

export class NettingAllocationSettlementCoordinator {
  readonly #store: NettingAllocationSettlementStorePort;
  readonly #observer: NettingAllocationObservationRouter;

  constructor(store: NettingAllocationSettlementStorePort, observer: NettingAllocationObservationRouter) {
    if (store === null || typeof store !== 'object'
      || typeof store.nettingBatch !== 'function'
      || typeof store.nettingAllocationExecutionAuthorizations !== 'function'
      || typeof store.recordNettingAllocationExecutionObservation !== 'function') {
      throw new Error('netting settlement requires a durable authorization store');
    }
    this.#store = store;
    this.#observer = observer;
  }

  async settle(proofHash: Uint8Array | string): Promise<NettingAllocationSettlementResult> {
    let batch = this.#store.nettingBatch(proofHash);
    if (batch === undefined) throw new Error('prepared netting batch was not found');
    if (batch.finalAllocationReceipt === undefined) {
      throw new Error('netting batch has no final allocation receipt');
    }
    const authorizations = this.#store.nettingAllocationExecutionAuthorizations(proofHash);
    const authorizationByAllocation = new Map(
      authorizations.map((authorization) => [toHex(authorization.allocationReceiptHash), authorization]),
    );
    const observedAuthorizationHashes: string[] = [];
    for (const allocation of batch.finalAllocationReceipt.allocations) {
      if (batch.settlementEvidence.some((evidence) =>
        bytesEqual(evidence.allocationReceiptHash, allocation.allocationReceiptHash))) continue;
      const authorization = authorizationByAllocation.get(toHex(allocation.allocationReceiptHash));
      if (authorization === undefined) continue;
      const idempotencyKey = toHex(authorization.authorizationHash);
      const observation = await this.#observer.observe({ authorization, idempotencyKey });
      if (observation === undefined) continue;
      this.#store.recordNettingAllocationExecutionObservation(observation);
      observedAuthorizationHashes.push(idempotencyKey);
      batch = this.#store.nettingBatch(proofHash);
      if (batch === undefined) throw new Error('netting batch disappeared after settlement observation');
    }
    if (batch.finalAllocationReceipt === undefined) {
      throw new Error('final allocation receipt disappeared after settlement observation');
    }
    const settled = new Set(batch.settlementEvidence.map((evidence) => toHex(evidence.allocationReceiptHash)));
    const pendingAllocationReceiptHashes = batch.finalAllocationReceipt.allocations
      .map((allocation) => toHex(allocation.allocationReceiptHash))
      .filter((allocationHash) => !settled.has(allocationHash));
    return Object.freeze({
      batch,
      observedAuthorizationHashes: Object.freeze(observedAuthorizationHashes),
      pendingAllocationReceiptHashes: Object.freeze(pendingAllocationReceiptHashes),
    });
  }
}
