import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const contractsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(contractsDir, "../../deployments/solana/program/idl");
const temporaryDir = mkdtempSync(join(tmpdir(), "naryx-program-idls-"));

const firmLockAccounts = [
  ["solver", true, true],
  ["config", false, false],
  ["reservation", false, false],
  ["reservation_class", false, false],
  ["quote_lock", false, true],
  ["system_program", false, false],
];

const firmEntryAccounts = [
  ["trader", true, true],
  ["config", false, false],
  ["solver_registry", false, false],
  ["risk_domain_index", false, false],
  ["risk_domain_record", false, false],
  ["solver", false, true],
  ["receipt", false, true],
  ["nonce_marker", false, true],
  ["open_package", false, true],
  ["executor_authority", false, false],
  ...[
    "spot_adapter_index",
    "perp_adapter_index",
    "spot_market_index",
    "perp_market_index",
    "spot_venue_index",
    "perp_venue_index",
    "base_asset_index",
    "quote_asset_index",
    "spot_adapter_record",
    "perp_adapter_record",
    "spot_market_record",
    "perp_market_record",
    "spot_venue_record",
    "perp_venue_record",
    "base_asset_record",
    "quote_asset_record",
  ].map((name) => [name, false, false]),
  ...[
    "reservation_program",
    "reservation_program_data",
    "core_program",
    "core_program_data",
    "reservation_class",
  ].map((name) => [name, false, false]),
  ...[
    "reservation_capacity",
    "reservation",
    "live_pair",
    "reservation_vault",
    "solver_quote",
    "trader_base",
    "trader_quote",
    "executor_base",
    "executor_quote",
  ].map((name) => [name, false, true]),
  ["quote_lock", false, true],
  ["series_index", false, false],
  ["series_record", false, false],
  ["perp_adapter_program", false, false],
  ["perp_adapter_program_data", false, false],
  ["perp_venue_program", false, false],
  ["perp_venue_program_data", false, false],
  ["rise_strategy", false, true],
  ["rise_log_authority", false, false],
  ...[
    "rise_global_config",
    "rise_trader_account",
    "rise_perp_asset_map",
    "rise_global_trader_index_header",
    "rise_active_trader_buffer_header",
    "rise_orderbook",
    "rise_spline_collection",
  ].map((name) => [name, false, true]),
  ["token_program", false, false],
  ["instructions_sysvar", false, false],
  ["system_program", false, false],
];

const publicExitAccounts = [
  ["trader", true, true],
  ["config", false, false],
  ["solver_registry", false, false],
  ["risk_domain_index", false, false],
  ["risk_domain_record", false, false],
  ["receipt", false, true],
  ["nonce_marker", false, true],
  ["open_package", false, true],
  ["entry_receipt", false, false],
  ["executor_authority", false, false],
  ...[
    "spot_adapter_index",
    "perp_adapter_index",
    "spot_market_index",
    "perp_market_index",
    "spot_venue_index",
    "perp_venue_index",
    "base_asset_index",
    "quote_asset_index",
    "spot_adapter_record",
    "perp_adapter_record",
    "spot_market_record",
    "perp_market_record",
    "spot_venue_record",
    "perp_venue_record",
    "base_asset_record",
    "quote_asset_record",
  ].map((name) => [name, false, false]),
  ...[
    "spot_adapter_program",
    "spot_adapter_program_data",
    "perp_adapter_program",
    "perp_adapter_program_data",
    "spot_venue_program",
    "spot_venue_program_data",
    "perp_venue_program",
    "perp_venue_program_data",
  ].map((name) => [name, false, false]),
  ...[
    "trader_token_a",
    "trader_token_b",
    "spot_vault_a",
    "spot_vault_b",
    "whirlpool",
    "tick_array_0",
    "tick_array_1",
    "tick_array_2",
    "whirlpool_oracle",
  ].map((name) => [name, false, true]),
  ["rise_strategy", false, true],
  ["rise_log_authority", false, false],
  ...[
    "rise_global_config",
    "rise_trader_account",
    "rise_perp_asset_map",
    "rise_global_trader_index_header",
    "rise_active_trader_buffer_header",
    "rise_orderbook",
    "rise_spline_collection",
  ].map((name) => [name, false, true]),
  ["token_program", false, false],
  ["instructions_sysvar", false, false],
  ["system_program", false, false],
];

function runAnchor(args) {
  const result = spawnSync("anchor", args, { cwd: contractsDir, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`anchor ${args.join(" ")} failed`);
}

function flattenAccounts(items) {
  return items.flatMap((item) =>
    "accounts" in item ? flattenAccounts(item.accounts) : [item],
  );
}

function requireNames(items, names, kind) {
  const actual = items.map((item) => item.name);
  if (actual.length !== names.length || actual.some((name, index) => name !== names[index])) {
    throw new Error(`Invalid ${kind} shape`);
  }
}

function requireAccountShape(instruction, expected, kind) {
  const actual = flattenAccounts(instruction.accounts);
  if (actual.length !== expected.length) throw new Error(`Invalid ${kind} account count`);
  for (const [index, [name, signer, writable]] of expected.entries()) {
    const account = actual[index];
    if (
      account.name !== name
      || (account.signer === true) !== signer
      || (account.writable === true) !== writable
    ) {
      throw new Error(`Invalid ${kind} account at index ${index}`);
    }
  }
}

try {
  runAnchor(["build", "-p", "naryx_core", "--ignore-keys", "--no-idl"]);
  const corePath = join(temporaryDir, "naryx_core.json");
  runAnchor(["idl", "build", "-p", "naryx_core", "-o", corePath, "--", "--lib"]);
  const core = JSON.parse(readFileSync(corePath, "utf8"));
  if (core.metadata?.name !== "naryx_core" || !core.address) {
    throw new Error("Invalid core program identity");
  }

  const firmLock = core.instructions.find((instruction) => instruction.name === "lock_firm_quote");
  const firmEntry = core.instructions.find((instruction) => instruction.name === "execute_firm_cash_and_carry");
  const publicExit = core.instructions.find((instruction) => instruction.name === "execute_cash_and_carry");
  if (!firmLock || !firmEntry || !publicExit) throw new Error("Missing cash-carry instructions");
  requireAccountShape(firmLock, firmLockAccounts, "firm lock");
  requireAccountShape(firmEntry, firmEntryAccounts, "firm entry");
  requireAccountShape(publicExit, publicExitAccounts, "public exit");
  requireNames(
    firmLock.args,
    ["order_hash", "quote_hash", "route_hash", "quote_args"],
    "firm lock argument",
  );
  requireNames(
    firmEntry.args,
    ["order_hash", "quote_hash", "route_hash", "args", "quote_args", "firm_quote_atoms"],
    "firm entry argument",
  );
  requireNames(
    publicExit.args,
    ["order_hash", "quote_hash", "route_hash", "args"],
    "public exit argument",
  );

  mkdirSync(outputDir, { recursive: true });
  copyFileSync(corePath, join(outputDir, "naryx_core.json"));
  process.stdout.write(`Published ABI-only core IDL ${core.address}\n`);
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
