/**
 * The job worker.
 *
 * Two entry points, both draining the same table:
 *
 *  - `processOne` runs inline right after the ingest response (the fast path, so a share
 *    usually lands within a second of being made)
 *  - `sweep` runs from cron, catching anything the fast path did not finish and everything
 *    that was deliberately deferred
 *
 * Nothing depends on the fast path succeeding: the durable row is written before the response,
 * so a killed isolate or a crashed process loses no work.
 */

import type { Config } from '../config.ts';
import { nextQuotaReset } from '../core/quota.ts';
import type { Db } from '../db/index.ts';
import {
  claimNextJob,
  failJob,
  finishJob,
  listAccountsNeedingKeepAlive,
  parkJob,
  pruneOAuthStates,
  pruneRateLimits,
  rescheduleJob,
} from '../db/repo.ts';
import type { Job } from '../db/schema.ts';
import type { Clock } from '../ports/clock.ts';
import type { Logger } from '../ports/logger.ts';
import type { TokenService } from '../services/tokens.ts';
import { type ResolveDeps, resolveItem } from './resolve.ts';

/** How long a claimed job is leased before another worker may reclaim it. */
const LEASE_MS = 2 * 60 * 1000;

/** Retries before a job is marked failed. Deliberately small — this is not a batch system. */
const MAX_ATTEMPTS = 5;

/** Exponential backoff, capped so a retry never lands further away than an hour. */
function backoffMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 2 ** Math.max(0, attempts - 1) * 15_000);
}

export interface WorkerDeps extends ResolveDeps {
  tokens: TokenService;
  /** Rebuilds per-account dependencies, since the YouTube client is account-scoped. */
  forAccount(accountId: string): Promise<ResolveDeps>;
}

export interface SweepResult {
  claimed: number;
  settled: number;
  deferred: number;
  parked: number;
  retried: number;
  failed: number;
}

export async function processJob(deps: WorkerDeps, job: Job): Promise<keyof SweepResult> {
  const { db, clock, logger } = deps;
  const now = clock.now().getTime();

  if (job.kind === 'token_keepalive') {
    if (!job.accountId) {
      await finishJob(db, job.id, now);
      return 'settled';
    }
    const outcome = await deps.tokens.touch(job.accountId);
    await finishJob(db, job.id, now);
    return outcome === 'ok' ? 'settled' : 'parked';
  }

  if (!job.itemId) {
    await failJob(db, job.id, 'resolve_item job has no itemId', now);
    return 'failed';
  }

  // The YouTube client, quota recorder, and token service are all account-scoped, so
  // dependencies are rebuilt per job rather than shared.
  const scoped = job.accountId ? await deps.forAccount(job.accountId) : deps;
  const outcome = await resolveItem(scoped, job.itemId);

  switch (outcome.kind) {
    case 'settled':
      await finishJob(db, job.id, now);
      return 'settled';

    case 'deferred': {
      // Retry after the quota resets, and do *not* consume an attempt: running out of quota
      // is not a failure of this job, and letting it burn attempts would eventually mark a
      // perfectly good share as permanently failed for accounting reasons.
      const retryAt = nextQuotaReset(clock.now(), deps.config.quota.resetTimeZone).getTime();
      await rescheduleJob(db, job.id, retryAt, now, {
        error: outcome.reason,
        consumeAttempt: false,
      });
      logger.info('job deferred until quota reset', {
        jobId: job.id,
        retryAt: new Date(retryAt).toISOString(),
      });
      return 'deferred';
    }

    case 'parked':
      // Held indefinitely, released by TokenService.onReauthorised. Nothing is lost.
      await parkJob(db, job.id, outcome.reason, now);
      return 'parked';

    case 'retry': {
      if (job.attempts >= MAX_ATTEMPTS) {
        await failJob(db, job.id, outcome.reason, now);
        logger.error('job exhausted its retries', {
          jobId: job.id,
          attempts: job.attempts,
          reason: outcome.reason,
        });
        return 'failed';
      }
      const delay = backoffMs(job.attempts);
      await rescheduleJob(db, job.id, now + delay, now, { error: outcome.reason });
      logger.warn('job retrying after backoff', {
        jobId: job.id,
        attempts: job.attempts,
        delayMs: delay,
      });
      return 'retried';
    }
  }
}

/** Claim and process a single due job. Returns false when there was nothing to do. */
export async function processOne(deps: WorkerDeps): Promise<boolean> {
  const job = await claimNextJob(deps.db, deps.clock.now().getTime(), LEASE_MS);
  if (!job) return false;
  await processJob(deps, job);
  return true;
}

/**
 * Drain the queue, bounded.
 *
 * `maxJobs` keeps a single invocation inside a Worker's CPU and wall-clock limits; whatever is
 * left is picked up by the next tick a minute later.
 */
export async function sweep(deps: WorkerDeps, maxJobs = 25): Promise<SweepResult> {
  const result: SweepResult = {
    claimed: 0,
    settled: 0,
    deferred: 0,
    parked: 0,
    retried: 0,
    failed: 0,
  };

  for (let i = 0; i < maxJobs; i += 1) {
    const job = await claimNextJob(deps.db, deps.clock.now().getTime(), LEASE_MS);
    if (!job) break;
    result.claimed += 1;
    try {
      const outcome = await processJob(deps, job);
      result[outcome] += 1;
    } catch (error) {
      // A throw here is a bug in the worker rather than an expected failure, so the job is
      // rescheduled rather than lost while the cause gets logged loudly.
      deps.logger.error('worker threw while processing a job', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await rescheduleJob(
        deps.db,
        job.id,
        deps.clock.now().getTime() + backoffMs(job.attempts),
        deps.clock.now().getTime(),
        { error: error instanceof Error ? error.message : String(error) },
      );
      result.retried += 1;
    }
  }

  return result;
}

/**
 * The daily maintenance pass.
 *
 * Touches idle tokens so none sits unused long enough to hit Google's six-month
 * invalidation, and — just as importantly — surfaces a revoked token within a day rather
 * than at the moment the user next expects a share to land.
 */
export async function runDailyMaintenance(deps: {
  db: Db;
  config: Config;
  clock: Clock;
  logger: Logger;
  tokens: TokenService;
}): Promise<{ touched: number; needingReauth: number }> {
  const now = deps.clock.now().getTime();

  // Anything not refreshed in the last 12 hours.
  const stale = await listAccountsNeedingKeepAlive(deps.db, now - 12 * 60 * 60 * 1000);

  let touched = 0;
  let needingReauth = 0;
  for (const account of stale) {
    const outcome = await deps.tokens.touch(account.id);
    if (outcome === 'ok') touched += 1;
    else needingReauth += 1;
  }

  await pruneRateLimits(deps.db, now - 60 * 60 * 1000);
  await pruneOAuthStates(deps.db, now);

  deps.logger.info('daily maintenance complete', { touched, needingReauth });
  return { touched, needingReauth };
}
