/**
 * OAuth routes.
 *
 * `/auth/start` is also the re-auth link sent in the `reauth_required` notification, so it has
 * to work when tapped from a phone with no session — which is why it carries no state of its
 * own beyond the single-use handshake row.
 */

import type { Hono } from 'hono';
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeCode,
  fetchIdentity,
} from '../../auth/google-oauth.ts';
import { YouTubeError } from '../../core/errors.ts';
import {
  countAccounts,
  getSoloAccount,
  putOAuthState,
  takeOAuthState,
  upsertAccount,
} from '../../db/repo.ts';
import { html } from '../html.ts';
import type { AppBindings } from '../middleware.ts';
import { errorPage, layout } from '../views.ts';

const STATE_TTL_MS = 10 * 60 * 1000;

export function registerAuthRoutes(app: Hono<AppBindings>): void {
  app.get('/auth/start', async (c) => {
    const runtime = c.get('runtime');
    const { config } = runtime;
    const logger = c.get('logger');
    const now = runtime.clock.now().getTime();

    // SOLO's instance lock. Without this, the deployer's /auth/start URL is an open
    // invitation for a stranger to attach their own account. Re-authorising the *existing*
    // account is still allowed, which is what makes the reauth link work. See ADR-0013.
    if (config.mode === 'SOLO') {
      const existing = await getSoloAccount(runtime.db);
      const reauthorising = existing !== undefined;
      if (reauthorising && existing.status === 'active' && c.req.query('force') !== '1') {
        return c.redirect('/', 302);
      }
    } else {
      const total = await countAccounts(runtime.db);
      if (total >= 100) {
        return c.html(
          errorPage(
            config,
            'Too many accounts',
            'Google caps unverified apps at 100 users. Remove an account or complete Google verification.',
          ),
          409,
        );
      }
    }

    // Fixtures mode connects a local stand-in account instead of redirecting to Google, so
    // `USE_FIXTURES=true` is a genuinely usable demo rather than a setup page you cannot get
    // past. Strictly gated: in fixtures mode nothing reaches YouTube, so the account is inert
    // and no real playlist can be touched.
    if (config.useFixtures) {
      const account = await upsertAccount(
        runtime.db,
        {
          googleUserId: 'fixtures-user',
          email: 'you@example.com (fixtures mode)',
          displayName: 'Fixtures mode',
          refreshTokenCipher: await runtime.vault.encrypt('fixtures-refresh-token'),
          accessTokenCipher: await runtime.vault.encrypt('fixtures-access-token'),
          accessTokenExpiresAt: now + 3_600_000,
        },
        now,
      );
      await runtime.tokens.onReauthorised(account.id);
      const scope = await runtime.forAccount(account.id);
      await scope.playlists.ensure(account.id, { force: true });
      logger.warn('connected a fixtures-mode account; nothing will reach YouTube');
      return c.redirect('/', 302);
    }

    const { verifier, challenge } = await createPkcePair();
    const state = createState();
    await putOAuthState(
      runtime.db,
      { state, codeVerifier: verifier, expiresAt: now + STATE_TTL_MS },
      now,
    );

    const url = buildAuthorizeUrl(
      {
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri: `${config.publicBaseUrl}/auth/callback`,
      },
      { state, codeChallenge: challenge },
    );

    return c.redirect(url, 302);
  });

  app.get('/auth/callback', async (c) => {
    const runtime = c.get('runtime');
    const { config } = runtime;
    const logger = c.get('logger');
    const now = runtime.clock.now().getTime();

    const error = c.req.query('error');
    if (error) {
      // The user declined, or Google refused. Both are user-visible and neither is a bug.
      return c.html(
        errorPage(
          config,
          'Authorisation was not completed',
          error === 'access_denied'
            ? 'You declined the permission request. Later needs it to add videos to a playlist on your behalf.'
            : `Google returned: ${error}`,
        ),
        400,
      );
    }

    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) {
      return c.html(errorPage(config, 'Invalid callback', 'Missing code or state.'), 400);
    }

    const handshake = await takeOAuthState(runtime.db, state, now);
    if (!handshake) {
      return c.html(
        errorPage(
          config,
          'That link has expired',
          'The authorisation link is single-use and expires after ten minutes. Start again.',
        ),
        400,
      );
    }

    try {
      const tokens = await exchangeCode(
        {
          clientId: config.google.clientId,
          clientSecret: config.google.clientSecret,
          redirectUri: `${config.publicBaseUrl}/auth/callback`,
        },
        { code, codeVerifier: handshake.codeVerifier },
        { now: () => now },
      );

      const identity = await fetchIdentity(tokens.accessToken);

      if (config.mode === 'MULTI' && !config.allowedEmails.includes(identity.email)) {
        logger.warn('rejected authorisation for a non-allowlisted email', {
          email: identity.email,
        });
        return c.html(
          errorPage(
            config,
            'Not on the allowlist',
            `${identity.email} is not listed in LATER_ALLOWED_EMAILS.`,
          ),
          403,
        );
      }

      if (config.mode === 'SOLO') {
        const existing = await getSoloAccount(runtime.db);
        if (existing && existing.googleUserId !== identity.googleUserId) {
          logger.warn('rejected a second account in SOLO mode', { email: identity.email });
          return c.html(
            errorPage(
              config,
              'This instance is already connected',
              `Later is running in SOLO mode and is connected to ${existing.email}. ` +
                'Set LATER_MODE=MULTI if you want more than one account.',
            ),
            409,
          );
        }
      }

      if (!tokens.refreshToken) {
        // Without a refresh token Later works for an hour and then stops. `prompt=consent`
        // should prevent this, so getting here means something unusual — say so plainly
        // rather than storing a token that will die quietly.
        logger.error('google returned no refresh token', { email: identity.email });
        return c.html(
          errorPage(
            config,
            'Google did not return a refresh token',
            'Without one, access would expire in about an hour. Revoke Later at ' +
              'myaccount.google.com/permissions and try again.',
          ),
          400,
        );
      }

      const account = await upsertAccount(
        runtime.db,
        {
          googleUserId: identity.googleUserId,
          email: identity.email,
          displayName: identity.name ?? null,
          refreshTokenCipher: await runtime.vault.encrypt(tokens.refreshToken),
          accessTokenCipher: await runtime.vault.encrypt(tokens.accessToken),
          accessTokenExpiresAt: tokens.expiresAt,
        },
        now,
      );

      // Releases anything parked while authorisation was dead, so the backlog drains.
      await runtime.tokens.onReauthorised(account.id);

      logger.info('account authorised', { accountId: account.id, email: identity.email });

      // Find-or-create the playlist now rather than on the first share, so a setup problem
      // surfaces while the user is still looking at the screen.
      let playlistNote = '';
      try {
        const scope = await runtime.forAccount(account.id);
        const playlist = await scope.playlists.ensure(account.id, { force: true });
        playlistNote = playlist.name;
      } catch (playlistError) {
        logger.error('could not resolve the destination playlist', {
          accountId: account.id,
          error: playlistError instanceof Error ? playlistError.message : String(playlistError),
        });
      }

      return c.html(
        layout({
          title: 'Later — connected',
          config,
          body: html`<div class="card">
            <h2 style="margin-top:0">Connected as ${identity.email}</h2>
            ${
              playlistNote
                ? html`<p>
                  Videos will be saved to your playlist <strong>${playlistNote}</strong>. This is a
                  playlist Later created — not your native Watch Later, which Google closed to
                  API access in 2016.
                </p>`
                : html`<p>
                  Connected, but the destination playlist could not be set up yet. Check the logs;
                  Later will retry on your first share.
                </p>`
            }
            <div class="row"><a href="/"><button>Start saving videos</button></a></div>
          </div>`,
        }),
      );
    } catch (exchangeError) {
      const detail =
        exchangeError instanceof YouTubeError
          ? exchangeError.message
          : exchangeError instanceof Error
            ? exchangeError.message
            : String(exchangeError);

      logger.error('oauth exchange failed', { error: detail });

      // redirect_uri_mismatch is by far the most common setup failure, and the fix is
      // mechanical — so say exactly what to do instead of showing Google's wording.
      const isMismatch = detail.toLowerCase().includes('redirect_uri_mismatch');
      return c.html(
        errorPage(
          config,
          isMismatch ? 'Redirect URI mismatch' : 'Could not complete authorisation',
          isMismatch
            ? `Google requires an exact match. Add this to "Authorized redirect URIs" on your ` +
                `OAuth client: ${config.publicBaseUrl}/auth/callback`
            : detail,
        ),
        400,
      );
    }
  });
}
