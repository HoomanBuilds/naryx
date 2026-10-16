import assert from "node:assert/strict";
import test from "node:test";
import {
  SolanaDevnetLegacyStrategyError,
  solanaDevnetAccountReadFailure,
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
