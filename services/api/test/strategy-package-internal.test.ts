import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { parseProtocolJson, stringifyProtocolJson } from "@naryx/protocol-types";
import { createStrategyPackageInternalHandler } from "../src/index.js";

const QUOTE_HASH = "11".repeat(32);

test("strategy package retrieval is loopback-only and returns the stored admission", async () => {
  const handler = createStrategyPackageInternalHandler({
    admissionByQuote: (quoteHash) => quoteHash === QUOTE_HASH
      ? ({ quoteHashHex: QUOTE_HASH, orderHashHex: "22".repeat(32) } as never)
      : undefined,
    order: (orderHash) => orderHash === "22".repeat(32)
      ? ({ orderHashHex: orderHash, graphHashHex: "33".repeat(32) } as never)
      : undefined,
    recordReceipt: () => ({ created: true, receiptHashHex: "44".repeat(32) }),
  });
  const server = createServer((request, response) => {
    if (!handler(request, response)) response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server address is unavailable");
  const url = `http://127.0.0.1:${address.port}/internal/strategy-packages/quotes/${QUOTE_HASH}`;
  try {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(parseProtocolJson(await response.text()), {
      version: 1,
      quoteHashHex: QUOTE_HASH,
      orderHashHex: "22".repeat(32),
    });
    assert.equal((await fetch(url, { headers: { Origin: "https://terminal.example" } })).status, 403);
    assert.equal((await fetch(`${url.slice(0, -64)}${"33".repeat(32)}`)).status, 404);
    const orderUrl = `http://127.0.0.1:${address.port}/internal/strategy-packages/orders/${"22".repeat(32)}`;
    const order = await fetch(orderUrl);
    assert.equal(order.status, 200);
    assert.deepEqual(parseProtocolJson(await order.text()), {
      version: 1,
      orderHashHex: "22".repeat(32),
      graphHashHex: "33".repeat(32),
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("strategy receipt recording is loopback-only and body-bounded", async () => {
  let recorded: unknown;
  const handler = createStrategyPackageInternalHandler({
    admissionByQuote: () => undefined,
    order: () => undefined,
    recordReceipt: (receipt) => {
      recorded = receipt;
      return { created: true, receiptHashHex: "44".repeat(32) };
    },
  });
  const server = createServer((request, response) => {
    if (!handler(request, response)) response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server address is unavailable");
  const url = `http://127.0.0.1:${address.port}/internal/strategy-packages/receipts`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stringifyProtocolJson({ receipt: { version: 1, receiptNonce: 7n } }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(parseProtocolJson(await response.text()), {
      version: 1,
      created: true,
      receiptHashHex: "44".repeat(32),
    });
    assert.deepEqual(recorded, { version: 1, receiptNonce: 7n });
    assert.equal((await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://terminal.example" },
      body: stringifyProtocolJson({ receipt: {} }),
    })).status, 403);
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 415);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});
