import {
  toHex,
  verifyNettingExternalExecutionEvidence,
  type NettingExternalExecutionEvidence,
  type NettingExternalExecutionIntent,
} from '@naryx/protocol-types';
import type {
  PreparedNettingBatch,
} from './package-exchange-store.js';

export interface NettingExternalExecutionStorePort {
  nettingBatch(proofHash: Uint8Array | string): PreparedNettingBatch | undefined;
  recordVerifiedNettingExternalExecutionEvidence(
    evidence: NettingExternalExecutionEvidence,
  ): { readonly evidence: NettingExternalExecutionEvidence; readonly replayed: boolean };
}

export interface NettingExternalExecutionPort {
  execute(input: Readonly<{
    intent: NettingExternalExecutionIntent;
    idempotencyKey: string;
  }>): Promise<NettingExternalExecutionEvidence>;
}

export interface NettingExecutionCoordinatorResult {
  readonly batch: PreparedNettingBatch;
  readonly executedIntentHashes: readonly string[];
}

export class NettingExecutionCoordinator {
  readonly #store: NettingExternalExecutionStorePort;
  readonly #executor: NettingExternalExecutionPort;

  constructor(store: NettingExternalExecutionStorePort, executor: NettingExternalExecutionPort) {
    if (store === null || typeof store !== 'object'
      || typeof store.nettingBatch !== 'function'
      || typeof store.recordVerifiedNettingExternalExecutionEvidence !== 'function') {
      throw new Error('netting execution requires a durable batch store');
    }
    if (executor === null || typeof executor !== 'object' || typeof executor.execute !== 'function') {
      throw new Error('netting execution requires a domain execution port');
    }
    this.#store = store;
    this.#executor = executor;
  }

  async execute(proofHash: Uint8Array | string): Promise<NettingExecutionCoordinatorResult> {
    let batch = this.#store.nettingBatch(proofHash);
    if (batch === undefined) throw new Error('prepared netting batch was not found');
    const executedIntentHashes: string[] = [];
    if (batch.externalExecutionStatus === 'RECOVERY_REQUIRED') {
      return Object.freeze({ batch, executedIntentHashes: Object.freeze(executedIntentHashes) });
    }
    for (const record of batch.externalExecutions) {
      if (record.evidence !== undefined) continue;
      const idempotencyKey = toHex(record.intent.intentHash);
      const evidence = await this.#executor.execute({ intent: record.intent, idempotencyKey });
      verifyNettingExternalExecutionEvidence(evidence, record.intent);
      this.#store.recordVerifiedNettingExternalExecutionEvidence(evidence);
      executedIntentHashes.push(idempotencyKey);
      batch = this.#store.nettingBatch(proofHash);
      if (batch === undefined) throw new Error('prepared netting batch disappeared after execution');
      if (batch.externalExecutionStatus === 'RECOVERY_REQUIRED') break;
    }
    return Object.freeze({
      batch,
      executedIntentHashes: Object.freeze(executedIntentHashes),
    });
  }
}
