import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseProtocolJson, stringifyProtocolJson } from "@naryx/protocol-types";
import {
  DurableHyperliquidTestnetTerminalExecutionPort,
  HttpHyperliquidTestnetAttemptExecutor,
  HyperliquidTestnetTerminalExecutionStateError,
  type HyperliquidTestnetTerminalExecutionRequest,
  type HyperliquidTestnetTerminalExecutionResult,
  type TrustedHyperliquidTestnetAttemptExecutor,
} from "../src/index.js";

const REQUEST: HyperliquidTestnetTerminalExecutionRequest = Object.freeze({
  attemptId: "attempt-0123456789AB",
  idempotencyKey: "idem-0123456789ABCD",
});
const OTHER_ATTEMPT: HyperliquidTestnetTerminalExecutionRequest = Object.freeze({
  attemptId: "attempt-ABCDEFGHIJKL",
  idempotencyKey: REQUEST.idempotencyKey,
});
const ACTION = `0x${"aa".repeat(32)}`;
const REQUEST_COMMITMENT = `0x${"bb".repeat(32)}`;
const EVIDENCE = `0x${"cc".repeat(32)}`;

function result(
  request: HyperliquidTestnetTerminalExecutionRequest,
): HyperliquidTestnetTerminalExecutionResult {
  return Object.freeze({
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    domain: "hypercore:testnet",
    environment: "TESTNET",
    status: "RECONCILED",
    submissionStatus: "ACKNOWLEDGED",
    packageStatus: "COMPLETED_EXACT",
    reasons: Object.freeze([]),
    actionCommitment: ACTION,
    requestCommitment: REQUEST_COMMITMENT,
    rawEvidenceCommitments: Object.freeze([EVIDENCE]),
  });
}

function stateError(code: HyperliquidTestnetTerminalExecutionStateError["code"]):
  (error: unknown) => boolean {
  return (error) => error instanceof HyperliquidTestnetTerminalExecutionStateError &&
    error.code === code;
}

