import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assetRef,
  domainRef,
  fromProtocolJson,
  positionSnapshotRecordHash,
  toHex,
  toProtocolJson,
  type NormalizedPositionInput,
  type PositionSnapshotRecordInput,
} from "@naryx/protocol-types";
import { createPublicApiHandler, SqlitePackageExchangeStore, SqlitePositionSnapshotStore } from "../src/index.js";
import { CLASS_SUPPORT, NOW, SERIES_SUPPORT } from "./exchange-fixtures.js";

const NOW_MS = 1_790_000_000_000;
const domain = domainRef("hypercore:testnet", 1, "11".repeat(32));
const btc = assetRef("btc", "22".repeat(32), 8);
const usdc = assetRef("usdc", "33".repeat(32), 6);

function authority() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
  return { raw, signRecord: (record: PositionSnapshotRecordInput): PositionSnapshotRecordInput => ({ ...record, signature: new Uint8Array(sign(null, positionSnapshotRecordHash(record), privateKey)) }) };
}

function position(snapshotId: string, overrides: Partial<NormalizedPositionInput> = {}): NormalizedPositionInput {
  return {
    adapterVersion: 1,
    snapshotId,
    domain,
    observedAtMs: BigInt(NOW_MS - 1_000),
    owner: "strategy-1",
    venueId: "hypercore",
    marketId: "btc-perp",
    underlyingId: "btc",
    positionType: "PERPETUAL",
    // Short 0.5 BTC marked at 60000 USDC.
    quantityBaseAtoms: -50_000_000n,
    markPrice: { baseAsset: btc, quoteAsset: usdc, quoteAtoms: 600n, baseAtoms: 1n, roundingDirection: "AWAY_FROM_ZERO" },
    collateralQuoteAtoms: 3_000_000_000n,
    dependencyIds: ["venue:hypercore"],
    riskDomainId: "btc-carry",
    closeRoutes: [{ routeId: "ioc-close", executableQuantityAtoms: 50_000_000n, expectedCostQuoteAtoms: 15_000_000n, settlementDelayMs: 1_000n, authorityHeld: true, requiredDependencyIds: ["venue:hypercore"] }],
    ...overrides,
  };
}

function record(overrides: Partial<PositionSnapshotRecordInput> = {}): PositionSnapshotRecordInput {
  return {
    recordVersion: 1,
    environment: "testnet",
    strategyAccount: "strategy-1",
    sourceId: "hypercore-testnet-info",
    observedAtMs: BigInt(NOW_MS - 500),
    positions: [position("hl:perp:BTC")],
    unmappedInstruments: [],
    sourceEvidenceHash: "44".repeat(32),
    authority: "position-key-1",
    signature: new Uint8Array(0),
    ...overrides,
  };
}

test("signed position snapshots feed exact positions, risk, and risk-domain reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-positions-"));
  const key = authority();
  let clock = NOW_MS;
  const store = new SqlitePositionSnapshotStore(join(dir, "positions.sqlite"), { authorities: new Map([["position-key-1", key.raw]]), clock: () => clock });
  const exchange = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
  const handler = createPublicApiHandler({ exchange, positions: store, nowValue: () => NOW, clockMs: () => clock, rateLimit: { windowMs: 60_000, maxRequests: 1_000 } });
  const server = createServer((request, response) => {
    if (!handler(request, response)) {
      response.statusCode = 418;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(toProtocolJson(body)) }),
    });
    return { status: response.status, body: fromProtocolJson(JSON.parse(await response.text())) as Record<string, unknown> };
  };
  const code = (response: { body: Record<string, unknown> }) => (response.body.error as { code: string }).code;
  try {
    assert.equal((await call("GET", "/v1/positions/strategy-1")).status, 404);
    const first = key.signRecord(record());
    assert.equal(code(await call("POST", "/v1/position-snapshots", { record: { ...first, signature: new Uint8Array(64).fill(1) } })), "INVALID_SIGNATURE");
    assert.equal(code(await call("POST", "/v1/position-snapshots", { record: key.signRecord(record({ authority: "someone" })) })), "UNKNOWN_AUTHORITY");
    assert.equal(code(await call("POST", "/v1/position-snapshots", { record: key.signRecord(record({ observedAtMs: BigInt(NOW_MS - 600_000), positions: [position("hl:perp:BTC", { observedAtMs: BigInt(NOW_MS - 600_000) })] })) })), "OBSERVATION_OUT_OF_WINDOW");
    const stored = await call("POST", "/v1/position-snapshots", { record: first });
    assert.deepEqual(stored.body, { recordHashHex: toHex(positionSnapshotRecordHash(first)), replayed: false });
    assert.equal((await call("POST", "/v1/position-snapshots", { record: first })).body.replayed, true);
    assert.equal(code(await call("POST", "/v1/position-snapshots", { record: key.signRecord(record({ observedAtMs: BigInt(NOW_MS - 700), positions: [position("hl:perp:BTC", { observedAtMs: BigInt(NOW_MS - 800) })], unmappedInstruments: ["DOGE"] })) })), "STALE_SNAPSHOT");

    clock = NOW_MS + 2_000;
    const positions = await call("GET", "/v1/positions/strategy-1");
    assert.equal(positions.body.label, "OBSERVED");
    const sources = positions.body.sources as readonly { ageMs: bigint; recordHash: string }[];
    assert.equal(sources[0]?.ageMs, 2_500n);
    assert.equal((positions.body.positions as readonly unknown[]).length, 1);

    const risk = await call("GET", "/v1/risk/strategy-1");
    const [usdcRisk] = risk.body.byAccountingAsset as readonly {
      exposure: { byUnderlying: readonly { key: string; netNotional: bigint }[] };
      closeCost: { costQuoteAtoms: bigint; complete: boolean };
      stress: { label: string; results: readonly { scenarioId: string; markPnlQuoteAtoms: bigint; lossQuoteAtoms: bigint }[] };
    }[];
    assert.deepEqual(usdcRisk?.exposure.byUnderlying.map((line) => [line.key, line.netNotional]), [["btc", -30_000_000_000n]]);
    assert.deepEqual([usdcRisk?.closeCost.costQuoteAtoms, usdcRisk?.closeCost.complete], [15_000_000n, true]);
    assert.equal(usdcRisk?.stress.label, "MODELED");
    // The short gains 3000 USDC when BTC falls 10%, and loses it when BTC rises; closing costs 150%.
    assert.deepEqual(usdcRisk?.stress.results.map((row) => [row.scenarioId, row.markPnlQuoteAtoms, row.lossQuoteAtoms]), [
      ["uniform-down-10pct", 3_000_000_000n, 22_500_000n],
      ["uniform-up-10pct", -3_000_000_000n, 3_022_500_000n],
    ]);

    // A newer snapshot with the position closed shows the account as closed in its risk domain.
    clock = NOW_MS + 5_000;
    await call("POST", "/v1/position-snapshots", { record: key.signRecord(record({ observedAtMs: BigInt(NOW_MS + 4_000), positions: [] })) });
    const domainView = await call("GET", "/v1/risk-domains/btc-carry");
    assert.deepEqual((domainView.body.accounts as readonly { strategyAccount: string; positionsInDomain: number }[]).map((entry) => [entry.strategyAccount, entry.positionsInDomain]), [["strategy-1", 0]]);
    assert.deepEqual(domainView.body.byAccountingAsset, []);
    assert.equal((await call("GET", "/v1/risk-domains/eth-carry")).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    exchange.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
