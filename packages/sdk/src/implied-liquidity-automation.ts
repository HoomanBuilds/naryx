import type {
  ExactSignedRatio,
  ImpliedPackageQuoteInput,
  ImplicationEvidence,
  PackageBookSide,
} from '@naryx/protocol-types';
import { NaryxEvidenceError } from './client.js';
import type { NaryxSolverClient } from './solver-client.js';

const HASH_HEX = /^[0-9a-f]{64}$/;

export interface ImpliedLegLevel {
  readonly priceTicks: bigint;
  readonly quantity: bigint;
  readonly reservationId?: string;
}

export interface ImpliedLegBookSnapshot {
  readonly sourceId: string;
  readonly sourceVersion: bigint;
  readonly observedAtValue: bigint;
  readonly bid: ImpliedLegLevel;
  readonly ask: ImpliedLegLevel;
}

export interface ImpliedLiquidityAutomationPolicy {
  readonly packageMarketId: string;
  readonly executionClassId: string;
  readonly legRatios: readonly ExactSignedRatio[];
  readonly evidence: Exclude<ImplicationEvidence, 'INDICATIVE_IMPLIED'>;
  readonly quoteLifetime: bigint;
  readonly refreshLead: bigint;
  readonly maxSourceAge: bigint;
  readonly solverCommitments?: Readonly<{ BID: string; ASK: string }>;
}

export type ImpliedLiquidityAutomationAction =
  | Readonly<{ kind: 'NO_CHANGE' }>
  | Readonly<{ kind: 'INVALIDATED'; sourceId: string; sourceVersion: bigint; entryIds: readonly string[] }>
  | Readonly<{ kind: 'CANCELLED'; entryId: string }>
  | Readonly<{ kind: 'PUBLISHED'; side: PackageBookSide; entryId: string; priceTicks: bigint; quantity: bigint; expiresAtValue: bigint }>;

export interface ImpliedLiquidityAutomation {
  tick(): Promise<readonly ImpliedLiquidityAutomationAction[]>;
}

type Client = Pick<NaryxSolverClient, 'observeSourceVersion' | 'postQuotes' | 'cancelQuote'>;

function level(snapshot: ImpliedLegBookSnapshot, ratio: ExactSignedRatio, side: PackageBookSide): ImpliedLegLevel & { side: PackageBookSide } {
  const required = ratio.numerator > 0n ? side : side === 'BID' ? 'ASK' : 'BID';
  const selected = required === 'BID' ? snapshot.bid : snapshot.ask;
  return { ...selected, side: required };
}

function fingerprint(snapshot: ImpliedLegBookSnapshot): string {
  return [
    snapshot.sourceVersion,
    snapshot.observedAtValue,
    snapshot.bid.priceTicks,
    snapshot.bid.quantity,
    snapshot.bid.reservationId ?? '',
    snapshot.ask.priceTicks,
    snapshot.ask.quantity,
    snapshot.ask.reservationId ?? '',
  ].join(':');
}

function responseEntries(value: unknown): readonly Readonly<{ entryId: string; priceTicks: bigint; quantity: bigint }>[] {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { entries?: unknown }).entries)) {
    throw new NaryxEvidenceError('implied quote publication returned no entries');
  }
  return Object.freeze((value as { entries: unknown[] }).entries.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new NaryxEvidenceError(`implied entry ${index} is malformed`);
    const record = entry as Record<string, unknown>;
    if (typeof record.entryId !== 'string' || !HASH_HEX.test(record.entryId)
      || typeof record.priceTicks !== 'bigint' || typeof record.quantity !== 'bigint' || record.quantity <= 0n) {
      throw new NaryxEvidenceError(`implied entry ${index} is malformed`);
    }
    return Object.freeze({ entryId: record.entryId, priceTicks: record.priceTicks, quantity: record.quantity });
  }));
}

