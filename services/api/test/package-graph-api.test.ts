import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adapterRef,
  assetRef,
  domainManifestHash,
  domainRef,
  fromProtocolJson,
  packageGraphHash,
  packageTemplateManifestHash,
  toHex,
  toProtocolJson,
  versionedManifestRef,
  type DomainRegistryRecordInput,
  type PackageGraphInput,
  type PackageTemplateManifestInput,
} from "@naryx/protocol-types";
import { createPublicApiHandler, SqlitePackageExchangeStore, SqliteRegistryStore } from "../src/index.js";
import { CLASS_SUPPORT, NOW, SERIES_SUPPORT } from "./exchange-fixtures.js";
import { DOMAIN_MANIFEST } from "./registry-fixtures.js";

const NOW_S = 1_790_000_000n;
const domain = domainRef(DOMAIN_MANIFEST.domainId, 1, domainManifestHash(DOMAIN_MANIFEST));
const sol = assetRef("sol", "33".repeat(32), 9);
const usdc = assetRef("usdc", "34".repeat(32), 6);
const spotAdapter = adapterRef({ adapterId: "spot-adapter-v1", adapterManifestVersion: 1, adapterManifestHash: "35".repeat(32) });
const perpAdapter = adapterRef({ adapterId: "perp-adapter-v1", adapterManifestVersion: 1, adapterManifestHash: "36".repeat(32) });
const venue = versionedManifestRef("venue-a", 1, "37".repeat(32));
const spotMarket = versionedManifestRef("sol-usdc-spot", 1, "38".repeat(32));
const perpMarket = versionedManifestRef("sol-usdc-perp", 1, "39".repeat(32));

const template: PackageTemplateManifestInput = {
  manifestVersion: 1,
  environment: "testnet",
  templateId: "basis-graph-v1",
  templateVersion: 1,
  supportedDomains: [domain],
  orderSchemaHash: "41".repeat(32),
  quoteSchemaHash: "42".repeat(32),
  routeSchemaHash: "43".repeat(32),
  receiptSchemaHash: "44".repeat(32),
  entryCompilerVersion: 1,
  exitCompilerVersion: 1,
  legCount: 2,
  legTypes: ["spot-purchase", "perp-sale"],
  supportedDirections: ["LONG_SPOT_SHORT_PERP"],
  supportedSettlementClasses: ["ATOMIC_POSTCONDITION"],
  allowedSpotAdapterIds: [spotAdapter.adapterId],
  allowedPerpAdapterIds: [perpAdapter.adapterId],
  riskPolicyHash: "45".repeat(32),
};

const record = (recordKind: DomainRegistryRecordInput["recordKind"], subjectId: string, subjectManifestHash: Uint8Array | string): DomainRegistryRecordInput => ({
  recordVersion: 1,
  environment: "testnet",
  domain,
  recordKind,
  subjectId,
  subjectManifestVersion: 1,
  subjectManifestHash,
  registryState: "ACTIVE",
  riskLimits: [],
  allowedTemplates: [{ templateId: template.templateId, templateVersion: 1, packageTemplateManifestHash: packageTemplateManifestHash(template) }],
  allowedSettlementClasses: ["ATOMIC_POSTCONDITION"],
  activationUnit: "EVM_UNIX_SECONDS",
  activationValue: 1n,
  governanceReference: "governance-testnet-v1",
});

const leg = (legId: string, legTypeId: string, adapter: typeof spotAdapter, market: typeof spotMarket, side: "BUY" | "SELL") => ({
  legId,
  legFamily: legTypeId === "spot-purchase" ? ("SPOT_SWAP" as const) : ("PERP_OPEN" as const),
  legTypeId,
  domain,
  adapter,
  venue,
  market,
  assets: [sol, usdc],
  side,
  quantityAsset: sol,
  quantityAtoms: 1_000_000_000n,
  minimumQuantityAtoms: 1_000_000_000n,
  maximumFeeQuoteAtoms: 10_000n,
  preconditionHashes: [],
  postconditionHashes: [],
  timeInForce: "FOK" as const,
  legExpiryValue: NOW_S + 60n,
});

