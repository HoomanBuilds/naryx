import assert from "node:assert/strict";
import test from "node:test";
import {
  assetRef,
  commitmentHash,
  domainRef,
  packageQuoteShard,
  solverCapacityRecord,
  type PackageQuoteShardInput,
} from "@naryx/protocol-types";
import { makerOperationsSnapshot } from "../src/maker-operations.js";

const hash = (byte: string) => byte.repeat(64 / byte.length);
const domain = domainRef("eip155:84532", 1, hash("11"));
const asset = assetRef("usdc", hash("22"), 6);

function shard(overrides: Partial<PackageQuoteShardInput> = {}) {
  return packageQuoteShard({
    shardVersion: 1,
    environment: "testnet",
    domain,
    solverId: "solver-a",
    templateId: "cash-and-carry-v1",
    marketGroupId: "sol-carry",
    referenceStateHash: hash("33"),
    referenceSequence: 8n,
    quoteLevels: [{
      levelId: 1n,
      direction: "ASK",
      size: 100n,
      referenceOffset: 3n,
      maximumFee: 2n,
      settlementClass: "ATOMIC_POSTCONDITION",
      quoteMode: "FIRM_ONCHAIN",
      validUntilUnit: "EVM_UNIX_SECONDS",
      validUntilValue: 1_100n,
      reservationPolicy: "RESERVE_ON_ACCEPT",
    }],
    inventoryCap: 1_000n,
    reservedCapacity: 250n,
    heartbeatExpiry: 1_050n,
    shardSequence: 4n,
    killSwitchState: "INACTIVE",
    signature: new Uint8Array(64),
    ...overrides,
  });
}

test("maker operations derives shard health, utilization, fills, and capacity", () => {
  const live = shard();
  const expired = shard({ marketGroupId: "eth-carry", heartbeatExpiry: 1_000n, shardSequence: 5n });
  const snapshot = makerOperationsSnapshot({
    shardsForSolver: (solverId) => {
      assert.equal(solverId, "solver-a");
      return [
        { shardId: "cash-and-carry-v1.sol-carry", shard: live, shardHashHex: hash("44") },
        { shardId: "cash-and-carry-v1.eth-carry", shard: expired, shardHashHex: hash("55") },
      ];
    },
    shardFillSummary: (_solverId, shardId) => ({
      fillCount: shardId.endsWith("sol-carry") ? 2 : 0,
      filledSize: shardId.endsWith("sol-carry") ? 80n : 0n,
      latestFillCommitment: shardId.endsWith("sol-carry") ? hash("66") : null,
      latestSettledAtMs: shardId.endsWith("sol-carry") ? 900 : null,
    }),
    capacityStatus: () => [{
      scope: "scope-a",
      record: solverCapacityRecord({
        version: 1,
        environment: "testnet",
        solverId: "solver-a",
        domain,
        asset,
        availableAtoms: 2_000n,
        maximumConcurrentRecoveryAtoms: 500n,
        evidenceGrade: "ONCHAIN_AVAILABLE",
        evidenceCommitment: commitmentHash(hash("77")),
        observedAtValue: 900n,
        expiresAtValue: 1_100n,
      }),
      status: {
        state: "ACTIVE",
        committedAtoms: 400n,
        committedRecoveryAtoms: 100n,
        remainingAtoms: 1_600n,
        outstandingCommitmentRoot: commitmentHash(hash("88")),
      },
    }],
  }, "solver-a", 1_000n);

  assert.deepEqual(snapshot.summary, {
    shardCount: 2,
    liveShardCount: 1,
    quotedLevelCount: 1,
    capacityScopeCount: 1,
    activeCapacityScopeCount: 1,
    alertCount: 1,
  });
  assert.equal(snapshot.shards[0]?.state, "LIVE");
  assert.equal(snapshot.shards[0]?.utilizationBps, 2_500n);
  assert.equal(snapshot.shards[0]?.availableCapacity, 750n);
  assert.equal(snapshot.shards[0]?.fillCount, 2);
  assert.equal(snapshot.shards[1]?.state, "HEARTBEAT_EXPIRED");
  assert.equal(snapshot.capacities[0]?.remainingAtoms, 1_600n);
  assert.equal(snapshot.capacities[0]?.outstandingCommitmentRoot, hash("88"));
});
