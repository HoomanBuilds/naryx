import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const contractsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(contractsDir, "../../deployments/solana/conformance/idl");
const temporaryDir = mkdtempSync(join(tmpdir(), "naryx-conformance-idls-"));

function buildIdl(program, output, cargoArgs) {
  runAnchor(["idl", "build", "-p", program, "-o", output, "--", ...cargoArgs]);
  return JSON.parse(readFileSync(output, "utf8"));
}

function runAnchor(args) {
  const result = spawnSync("anchor", args, { cwd: contractsDir, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`anchor ${args.join(" ")} failed`);
}

function requireNames(items, names, kind) {
  const present = new Set(items.map((item) => item.name));
  for (const name of names) {
    if (!present.has(name)) throw new Error(`Missing ${kind}: ${name}`);
  }
}

function requireExactNames(items, names, kind) {
  const actual = items.map((item) => item.name);
  if (actual.length !== names.length || actual.some((name, index) => name !== names[index])) {
    throw new Error(`Invalid ${kind} order: expected ${names.join(", ")}; received ${actual.join(", ")}`);
  }
}

try {
  runAnchor(["build", "-p", "naryx_conformance_venue", "--ignore-keys", "--no-idl"]);
  runAnchor(["build", "-p", "naryx_core", "--ignore-keys", "--no-idl", "--", "--features", "conformance"]);

  const corePath = join(temporaryDir, "naryx_core.json");
  const venuePath = join(temporaryDir, "naryx_conformance_venue.json");
  const core = buildIdl("naryx_core", corePath, ["--features", "conformance", "--lib"]);
  const venue = buildIdl("naryx_conformance_venue", venuePath, ["--lib"]);

  if (core.metadata?.name !== "naryx_core" || !core.address) {
    throw new Error("Invalid core program identity");
  }
  if (venue.metadata?.name !== "naryx_conformance_venue" || !venue.address) {
    throw new Error("Invalid conformance venue identity");
  }
  requireNames(core.instructions, ["execute_conformance_atomic"], "core instruction");
  requireNames(core.accounts, ["ConformanceExecutionReceipt", "ProtocolConfig"], "core account");
  requireNames(core.types, ["ConformanceAction", "ConformanceExecutionArgs", "ConformanceExecutionReceipt"], "core type");
  requireNames(venue.instructions, ["spot_buy_exact_output", "spot_sell_exact_input", "open_short_exact", "close_short_exact"], "venue instruction");
  requireNames(venue.accounts, ["MarketConfig", "PerpPosition"], "venue account");

  const execution = core.instructions.find((instruction) => instruction.name === "execute_conformance_atomic");
  requireExactNames(execution.accounts, [
    "trader",
    "config",
    "solver_registry",
    "receipt",
    "nonce_marker",
    "entry_receipt",
    "market",
    "position",
    "trader_base",
    "trader_quote",
    "spot_base_vault",
    "spot_quote_vault",
    "perp_quote_vault",
    "conformance_program",
    "token_program",
    "system_program",
    "instructions_sysvar",
  ], "execution account");
  requireExactNames(execution.args, ["order_hash", "quote_hash", "route_hash", "args"], "execution argument");
  const executionArgs = core.types.find((type) => type.name === "ConformanceExecutionArgs");
  requireExactNames(executionArgs.type.fields, [
    "action",
    "base_quantity_atoms",
    "spot_quote_limit_atoms",
    "collateral_quote_limit_atoms",
    "expiry_slot",
    "nonce",
    "entry_execution_digest",
    "expected_pre_short_base_atoms",
    "expected_pre_collateral_quote_atoms",
  ], "conformance execution argument field");
  const venueProgram = execution.accounts.find((account) => account.name === "conformance_program");
  if (venueProgram.address !== venue.address) {
    throw new Error("Core and conformance venue program identities differ");
  }

  mkdirSync(outputDir, { recursive: true });
  copyFileSync(corePath, join(outputDir, "naryx_core.json"));
  copyFileSync(venuePath, join(outputDir, "naryx_conformance_venue.json"));
  process.stdout.write(`Published ${core.address} and ${venue.address}\n`);
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
