import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import test from "node:test";

import {
  validateEnvironment,
  withLocalSolanaEnvironment,
} from "../src/environment.js";

test("starts a truthful provisioned local Solana environment and cleans it", async () => {
  let cleanedRunDir;
  await withLocalSolanaEnvironment(async (environment) => {
    cleanedRunDir = environment.runDir;
    const { manifest } = environment;

    assert.equal(await validateEnvironment(environment), true);
    assert.equal(manifest.evidenceGrade, "CONFORMANCE_DEPENDENCY");
    assert.equal(manifest.mainnet, false);
    assert.match(manifest.rpc.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(manifest.assets.base.decimals, 6);
    assert.equal(manifest.assets.quote.decimals, 6);
    assert.equal(manifest.assets.base.label, "NARYX_LOCAL_BASE_6");
    assert.equal(manifest.assets.quote.label, "NARYX_LOCAL_QUOTE_6");
    assert.ok(manifest.limitations.some((item) => item.includes("not Orca")));
    assert.ok(
      manifest.limitations.some((item) => item.includes("not Phoenix")),
    );
    assert.ok(
      manifest.governance.activatedAtSlot >=
        Math.max(
          manifest.governance.solverActivationSlot,
          manifest.governance.entryActivationSlot,
        ),
    );
    assert.equal(statSync(environment.manifestPath).mode & 0o777, 0o444);

    const identities = Object.values(manifest.identities);
    assert.equal(new Set(identities).size, identities.length);
  });
  assert.equal(existsSync(cleanedRunDir), false);
});
