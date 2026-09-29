const validStatuses = new Set(["PASSED", "FAILED", "TIMED_OUT", "SKIPPED"]);

export function resultStatus(exitCode, timedOut) {
  if (timedOut) return "TIMED_OUT";
  return exitCode === 0 ? "PASSED" : "FAILED";
}

export function buildEvidence({
  commit,
  dirty,
  startedAt,
  finishedAt,
  results,
  skipped,
}) {
  const checks = [...results, ...skipped];
  for (const check of checks) {
    if (!validStatuses.has(check.status)) {
      throw new Error(`Invalid evidence status for ${check.id}`);
    }
  }
  for (const check of skipped) {
    if (check.status !== "SKIPPED" || typeof check.reason !== "string") {
      throw new Error(`Skipped evidence ${check.id} requires a reason`);
    }
  }
  return {
    schemaVersion: 1,
    evidenceClass: "NARYX_PHASE_10_LOCAL_DEMO_V1",
    networkPolicy: "LOCAL_ONLY_NO_PUBLIC_WRITES",
    commit,
    dirty,
    startedAt,
    finishedAt,
    status: results.every((result) => result.status === "PASSED")
      ? "PASSED"
      : "FAILED",
    checks,
  };
}
