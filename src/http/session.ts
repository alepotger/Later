/**
 * Signed, stateless credentials for MULTI mode.
 *
 * MULTI needs to answer "which account is this?" in two places where SOLO never has to ask:
 * a browser hitting the web UI, and a Telegram chat that has not been seen before. Both are
 * solved with an HMAC over the account ID rather than a table of session rows.
 *
 * Stateless because the alternative costs a database round trip on every page load, a sweep
 * job, and a migration — to protect a web UI whose worst-case compromise is the same thing an
 * ingest token already grants. The signing key is `SESSION_SECRET`, which is required in every
 * mode, so rotating it invalidates every session and every outstanding link code at once.
 *
 * Nothing here is used in SOLO: there is one account and no ambiguity, so the UI stays free of
 * sign-in concepts entirely. See docs/adr/0013-solo-and-multi-modes.md.
 */

import { timingSafeEqual } from '../core/bytes.ts';
import { hmacSha256Hex } from '../crypto/vault.ts';

export const SESSION_COOKIE = 'later_session';

/** Long, because re-authorising with Google to read your own share list is absurd friction. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Short, because a link code in a browser tab is a bearer credential for the account. */
export const LINK_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Domain separation.
 *
 * Both credentials are an account ID signed with the same key. Without a purpose in the signed
 * message, a Telegram link code copied out of the page would work as a session cookie and vice
 * versa — the short expiry on one would be silently undone by the long expiry on the other.
 */
export type SignedPurpose = 'session' | 'telegram-link';

/** `<value>.<expiresAt>.<hmac>`; the value must not contain a dot. Account IDs do not. */
export async function signValue(
  secret: string,
  purpose: SignedPurpose,
  value: string,
  expiresAt: number,
): Promise<string> {
  const body = `${value}.${expiresAt}`;
  return `${body}.${await hmacSha256Hex(secret, `${purpose}:${body}`)}`;
}

/** The signed value, or null for anything malformed, mis-signed, expired, or wrong-purpose. */
export async function verifyValue(
  secret: string,
  purpose: SignedPurpose,
  token: string,
  now: number,
): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [value, expiresRaw, signature] = parts as [string, string, string];

  const expected = await hmacSha256Hex(secret, `${purpose}:${value}.${expiresRaw}`);
  if (!timingSafeEqual(signature, expected)) return null;

  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

  return value;
}

/** Read one cookie out of a raw `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Serialise the session cookie.
 *
 * `SameSite=Lax` rather than `Strict`: the cookie is set on the OAuth callback, which is a
 * cross-site navigation from Google, and `Strict` would drop it on that exact request.
 * `Secure` follows the deployment's own base URL, so a localhost run still works.
 */
export function sessionCookie(value: string, options: { secure: boolean; maxAge: number }): string {
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAge}`,
  ];
  if (options.secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie('', { secure, maxAge: 0 });
}
