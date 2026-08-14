/**
 * Turning a YouTube URL into a video ID.
 *
 * This is Tier 0, and it is the highest-value code in the project: it resolves the
 * majority of real shares for zero API quota. Every URL shape it fails to recognise
 * becomes either a 100-unit `search.list` or an item the user has to confirm by hand,
 * so the fixtures for this module are deliberately exhaustive.
 */

import type { ChannelRef, PlaylistRef, VideoRef } from '../types.ts';
import { isPlaylistId, isVideoId, watchUrl } from '../types.ts';
import { hostOf } from './find.ts';
import { isYouTubeHost } from './hosts.ts';

export type YouTubeHit =
  | { kind: 'video'; ref: VideoRef }
  | { kind: 'playlist'; ref: PlaylistRef }
  | { kind: 'channel'; ref: ChannelRef };

/** Path prefixes that carry the video ID as the next segment. */
const ID_IN_PATH = new Set(['shorts', 'live', 'embed', 'v', 'e']);

const TIME_KEYS = ['t', 'start', 'time_continue'] as const;

/**
 * Parse a YouTube time offset.
 *
 * Accepts the three forms YouTube itself emits: bare seconds (`42`), suffixed seconds
 * (`42s`), and compound (`1h2m3s`, `1m30s`).
 */
export function parseTimeOffset(raw: string): number | undefined {
  const value = raw.trim().toLowerCase();
  if (value === '') return undefined;
  if (/^\d+$/.test(value)) return Number(value);

  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match) return undefined;
  const [, hours, minutes, seconds] = match;
  if (hours === undefined && minutes === undefined && seconds === undefined) return undefined;

  return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}

function startSecondsFrom(...sources: URLSearchParams[]): number | undefined {
  for (const params of sources) {
    for (const key of TIME_KEYS) {
      const raw = params.get(key);
      if (raw === null) continue;
      const parsed = parseTimeOffset(raw);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Split a path segment that has query junk glued onto it.
 *
 * `youtu.be/dQw4w9WgXcQ&t=42` appears in the wild — an ampersand where there should be
 * a question mark. The URL parser reads the whole thing as one path segment, so the ID
 * and the timestamp both have to be recovered by hand.
 */
function splitIdAndTail(segment: string): { id: string; tail: URLSearchParams } {
  const cut = segment.search(/[&?]/);
  if (cut === -1) return { id: segment, tail: new URLSearchParams() };
  return {
    id: segment.slice(0, cut),
    tail: new URLSearchParams(segment.slice(cut + 1)),
  };
}

function videoHit(videoId: string, url: URL, tail: URLSearchParams): YouTubeHit {
  const start = startSecondsFrom(url.searchParams, tail);
  const ref: VideoRef = {
    videoId,
    // Rebuilt from the ID, so tracking parameters cannot survive by construction.
    canonicalUrl: watchUrl(videoId),
    sourceUrl: url.toString(),
  };
  if (start !== undefined) ref.startSeconds = start;
  return { kind: 'video', ref };
}

/**
 * Classify a YouTube URL.
 *
 * Returns null for YouTube pages that are not a video, playlist, or channel — a search
 * results page, the subscriptions feed, a Community post. The caller reports those as
 * "found a link, but it isn't a video", which is a more useful failure than silence.
 */
export function classifyYouTubeUrl(url: URL): YouTubeHit | null {
  const host = hostOf(url);
  if (!isYouTubeHost(host)) return null;

  const segments = url.pathname.split('/').filter((s) => s.length > 0);

  // youtu.be/<id> — the entire path is the ID.
  if (host === 'youtu.be') {
    const first = segments[0];
    if (!first) return null;
    const { id, tail } = splitIdAndTail(first);
    return isVideoId(id) ? videoHit(id, url, tail) : null;
  }

  const first = segments[0];
  if (!first) return null;
  const kind = safeDecode(first).toLowerCase();

  if (kind === 'watch') {
    const v = url.searchParams.get('v');
    // `watch?v=ID&list=PL...` is a video that happens to sit in a playlist. The user
    // shared the video, so the list is deliberately ignored.
    return v && isVideoId(v) ? videoHit(v, url, new URLSearchParams()) : null;
  }

  if (ID_IN_PATH.has(kind)) {
    const second = segments[1];
    if (!second) return null;
    const { id, tail } = splitIdAndTail(second);

    // `embed/videoseries?list=PL...` is a playlist embed, not a video.
    if (id.toLowerCase() === 'videoseries') {
      const list = url.searchParams.get('list');
      return list && isPlaylistId(list)
        ? { kind: 'playlist', ref: { playlistId: list, sourceUrl: url.toString() } }
        : null;
    }

    return isVideoId(id) ? videoHit(id, url, tail) : null;
  }

  if (kind === 'playlist') {
    const list = url.searchParams.get('list');
    return list && isPlaylistId(list)
      ? { kind: 'playlist', ref: { playlistId: list, sourceUrl: url.toString() } }
      : null;
  }

  const decodedFirst = safeDecode(first);
  if (decodedFirst.startsWith('@') && decodedFirst.length > 1) {
    return { kind: 'channel', ref: { ref: decodedFirst, sourceUrl: url.toString() } };
  }
  if (kind === 'channel' || kind === 'c' || kind === 'user') {
    const name = segments[1];
    if (name) {
      return { kind: 'channel', ref: { ref: safeDecode(name), sourceUrl: url.toString() } };
    }
  }

  return null;
}
