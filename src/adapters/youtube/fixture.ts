/**
 * Fixture YouTube client.
 *
 * This is the load-bearing piece of the "never be blocked on a console step" mandate.
 * It behaves like the real client — including quota accounting and the failure modes that
 * actually matter — so the OAuth flow, the pipeline, dedupe, quota deferral, and the
 * reauth path are all built and tested before a single credential exists.
 *
 * It is also what makes `USE_FIXTURES=true` a genuine way to try Later before deciding to
 * set up a Google Cloud project.
 *
 * Deliberate behaviours copied from the real thing:
 *  - `addToPlaylist` does NOT reject duplicates, because YouTube stopped doing so in 2016
 *  - `getVideos` omits nothing: unknown IDs come back marked unavailable, not dropped
 *  - every call costs the same units the real call would
 */

import type { PlaylistPrivacy } from '../../config.ts';
import { YouTubeError } from '../../core/errors.ts';
import { QUOTA_COSTS } from '../../core/quota.ts';
import { isUnwritableSystemPlaylist } from '../../core/types.ts';
import type { VideoAvailability } from '../../db/schema.ts';
import type {
  QuotaRecorder,
  YouTubeClient,
  YouTubePlaylist,
  YouTubeSearchResult,
  YouTubeVideo,
} from '../../ports/youtube.ts';

/** A failure the test (or a dev poking at the UI) wants the next call to produce. */
export type InjectedFailure =
  | { kind: 'invalid_grant' }
  | { kind: 'quota_exceeded' }
  | { kind: 'transient'; times?: number }
  | { kind: 'forbidden' }
  | { kind: 'not_found' };

export interface FixtureVideo {
  videoId: string;
  title: string;
  channelTitle: string;
  channelId: string;
  durationSeconds?: number;
  availability?: VideoAvailability;
}

export interface FixtureYouTubeOptions {
  videos?: FixtureVideo[];
  playlists?: YouTubePlaylist[];
  searchResults?: Record<string, YouTubeSearchResult[]>;
  quota?: QuotaRecorder;
}

export interface FixtureYouTubeClient extends YouTubeClient {
  /** Every call made, in order, with its quota cost. Assert against this. */
  readonly calls: { operation: string; units: number; detail?: string }[];
  readonly unitsSpent: number;
  /** Contents of each playlist, so tests can assert what actually got added. */
  readonly playlistContents: Map<string, string[]>;
  /** Make the next matching call fail. */
  failNext(failure: InjectedFailure): void;
  addFixtureVideo(video: FixtureVideo): void;
  /**
   * Simulate the user deleting the playlist in the YouTube app.
   *
   * Removes it from both the listing and the contents, so a subsequent insert against the
   * cached ID fails with `not_found` exactly as the real API would — which is what exercises
   * the find-or-create heal path.
   */
  removePlaylist(playlistId: string): void;
  reset(): void;
}

/**
 * A small default corpus.
 *
 * Real IDs and channel names, because the ranking code in Tier 2 compares titles and
 * channels and synthetic strings would make those tests meaningless.
 */
export const DEFAULT_FIXTURE_VIDEOS: FixtureVideo[] = [
  {
    videoId: 'dQw4w9WgXcQ',
    title: 'Rick Astley - Never Gonna Give You Up (Official Video)',
    channelTitle: 'Rick Astley',
    channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
    durationSeconds: 212,
  },
  {
    videoId: '9bZkp7q19f0',
    title: 'PSY - GANGNAM STYLE',
    channelTitle: 'officialpsy',
    channelId: 'UCrDkAvwZum-UTjHmzDI2iIw',
    durationSeconds: 253,
  },
  {
    videoId: 'a-b_cD3fGh1',
    title: 'Why Planes Really Fly',
    channelTitle: 'Veritasium',
    channelId: 'UCHnyfMqiRRG1u-2MsSQLbXA',
    durationSeconds: 900,
  },
  {
    videoId: 'privateVid1',
    title: 'Private video',
    channelTitle: 'Someone',
    channelId: 'UCprivate00000000000000',
    availability: 'private',
  },
  {
    videoId: 'blockedVid1',
    title: 'Region blocked video',
    channelTitle: 'Someone Else',
    channelId: 'UCblocked0000000000000',
    availability: 'blocked',
  },
];

/** A quota recorder that tracks a running total and enforces a budget. */
export function fixtureQuota(budget = 9000): QuotaRecorder & { spent: number } {
  const state = {
    spent: 0,
    async reserve(operation: string, units: number): Promise<void> {
      if (state.spent + units > budget) {
        throw new YouTubeError(
          'quota_exceeded',
          `Refusing ${operation}: would spend ${units} units with ${budget - state.spent} left in budget.`,
        );
      }
    },
    async record(_operation: string, units: number): Promise<void> {
      state.spent += units;
    },
  };
  return state;
}

