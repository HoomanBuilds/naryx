import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fromProtocolJson, marketCatalogue, marketCatalogueHash, searchMarketCatalogue, toHex, type MarketCatalogueInput } from "@naryx/protocol-types";
import { createPublicApiHandler, SqlitePackageExchangeStore } from "../src/index.js";
import { createCatalogueIssuer } from "../src/market-catalogue-issuer.js";
import { CLASS, CLASS_SUPPORT, NOW, registerAll, SERIES, SERIES_SUPPORT, withStore } from "./exchange-fixtures.js";

function catalogueKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, signHash: (hash: Uint8Array) => new Uint8Array(sign(null, hash, privateKey)) };
}

test("the catalogue issuer signs one catalogue per window and advances its sequence", () => {
  withStore((store) => {
    registerAll(store);
    const keys = catalogueKeys();
    let now = 1_790_000_000_000;
    const issuer = createCatalogueIssuer({ exchange: store, environment: "testnet", authority: "catalogue-1", signHash: keys.signHash, clockMs: () => now, ttlMs: 60_000 });

    const first = issuer.current();
    const hash = marketCatalogueHash(first.catalogue);
    assert.equal(first.catalogueHash, toHex(hash));
    assert.ok(verify(null, hash, keys.publicKey, first.catalogue.signature), "the authority signed the catalogue hash");
    const parsed = marketCatalogue(first.catalogue);
    assert.deepEqual(parsed.entries.map((entry) => entry.packageMarketId), [CLASS]);
    assert.equal(parsed.entries[0]?.seriesId, SERIES.seriesId);
    assert.equal(parsed.entries[0]?.halted, false);
    assert.equal(parsed.expiresAtMs - parsed.issuedAtMs, 60_000n);

    now += 59_999;
    assert.equal(issuer.current(), first, "every reader in one window receives the same catalogue");
    now += 1;
    const second = issuer.current();
    assert.ok(second.catalogue.sequence > first.catalogue.sequence);
    assert.notEqual(second.catalogueHash, first.catalogueHash);

    // A tampered catalogue no longer verifies against the authority's signature.
    const tampered: MarketCatalogueInput = { ...second.catalogue, entries: [{ ...second.catalogue.entries[0]!, halted: true }] };
    assert.equal(verify(null, marketCatalogueHash(tampered), keys.publicKey, tampered.signature), false);
    assert.equal(searchMarketCatalogue(second.catalogue, { text: CLASS.slice(0, 6) }).length, 1);
    assert.equal(searchMarketCatalogue(tampered, { text: CLASS.slice(0, 6) }).length, 0, "halted markets are hidden unless asked for");
  });
});

test("GET /v1/catalogue serves the signed catalogue, and 503 without an authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-catalogue-"));
  const store = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
  registerAll(store);
  const keys = catalogueKeys();
  const base = { exchange: store, nowValue: () => NOW, clockMs: () => 1_790_000_000_000, rateLimit: { windowMs: 60_000, maxRequests: 1_000 } };
  const catalogue = createCatalogueIssuer({ exchange: store, environment: "testnet", authority: "catalogue-1", signHash: keys.signHash, clockMs: base.clockMs });
  const withCatalogue = createPublicApiHandler({ ...base, catalogue });
  const without = createPublicApiHandler(base);
  const server = createServer((request, response) => {
    const bare = request.url?.startsWith("/without") === true;
    if (bare) request.url = (request.url as string).slice("/without".length);
    if (!(bare ? without : withCatalogue)(request, response)) {
      response.statusCode = 418;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const served = await fetch(`http://127.0.0.1:${port}/v1/catalogue`);
    assert.equal(served.status, 200);
    const body = fromProtocolJson(JSON.parse(await served.text())) as { catalogue: MarketCatalogueInput; catalogueHash: string };
    const hash = marketCatalogueHash(body.catalogue);
    assert.equal(body.catalogueHash, toHex(hash));
    assert.ok(verify(null, hash, keys.publicKey, body.catalogue.signature));
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/catalogue?q=sol`)).status, 400, "the catalogue takes no search parameters");
    const missing = await fetch(`http://127.0.0.1:${port}/without/v1/catalogue`);
    assert.equal(missing.status, 503);
    assert.match(await missing.text(), /CATALOGUE_UNAVAILABLE/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
