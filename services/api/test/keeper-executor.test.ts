import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bs58 from "bs58";
import {
  activationConditionHash,
  assetRef,
  domainRef,
  keeperActionAuthorizationBytes,
  strategyHealthSnapshotHash,
  toProtocolJson,
  type ActivationConditionInput,
  type KeeperActionAuthorizationInput,
  type NormalizedPositionInput,
  type StrategyHealthSnapshotInput,
} from "@naryx/protocol-types";
import { createKeeperExecutorHandler, keeperClock, SqliteKeeperExecutor } from "../src/index.js";

const btc = assetRef("btc", "22".repeat(32), 8);
const usdc = assetRef("usdc", "33".repeat(32), 6);
const STATE_HASH = "51".repeat(32);

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
  return { raw, id: bs58.encode(raw), sign: (bytes: Uint8Array) => new Uint8Array(sign(null, bytes, privateKey)) };
}

const condition: ActivationConditionInput = { conditionVersion: 1, metric: "BASIS", comparator: "AT_OR_ABOVE", threshold: 50n, observationUnit: "EVM_UNIX_SECONDS", maximumObservationAge: 30n };
const snapshot = (overrides: Partial<StrategyHealthSnapshotInput> = {}): StrategyHealthSnapshotInput => ({
  snapshotVersion: 1, environment: "testnet", strategyId: "strategy-1", strategyStateHash: STATE_HASH, observedAtUnit: "EVM_UNIX_SECONDS", observedAtValue: 1_000n,
  deltaBaseAtoms: -40n, grossNotionalQuoteAtoms: 30_000_000_000n, leverageBps: 30_000n, marginHealthBps: 2_500n, liquidationDistanceBps: 1_800n, basisTicks: 60n, fundingPpm: 120n,
  volatilityPpm: 450_000n, residualBaseAtoms: 0n, maximumLossBoundQuoteAtoms: 900n, dependencyState: "HEALTHY", recoveryCapacityQuoteAtoms: 5_000n, evidenceHash: "52".repeat(32), ...overrides,
});
const exit: KeeperActionAuthorizationInput = {
  authorizationVersion: 1, environment: "testnet", strategyId: "strategy-1", templateId: "cash-and-carry-v1", templateVersion: 1, packageTemplateManifestHash: "44".repeat(32),
  lifecycleGraphHash: "61".repeat(32), actionKind: "SCHEDULED_EXIT", conditionHash: activationConditionHash(condition), maximumCostQuoteAtoms: 20_000_000n,
  resultingRiskBound: { maximumLeverageBps: 30_000n, maximumGrossNotionalQuoteAtoms: 30_000_000_000n, maximumLossBoundQuoteAtoms: 900n, maximumAbsoluteDeltaBaseAtoms: 40n, minimumMarginHealthBps: 2_000n },
  riskReducing: true, rewardQuoteAtoms: 10n, permittedKeeperIds: [], expiryUnit: "EVM_UNIX_SECONDS", expiryValue: 2_000n, authorizationNonce: 7n,
};
const position: NormalizedPositionInput = {
  adapterVersion: 1, snapshotId: "snap-1", domain: domainRef("hypercore:testnet", 1, "11".repeat(32)), observedAtMs: 1_000_000n, owner: "strategy-1", venueId: "hypercore",
  marketId: "btc-perp", underlyingId: "btc", positionType: "PERPETUAL", quantityBaseAtoms: -50_000_000n,
  markPrice: { baseAsset: btc, quoteAsset: usdc, quoteAtoms: 600n, baseAtoms: 1n, roundingDirection: "AWAY_FROM_ZERO" },
  dependencyIds: ["venue:hypercore"], riskDomainId: "btc-carry",
  closeRoutes: [{ routeId: "ioc-close", executableQuantityAtoms: 50_000_000n, expectedCostQuoteAtoms: 15_000_000n, settlementDelayMs: 1_000n, authorityHeld: true, requiredDependencyIds: ["venue:hypercore"] }],
};