export function createImpliedLiquidityAutomation(options: Readonly<{
  client: Client;
  policy: ImpliedLiquidityAutomationPolicy;
  readLegBooks: () => Promise<readonly ImpliedLegBookSnapshot[]>;
  now: () => bigint;
}>): ImpliedLiquidityAutomation {
  const { policy } = options;
  if (!Array.isArray(policy.legRatios) || policy.legRatios.length === 0
    || policy.quoteLifetime <= 0n || policy.refreshLead < 0n
    || policy.refreshLead >= policy.quoteLifetime || policy.maxSourceAge <= 0n) {
    throw new TypeError('implied liquidity policy has invalid legs or timing');
  }
  if (policy.evidence === 'SOLVER_BACKED_IMPLIED'
    && (policy.solverCommitments === undefined
      || !HASH_HEX.test(policy.solverCommitments.BID)
      || !HASH_HEX.test(policy.solverCommitments.ASK)
      || policy.solverCommitments.BID === policy.solverCommitments.ASK)) {
    throw new TypeError('solver-backed bid and ask need distinct commitment ids');
  }

  const versions = new Map<string, bigint>();
  const fingerprints = new Map<string, string>();
  let live: Readonly<{ entries: readonly string[]; expiresAtValue: bigint }> | undefined;

  return {
    async tick() {
      const now = options.now();
      const snapshots = await options.readLegBooks();
      if (snapshots.length !== policy.legRatios.length) throw new NaryxEvidenceError('every package leg needs one source book');
      const sourceIds = new Set<string>();
      let changed = false;
      for (const snapshot of snapshots) {
        if (sourceIds.has(snapshot.sourceId)) throw new NaryxEvidenceError('one source cannot back two package legs');
        sourceIds.add(snapshot.sourceId);
        if (snapshot.sourceVersion < 0n || snapshot.observedAtValue > now || now - snapshot.observedAtValue > policy.maxSourceAge) {
          throw new NaryxEvidenceError(`source ${snapshot.sourceId} is stale or malformed`);
        }
        const previousVersion = versions.get(snapshot.sourceId);
        if (previousVersion !== undefined && snapshot.sourceVersion < previousVersion) {
          throw new NaryxEvidenceError(`source ${snapshot.sourceId} moved backwards`);
        }
        const nextFingerprint = fingerprint(snapshot);
        const previousFingerprint = fingerprints.get(snapshot.sourceId);
        if (previousVersion === snapshot.sourceVersion && previousFingerprint !== undefined && previousFingerprint !== nextFingerprint) {
          throw new NaryxEvidenceError(`source ${snapshot.sourceId} changed without a new version`);
        }
        if (previousVersion !== snapshot.sourceVersion) changed = true;
      }

      const refresh = live !== undefined && live.expiresAtValue <= now + policy.refreshLead;
      if (!changed && !refresh && live !== undefined) return Object.freeze([{ kind: 'NO_CHANGE' as const }]);
      const actions: ImpliedLiquidityAutomationAction[] = [];
      for (const snapshot of snapshots) {
        if (versions.get(snapshot.sourceId) === snapshot.sourceVersion) continue;
        const response = await options.client.observeSourceVersion(snapshot.sourceId, snapshot.sourceVersion) as { invalidatedEntryIds?: unknown };
        if (!Array.isArray(response.invalidatedEntryIds)
          || response.invalidatedEntryIds.some((entry) => typeof entry !== 'string' || !HASH_HEX.test(entry))) {
          throw new NaryxEvidenceError('source invalidation response is malformed');
        }
        actions.push({
          kind: 'INVALIDATED',
          sourceId: snapshot.sourceId,
          sourceVersion: snapshot.sourceVersion,
          entryIds: Object.freeze([...(response.invalidatedEntryIds as string[])]),
        });
        versions.set(snapshot.sourceId, snapshot.sourceVersion);
        fingerprints.set(snapshot.sourceId, fingerprint(snapshot));
      }
      if (refresh && live !== undefined) {
        for (const entryId of live.entries) {
          await options.client.cancelQuote(policy.packageMarketId, entryId);
          actions.push({ kind: 'CANCELLED', entryId });
        }
        live = undefined;
      }

      const expiresAtValue = now + policy.quoteLifetime;
      const quote = (side: PackageBookSide): ImpliedPackageQuoteInput => ({
        executionClassId: policy.executionClassId,
        side,
        evidence: policy.evidence,
        legRatios: policy.legRatios,
        legSources: snapshots.map((snapshot, index) => {
          const selected = level(snapshot, policy.legRatios[index] as ExactSignedRatio, side);
          if (policy.evidence === 'RESERVATION_BACKED_IMPLIED' && selected.reservationId === undefined) {
            throw new NaryxEvidenceError(`source ${snapshot.sourceId} has no ${selected.side} reservation`);
          }
          return {
            sourceId: snapshot.sourceId,
            sourceVersion: snapshot.sourceVersion,
            side: selected.side,
            priceTicks: selected.priceTicks,
            quantity: selected.quantity,
            ...(selected.reservationId === undefined ? {} : { reservationId: selected.reservationId }),
          };
        }),
        ...(policy.evidence === 'SOLVER_BACKED_IMPLIED'
          ? { solverCommitment: policy.solverCommitments?.[side] as string }
          : {}),
      });
      const entries = responseEntries(await options.client.postQuotes(policy.packageMarketId, [
        { quote: quote('BID'), expiresAtValue },
        { quote: quote('ASK'), expiresAtValue },
      ]));
      if (entries.length !== 2) throw new NaryxEvidenceError('implied quote publication did not return both sides');
      live = Object.freeze({ entries: Object.freeze(entries.map((entry) => entry.entryId)), expiresAtValue });
      actions.push(
        { kind: 'PUBLISHED', side: 'BID', ...entries[0] as { entryId: string; priceTicks: bigint; quantity: bigint }, expiresAtValue },
        { kind: 'PUBLISHED', side: 'ASK', ...entries[1] as { entryId: string; priceTicks: bigint; quantity: bigint }, expiresAtValue },
      );
      return Object.freeze(actions);
    },
  };
}
