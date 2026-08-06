/**
 * Cloudflare Workers entry point — the primary deploy target.
 *
 * Two handlers: `fetch` serves requests, `scheduled` drains the job queue from Cron Triggers.
 * Both build the same runtime over the same D1-backed database, and neither contains any
 * application logic of its own.
 */

import type { D1Database, ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { formatConfigProblems, parseConfig } from '../config.ts';
import { openD1 } from '../db/d1.ts';
import { createApp } from '../http/app.ts';
import { runDailyMaintenance, sweep } from '../pipeline/worker.ts';
import { createLogger } from '../ports/logger.ts';
import { buildRuntime } from '../runtime.ts';

export interface WorkerEnv extends Record<string, string | undefined | D1Database> {
  DB: D1Database;
}

/** Cron expression that drives the daily maintenance pass, matched against in `scheduled`. */
const DAILY_CRON = '0 4 * * *';

function configure(env: WorkerEnv) {
  // A Worker has no process.env; bindings arrive per request, so config is parsed per
  // invocation. Cheap, and it means a changed secret takes effect without a redeploy.
  const result = parseConfig(env as Record<string, string | undefined>);
  return result;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const result = configure(env);
    if (!result.ok) {
      // Returned as text rather than logged only, because on a fresh deploy this page *is*
      // the error message the deployer will see.
      return new Response(formatConfigProblems(result), {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const logger = createLogger({ level: result.config.logLevel });
    for (const warning of result.warnings) logger.warn(warning);

    const runtime = await buildRuntime({
      config: result.config,
      db: openD1(env.DB),
      logger,
      waitUntil: (promise) => ctx.waitUntil(promise),
    });

    return await createApp(runtime).fetch(request);
  },

  async scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const result = configure(env);
    if (!result.ok) {
      console.error(formatConfigProblems(result));
      return;
    }

    const { config } = result;
    const logger = createLogger({ level: config.logLevel });
    const db = openD1(env.DB);
    const runtime = await buildRuntime({
      config,
      db,
      logger,
      waitUntil: (promise) => ctx.waitUntil(promise),
    });

    if (controller.cron === DAILY_CRON) {
      await runDailyMaintenance({
        db,
        config,
        clock: runtime.clock,
        logger,
        tokens: runtime.tokens,
      });
      return;
    }

    const worker = await runtime.worker();
    const outcome = await sweep(worker);
    if (outcome.claimed > 0) logger.info('sweep', { ...outcome });
  },
};
