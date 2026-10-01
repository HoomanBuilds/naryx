import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Publishes the ABI-only IDLs for the Devnet test perp lane: the venue, its adapter, and the
// naryx_core build with the `devnet-test-perp` feature. The default core IDL is published by
// build-program-artifacts.mjs and is not touched here.
const contractsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(contractsDir, "../../deployments/solana/devnet/test-perp/idl");
const temporaryDir = mkdtempSync(join(tmpdir(), "naryx-test-perp-idls-"));

const testPerpAccounts = [
  "test_perp_market",
  "test_perp_position",
  "test_perp_oracle",
  "test_perp_collateral_vault",
  "test_perp_fee_vault",
  "test_perp_insurance_vault",
];

function runAnchor(args) {
  const result = spawnSync("anchor", args, { cwd: contractsDir, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`anchor ${args.join(" ")} failed`);
}

function flattenAccounts(items) {
  return items.flatMap((item) => ("accounts" in item ? flattenAccounts(item.accounts) : [item]));
}

function requireVenueSlice(instruction, kind) {
  const names = flattenAccounts(instruction.accounts).map((account) => account.name);
  const start = names.indexOf("rise_strategy");
  const slice = names.slice(start + 1, start + 1 + testPerpAccounts.length);
  if (start < 0 || slice.some((name, index) => name !== testPerpAccounts[index])) {
    throw new Error(`Invalid ${kind} test perp account shape`);
  }
  if (names.some((name) => name.startsWith("rise_") && name !== "rise_strategy")) {
    throw new Error(`${kind} still lists Rise venue accounts`);
  }
}

function buildIdl(program, file, extraCargoArgs = []) {
  const path = join(temporaryDir, file);
  runAnchor(["idl", "build", "-p", program, "-o", path, "--", "--lib", ...extraCargoArgs]);
  const idl = JSON.parse(readFileSync(path, "utf8"));
  if (idl.metadata?.name !== program || !idl.address) throw new Error(`Invalid ${program} identity`);
  return { idl, path };
}

try {
  const core = buildIdl("naryx_core", "naryx_core.devnet-test-perp.json", [
    "--features",
    "devnet-test-perp",
  ]);
  for (const name of ["execute_firm_cash_and_carry", "execute_cash_and_carry"]) {
    const instruction = core.idl.instructions.find((item) => item.name === name);
    if (!instruction) throw new Error(`Missing ${name}`);
    requireVenueSlice(instruction, name);
  }
  const venue = buildIdl("naryx_test_perp", "naryx_test_perp.json");
  const adapter = buildIdl("naryx_test_perp_adapter", "naryx_test_perp_adapter.json");

  mkdirSync(outputDir, { recursive: true });
  for (const { path } of [core, venue, adapter]) {
    copyFileSync(path, join(outputDir, path.split("/").pop()));
  }
  process.stdout.write(`Published Devnet test perp IDLs to ${outputDir}\n`);
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
