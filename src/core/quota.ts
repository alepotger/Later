/**
 * Quota arithmetic — pure, and the reason the pipeline is ordered the way it is.
 *
 * A Google Cloud project gets 10,000 units/day for the YouTube Data API, resetting at
 * midnight Pacific. Costs are wildly uneven: one search costs as much as a hundred video
 * lookups. Verified 2026-08-05, see docs/verification-log.md.
 */

/**
 * Unit costs per operation.
 *
 * Hardcoded from Google's published quota calculator. If Google reprices, this table and
 * the verification log are the two places to update — the ~10% default budget reserve
 * exists partly to absorb the drift until someone notices.
 */
export const QUOTA_COSTS = {
  'videos.list': 1,
  'playlists.list': 1,
  'playlistItems.list': 1,
  'channels.list': 1,
  'playlists.insert': 50,
  'playlistItems.insert': 50,
  'playlistItems.delete': 50,
  'search.list': 100,
} as const;

export type YouTubeOperation = keyof typeof QUOTA_COSTS;

export function costOf(operation: YouTubeOperation): number {
  return QUOTA_COSTS[operation];
}

/** A share that already contains a YouTube URL: validate, then insert. */
export const COST_TIER0_PATH = QUOTA_COSTS['videos.list'] + QUOTA_COSTS['playlistItems.insert'];

/** A share that has to be searched for: search, validate, insert. Nearly 3x the price. */
export const COST_SEARCH_PATH = QUOTA_COSTS['search.list'] + COST_TIER0_PATH;

export interface QuotaState {
  /** Units already spent in the current quota day, across the whole instance. */
  spent: number;
  /** Later's own budget, deliberately below Google's hard limit. */
  budget: number;
}

export function remainingUnits(state: QuotaState): number {
  return Math.max(0, state.budget - state.spent);
}

export function canSpend(state: QuotaState, units: number): boolean {
  return state.spent + units <= state.budget;
}

export function percentUsed(state: QuotaState): number {
  if (state.budget <= 0) return 100;
  return Math.min(100, Math.round((state.spent / state.budget) * 100));
}

/**
 * How many more shares of each shape today's remaining budget allows.
 *
 * Surfaced in the UI because "3,200 units left" means nothing to anyone, whereas
 * "about 62 more links" is immediately actionable.
 */
export function remainingShares(state: QuotaState): { withLink: number; needingSearch: number } {
  const left = remainingUnits(state);
  return {
    withLink: Math.floor(left / COST_TIER0_PATH),
    needingSearch: Math.floor(left / COST_SEARCH_PATH),
  };
}

/**
 * The quota day as `YYYY-MM-DD` in the given time zone.
 *
 * Must not be UTC. Google resets at midnight Pacific, so a UTC day boundary would refill
 * the budget at the wrong moment — and the "retry after reset" job would fire up to eight
 * hours before quota actually came back.
 */
export function quotaDate(at: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the key format we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** The UTC offset, in milliseconds, in effect in `timeZone` at `date`. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour') % 24,
    field('minute'),
    field('second'),
  );
  return asIfUtc - date.getTime();
}

/**
 * When the quota next resets — midnight in the reset time zone.
 *
 * Uses two offset lookups rather than one so that the answer stays correct across a DST
 * transition, where the offset at the moment we are asking differs from the offset at the
 * moment we are asking about.
 */
export function nextQuotaReset(at: Date, timeZone: string): Date {
  const [year, month, day] = quotaDate(at, timeZone).split('-').map(Number);
  const nextLocalMidnightAsUtc = Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + 1, 0, 0, 0);

  let instant = nextLocalMidnightAsUtc - zoneOffsetMs(new Date(nextLocalMidnightAsUtc), timeZone);
  instant = nextLocalMidnightAsUtc - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}
