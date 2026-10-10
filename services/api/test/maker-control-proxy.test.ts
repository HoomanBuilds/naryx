import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createMakerControlProxy } from "../src/maker-control-proxy.js";

const TOKEN = "operator-token-with-at-least-thirty-two-characters";
const HASH = "11".repeat(32);

test("maker control proxy authenticates and forwards only exact-state controls", async (t) => {
  const upstream: { url: string; body: unknown }[] = [];
  const handler = createMakerControlProxy({
    solverOrigin: "http://127.0.0.1:8788",
    operatorTokenSha256: createHash("sha256").update(TOKEN).digest("hex"),
    fetch: async (input, init) => {
      upstream.push({ url: String(input), body: JSON.parse(String(init?.body)) as unknown });
      return new Response(JSON.stringify({ version: 1, changed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const server = createServer((request, response) => {
    if (!handler(request, response)) response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/internal/terminal/maker/shards/template.market/cancel-all`;
  const request = (operatorToken: string) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operatorToken, expectedShardHash: HASH, expectedShardSequence: "7" }),
  });

  const rejected = await request("wrong-token-that-is-still-long-enough-to-parse");
  assert.equal(rejected.status, 403);
  assert.equal(upstream.length, 0);

  const accepted = await request(TOKEN);
  assert.equal(accepted.status, 200);
  assert.deepEqual(upstream, [{
    url: "http://127.0.0.1:8788/internal/maker/shards/template.market/cancel-all",
    body: { expectedShardHash: HASH, expectedShardSequence: "7" },
  }]);
});
