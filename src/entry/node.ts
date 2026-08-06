/**
 * Node entry point — the self-host path.
 *
 * Thin by design: everything meaningful is shared with the Worker entry. This file owns
 * exactly three things a Worker does not have — a filesystem-backed database, an internal
 * scheduler, and a process to keep alive.
 */

import { serve } from '@hono/node-server';
import { formatConfigProblems, parseConfig } from '../config.ts';
import { migrateNodeDb, openNodeDb } from '../db/node.ts';
import { createApp } from '../http/app.ts';
import { runDailyMaintenance, sweep } from '../pipeline/worker.ts';
import { createLogger } from '../ports/logger.ts';
import { buildRuntime } from '../runtime.ts';

const SWEEP_INTERVAL_MS = 60_000;
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const result = parseConfig(process.env);

  // Config problems are printed before anything else and stop the process. A stranger with a
  // half-filled .env is this project's most common failure state, so the message has to be
  // the first thing they see and has to say what to do.
  const problems = formatConfigProblems(result);
  if (problems !== '') console.error(problems);
  if (!result.ok) process.exit(1);

  const { config } = result;
  const logger = createLogger({ level: config.logLevel });

  const { db, close } = openNodeDb(config.databasePath);
  migrateNodeDb(db);
  logger.info('database ready', { path: config.databasePath });

  const runtime = await buildRuntime({ config, db, logger });
  const app = createApp(runtime);

  const port = Number(process.env.PORT ?? new URL(config.publicBaseUrl).port ?? 3000) || 3000;

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info('later is listening', {
      port: info.port,
      mode: config.mode,
      publicBaseUrl: config.publicBaseUrl,
      useFixtures: config.useFixtures,
    });
    console.log(`\n  Later is running.  →  ${config.publicBaseUrl}\n`);
  });

  // The internal scheduler stands in for Cloudflare Cron Triggers. Same job table, same
  // functions — only the thing pulling the lever differs.
  const sweepTimer = setInterval(() => {
    void (async () => {
      try {
        const worker = await runtime.worker();
        const outcome = await sweep(worker);
        if (outcome.claimed > 0) logger.info('sweep', { ...outcome });
      } catch (error) {
        logger.error('sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, SWEEP_INTERVAL_MS);

  const maintenanceTimer = setInterval(() => {
    void (async () => {
      try {
        await runDailyMaintenance({
          db,
          config,
          clock: runtime.clock,
          logger,
          tokens: runtime.tokens,
        });
      } catch (error) {
        logger.error('maintenance failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, MAINTENANCE_INTERVAL_MS);

  // Unref so the timers never hold the process open on their own during shutdown.
  sweepTimer.unref?.();
  maintenanceTimer.unref?.();

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    clearInterval(sweepTimer);
    clearInterval(maintenanceTimer);
    server.close(() => {
      close();
      process.exit(0);
    });
    // Do not hang forever if a connection refuses to close.
    setTimeout(() => process.exit(0), 5000).unref?.();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
