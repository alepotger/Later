/**
 * Database wiring.
 *
 * One schema, one dialect, two drivers. The `Db` type below is deliberately the *common*
 * Drizzle base type across sync and async drivers: Drizzle query builders are `PromiseLike`,
 * so `await db.select()...` works identically against D1 (async) and a local SQLite file
 * (sync). That is what lets every query in `repo.ts` be written once.
 *
 * See docs/adr/0003-sqlite-dialect-everywhere-drizzle.md.
 */

import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

/**
 * The shared database handle.
 *
 * Only the SQL builder API is used — no Drizzle relational queries — so the schema does
 * not need to be threaded through this type.
 */
export type Db = BaseSQLiteDatabase<'sync' | 'async', unknown>;

export * as schema from './schema.ts';
