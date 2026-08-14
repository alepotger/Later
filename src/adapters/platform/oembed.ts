/**
 * Tier 1: read a TikTok or Instagram caption via public oEmbed.
 *
 * Costs no YouTube quota at all, so it sits between the free regex (Tier 0) and the expensive
 * search (Tier 2). The common win is large: a Reel whose caption contains a YouTube link is
 * resolved for zero units once the caption is in hand.
 *
 * Official public endpoints only — no scraping, no cookie replay. Where a platform does not
 * permit something, Later ships a documented limitation instead. See SECURITY.md.
 *
 * On Instagram: Meta required an access token and App Review from October 2020, and appears to
 * have reversed that in June 2026. Rather than betting either way, the token here is optional —
 * tokenless is tried first, a token is used if configured, and any failure degrades to Tier 2.
 * See docs/verification-log.md.
 */

import type { SocialPlatform } from '../../core/types.ts';
import type { Logger } from '../../ports/logger.ts';

const TIKTOK_OEMBED = 'https://www.tiktok.com/oembed';
const INSTAGRAM_OEMBED = 'https://graph.facebook.com/v21.0/instagram_oembed';

const TIMEOUT_MS = 8000;

export interface PlatformMetadata {
  /** Caption or title text — fed straight back into Tier 0 to look for a YouTube link. */
  text: string;
  authorName?: string | undefined;
  /** The canonical URL, when a shortlink was resolved to one. */
  resolvedUrl?: string | undefined;
}

export interface PlatformMetadataPort {
  fetchMetadata(url: string, platform: SocialPlatform): Promise<PlatformMetadata | null>;
}

export interface OEmbedOptions {
  logger: Logger;
  fetch?: typeof fetch;
  /** Optional. Instagram may grant higher rate limits with one; it is not required. */
  instagramToken?: string | undefined;
}

export function createOEmbedClient(options: OEmbedOptions): PlatformMetadataPort {
  const fetchImpl = options.fetch ?? fetch;

  async function getJson(url: string): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        options.logger.debug('oembed returned a non-ok status', { status: response.status });
        return null;
      }
      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      options.logger.debug('oembed request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async fetchMetadata(url: string, platform: SocialPlatform): Promise<PlatformMetadata | null> {
      const endpoint =
        platform === 'tiktok'
          ? `${TIKTOK_OEMBED}?url=${encodeURIComponent(url)}`
          : `${INSTAGRAM_OEMBED}?url=${encodeURIComponent(url)}&omitscript=true` +
            (options.instagramToken
              ? `&access_token=${encodeURIComponent(options.instagramToken)}`
              : '');

      const payload = await getJson(endpoint);
      if (!payload) return null;

      // TikTok puts the caption in `title`. Instagram uses `title` too, and omits it entirely
      // for posts with no caption — which is a normal outcome, not an error.
      const title = typeof payload.title === 'string' ? payload.title : '';
      const authorName = typeof payload.author_name === 'string' ? payload.author_name : undefined;

      if (title === '' && !authorName) return null;

      return { text: title, authorName };
    },
  };
}

/**
 * Follow a shortlink to its destination without fetching the page body.
 *
 * `vm.tiktok.com` and `vt.tiktok.com` links are opaque, and oEmbed needs the canonical URL.
 * A HEAD request with redirects followed is the cheapest way to get it.
 */
export async function resolveShortlink(
  url: string,
  deps: { logger: Logger; fetch?: typeof fetch },
): Promise<string | null> {
  const fetchImpl = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    // `response.url` is the final URL after redirects.
    const finalUrl = response.url;
    if (!finalUrl || finalUrl === url) return null;
    return finalUrl;
  } catch (error) {
    deps.logger.debug('shortlink resolution failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Records calls and returns canned metadata. No network. */
export function fixturePlatformMetadata(
  responses: Record<string, PlatformMetadata> = {},
): PlatformMetadataPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetchMetadata(url) {
      calls.push(url);
      for (const [needle, metadata] of Object.entries(responses)) {
        if (needle !== '*' && url.includes(needle)) return metadata;
      }
      return responses['*'] ?? null;
    },
  };
}
