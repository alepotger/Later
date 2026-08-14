import { describe, expect, it } from 'vitest';
import {
  COST_SEARCH_PATH,
  COST_TIER0_PATH,
  canSpend,
  nextQuotaReset,
  percentUsed,
  QUOTA_COSTS,
  quotaDate,
  remainingShares,
  remainingUnits,
} from '../../src/core/quota.ts';

const PACIFIC = 'America/Los_Angeles';

describe('quota costs', () => {
  it('matches the verified published costs', () => {
    expect(QUOTA_COSTS['videos.list']).toBe(1);
    expect(QUOTA_COSTS['playlistItems.list']).toBe(1);
    expect(QUOTA_COSTS['playlists.list']).toBe(1);
    expect(QUOTA_COSTS['playlistItems.insert']).toBe(50);
    expect(QUOTA_COSTS['playlists.insert']).toBe(50);
    expect(QUOTA_COSTS['search.list']).toBe(100);
  });

  it('prices the two pipeline paths at 51 and 151 units', () => {
    expect(COST_TIER0_PATH).toBe(51);
    expect(COST_SEARCH_PATH).toBe(151);
  });

  it('makes searching nearly three times the price of a link', () => {
    expect(COST_SEARCH_PATH / COST_TIER0_PATH).toBeGreaterThan(2.9);
  });
});

describe('budget arithmetic', () => {
  it('reports what is left', () => {
    expect(remainingUnits({ spent: 1000, budget: 9000 })).toBe(8000);
  });

  it('never reports a negative remainder', () => {
    expect(remainingUnits({ spent: 9999, budget: 9000 })).toBe(0);
  });

  it('permits a spend that exactly reaches the budget', () => {
    expect(canSpend({ spent: 8949, budget: 9000 }, 51)).toBe(true);
  });

  it('refuses a spend that would exceed the budget', () => {
    expect(canSpend({ spent: 8950, budget: 9000 }, 51)).toBe(false);
  });

  it('translates units into something a human can act on', () => {
    expect(remainingShares({ spent: 0, budget: 9000 })).toEqual({
      withLink: 176,
      needingSearch: 59,
    });
  });

  it('reports percentage used', () => {
    expect(percentUsed({ spent: 4500, budget: 9000 })).toBe(50);
    expect(percentUsed({ spent: 99999, budget: 9000 })).toBe(100);
  });
});

describe('quota day boundaries', () => {
  it('uses the reset time zone, not UTC', () => {
    // 06:59 UTC on 6 August is already 6 August in UTC but still 23:59 on 5 August in
    // Pacific. Using UTC would refill the budget up to eight hours early.
    const at = new Date('2026-08-06T06:59:00Z');
    expect(quotaDate(at, 'UTC')).toBe('2026-08-06');
    expect(quotaDate(at, PACIFIC)).toBe('2026-08-05');
  });

  it('rolls over exactly at Pacific midnight, not a minute either side', () => {
    // 07:00Z is precisely midnight PDT, which makes it the first instant of the new
    // quota day. Worth pinning: an off-by-one here silently shifts every budget window.
    expect(quotaDate(new Date('2026-08-06T06:59:59Z'), PACIFIC)).toBe('2026-08-05');
    expect(quotaDate(new Date('2026-08-06T07:00:00Z'), PACIFIC)).toBe('2026-08-06');
  });

  it('formats as YYYY-MM-DD', () => {
    expect(quotaDate(new Date('2026-01-02T20:00:00Z'), PACIFIC)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('finds the next Pacific midnight', () => {
    const at = new Date('2026-08-06T20:00:00Z'); // 13:00 Pacific (PDT, UTC-7)
    const reset = nextQuotaReset(at, PACIFIC);
    expect(reset.toISOString()).toBe('2026-08-07T07:00:00.000Z');
    expect(reset.getTime()).toBeGreaterThan(at.getTime());
  });

  it('always returns a moment in the future', () => {
    for (const iso of [
      '2026-08-06T06:59:00Z',
      '2026-08-06T07:00:00Z',
      '2026-08-06T07:01:00Z',
      '2026-01-01T00:00:00Z',
      '2026-12-31T23:59:00Z',
    ]) {
      const at = new Date(iso);
      expect(nextQuotaReset(at, PACIFIC).getTime()).toBeGreaterThan(at.getTime());
    }
  });

  it('lands on a real day boundary across the spring DST transition', () => {
    // US DST began 8 March 2026. The offset in effect when we ask differs from the offset
    // at the moment we are asking about, which is what the two-pass lookup handles.
    const at = new Date('2026-03-07T20:00:00Z');
    const reset = nextQuotaReset(at, PACIFIC);
    expect(quotaDate(new Date(reset.getTime() + 1000), PACIFIC)).toBe('2026-03-08');
    expect(quotaDate(new Date(reset.getTime() - 1000), PACIFIC)).toBe('2026-03-07');
  });

  it('lands on a real day boundary across the autumn DST transition', () => {
    const at = new Date('2026-10-31T20:00:00Z');
    const reset = nextQuotaReset(at, PACIFIC);
    expect(quotaDate(new Date(reset.getTime() + 1000), PACIFIC)).toBe('2026-11-01');
    expect(quotaDate(new Date(reset.getTime() - 1000), PACIFIC)).toBe('2026-10-31');
  });

  it('works for a zone ahead of UTC', () => {
    const at = new Date('2026-08-06T20:00:00Z');
    const reset = nextQuotaReset(at, 'Asia/Tokyo');
    expect(quotaDate(new Date(reset.getTime() + 1000), 'Asia/Tokyo')).toBe('2026-08-08');
  });
});
