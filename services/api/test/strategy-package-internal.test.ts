import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { parseProtocolJson } from "@naryx/protocol-types";
import { createStrategyPackageInternalHandler } from "../src/index.js";

const QUOTE_HASH = "11".repeat(32);

test("strategy package retrieval is loopback-only and returns the stored admission", async () => {
  const handler = createStrategyPackageInternalHandler({
    admissionByQuote: (quoteHash) => quoteHash === QUOTE_HASH
      ? ({ quoteHashHex: QUOTE_HASH, orderHashHex: "22".repeat(32) } as never)
      : undefined,
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
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});
