/**
 * The resolution pipeline.
 *
 * Takes one item and drives it to a terminal state. Phase 1 implements Tier 0 only; Tiers 1
 * to 3 slot in at the marked point without changing anything around them.
 *
 * The ordering of the dedupe claim and the YouTube call is the subtle part, and it is
 * deliberate — see `claimAndAdd` below.
 */

import type { Config } from '../config.ts';
import { YouTubeError } from '../core/errors.ts';
import { extractFromText } from '../core/urls/extract.ts';
import type { Db } from '../db/index.ts';
import {
  deletePlaylistEntry,
  getAccountById,
  getCachedVideos,
  getItemById,
  hasPlaylistEntry,
  putCachedVideo,
  recordPlaylistEntry,
  updateItem,
} from '../db/repo.ts';
import type { ItemStatus } from '../db/schema.ts';
import type { Clock } from '../ports/clock.ts';
import type { Logger } from '../ports/logger.ts';
import type { Notifier } from '../ports/notifier.ts';
import type { YouTubeClient, YouTubeVideo } from '../ports/youtube.ts';
import type { LlmPort } from '../ports/llm.ts';
import type { PlatformMetadataPort } from '../adapters/platform/oembed.ts';
import { resolveHigherTiers } from './tiers.ts';
import type { PlaylistService } from '../services/playlist.ts';
import { ReauthRequiredError, type TokenService } from '../services/tokens.ts';

export interface ResolveDeps {
  db: Db;
  config: Config;
  clock: Clock;
  logger: Logger;
  notifier: Notifier;
  youtube: YouTubeClient;
  playlists: PlaylistService;
  tokens: TokenService;
  llm: LlmPort;
  platform: PlatformMetadataPort;
}

export type ResolveOutcome =
  | { kind: 'settled'; status: ItemStatus }
  /** Quota gone. The caller must reschedule without consuming a retry attempt. */
  | { kind: 'deferred'; reason: string }
  /** Account needs re-authorisation. The caller must park, not fail. */
  | { kind: 'parked'; reason: string }
  /** Transient. The caller retries with backoff. */
  | { kind: 'retry'; reason: string };

/**
 * Resolve one item.
 *
 * Never throws for an expected condition: every outcome the caller must treat differently is
 * returned as data. Only genuine bugs propagate.
 */
