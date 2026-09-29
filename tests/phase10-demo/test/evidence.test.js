import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidence, resultStatus } from "../src/evidence.js";

test("aggregates required results without upgrading skipped checks", () => {
  assert.equal(resultStatus(0, false), "PASSED");
  assert.equal(resultStatus(1, false), "FAILED");
  assert.equal(resultStatus(null, true), "TIMED_OUT");

  const evidence = buildEvidence({
    commit: "abc123",
    dirty: false,
    startedAt: "2026-09-29T00:00:00.000Z",
    finishedAt: "2026-09-29T00:00:01.000Z",
    results: [{ id: "local", status: "PASSED", exitCode: 0 }],
    skipped: [{ id: "public", status: "SKIPPED", reason: "credentials" }],
  });

  assert.equal(evidence.status, "PASSED");
  assert.deepEqual(
    evidence.checks.map((check) => check.status),
    ["PASSED", "SKIPPED"],
  );
});

test("fails the aggregate when a required command fails", () => {
  const evidence = buildEvidence({
    commit: "abc123",
    dirty: false,
    startedAt: "2026-09-29T00:00:00.000Z",
    finishedAt: "2026-09-29T00:00:01.000Z",
    results: [{ id: "local", status: "FAILED", exitCode: 1 }],
    skipped: [],
  });
  assert.equal(evidence.status, "FAILED");
});
