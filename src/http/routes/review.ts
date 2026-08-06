/**
 * The review inbox.
 *
 * Where items go when Later resolved something but was not confident enough to add it. This
 * list existing is the whole point of the confidence gate — a wrong video in someone's playlist
 * destroys trust faster than a missing right one, so anything uncertain waits here for one tap.
 *
 * Forms post and redirect, so it works with no JavaScript. That matters because a lot of these
 * page loads happen inside the in-app browser a share sheet opens.
 */

import type { Hono } from 'hono';
import {
  getCachedVideos,
  getItemById,
  getSoloAccount,
  listItemsByStatus,
  putCachedVideo,
  requeueItemJob,
  updateItem,
} from '../../db/repo.ts';
import type { Account, Item } from '../../db/schema.ts';
import { processOne } from '../../pipeline/worker.ts';
import type { AppBindings } from '../middleware.ts';
import { errorPage, reviewPage } from '../views.ts';
import type { Runtime } from '../../runtime.ts';

/** Load an item, checking it belongs to the caller's account. */
async function loadOwnedItem(runtime: Runtime, account: Account, id: string): Promise<Item | null> {
  const item = await getItemById(runtime.db, id);
  // Item IDs are random rather than sequential precisely so they cannot be enumerated, but
  // the ownership check is what actually enforces it.
  if (!item || item.accountId !== account.id) return null;
  return item;
}

export function registerReviewRoutes(app: Hono<AppBindings>): void {
  app.get('/review', async (c) => {
    const runtime = c.get('runtime');
    const account = await getSoloAccount(runtime.db);
    if (!account) return c.redirect('/', 302);

    const held = await listItemsByStatus(runtime.db, account.id, ['held_for_review'], 50);
    const videoIds = [
      ...new Set(
        held.map((item) => item.resolvedVideoId).filter((id): id is string => Boolean(id)),
      ),
    ];

    let cached = await getCachedVideos(runtime.db, videoIds);

    // A Tier 2 hold never called `videos.list`, so these titles are not cached yet — and a
    // review page showing bare video IDs is useless, because you cannot judge "is this the
    // right video?" from an ID. One batched lookup costs 1 unit for up to 50 IDs, and it also
    // warms the cache so confirming the item afterwards spends nothing extra.
    const missing = videoIds.filter((id) => !cached.some((row) => row.videoId === id));
    if (missing.length > 0) {
      try {
        const scope = await runtime.forAccount(account.id);
        const fetched = await scope.youtube.getVideos(missing);
        const now = runtime.clock.now().getTime();
        for (const video of fetched) {
          await putCachedVideo(
            runtime.db,
            {
              videoId: video.videoId,
              title: video.title,
              channelTitle: video.channelTitle,
              channelId: video.channelId,
              durationSeconds: video.durationSeconds,
              availability: video.availability,
            },
            now,
          );
        }
        cached = await getCachedVideos(runtime.db, videoIds);
      } catch (error) {
        // Out of quota, or authorisation is dead. Render with what we have rather than
        // failing the page — a review list with IDs beats no review list.
        c.get('logger').warn('could not fetch titles for the review inbox', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return c.html(
      reviewPage({
        config: runtime.config,
        items: held,
        videos: new Map(cached.map((row) => [row.videoId, row])),
      }),
    );
  });

  /**
   * Confirm a held item.
   *
   * The video is not added here. The item goes back to `pending` and its job is re-queued, so
   * confirmation runs the same pipeline as everything else — dedupe claim, quota gate, and all.
   * A second code path for "the user said yes" is how those guards quietly stop applying.
   */
  app.post('/review/:id/confirm', async (c) => {
    const runtime = c.get('runtime');
    const account = await getSoloAccount(runtime.db);
    if (!account) return c.redirect('/', 302);

    const item = await loadOwnedItem(runtime, account, c.req.param('id'));
    if (!item) return c.html(errorPage(runtime.config, 'Not found', 'No such item.'), 404);
    if (item.status !== 'held_for_review') return c.redirect('/review', 302);

    const now = runtime.clock.now().getTime();
    // Confidence becomes 1: a human confirming it is better evidence than any score.
    await updateItem(
      runtime.db,
      item.id,
      { status: 'pending', confidence: 1, failureReason: null },
      now,
    );
    await requeueItemJob(runtime.db, { accountId: account.id, itemId: item.id }, now);

    // Run it now rather than waiting for the sweep — the user is looking at the screen.
    await processOne(await runtime.worker());

    return c.redirect('/review', 302);
  });

  app.post('/review/:id/reject', async (c) => {
    const runtime = c.get('runtime');
    const account = await getSoloAccount(runtime.db);
    if (!account) return c.redirect('/', 302);

    const item = await loadOwnedItem(runtime, account, c.req.param('id'));
    if (!item) return c.html(errorPage(runtime.config, 'Not found', 'No such item.'), 404);

    await updateItem(
      runtime.db,
      item.id,
      { status: 'rejected', failureReason: 'You skipped this one.' },
      runtime.clock.now().getTime(),
    );
    return c.redirect('/review', 302);
  });
}
