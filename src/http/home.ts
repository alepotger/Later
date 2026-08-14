/**
 * Rendering the home page.
 *
 * Lives outside `app.ts` because three route modules need it — the paste box, the PWA share
 * target, and the account routes, which render the page directly rather than redirecting so a
 * freshly minted ingest token can be shown without ever appearing in a URL.
 */

import type { Context } from 'hono';
import {
  countItemsByStatus,
  getCachedVideos,
  listRecentItems,
  quotaByAccountForDate,
} from '../db/repo.ts';
import type { Account } from '../db/schema.ts';
import type { Runtime } from '../runtime.ts';
import { resolveWebAccount, telegramLinkCode } from './accounts.ts';
import type { Html } from './html.ts';
import type { AppBindings } from './middleware.ts';
import { homePage, ingestTokenPanel, multiAccountPanel, setupPage, signInPage } from './views.ts';

/** The account the browser is looking at: the only account in SOLO, the session's in MULTI. */
export async function webAccount(c: Context<AppBindings>): Promise<Account | undefined> {
  return await resolveWebAccount(c.get('runtime'), c.req.header('cookie'));
}

/**
 * What to show when there is no account to show.
 *
 * Two different situations that must not be conflated: a fresh SOLO deployment nobody has
 * connected yet, and a shared instance you have simply not signed in to.
 */
export function noAccountPage(runtime: Runtime): string {
  return runtime.config.mode === 'MULTI' ? signInPage(runtime.config) : setupPage(runtime.config);
}

export interface HomeOptions {
  flash?: Html | null;
  prefill?: string;
  /** Shown once, at the top, because reloading the page cannot bring it back. */
  mintedToken?: string;
}

export async function renderHome(
  runtime: Runtime,
  account: Account,
  options: HomeOptions,
): Promise<string> {
  const items = await listRecentItems(runtime.db, account.id, 25);
  const counts = await countItemsByStatus(runtime.db, account.id);

  const videoIds = items
    .map((item) => item.resolvedVideoId)
    .filter((id): id is string => Boolean(id));
  const cached = await getCachedVideos(runtime.db, [...new Set(videoIds)]);
  const titles = new Map(
    cached.filter((row) => row.title).map((row) => [row.videoId, row.title as string]),
  );

  const scope = await runtime.forAccount(account.id);
  const quota = await scope.quota.summary();

  const extras = runtime.config.mode === 'MULTI' ? await multiPanel(runtime, account, quota) : null;

  const flash = options.mintedToken
    ? ingestTokenPanel(options.mintedToken, runtime.config.publicBaseUrl)
    : options.flash;

  return homePage({
    config: runtime.config,
    email: account.email,
    playlistId: account.playlistId,
    playlistName: account.playlistName ?? runtime.config.playlist.name,
    items,
    titles,
    quota,
    counts,
    needsReauth: account.status === 'reauth_required',
    extras,
    ...(options.prefill !== undefined ? { prefill: options.prefill } : {}),
    ...(flash !== undefined ? { flash } : {}),
  });
}

/** The MULTI-only account panel: token management, Telegram linking, and quota share. */
async function multiPanel(
  runtime: Runtime,
  account: Account,
  quota: { spent: number; budget: number; quotaDate: string },
): Promise<Html> {
  const perAccount = await quotaByAccountForDate(runtime.db, quota.quotaDate);
  const yours = perAccount.find((row) => row.accountId === account.id)?.unitsSpent ?? 0;

  return multiAccountPanel({
    email: account.email,
    hasIngestToken: account.ingestTokenHash !== null,
    telegramLinked: account.telegramChatId !== null,
    // Only offered when a bot is actually configured — a link code for a bot that does not
    // exist is a dead end dressed up as a feature.
    telegramLinkCode:
      runtime.telegram && account.telegramChatId === null
        ? await telegramLinkCode(runtime, account.id)
        : null,
    quota: { yours, instance: quota.spent, budget: quota.budget },
  });
}
