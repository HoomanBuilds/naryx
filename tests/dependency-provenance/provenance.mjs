// Records, for every workspace lockfile, each resolved dependency's exact version, registry
// source, and integrity hash, and binds them in one digest. `--write` regenerates
// deployments/dependency-provenance.json; the default checks that every lockfile still matches it,
// so an unreviewed dependency change fails before anything is built or deployed.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(root, "deployments/dependency-provenance.json");
const workspaces = [
  "packages/protocol-types",
  "packages/adapter-core",
  "packages/sdk",
  "packages/adapters/evm",
  "packages/adapters/hyperliquid",
  "packages/adapters/solana",
  "services/api",
  "services/indexer",
  "services/keeper",
  "services/solver",
  "apps/web",
  "contracts/solana",
];

function workspaceRecord(workspace) {
  const lock = JSON.parse(readFileSync(join(root, workspace, "package-lock.json"), "utf8"));
  const packages = Object.entries(lock.packages ?? {})
    .filter(([path, entry]) => path.startsWith("node_modules/") && entry.link !== true)
    .map(([path, entry]) => ({ path, entry }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const unpinned = packages.filter(({ entry }) => entry.resolved?.startsWith("https://") && entry.integrity === undefined).map(({ path }) => path);
  // One line per package: install path, exact version, integrity, and whether it ships only for development.
  const lines = packages.map(({ path, entry }) => `${path.replace(/^node_modules\//, "")}@${entry.version ?? "local"} ${entry.integrity ?? "no-integrity"}${entry.dev === true ? " dev" : ""}`);
  return { workspace, lockfileVersion: lock.lockfileVersion, packageCount: packages.length, unpinned, packages: lines };
}

const records = workspaces.map(workspaceRecord);
const digest = createHash("sha256").update(JSON.stringify(records)).digest("hex");
const manifest = { manifestVersion: 1, digest, records };

if (process.argv.includes("--write")) {
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`wrote ${relative(root, output)} digest ${digest}\n`);
} else {
  const recorded = JSON.parse(readFileSync(output, "utf8"));
  const unpinned = records.flatMap((record) => record.unpinned.map((path) => `${record.workspace}:${path}`));
  if (recorded.digest !== digest) {
    const changed = records.filter((record) => JSON.stringify(record) !== JSON.stringify(recorded.records.find((entry) => entry.workspace === record.workspace))).map((record) => record.workspace);
    process.stderr.write(`dependency provenance changed in: ${changed.join(", ")}\nreview the change, then run with --write\n`);
    process.exit(1);
  }
  if (unpinned.length > 0) {
    process.stderr.write(`registry dependencies without an integrity hash: ${unpinned.join(", ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`dependency provenance matches ${digest}\n`);
}
