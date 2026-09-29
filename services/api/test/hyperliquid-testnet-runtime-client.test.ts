import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { domainRef, parseProtocolJson, stringifyProtocolJson } from "@naryx/protocol-types";
import {
  HYPERLIQUID_TESTNET_PREPARE_PATH,
  HYPERLIQUID_TESTNET_RECONCILE_PATH,
  HttpHyperliquidTestnetEvidenceClient,
  HyperliquidTestnetRuntimeClientError,
  createHyperliquidTestnetAttemptPreparationPort,
  createHyperliquidTestnetEvidenceRuntime,
  loadHyperliquidTestnetRuntimeConfig,
  type HyperliquidTestnetAttemptPreparation,
} from "../src/index.js";

function errorCode(code: HyperliquidTestnetRuntimeClientError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof HyperliquidTestnetRuntimeClientError && error.code === code;
}

function preparationOptions() {
  return {
    intents: {
      getAttempt: () => undefined,
      getSelectedQuote: () => undefined,
    },
    orders: {
      getByOrderHash: () => undefined,
      getCanonicalOrderByHash: () => undefined,
    },
    domain: domainRef("hypercore:testnet", 1, "11".repeat(32)),
    solverId: "solver-hypercore-testnet-v1",
    solverVerificationKey: "22".repeat(32),
    seriesManifestHash: "23".repeat(32),
    executionClassManifestHash: "24".repeat(32),
    market: {
      spot: {
        adapterId: "hypercore-spot-v1",
        adapterManifestVersion: 1,
        adapterManifestHash: "51".repeat(32),
        venueId: "hypercore-testnet",
        venueManifestVersion: 1,
        venueManifestHash: "52".repeat(32),
        marketId: "spot-btc-usdc",
        marketManifestVersion: 1,
        marketManifestHash: "53".repeat(32),
        assetId: 101,
        sizeDecimals: 5,
        universeIndex: 101,
        tokenIndex: 7,
      },
      perpetual: {
        adapterId: "hypercore-perpetual-v1",
        adapterManifestVersion: 1,
        adapterManifestHash: "61".repeat(32),
        venueId: "hypercore-testnet",
        venueManifestVersion: 1,
        venueManifestHash: "62".repeat(32),
        marketId: "perp-btc-usdc",
        marketManifestVersion: 1,
        marketManifestHash: "63".repeat(32),
        assetId: 3,
        sizeDecimals: 4,
        assetIndex: 3,
      },
      quoteTokenIndex: 0,
    },
    bounds: {
      maxEvidenceAgeMs: 5_000,
      maxSnapshotSkewMs: 1_000,
      maxFillPages: 4,
    },
    currentTimeMs: () => 1_000,
  };
}

test("Hyperliquid preparation resolves only a durable selected attempt", () => {
  const port = createHyperliquidTestnetAttemptPreparationPort(preparationOptions());
  assert.throws(
    () => port.prepare("hypercore-attempt-0001"),
    errorCode("ATTEMPT_NOT_FOUND"),
  );

  const mismatch = createHyperliquidTestnetAttemptPreparationPort({
    ...preparationOptions(),
    intents: {
      getAttempt: () => ({
        attemptId: "local-atomic-" + "aa".repeat(32),
        orderHash: "aa".repeat(32),
        routeHash: "bb".repeat(32),
        quoteHash: "cc".repeat(32),
        status: "AUTHORIZED_QUOTE_SELECTED" as const,
        selectedAtMs: 900,
      }),
      getSelectedQuote: () => undefined,
    },
  });
  assert.throws(
    () => mismatch.prepare("local-atomic-" + "aa".repeat(32)),
    errorCode("ATTEMPT_EVIDENCE_MISSING"),
  );
});

test("Hyperliquid evidence client uses exact loopback paths and protocol JSON", async (context) => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url ?? "",
      body: parseProtocolJson(Buffer.concat(chunks).toString("utf8"), "test.request"),
    });
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(stringifyProtocolJson({ status: "EVIDENCE_ACCEPTED", sequence: 1n }, "test.response"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const client = new HttpHyperliquidTestnetEvidenceClient({
    solverOrigin: `http://127.0.0.1:${address.port}`,
  });
  const prepared = await client.prepare({ attemptId: "attempt-1" } as HyperliquidTestnetAttemptPreparation);
  const reconciled = await client.reconcile({ attemptId: "attempt-1", handoff: { revision: 2n } });

  assert.deepEqual(prepared, { status: "EVIDENCE_ACCEPTED", sequence: 1n });
  assert.deepEqual(reconciled, { status: "EVIDENCE_ACCEPTED", sequence: 1n });
  assert.equal(requests[0]?.path, HYPERLIQUID_TESTNET_PREPARE_PATH);
  assert.deepEqual(requests[0]?.body, { attemptId: "attempt-1" });
  assert.equal(requests[1]?.path, HYPERLIQUID_TESTNET_RECONCILE_PATH);
  assert.deepEqual(requests[1]?.body, { attemptId: "attempt-1", handoff: { revision: 2n } });

  assert.throws(
    () => new HttpHyperliquidTestnetEvidenceClient({ solverOrigin: "https://solver.example.com" }),
    errorCode("INVALID_CONFIGURATION"),
  );
  assert.throws(
    () => new HttpHyperliquidTestnetEvidenceClient({ solverOrigin: "http://192.0.2.10:8788" }),
    errorCode("INVALID_CONFIGURATION"),
  );
});

test("Hyperliquid evidence runtime reports preparation without enabling submission", () => {
  const runtime = createHyperliquidTestnetEvidenceRuntime(preparationOptions(), {
    solverOrigin: "http://127.0.0.1:8788",
  });
  assert.deepEqual(runtime.readiness, {
    preparationAvailable: true,
    evidenceReconciliationAvailable: true,
    executionSubmissionAvailable: false,
    executionSubmissionReason: "SOLVER_EXECUTOR_BOUNDARY_NOT_AVAILABLE",
  });
});

test("Hyperliquid runtime config requires exact Testnet identities", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-config-"));
  const path = join(scratch, "runtime.json");
  const options = preparationOptions();
  const config = {
    version: 1,
    environment: "TESTNET",
    domain: {
      domainId: options.domain.domainId,
      domainManifestVersion: options.domain.domainManifestVersion,
      domainManifestHash: "11".repeat(32),
    },
    solverId: options.solverId,
    solverVerificationKey: options.solverVerificationKey,
    seriesManifestHash: options.seriesManifestHash,
    executionClassManifestHash: options.executionClassManifestHash,
    market: options.market,
    bounds: options.bounds,
  };
  try {
    writeFileSync(path, stringifyProtocolJson(config, "test.runtimeConfig"));
    const loaded = loadHyperliquidTestnetRuntimeConfig(path);
    assert.equal(loaded.domain.domainId, "hypercore:testnet");
    assert.deepEqual(loaded.market, options.market);

    writeFileSync(path, stringifyProtocolJson({ ...config, environment: "MAINNET" }, "test.invalid"));
    assert.throws(
      () => loadHyperliquidTestnetRuntimeConfig(path),
      errorCode("INVALID_CONFIGURATION"),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
