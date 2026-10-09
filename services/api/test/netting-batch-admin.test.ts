import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { parseProtocolJson, stringifyProtocolJson } from "@naryx/protocol-types";
import { createNettingBatchAdminHandler } from "../src/index.js";

test("only the loopback admin route prepares an authoritative netting batch", async () => {
  let prepared = 0;
  const handler = createNettingBatchAdminHandler({
    async prepareNext(policy) {
      prepared += 1;
      assert.deepEqual(policy, { schemaVersion: 1 });
      return { status: "IDLE" };
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
    const response = await fetch(`${origin}/internal/netting/batches/prepare-next`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stringifyProtocolJson({ policy: { schemaVersion: 1 } }),
    });
    assert.equal(response.status, 200);
    const body = parseProtocolJson(await response.text()) as { status: string };
    assert.equal(body.status, "IDLE");
    assert.equal(prepared, 1);

    const browserResponse = await fetch(`${origin}/internal/netting/batches/prepare-next`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://naryx.example" },
      body: stringifyProtocolJson({ policy: { schemaVersion: 1 } }),
    });
    assert.equal(browserResponse.status, 403);
    assert.equal(prepared, 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});