export function createFixtureYouTubeClient(
  options: FixtureYouTubeOptions = {},
): FixtureYouTubeClient {
  const videos = new Map<string, FixtureVideo>();
  for (const video of options.videos ?? DEFAULT_FIXTURE_VIDEOS) videos.set(video.videoId, video);

  let playlists: YouTubePlaylist[] = [...(options.playlists ?? [])];
  const playlistContents = new Map<string, string[]>();
  for (const playlist of playlists) playlistContents.set(playlist.id, []);

  const searchResults = options.searchResults ?? {};
  const calls: { operation: string; units: number; detail?: string }[] = [];
  const pendingFailures: InjectedFailure[] = [];
  let unitsSpent = 0;
  let playlistCounter = 0;
  let itemCounter = 0;

  function throwInjected(): void {
    const failure = pendingFailures[0];
    if (!failure) return;

    if (failure.kind === 'transient') {
      const remaining = (failure.times ?? 1) - 1;
      if (remaining <= 0) pendingFailures.shift();
      else pendingFailures[0] = { kind: 'transient', times: remaining };
      throw new YouTubeError('transient', 'Injected transient failure (HTTP 503)', { status: 503 });
    }

    pendingFailures.shift();
    switch (failure.kind) {
      case 'invalid_grant':
        throw new YouTubeError(
          'invalid_grant',
          'Injected invalid_grant: refresh token revoked or expired.',
          { status: 400, reason: 'invalid_grant' },
        );
      case 'quota_exceeded':
        throw new YouTubeError('quota_exceeded', 'Injected quotaExceeded.', {
          status: 403,
          reason: 'quotaExceeded',
        });
      case 'forbidden':
        throw new YouTubeError('forbidden', 'Injected forbidden.', { status: 403 });
      case 'not_found':
        throw new YouTubeError('not_found', 'Injected not_found.', { status: 404 });
    }
  }

  async function spend(operation: string, units: number, detail?: string): Promise<void> {
    throwInjected();
    await options.quota?.reserve(operation, units);
    await options.quota?.record(operation, units);
    unitsSpent += units;
    calls.push(detail === undefined ? { operation, units } : { operation, units, detail });
  }

  const client: FixtureYouTubeClient = {
    calls,
    get unitsSpent() {
      return unitsSpent;
    },
    playlistContents,

    failNext(failure) {
      pendingFailures.push(failure);
    },

    addFixtureVideo(video) {
      videos.set(video.videoId, video);
    },

    removePlaylist(playlistId) {
      playlists = playlists.filter((playlist) => playlist.id !== playlistId);
      playlistContents.delete(playlistId);
    },

    reset() {
      calls.length = 0;
      pendingFailures.length = 0;
      unitsSpent = 0;
    },

    async getVideos(videoIds) {
      // One unit regardless of how many IDs — the real API charges per call, not per ID.
      await spend('videos.list', QUOTA_COSTS['videos.list'], videoIds.join(','));

      return videoIds.map((videoId): YouTubeVideo => {
        const fixture = videos.get(videoId);
        if (!fixture) {
          // Unknown IDs are reported as deleted rather than omitted, so the caller can
          // tell the user why their share did not land.
          return {
            videoId,
            title: '',
            channelTitle: '',
            channelId: '',
            durationSeconds: null,
            availability: 'deleted',
          };
        }
        return {
          videoId,
          title: fixture.title,
          channelTitle: fixture.channelTitle,
          channelId: fixture.channelId,
          durationSeconds: fixture.durationSeconds ?? null,
          availability: fixture.availability ?? 'available',
        };
      });
    },

    async listMyPlaylists() {
      await spend('playlists.list', QUOTA_COSTS['playlists.list']);
      return [...playlists];
    },

    async createPlaylist(title: string, _privacy: PlaylistPrivacy) {
      await spend('playlists.insert', QUOTA_COSTS['playlists.insert'], title);
      playlistCounter += 1;
      const playlist: YouTubePlaylist = { id: `PLfixture${playlistCounter}`, title };
      playlists = [...playlists, playlist];
      playlistContents.set(playlist.id, []);
      return playlist;
    },

    async addToPlaylist(playlistId: string, videoId: string) {
      // Refuse the system playlists in the fixture too, so the invariant is exercised by
      // tests rather than only asserted in a document.
      if (isUnwritableSystemPlaylist(playlistId)) {
        throw new YouTubeError(
          'unwritable_playlist',
          `Refusing to write to system playlist "${playlistId}". Google removed API access ` +
            'to Watch Later on 2016-09-12; see docs/adr/0004-watch-later-is-unreachable.md.',
        );
      }

      await spend('playlistItems.insert', QUOTA_COSTS['playlistItems.insert'], videoId);

      if (!playlistContents.has(playlistId)) {
        throw new YouTubeError('not_found', `Playlist ${playlistId} does not exist.`, {
          status: 404,
        });
      }

      // Deliberately permits duplicates, exactly as the real API now does.
      playlistContents.get(playlistId)?.push(videoId);
      itemCounter += 1;
      return { playlistItemId: `PLI${itemCounter}` };
    },

    async listPlaylistVideoIds(playlistId: string) {
      await spend('playlistItems.list', QUOTA_COSTS['playlistItems.list'], playlistId);
      return [...(playlistContents.get(playlistId) ?? [])];
    },

    async search(query: string, maxResults = 5) {
      await spend('search.list', QUOTA_COSTS['search.list'], query);
      return (searchResults[query] ?? searchResults['*'] ?? []).slice(0, maxResults);
    },
  };

  return client;
}
