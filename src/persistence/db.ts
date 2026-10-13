import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Works from both `src/persistence` (tsx/vitest) and `dist/persistence` (built). */
export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/** Set the SQLCipher key; true if the file opens with it. */
function unlock(sqlite: Database.Database, key: string): boolean {
  sqlite.pragma("cipher = 'sqlcipher'");
  sqlite.pragma(`key = '${key}'`);
  try {
    sqlite.prepare('SELECT count(*) FROM sqlite_master').get();
    return true;
  } catch {
    return false;
  }
}

/** A database left unencrypted by an older version is encrypted in place, once. */
function encryptExisting(file: string, key: string): void {
  const plain = new Database(file);
  try {
    plain.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch {
    plain.close();
    throw new Error(`${file} cannot be opened with the stored data key (was OPERATOR_DATA_KEY changed or lost?)`);
  }
  plain.pragma('journal_mode = DELETE');
  plain.pragma("cipher = 'sqlcipher'");
  plain.pragma(`rekey = '${key}'`);
  plain.close();
}

/**
 * Open (and migrate) the SQLite database in WAL mode so jobs and approvals survive a crash.
 * With a key (always, outside tests) the whole file is encrypted (SQLCipher, AES-256).
 */
export function openDb(file: string, key?: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  let sqlite = new Database(file);
  if (key && file !== ':memory:' && !unlock(sqlite, key)) {
    sqlite.close();
    encryptExisting(file, key);
    sqlite = new Database(file);
    if (!unlock(sqlite, key)) throw new Error(`could not open ${file} after encrypting it`);
  }
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema }) as Db;
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

/** Run `fn` in a `BEGIN IMMEDIATE` transaction (takes the write lock up front). */
export function immediate<T>(db: Db, fn: () => T): T {
  return db.$client.transaction(fn).immediate();
}

export function json<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
