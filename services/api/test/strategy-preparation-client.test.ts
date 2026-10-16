import assert from "node:assert/strict";
import test from "node:test";
import { commitmentHash, stringifyProtocolJson } from "@naryx/protocol-types";
import { HttpStrategyPreparationClient, StrategyPreparationClientError } from "../src/index.js";

const QUOTE_HASH = "ab".repeat(32);

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
