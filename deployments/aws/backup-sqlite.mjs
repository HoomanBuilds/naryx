// Online backup of every SQLite database under a data directory, safe while the services run:
// better-sqlite3's backup API copies a consistent snapshot of each database (WAL included). The
// keeper's JSON records (incident journals, the funding-mirror record) are copied as files; the
// keeper replaces each by an atomic rename, so a copy is always one complete version.
//
//   node deployments/aws/backup-sqlite.mjs <data-dir> <destination-dir>
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dataArgument, destinationArgument] = process.argv.slice(2);
if (dataArgument === undefined || destinationArgument === undefined) {
  process.stderr.write('usage: node backup-sqlite.mjs <data-dir> <destination-dir>\n');
  process.exit(2);
}
const dataDir = resolve(dataArgument);
const destination = resolve(destinationArgument);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const Database = createRequire(join(repository, 'services/api/package.json'))('better-sqlite3');

function files(directory, extension) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return files(path, extension);
    return name.endsWith(extension) ? [path] : [];
  });
}

let failures = 0;
for (const source of files(dataDir, '.json')) {
  const target = join(destination, relative(dataDir, source));
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    copyFileSync(source, target);
    process.stdout.write(`backed up ${relative(dataDir, source)}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`failed ${relative(dataDir, source)}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
for (const source of files(dataDir, '.db')) {
  const target = join(destination, relative(dataDir, source));
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const db = new Database(source, { fileMustExist: true });
  try {
    await db.backup(target);
    process.stdout.write(`backed up ${relative(dataDir, source)}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`failed ${relative(dataDir, source)}: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    db.close();
  }
}
process.exit(failures === 0 ? 0 : 1);
