// Creates or extends the Devnet address lookup table that holds the fixed firm-entry accounts, and
// prints the `lookupTables` runtime manifest fragment the API materializer verifies live.
//
//   node scripts/devnet-lookup-table.mjs --cluster devnet --record /abs/initialize-record.json \
//     --payer /abs/payer.json --authority /abs/alt-authority.json [--table <address>] [--freeze] [--send]
//
// Dry run is the default. Existing tables are only extended with missing addresses; a table whose
// authority or existing contents differ from the expected prefix fails closed.
import anchor from "@anchor-lang/core";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  TOKEN_PROGRAM_ID,
  absolutePath,
  executeStep,
  loadKeypair,
  parseFlags,
  publicKey,
  requireDevnetCluster,
  requireDevnetGenesis,
  rpcUrl,
} from "./devnet-operator.mjs";

const { web3 } = anchor;
const EXTEND_BATCH = 20;
const MAX_TABLE_ADDRESSES = 256;

function text(value, name) {
  if (typeof value !== "string") throw new Error(`${name} is missing from the initialization record`);
  return publicKey(value, name).toBase58();
}

/**
 * Every account the firm entry and lock read that is the same for every trader: programs and their
 * ProgramData, protocol and registry PDAs, venue accounts, the solver's quote account, and sysvars.
 * Per-trader and per-order accounts never go in the table.
 */
export function fixedFirmAccounts(record) {
  const accounts = record.accounts ?? {};
  const fragment = record.fragments?.runtimeManifest ?? {};
  const solver = record.fragments?.solverConfig ?? {};
  const addresses = [];
  for (const program of fragment.programs ?? []) {
    addresses.push(text(program.programId, `${program.name} programId`), text(program.programDataAddress, `${program.name} programDataAddress`));
  }
  if (addresses.length !== 10) throw new Error("initialization record must carry the five reviewed programs");
  for (const name of [
    "config", "solverRegistry", "testPerpMarket", "collateralVault", "feeVault", "insuranceVault", "reservationClass",
    "packageBookClass", "packageBookShard", "packageBookLevelPage", "seriesIndex", "seriesRecord", "solverQuote",
  ]) {
    addresses.push(text(accounts[name], `accounts.${name}`));
  }
  for (const group of ["indexes", "records"]) {
    const values = accounts[group] ?? {};
    for (const name of ["spotAdapter", "perpAdapter", "spotMarket", "perpMarket", "spotVenue", "perpVenue", "baseAsset", "quoteAsset"]) {
      addresses.push(text(values[name], `accounts.${group}.${name}`));
    }
  }
  addresses.push(
    text(fragment.testPerp?.oracle, "testPerp.oracle"),
    text(solver.solverId, "solverId"),
    TOKEN_PROGRAM_ID.toBase58(),
    web3.SystemProgram.programId.toBase58(),
    web3.SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(),
  );
  const unique = [...new Set(addresses)];
  if (unique.length > MAX_TABLE_ADDRESSES) throw new Error("fixed account set exceeds one lookup table");
  return unique;
}

/** The addresses still missing from a live table, or a failure when its contents diverge. */
export function missingAddresses(existing, expected) {
  const known = new Set(expected);
  for (const address of existing) {
    if (!known.has(address)) throw new Error(`lookup table holds unexpected address ${address}`);
  }
  const present = new Set(existing);
  return expected.filter((address) => !present.has(address));
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), ["cluster", "rpc-url", "record", "payer", "authority", "table", "out"], ["send", "freeze"]);
  requireDevnetCluster(flags);
  const send = flags.send === true;
  const record = JSON.parse(readFileSync(absolutePath(flags.record, "--record"), "utf8"));
  if (record.cluster !== "solana-devnet") throw new Error("initialization record is not for solana-devnet");
  const payer = loadKeypair(flags.payer, "--payer");
  const authority = loadKeypair(flags.authority, "--authority");
  const connection = new web3.Connection(rpcUrl(flags), "confirmed");
  await requireDevnetGenesis(connection);
  const expected = fixedFirmAccounts(record);
  const steps = [];

  let table;
  let existing = [];
  if (flags.table !== undefined) {
    table = publicKey(flags.table, "--table");
    const live = (await connection.getAddressLookupTable(table, { commitment: "confirmed" })).value;
    if (live === null) throw new Error("--table does not exist");
    if (live.state.authority === undefined) {
      existing = live.state.addresses.map((key) => key.toBase58());
      if (missingAddresses(existing, expected).length !== 0) throw new Error("--table is frozen and incomplete");
    } else if (!live.state.authority.equals(authority.publicKey)) {
      throw new Error("--authority does not control --table");
    }
    existing = live.state.addresses.map((key) => key.toBase58());
  } else {
    const recentSlot = await connection.getSlot("finalized");
    const [instruction, address] = web3.AddressLookupTableProgram.createLookupTable({
      authority: authority.publicKey, payer: payer.publicKey, recentSlot,
    });
    table = address;
    steps.push({ name: "create", ...(await executeStep(connection, { label: "create lookup table", instructions: [instruction], signers: [authority] }, { payer, send })) });
    if (!send) {
      steps.push({ name: "extend", status: "PENDING_PRIOR_STEP", addresses: expected.length });
    }
  }

  const missing = missingAddresses(existing, expected);
  if (table !== undefined && (send || flags.table !== undefined)) {
    for (let offset = 0; offset < missing.length; offset += EXTEND_BATCH) {
      const batch = missing.slice(offset, offset + EXTEND_BATCH).map((address) => new web3.PublicKey(address));
      const instruction = web3.AddressLookupTableProgram.extendLookupTable({
        lookupTable: table, authority: authority.publicKey, payer: payer.publicKey, addresses: batch,
      });
      steps.push({ name: `extend.${offset / EXTEND_BATCH}`, ...(await executeStep(connection, { label: "extend lookup table", instructions: [instruction], signers: [authority] }, { payer, send })) });
      if (!send) break;
    }
  }
  if (flags.freeze === true && send) {
    const instruction = web3.AddressLookupTableProgram.freezeLookupTable({ lookupTable: table, authority: authority.publicKey });
    steps.push({ name: "freeze", ...(await executeStep(connection, { label: "freeze lookup table", instructions: [instruction], signers: [authority] }, { payer, send })) });
  }

  // The fragment lists the exact live order the program appended, which the materializer compares.
  const finalAddresses = send
    ? ((await connection.getAddressLookupTable(table, { commitment: "finalized" })).value?.state.addresses ?? []).map((key) => key.toBase58())
    : [...existing, ...missing];
  if (send && missingAddresses(finalAddresses, expected).length !== 0) throw new Error("lookup table is still incomplete; rerun with --table");
  const output = {
    schemaVersion: 1,
    cluster: "solana-devnet",
    mode: send ? "SEND" : "DRY_RUN",
    steps,
    fragments: { runtimeManifest: { lookupTables: [{ address: table.toBase58(), expectedAddresses: finalAddresses }] } },
  };
  const textOutput = `${JSON.stringify(output, null, 2)}\n`;
  if (flags.out !== undefined) writeFileSync(absolutePath(flags.out, "--out"), textOutput, { mode: 0o644 });
  process.stdout.write(textOutput);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
