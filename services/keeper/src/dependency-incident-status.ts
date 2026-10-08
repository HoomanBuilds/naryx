import type {
  DependencyIncidentFileStore,
  DependencyIncidentJournal,
  DependencyState,
} from './dependency-incident-engine.js';

export interface DependencyIncidentScopeStatus {
  readonly scopeId: string;
  readonly scopeHash: `0x${string}`;
  readonly domainId: string;
  readonly state: DependencyState;
  readonly entryAllowed: boolean;
  readonly exitAllowed: boolean;
  readonly revision: string;
  readonly evidenceCommitment: `0x${string}`;
  readonly evidenceObservedAtMs: string;
  readonly evidenceValidUntilMs: string;
  readonly evidenceFresh: boolean;
  readonly latestReceiptHash: `0x${string}` | null;
}

export interface DependencyIncidentStatusSnapshot {
  readonly version: 1;
  readonly observedAtMs: number;
  readonly configuredScopeCount: number;
  readonly unavailableScopeCount: number;
  readonly scopes: readonly DependencyIncidentScopeStatus[];
}

function scopeStatus(journal: DependencyIncidentJournal, nowMs: bigint): DependencyIncidentScopeStatus {
  return Object.freeze({
    scopeId: journal.scope.scopeId,
    scopeHash: journal.scopeHash,
    domainId: journal.scope.domain.domainId,
    state: journal.state,
    entryAllowed: journal.entryAllowed,
    exitAllowed: journal.exitAllowed,
    revision: journal.revision.toString(),
    evidenceCommitment: journal.latestEvidence.evidenceCommitment,
    evidenceObservedAtMs: journal.latestEvidence.observedAtMs.toString(),
    evidenceValidUntilMs: journal.latestEvidence.validUntilMs.toString(),
    evidenceFresh: nowMs >= journal.latestEvidence.observedAtMs && nowMs < journal.latestEvidence.validUntilMs,
    latestReceiptHash: journal.receipts.at(-1)?.receiptHash ?? null,
  });
}

export class DependencyIncidentStatusReader {
  readonly #stores: readonly Pick<DependencyIncidentFileStore, 'load'>[];
  readonly #nowMs: () => number;

  constructor(
    stores: readonly Pick<DependencyIncidentFileStore, 'load'>[],
    nowMs: () => number = Date.now,
  ) {
    this.#stores = Object.freeze([...stores]);
    this.#nowMs = nowMs;
  }

  async current(): Promise<DependencyIncidentStatusSnapshot> {
    const observedAtMs = this.#nowMs();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new Error('dependency incident status clock is invalid');
    }
    const scopes: DependencyIncidentScopeStatus[] = [];
    let unavailableScopeCount = 0;
    for (const store of this.#stores) {
      try {
        scopes.push(scopeStatus(await store.load(), BigInt(observedAtMs)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        unavailableScopeCount += 1;
      }
    }
    scopes.sort((left, right) => left.scopeHash.localeCompare(right.scopeHash));
    return Object.freeze({
      version: 1,
      observedAtMs,
      configuredScopeCount: this.#stores.length,
      unavailableScopeCount,
      scopes: Object.freeze(scopes),
    });
  }
}
