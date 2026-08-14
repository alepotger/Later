/**
 * Token lifecycle — the machinery that decides whether Later keeps working.
 *
 * The contract, from docs/adr/0005-token-lifecycle-and-reauth.md:
 *
 *  - `invalid_grant` is **terminal**. Never retried. The account moves to
 *    `reauth_required`, its pending work is *parked* rather than failed, and the user is
 *    notified exactly once with a working re-auth link.
 *  - Transient failures are retried by the caller with backoff.
 *  - A rotated refresh token is always persisted. Google may issue a new one on refresh, and
 *    dropping it means running on a token Google considers superseded.
 *  - A keep-alive sweep touches idle tokens, defending against the six-month unused-token
 *    rule and surfacing a revocation within a day instead of at the moment the user next
 *    expects a share to land.
 */

import { and, eq } from 'drizzle-orm';
import { refreshAccessToken } from '../auth/google-oauth.ts';
import type { Config } from '../config.ts';
import { YouTubeError } from '../core/errors.ts';
import type { Vault } from '../crypto/vault.ts';
import type { Db } from '../db/index.ts';
import {
  getAccountById,
  markReauthNotified,
  parkJob,
  setAccountStatus,
  setAccountTokens,
} from '../db/repo.ts';
import { type Account, jobs } from '../db/schema.ts';
import type { Clock } from '../ports/clock.ts';
import type { Logger } from '../ports/logger.ts';
import type { Notifier } from '../ports/notifier.ts';

export class ReauthRequiredError extends Error {
  readonly accountId: string;
  constructor(accountId: string, message: string) {
    super(message);
    this.name = 'ReauthRequiredError';
    this.accountId = accountId;
  }
}

export interface TokenService {
  /** A valid access token, refreshing if needed. Throws `ReauthRequiredError` if dead. */
  getAccessToken(accountId: string): Promise<string>;
  /** Force a refresh regardless of expiry. Used by the keep-alive cron. */
  touch(accountId: string): Promise<'ok' | 'reauth_required'>;
  /** Called after a successful re-authorisation, to release parked work. */
  onReauthorised(accountId: string): Promise<void>;
  /**
   * Enter `reauth_required` from outside the refresh path.
   *
   * Needed because `invalid_grant` can also surface directly from a YouTube API call, not
   * only from a token refresh. Without this, that route would park the item but leave the
   * account looking healthy and send no notification — which is exactly the silent failure
   * ADR-0005 exists to prevent.
   */
  markReauthRequired(accountId: string, reason: string): Promise<void>;
}

export interface TokenServiceDeps {
  db: Db;
  config: Config;
  vault: Vault;
  clock: Clock;
  logger: Logger;
  notifier: Notifier;
  fetch?: typeof fetch;
}

