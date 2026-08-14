/**
 * The quota gate.
 *
 * Every YouTube call passes through here: reserve before spending, record after. Exhaustion
 * raises a `quota_exceeded` error, which the pipeline turns into a *deferred* item retried
 * after the next reset — never a dropped one.
 *
 * See docs/adr/0006-quota-strategy.md.
 */

import type { Config } from '../config.ts';
import { YouTubeError } from '../core/errors.ts';
import {
  nextQuotaReset,
  percentUsed,
  type QuotaState,
  quotaDate,
  remainingShares,
  remainingUnits,
} from '../core/quota.ts';
import type { Db } from '../db/index.ts';
import { addQuotaSpend, sumQuotaForDate } from '../db/repo.ts';
import type { Clock } from '../ports/clock.ts';
import type { QuotaRecorder } from '../ports/youtube.ts';

export interface QuotaService extends QuotaRecorder {
  state(): Promise<QuotaState>;
  summary(): Promise<QuotaSummary>;
  nextReset(): Date;
}

export interface QuotaSummary extends QuotaState {
  remaining: number;
  percentUsed: number;
  quotaDate: string;
  nextReset: Date;
  /** Units expressed as something a human can act on. */
  sharesLeft: { withLink: number; needingSearch: number };
}

export function createQuotaService(deps: {
  db: Db;
  config: Config;
  clock: Clock;
  accountId: string;
}): QuotaService {
  const { db, config, clock, accountId } = deps;

  function today(): string {
    return quotaDate(clock.now(), config.quota.resetTimeZone);
  }

  async function state(): Promise<QuotaState> {
    // Summed across all accounts: the 10,000-unit allowance belongs to the Google Cloud
    // project, so in MULTI mode everyone shares one pool.
    const spent = await sumQuotaForDate(db, today());
    return { spent, budget: config.quota.dailyBudget };
  }

  return {
    state,

    nextReset() {
      return nextQuotaReset(clock.now(), config.quota.resetTimeZone);
    },

    async summary(): Promise<QuotaSummary> {
      const current = await state();
      return {
        ...current,
        remaining: remainingUnits(current),
        percentUsed: percentUsed(current),
        quotaDate: today(),
        nextReset: nextQuotaReset(clock.now(), config.quota.resetTimeZone),
        sharesLeft: remainingShares(current),
      };
    },

    async reserve(operation: string, units: number): Promise<void> {
      const current = await state();
      if (current.spent + units <= current.budget) return;

      throw new YouTubeError(
        'quota_exceeded',
        `Daily YouTube quota budget reached: ${current.spent}/${current.budget} units used, ` +
          `${operation} needs ${units}. Work is queued until the next reset.`,
        { reason: 'quotaExceeded' },
      );
    },

    async record(_operation: string, units: number): Promise<void> {
      await addQuotaSpend(db, accountId, today(), units, clock.now().getTime());
    },
  };
}