export async function resolveItem(deps: ResolveDeps, itemId: string): Promise<ResolveOutcome> {
  const { db, clock, logger } = deps;
  const log = logger.child({ itemId });

  const item = await getItemById(db, itemId);
  if (!item) return { kind: 'settled', status: 'failed' };

  const account = await getAccountById(db, item.accountId);
  if (!account) return { kind: 'settled', status: 'failed' };

  if (account.status === 'reauth_required') {
    await setStatus(deps, itemId, 'parked', 'Waiting for Google authorisation to be renewed.');
    return { kind: 'parked', reason: 'account awaiting re-authorisation' };
  }
  if (account.status === 'disabled') {
    await setStatus(deps, itemId, 'failed', 'This account is disabled.');
    return { kind: 'settled', status: 'failed' };
  }

  // ─── Resolution ───────────────────────────────────────────────────────────
  // Tier 0 result is normally already on the row, set synchronously during ingest.
  let videoId = item.resolvedVideoId;
  let tier = item.resolvedTier ?? 0;

  if (!videoId) {
    // Re-run Tier 0 in case the row predates a fix to the extractor: free, and it means a
    // parser improvement retroactively rescues items sitting in the queue.
    const extraction = extractFromText(item.rawText);
    const first = extraction.videos[0];
    if (first) {
      videoId = first.videoId;
      tier = 0;
    }
  }

  // ── Tiers 1 and 2: platform captions, then language understanding ──
  // Only reached when Tier 0 found nothing, so the free path is never taxed by this.
  let confidence = item.confidence ?? 1;

  if (!videoId) {
    let outcome: Awaited<ReturnType<typeof resolveHigherTiers>>;
    try {
      outcome = await resolveHigherTiers(deps, item.rawText);
    } catch (error) {
      // Quota exhaustion during `search.list` arrives here and must defer, not fail — the
      // shared item is still perfectly good, we just cannot afford to resolve it today.
      return await handleFailure(deps, itemId, null, tier, error);
    }

    if (outcome.kind === 'video') {
      videoId = outcome.videoId;
      tier = outcome.tier;
      confidence = outcome.confidence;
    } else if (outcome.kind === 'review') {
      // Never add a guess we are not confident about. A wrong video in someone's playlist
      // destroys trust faster than a missing right one.
      await updateItem(
        db,
        itemId,
        {
          status: 'held_for_review',
          resolvedVideoId: outcome.videoId,
          resolvedTier: outcome.tier,
          confidence: outcome.confidence,
          failureReason: outcome.reason,
        },
        clock.now().getTime(),
      );
      await deps.notifier.send({
        kind: 'item_held',
        itemId,
        guess: outcome.guess,
        confidence: outcome.confidence,
        reviewUrl: `${deps.config.publicBaseUrl}/review`,
      });
      log.info('held for review', { videoId: outcome.videoId, confidence: outcome.confidence });
      return { kind: 'settled', status: 'held_for_review' };
    } else {
      await setStatus(deps, itemId, 'unresolvable', outcome.reason);
      await deps.notifier.send({
        kind: 'item_failed',
        reason: outcome.reason,
        sharedText: item.rawText.slice(0, 200),
      });
      return { kind: 'settled', status: 'unresolvable' };
    }
  }

  try {
    // ─── Cheap dedupe check before spending anything ─────────────────────────
    if (await hasPlaylistEntry(db, item.accountId, videoId)) {
      await updateItem(
        db,
        itemId,
        {
          status: 'duplicate',
          resolvedVideoId: videoId,
          resolvedTier: tier,
          failureReason: 'Already in your playlist.',
        },
        clock.now().getTime(),
      );
      log.info('skipped duplicate', { videoId });
      return { kind: 'settled', status: 'duplicate' };
    }

    const video = await loadVideo(deps, videoId);

    if (video.availability !== 'available') {
      const reason =
        video.availability === 'private'
          ? 'That video is private, so it cannot be added to a playlist.'
          : video.availability === 'deleted'
            ? 'That video has been deleted or does not exist.'
            : 'That video is blocked in some regions and may not play for you.';

      // A region-blocked video is still addable — it just may not play everywhere — so it is
      // saved with a warning rather than refused.
      if (video.availability !== 'blocked') {
        await updateItem(
          db,
          itemId,
          {
            status: 'blocked',
            resolvedVideoId: videoId,
            resolvedTier: tier,
            failureReason: reason,
          },
          clock.now().getTime(),
        );
        await deps.notifier.send({
          kind: 'item_failed',
          reason,
          sharedText: item.rawText.slice(0, 200),
        });
        log.info('video unavailable', { videoId, availability: video.availability });
        return { kind: 'settled', status: 'blocked' };
      }
      log.warn('adding a region-blocked video', { videoId });
    }

    const playlist = await deps.playlists.ensure(item.accountId);
    const added = await claimAndAdd(deps, {
      itemId,
      accountId: item.accountId,
      videoId,
      playlistId: playlist.id,
    });

    if (!added) {
      await updateItem(
        db,
        itemId,
        {
          status: 'duplicate',
          resolvedVideoId: videoId,
          resolvedTier: tier,
          failureReason: 'Already in your playlist.',
        },
        clock.now().getTime(),
      );
      return { kind: 'settled', status: 'duplicate' };
    }

    await updateItem(
      db,
      itemId,
      {
        status: 'added',
        resolvedVideoId: videoId,
        resolvedTier: tier,
        confidence,
        failureReason: null,
      },
      clock.now().getTime(),
    );

    log.info('added to playlist', {
      videoId,
      playlistId: playlist.id,
      tier,
      title: video.title.slice(0, 120),
    });

    if (deps.config.notify.onSuccess) {
      await deps.notifier.send({
        kind: 'item_added',
        videoId,
        title: video.title,
        playlistName: playlist.name,
      });
    }

    return { kind: 'settled', status: 'added' };
  } catch (error) {
    return await handleFailure(deps, itemId, videoId, tier, error);
  }
}

/**
 * Claim the video, then add it. Order matters.
 *
 * The database row is inserted *before* the YouTube call, because the unique constraint is
 * the only thing preventing a double-add — YouTube itself stopped rejecting duplicate
 * inserts in 2016. Two concurrent runs both call this; exactly one wins the insert and only
 * that one spends 50 units.
 *
 * If the YouTube call then fails, the claim is rolled back. Leaving it would mark the video
 * as saved when it is not, which is the one outcome worse than a duplicate.
 */
async function claimAndAdd(
  deps: ResolveDeps,
  input: { itemId: string; accountId: string; videoId: string; playlistId: string },
): Promise<boolean> {
  const { db, clock, logger } = deps;
  const now = clock.now().getTime();

  const claimed = await recordPlaylistEntry(
    db,
    {
      accountId: input.accountId,
      videoId: input.videoId,
      playlistId: input.playlistId,
      itemId: input.itemId,
    },
    now,
  );
  if (!claimed) return false;

  try {
    const { playlistItemId } = await deps.youtube.addToPlaylist(input.playlistId, input.videoId);
    // Re-record with YouTube's own item ID so the entry can be removed later if needed.
    await deletePlaylistEntry(db, input.accountId, input.videoId);
    await recordPlaylistEntry(
      db,
      {
        accountId: input.accountId,
        videoId: input.videoId,
        playlistId: input.playlistId,
        playlistItemId,
        itemId: input.itemId,
      },
      now,
    );
    return true;
  } catch (error) {
    await deletePlaylistEntry(db, input.accountId, input.videoId);
    logger.debug('rolled back playlist claim after a failed insert', {
      videoId: input.videoId,
    });

    // A missing playlist means the user deleted it. Re-resolve once and retry, which turns a
    // confusing hard failure into a self-healing one.
    if (error instanceof YouTubeError && error.kind === 'not_found') {
      const fresh = await deps.playlists.ensure(input.accountId, { force: true });
      if (fresh.id !== input.playlistId) {
        logger.info('playlist had gone; re-created and retrying', { playlistId: fresh.id });
        return await claimAndAdd(deps, { ...input, playlistId: fresh.id });
      }
    }
    throw error;
  }
}

