import type { IncomingMessage, ServerResponse } from "node:http";
import {
  toHex,
  type AssetRef,
  type DomainRef,
  type PackageQuoteShard,
  type SolverCapacityStatus,
} from "@naryx/protocol-types";
import type { SqliteSolverApiStore } from "./solver-api-store.js";
import { sendError, sendJson } from "./internal-http.js";

export const MAKER_OPERATIONS_PATH = "/internal/terminal/maker/operations";

export type MakerShardState = "LIVE" | "EMPTY" | "QUOTES_EXPIRED" | "CAPACITY_EXHAUSTED" | "HEARTBEAT_EXPIRED" | "KILLED";

type MakerOperationsStore = Pick<
  SqliteSolverApiStore,
  "shardsForSolver" | "shardFillSummary" | "capacityStatus"
>;

function shardState(shard: PackageQuoteShard, atValue: bigint): MakerShardState {
  if (shard.killSwitchState === "ACTIVE") return "KILLED";
  if (shard.heartbeatExpiry <= atValue) return "HEARTBEAT_EXPIRED";
  if (shard.inventoryCap === 0n || shard.reservedCapacity >= shard.inventoryCap) return "CAPACITY_EXHAUSTED";
  if (shard.quoteLevels.length === 0) return "EMPTY";
  if (shard.quoteLevels.every((level) => level.validUntilValue <= atValue)) return "QUOTES_EXPIRED";
  return "LIVE";
}

function utilizationBps(reservedCapacity: bigint, inventoryCap: bigint): bigint {
  if (inventoryCap === 0n) return 10_000n;
  const value = reservedCapacity * 10_000n / inventoryCap;
  return value > 10_000n ? 10_000n : value;
}

function capacityView(entry: {
  readonly scope: string;
  readonly record: {
    readonly environment: string;
    readonly domain: DomainRef;
    readonly asset: AssetRef;
    readonly availableAtoms: bigint;
    readonly maximumConcurrentRecoveryAtoms: bigint;
    readonly evidenceGrade: string;
    readonly observedAtValue: bigint;
    readonly expiresAtValue: bigint;
  };
  readonly status: SolverCapacityStatus;
}) {
  return Object.freeze({
    scope: entry.scope,
    environment: entry.record.environment,
    domain: Object.freeze({
      domainId: entry.record.domain.domainId,
      domainManifestVersion: entry.record.domain.domainManifestVersion,
      domainManifestHash: toHex(entry.record.domain.domainManifestHash),
    }),
    asset: Object.freeze({
      assetId: entry.record.asset.assetId,
      assetManifestHash: toHex(entry.record.asset.assetManifestHash),
      decimals: entry.record.asset.decimals,
    }),
    availableAtoms: entry.record.availableAtoms,
    maximumConcurrentRecoveryAtoms: entry.record.maximumConcurrentRecoveryAtoms,
    evidenceGrade: entry.record.evidenceGrade,
    observedAtValue: entry.record.observedAtValue,
    expiresAtValue: entry.record.expiresAtValue,
    state: entry.status.state,
    committedAtoms: entry.status.committedAtoms,
    committedRecoveryAtoms: entry.status.committedRecoveryAtoms,
    remainingAtoms: entry.status.remainingAtoms,
    outstandingCommitmentRoot: toHex(entry.status.outstandingCommitmentRoot),
  });
}

export function makerOperationsSnapshot(
  store: MakerOperationsStore,
  solverId: string,
  atValue: bigint,
) {
  const shards = store.shardsForSolver(solverId).map(({ shardId, shard, shardHashHex }) => {
    const fills = store.shardFillSummary(solverId, shardId, shardHashHex);
    const state = shardState(shard, atValue);
    const activeQuoteLevelCount = state === "LIVE"
      ? shard.quoteLevels.filter((level) => level.validUntilValue > atValue).length
      : 0;
    return Object.freeze({
      shardId,
      shardHash: shardHashHex,
      state,
      environment: shard.environment,
      domain: Object.freeze({
        domainId: shard.domain.domainId,
        domainManifestVersion: shard.domain.domainManifestVersion,
        domainManifestHash: toHex(shard.domain.domainManifestHash),
      }),
      templateId: shard.templateId,
      marketGroupId: shard.marketGroupId,
      referenceStateHash: toHex(shard.referenceStateHash),
      referenceSequence: shard.referenceSequence,
      quoteLevels: shard.quoteLevels,
      activeQuoteLevelCount,
      inventoryCap: shard.inventoryCap,
      reservedCapacity: shard.reservedCapacity,
      availableCapacity: shard.inventoryCap > shard.reservedCapacity
        ? shard.inventoryCap - shard.reservedCapacity
        : 0n,
      utilizationBps: utilizationBps(shard.reservedCapacity, shard.inventoryCap),
      heartbeatExpiry: shard.heartbeatExpiry,
      shardSequence: shard.shardSequence,
      ...fills,
    });
  });
  const capacities = store.capacityStatus(solverId, atValue).map(capacityView);
  return Object.freeze({
    version: 1,
    solverId,
    asOfValue: atValue,
    summary: Object.freeze({
      shardCount: shards.length,
      liveShardCount: shards.filter((shard) => shard.state === "LIVE").length,
      quotedLevelCount: shards.reduce((sum, shard) => sum + shard.activeQuoteLevelCount, 0),
      capacityScopeCount: capacities.length,
      activeCapacityScopeCount: capacities.filter((capacity) => capacity.state === "ACTIVE").length,
      alertCount: shards.filter((shard) => shard.state !== "LIVE").length
        + capacities.filter((capacity) => capacity.state !== "ACTIVE").length,
    }),
    shards: Object.freeze(shards),
    capacities: Object.freeze(capacities),
  });
}

export function createMakerOperationsHandler(options: {
  readonly store: MakerOperationsStore;
  readonly solverId: string;
  readonly nowValue: () => bigint;
}): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://internal.local");
    if (url.pathname !== MAKER_OPERATIONS_PATH) return false;
    if (url.search !== "") return sendError(response, 400, "INVALID_REQUEST", "Query parameters are not accepted.");
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET, OPTIONS");
      return sendError(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
    }
    try {
      return sendJson(response, 200, makerOperationsSnapshot(options.store, options.solverId, options.nowValue()));
    } catch {
      return sendError(response, 500, "MAKER_OPERATIONS_FAILED", "Maker operations could not be loaded.");
    }
  };
}
