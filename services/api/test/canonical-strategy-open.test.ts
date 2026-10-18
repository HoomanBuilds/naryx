import assert from "node:assert/strict";
import test from "node:test";
import { economicStrategySeries, packageReceiptHash, protocolId, seriesExecutionClass, toHex } from "@naryx/protocol-types";
import { prepareCanonicalStrategyOpen } from "../src/strategy-open-preparation.js";
import { CLASS_SUPPORT, SERIES, SERIES_SUPPORT, executionClass } from "./exchange-fixtures.js";
import { hash, receipt } from "./evidence-fixtures.js";

test("canonical OPEN binds a schema-valid two-leg series to its finalized receipt", () => {
  const series = economicStrategySeries(SERIES, SERIES_SUPPORT);
  const lane = seriesExecutionClass(executionClass(), CLASS_SUPPORT);
  const origin = receipt(hash(3), { packageMarketId: lane.executionClassId, domain: lane.domains[0]!,
    packageTemplateManifestHash: series.templateManifestHash, netSpotDelta: 1_000_000_000n });
  const input = { environment: "testnet", atValue: 1_000n, receiptHashHex: toHex(packageReceiptHash(origin)),
    receipt: origin, series, executionClass: lane, transferable: true };
  const prepared = prepareCanonicalStrategyOpen(input);
  assert.equal(prepared.command.parameters.kind, "OPEN");
  if (prepared.command.parameters.kind !== "OPEN") throw new Error("unexpected command");
  const state = prepared.command.parameters.state;
  assert.equal(state.legs.find(leg => leg.legId === "spot")?.instrumentId, series.instrumentRefs![0]);
  assert.equal(state.legs.find(leg => leg.legId === "perp")?.instrumentId, series.instrumentRefs![1]);
  assert.deepEqual(state.legs.map(leg => leg.underlyingId), series.underlyingRefs);
  assert.equal(state.venuePositionsTransferable, false);
  assert.throws(() => prepareCanonicalStrategyOpen({ ...input, series: { ...series, underlyingRefs: [series.underlyingRefs[0]!] } }));
  assert.throws(() => prepareCanonicalStrategyOpen({ ...input, executionClass: { ...lane, executionClassId: protocolId("other") } }));
  assert.throws(() => prepareCanonicalStrategyOpen({ ...input, receiptHashHex: "00".repeat(32) }));
});
