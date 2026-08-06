/**
 * The real YouTube Data API v3 client.
 *
 * Plain `fetch` against the REST endpoints — no SDK, because the Google client libraries are
 * Node-oriented and this code has to run on Cloudflare Workers too.
 *
 * Every method goes through `call()`, which reserves quota *before* spending and records it
 * after. That ordering is deliberate: over-counting a failed call is safe, under-counting is
 * how a deployment blows through Google's hard limit and fails mid-operation.
 */

import type { PlaylistPrivacy } from '../../config.ts';
import { classifyGoogleError, YouTubeError } from '../../core/errors.ts';
import { QUOTA_COSTS, type YouTubeOperation } from '../../core/quota.ts';
import { isUnwritableSystemPlaylist } from '../../core/types.ts';
import type { VideoAvailability } from '../../db/schema.ts';
import type {
  QuotaRecorder,
  YouTubeClient,
  YouTubePlaylist,
  YouTubeSearchResult,
  YouTubeVideo,
} from '../../ports/youtube.ts';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

export interface GoogleYouTubeClientOptions {
  /** Returns a currently-valid access token, refreshing it if necessary. */
  getAccessToken: () => Promise<string>;
  quota: QuotaRecorder;
  fetch?: typeof fetch;
}

export function createGoogleYouTubeClient(options: GoogleYouTubeClientOptions): YouTubeClient {
  const fetchImpl = options.fetch ?? fetch;

  async function call<T>(
    operation: YouTubeOperation,
    path: string,
    init: { method?: string; query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const units = QUOTA_COSTS[operation];
    await options.quota.reserve(operation, units);

    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const accessToken = await options.getAccessToken();

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (cause) {
      // The request never landed, so nothing was spent.
      throw new YouTubeError('transient', `Network failure calling ${operation}.`, { cause });
    }

    // Recorded even on failure: Google charges for calls that return 4xx.
    await options.quota.record(operation, units);

    const payload = await safeJson(response);
    if (!response.ok) throw classifyGoogleError(response.status, payload);
    return payload as T;
  }

  return {
    async getVideos(videoIds: string[]): Promise<YouTubeVideo[]> {
      if (videoIds.length === 0) return [];

      const data = await call<VideoListResponse>('videos.list', '/videos', {
        query: {
          part: 'snippet,contentDetails,status',
          id: videoIds.join(','),
          maxResults: '50',
        },
      });

      const found = new Map<string, YouTubeVideo>();
      for (const raw of data.items ?? []) {
        if (!raw.id) continue;
        found.set(raw.id, {
          videoId: raw.id,
          title: raw.snippet?.title ?? '',
          channelTitle: raw.snippet?.channelTitle ?? '',
          channelId: raw.snippet?.channelId ?? '',
          durationSeconds: parseIso8601Duration(raw.contentDetails?.duration),
          availability: availabilityOf(raw),
        });
      }

      // IDs absent from the response are reported as deleted rather than dropped, so the
      // user is told *why* their share did not land instead of it silently vanishing.
      return videoIds.map(
        (videoId) =>
          found.get(videoId) ?? {
            videoId,
            title: '',
            channelTitle: '',
            channelId: '',
            durationSeconds: null,
            availability: 'deleted' as VideoAvailability,
          },
      );
    },

    async listMyPlaylists(): Promise<YouTubePlaylist[]> {
      const out: YouTubePlaylist[] = [];
      let pageToken: string | undefined;

      do {
        const data = await call<PlaylistListResponse>('playlists.list', '/playlists', {
          query: {
            part: 'snippet',
            mine: 'true',
            maxResults: '50',
            ...(pageToken ? { pageToken } : {}),
          },
        });
        for (const raw of data.items ?? []) {
          if (raw.id) out.push({ id: raw.id, title: raw.snippet?.title ?? '' });
        }
        pageToken = data.nextPageToken;
      } while (pageToken);

      return out;
    },

    async createPlaylist(title: string, privacy: PlaylistPrivacy): Promise<YouTubePlaylist> {
      const data = await call<PlaylistResource>('playlists.insert', '/playlists', {
        method: 'POST',
        query: { part: 'snippet,status' },
        body: {
          snippet: {
            title,
            description:
              'Created by Later (https://github.com/alepotger/Later). Videos shared from ' +
              'your phone land here.',
          },
          status: { privacyStatus: privacy },
        },
      });
      if (!data.id) throw new YouTubeError('client_error', 'playlists.insert returned no id.');
      return { id: data.id, title: data.snippet?.title ?? title };
    },

    async addToPlaylist(playlistId: string, videoId: string) {
      // Refuse the system playlists before spending a request. Google removed API access to
      // Watch Later on 2016-09-12; an insert here would fail anyway, and failing loudly with
      // an explanation is far more useful than a generic 404.
      // See docs/adr/0004-watch-later-is-unreachable.md.
      if (isUnwritableSystemPlaylist(playlistId)) {
        throw new YouTubeError(
          'unwritable_playlist',
          `Cannot write to the system playlist "${playlistId}". Google removed API access to ` +
            'Watch Later on 2016-09-12 and it cannot be restored by any OAuth scope. Later ' +
            'writes to a dedicated playlist it creates instead.',
        );
      }

      const data = await call<PlaylistItemResource>('playlistItems.insert', '/playlistItems', {
        method: 'POST',
        query: { part: 'snippet' },
        body: {
          snippet: {
            playlistId,
            resourceId: { kind: 'youtube#video', videoId },
          },
        },
      });
      if (!data.id) throw new YouTubeError('client_error', 'playlistItems.insert returned no id.');
      return { playlistItemId: data.id };
    },

    async listPlaylistVideoIds(playlistId: string): Promise<string[]> {
      const out: string[] = [];
      let pageToken: string | undefined;

      do {
        const data = await call<PlaylistItemListResponse>('playlistItems.list', '/playlistItems', {
          query: {
            part: 'contentDetails',
            playlistId,
            maxResults: '50',
            ...(pageToken ? { pageToken } : {}),
          },
        });
        for (const raw of data.items ?? []) {
          const id = raw.contentDetails?.videoId;
          if (id) out.push(id);
        }
        pageToken = data.nextPageToken;
      } while (pageToken);

      return out;
    },

    async search(query: string, maxResults = 5): Promise<YouTubeSearchResult[]> {
      // 100 units — the most expensive thing Later can do, and never reached when a URL is
      // present in the share. See docs/adr/0006-quota-strategy.md.
      const data = await call<SearchListResponse>('search.list', '/search', {
        query: {
          part: 'snippet',
          q: query,
          type: 'video',
          maxResults: String(Math.min(Math.max(maxResults, 1), 25)),
        },
      });

      const out: YouTubeSearchResult[] = [];
      for (const raw of data.items ?? []) {
        const videoId = raw.id?.videoId;
        if (!videoId) continue;
        out.push({
          videoId,
          title: raw.snippet?.title ?? '',
          channelTitle: raw.snippet?.channelTitle ?? '',
          channelId: raw.snippet?.channelId ?? '',
        });
      }
      return out;
    },
  };
}

function availabilityOf(raw: VideoResource): VideoAvailability {
  const privacy = raw.status?.privacyStatus;
  if (privacy === 'private') return 'private';

  // `uploadStatus` covers deleted, rejected, and failed uploads.
  const upload = raw.status?.uploadStatus;
  if (upload === 'deleted' || upload === 'rejected' || upload === 'failed') return 'deleted';

  // A video with region restrictions is still addable to a playlist; it just may not play
  // where the user is. Recorded so the UI can say so rather than pretending all is well.
  const blocked = raw.contentDetails?.regionRestriction?.blocked;
  if (blocked && blocked.length > 0) return 'blocked';

  return 'available';
}

/** Parse YouTube's ISO-8601 durations (`PT1H2M3S`, `PT45S`, `P1DT2H`). */
export function parseIso8601Duration(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  if (!days && !hours && !minutes && !seconds) return null;
  return (
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Math.round(Number(seconds ?? 0))
  );
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

// ─── Minimal response shapes ─────────────────────────────────────────────────
// Only the fields Later reads. Everything is optional because the API omits parts we did
// not request, and a missing field must never throw.

interface VideoResource {
  id?: string;
  snippet?: { title?: string; channelTitle?: string; channelId?: string };
  contentDetails?: { duration?: string; regionRestriction?: { blocked?: string[] } };
  status?: { privacyStatus?: string; uploadStatus?: string };
}
interface VideoListResponse {
  items?: VideoResource[];
}
interface PlaylistResource {
  id?: string;
  snippet?: { title?: string };
}
interface PlaylistListResponse {
  items?: PlaylistResource[];
  nextPageToken?: string;
}
interface PlaylistItemResource {
  id?: string;
}
interface PlaylistItemListResponse {
  items?: { contentDetails?: { videoId?: string } }[];
  nextPageToken?: string;
}
interface SearchListResponse {
  items?: {
    id?: { videoId?: string };
    snippet?: { title?: string; channelTitle?: string; channelId?: string };
  }[];
}
