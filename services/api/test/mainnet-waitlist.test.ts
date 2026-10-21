import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Resolver } from "node:dns/promises";
import Database from "better-sqlite3";
import { createEmailDomainCheck, createMainnetWaitlistHandler, MainnetWaitlistStore, normalizeWaitlistEmail } from "../src/mainnet-waitlist.js";

test("waitlist normalizes email without collapsing aliases and refuses malformed or oversized addresses", () => {
  assert.equal(normalizeWaitlistEmail(" Trader+Launch@Example.COM "), "trader+launch@example.com");
  assert.equal(normalizeWaitlistEmail(`${"a".repeat(64)}@example.com`), `${"a".repeat(64)}@example.com`);
  for (const invalid of [null, 1, "", "a", "a@localhost", "a@@example.com", ".a@example.com", "a..b@example.com",
    "a@-example.com", "a@example..com", "a\nb@example.com", `${"a".repeat(65)}@example.com`, `${"a".repeat(300)}@example.com`]) {
    assert.equal(normalizeWaitlistEmail(invalid), undefined);
  }
});

test("waitlist persists consent across restart and concurrent duplicate signups keep the original row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-waitlist-"));
  const path = join(dir, "waitlist.db");
  let store = new MainnetWaitlistStore(path);
  try {
    await Promise.all([Promise.resolve().then(() => store.subscribe(" Trader@Example.com ", 100)),
      Promise.resolve().then(() => store.subscribe("trader@example.com", 200))]);
    store.close();
    store = new MainnetWaitlistStore(path);
    store.subscribe("trader@example.com", 300);
    const db = new Database(path, { readonly: true });
    try {
      assert.deepEqual(db.prepare("SELECT * FROM mainnet_waitlist").all(), [{ email: "trader@example.com",
        created_at_ms: 100, consent_version: "mainnet-launch-v1", source: "website" }]);
    } finally { db.close(); }
    assert.throws(() => store.subscribe("invalid", 400), /Invalid waitlist email/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("mail domain checks accept MX or SMTP address fallback, refuse null MX and retry DNS failures", async (t) => {
  const resolver = new Resolver();
  let calls = 0;
  resolver.resolveMx = async domain => {
    calls++;
    if (domain === "nomail.example") return [{ exchange: "", priority: 0 }];
    if (domain === "absent.example") throw Object.assign(new Error("absent"), { code: "ENOTFOUND" });
    if (domain === "fallback.example") throw Object.assign(new Error("no mx"), { code: "ENODATA" });
    if (domain === "timeout.example") throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    return [{ exchange: "mx.example", priority: 10 }];
  };
  t.mock.method(resolver, "resolve4", async () => ["192.0.2.1"]);
  t.mock.method(resolver, "resolve6", async () => { throw Object.assign(new Error("no ipv6"), { code: "ENODATA" }); });
  const accepts = createEmailDomainCheck(resolver);
  assert.equal(await accepts("mail.example"), true);
  assert.equal(await accepts("mail.example"), true);
  assert.equal(calls, 1);
  assert.equal(await accepts("nomail.example"), false);
  assert.equal(await accepts("absent.example"), false);
  assert.equal(await accepts("fallback.example"), true);
  await assert.rejects(accepts("timeout.example"), /timeout/);
  await assert.rejects(accepts("timeout.example"), /timeout/);
  assert.equal(calls, 6);
});

test("waitlist HTTP handles consent, CORS, bot traps, limits, durable failures and idempotent responses", async () => {
  const saved: string[] = [];
  let now = 0;
  let fail = false;
  const handler = createMainnetWaitlistHandler({ allowedOrigins: "https://naryx.xyz", clockMs: () => now,
    acceptsEmailDomain: async domain => domain === "example.com",
    store: { subscribe: email => { if (fail) throw new Error("private database details"); saved.push(email); } } });
  const server = createServer((req, res) => { if (!handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const body = { email: "Trader@Example.com", consent: true, website: "" };
  const post = (payload: unknown, headers = {}) => fetch(`${base}/v1/waitlist`, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://naryx.xyz", ...headers }, body: JSON.stringify(payload) });
  try {
    const preflight = await fetch(`${base}/v1/waitlist`, { method: "OPTIONS", headers: { Origin: "https://naryx.xyz" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://naryx.xyz");
    assert.equal((await post(body, { Origin: "https://untrusted.example" })).status, 403);
    assert.equal((await fetch(`${base}/v1/waitlist`)).status, 405);
    assert.equal((await fetch(`${base}/v1/other`)).status, 404);
    const first = await post(body);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.deepEqual(await first.json(), { status: "joined" });
    assert.deepEqual(await (await post(body)).json(), { status: "joined" });
    assert.equal((await post({ ...body, consent: false })).status, 400);
    assert.equal((await post({ ...body, email: "invalid" })).status, 400);
    assert.equal((await post({ ...body, website: "bot.example" })).status, 200);
    const throttled = await post(body);
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers.get("retry-after"), "600");
    assert.equal(saved.length, 2);
    now += 600_000;
    assert.equal((await post(body, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post({ ...body, email: "x".repeat(3000) })).status, 413);
    assert.equal((await post([])).status, 400);
    assert.equal((await fetch(`${base}/v1/waitlist`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400);
    fail = true;
    const failure = await post(body);
    assert.equal(failure.status, 503);
    assert.ok(!(await failure.text()).includes("private database details"));
    now += 600_000;
    fail = false;
    const before = saved.length;
    assert.equal((await post({ ...body, email: "trader@nonexistent.invalid" })).status, 400);
    assert.equal(saved.length, before);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
