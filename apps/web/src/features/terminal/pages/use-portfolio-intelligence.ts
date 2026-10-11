"use client";

import { useQuery } from "@tanstack/react-query";
import {
  NaryxApiError,
  NaryxClient,
  type AssetRef,
  type NormalizedPosition,
  type StrategyState,
  type VerifiedRisk,
} from "@naryx/sdk";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type SignedCollateral = Readonly<{
  sourceId: string;
  assetId: string;
  decimals: number;
  riskDomainId: string;
  mode: string;
  availableAtoms: bigint;
  haircutBps: bigint;
  ageMs: bigint;
  inventoryEligible: boolean;
  withdrawalAllowed: boolean;
}>;

type SignedRisk = Readonly<{
  assetId: string;
  decimals: number;
  netNotionalAtoms: bigint;
  grossNotionalAtoms: bigint;
  closeCostAtoms: bigint;
  timeToUnwindMs: bigint;
  fullyClosable: boolean;
  downShockLossAtoms: bigint;
  upShockLossAtoms: bigint;
}>;

export type PortfolioScenarioGroup = Readonly<{
  accountingAsset: AssetRef;
  positions: readonly NormalizedPosition[];
  underlyingIds: readonly string[];
  dependencyIds: readonly string[];
}>;

/** "none" is a 404 (nothing published); "unavailable" is any other failure, including a store that is off. */
export type ObservationStatus = "observed" | "none" | "unavailable";

export type PortfolioIntelligenceRow = Readonly<{
  strategyId: string;
  environment: string;
  state: StrategyState;
  stateHash: string;
  positionSources: number;
  positionCount: number;
  positionAgeMs: bigint | null;
  risk: readonly SignedRisk[];
  scenarioGroups: readonly PortfolioScenarioGroup[];
  positions: readonly NormalizedPosition[];
  collateral: readonly SignedCollateral[];
  riskStatus: ObservationStatus;
  collateralStatus: ObservationStatus;
  riskDomainIds: readonly string[];
}>;

export type PortfolioIntelligenceState = Readonly<{
  rows: readonly PortfolioIntelligenceRow[];
  loading: boolean;
  unavailable: boolean;
  /** Owners or strategies whose own read failed; the rest still load. */
  unreadableOwners: number;
  unreadableStrategies: number;
  configured: boolean;
  refresh(): Promise<void>;
}>;

