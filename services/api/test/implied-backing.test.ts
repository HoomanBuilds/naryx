import assert from "node:assert/strict";
import { test } from "node:test";
import { impliedBackingAtoms } from "../src/implied-backing.js";

test("backing scales raw asset quantities into collateral atoms without under-reserving", () => {
  assert.equal(impliedBackingAtoms(5_000_000_000_000_000n, 1_000_000_000n, 10n ** 18n), 5_000_000n);
  assert.equal(impliedBackingAtoms(5_000_000_000_000_001n, 1_000_000_000n, 10n ** 18n), 5_000_001n);
  assert.equal(impliedBackingAtoms(1n, 1n, 10n ** 18n), 1n);
  assert.equal(impliedBackingAtoms(3n, 7n), 21n);
});

test("backing rejects invalid units and collateral overflow", () => {
  const maximum = (1n << 128n) - 1n;
  assert.equal(impliedBackingAtoms(maximum, maximum, maximum), maximum);
  for (const args of [[0n, 1n, 1n], [1n, -1n, 1n], [1n, 1n, 0n],
    [maximum + 1n, 1n, 1n], [1n, maximum + 1n, 1n], [1n, 1n, maximum + 1n],
    [maximum, 2n, 1n]] as const) {
    assert.throws(() => impliedBackingAtoms(args[0], args[1], args[2]), RangeError);
  }
});
