"use client";

import { useQuery } from "@tanstack/react-query";
import { NaryxClient, type StrategyState } from "@naryx/sdk";

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

export type PortfolioIntelligenceRow = Readonly<{
  strategyId: string;
  environment: string;
  state: StrategyState;
  stateHash: string;
  positionSources: number;
  positionCount: number;
  positionAgeMs: bigint | null;
  collateral: readonly SignedCollateral[];
}>;

export type PortfolioIntelligenceState = Readonly<{
  rows: readonly PortfolioIntelligenceRow[];
  loading: boolean;
  unavailable: boolean;
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

async function read(base: string, path: string, signal: AbortSignal, optional = false): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error(`${path} answered ${response.status}.`);
  return record(decode(await response.json() as Json), path);
}

function largest(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  return values.reduce((current, value) => value > current ? value : current);
}

function parseCollateral(value: Record<string, unknown> | null): readonly SignedCollateral[] {
  if (value === null) return [];
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

function parsePositions(value: Record<string, unknown> | null): Pick<PortfolioIntelligenceRow, "positionSources" | "positionCount" | "positionAgeMs"> {
  if (value === null) return { positionSources: 0, positionCount: 0, positionAgeMs: null };
  if (!Array.isArray(value.sources)) throw new Error("Position sources are malformed.");
  const sources = value.sources.map((raw, index) => {
    const source = record(raw, `Position source ${index}`);
    if (typeof source.positionCount !== "number" || !Number.isSafeInteger(source.positionCount) || source.positionCount < 0) {
      throw new Error(`Position source ${index} count is malformed.`);
    }
    return { positionCount: source.positionCount, ageMs: integer(source.ageMs, `Position source ${index} age`) };
  });
  return {
    positionSources: sources.length,
    positionCount: sources.reduce((sum, source) => sum + source.positionCount, 0),
    positionAgeMs: largest(sources.map((source) => source.ageMs)),
  };
}

export function usePortfolioIntelligence(baseUrl: string | null, owners: readonly (string | null)[]): PortfolioIntelligenceState {
  const activeOwners = [...new Set(owners.filter((owner): owner is string => owner !== null).map((owner) => owner.trim()).filter(Boolean))].sort();
  const query = useQuery({
    queryKey: ["portfolio-intelligence", baseUrl, activeOwners],
    enabled: baseUrl !== null && activeOwners.length > 0,
    refetchInterval: 15_000,
    queryFn: async ({ signal }): Promise<readonly PortfolioIntelligenceRow[]> => {
      const base = baseUrl!.replace(/\/+$/, "");
      const client = new NaryxClient({ baseUrl: base });
      const ownerViews = await Promise.all(activeOwners.map((owner) => read(base, `/v1/owners/${encodeURIComponent(owner)}/strategies`, signal)));
      const ids = new Set<string>();
      let environment: string | null = null;
      for (const view of ownerViews) {
        if (view === null || !Array.isArray(view.strategies)) throw new Error("Owner strategies are malformed.");
        const ownerEnvironment = string(view.environment, "Strategy environment");
        if (environment !== null && environment !== ownerEnvironment) throw new Error("Owner strategy views disagree on environment.");
        environment = ownerEnvironment;
        for (const raw of view.strategies) {
          const strategy = record(raw, "Owner strategy");
          if (strategy.open === true && strategy.retired === false) ids.add(string(strategy.strategyId, "Strategy id"));
        }
      }
      const rows = await Promise.all([...ids].sort().map(async (strategyId) => {
        const encoded = encodeURIComponent(strategyId);
        const [strategy, positions, collateral] = await Promise.all([
          client.getStrategy(strategyId),
          read(base, `/v1/positions/${encoded}`, signal, true),
          read(base, `/v1/collateral/${encoded}`, signal, true),
        ]);
        return Object.freeze({
          strategyId,
          environment: environment as string,
          state: strategy.state,
          stateHash: strategy.stateHash,
          ...parsePositions(positions),
          collateral: parseCollateral(collateral),
        });
      }));
      return Object.freeze(rows);
    },
  });

  return Object.freeze({
    rows: query.data ?? [],
    loading: query.isLoading,
    unavailable: query.isError,
    configured: baseUrl !== null,
    refresh: async () => { await query.refetch(); },
  });
}
