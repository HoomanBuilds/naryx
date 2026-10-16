import assert from "node:assert/strict";
import test from "node:test";
import {
  SolanaDevnetLegacyStrategyError,
  createSolanaDevnetAccountStatusCache,
  solanaDevnetAccountReadFailure,
  solanaDevnetCollateralTopUp,
  type SolanaDevnetAccountStatus,
} from "../src/solana-devnet-order-context.js";

test("legacy devnet strategy conflicts are actionable without exposing unrelated read failures", () => {
  assert.deepEqual(solanaDevnetAccountReadFailure(new SolanaDevnetLegacyStrategyError()), {
    status: 409,
    code: "LEGACY_STRATEGY_UNSUPPORTED",
    message: "This wallet has an older devnet strategy account that cannot trade on the current market. Use a fresh devnet wallet until migration is supported.",
  });
  assert.deepEqual(solanaDevnetAccountReadFailure(new Error("private RPC error")), {
    status: 502,
    code: "ACCOUNT_READ_FAILED",
    message: "Solana Devnet account read failed closed.",
  });
});

test("collateral setup funds a rounded buffer without chasing small moves or exceeding the deposit cap", () => {
  assert.deepEqual(solanaDevnetCollateralTopUp(101n, 0n, 200n), { target: 103n, deposit: 103n });
  assert.deepEqual(solanaDevnetCollateralTopUp(102n, 103n, 200n), { target: 104n, deposit: 0n });
  assert.deepEqual(solanaDevnetCollateralTopUp(101n, 0n, 101n), { target: 103n, deposit: 101n });
  assert.deepEqual(solanaDevnetCollateralTopUp(0n, 0n, 1n), { target: 0n, deposit: 0n });
  assert.throws(() => solanaDevnetCollateralTopUp(102n, 0n, 101n), /reviewed deposit bound/);
});

test("account status coalesces reads but never reuses completed setup instructions", async () => {
  let calls = 0;
  let resolve: (value: SolanaDevnetAccountStatus) => void = () => {};
  const status = { ready: false } as SolanaDevnetAccountStatus;
  const read = createSolanaDevnetAccountStatusCache(() => {
    calls += 1;
    return new Promise((done) => { resolve = done; });
  });
  const first = read("owner", 1n);
  assert.equal(read("owner", 1n), first);
  resolve(status);
  await first;
  const second = read("owner", 1n);
  assert.equal(calls, 2);
  resolve(status);
  await second;
});

test("ready account status expires and failed reads remain retryable", async () => {
  let now = 0;
  let calls = 0;
  const read = createSolanaDevnetAccountStatusCache(async () => {
    calls += 1;
    if (calls === 1) throw new Error("RPC unavailable");
    return { ready: true } as SolanaDevnetAccountStatus;
  }, () => now);
  await assert.rejects(read("owner", 1n), /RPC unavailable/);
  await read("owner", 1n);
  await read("owner", 1n);
  assert.equal(calls, 2);
  now = 2_000;
  await read("owner", 1n);
  assert.equal(calls, 3);
});
