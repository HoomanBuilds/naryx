import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExecutionPreparationRequest } from "../src/terminal-execution.js";

test("parses execution size with the active market decimals and limit", () => {
  const request = parseExecutionPreparationRequest({
    domain: "svm:devnet",
    mode: "entry",
    size: "0.01",
    slippageBps: 25,
    quoteMode: "coordinated_limits",
    traderPublicKey: "11111111111111111111111111111111",
    idempotencyKey: "solana-size-parse-0001",
  }, { baseDecimals: 9, maximumSizeAtoms: 10_000_000_000n });
  assert.equal(request.sizeAtoms, "10000000");
  assert.throws(() => parseExecutionPreparationRequest({
    domain: "svm:devnet",
    mode: "entry",
    size: "10.000000001",
    slippageBps: 25,
    quoteMode: "coordinated_limits",
    traderPublicKey: "11111111111111111111111111111111",
    idempotencyKey: "solana-size-parse-0002",
  }, { baseDecimals: 9, maximumSizeAtoms: 10_000_000_000n }), /outside the supported canonical range/);
});
