import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const programsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../programs");
const constantsPath = resolve(programsDir, "naryx_core/src/constants.rs");
// Same declaration shape that `anchor keys sync` rewrites.
const DECLARE_ID = /^(?:\w+::)*declare_id!\("(\w*)"\)/m;
const BASE58_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// naryx_core cannot import these IDs because both programs depend on naryx_core.
const CONSTANTS = [
  ["PACKAGE_BOOK_PROGRAM_ID", "naryx_package_book"],
  ["INVENTORY_RESERVATION_PROGRAM_ID", "naryx_inventory_reservation"],
];

function declaredId(program) {
  const source = readFileSync(resolve(programsDir, program, "src/lib.rs"), "utf8");
  const id = DECLARE_ID.exec(source)?.[1];
  if (id === undefined || !BASE58_ID.test(id)) {
    throw new Error(`${program} has no valid declare_id!`);
  }
  return id;
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error("Usage: node scripts/sync-core-program-ids.mjs [--check]");
}
const check = args[0] === "--check";

let source = readFileSync(constantsPath, "utf8");
const changes = [];
for (const [name, program] of CONSTANTS) {
  const pattern = new RegExp(`(pub const ${name}: Pubkey =\\s*pubkey!\\(")(\\w*)("\\))`, "g");
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${name} declaration`);
  const current = matches[0][2];
  const id = declaredId(program);
  if (current === id) continue;
  changes.push(`${name}: ${current} -> ${id} (${program})`);
  source = source.replace(pattern, (_, prefix, _current, suffix) => `${prefix}${id}${suffix}`);
}

for (const change of changes) process.stdout.write(`${change}\n`);
if (changes.length === 0) {
  process.stdout.write("Core cross-program IDs match declare_id!.\n");
} else if (check) {
  process.stderr.write("Core cross-program IDs are stale. Run node scripts/sync-core-program-ids.mjs.\n");
  process.exitCode = 1;
} else {
  writeFileSync(constantsPath, source);
  process.stdout.write(`Updated ${constantsPath}\n`);
}
