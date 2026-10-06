import assert from "node:assert/strict";
import test from "node:test";
import {
  GeneralizedStrategyQuoteClientError,
  HttpGeneralizedStrategyQuoteClient,
} from "../src/index.js";

const ORDER_HASH = "11".repeat(32);
const IDEMPOTENCY_KEY = "generalized-quote-0001";

test("generalized quote client permits only loopback and sends the bounded request", async () => {
  assert.throws(
    () => new HttpGeneralizedStrategyQuoteClient("https://solver.example"),
    (error: unknown) => error instanceof GeneralizedStrategyQuoteClientError
      && error.code === "INVALID_ENDPOINT",
  );
  let requestUrl = "";
  let requestBody = "";
  const client = new HttpGeneralizedStrategyQuoteClient("http://127.0.0.1:8788", (async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    return new Response("", { status: 404 });
  }) as typeof fetch);
  await assert.rejects(
    () => client.quote(ORDER_HASH, IDEMPOTENCY_KEY),
    (error: unknown) => error instanceof GeneralizedStrategyQuoteClientError
      && error.code === "NOT_FOUND",
  );
  assert.equal(requestUrl, "http://127.0.0.1:8788/internal/strategy-quotes");
  assert.deepEqual(JSON.parse(requestBody), { orderHash: ORDER_HASH, idempotencyKey: IDEMPOTENCY_KEY });
  await assert.rejects(
    () => client.quote("AA".repeat(32), IDEMPOTENCY_KEY),
    (error: unknown) => error instanceof GeneralizedStrategyQuoteClientError
      && error.code === "INVALID_REQUEST",
  );
});

test("generalized quote client keeps declined and malformed responses fail closed", async () => {
  const client = (response: Response) => new HttpGeneralizedStrategyQuoteClient(
    "http://127.0.0.1:8788",
    (async () => response) as typeof fetch,
  );
  await assert.rejects(
    () => client(new Response("", { status: 409 })).quote(ORDER_HASH, IDEMPOTENCY_KEY),
    (error: unknown) => error instanceof GeneralizedStrategyQuoteClientError
      && error.code === "QUOTE_DECLINED",
  );
  await assert.rejects(
    () => client(new Response("{}", { headers: { "content-type": "application/json" } })).quote(ORDER_HASH, IDEMPOTENCY_KEY),
    (error: unknown) => error instanceof GeneralizedStrategyQuoteClientError
      && error.code === "INVALID_RESPONSE",
  );
  await assert.rejects(
    () => client(new Response("{}", { headers: { "content-type": "text/plain" } })).quote(ORDER_HASH, IDEMPOTENCY_KEY),
    (error: unknown) => error instanceof GeneralizedStrategyQuoteClientError
      && error.code === "INVALID_RESPONSE",
  );
});
