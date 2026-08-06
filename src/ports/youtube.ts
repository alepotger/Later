/**
 * The YouTube port.
 *
 * Two implementations ship: a real REST client, and a fixture client backed by recorded
 * responses with injectable failures. The fixture one is not a testing afterthought — it
 * is what makes §9's mandate real, letting the entire pipeline (including `invalid_grant`
 * and quota exhaustion) be built and tested before any credential exists.
 *
 * Every method declares its quota cost through the client, so an untracked call is a type
 * error rather than an oversight. See docs/adr/0006-quota-strategy.md.
 */

import type { PlaylistPrivacy } from '../config.ts';
import type { VideoAvailability } from '../db/schema.ts';

export interface YouTubeVideo {
  videoId: string;
  title: string;
  channelTitle: string;
  channelId: string;
  durationSeconds: number | null;
  availability: VideoAvailability;
}

export interface YouTubePlaylist {
  id: string;
  title: string;
}

export interface YouTubeSearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
  channelId: string;
}

export interface YouTubeClient {
  /**
   * Look up videos by ID. 1 unit per call regardless of how many IDs, so batch freely.
   *
   * IDs that are missing from the response are returned with an `availability` other than
   * `available` rather than being silently dropped — a deleted video is information, and
   * the user is told why their share did not land.
   */
  getVideos(videoIds: string[]): Promise<YouTubeVideo[]>;

  /** The authorised account's own playlists. Used by find-or-create. */
  listMyPlaylists(): Promise<YouTubePlaylist[]>;

  createPlaylist(title: string, privacy: PlaylistPrivacy): Promise<YouTubePlaylist>;

  /**
   * Add a video to a playlist. 50 units.
   *
   * Note that YouTube will happily add a duplicate — it stopped rejecting them in 2016 —
   * so callers must check first. See docs/adr/0004-watch-later-is-unreachable.md.
   */
  addToPlaylist(playlistId: string, videoId: string): Promise<{ playlistItemId: string }>;

  /** Video IDs already in a playlist. 1 unit per page. */
  listPlaylistVideoIds(playlistId: string): Promise<string[]>;

  /** 100 units. Never call this when a URL is already present in the share. */
  search(query: string, maxResults?: number): Promise<YouTubeSearchResult[]>;
}

/**
 * Records what an operation cost, so the ledger reflects reality rather than intent.
 *
 * The real client reports actual calls made (including extra pages); the fixture client
 * reports the same numbers so quota-exhaustion tests are meaningful.
 */
export interface QuotaRecorder {
  record(operation: string, units: number): Promise<void>;
  /** Refuse before spending. Throws a `quota_exceeded` YouTubeError when over budget. */
  reserve(operation: string, units: number): Promise<void>;
}
