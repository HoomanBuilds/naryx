// Online backup of every SQLite database under a data directory, safe while the services run:
// better-sqlite3's backup API copies a consistent snapshot of each database (WAL included). The
// keeper's JSON records (incident journals, the funding-mirror record) are copied as files; the
// keeper replaces each by an atomic rename, so a copy is always one complete version.
//
//   node deployments/aws/backup-sqlite.mjs <data-dir> <destination-dir>
import { createRequire } from 'node:module';
import { closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dataArgument, destinationArgument] = process.argv.slice(2);
if (dataArgument === undefined || destinationArgument === undefined) {
  process.stderr.write('usage: node backup-sqlite.mjs <data-dir> <destination-dir>\n');
  process.exit(2);
}
const dataDir = resolve(dataArgument);
const destination = resolve(destinationArgument);
if (destination === dataDir || destination.startsWith(dataDir + sep)) {
  throw new Error('Backup destination must be outside the data directory.');
}
process.umask(0o077);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const Database = createRequire(join(repository, 'services/api/package.json'))('better-sqlite3');

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const status = lstatSync(path);
    if (status.isSymbolicLink()) return [];
    if (status.isDirectory()) return files(path);
    return status.isFile() ? [path] : [];
  });
}

function isDatabase(path) {
  const descriptor = openSync(path, 'r');
  try {
    const header = Buffer.alloc(16);
    return readSync(descriptor, header, 0, 16, 0) === 16 && header.toString('ascii') === 'SQLite format 3\0';
  } finally { closeSync(descriptor); }
}

let failures = 0;
for (const source of files(dataDir)) {
  let db;
  try {
    const database = isDatabase(source);
    if (!database && !source.endsWith('.json')) continue;
    const target = join(destination, relative(dataDir, source));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (database) {
      db = new Database(source, { readonly: true, fileMustExist: true });
      await db.backup(target);
    } else copyFileSync(source, target);
    process.stdout.write(`backed up ${relative(dataDir, source)}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`failed ${relative(dataDir, source)}: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    db?.close();
  }
}
process.exit(failures === 0 ? 0 : 1);
