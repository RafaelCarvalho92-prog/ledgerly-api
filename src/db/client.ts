/**
 * Database access: Drizzle ORM on top of Node's built-in `node:sqlite` (no native addon to
 * compile), through Drizzle's `sqlite-proxy` driver.
 *
 * Transactions: node:sqlite is synchronous but our handlers are async, so two requests could
 * interleave statements inside one BEGIN...COMMIT. `tx()` therefore holds an async lock for the
 * whole transaction, and every statement issued outside a transaction waits for that lock
 * (AsyncLocalStorage tells the two apart). Result: serializable transactions, no deadlocks.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema.js';

// Loaded with require(): Vite/Vitest 5 does not recognise the newer `node:sqlite` builtin in ESM imports.
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncType;

export type DB = SqliteRemoteDatabase<typeof schema>;

class Lock {
  private tail: Promise<void> = Promise.resolve();
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    return release;
  }
  /** Resolves when nobody holds the lock (used by statements outside transactions). */
  idle(): Promise<void> {
    return this.tail;
  }
}

type SqlValue = null | number | bigint | string | Uint8Array;

export interface Database {
  db: DB;
  sqlite: DatabaseSync;
  tx<T>(fn: () => Promise<T>): Promise<T>;
  ping(): boolean;
  close(): void;
}

export function openDatabase(url: string): Database {
  const sqlite = new DatabaseSync(url === ':memory:' ? ':memory:' : url);
  sqlite.exec('PRAGMA foreign_keys = ON;');
  if (url !== ':memory:') sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

  const lock = new Lock();
  const inTx = new AsyncLocalStorage<boolean>();

  const db = drizzle(
    async (sql, params, method) => {
      if (!inTx.getStore()) await lock.idle();
      const stmt = sqlite.prepare(sql);
      const args = params as SqlValue[];
      if (method === 'run') {
        stmt.run(...args);
        return { rows: [] };
      }
      // setReturnArrays exists since Node 22.16/24 (newer than the pinned @types/node).
      (stmt as unknown as { setReturnArrays(v: boolean): void }).setReturnArrays(true);
      if (method === 'get') {
        const row = stmt.get(...args) as unknown as unknown[] | undefined;
        return { rows: (row ?? undefined) as unknown as unknown[] };
      }
      return { rows: stmt.all(...args) as unknown as unknown[][] };
    },
    { schema },
  );

  return {
    db,
    sqlite,
    async tx<T>(fn: () => Promise<T>): Promise<T> {
      if (inTx.getStore()) return fn(); // nested: join the outer transaction
      const release = await lock.acquire();
      try {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const result = await inTx.run(true, fn);
          sqlite.exec('COMMIT');
          return result;
        } catch (err) {
          sqlite.exec('ROLLBACK');
          throw err;
        }
      } finally {
        release();
      }
    },
    ping() {
      return (sqlite.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined)?.ok === 1;
    },
    close() {
      sqlite.close();
    },
  };
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Applies pending SQL files from /migrations in order, each in its own transaction. */
export function migrate(database: Database, dir = MIGRATIONS_DIR): string[] {
  const { sqlite } = database;
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    (sqlite.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const pending = readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !applied.has(f))
    .sort();
  for (const file of pending) {
    sqlite.exec('BEGIN');
    try {
      sqlite.exec(readFileSync(`${dir}${file}`, 'utf8'));
      sqlite
        .prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return pending;
}
