import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  createPrivateTerminalServer,
  type HyperliquidTestnetTerminalContext,
  type HyperliquidTestnetTerminalExecutionPort,
  type HyperliquidTestnetTerminalExecutionResult,
} from "../src/index.js";
import { executionReadinessFixtureGate, executionReadinessFixtureScopes } from "./execution-readiness-fixture.js";

const ATTEMPT_ID = "attempt-0123456789AB";
const IDEMPOTENCY_KEY = "idem-0123456789ABCD";
const ACTION = `0x${"aa".repeat(32)}`;
const REQUEST = `0x${"bb".repeat(32)}`;
const ERROR = `0x${"cc".repeat(32)}`;
const EVIDENCE = `0x${"dd".repeat(32)}`;
const LEG_EVIDENCE = `0x${"de".repeat(32)}`;
const ENDPOINT = "/internal/terminal/hyperliquid-testnet/execute";
const CONTEXT_ENDPOINT = "/internal/terminal/hyperliquid-testnet/context";
const TERMINAL_CONTEXT: HyperliquidTestnetTerminalContext = Object.freeze({
  contextId: "hyperliquid:testnet:btc-carry-v1",
  tradingAccount: "0x1111111111111111111111111111111111111111",
  domain: Object.freeze({
    domainId: "hypercore:testnet",
    domainManifestVersion: 1,
    domainManifestHash: "11".repeat(32),
  }),
  environment: "TESTNET",
  authorizationMode: "OWNER_SIGNED_OMNIBUS_ACCOUNT",
  maxOpenPackagesPerOwner: 1,
});
const EXECUTION_EVIDENCE = Object.freeze({
  evidenceVersion: "1000100",
  observedAtMs: "1000100",
  terminalResidualBaseAtoms: "0",
  terminalResidualQuoteAtoms: "0",
  legs: Object.freeze([
    Object.freeze({
      legId: "spot", role: "SPOT", clientOrderId: `0x${"51".repeat(16)}`,
      requestedSignedBaseAtoms: "1000", filledSignedBaseAtoms: "1000",
      grossQuoteAtoms: "6000", feeAssetId: "btc", feeAssetDecimals: 3,
      feeAtoms: "1", venueFeeQuoteAtoms: "6", evidenceCommitment: LEG_EVIDENCE,
    }),
    Object.freeze({
      legId: "perp", role: "PERPETUAL", clientOrderId: `0x${"52".repeat(16)}`,
      requestedSignedBaseAtoms: "-999", filledSignedBaseAtoms: "-999",
      grossQuoteAtoms: "5994", feeAssetId: "usdc", feeAssetDecimals: 2,
      feeAtoms: "3", venueFeeQuoteAtoms: "3", evidenceCommitment: LEG_EVIDENCE,
    }),
  ]),
});

