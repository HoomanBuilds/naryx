import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedTerminalOrigin, parseTerminalOrigins } from "../src/terminal-origin.js";

test("terminal origins accept one exact origin or an exact list, never a pattern or a path", () => {
  assert.equal(parseTerminalOrigins(undefined), null);
  assert.equal(parseTerminalOrigins("https://naryx.example"), "https://naryx.example");
  const list = parseTerminalOrigins("https://naryx.vercel.app, https://app.naryx.example");
  assert.ok(isAllowedTerminalOrigin(list, "https://app.naryx.example"));
  assert.ok(!isAllowedTerminalOrigin(list, "https://evil.example"));
  assert.ok(!isAllowedTerminalOrigin(null, "https://naryx.vercel.app"));
  for (const bad of ["https://*.vercel.app", "https://naryx.example/", "https://naryx.example/path", "ftp://naryx.example", "https://a.example,https://a.example"]) {
    assert.throws(() => parseTerminalOrigins(bad), /NARYX_TERMINAL_ORIGIN/);
  }
});
