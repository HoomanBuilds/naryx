import assert from "node:assert/strict";
import test from "node:test";
import { strategyProgramView } from "../src/index.js";

test("activates only exact template actions backed by a qualified lane", () => {
  const view = strategyProgramView([{
    laneId: "base-sepolia-cash-carry",
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    actions: ["ENTRY", "EXIT"],
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
    settlementClasses: ["ATOMIC_POSTCONDITION"],
    domains: ["base"],
  } as const;
  assert.throws(() => strategyProgramView([lane, lane]), /repeated/);
  assert.throws(() => strategyProgramView([{ ...lane, domains: [] }]), /domains are invalid/);
});