test("Hyperliquid executor client calls only the strict loopback executor boundary", async (context) => {
  let received: unknown;
  const server = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/internal/solver/hyperliquid-testnet/execute");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = parseProtocolJson(Buffer.concat(chunks).toString("utf8"), "test.executorRequest");
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(stringifyProtocolJson(result(REQUEST), "test.executorResult"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const client = new HttpHyperliquidTestnetAttemptExecutor({
    executorOrigin: `http://127.0.0.1:${port}`,
  });
  assert.deepEqual(await client.executeAttempt(REQUEST), result(REQUEST));
  assert.deepEqual(received, REQUEST);
  assert.throws(
    () => new HttpHyperliquidTestnetAttemptExecutor({
      executorOrigin: "https://solver.example.com",
    }),
    /loopback HTTP origin/,
  );
});

test("durable Hyperliquid terminal execution replays one stored result across restart", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-terminal-"));
  const path = join(scratch, "executions.db");
  let calls = 0;
  const executor: TrustedHyperliquidTestnetAttemptExecutor = {
    executeAttempt: async (request) => {
      calls += 1;
      return result(request);
    },
  };
  const first = new DurableHyperliquidTestnetTerminalExecutionPort(path, executor);
  try {
    assert.deepEqual(await first.execute(REQUEST), result(REQUEST));
    assert.deepEqual(await first.execute(REQUEST), result(REQUEST));
    assert.equal(calls, 1);
  } finally {
    first.close();
  }

  const restarted = new DurableHyperliquidTestnetTerminalExecutionPort(path, {
    executeAttempt: async () => {
      calls += 1;
      throw new Error("stored result should be replayed");
    },
  });
  try {
    assert.deepEqual(await restarted.execute(REQUEST), result(REQUEST));
    assert.equal(calls, 1);
  } finally {
    restarted.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("durable Hyperliquid terminal execution coalesces concurrent calls", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-terminal-coalesce-"));
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const port = new DurableHyperliquidTestnetTerminalExecutionPort(
    join(scratch, "executions.db"),
    {
      executeAttempt: async (request) => {
        calls += 1;
        await gate;
        return result(request);
      },
    },
  );
  try {
    const first = port.execute(REQUEST);
    const second = port.execute(REQUEST);
    assert.equal(calls, 1);
    release?.();
    assert.deepEqual(await Promise.all([first, second]), [result(REQUEST), result(REQUEST)]);
    assert.equal(calls, 1);
  } finally {
    port.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("durable Hyperliquid terminal execution rejects idempotency binding mismatches", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-terminal-conflict-"));
  let calls = 0;
  const port = new DurableHyperliquidTestnetTerminalExecutionPort(
    join(scratch, "executions.db"),
    {
      executeAttempt: async (request) => {
        calls += 1;
        return result(request);
      },
    },
  );
  try {
    await port.execute(REQUEST);
    await assert.rejects(port.execute(OTHER_ATTEMPT), stateError("IDEMPOTENCY_CONFLICT"));
    await assert.rejects(port.execute({
      attemptId: REQUEST.attemptId,
      idempotencyKey: "idem-FEDCBA9876543210",
    }), stateError("IDEMPOTENCY_CONFLICT"));
    assert.equal(calls, 1);
  } finally {
    port.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("durable Hyperliquid terminal execution fences thrown and invalid outcomes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-terminal-uncertain-"));
  const thrownPath = join(scratch, "thrown.db");
  let thrownCalls = 0;
  const throwing = new DurableHyperliquidTestnetTerminalExecutionPort(thrownPath, {
    executeAttempt: async () => {
      thrownCalls += 1;
      throw new Error("response lost");
    },
  });
  await assert.rejects(throwing.execute(REQUEST), /response lost/);
  await assert.rejects(throwing.execute(REQUEST), stateError("EXECUTION_OUTCOME_UNCERTAIN"));
  assert.equal(thrownCalls, 1);
  throwing.close();

  const restarted = new DurableHyperliquidTestnetTerminalExecutionPort(thrownPath, {
    executeAttempt: async (request) => {
      thrownCalls += 1;
      return result(request);
    },
  });
  await assert.rejects(restarted.execute(REQUEST), stateError("EXECUTION_OUTCOME_UNCERTAIN"));
  assert.equal(thrownCalls, 1);
  restarted.close();

  const invalidRequest = {
    attemptId: "attempt-invalidresult",
    idempotencyKey: "idem-invalidresult-01",
  };
  let invalidCalls = 0;
  const invalid = new DurableHyperliquidTestnetTerminalExecutionPort(
    join(scratch, "invalid.db"),
    {
      executeAttempt: async () => {
        invalidCalls += 1;
        return { ...result(invalidRequest), domain: "hypercore:mainnet" } as unknown as
          HyperliquidTestnetTerminalExecutionResult;
      },
    },
  );
  try {
    await assert.rejects(invalid.execute(invalidRequest), /not bound to hypercore:testnet TESTNET/);
    await assert.rejects(
      invalid.execute(invalidRequest),
      stateError("EXECUTION_OUTCOME_UNCERTAIN"),
    );
    assert.equal(invalidCalls, 1);
  } finally {
    invalid.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("durable Hyperliquid terminal execution resolves a timed-out handoff from the executor record", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-terminal-resolve-"));
  let executions = 0;
  const resolves: boolean[] = [];
  const settled: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const executor: TrustedHyperliquidTestnetAttemptExecutor = {
    executeAttempt: async (request) => {
      executions += 1;
      if (request.attemptId === REQUEST.attemptId) throw new Error("executor request timed out");
      await gate;
      return result(request);
    },
    attemptStatus: async (request) => {
      resolves.push(request.resolve);
      return request.attemptId === REQUEST.attemptId
        ? { state: "COMPLETED", queuePosition: null, lane: "FREE", result: result(REQUEST) }
        : { state: "QUEUED", queuePosition: 1, lane: "EXECUTING", result: null };
    },
  };
  const port = new DurableHyperliquidTestnetTerminalExecutionPort(join(scratch, "execution.db"), executor, {
    requireOwnerAuthorization: () => {},
    admit: () => {},
    settle: (_request, outcome) => { settled.push(outcome.status); },
  });
  try {
    await assert.rejects(port.execute(REQUEST), /timed out/);
    await assert.rejects(port.execute(REQUEST), stateError("EXECUTION_OUTCOME_UNCERTAIN"));
    // Nothing waits on the executor any more, so the status call resolves (fencing if unreceived).
    assert.deepEqual(await port.status(REQUEST), { state: "COMPLETED", result: result(REQUEST) });
    assert.deepEqual(resolves, [true]);
    assert.deepEqual(settled, ["RECONCILED"]);
    assert.deepEqual(await port.execute(REQUEST), result(REQUEST));
    assert.equal(executions, 1);

    // While this process still waits on a queued handoff, polling only reads.
    const queued = { attemptId: "attempt-queued-000001", idempotencyKey: "idem-queued-0000001" };
    const pending = port.execute(queued);
    assert.deepEqual(await port.status(queued), { state: "QUEUED", queuePosition: 1, lane: "EXECUTING" });
    assert.deepEqual(resolves, [true, false]);
    release();
    assert.deepEqual(await pending, result(queued));
    assert.deepEqual(await port.status({ attemptId: "attempt-never-0000001", idempotencyKey: "idem-never-00000001" }),
      { state: "NOT_STARTED", lane: null });
  } finally {
    port.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
