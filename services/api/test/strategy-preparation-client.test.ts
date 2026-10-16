import assert from "node:assert/strict";
import test from "node:test";
import { commitmentHash, stringifyProtocolJson } from "@naryx/protocol-types";
import { HttpStrategyPreparationClient, StrategyPreparationClientError } from "../src/index.js";

const QUOTE_HASH = "ab".repeat(32);

test("preparation preserves only quote-bound exact testnet funding requirements", async () => {
  const funding = {
    version: 1, quoteHash: QUOTE_HASH, chainId: 84532,
    strategyAccount: "0x1111111111111111111111111111111111111111",
    token: "0x2222222222222222222222222222222222222222",
    balanceAtoms: "1999999", requiredAtoms: "2000000", deficitAtoms: "1",
  };
  for (const [requirement, expected] of [
    [funding, "ACCOUNT_FUNDING_REQUIRED"],
    [{ ...funding, assetId: "base-test-token", decimals: 18 }, "ACCOUNT_FUNDING_REQUIRED"],
    [{ ...funding, assetId: "base-test-token", decimals: 39 }, "INVALID_RESPONSE"],
    [{ ...funding, quoteHash: "cd".repeat(32) }, "INVALID_RESPONSE"],
    [{ ...funding, chainId: 1 }, "INVALID_RESPONSE"],
    [{ ...funding, deficitAtoms: "2" }, "INVALID_RESPONSE"],
    [{ ...funding, requiredAtoms: (1n << 256n).toString() }, "INVALID_RESPONSE"],
  ] as const) {
    const client = new HttpStrategyPreparationClient("http://127.0.0.1:8788", async () =>
      new Response(JSON.stringify({ error: { code: "ACCOUNT_FUNDING_REQUIRED", funding: requirement } }), {
        status: 400, headers: { "Content-Type": "application/json" },
      }));
    await assert.rejects(client.prepare(QUOTE_HASH), (error: unknown) => {
      assert.ok(error instanceof StrategyPreparationClientError);
      assert.equal(error.code, expected);
      if (expected === "ACCOUNT_FUNDING_REQUIRED") assert.deepEqual(error.funding, requirement);
      return true;
    });
  }
});

test("strategy preparation exposes only recognized actionable refusals", async () => {
  for (const [message, code] of [
    ["strategy account lacks quote balance after maximum spend for recovery", "ACCOUNT_FUNDING_REQUIRED"],
    ["quoted margin is below the risk-policy floor", "MINIMUM_MARGIN_REQUIRED"],
    ["EVM calendar spread preparation refused: order, quote, or route expired", "QUOTE_EXPIRED"],
    ["private infrastructure error", "UPSTREAM_REJECTED"],
  ]) {
    const client = new HttpStrategyPreparationClient("http://127.0.0.1:8788", async () =>
      new Response(JSON.stringify({ error: { code: "PREPARATION_REJECTED", message } }), {
        status: 400, headers: { "Content-Type": "application/json" },
      }));
    await assert.rejects(client.prepare(QUOTE_HASH), (error: unknown) =>
      error instanceof StrategyPreparationClientError && error.code === code
      && !error.message.includes("private infrastructure error"));
  }
});

test("strategy preparation client accepts only loopback and verifies the returned quote", async () => {
  assert.throws(() => new HttpStrategyPreparationClient("https://solver.example"), /loopback/);
  const fetchImplementation = async () => new Response(stringifyProtocolJson({
    version: 1,
    prepared: {
      version: 1,
      quoteHash: commitmentHash(QUOTE_HASH),
      domains: [{ kind: "HYPERCORE_EXECUTOR" }],
    },
  }), { headers: { "Content-Type": "application/json" } });
  const client = new HttpStrategyPreparationClient("http://127.0.0.1:8788", fetchImplementation as typeof fetch);
  const result = await client.prepare(QUOTE_HASH);
  assert.equal(result.prepared.domains.length, 1);
  await assert.rejects(() => client.prepare(QUOTE_HASH.toUpperCase()), /lowercase hex/);

  const mismatched = new HttpStrategyPreparationClient("http://127.0.0.1:8788", (async () => new Response(stringifyProtocolJson({
    version: 1,
    prepared: {
      version: 1,
      quoteHash: commitmentHash("22".repeat(32)),
      domains: [{}],
    },
  }), { headers: { "Content-Type": "application/json" } })) as typeof fetch);
  await assert.rejects(() => mismatched.prepare(QUOTE_HASH), /does not bind/);
});
