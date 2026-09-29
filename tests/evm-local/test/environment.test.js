import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { validateEnvironment, withLocalEvmEnvironment } from "../src/environment.js";

test("provisions and validates the Base local conformance graph", { timeout: 30_000 }, async () => {
  let runDir;
  await withLocalEvmEnvironment(async (environment) => {
    runDir = environment.runDir;
    assert.equal(await validateEnvironment(environment), true);
    assert.equal(environment.manifest.evidenceGrade, "LOCAL_CONFORMANCE");
    assert.equal(environment.manifest.chainId, 31_338);
    assert.equal(Object.hasOwn(environment.manifest, "keys"), false);
    assert.equal(existsSync(environment.manifestPath), true);
  });
  assert.equal(existsSync(runDir), false);
});
