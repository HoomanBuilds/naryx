import assert from "node:assert/strict";
import test from "node:test";
import { strategyProgramView } from "../src/index.js";

test("activates only exact template actions backed by a qualified lane", () => {
  const view = strategyProgramView([{
    laneId: "base-sepolia-cash-carry",
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    actions: ["ENTRY", "EXIT"],
    legFamilies: ["SPOT_SWAP", "PERP_OPEN", "PERP_CLOSE"],
    settlementClasses: ["ATOMIC_POSTCONDITION"],
    domains: ["base"],
  }]);
  const cash = view.templates.find((template) => template.templateId === "cash-and-carry-v1")!;
  assert.equal(cash.activation, "EXECUTABLE_BY_QUALIFIED_LANE");
  assert.deepEqual(cash.qualifiedLanes, ["base-sepolia-cash-carry"]);
  assert.equal(cash.actions.find((action) => action.action === "ENTRY")?.activation, "EXECUTABLE_BY_QUALIFIED_LANE");
  assert.equal(cash.actions.find((action) => action.action === "REBALANCE")?.activation, "ADAPTER_ACTIVATION_REQUIRED");
  assert.equal(
    view.templates.find((template) => template.templateId === "option-spread-v1")?.activation,
    "ADAPTER_ACTIVATION_REQUIRED",
  );
});

test("fails closed on duplicate or malformed lane capabilities", () => {
  const lane = {
    laneId: "lane",
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    actions: ["ENTRY"],
    legFamilies: ["SPOT_SWAP", "PERP_OPEN"],
    settlementClasses: ["ATOMIC_POSTCONDITION"],
    domains: ["base"],
  } as const;
  assert.throws(() => strategyProgramView([lane, lane]), /repeated/);
  assert.throws(() => strategyProgramView([{ ...lane, domains: [] }]), /domains are invalid/);
  assert.throws(() => strategyProgramView([{ ...lane, legFamilies: [] }]), /leg families are invalid/);
});

test("does not activate an action when a mandatory leg family is unavailable", () => {
  const view = strategyProgramView([{
    laneId: "spot-only",
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    actions: ["ENTRY"],
    legFamilies: ["SPOT_SWAP"],
    settlementClasses: ["ATOMIC_POSTCONDITION"],
    domains: ["base"],
  }]);
  const entry = view.templates.find((template) => template.templateId === "cash-and-carry-v1")
    ?.actions.find((action) => action.action === "ENTRY");
  assert.equal(entry?.activation, "ADAPTER_ACTIVATION_REQUIRED");
});
