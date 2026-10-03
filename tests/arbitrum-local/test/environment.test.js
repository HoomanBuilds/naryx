import assert from "node:assert/strict";
import test from "node:test";
import {
  validateArbitrumLocalEnvironment,
  withLocalArbitrumEnvironment,
} from "../src/environment.js";

test("deploys a private Arbitrum asynchronous dependency graph", { timeout: 30_000 }, async () => {
  await withLocalArbitrumEnvironment(async (environment) => {
    assert.equal(await validateArbitrumLocalEnvironment(environment), true);
    assert.equal(environment.manifest.chainId, 421_614);
    assert.equal(environment.manifest.mainnet, false);
    assert.equal(environment.manifest.contracts.adapter.address, environment.contracts.adapter);
    assert.equal(environment.manifest.contracts.exitController.address, environment.contracts.exitController);
    assert.equal(environment.manifest.contracts.accountFactory.address, environment.contracts.accountFactory);
    assert.equal(environment.manifest.contracts.account.address, environment.contracts.account);
    assert.notEqual(environment.contracts.account, environment.contracts.accountImplementation);
    assert.notEqual(environment.manifest.contracts.account.codeHash, environment.manifest.contracts.accountImplementation.codeHash);
  });
});
