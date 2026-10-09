import {
  ProtocolError,
  crossBatchClearingPlan,
  crossBatchClearingPolicy,
  toHex,
  type CrossBatchClearingPolicyInput,
  type NettingExternalExecutionIntent,
} from '@naryx/protocol-types';
import type { PreparedCrossBatchClearing } from './package-exchange-store.js';

const MAX_DISCOVERY_CANDIDATES = 512;

export interface AuthoritativeCrossBatchClearingPort {
  pendingCrossBatchSourceIntents(
    policy: CrossBatchClearingPolicyInput,
    maximumCandidates?: number,
  ): readonly NettingExternalExecutionIntent[];
  recordPreparedCrossBatchClearing(input: Readonly<{
    policy: CrossBatchClearingPolicyInput;
    sourceIntentHashes: readonly string[];
  }>): { readonly clearing: PreparedCrossBatchClearing; readonly replayed: boolean };
}

export type PrepareNextAuthoritativeCrossBatchClearingResult =
  | Readonly<{ status: 'IDLE' }>
  | Readonly<{
      status: 'PREPARED';
      clearing: PreparedCrossBatchClearing;
      replayed: boolean;
    }>;

function routeKey(intent: NettingExternalExecutionIntent): string {
  return [
    intent.instrumentId,
    toHex(intent.instrumentHash),
    intent.domain.domainId,
    String(intent.domain.domainManifestVersion),
    toHex(intent.domain.domainManifestHash),
    intent.adapter.adapterId,
    String(intent.adapter.adapterManifestVersion),
    toHex(intent.adapter.adapterManifestHash),
    intent.venue.subjectId,
    String(intent.venue.manifestVersion),
    toHex(intent.venue.manifestHash),
    intent.market.subjectId,
    String(intent.market.manifestVersion),
    toHex(intent.market.manifestHash),
    intent.quantityAsset.assetId,
    toHex(intent.quantityAsset.assetManifestHash),
    String(intent.quantityAsset.decimals),
    intent.quoteAsset.assetId,
    toHex(intent.quoteAsset.assetManifestHash),
    String(intent.quoteAsset.decimals),
    intent.quantityIncrementAtoms.toString(),
    intent.priceTickQuoteAtoms.toString(),
  ].join(':');
}

function validSources(
  sources: readonly NettingExternalExecutionIntent[],
  policy: ReturnType<typeof crossBatchClearingPolicy>,
): boolean {
  try {
    crossBatchClearingPlan(sources, policy);
    return true;
  } catch (error) {
    if (error instanceof ProtocolError) return false;
    throw error;
  }
}

function selectSources(
  candidates: readonly NettingExternalExecutionIntent[],
  policy: ReturnType<typeof crossBatchClearingPolicy>,
): readonly NettingExternalExecutionIntent[] | undefined {
  const indexed = candidates.map((intent, index) => ({ intent, index }));
  const groups = new Map<string, typeof indexed>();
  for (const candidate of indexed) {
    const key = routeKey(candidate.intent);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  const viablePairs: {
    key: string;
    group: typeof indexed;
    left: (typeof indexed)[number];
    right: (typeof indexed)[number];
  }[] = [];
  for (const [key, group] of groups) {
    pairSearch: for (let rightIndex = 1; rightIndex < group.length; rightIndex += 1) {
      for (let leftIndex = 0; leftIndex < rightIndex; leftIndex += 1) {
        const left = group[leftIndex]!;
        const right = group[rightIndex]!;
        if (validSources([left.intent, right.intent], policy)) {
          viablePairs.push({ key, group, left, right });
          break pairSearch;
        }
      }
    }
  }
  viablePairs.sort((left, right) => {
    if (left.right.index !== right.right.index) return left.right.index - right.right.index;
    if (left.left.index !== right.left.index) return left.left.index - right.left.index;
    return left.key.localeCompare(right.key);
  });
  const selectedPair = viablePairs[0];
  if (selectedPair === undefined) return undefined;

  let selected = [selectedPair.left.intent, selectedPair.right.intent]
    .sort((left, right) => candidates.indexOf(left) - candidates.indexOf(right));
  const selectedHashes = new Set(selected.map((intent) => toHex(intent.intentHash)));
  for (const candidate of selectedPair.group) {
    if (selected.length === policy.maximumSourceIntents) break;
    const hash = toHex(candidate.intent.intentHash);
    if (selectedHashes.has(hash)) continue;
    const proposed = [...selected, candidate.intent];
    if (!validSources(proposed, policy)) continue;
    selected = proposed;
    selectedHashes.add(hash);
  }
  return Object.freeze(selected);
}

export function prepareNextAuthoritativeCrossBatchClearing(
  exchange: AuthoritativeCrossBatchClearingPort,
  policyInput: CrossBatchClearingPolicyInput,
): PrepareNextAuthoritativeCrossBatchClearingResult {
  const policy = crossBatchClearingPolicy(policyInput);
  const candidates = exchange.pendingCrossBatchSourceIntents(policy, MAX_DISCOVERY_CANDIDATES);
  const selected = selectSources(candidates, policy);
  if (selected === undefined) return Object.freeze({ status: 'IDLE' });
  const prepared = exchange.recordPreparedCrossBatchClearing({
    policy,
    sourceIntentHashes: selected.map((intent) => toHex(intent.intentHash)),
  });
  return Object.freeze({ status: 'PREPARED', ...prepared });
}