const graph: PackageGraphInput = {
  graphVersion: 1,
  environment: "testnet",
  templateId: template.templateId,
  templateVersion: 1,
  packageTemplateManifestHash: packageTemplateManifestHash(template),
  seriesId: "sol-basis",
  executionClassId: "sol-basis-atomic",
  lifecycleAction: "ENTRY",
  owner: "trader-1",
  strategyAccountRefs: ["strategy-1"],
  legs: [leg("spot", "spot-purchase", spotAdapter, spotMarket, "BUY"), leg("perp", "perp-sale", perpAdapter, perpMarket, "SELL")],
  dependencyEdges: [],
  executionGroups: [{ groupId: "atomic", kind: "ALL_OR_NONE", legIds: ["spot", "perp"] }],
  settlementClass: "ATOMIC_POSTCONDITION",
  policyHashes: { netting: "51".repeat(32), privacy: "52".repeat(32), solver: "53".repeat(32), delivery: "54".repeat(32), resource: "55".repeat(32), portfolioRiskLimits: "56".repeat(32) },
  recoverySlots: [],
  maximumRecoveryCostQuoteAtoms: 0n,
  expiryUnit: "EVM_UNIX_SECONDS",
  packageExpiryValue: NOW_S + 60n,
  nonce: 1n,
};

test("graphs compile against the registered template and this server's registry state, and simulate their failure points", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-graph-api-"));
  const registry = new SqliteRegistryStore(join(dir, "registry.sqlite"));
  const exchange = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
  registry.registerDomain(DOMAIN_MANIFEST);
  registry.registerPackageTemplate(template);
  const graphContext = {
    activeRegistryRecords: [
      record("ASSET", "sol", sol.assetManifestHash),
      record("ASSET", "usdc", usdc.assetManifestHash),
      record("ADAPTER", spotAdapter.adapterId, spotAdapter.adapterManifestHash),
      record("ADAPTER", perpAdapter.adapterId, perpAdapter.adapterManifestHash),
      record("VENUE", venue.subjectId, venue.manifestHash),
      record("MARKET", spotMarket.subjectId, spotMarket.manifestHash),
      record("MARKET", perpMarket.subjectId, perpMarket.manifestHash),
    ],
    resourceLimits: [{ domainId: DOMAIN_MANIFEST.domainId, maximumActionsPerTransaction: 4 }],
  };
  const handler = createPublicApiHandler({ exchange, registry, graphContext, nowValue: () => NOW, clockMs: () => Number(NOW_S) * 1_000, rateLimit: { windowMs: 60_000, maxRequests: 1_000 } });
  const server = createServer((request, response) => {
    if (!handler(request, response)) {
      response.statusCode = 418;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toProtocolJson(body)) });
    return { status: response.status, body: fromProtocolJson(JSON.parse(await response.text())) as Record<string, unknown> };
  };
  try {
    const compiled = await post("/v1/packages/compile", { graph });
    assert.equal(compiled.status, 200, JSON.stringify(toProtocolJson(compiled.body)));
    assert.equal(compiled.body.compiled, true);
    assert.equal(toHex(compiled.body.graphHash as Uint8Array), toHex(packageGraphHash(graph)));
    assert.equal(compiled.body.timeSource, "SERVER");
    const tooBig = await post("/v1/packages/compile", { graph: { ...graph, legs: [...graph.legs, leg("extra", "spot-purchase", spotAdapter, spotMarket, "BUY")], executionGroups: [{ groupId: "atomic", kind: "ALL_OR_NONE", legIds: ["spot", "perp", "extra"] }] } });
    assert.deepEqual(tooBig.body.reasons, ["TOO_MANY_LEGS"]);
    assert.equal((await post("/v1/packages/compile", { graph: { ...graph, templateVersion: 2 } })).status, 404);
    assert.equal((await post("/v1/packages/compile", { graph: { ...graph, dependencyEdges: [{ fromLegId: "spot", toLegId: "perp" }, { fromLegId: "perp", toLegId: "spot" }] } })).status, 400);

    const simulated = await post("/v1/packages/simulate", { graph });
    assert.equal(simulated.body.label, "SIMULATED");
    assert.deepEqual(simulated.body.stages, [["perp", "spot"]]);
    assert.deepEqual(simulated.body.failurePoints, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    registry.close();
    exchange.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
