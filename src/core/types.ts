/**
 * Core domain types.
 *
 * Everything in `src/core` is pure: plain data in, plain data out. No network, no
 * database, no clock, no environment. That is what makes the interesting logic in
 * this project testable with zero credentials.
 */

/** A YouTube video we are confident about, normalised to its ID. */
export interface VideoRef {
  /** Canonical 11-character YouTube video ID. */
  videoId: string;
  /**
   * Canonical watch URL, rebuilt from the ID alone.
   *
   * Rebuilding rather than cleaning is deliberate: tracking parameters cannot
   * survive a URL constructed from an allowlist of things we understand.
   */
  canonicalUrl: string;
  /** Start offset in seconds, if the share carried a timestamp. */
  startSeconds?: number;
  /** The URL as it appeared in the share, after any redirector was unwrapped. */
  sourceUrl: string;
}

export interface PlaylistRef {
  playlistId: string;
  sourceUrl: string;
}

export interface ChannelRef {
  /** Handle (`@veritasium`), channel ID (`UC...`), or legacy user/custom name. */
  ref: string;
  sourceUrl: string;
}

export type SocialPlatform = 'tiktok' | 'instagram';

/** A TikTok or Instagram link whose caption may name a YouTube video (Tier 1). */
export interface PlatformLink {
  platform: SocialPlatform;
  url: string;
  /** True when the URL must be followed through a redirect before it means anything. */
  isShortlink: boolean;
}

/**
 * Everything Tier 0 could find in a share.
 *
 * The shape deliberately distinguishes "no URLs at all" (Tier 1/2 territory) from
 * "URLs, but none of them a video" (which lets the pipeline say something specific
 * about why it failed instead of just shrugging).
 */
export interface Extraction {
  /** Videos in order of first appearance, deduplicated by ID. */
  videos: VideoRef[];
  playlists: PlaylistRef[];
  channels: ChannelRef[];
  platformLinks: PlatformLink[];
  /** URLs we found but could not turn into a video, including unrecognised YouTube pages. */
  otherUrls: string[];
}

export const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isVideoId(value: string): boolean {
  return YOUTUBE_VIDEO_ID_RE.test(value);
}

/** YouTube playlist IDs vary in length and prefix (`PL`, `UU`, `FL`, `OL`, `RD`, ...). */
export function isPlaylistId(value: string): boolean {
  return /^[A-Za-z0-9_-]{12,64}$/.test(value);
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * The two system playlists Google removed API access to on 2016-09-12.
 *
 * Kept here, next to the ID helpers, so the constraint travels with the code that
 * handles playlist IDs rather than living only in a document. See
 * docs/adr/0004-watch-later-is-unreachable.md.
 */
export const UNWRITABLE_SYSTEM_PLAYLISTS = new Set(['WL', 'HL', 'LL']);

export function isUnwritableSystemPlaylist(playlistId: string): boolean {
  return UNWRITABLE_SYSTEM_PLAYLISTS.has(playlistId.toUpperCase());
}
