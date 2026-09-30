import { packageQuoteShardHash, type QuoteReferenceStateInput, type SolverCapabilityManifestInput } from "@naryx/protocol-types";
import { verifyEd25519 } from "./ed25519.js";
import type { SqliteRegistryStore } from "./registry-store.js";
import type { SqliteSolverApiStore } from "./solver-api-store.js";

export interface OffchainShardFillRequest {
  readonly boundShardHash: string;
  readonly referenceState: QuoteReferenceStateInput;
  readonly levelId: bigint;
  readonly takerSide: "BUY" | "SELL";
  readonly size: bigint;
  readonly fee: bigint;
  readonly orderHash: string;
  readonly quoteHash: string;
  readonly routeHash: string;
}

export type OffchainShardFillResult =
  | { readonly settled: true; readonly replayed: boolean; readonly fillCommitmentHex: string; readonly priceTicks: bigint }
  | { readonly settled: false; readonly reason: string };

/**
 * The controller's settlement gate for signed offchain quote shards, used where a domain such as
 * Hyperliquid has no package contract to consume shard capacity. Before a shard-level fill is
 * executed, the gate requires the solver's manifest to be live, re-verifies the shard's signature
 * under a quote key valid now (so revoking a key stops fills against shards it signed), takes the
 * settlement time from the server clock in the level's own unit, and settles the fill through the
 * durable ledger, which bounds every signed state's cumulative fills and records each fill once.
 */
export function createOffchainShardSettlement(options: {
  readonly store: Pick<SqliteSolverApiStore, "getShard" | "settleShardFill">;
  readonly registry: Pick<SqliteRegistryStore, "latest">;
  readonly nowIn: (unit: string) => bigint | undefined;
}): { settle(solverId: string, shardId: string, request: OffchainShardFillRequest): OffchainShardFillResult } {
  return {
    settle(solverId, shardId, request) {
      const current = options.store.getShard(solverId, shardId);
      const level = current?.quoteLevels.find((entry) => entry.levelId === request.levelId);
      if (current === undefined) return { settled: false, reason: "SHARD_UNKNOWN" };
      const atValue = options.nowIn(level?.validUntilUnit ?? "EVM_UNIX_SECONDS");
      if (atValue === undefined) return { settled: false, reason: "TIME_UNIT_UNSUPPORTED" };
      return options.store.settleShardFill(solverId, shardId, { ...request, atValue }, (shard) => {
        const manifest = options.registry.latest<SolverCapabilityManifestInput>("SOLVER_CAPABILITY", solverId)?.document;
        if (manifest === undefined) return false;
        const now = options.nowIn(manifest.validityUnit);
        if (now === undefined || now >= manifest.validUntilValue) return false;
        const hash = packageQuoteShardHash(shard);
        return manifest.quoteVerificationKeys.some(
          (key) => now >= key.validFromValue && now < key.validUntilValue && verifyEd25519(key.verificationKey, hash, shard.signature),
        );
      });
    },
  };
}
