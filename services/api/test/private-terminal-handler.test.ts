import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createPrivateTerminalServer } from "../src/index.js";

test("private preview accepts bounded input and rejects extra execution fields", async () => {
  const origin = "http://127.0.0.1:3000";
  const server = createPrivateTerminalServer({
    host: "127.0.0.1",
    port: 0,
    terminalOrigin: origin,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}/internal/terminal/preview`;

  try {
    const accepted = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        domain: "solana",
        mode: "entry",
        size: "100.000001",
        slippageBps: 10,
        quoteMode: "coordinated_limits",
      }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("access-control-allow-origin"), origin);
    const preview = await accepted.json() as {
      source: string;
      executionAvailable: boolean;
      size: { baseAtoms: string };
      bound: { quoteAtoms: string };
      legs: unknown[];
    };
    assert.equal(preview.source, "PRIVATE_TERMINAL_BFF");
    assert.equal(preview.executionAvailable, false);
    assert.equal(preview.size.baseAtoms, "100000001");
    assert.match(preview.bound.quoteAtoms, /^\d+$/);
    assert.equal(preview.legs.length, 2);

    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        domain: "solana",
        mode: "entry",
        size: "100",
        slippageBps: 10,
        quoteMode: "coordinated_limits",
        adapter: "untrusted",
      }),
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), {
      error: {
        code: "INVALID_FIELDS",
        message: "Request must contain only domain, mode, size, slippageBps, and quoteMode.",
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});
