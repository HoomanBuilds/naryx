import assert from "node:assert/strict";
import test from "node:test";
import { createReadCache } from "../src/read-cache.js";

test("joins reads within the window, expires them, and retries after a failure", async () => {
  let now = 0;
  let reads = 0;
  const cache = createReadCache<number>({ ttlMs: 2_000, clockMs: () => now });
  const read = () => Promise.resolve(++reads);
  assert.equal(await cache("a", read), 1);
  now = 1_999;
  assert.equal(await cache("a", read), 1);
  assert.equal(await cache("b", read), 2);
  now = 2_000;
  assert.equal(await cache("a", read), 3);

  const failing = cache("c", () => Promise.reject(new Error("rpc down")));
  await assert.rejects(failing, /rpc down/);
  assert.equal(await cache("c", read), 4);
});

test("keeps at most maxKeys entries", async () => {
  let reads = 0;
  const cache = createReadCache<number>({ ttlMs: 60_000, maxKeys: 2, clockMs: () => 0 });
  const read = () => Promise.resolve(++reads);
  await cache("a", read);
  await cache("b", read);
  await cache("c", read);
  assert.equal(await cache("a", read), 4);
});
