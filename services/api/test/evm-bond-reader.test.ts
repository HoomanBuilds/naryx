import assert from "node:assert/strict";
import test from "node:test";
import { assetRef, verifyQuoteBond } from "@naryx/protocol-types";
import { createEvmBondReader } from "../src/index.js";

const SOLVER = `0x${"51".repeat(20)}`;
const TOKEN = `0x${"70".repeat(20)}`;
const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0");
const address = (value: string) => `${"00".repeat(12)}${value.slice(2)}`;

test("the bond reader turns the vault's bond state into the kernel ledger the backing check uses", async () => {
  let calls = 0;
  const state = (encumbered: bigint, released: boolean) =>
    `0x${address(SOLVER)}${address(TOKEN)}${word(1_000n)}${word(600n)}${word(encumbered)}${word(0n)}${word(100n)}${word(5_000n)}${word(0)}${word(0b10)}${word(released ? 1 : 0)}`;
  let result = state(0n, false);
  const reader = createEvmBondReader({
    rpcUrl: "http://127.0.0.1:8545",
    vault: `0x${"cd".repeat(20)}`,
    solverByAddress: new Map([[SOLVER, "solver-a"]]),
    assetByAddress: new Map([[TOKEN, assetRef("usdc", "33".repeat(32), 6)]]),
    fetch: async (_url, init) => {
      calls += 1;
      assert.match(JSON.parse(init.body).params[0].data, /^0x8b3ee973(b0){32}$/);
      return { ok: true, status: 200, json: async () => ({ result }) };
    },
  });
  const quote = { quoteMode: "FIRM_BONDED" as const, solverId: "solver-a", performanceBondId: "b0".repeat(32), validUntilValue: 4_000n, solverFee: { atoms: 10n }, protocolFee: { atoms: 0n } };
  const ledger = await reader("b0".repeat(32));
  assert.ok(ledger !== undefined);
  assert.deepEqual(verifyQuoteBond(quote, ledger), { backed: true });
  result = state(1_000n, false);
  assert.deepEqual(verifyQuoteBond(quote, (await reader("b0".repeat(32)))!), { backed: false, violations: ["BOND_EXHAUSTED"] });
  result = state(0n, true);
  assert.deepEqual(verifyQuoteBond(quote, (await reader("b0".repeat(32)))!), { backed: false, violations: ["BOND_RELEASED"] });
  result = `0x${word(0).repeat(11)}`;
  assert.equal(await reader("b0".repeat(32)), undefined, "an unopened bond reads as none");
  assert.equal(calls, 4);
});
