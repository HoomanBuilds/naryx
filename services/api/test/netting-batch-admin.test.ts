import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { parseProtocolJson, stringifyProtocolJson } from "@naryx/protocol-types";
import { createNettingBatchAdminHandler } from "../src/index.js";

const packageOrderId = "11".repeat(32);

test("only the loopback admin route prepares an authoritative netting batch", async () => {
  let prepared = 0;
  const handler = createNettingBatchAdminHandler({
    async prepare(input) {
      prepared += 1;
      assert.deepEqual(input.packageOrderIds, [packageOrderId]);
      assert.deepEqual(input.policy, { schemaVersion: 1 });
      return {
        batch: { proofHashHex: "22".repeat(32) } as never,
        replayed: false,
      };
    },
  });
  const server = createServer((request, response) => {
    if (!handler(request, response)) response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server address is unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/internal/netting/batches/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stringifyProtocolJson({ packageOrderIds: [packageOrderId], policy: { schemaVersion: 1 } }),
    });
    assert.equal(response.status, 200);
    const body = parseProtocolJson(await response.text()) as { replayed: boolean };
    assert.equal(body.replayed, false);
    assert.equal(prepared, 1);

    const browserResponse = await fetch(`${origin}/internal/netting/batches/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://naryx.example" },
      body: stringifyProtocolJson({ packageOrderIds: [packageOrderId], policy: { schemaVersion: 1 } }),
    });
    assert.equal(browserResponse.status, 403);
    assert.equal(prepared, 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});
