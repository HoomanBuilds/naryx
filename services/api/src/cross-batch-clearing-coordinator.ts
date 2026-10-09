import {
  toHex,
  verifyCrossBatchExternalExecutionEvidence,
  type CrossBatchExternalExecutionEvidence,
  type CrossBatchExternalExecutionIntent,
} from '@naryx/protocol-types';
import type { PreparedCrossBatchClearing } from './package-exchange-store.js';

export interface CrossBatchClearingStorePort {
  crossBatchClearing(planHash: Uint8Array | string): PreparedCrossBatchClearing | undefined;
  recordVerifiedCrossBatchExternalExecutionEvidence(
    evidence: CrossBatchExternalExecutionEvidence,
  ): { readonly evidence: CrossBatchExternalExecutionEvidence; readonly replayed: boolean };
}

export interface CrossBatchExternalExecutionPort {
  execute(input: Readonly<{
    intent: CrossBatchExternalExecutionIntent;
    idempotencyKey: string;
  }>): Promise<CrossBatchExternalExecutionEvidence>;
}

export interface RoutedCrossBatchExternalExecutionPort extends CrossBatchExternalExecutionPort {
  readonly routeId: string;
  supports(intent: CrossBatchExternalExecutionIntent): boolean;
}

export class CrossBatchExternalExecutionRouter implements CrossBatchExternalExecutionPort {
  readonly #routes: readonly RoutedCrossBatchExternalExecutionPort[];

  constructor(routes: readonly RoutedCrossBatchExternalExecutionPort[]) {
    if (!Array.isArray(routes) || routes.length === 0
      || routes.some((route) => typeof route?.routeId !== 'string' || route.routeId.length === 0
        || typeof route.supports !== 'function' || typeof route.execute !== 'function')
      || new Set(routes.map((route) => route.routeId)).size !== routes.length) {
      throw new Error('cross-batch execution routes must be nonempty, unique, and complete');
    }
    this.#routes = Object.freeze([...routes]);
  }

  async execute(input: Readonly<{
    intent: CrossBatchExternalExecutionIntent;
    idempotencyKey: string;
  }>): Promise<CrossBatchExternalExecutionEvidence> {
    const matches = this.#routes.filter((route) => route.supports(input.intent));
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? 'cross-batch residual has no registered execution route'
        : 'cross-batch residual matches multiple execution routes');
    }
    return matches[0]!.execute(input);
  }
}

export interface CrossBatchClearingCoordinatorResult {
  readonly clearing: PreparedCrossBatchClearing;
  readonly executedIntentHash?: string;
}

export class CrossBatchClearingCoordinator {
  readonly #store: CrossBatchClearingStorePort;
  readonly #executor: CrossBatchExternalExecutionPort;

  constructor(store: CrossBatchClearingStorePort, executor: CrossBatchExternalExecutionPort) {
    if (store === null || typeof store !== 'object'
      || typeof store.crossBatchClearing !== 'function'
      || typeof store.recordVerifiedCrossBatchExternalExecutionEvidence !== 'function') {
      throw new Error('cross-batch clearing requires a durable clearing store');
    }
    if (executor === null || typeof executor !== 'object' || typeof executor.execute !== 'function') {
      throw new Error('cross-batch clearing requires a domain execution port');
    }
    this.#store = store;
    this.#executor = executor;
  }

  async execute(planHash: Uint8Array | string): Promise<CrossBatchClearingCoordinatorResult> {
    let clearing = this.#store.crossBatchClearing(planHash);
    if (clearing === undefined) throw new Error('cross-batch clearing plan was not found');
    if (clearing.status !== 'PENDING') return Object.freeze({ clearing });
    if (clearing.intent === undefined) throw new Error('pending cross-batch clearing lacks an external intent');

    const executedIntentHash = toHex(clearing.intent.intentHash);
    const evidence = await this.#executor.execute({
      intent: clearing.intent,
      idempotencyKey: executedIntentHash,
    });
    verifyCrossBatchExternalExecutionEvidence(evidence, clearing.intent);
    this.#store.recordVerifiedCrossBatchExternalExecutionEvidence(evidence);
    clearing = this.#store.crossBatchClearing(planHash);
    if (clearing === undefined) throw new Error('cross-batch clearing disappeared after execution');
    return Object.freeze({ clearing, executedIntentHash });
  }
}
