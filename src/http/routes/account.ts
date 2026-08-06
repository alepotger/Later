/**
 * Account self-service. MULTI mode only.
 *
 * Two things a shared instance needs that a SOLO one does not: a per-account ingest token, and
 * a way to tell the Telegram bot which chat belongs to whom. Both are the user's own to manage,
 * so neither goes through the deployer's `.env` — the point of MULTI is that adding a person
 * does not mean editing config and redeploying.
 *
 * In SOLO these routes 404. There is one account, its token is `INGEST_TOKEN`, and any
 * allowlisted Telegram chat is by definition the owner's.
 */

import type { Hono } from 'hono';
import { setAccountTelegramChatId } from '../../db/repo.ts';
import { cookiesAreSecure, mintIngestToken, resolveWebAccount } from '../accounts.ts';
import { noAccountPage, renderHome } from '../home.ts';
import type { AppBindings } from '../middleware.ts';
import { clearedSessionCookie } from '../session.ts';

export function registerAccountRoutes(app: Hono<AppBindings>): void {
  app.post('/account/ingest-token', async (c) => {
    const runtime = c.get('runtime');
    if (runtime.config.mode !== 'MULTI') return c.notFound();

    const account = await resolveWebAccount(runtime, c.req.header('cookie'));
    if (!account) return c.html(noAccountPage(runtime));

    const { token, hash } = await mintIngestToken(runtime, account.id);
    c.get('logger').info('minted a new ingest token', { accountId: account.id });

    // Rendered, not redirected. A redirect would have to carry the token in the URL, and a
    // secret in a URL ends up in history, server logs and referrer headers.
    return c.html(
      await renderHome(runtime, { ...account, ingestTokenHash: hash }, { mintedToken: token }),
    );
  });

  app.post('/account/telegram/unlink', async (c) => {
    const runtime = c.get('runtime');
    if (runtime.config.mode !== 'MULTI') return c.notFound();

    const account = await resolveWebAccount(runtime, c.req.header('cookie'));
    if (!account) return c.html(noAccountPage(runtime));

    await setAccountTelegramChatId(runtime.db, account.id, null, runtime.clock.now().getTime());
    return c.redirect('/', 303);
  });

  app.post('/auth/signout', async (c) => {
    const runtime = c.get('runtime');
    if (runtime.config.mode !== 'MULTI') return c.notFound();

    c.header('set-cookie', clearedSessionCookie(cookiesAreSecure(runtime)));
    return c.redirect('/', 303);
  });
}
