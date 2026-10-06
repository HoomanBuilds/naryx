import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  domainManifestHash,
  domainRef,
  economicStrategySeriesHash,
  packageMatchingPolicy,
  packageMatchingPolicyHash,
  packageTemplateManifestHash,
  toProtocolJson,
  type PackageTemplateManifestInput,
} from "@naryx/protocol-types";
import {
  applyPublicMarketBootstrap,
  loadPublicMarketBootstrap,
  SqlitePackageExchangeStore,
  SqliteRegistryStore,
} from "../src/index.js";
import {
  CLASS,
  CLASS_SUPPORT,
  POLICY,
  SERIES,
  SERIES_SUPPORT,
  executionClass,
} from "./exchange-fixtures.js";
import { DOMAIN_MANIFEST } from "./registry-fixtures.js";

test("a reviewed public market bootstrap registers every immutable market document idempotently", () => {
  const directory = mkdtempSync(join(tmpdir(), "naryx-public-bootstrap-"));
  const path = join(directory, "bootstrap.json");
  const domain = domainRef(DOMAIN_MANIFEST.domainId, 1, domainManifestHash(DOMAIN_MANIFEST));
  const template: PackageTemplateManifestInput = {
    manifestVersion: 1,
    environment: "testnet",
    templateId: SERIES.templateId,
    templateVersion: 1,
    supportedDomains: [domain],
    orderSchemaHash: "61".repeat(32),
    quoteSchemaHash: "62".repeat(32),
    routeSchemaHash: "63".repeat(32),
    receiptSchemaHash: "64".repeat(32),
    entryCompilerVersion: 1,
    exitCompilerVersion: 1,
    legCount: 2,
    legTypes: ["spot-purchase", "perp-sale"],
    supportedDirections: ["LONG_SPOT_SHORT_PERP"],
    supportedSettlementClasses: ["ATOMIC_POSTCONDITION"],
    allowedSpotAdapterIds: ["spot-adapter-v1"],
    allowedPerpAdapterIds: ["perp-adapter-v1"],
    riskPolicyHash: "65".repeat(32),
  };
  const series = { ...SERIES, templateManifestHash: packageTemplateManifestHash(template) };
  const policy = { ...POLICY, environment: "testnet" };
  const execution = executionClass({
    seriesManifestHash: economicStrategySeriesHash(series, SERIES_SUPPORT),
    domains: [domain],
    matchingPolicyHash: packageMatchingPolicyHash(packageMatchingPolicy(policy)),
  });
  writeFileSync(path, JSON.stringify(toProtocolJson({
    version: 1,
    environment: "testnet",
    domainManifests: [DOMAIN_MANIFEST],
    packageTemplateManifests: [template],
    matchingPolicies: [policy],
    series: [series],
    executionClasses: [execution],
    books: [{ executionClassId: CLASS, executionClassVersion: 1 }],
  })));

  const exchange = new SqlitePackageExchangeStore(join(directory, "exchange.sqlite"), {
    seriesSupport: SERIES_SUPPORT,
    executionClassSupport: CLASS_SUPPORT,
  });
  const registry = new SqliteRegistryStore(join(directory, "registry.sqlite"));
  try {
    const bootstrap = loadPublicMarketBootstrap(path, "testnet");
    const result = applyPublicMarketBootstrap(bootstrap, exchange, registry);
    assert.deepEqual(result, { domains: 1, templates: 1, series: 1, executionClasses: 1, books: 1 });
    applyPublicMarketBootstrap(bootstrap, exchange, registry);
    assert.deepEqual(exchange.listBooks(), [{ executionClassId: CLASS, halted: false }]);
    assert.equal(registry.latest("PACKAGE_TEMPLATE", SERIES.templateId, 1)?.documentHashHex,
      Buffer.from(packageTemplateManifestHash(template)).toString("hex"));
    assert.throws(() => loadPublicMarketBootstrap(path, "mainnet"), /non-mainnet environment/);
  } finally {
    registry.close();
    exchange.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
