import assert from "node:assert/strict";
import test from "node:test";
import { createHttpBaseSepoliaSolverAuthorizer } from "../src/base-sepolia-solver-authorization.js";
import { EvmTestnetTerminalValidationError } from "../src/evm-testnet-runtime-ports.js";

const bounds = {
  currentUnixSeconds: 1n,
  strategyAccount: `0x${"11".repeat(20)}`,
  solver: `0x${"22".repeat(20)}`,
  spotFillCommitment: new Uint8Array(32).fill(3),
  packageNonce: 0n,
  expectedPrePerpEntryNotionalWad: 0n,
  expectedPrePerpBalanceWad: 0n,
  minimumPostPerpBalanceWad: 1n,
  maximumPostPerpBalanceWad: 2n,
  maximumPostPerpEntryNotionalWad: 3n,
  perpExpiry: 4_294_967_295,
  perpArgs: [new Uint8Array(32), new Uint8Array(32)],
} as never;

function answering(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

test("a solver that declines at chain time is reported with its reason, not as a service failure", async () => {
  const declined = createHttpBaseSepoliaSolverAuthorizer(
    "http://127.0.0.1:8794",
    answering(409, { error: { code: "NOT_AUTHORIZED", message: "selected attempt failed admission at chain time" } }),
  );
  await assert.rejects(
    declined({ attemptId: "a", traderSignature: "0x", bounds }),
    (error: unknown) => error instanceof EvmTestnetTerminalValidationError && error.code === "SOLVER_DECLINED"
      && /failed admission at chain time/.test(error.message),
  );
  const broken = createHttpBaseSepoliaSolverAuthorizer("http://127.0.0.1:8794", answering(502, { error: { code: "AUTHORIZATION_FAILED" } }));
  await assert.rejects(
    broken({ attemptId: "a", traderSignature: "0x", bounds }),
    (error: unknown) => !(error instanceof EvmTestnetTerminalValidationError) && /HTTP 502/.test(String(error)),
  );
});
