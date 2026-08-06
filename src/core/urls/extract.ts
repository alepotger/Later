/**
 * Tier 0: everything we can learn from shared text without spending a request.
 *
 * Given whatever the share sheet produced, find the YouTube videos being recommended.
 * Costs nothing, is fully deterministic, and handles the majority of real shares.
 */

import type { ChannelRef, Extraction, PlatformLink, PlaylistRef, VideoRef } from '../types.ts';
import { findUrlCandidates, hostOf, toUrl } from './find.ts';
import { isInstagramHost, isTikTokHost, isYouTubeHost } from './hosts.ts';
import { unwrapRedirects } from './redirectors.ts';
import { normaliseText } from './text.ts';
import { classifyYouTubeUrl } from './youtube.ts';

/** TikTok hosts whose URLs are opaque until followed. */
const TIKTOK_SHORTLINK_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);

function classifyPlatformUrl(url: URL): PlatformLink | null {
  const host = hostOf(url);

  if (isTikTokHost(host)) {
    const isShortlink = TIKTOK_SHORTLINK_HOSTS.has(host) || url.pathname.startsWith('/t/');
    return { platform: 'tiktok', url: url.toString(), isShortlink };
  }

  if (isInstagramHost(host)) {
    // Instagram share URLs carry the shortcode in the path (`/reel/<code>`), so they are
    // never opaque in the way a TikTok `vm.` link is.
    return { platform: 'instagram', url: url.toString(), isShortlink: false };
  }

  return null;
}

/**
 * Extract every YouTube video referenced by a share.
 *
 * Deduplication is by video ID, keeping the first occurrence — a caption that mentions
 * the same video twice produces one playlist entry, and the first mention is the one
 * most likely to carry the timestamp the sharer meant.
 */
export function extractFromText(rawText: string): Extraction {
  const text = normaliseText(rawText);

  const videos = new Map<string, VideoRef>();
  const playlists = new Map<string, PlaylistRef>();
  const channels = new Map<string, ChannelRef>();
  const platformLinks = new Map<string, PlatformLink>();
  const otherUrls = new Set<string>();

  for (const candidate of findUrlCandidates(text)) {
    const parsed = toUrl(candidate);
    if (!parsed) continue;

    const url = unwrapRedirects(parsed);
    const host = hostOf(url);

    if (isYouTubeHost(host)) {
      const hit = classifyYouTubeUrl(url);
      if (!hit) {
        // A YouTube link that isn't a video: a search page, a channel feed, a post.
        otherUrls.add(url.toString());
        continue;
      }
      if (hit.kind === 'video') {
        if (!videos.has(hit.ref.videoId)) videos.set(hit.ref.videoId, hit.ref);
      } else if (hit.kind === 'playlist') {
        if (!playlists.has(hit.ref.playlistId)) playlists.set(hit.ref.playlistId, hit.ref);
      } else if (!channels.has(hit.ref.ref)) {
        channels.set(hit.ref.ref, hit.ref);
      }
      continue;
    }

    const platform = classifyPlatformUrl(url);
    if (platform) {
      if (!platformLinks.has(platform.url)) platformLinks.set(platform.url, platform);
      continue;
    }

    otherUrls.add(url.toString());
  }

  return {
    videos: [...videos.values()],
    playlists: [...playlists.values()],
    channels: [...channels.values()],
    platformLinks: [...platformLinks.values()],
    otherUrls: [...otherUrls],
  };
}

/** True when Tier 0 found at least one video and no further tier is needed. */
export function hasVideos(extraction: Extraction): boolean {
  return extraction.videos.length > 0;
}
