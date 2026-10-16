import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { toProtocolJson } from "@naryx/protocol-types";
import { createOrderActivationAdminHandler } from "../src/order-activation-admin.js";

test("activation reserve takes its time and observations from the server, never from the caller", async () => {
  const reserved: unknown[] = [];
  const handler = createOrderActivationAdminHandler({
    activations: {
      activationClockValue: () => 1_060n,
      reserve: (input) => {
        reserved.push(input);
        return { active: false, reason: "NOT_DUE" };
      },
      complete: () => { throw new Error("unused"); },
      cancel: () => { throw new Error("unused"); },
    },
    observations: { observations: (_orderHash, atValue) => [{ metric: "BASIS", value: 1n, observedAtValue: atValue }] },
  });
  const server = createServer((request, response) => {
    if (!handler(request, response)) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const reserve = async (body: unknown) => (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/order-activations/reserve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toProtocolJson(body)),
  })).status;
  try {
    const body = { orderHash: "aa".repeat(32), side: "BID", limitPriceTicks: 100n };
    assert.equal(await reserve({ ...body, atValue: 9_999n }), 400);
    assert.equal(await reserve({ ...body, observations: [] }), 400);
    assert.equal(reserved.length, 0);
    assert.equal(await reserve(body), 200);
    assert.deepEqual(reserved, [{
      orderHashHex: "aa".repeat(32),
      observations: [{ metric: "BASIS", value: 1n, observedAtValue: 1_060n }],
      atValue: 1_060n,
      side: "BID",
      limitPriceTicks: 100n,
    }]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("time-only activation reserves without a metric observation service", async () => {
  let received: unknown;
  const handler = createOrderActivationAdminHandler({
    activations: {
      activationClockValue: () => 1_000n,
      reserve: (input) => { received = input; return { active: false, reason: "NOT_DUE" }; },
      complete: () => { throw new Error("unused"); },
      cancel: () => { throw new Error("unused"); },
    },
  });
  const server = createServer((request, response) => {
    if (!handler(request, response)) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/order-activations/reserve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toProtocolJson({ orderHash: "aa".repeat(32), side: "BID", limitPriceTicks: 100n })),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(received, {
      orderHashHex: "aa".repeat(32),
      observations: [],
      atValue: 1_000n,
      side: "BID",
      limitPriceTicks: 100n,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
