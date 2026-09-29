import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { domainManifestHash, toHex } from "@naryx/protocol-types";
import { SqliteRegistryStore } from "../src/index.js";
import { DOMAIN_MANIFEST, operatorKeys, signedSolverManifest } from "./registry-fixtures.js";

function withRegistry(run: (registry: SqliteRegistryStore, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "naryx-registry-"));
  const path = join(dir, "registry.sqlite");
  const registry = new SqliteRegistryStore(path, { clock: () => 1_000 });
  try {
    run(registry, path);
  } finally {
    try {
      registry.close();
    } catch {
      // already closed by the test
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a published manifest version is immutable and re-registration is idempotent", () => {
  withRegistry((registry) => {
    const first = registry.registerDomain(DOMAIN_MANIFEST);
    assert.deepEqual(first, { created: true, documentHashHex: toHex(domainManifestHash(DOMAIN_MANIFEST)) });
    assert.equal(registry.registerDomain(DOMAIN_MANIFEST).created, false);
    assert.throws(() => registry.registerDomain({ ...DOMAIN_MANIFEST, clockModelId: "other-clock" }), { code: "DOCUMENT_CONFLICT" });
    registry.registerDomain({ ...DOMAIN_MANIFEST, manifestVersion: 2, clockModelId: "other-clock" });
    assert.equal(registry.latest("DOMAIN", DOMAIN_MANIFEST.domainId)?.subjectVersion, 2);
    assert.equal(registry.latest("DOMAIN", DOMAIN_MANIFEST.domainId, 1)?.documentHashHex, first.documentHashHex);
    assert.deepEqual(registry.list("DOMAIN").map((entry) => entry.subjectVersion), [2]);
    assert.throws(() => registry.registerDomain({ ...DOMAIN_MANIFEST, domainId: "" }), { code: "INVALID_DOCUMENT" });
  });
});

test("solver manifests need a valid operator signature, a stable operator key, and a rising nonce", () => {
  withRegistry((registry) => {
    const operator = operatorKeys();
    assert.equal(registry.registerSolverManifest(signedSolverManifest(operator)).created, true);
    const forged = { ...signedSolverManifest(operator, { manifestNonce: 2n }), maximumNotionalByMarket: [] };
    assert.throws(() => registry.registerSolverManifest(forged), { code: /INVALID_SIGNATURE|INVALID_DOCUMENT/ });
    assert.throws(() => registry.registerSolverManifest(signedSolverManifest(operatorKeys(), { manifestNonce: 3n })), { code: "OPERATOR_CHANGED" });
    registry.registerSolverManifest(signedSolverManifest(operator, { manifestNonce: 5n }));
    assert.throws(() => registry.registerSolverManifest(signedSolverManifest(operator, { manifestNonce: 4n })), { code: "NONCE_REGRESSED" });
    assert.equal(registry.latest("SOLVER_CAPABILITY", "solver-a")?.subjectVersion, 5);
  });
});

test("registry documents are append-only and the path must be durable", () => {
  withRegistry((registry, path) => {
    registry.registerDomain(DOMAIN_MANIFEST);
    registry.close();
    const raw = new Database(path);
    try {
      assert.throws(() => raw.prepare("DELETE FROM registry_documents").run(), /immutable/);
      assert.throws(() => raw.prepare("UPDATE registry_documents SET subject_id = 'x'").run(), /immutable/);
    } finally {
      raw.close();
    }
  });
  assert.throws(() => new SqliteRegistryStore("relative.sqlite"), { code: "INVALID_PATH" });
});
