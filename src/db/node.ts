/**
 * Node / self-host driver: a local SQLite file.
 *
 * Only imported from the Node entry point and from tests, never from shared code — this is
 * the one place `node:` APIs and a native module are allowed.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './index.ts';

export interface NodeDb {
  db: Db;
  close(): void;
}

export function openNodeDb(path: string): NodeDb {
  const isMemory = path === ':memory:';

  if (!isMemory) {
    const absolute = resolve(path);
    const dir = dirname(absolute);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(isMemory ? ':memory:' : resolve(path));

  // WAL gives us concurrent reads alongside a writer, which matters because the cron sweep
  // and an inbound ingest can overlap. Not applicable to in-memory databases.
  if (!isMemory) sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // Wait rather than fail immediately if the sweep and a request collide on the writer.
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite) as unknown as Db;
  return { db, close: () => sqlite.close() };
}

/**
 * Apply migrations.
 *
 * Runs automatically at boot on the Node path so a self-hoster never has to think about
 * it; the Cloudflare path applies them in the deploy script instead.
 */
export function migrateNodeDb(db: Db, migrationsFolder = 'drizzle'): void {
  migrate(db as never, { migrationsFolder });
}