test("the keeper executor serves signed current health, prices exits, and queues an owner-authorized action once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-keeper-executor-"));
  const owner = keyPair();
  const authority = keyPair();
  let stateHashHex = STATE_HASH;
  const strategies = { strategy: () => ({ state: { ownerId: owner.id, open: true }, stateHashHex }) } as unknown as ConstructorParameters<typeof SqliteKeeperExecutor>[1]["strategies"];
  const positions = { latest: () => [{ record: { positions: [position] } }] } as unknown as NonNullable<ConstructorParameters<typeof SqliteKeeperExecutor>[1]["positions"]>;
  const executor = new SqliteKeeperExecutor(join(dir, "keeper.sqlite"), { authorities: new Map([["health-1", authority.raw]]), strategies, positions, clock: () => 1_010_000 });
  try {
    const before = snapshot();
    const hash = strategyHealthSnapshotHash(before);
    assert.throws(() => executor.publishHealth(before, "health-2", authority.sign(hash)), { code: "UNKNOWN_AUTHORITY" });
    assert.throws(() => executor.publishHealth(before, "health-1", owner.sign(hash)), { code: "INVALID_SIGNATURE" });
    assert.equal(executor.publishHealth(before, "health-1", authority.sign(hash)).replayed, false);
    assert.equal(executor.publishHealth(before, "health-1", authority.sign(hash)).replayed, true);
    assert.equal(executor.health("strategy-1")?.stateHash, STATE_HASH);

    const plan = executor.plan(exit, before);
    assert.equal(plan?.costQuoteAtoms, 15_000_000n);
    assert.equal(plan?.after.grossNotionalQuoteAtoms, 0n);
    assert.ok(executor.plan({ ...exit, actionKind: "REBALANCE" }, before) !== undefined);
    assert.equal(executor.plan({ ...exit, actionKind: "ROLL" }, before), undefined);

    const request = { keeperId: "keeper-1", authorization: exit, condition, lifecycleGraphHash: "61".repeat(32), atValue: 1_010n };
    assert.deepEqual(executor.execute({ ...request, ownerSignature: authority.sign(keeperActionAuthorizationBytes(exit)) }), { status: "REJECTED", reason: "OWNER_SIGNATURE_INVALID" });
    const ownerSignature = owner.sign(keeperActionAuthorizationBytes(exit));
    assert.deepEqual(executor.execute({ ...request, ownerSignature }), { status: "QUEUED" });
    assert.deepEqual(executor.execute({ ...request, ownerSignature }), { status: "REJECTED", reason: "REPLAY" });
    assert.deepEqual(executor.queued().map((entry) => [entry.actionKind, entry.plan.costQuoteAtoms]), [["SCHEDULED_EXIT", 15_000_000n]]);

    // The cost bound is enforced by the executor itself, whatever the keeper projected.
    const cheap = { ...exit, maximumCostQuoteAtoms: 1_000n, authorizationNonce: 8n };
    assert.deepEqual(executor.execute({ ...request, authorization: cheap, ownerSignature: owner.sign(keeperActionAuthorizationBytes(cheap)) }), { status: "REJECTED", reason: "COST_ABOVE_BOUND" });

    // Once the strategy moves, no snapshot of the old state is served as its health.
    const next = { ...exit, authorizationNonce: 9n };
    stateHashHex = "53".repeat(32);
    assert.equal(executor.health("strategy-1"), undefined);
    assert.deepEqual(executor.execute({ ...request, authorization: next, ownerSignature: owner.sign(keeperActionAuthorizationBytes(next)) }), { status: "REJECTED", reason: "HEALTH_UNAVAILABLE" });
    stateHashHex = STATE_HASH;

    const handler = createKeeperExecutorHandler({ executor, nowIn: keeperClock(() => 1_010_000) });
    const server = createServer((req, res) => {
      if (!handler(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const health = await fetch(`${base}/internal/keeper/strategies/strategy-1/health`);
      assert.equal(health.status, 200);
      const browser = await fetch(`${base}/internal/keeper/strategies/strategy-1/health`, { headers: { Origin: "https://example.com" } });
      assert.equal(browser.status, 403);
      const later = { ...exit, authorizationNonce: 10n };
      const executed = await fetch(`${base}/internal/keeper/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toProtocolJson({ keeperId: "keeper-1", authorization: later, ownerSignature: owner.sign(keeperActionAuthorizationBytes(later)), condition, lifecycleGraphHash: "61".repeat(32) })),
      });
      assert.equal(executed.status, 200);
      assert.equal(((await executed.json()) as { status: string }).status, "QUEUED");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    executor.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
