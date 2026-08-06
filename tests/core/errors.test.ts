/**
 * Error classification.
 *
 * The reason this is tested carefully: `invalid_grant` and `quotaExceeded` must never be
 * mistaken for generic errors, because each drives a different behaviour and getting it wrong
 * is how a deployment fails silently. Google is inconsistent about where the useful signal
 * lives — HTTP status, `error.errors[].reason`, or a top-level `error` string on the OAuth
 * endpoints — so all three shapes are covered.
 */

import { describe, expect, it } from 'vitest';
import { parseIso8601Duration } from '../../src/adapters/youtube/google.ts';
import { classifyGoogleError, YouTubeError } from '../../src/core/errors.ts';

describe('invalid_grant', () => {
  it('is recognised from the OAuth endpoint shape', () => {
    const error = classifyGoogleError(400, {
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.',
    });
    expect(error.kind).toBe('invalid_grant');
  });

  it('is terminal — never retryable', () => {
    const error = classifyGoogleError(400, { error: 'invalid_grant' });
    expect(error.isRetryable).toBe(false);
  });

  it('is deferrable, because the work resumes after re-authorisation', () => {
    expect(classifyGoogleError(400, { error: 'invalid_grant' }).isDeferrable).toBe(true);
  });

  it('treats a 401 from the API as needing re-authorisation too', () => {
    const error = classifyGoogleError(401, {
      error: { message: 'Invalid Credentials', errors: [{ reason: 'authError' }] },
    });
    expect(error.kind).toBe('invalid_grant');
  });
});

describe('quota exhaustion', () => {
  for (const reason of [
    'quotaExceeded',
    'dailyLimitExceeded',
    'rateLimitExceeded',
    'userRateLimitExceeded',
  ]) {
    it(`recognises ${reason}`, () => {
      const error = classifyGoogleError(403, {
        error: { message: 'quota', errors: [{ reason }] },
      });
      expect(error.kind).toBe('quota_exceeded');
    });
  }

  it('recognises a bare 429', () => {
    expect(classifyGoogleError(429, {}).kind).toBe('quota_exceeded');
  });

  it('is deferrable but not retryable, so work is queued rather than hammered', () => {
    const error = classifyGoogleError(403, {
      error: { errors: [{ reason: 'quotaExceeded' }] },
    });
    expect(error.isDeferrable).toBe(true);
    expect(error.isRetryable).toBe(false);
  });
});

describe('other statuses', () => {
  it('maps 404 to not_found', () => {
    expect(classifyGoogleError(404, {}).kind).toBe('not_found');
  });

  it('maps a videoNotFound reason to not_found even on a 400', () => {
    expect(
      classifyGoogleError(400, { error: { errors: [{ reason: 'videoNotFound' }] } }).kind,
    ).toBe('not_found');
  });

  it('maps 403 to forbidden when it is not a quota problem', () => {
    expect(classifyGoogleError(403, { error: { errors: [{ reason: 'forbidden' }] } }).kind).toBe(
      'forbidden',
    );
  });

  it('maps 5xx to transient, and only that is retryable', () => {
    for (const status of [500, 502, 503, 504]) {
      const error = classifyGoogleError(status, {});
      expect(error.kind).toBe('transient');
      expect(error.isRetryable).toBe(true);
    }
  });

  it('maps an unrecognised 4xx to client_error — our bug, not the user’s', () => {
    const error = classifyGoogleError(400, { error: { message: 'Bad Request' } });
    expect(error.kind).toBe('client_error');
    expect(error.isRetryable).toBe(false);
  });
});

describe('message extraction', () => {
  it('prefers error_description from the OAuth endpoints', () => {
    expect(
      classifyGoogleError(400, { error: 'invalid_grant', error_description: 'Revoked.' }).message,
    ).toContain('invalid_grant');
  });

  it('uses error.message from the API endpoints', () => {
    expect(classifyGoogleError(404, { error: { message: 'Video not found.' } }).message).toBe(
      'Video not found.',
    );
  });

  it('falls back to the status when there is no body', () => {
    expect(classifyGoogleError(418, {}).message).toContain('418');
  });

  it('keeps Google’s reason string verbatim, because it is useful in logs', () => {
    expect(
      classifyGoogleError(403, { error: { errors: [{ reason: 'quotaExceeded' }] } }).reason,
    ).toBe('quotaExceeded');
  });

  it('does not throw on a malformed or non-object body', () => {
    for (const body of [null, undefined, 'a string', 42, [], { error: [] }]) {
      expect(() => classifyGoogleError(400, body)).not.toThrow();
    }
  });
});

describe('YouTubeError', () => {
  it('marks unwritable_playlist as neither retryable nor deferrable', () => {
    const error = new YouTubeError('unwritable_playlist', 'WL is not writable');
    expect(error.isRetryable).toBe(false);
    expect(error.isDeferrable).toBe(false);
  });

  it('preserves the cause for debugging', () => {
    const cause = new Error('socket hang up');
    expect(new YouTubeError('transient', 'network', { cause }).cause).toBe(cause);
  });
});

describe('parseIso8601Duration', () => {
  const cases: [string | undefined, number | null][] = [
    ['PT3M32S', 212],
    ['PT45S', 45],
    ['PT1H', 3600],
    ['PT1H2M3S', 3723],
    ['PT15M', 900],
    ['P1DT2H', 93600],
    ['PT4M13.5S', 254], // livestream durations can carry fractional seconds
    [undefined, null],
    ['', null],
    ['P', null],
    ['garbage', null],
    ['3M32S', null], // missing the leading P
  ];

  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)} as ${String(expected)}`, () => {
      expect(parseIso8601Duration(input)).toBe(expected);
    });
  }
});
