import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const BUSY_TIMEOUT_MS = 5_000;

function repositoryRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Opens a durable SQLite database: an absolute path outside the repository checkout, WAL
 * journaling, full synchronous writes, and enforced foreign keys. It throws through `fail` so each
 * store reports errors in its own vocabulary.
 */
export function openDurableDatabase(dbPath: string, schemaSql: string, fail: (code: string, message: string) => Error): Database.Database {
  if (typeof dbPath !== "string" || dbPath.length === 0 || dbPath === ":memory:" || !isAbsolute(dbPath)) {
    throw fail("INVALID_PATH", "Database path must be an absolute durable file path.");
  }
  const resolved = resolve(dbPath);
  const root = repositoryRoot();
  if (root !== undefined && (resolved === resolve(root) || resolved.startsWith(resolve(root) + sep))) {
    throw fail("INVALID_PATH", "Database path must remain outside the repository checkout.");
  }
  mkdirSync(dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  try {
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const journalMode = db.pragma("journal_mode = WAL", { simple: true });
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    if (String(journalMode).toLowerCase() !== "wal" || db.pragma("foreign_keys", { simple: true }) !== 1) {
      throw fail("PRAGMA_FAILED", "Durability pragmas were not applied.");
    }
    db.exec(schemaSql);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
