/**
 * Which account is this request for?
 *
 * The single place the SOLO/MULTI difference is decided. ADR-0013 promises the mode changes
 * "only authorisation policy and UI, never storage" — this file is the authorisation policy
 * half of that promise, and everything downstream just receives an `Account`.
 */

import { randomToken, sha256Hex, timingSafeEqual } from '../core/bytes.ts';
import {
  getAccountById,
  getAccountByIngestTokenHash,
  getAccountByTelegramChatId,
  getSoloAccount,
  setAccountIngestTokenHash,
} from '../db/repo.ts';
import type { Account } from '../db/schema.ts';
import type { Runtime } from '../runtime.ts';
import {
  LINK_CODE_TTL_MS,
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookie,
  signValue,
  verifyValue,
} from './session.ts';

export type IngestAuth =
  | { ok: true; account: Account }
  | { ok: false; reason: 'unauthorized' }
  | { ok: false; reason: 'not_connected' };

/**
 * Authenticate an ingest bearer token and resolve the account it belongs to.
 *
 * SOLO compares against the one configured token in constant time. MULTI looks the account up
 * by the SHA-256 of the presented token, so the plaintext is never stored and a database dump
 * cannot be used to post shares.
 *
 * The MULTI lookup is an ordinary indexed query rather than a constant-time scan. That is
 * deliberate and safe: the token is 256 bits of `crypto.getRandomValues`, so there is no prefix
 * to walk — a timing signal would have to be exploited against a search space no attacker can
 * enumerate. Constant time matters for the SOLO comparison because that one *is* a byte-by-byte
 * compare against a known-length secret.
 */
export async function authenticateIngest(runtime: Runtime, presented: string): Promise<IngestAuth> {
  if (presented === '') return { ok: false, reason: 'unauthorized' };

  if (runtime.config.mode === 'SOLO') {
    if (!timingSafeEqual(presented, runtime.config.ingest.token)) {
      return { ok: false, reason: 'unauthorized' };
    }
    const account = await getSoloAccount(runtime.db);
    return account ? { ok: true, account } : { ok: false, reason: 'not_connected' };
  }

  const account = await getAccountByIngestTokenHash(runtime.db, await sha256Hex(presented));
  // An unknown token and a token belonging to no-one are the same answer on purpose: MULTI
  // must not confirm that a given token is "valid but unconnected".
  return account ? { ok: true, account } : { ok: false, reason: 'unauthorized' };
}

/**
 * Which account the browser in front of us is looking at.
 *
 * SOLO answers with the one account and never shows a sign-in — the instance is locked to its
 * first authorisation, so there is nothing to choose between. MULTI reads the signed session
 * cookie written by the OAuth callback.
 */
export async function resolveWebAccount(
  runtime: Runtime,
  cookieHeader: string | undefined,
): Promise<Account | undefined> {
  if (runtime.config.mode === 'SOLO') return await getSoloAccount(runtime.db);

  const raw = readCookie(cookieHeader, SESSION_COOKIE);
  if (!raw) return undefined;

  const accountId = await verifyValue(
    runtime.config.secrets.sessionSecret,
    'session',
    raw,
    runtime.clock.now().getTime(),
  );
  if (!accountId) return undefined;

  return await getAccountById(runtime.db, accountId);
}

/**
 * Which account a Telegram chat belongs to.
 *
 * SOLO: the one account — any chat that passed the allowlist is the owner's. MULTI: whichever
 * account ran `/link` from this chat, and no fallback. Guessing in MULTI would mean forwarding
 * a stranger's Reel into the first-created user's playlist.
 */
export async function resolveTelegramAccount(
  runtime: Runtime,
  chatId: string,
): Promise<Account | undefined> {
  return runtime.config.mode === 'SOLO'
    ? await getSoloAccount(runtime.db)
    : await getAccountByTelegramChatId(runtime.db, chatId);
}

/** `Secure` must not be set on a plain-HTTP localhost run, or the browser drops the cookie. */
export function cookiesAreSecure(runtime: Runtime): boolean {
  return runtime.config.publicBaseUrl.startsWith('https://');
}

/** The `Set-Cookie` value that signs an account in. */
export async function issueSessionCookie(runtime: Runtime, accountId: string): Promise<string> {
  const value = await signValue(
    runtime.config.secrets.sessionSecret,
    'session',
    accountId,
    runtime.clock.now().getTime() + SESSION_TTL_MS,
  );
  return sessionCookie(value, {
    secure: cookiesAreSecure(runtime),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** A short-lived, single-account code that the Telegram bot accepts as proof of ownership. */
export async function telegramLinkCode(runtime: Runtime, accountId: string): Promise<string> {
  return await signValue(
    runtime.config.secrets.sessionSecret,
    'telegram-link',
    accountId,
    runtime.clock.now().getTime() + LINK_CODE_TTL_MS,
  );
}

/**
 * Mint a new ingest token for an account and store only its hash.
 *
 * Returns the plaintext to the caller exactly once — there is deliberately no way to read it
 * back, which is what makes a leaked database useless for posting shares.
 */
export async function mintIngestToken(
  runtime: Runtime,
  accountId: string,
): Promise<{ token: string; hash: string }> {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  await setAccountIngestTokenHash(runtime.db, accountId, hash, runtime.clock.now().getTime());
  return { token, hash };
}
