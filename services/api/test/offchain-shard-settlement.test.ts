import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  domainManifestHash,
  domainRef,
  packageQuoteShardHash,
  quoteReferenceStateHash,
  toHex,
  type PackageQuoteLevel,
  type PackageQuoteShardInput,
  type QuoteReferenceStateInput,
} from "@naryx/protocol-types";
import { createOffchainShardSettlement, SqliteRegistryStore, SqliteSolverApiStore } from "../src/index.js";
import { DOMAIN_MANIFEST, operatorKeys, signedSolverManifest } from "./registry-fixtures.js";

const NOW_S = 1_900_000_000n;
const FAR = NOW_S + 86_400n;

function quoteKey(): { raw: Uint8Array; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { raw: new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32)), privateKey };
}

const reference: QuoteReferenceStateInput = {
  referenceVersion: 1,
  environment: "testnet",
  marketGroupId: "sol-carry",
  referenceKind: "BASIS",
  referenceSequence: 1n,
  referencePriceTicks: 1_000n,
  sourceEvidenceHash: "41".repeat(32),
  observedAtUnit: "EVM_UNIX_SECONDS",
  observedAtValue: NOW_S - 10n,
};

const level = (levelId: bigint, direction: "BID" | "ASK", referenceOffset: bigint): PackageQuoteLevel => ({
  levelId,
  direction,
  size: 10n,
  referenceOffset,
  maximumFee: 5n,
  settlementClass: "BATCHED_IOC_WITH_RECOVERY",
  quoteMode: "EXECUTION_COMMITMENT",
  validUntilUnit: "EVM_UNIX_SECONDS",
  validUntilValue: FAR,
  reservationPolicy: "RESERVE_ON_ACCEPT",
});

test("the controller settles offchain shard fills once, within each signed state's level size and inventory", () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-shard-settlement-"));
  const registry = new SqliteRegistryStore(join(dir, "registry.sqlite"));
  const store = new SqliteSolverApiStore(join(dir, "solver.sqlite"), { clock: () => Number(NOW_S) * 1_000 });
  try {
    const operator = operatorKeys();
    const key = quoteKey();
    registry.registerDomain(DOMAIN_MANIFEST);
    registry.registerSolverManifest(
      signedSolverManifest(operator, { quoteVerificationKeys: [{ keyId: "q-1", scheme: "ED25519", verificationKey: key.raw, validFromValue: 0n, validUntilValue: FAR }], validUntilValue: FAR }),
    );
    const shardFor = (overrides: Partial<PackageQuoteShardInput> = {}): PackageQuoteShardInput => {
      const unsigned: PackageQuoteShardInput = {
        shardVersion: 1,
        environment: "testnet",
        domain: domainRef(DOMAIN_MANIFEST.domainId, 1, domainManifestHash(DOMAIN_MANIFEST)),
        solverId: "solver-a",
        templateId: "cash-and-carry-v1",
        marketGroupId: "sol-carry",
        referenceStateHash: quoteReferenceStateHash(reference),
        referenceSequence: 1n,
        quoteLevels: [level(1n, "BID", -5n), level(2n, "ASK", 5n)],
        inventoryCap: 15n,
        reservedCapacity: 0n,
        heartbeatExpiry: FAR,
        shardSequence: 1n,
        killSwitchState: "INACTIVE",
        signature: new Uint8Array(0),
        ...overrides,
      };
      return { ...unsigned, signature: new Uint8Array(sign(null, packageQuoteShardHash(unsigned), key.privateKey)) };
    };
    const first = shardFor();
    assert.ok(store.admitShard("solver-a", first).accepted);
    const shardId = "cash-and-carry-v1.sol-carry";
    const gate = createOffchainShardSettlement({ store, registry, nowIn: (unit) => (unit === "EVM_UNIX_SECONDS" ? NOW_S : undefined) });
    const fill = (overrides: Record<string, unknown> = {}) => ({
      boundShardHash: toHex(packageQuoteShardHash(first)),
      referenceState: reference,
      levelId: 2n,
      takerSide: "BUY" as const,
      size: 6n,
      fee: 1n,
      orderHash: "61".repeat(32),
      quoteHash: "62".repeat(32),
      routeHash: "63".repeat(32),
      ...overrides,
    });

    const settled = gate.settle("solver-a", shardId, fill());
    assert.ok(settled.settled && !settled.replayed);
    assert.equal(settled.priceTicks, 1_005n, "the price is the committed reference plus the level offset");
    const replay = gate.settle("solver-a", shardId, fill());
    assert.ok(replay.settled && replay.replayed && replay.fillCommitmentHex === settled.fillCommitmentHex);

    // Cumulative fills of one signed state are bounded by the level and by the shard's inventory.
    assert.deepEqual(gate.settle("solver-a", shardId, fill({ orderHash: "64".repeat(32), size: 5n })), { settled: false, reason: "SIZE_ABOVE_LEVEL" });
    assert.ok(gate.settle("solver-a", shardId, fill({ orderHash: "64".repeat(32), size: 4n })).settled);
    assert.deepEqual(
      gate.settle("solver-a", shardId, fill({ orderHash: "65".repeat(32), levelId: 1n, takerSide: "SELL", size: 6n })),
      { settled: false, reason: "CAPACITY_UNAVAILABLE" },
    );
    const bid = gate.settle("solver-a", shardId, fill({ orderHash: "65".repeat(32), levelId: 1n, takerSide: "SELL", size: 5n }));
    assert.ok(bid.settled && bid.priceTicks === 995n);
    assert.deepEqual(gate.settle("solver-a", shardId, fill({ orderHash: "66".repeat(32), referenceState: { ...reference, referencePriceTicks: 900n } })), { settled: false, reason: "REFERENCE_CHANGED" });
    assert.equal(store.shardFills("solver-a", shardId).length, 3);

    // A new signed state has its own capacity, fills must bind it, and settled fills still replay.
    const second = shardFor({ shardSequence: 2n, reservedCapacity: 15n, inventoryCap: 30n });
    assert.ok(store.admitShard("solver-a", second).accepted);
    assert.deepEqual(gate.settle("solver-a", shardId, fill({ orderHash: "67".repeat(32), size: 1n })), { settled: false, reason: "SHARD_CHANGED" });
    assert.ok(gate.settle("solver-a", shardId, fill({ orderHash: "67".repeat(32), size: 1n, boundShardHash: toHex(packageQuoteShardHash(second)) })).settled);
    const late = gate.settle("solver-a", shardId, fill());
    assert.ok(late.settled && late.replayed, "a settled fill replays after its shard moved on");

    // Revoking the quote key stops fills against every shard it signed.
    registry.registerSolverManifest(
      signedSolverManifest(operator, { manifestNonce: 2n, quoteVerificationKeys: [{ keyId: "q-2", scheme: "ED25519", verificationKey: quoteKey().raw, validFromValue: 0n, validUntilValue: FAR }], validUntilValue: FAR }),
    );
    assert.deepEqual(
      gate.settle("solver-a", shardId, fill({ orderHash: "68".repeat(32), size: 1n, boundShardHash: toHex(packageQuoteShardHash(second)) })),
      { settled: false, reason: "SIGNATURE_INVALID" },
    );
    assert.deepEqual(gate.settle("solver-a", "cash-and-carry-v1.eth-carry", fill()), { settled: false, reason: "SHARD_UNKNOWN" });
  } finally {
    store.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
