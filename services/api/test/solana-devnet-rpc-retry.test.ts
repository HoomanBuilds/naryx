import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { HttpSolanaDevnetMarketReadPort } from "../src/solana-devnet-order-context.js";

test("retries a rate-limited Solana RPC read", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    if (requests === 1) {
      response.setHeader("retry-after", "0");
      response.writeHead(429).end("{}");
      return;
    }
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "devnet-genesis" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const rpc = new HttpSolanaDevnetMarketReadPort(`http://127.0.0.1:${address.port}`);
    assert.equal(await rpc.getGenesisHash(), "devnet-genesis");
    assert.equal(requests, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
