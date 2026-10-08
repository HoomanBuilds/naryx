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
  collateralSnapshotHash,
  fromProtocolJson,
  toHex,
  toProtocolJson,
  type CollateralSnapshotInput,
} from "@naryx/protocol-types";
import {
  createPublicApiHandler,
  SqliteCollateralSnapshotStore,
  SqlitePackageExchangeStore,
} from "../src/index.js";
import { CLASS_SUPPORT, NOW, SERIES_SUPPORT } from "./exchange-fixtures.js";

const NOW_MS = 1_790_000_000_000;
const usdc = assetRef("usdc", "33".repeat(32), 6);

function authority() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
  return {
    raw,
    signRecord: (record: CollateralSnapshotInput): CollateralSnapshotInput => ({
      ...record,
      signature: new Uint8Array(sign(null, collateralSnapshotHash(record), privateKey)),
    }),
  };
}

function record(overrides: Partial<CollateralSnapshotInput> = {}): CollateralSnapshotInput {
  return {
    version: 2,
    environment: "testnet",
    snapshotId: "collateral-1",
    sourceId: "base-sepolia-vault",
    strategyAccount: "strategy-1",
    owner: "owner-1",
    authority: "collateral-key-1",
    observedAtMs: BigInt(NOW_MS - 500),
    asset: usdc,
    riskDomainId: "sol-carry",
    mode: "ISOLATED",
    ownAvailableQuoteAtoms: 10_000_000n,
    borrowAvailableQuoteAtoms: 5_000_000n,
    requestedBorrowQuoteAtoms: 0n,
    borrowCostQuoteAtoms: 0n,
    haircutBps: 500n,
    withdrawalDelayMs: 1_000n,
    inventoryEligible: true,
    withdrawalAllowed: true,
    sourceEvidenceHash: "44".repeat(32),
    signature: new Uint8Array(64),
    ...overrides,
  };
}

test("signed environment-bound collateral snapshots are durable and monotonic", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-collateral-"));
  const key = authority();
  let clock = NOW_MS;
  const collateral = new SqliteCollateralSnapshotStore(join(dir, "collateral.sqlite"), {
    environment: "testnet",
    authorities: new Map([["collateral-key-1", key.raw]]),
    clock: () => clock,
  });
  const exchange = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), {
    seriesSupport: SERIES_SUPPORT,
    executionClassSupport: CLASS_SUPPORT,
  });
  const handler = createPublicApiHandler({
    exchange,
    collateral,
    nowValue: () => NOW,
    clockMs: () => clock,
    rateLimit: { windowMs: 60_000, maxRequests: 1_000 },
  });
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
      ...(body === undefined ? {} : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toProtocolJson(body)),
      }),
    });
    return {
      status: response.status,
      body: fromProtocolJson(JSON.parse(await response.text())) as Record<string, unknown>,
    };
  };
  const code = (response: { body: Record<string, unknown> }) => (response.body.error as { code: string }).code;
  try {
    assert.equal((await call("GET", "/v1/collateral/strategy-1")).status, 404);
    assert.equal(code(await call("POST", "/v1/collateral-snapshots", {
      record: { ...key.signRecord(record()), signature: new Uint8Array(64).fill(1) },
    })), "INVALID_SIGNATURE");
    assert.equal(code(await call("POST", "/v1/collateral-snapshots", {
      record: key.signRecord(record({ environment: "devnet" })),
    })), "WRONG_ENVIRONMENT");

    const first = key.signRecord(record());
    assert.deepEqual((await call("POST", "/v1/collateral-snapshots", { record: first })).body, {
      recordHashHex: toHex(collateralSnapshotHash(first)),
      replayed: false,
    });
    assert.equal((await call("POST", "/v1/collateral-snapshots", { record: first })).body.replayed, true);
    assert.equal(code(await call("POST", "/v1/collateral-snapshots", {
      record: key.signRecord(record({ snapshotId: "collateral-stale", observedAtMs: BigInt(NOW_MS - 700) })),
    })), "STALE_SNAPSHOT");

    clock += 2_000;
    const view = await call("GET", "/v1/collateral/strategy-1");
    assert.equal(view.status, 200);
    assert.equal(view.body.label, "OBSERVED");
    const [source] = view.body.sources as readonly {
      ageMs: bigint;
      recordHash: string;
      record: CollateralSnapshotInput;
    }[];
    assert.equal(source?.ageMs, 2_500n);
    assert.equal(source?.recordHash, toHex(collateralSnapshotHash(first)));
    assert.equal(source?.record.environment, "testnet");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    collateral.close();
    exchange.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
