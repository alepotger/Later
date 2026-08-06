/**
 * Time as an injected dependency.
 *
 * Quota days, token expiry, retry backoff, and rate-limit windows are all time-dependent,
 * and none of them should need a real clock to test. A test that has to sleep is a test
 * nobody runs.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock the tests can move by hand. */
export function fixedClock(start: Date | number): Clock & {
  set(at: Date | number): void;
  advance(ms: number): void;
} {
  let current = typeof start === 'number' ? start : start.getTime();
  return {
    now: () => new Date(current),
    set: (at) => {
      current = typeof at === 'number' ? at : at.getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}
