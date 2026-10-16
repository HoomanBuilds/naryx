import type { StrategyPackageReceiptInput } from '@naryx/protocol-types';
import type {
  EvmStrategyExecutionObservationPort,
  ObservedEvmStrategyExecution,
} from './evm-strategy-execution-observation-client.js';
import type {
  EvmStrategyPositionEvidence,
  SqliteStrategyPackageStore,
  StoredEvmStrategyPosition,
} from './strategy-package-store.js';

interface FinalizationStore {
  recordReceipt(receipt: StrategyPackageReceiptInput): { readonly created: boolean; readonly receiptHashHex: string };
  recordEvmStrategyPosition(evidence: EvmStrategyPositionEvidence): StoredEvmStrategyPosition;
  completeEvmStrategyObservation?(quoteHashHex: string, transactionHash: string): void;
}

export function recordFinalizedEvmStrategy(
  store: FinalizationStore,
  quoteHashHex: string,
  observation: Extract<ObservedEvmStrategyExecution, { status: 'FINALIZED' }>,
) {
  const stored = store.recordReceipt(observation.receipt);
  const position = store.recordEvmStrategyPosition({
    receiptHashHex: stored.receiptHashHex,
    packageIdHex: observation.packageId,
    chainId: observation.chainId,
    account: observation.account,
    previousStateHashHex: observation.previousStateHash,
    nextStateHashHex: observation.nextStateHash,
  });
  store.completeEvmStrategyObservation?.(quoteHashHex, observation.transactionHash);
  return { ...stored, position };
}

export async function reconcilePendingEvmStrategies(
  store: FinalizationStore & Pick<SqliteStrategyPackageStore,
    'pendingEvmStrategyObservations' | 'touchEvmStrategyObservation'>,
  observer: EvmStrategyExecutionObservationPort,
  limit = 10,
): Promise<{ finalized: number; pending: number; failed: number }> {
  const result = { finalized: 0, pending: 0, failed: 0 };
  for (const item of store.pendingEvmStrategyObservations(limit)) {
    store.touchEvmStrategyObservation(item.quoteHashHex, item.transactionHash);
    try {
      const observation = await observer.observe(item.quoteHashHex, item.transactionHash);
      if (observation.status !== 'FINALIZED') {
        result.pending += 1;
        continue;
      }
      recordFinalizedEvmStrategy(store, item.quoteHashHex, observation);
      result.finalized += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
