/**
 * Cloudflare driver: D1.
 *
 * D1 *is* SQLite, so this shares the schema, the migrations, and every query in `repo.ts`
 * with the Node path. Migrations are applied by `wrangler d1 migrations apply` in the
 * deploy script rather than at boot, because a Worker has no boot.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import type { Db } from './index.ts';

export function openD1(binding: D1Database): Db {
  return drizzle(binding as never) as unknown as Db;
}