/** Look up video metadata, preferring the cache so nothing is ever fetched twice. */
async function loadVideo(deps: ResolveDeps, videoId: string): Promise<YouTubeVideo> {
  const cached = (await getCachedVideos(deps.db, [videoId]))[0];
  if (cached) {
    return {
      videoId: cached.videoId,
      title: cached.title ?? '',
      channelTitle: cached.channelTitle ?? '',
      channelId: cached.channelId ?? '',
      durationSeconds: cached.durationSeconds,
      availability: cached.availability,
    };
  }

  const fetched = (await deps.youtube.getVideos([videoId]))[0];
  if (!fetched) {
    return {
      videoId,
      title: '',
      channelTitle: '',
      channelId: '',
      durationSeconds: null,
      availability: 'deleted',
    };
  }

  await putCachedVideo(
    deps.db,
    {
      videoId: fetched.videoId,
      title: fetched.title,
      channelTitle: fetched.channelTitle,
      channelId: fetched.channelId,
      durationSeconds: fetched.durationSeconds,
      availability: fetched.availability,
    },
    deps.clock.now().getTime(),
  );

  return fetched;
}

async function handleFailure(
  deps: ResolveDeps,
  itemId: string,
  videoId: string | null,
  tier: number,
  error: unknown,
): Promise<ResolveOutcome> {
  const { db, clock, logger } = deps;
  const now = clock.now().getTime();

  if (error instanceof ReauthRequiredError) {
    await updateItem(
      db,
      itemId,
      {
        status: 'parked',
        resolvedVideoId: videoId,
        resolvedTier: tier,
        failureReason: 'Waiting for Google authorisation to be renewed. Nothing has been lost.',
      },
      now,
    );
    return { kind: 'parked', reason: error.message };
  }

  if (error instanceof YouTubeError) {
    if (error.kind === 'quota_exceeded') {
      // Kept, not dropped. This is a §11 requirement and the right behaviour anyway: the
      // whole value of Later is not having to think about a share twice.
      await updateItem(
        db,
        itemId,
        {
          status: 'deferred',
          resolvedVideoId: videoId,
          resolvedTier: tier,
          failureReason: "Daily YouTube API quota reached. Queued for tomorrow — it won't be lost.",
        },
        now,
      );
      logger.warn('deferred for quota', { itemId, videoId });
      return { kind: 'deferred', reason: error.message };
    }

    if (error.kind === 'invalid_grant') {
      // Also reachable when the API itself rejects the token, not only via a refresh. The
      // account transition and the one-time notification live in the token service, so route
      // through it rather than duplicating them here — otherwise this path parks the item and
      // leaves the user with no idea why nothing is saving.
      await deps.tokens.markReauthRequired(
        (await getItemById(db, itemId))?.accountId ?? '',
        error.message,
      );
      await updateItem(
        db,
        itemId,
        {
          status: 'parked',
          resolvedVideoId: videoId,
          resolvedTier: tier,
          failureReason: 'Waiting for Google authorisation to be renewed. Nothing has been lost.',
        },
        now,
      );
      return { kind: 'parked', reason: error.message };
    }

    if (error.isRetryable) {
      return { kind: 'retry', reason: error.message };
    }

    const reason =
      error.kind === 'unwritable_playlist'
        ? error.message
        : `YouTube rejected the request: ${error.message}`;
    await updateItem(
      db,
      itemId,
      { status: 'failed', resolvedVideoId: videoId, resolvedTier: tier, failureReason: reason },
      now,
    );
    logger.error('youtube rejected the request', {
      itemId,
      videoId,
      kind: error.kind,
      status: error.status ?? null,
      reason: error.reason ?? null,
    });
    return { kind: 'settled', status: 'failed' };
  }

  // Anything else is our bug. Retry once via the job layer, then it lands in `failed` with
  // the message preserved so an issue report has something to go on.
  logger.error('unexpected pipeline error', {
    itemId,
    videoId,
    error: error instanceof Error ? error.message : String(error),
  });
  return { kind: 'retry', reason: error instanceof Error ? error.message : String(error) };
}

async function setStatus(
  deps: ResolveDeps,
  itemId: string,
  status: ItemStatus,
  reason: string,
): Promise<void> {
  await updateItem(deps.db, itemId, { status, failureReason: reason }, deps.clock.now().getTime());
}
