import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  HttpInternalSolverQuoteClient,
  SolverQuoteClientError,
} from "../src/index.js";

test("solver quote client enforces loopback transport and response bindings", async (context) => {
  const orderHash = "11".repeat(32);
  const routeHash = "22".repeat(32);
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      orderHash: string;
      idempotencyKey: string;
    };
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      version: 1,
      status: "SIGNED",
      idempotencyKey: body.idempotencyKey,
      orderHash: body.orderHash,
      routeHash,
      quoteHash: "33".repeat(32),
      solverSignatureDigest: "44".repeat(32),
      routeBytes: "01",
      solverQuoteBytes: "02",
      route: { orderHash: body.orderHash },
      quote: {
        orderHash: body.orderHash,
        routeHash,
        solverSignatureScheme: "ED25519",
        quoteMode: "EXECUTION_COMMITMENT",
        signature: "55".repeat(64),
      },
    }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const client = new HttpInternalSolverQuoteClient(`http://127.0.0.1:${address.port}`);
  const result = await client.quote({ orderHash, idempotencyKey: "quote-client-key-0001" });
  assert.equal(result.orderHash, orderHash);
  assert.equal(result.routeHash, routeHash);
  assert.throws(
    () => new HttpInternalSolverQuoteClient("https://solver.example.com"),
    (error: unknown) => {
      assert.ok(error instanceof SolverQuoteClientError);
      assert.equal(error.code, "INVALID_ENDPOINT");
      return true;
    },
  );
});
