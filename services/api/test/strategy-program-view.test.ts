import assert from "node:assert/strict";
import test from "node:test";
import { strategyProgramView } from "../src/index.js";

test("activates only exact template actions backed by a qualified lane", () => {
  const view = strategyProgramView([{
    laneId: "base-sepolia-cash-carry",
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    actions: ["ENTRY", "EXIT"],
    legs: [
      { legFamily: "SPOT_SWAP", sides: ["BUY", "SELL"], maximumLegs: 1 },
      { legFamily: "PERP_OPEN", sides: ["SELL"], maximumLegs: 1 },
      { legFamily: "PERP_CLOSE", sides: ["BUY"], maximumLegs: 1 },
    ],
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
    legs: [
      { legFamily: "SPOT_SWAP", sides: ["BUY", "SELL"], maximumLegs: 1 },
      { legFamily: "PERP_OPEN", sides: ["SELL"], maximumLegs: 1 },
    ],
    settlementClasses: ["ATOMIC_POSTCONDITION"],
    domains: ["base"],
  } as const;
  assert.throws(() => strategyProgramView([lane, lane]), /repeated/);
  assert.throws(() => strategyProgramView([{ ...lane, domains: [] }]), /domains are invalid/);
  assert.throws(() => strategyProgramView([{ ...lane, legs: [] }]), /leg capabilities are invalid/);
  assert.throws(
    () => strategyProgramView([{ ...lane, legs: [{ legFamily: "SPOT_SWAP", sides: [], maximumLegs: 1 }] }]),
    /leg capabilities are invalid/,
  );
});

test("does not activate an action when a mandatory leg family is unavailable", () => {
  const view = strategyProgramView([{
    laneId: "spot-only",
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    actions: ["ENTRY"],
    legs: [{ legFamily: "SPOT_SWAP", sides: ["BUY", "SELL"], maximumLegs: 1 }],
    settlementClasses: ["ATOMIC_POSTCONDITION"],
    domains: ["base"],
  }]);
  const entry = view.templates.find((template) => template.templateId === "cash-and-carry-v1")
    ?.actions.find((action) => action.action === "ENTRY");
  assert.equal(entry?.activation, "ADAPTER_ACTIVATION_REQUIRED");
});

test("does not activate a two-sided funding spread from one-sided perp support", () => {
  const view = strategyProgramView([{
    laneId: "short-only",
    templateId: "perpetual-funding-spread-v1",
    templateVersion: 1,
    actions: ["ENTRY"],
    legs: [{ legFamily: "PERP_OPEN", sides: ["SELL"], maximumLegs: 2 }],
    settlementClasses: ["BATCHED_IOC_WITH_RECOVERY"],
    domains: ["solana"],
  }]);
  const entry = view.templates.find((template) => template.templateId === "perpetual-funding-spread-v1")
    ?.actions.find((action) => action.action === "ENTRY");
  assert.equal(entry?.activation, "ADAPTER_ACTIVATION_REQUIRED");
});

test("requires enough capacity for every mandatory package leg", () => {
  const lane = {
    laneId: "options",
    templateId: "option-spread-v1",
    templateVersion: 1,
    actions: ["ENTRY"],
    settlementClasses: ["ASYNC_BONDED_SOLVER"],
    domains: ["base"],
  } as const;
  const insufficient = strategyProgramView([{
    ...lane,
    legs: [{ legFamily: "OPTION_BUY", sides: ["BUY"], maximumLegs: 1 }],
  }]);
  assert.equal(
    insufficient.templates.find((template) => template.templateId === "option-spread-v1")
      ?.actions.find((action) => action.action === "ENTRY")?.activation,
    "ADAPTER_ACTIVATION_REQUIRED",
  );
  const sufficient = strategyProgramView([{
    ...lane,
    legs: [
      { legFamily: "OPTION_BUY", sides: ["BUY"], maximumLegs: 1 },
      { legFamily: "OPTION_MINT", sides: ["SELL"], maximumLegs: 1 },
    ],
  }]);
  assert.equal(
    sufficient.templates.find((template) => template.templateId === "option-spread-v1")
      ?.actions.find((action) => action.action === "ENTRY")?.activation,
    "EXECUTABLE_BY_QUALIFIED_LANE",
  );
});
