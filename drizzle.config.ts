import { defineConfig } from 'drizzle-kit';

/**
 * Migration generation only. Applying them differs per target — `wrangler d1 migrations
 * apply` on Cloudflare, and automatically at boot on the Node path — but both consume the
 * same generated SQL from `drizzle/`.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
