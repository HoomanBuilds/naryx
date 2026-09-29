import assert from "node:assert/strict";
import test from "node:test";
import { clientKey, createRateLimiter } from "../src/rate-limit.js";

test("a full client table evicts the least recent client instead of refusing new ones", () => {
  let now = 0;
  const limited = createRateLimiter({ windowMs: 1_000, maxRequests: 2, clockMs: () => now, maxKeys: 3 });
  for (const key of ["a", "b", "c", "d", "e"]) assert.equal(limited(key), false);
  assert.equal(limited("new-client"), false);
  assert.equal(limited("e"), false);
  assert.equal(limited("e"), true);
  now = 1_000;
  assert.equal(limited("e"), false);
});

test("ipv6 peers share a /64 bucket and ipv4-mapped peers use the ipv4 address", () => {
  assert.equal(clientKey("2001:db8:1:2:aaaa::1"), clientKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"));
  assert.notEqual(clientKey("2001:db8:1:2::1"), clientKey("2001:db8:1:3::1"));
  assert.equal(clientKey("::ffff:10.0.0.7"), "10.0.0.7");
  assert.equal(clientKey("10.0.0.7"), "10.0.0.7");
  assert.equal(clientKey(undefined), "unknown");
});
