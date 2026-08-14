/**
 * Signed session and link credentials.
 *
 * These are bearer credentials for someone's YouTube playlist, so the tests are about the ways
 * verification must say no, not the happy path.
 */

import { describe, expect, it } from 'vitest';
import {
  clearedSessionCookie,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  signValue,
  verifyValue,
} from '../../src/http/session.ts';

const SECRET = 'a-test-session-secret';
const NOW = 1_754_510_400_000;

describe('signValue / verifyValue', () => {
  it('round-trips a value', async () => {
    const token = await signValue(SECRET, 'session', 'acc_abc123', NOW + 60_000);
    expect(await verifyValue(SECRET, 'session', token, NOW)).toBe('acc_abc123');
  });

  it('rejects a different key', async () => {
    const token = await signValue(SECRET, 'session', 'acc_abc123', NOW + 60_000);
    expect(await verifyValue('another-secret', 'session', token, NOW)).toBeNull();
  });

  it('rejects a different purpose', async () => {
    const token = await signValue(SECRET, 'telegram-link', 'acc_abc123', NOW + 60_000);
    expect(await verifyValue(SECRET, 'session', token, NOW)).toBeNull();
  });

  it('rejects an expired value, and treats the boundary as expired', async () => {
    const expired = await signValue(SECRET, 'session', 'acc_abc123', NOW - 1);
    expect(await verifyValue(SECRET, 'session', expired, NOW)).toBeNull();

    const exact = await signValue(SECRET, 'session', 'acc_abc123', NOW);
    expect(await verifyValue(SECRET, 'session', exact, NOW)).toBeNull();
  });

  it('rejects an extended expiry, because the expiry is inside the signature', async () => {
    const token = await signValue(SECRET, 'session', 'acc_abc123', NOW - 1);
    const [value, , signature] = token.split('.') as [string, string, string];

    expect(
      await verifyValue(SECRET, 'session', `${value}.${NOW + 999_999}.${signature}`, NOW),
    ).toBeNull();
  });

  it('rejects a swapped account ID', async () => {
    const token = await signValue(SECRET, 'session', 'acc_mine', NOW + 60_000);
    const [, expiry, signature] = token.split('.') as [string, string, string];

    expect(
      await verifyValue(SECRET, 'session', `acc_yours.${expiry}.${signature}`, NOW),
    ).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['no separators', 'garbage'],
    ['too few parts', 'acc_abc.123'],
    ['too many parts', 'acc_abc.123.sig.extra'],
    ['non-numeric expiry', 'acc_abc.soon.0000'],
  ])('rejects a malformed token: %s', async (_label, token) => {
    expect(await verifyValue(SECRET, 'session', token, NOW)).toBeNull();
  });

  it('rejects a non-finite expiry rather than treating it as far future', async () => {
    // `Number('Infinity')` is not NaN, so a naive `Number.isNaN` check would let this pass and
    // mint an eternal session out of a malformed string.
    const forged = `acc_abc.Infinity.${'0'.repeat(64)}`;
    expect(await verifyValue(SECRET, 'session', forged, NOW)).toBeNull();
  });
});

describe('cookies', () => {
  it('marks the session cookie HttpOnly and SameSite=Lax', async () => {
    const header = sessionCookie('value', { secure: true, maxAge: 3600 });
    expect(header).toContain('HttpOnly');
    // Lax, not Strict: the cookie is set on the cross-site return from Google's consent screen.
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
    expect(header).toContain('Path=/');
  });

  it('omits Secure on a plain-HTTP deployment, or the browser drops it', () => {
    expect(sessionCookie('v', { secure: false, maxAge: 60 })).not.toContain('Secure');
  });

  it('clears with Max-Age=0', () => {
    expect(clearedSessionCookie(false)).toContain('Max-Age=0');
  });

  it('reads one cookie out of a header with several', () => {
    const header = `theme=dark; ${SESSION_COOKIE}=abc.123.def; other=1`;
    expect(readCookie(header, SESSION_COOKIE)).toBe('abc.123.def');
  });

  it('does not match a cookie whose name merely ends with the one wanted', () => {
    expect(readCookie(`not_${SESSION_COOKIE}=evil`, SESSION_COOKIE)).toBeUndefined();
  });

  it('returns undefined for a missing header or a missing cookie', () => {
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie('theme=dark', SESSION_COOKIE)).toBeUndefined();
  });
});