function decode(value: Json): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    if (value.$naryxType === "bigint" && typeof value.value === "string") return BigInt(value.value);
    if (value.$naryxType === "bytes" && typeof value.value === "string") return value.value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]));
  }
  return value;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${context} is malformed.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${context} is malformed.`);
  return value;
}

function integer(value: unknown, context: string): bigint {
  if (typeof value !== "bigint") throw new Error(`${context} is not exact.`);
  return value;
}

class ReadError extends Error {
  readonly status: number;

  constructor(status: number, path: string) {
    super(`${path} answered ${status}.`);
    this.status = status;
  }
}

async function read(base: string, path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new ReadError(response.status, path);
  return record(decode(await response.json() as Json), path);
}

function largest(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  return values.reduce((current, value) => value > current ? value : current);
}

function parseCollateral(value: Record<string, unknown>): readonly SignedCollateral[] {
  if (!Array.isArray(value.sources)) throw new Error("Collateral sources are malformed.");
  return Object.freeze(value.sources.map((raw, index) => {
    const source = record(raw, `Collateral source ${index}`);
    const snapshot = record(source.record, `Collateral source ${index} record`);
    const asset = record(snapshot.asset, `Collateral source ${index} asset`);
    if (typeof asset.decimals !== "number" || !Number.isSafeInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255) {
      throw new Error(`Collateral source ${index} decimals are malformed.`);
    }
    if (typeof snapshot.inventoryEligible !== "boolean" || typeof snapshot.withdrawalAllowed !== "boolean") {
      throw new Error(`Collateral source ${index} flags are malformed.`);
    }
    return Object.freeze({
      sourceId: string(snapshot.sourceId, `Collateral source ${index} source id`),
      assetId: string(asset.assetId, `Collateral source ${index} asset id`),
      decimals: asset.decimals,
      riskDomainId: string(snapshot.riskDomainId, `Collateral source ${index} risk domain`),
      mode: string(snapshot.mode, `Collateral source ${index} mode`),
      availableAtoms: integer(snapshot.ownAvailableQuoteAtoms, `Collateral source ${index} available amount`),
      haircutBps: integer(snapshot.haircutBps, `Collateral source ${index} haircut`),
      ageMs: integer(source.ageMs, `Collateral source ${index} age`),
      inventoryEligible: snapshot.inventoryEligible,
      withdrawalAllowed: snapshot.withdrawalAllowed,
    });
  }));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

type RiskSummary = Pick<PortfolioIntelligenceRow, "positionSources" | "positionCount" | "positionAgeMs" | "risk" | "scenarioGroups" | "positions">;
const NO_RISK: RiskSummary = Object.freeze({ positionSources: 0, positionCount: 0, positionAgeMs: null, risk: [], scenarioGroups: [], positions: [] });

function summarizeRisk(value: VerifiedRisk): RiskSummary {
  return Object.freeze({
    positions: value.positions.positions,
    positionSources: value.positions.sources.length,
    positionCount: value.positions.positions.length,
    positionAgeMs: largest(value.positions.sources.map((source) => source.ageMs)),
    risk: Object.freeze(value.byAccountingAsset.map((group) => {
      const down = group.stress.results.find((result) => result.scenarioId === "uniform-down-10pct");
      const up = group.stress.results.find((result) => result.scenarioId === "uniform-up-10pct");
      if (down === undefined || up === undefined) throw new Error("The verified risk view is missing its fixed stress scenarios.");
      return Object.freeze({
        assetId: group.accountingAsset.assetId,
        decimals: group.accountingAsset.decimals,
        netNotionalAtoms: group.exposure.byUnderlying.reduce((sum, line) => sum + line.netNotional, BigInt(0)),
        grossNotionalAtoms: group.exposure.byUnderlying.reduce((sum, line) => sum + line.grossNotional, BigInt(0)),
        closeCostAtoms: group.closeCost.costQuoteAtoms,
        timeToUnwindMs: group.closeCost.timeToUnwindMs,
        fullyClosable: group.closeCost.complete,
        downShockLossAtoms: down.lossQuoteAtoms,
        upShockLossAtoms: up.lossQuoteAtoms,
      });
    })),
    scenarioGroups: Object.freeze(value.byAccountingAsset.map((group) => {
      const positions = value.positions.positions.filter((position) => {
        const asset = position.markPrice.quoteAsset;
        return asset.assetId === group.accountingAsset.assetId && asset.decimals === group.accountingAsset.decimals
          && sameBytes(asset.assetManifestHash, group.accountingAsset.assetManifestHash);
      });
      return Object.freeze({
        accountingAsset: group.accountingAsset,
        positions: Object.freeze(positions),
        underlyingIds: Object.freeze([...new Set(positions.map((position) => position.underlyingId))].sort()),
        dependencyIds: Object.freeze([...new Set(positions.flatMap((position) => [
          ...position.dependencyIds,
          ...position.closeRoutes.flatMap((route) => route.requiredDependencyIds),
        ]))].sort()),
      });
    })),
  });
}

/** Reads one optional column; any failure but an abort marks only that column. */
async function optional<T>(signal: AbortSignal, load: () => Promise<T>): Promise<Readonly<{ status: ObservationStatus; value: T | null }>> {
  try {
    return { status: "observed", value: await load() };
  } catch (error) {
    if (signal.aborted) throw error;
    const status = error instanceof NaryxApiError || error instanceof ReadError ? error.status : 0;
    return { status: status === 404 ? "none" : "unavailable", value: null };
  }
}

export function usePortfolioIntelligence(baseUrl: string | null, owners: readonly (string | null)[]): PortfolioIntelligenceState {
  const activeOwners = [...new Set(owners.filter((owner): owner is string => owner !== null).map((owner) => owner.trim()).map((owner) => (owner.startsWith("0x") ? owner.toLowerCase() : owner)).filter(Boolean))].sort();
  const query = useQuery({
    queryKey: ["portfolio-intelligence", baseUrl, activeOwners],
    enabled: baseUrl !== null && activeOwners.length > 0,
    refetchInterval: 15_000,
    queryFn: async ({ signal }) => {
      const base = baseUrl!.replace(/\/+$/, "");
      const client = new NaryxClient({ baseUrl: base });
      const ownerViews = await Promise.all(activeOwners.map((owner) => optional(signal, () => read(base, `/v1/owners/${encodeURIComponent(owner)}/strategies`, signal))));
      const unreadableOwners = ownerViews.filter((view) => view.status === "unavailable").length;
      if (unreadableOwners === ownerViews.length) throw new Error("No owner strategy view could be read.");
      const ids = new Set<string>();
      let environment: string | null = null;
      for (const { value: view } of ownerViews) {
        if (view === null) continue;
        if (!Array.isArray(view.strategies)) throw new Error("Owner strategies are malformed.");
        const ownerEnvironment = string(view.environment, "Strategy environment");
        if (environment !== null && environment !== ownerEnvironment) throw new Error("Owner strategy views disagree on environment.");
        environment = ownerEnvironment;
        for (const raw of view.strategies) {
          const strategy = record(raw, "Owner strategy");
          if (strategy.open === true && strategy.retired === false) ids.add(string(strategy.strategyId, "Strategy id"));
        }
      }
      const rows = await Promise.all([...ids].sort().map(async (strategyId): Promise<PortfolioIntelligenceRow | null> => {
        const [strategy, risk, collateral] = await Promise.all([
          optional(signal, () => client.getStrategy(strategyId)),
          optional(signal, async () => summarizeRisk(await client.getRisk(strategyId))),
          optional(signal, async () => parseCollateral(await read(base, `/v1/collateral/${encodeURIComponent(strategyId)}`, signal))),
        ]);
        if (strategy.value === null) return null;
        const summary = risk.value ?? NO_RISK;
        const collateralSources = collateral.value ?? [];
        return Object.freeze({
          strategyId,
          environment: environment as string,
          state: strategy.value.state,
          stateHash: strategy.value.stateHash,
          ...summary,
          collateral: collateralSources,
          riskStatus: risk.status,
          collateralStatus: collateral.status,
          riskDomainIds: Object.freeze([...new Set([
            ...summary.positions.map((position) => position.riskDomainId),
            ...collateralSources.map((source) => source.riskDomainId),
          ])].sort()),
        });
      }));
      const loaded = rows.filter((row): row is PortfolioIntelligenceRow => row !== null);
      return Object.freeze({ rows: Object.freeze(loaded), unreadableOwners, unreadableStrategies: rows.length - loaded.length });
    },
  });

  return Object.freeze({
    rows: query.data?.rows ?? [],
    loading: query.isLoading,
    unavailable: query.isError,
    unreadableOwners: query.data?.unreadableOwners ?? 0,
    unreadableStrategies: query.data?.unreadableStrategies ?? 0,
    configured: baseUrl !== null,
    refresh: async () => { await query.refetch(); },
  });
}
