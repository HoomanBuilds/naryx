import {
  buildExposureGraph,
  packageCloseCostIndex,
  stressPortfolio,
  toHex,
  type AssetRef,
  type NormalizedPositionInput,
} from "@naryx/protocol-types";
import type { StoredPositionSnapshot } from "./position-snapshot-store.js";

/** The fixed stress set every risk read reports; it is a model, labeled as one. */
const SHOCK_BPS = 1_000n;
const STRESSED_CLOSE_COST_BPS = 15_000n;
export const RISK_METHODOLOGY =
  "Positions are the latest signed read-only snapshot of each source. Exposure and close cost are exact over those positions in each accounting asset; the stress rows apply a uniform 10% move down and up to every underlying with close costs at 150% and no dependency failure. Nothing converts between accounting assets.";

function sourceView(entry: StoredPositionSnapshot, nowMs: number) {
  return {
    sourceId: entry.record.sourceId,
    recordHash: entry.recordHashHex,
    observedAtMs: entry.record.observedAtMs,
    ageMs: BigInt(nowMs) - entry.record.observedAtMs,
    positionCount: entry.record.positions.length,
    unmappedInstruments: entry.record.unmappedInstruments,
  };
}

/**
 * The positions of one account or risk domain, as every source last observed them, with each
 * signed record in full so a reader can re-hash it and check its authority signature.
 */
export function positionsView(strategyAccount: string, snapshots: readonly StoredPositionSnapshot[], nowMs: number) {
  return {
    strategyAccount,
    label: "OBSERVED" as const,
    sources: snapshots.map((entry) => sourceView(entry, nowMs)),
    records: snapshots.map((entry) => entry.record),
    positions: snapshots.flatMap((entry) => entry.record.positions.map((position) => ({ sourceId: entry.record.sourceId, position }))),
  };
}

function byAccountingAsset(positions: readonly NormalizedPositionInput[]): Map<string, { asset: AssetRef; positions: NormalizedPositionInput[] }> {
  const groups = new Map<string, { asset: AssetRef; positions: NormalizedPositionInput[] }>();
  for (const position of positions) {
    const asset = position.markPrice.quoteAsset;
    const key = `${asset.assetId}/${asset.decimals}/${toHex(asset.assetManifestHash)}`;
    const group = groups.get(key) ?? { asset, positions: [] };
    group.positions.push(position);
    groups.set(key, group);
  }
  return groups;
}

/** Exact exposure, close cost, and the modeled stress rows for a set of positions, per accounting asset. */
export function riskView(positions: readonly NormalizedPositionInput[]) {
  return [...byAccountingAsset(positions).values()].map(({ asset, positions: grouped }) => {
    const underlyings = [...new Set(grouped.map((position) => position.underlyingId))].sort();
    const scenario = (scenarioId: string, shockBps: bigint) => ({
      scenarioId,
      priceShocksBps: underlyings.map((underlyingId) => ({ underlyingId, shockBps })),
      closeCostMultiplierBps: STRESSED_CLOSE_COST_BPS,
      failedDependencyIds: [],
    });
    return {
      accountingAsset: asset,
      exposure: buildExposureGraph(grouped, asset),
      closeCost: packageCloseCostIndex(grouped),
      stress: {
        label: "MODELED" as const,
        results: [stressPortfolio(grouped, scenario("uniform-down-10pct", -SHOCK_BPS), asset), stressPortfolio(grouped, scenario("uniform-up-10pct", SHOCK_BPS), asset)],
      },
    };
  });
}