export function createTokenService(deps: TokenServiceDeps): TokenService {
  const { db, config, vault, clock, logger, notifier } = deps;

  async function loadAccount(accountId: string): Promise<Account> {
    const account = await getAccountById(db, accountId);
    if (!account) throw new Error(`account ${accountId} not found`);
    return account;
  }

  /**
   * Move an account to `reauth_required` and tell the user, once.
   *
   * Parking rather than failing is the important part: everything the user shared during the
   * dead window is still there, and drains when they re-authorise. That is the difference
   * between an outage and data loss.
   */
  async function enterReauthRequired(account: Account, reason: string): Promise<void> {
    const now = clock.now().getTime();

    if (account.status !== 'reauth_required') {
      await setAccountStatus(db, account.id, 'reauth_required', now);
    }

    // Park this account's outstanding work so the sweep stops picking it up.
    await db
      .update(jobs)
      .set({ status: 'parked', lockedUntil: null, lastError: reason, updatedAt: now })
      .where(and(eq(jobs.accountId, account.id), eq(jobs.status, 'pending')));

    logger.error('account requires re-authorisation', {
      accountId: account.id,
      email: account.email,
      reason,
      publishingStatus: config.google.publishingStatus,
    });

    // Exactly once per transition. A notification channel used as a retry log gets muted,
    // and this is the one message that must not be.
    if (account.reauthNotifiedAt === null) {
      await notifier.send({
        kind: 'reauth_required',
        email: account.email,
        reauthUrl: `${config.publicBaseUrl}/auth/start`,
        publishingStatus: config.google.publishingStatus,
      });
      await markReauthNotified(db, account.id, now);
    }
  }

  async function refresh(account: Account): Promise<string> {
    if (!account.refreshTokenCipher) {
      await enterReauthRequired(account, 'no refresh token stored');
      throw new ReauthRequiredError(
        account.id,
        'No refresh token stored for this account. Re-authorisation is required.',
      );
    }

    const refreshToken = await vault.decrypt(account.refreshTokenCipher);
    if (refreshToken === null) {
      // Decryption failed: TOKEN_ENCRYPTION_KEY changed or the row was tampered with.
      // Not the user's fault and not fixable by retrying, but re-auth does fix it.
      await enterReauthRequired(account, 'stored refresh token could not be decrypted');
      throw new ReauthRequiredError(
        account.id,
        'The stored refresh token could not be decrypted. This usually means ' +
          'TOKEN_ENCRYPTION_KEY changed. Re-authorise to store a new token.',
      );
    }

    let tokens: Awaited<ReturnType<typeof refreshAccessToken>>;
    try {
      tokens = await refreshAccessToken(
        { clientId: config.google.clientId, clientSecret: config.google.clientSecret },
        refreshToken,
        { fetch: deps.fetch, now: () => clock.now().getTime() },
      );
    } catch (error) {
      if (error instanceof YouTubeError && error.kind === 'invalid_grant') {
        await enterReauthRequired(account, error.message);
        throw new ReauthRequiredError(account.id, error.message);
      }
      // Transient and client errors propagate unchanged; the caller decides about retrying.
      throw error;
    }

    const now = clock.now().getTime();
    const patch: Parameters<typeof setAccountTokens>[2] = {
      accessTokenCipher: await vault.encrypt(tokens.accessToken),
      accessTokenExpiresAt: tokens.expiresAt,
    };

    // Persist a rotated refresh token whenever Google sends one. Invisible when right, and a
    // very confusing failure a few days later when wrong.
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
      patch.refreshTokenCipher = await vault.encrypt(tokens.refreshToken);
      logger.info('stored rotated refresh token', { accountId: account.id });
    }

    await setAccountTokens(db, account.id, patch, now);
    logger.debug('refreshed access token', {
      accountId: account.id,
      expiresAt: tokens.expiresAt,
    });

    return tokens.accessToken;
  }

  return {
    async getAccessToken(accountId: string): Promise<string> {
      const account = await loadAccount(accountId);

      if (account.status === 'reauth_required') {
        throw new ReauthRequiredError(
          accountId,
          'Account is awaiting re-authorisation; not attempting to use its tokens.',
        );
      }
      if (account.status === 'disabled') {
        throw new Error(`account ${accountId} is disabled`);
      }

      const now = clock.now().getTime();
      if (account.accessTokenCipher && account.accessTokenExpiresAt !== null) {
        if (account.accessTokenExpiresAt > now) {
          const cached = await vault.decrypt(account.accessTokenCipher);
          if (cached !== null) return cached;
          logger.warn('cached access token failed to decrypt; refreshing', { accountId });
        }
      }

      return await refresh(account);
    },

    async touch(accountId: string): Promise<'ok' | 'reauth_required'> {
      const account = await loadAccount(accountId);
      if (account.status !== 'active') return 'reauth_required';
      try {
        await refresh(account);
        return 'ok';
      } catch (error) {
        if (error instanceof ReauthRequiredError) return 'reauth_required';
        // A transient failure during keep-alive is not interesting: the next sweep retries.
        logger.warn('keep-alive refresh failed, will retry on the next sweep', {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        });
        return 'ok';
      }
    },

    async markReauthRequired(accountId: string, reason: string): Promise<void> {
      await enterReauthRequired(await loadAccount(accountId), reason);
    },

    async onReauthorised(accountId: string): Promise<void> {
      const now = clock.now().getTime();
      await setAccountStatus(db, accountId, 'active', now);
      const released = await db
        .update(jobs)
        .set({ status: 'pending', runAfter: now, lastError: null, updatedAt: now })
        .where(and(eq(jobs.accountId, accountId), eq(jobs.status, 'parked')))
        .returning({ id: jobs.id });

      if (released.length > 0) {
        logger.info('released parked work after re-authorisation', {
          accountId,
          released: released.length,
        });
      }
    },
  };
}

/** Re-exported so the cron sweep can park a single job without importing the repo directly. */
export { parkJob };
