/**
 * Finding or creating the destination playlist.
 *
 * This is **not** the native Watch Later queue, and cannot be: Google removed API access to
 * `WL` on 2016-09-12. Later creates and owns a normal playlist instead. See
 * docs/adr/0004-watch-later-is-unreachable.md.
 *
 * The playlist ID is cached on the account, but never assumed to still exist — the user can
 * delete or rename it in the YouTube app at any moment, so callers can force a re-resolve.
 */

import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { getAccountById, setAccountPlaylist } from '../db/repo.ts';
import type { Clock } from '../ports/clock.ts';
import type { Logger } from '../ports/logger.ts';
import type { YouTubeClient } from '../ports/youtube.ts';

export interface ResolvedPlaylist {
  id: string;
  name: string;
}

export interface PlaylistService {
  /**
   * The account's destination playlist.
   *
   * `force: true` skips the cached ID and re-runs find-or-create — used after an insert
   * fails with `not_found`, which is what a user deleting the playlist looks like.
   */
  ensure(accountId: string, options?: { force?: boolean }): Promise<ResolvedPlaylist>;
}

export function createPlaylistService(deps: {
  db: Db;
  config: Config;
  clock: Clock;
  logger: Logger;
  youtube: YouTubeClient;
}): PlaylistService {
  const { db, config, clock, logger, youtube } = deps;
  const wantedName = config.playlist.name;

  return {
    async ensure(accountId, options = {}): Promise<ResolvedPlaylist> {
      const account = await getAccountById(db, accountId);
      if (!account) throw new Error(`account ${accountId} not found`);

      if (!options.force && account.playlistId && account.playlistName === wantedName) {
        return { id: account.playlistId, name: account.playlistName };
      }

      // 1 unit. Cheap enough to be worth doing rather than guessing.
      const existing = await youtube.listMyPlaylists();
      const match = existing.find(
        (playlist) => playlist.title.trim().toLowerCase() === wantedName.trim().toLowerCase(),
      );

      if (match) {
        await setAccountPlaylist(db, accountId, match.id, wantedName, clock.now().getTime());
        logger.info('using existing playlist', {
          accountId,
          playlistId: match.id,
          name: wantedName,
        });
        return { id: match.id, name: wantedName };
      }

      // 50 units, once per account for the lifetime of the deployment.
      const created = await youtube.createPlaylist(wantedName, config.playlist.privacy);
      await setAccountPlaylist(db, accountId, created.id, wantedName, clock.now().getTime());
      logger.info('created playlist', {
        accountId,
        playlistId: created.id,
        name: wantedName,
        privacy: config.playlist.privacy,
      });
      return { id: created.id, name: wantedName };
    },
  };
}

/** Deep link that opens the playlist, preferring the native app on mobile. */
export function playlistUrl(playlistId: string): string {
  return `https://www.youtube.com/playlist?list=${playlistId}`;
}