async function listen(server: ReturnType<typeof createPrivateTerminalServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createPrivateTerminalServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function createGatedExecutionServer(
  config: Parameters<typeof createPrivateTerminalServer>[0],
  port: HyperliquidTestnetTerminalExecutionPort,
) {
  return createPrivateTerminalServer(
    config, {}, undefined, port, {},
    undefined, undefined, undefined, undefined, undefined, "PHASE4_FIXTURE", undefined, undefined, undefined,
    executionReadinessFixtureGate, executionReadinessFixtureScopes,
  );
}

function base(status: string): Record<string, unknown> {
  return {
    attemptId: ATTEMPT_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    domain: "hypercore:testnet",
    environment: "TESTNET",
    status,
  };
}

function variantFixtures(): Array<{ name: string; result: HyperliquidTestnetTerminalExecutionResult }> {
  return [
    {
      name: "CHECKPOINT_INCOMPLETE",
      result: { ...base("CHECKPOINT_INCOMPLETE"), reasons: ["EVIDENCE_PENDING"], rawEvidenceCommitments: [EVIDENCE] } as unknown as HyperliquidTestnetTerminalExecutionResult,
    },
    {
      name: "CHECKPOINT_FAILED",
      result: { ...base("CHECKPOINT_FAILED"), errorCommitment: ERROR } as unknown as HyperliquidTestnetTerminalExecutionResult,
    },
    {
      name: "NOT_SUBMITTED",
      result: {
        ...base("NOT_SUBMITTED"),
        evidenceStatus: "PRECONDITION_REJECTED",
        actionCommitment: null,
        requestCommitment: null,
        errorCommitment: ERROR,
      } as unknown as HyperliquidTestnetTerminalExecutionResult,
    },
    {
      name: "SUBMISSION_CALL_FAILED",
      result: { ...base("SUBMISSION_CALL_FAILED"), errorCommitment: ERROR } as unknown as HyperliquidTestnetTerminalExecutionResult,
    },
    {
      name: "SUBMISSION_RESULT_INVALID",
      result: { ...base("SUBMISSION_RESULT_INVALID"), errorCommitment: ERROR } as unknown as HyperliquidTestnetTerminalExecutionResult,
    },
    {
      name: "RECONCILIATION_DEFERRED",
      result: {
        ...base("RECONCILIATION_DEFERRED"),
        submissionStatus: "ACKNOWLEDGED",
        actionCommitment: ACTION,
        requestCommitment: REQUEST,
        errorCommitment: ERROR,
      } as unknown as HyperliquidTestnetTerminalExecutionResult,
    },
    {
      name: "RECONCILIATION_INCOMPLETE",
      result: {
        ...base("RECONCILIATION_INCOMPLETE"),
        submissionStatus: "AMBIGUOUS",
        packageStatus: "RECONCILING",
        reasons: ["RECONCILIATION_PENDING"],
        actionCommitment: ACTION,
        requestCommitment: REQUEST,
        rawEvidenceCommitments: [EVIDENCE],
      } as unknown as HyperliquidTestnetTerminalExecutionResult,
    },
    {
      name: "RECONCILED",
      result: {
        ...base("RECONCILED"),
        submissionStatus: "ACKNOWLEDGED",
        packageStatus: "COMPLETED_EXACT",
        reasons: [],
        actionCommitment: ACTION,
        requestCommitment: REQUEST,
        rawEvidenceCommitments: [EVIDENCE],
      } as unknown as HyperliquidTestnetTerminalExecutionResult,
    },
    {
      name: "HANDOFF_REJECTED",
      result: {
        ...base("HANDOFF_REJECTED"),
        reason: "HANDOFF_REFUSED",
        actionCommitment: ACTION,
        requestCommitment: REQUEST,
      } as unknown as HyperliquidTestnetTerminalExecutionResult,
    },
    {
      name: "STRATEGY_EXECUTION",
      result: {
        ...base("STRATEGY_EXECUTION"),
        packageStatus: "COMPLETED",
        completedStages: [0],
        stages: [{
          batchStage: 0,
          submissionStatus: "ACKNOWLEDGED",
          actionCommitment: ACTION,
          requestCommitment: REQUEST,
          evidence: {
            status: "COMPLETE",
            outcome: "COMPLETED",
            reasons: [],
            observedAtMs: "1000100",
            legs: [{
              legId: "spot",
              clientOrderId: `0x${"51".repeat(16)}`,
              plannedSignedBaseAtoms: "1000",
              filledSignedBaseAtoms: "1000",
              terminalStatus: "FILLED",
              openOrderStatus: "NONE",
              orderId: 1,
              fillCount: 1,
              grossQuoteAtoms: "6000",
              feeAssetId: "btc",
              feeAssetDecimals: 3,
              feeAtoms: "1",
              venueFeeQuoteAtoms: "6",
              observedAtMs: "1000050",
              evidenceCommitment: LEG_EVIDENCE,
            }],
            rawEvidenceCommitments: [EVIDENCE],
          },
        }],
      } as unknown as HyperliquidTestnetTerminalExecutionResult,
    },
  ];
}

test("hyperliquid testnet terminal execution boundary is injected and fail-closed", async () => {
  const origin = "http://127.0.0.1:3000";
  const config = { host: "127.0.0.1", port: 0, terminalOrigin: origin };
  const body = { attemptId: ATTEMPT_ID, idempotencyKey: IDEMPOTENCY_KEY };

  const unavailable = createPrivateTerminalServer(config);
  const unavailableUrl = await listen(unavailable);
  try {
    const health = await fetch(`${unavailableUrl}/internal/healthz`);
    assert.equal(health.status, 200);
    const healthBody = await health.json() as { hyperliquidTestnetExecutionAvailable: boolean };
    assert.equal(healthBody.hyperliquidTestnetExecutionAvailable, false);
    const response = await fetch(`${unavailableUrl}${ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { code: "EXECUTION_UNAVAILABLE", message: "Hyperliquid Testnet execution is unavailable." },
    });
    const wrongMethod = await fetch(`${unavailableUrl}${ENDPOINT}`, {
      method: "GET",
      headers: { Origin: origin },
    });
    assert.equal(wrongMethod.status, 405);
  } finally {
    await close(unavailable);
  }

  let calls = 0;
  let next: unknown | undefined;
  const port: HyperliquidTestnetTerminalExecutionPort = {
    execute: async (request) => {
      calls += 1;
      assert.deepEqual(request, body);
      assert.deepEqual(JSON.parse(JSON.stringify(request)), request);
      return next as HyperliquidTestnetTerminalExecutionResult;
    },
  };
  const server = createGatedExecutionServer(config, port);
  const serverUrl = await listen(server);
  try {
    const health = await fetch(`${serverUrl}/internal/healthz`);
    assert.equal((await health.json() as { hyperliquidTestnetExecutionAvailable: boolean }).hyperliquidTestnetExecutionAvailable, true);

    next = {
      ...base("RECONCILED"),
      submissionStatus: "ACKNOWLEDGED",
      packageStatus: "COMPLETED_EXACT",
      reasons: [],
      actionCommitment: ACTION,
      requestCommitment: REQUEST,
      rawEvidenceCommitments: [EVIDENCE],
      observedNetSpotDeltaAtoms: "999",
      observedPerpetualDeltaAtoms: "-999",
      executionEvidence: EXECUTION_EVIDENCE,
    };
    const reconciled = await fetch(`${serverUrl}${ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
    assert.equal(reconciled.status, 200);
    assert.deepEqual(await reconciled.json(), next);
    assert.equal(calls, 1);

    for (const extra of [{ ...body, plan: {} }, { ...body, account: "x" }, { ...body, signer: "y" }]) {
      const rejected = await fetch(`${serverUrl}${ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(extra),
      });
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json() as { error: { code: string } }).error.code, /INVALID_HYPERLIQUID/);
    }
    assert.equal(calls, 1);

    for (const fixture of variantFixtures()) {
      next = fixture.result;
      const response = await fetch(`${serverUrl}${ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, fixture.name);
      assert.deepEqual(await response.json(), fixture.result);
    }

    const badResults: unknown[] = [
      { ...base("RECONCILED"), submissionStatus: "ACKNOWLEDGED", packageStatus: "COMPLETED_EXACT", reasons: ["SETTLED"], actionCommitment: ACTION, requestCommitment: REQUEST, rawEvidenceCommitments: [EVIDENCE], attemptId: "attempt-mismatched-01" },
      { ...base("RECONCILED"), submissionStatus: "ACKNOWLEDGED", packageStatus: "COMPLETED_EXACT", reasons: ["SETTLED"], actionCommitment: "NOT_A_HASH", requestCommitment: REQUEST, rawEvidenceCommitments: [EVIDENCE] },
      { ...base("RECONCILED"), submissionStatus: "ACKNOWLEDGED", packageStatus: "COMPLETED_EXACT", reasons: ["SETTLED"], actionCommitment: ACTION, requestCommitment: REQUEST, rawEvidenceCommitments: [EVIDENCE], plan: {} },
      { ...base("RECONCILED"), submissionStatus: "VENUE_SUCCESS", packageStatus: "COMPLETED_EXACT", reasons: ["SETTLED"], actionCommitment: ACTION, requestCommitment: REQUEST, rawEvidenceCommitments: [EVIDENCE] },
      { ...base("RECONCILED"), submissionStatus: "ACKNOWLEDGED", packageStatus: "COMPLETED_EXACT", reasons: [], actionCommitment: ACTION, requestCommitment: REQUEST, rawEvidenceCommitments: [EVIDENCE], observedNetSpotDeltaAtoms: "999", observedPerpetualDeltaAtoms: "-999", executionEvidence: { ...EXECUTION_EVIDENCE, terminalResidualQuoteAtoms: "-1" } },
    ];
    for (const bad of badResults) {
      next = bad;
      const response = await fetch(`${serverUrl}${ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: { code: "HYPERLIQUID_EXECUTION_FAILED", message: "Hyperliquid Testnet execution failed closed." },
      });
    }

    const sixteenCommitments = Array.from(
      { length: 16 },
      (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`,
    );
    next = {
      ...base("RECONCILED"),
      submissionStatus: "ACKNOWLEDGED",
      packageStatus: "COMPLETED_EXACT",
      reasons: [],
      actionCommitment: ACTION,
      requestCommitment: REQUEST,
      rawEvidenceCommitments: sixteenCommitments,
    };
    const sixteen = await fetch(`${serverUrl}${ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
    assert.equal(sixteen.status, 200);
    assert.deepEqual(await sixteen.json(), next);

    const sixtyFiveCommitments = Array.from(
      { length: 65 },
      (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`,
    );
    next = {
      ...base("RECONCILED"),
      submissionStatus: "ACKNOWLEDGED",
      packageStatus: "COMPLETED_EXACT",
      reasons: [],
      actionCommitment: ACTION,
      requestCommitment: REQUEST,
      rawEvidenceCommitments: sixtyFiveCommitments,
    };
    const sixtyFive = await fetch(`${serverUrl}${ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
    assert.equal(sixtyFive.status, 502);
    assert.deepEqual(await sixtyFive.json(), {
      error: { code: "HYPERLIQUID_EXECUTION_FAILED", message: "Hyperliquid Testnet execution failed closed." },
    });

    next = { ...base("RECONCILED"), submissionStatus: "ACKNOWLEDGED", packageStatus: "COMPLETED_EXACT", reasons: [], actionCommitment: ACTION, requestCommitment: REQUEST, rawEvidenceCommitments: [EVIDENCE] };
    const throwing = createGatedExecutionServer(config, {
      execute: async () => {
        throw new Error("boom");
      },
    });
    const throwingUrl = await listen(throwing);
    try {
      const response = await fetch(`${throwingUrl}${ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: { code: "HYPERLIQUID_EXECUTION_FAILED", message: "Hyperliquid Testnet execution failed closed." },
      });
    } finally {
      await close(throwing);
    }
  } finally {
    await close(server);
  }
});

test("hyperliquid terminal context exposes only the active dedicated Testnet account gate", async () => {
  const origin = "http://127.0.0.1:3000";
  const config = { host: "127.0.0.1", port: 0, terminalOrigin: origin };
  const unavailable = createPrivateTerminalServer(config);
  const unavailableUrl = await listen(unavailable);
  try {
    const response = await fetch(`${unavailableUrl}${CONTEXT_ENDPOINT}`, {
      headers: { Origin: origin },
    });
    assert.equal(response.status, 503);
  } finally {
    await close(unavailable);
  }

  const server = createPrivateTerminalServer(
    config,
    {},
    undefined,
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "PHASE4_FIXTURE",
    undefined,
    undefined,
    TERMINAL_CONTEXT,
  );
  const serverUrl = await listen(server);
  try {
    const response = await fetch(`${serverUrl}${CONTEXT_ENDPOINT}`, {
      headers: { Origin: origin },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), TERMINAL_CONTEXT);

    const wrongMethod = await fetch(`${serverUrl}${CONTEXT_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{}",
    });
    assert.equal(wrongMethod.status, 405);
  } finally {
    await close(server);
  }
});
