/**
 * Unwrapping link redirectors, without touching the network.
 *
 * Instagram, Facebook, Google, and Reddit all rewrite outbound links to pass through
 * their own domain, and the real destination sits percent-encoded in a query parameter.
 * A share that has been through one of those wrappers still contains the YouTube URL —
 * it just isn't visible to a naive regex.
 *
 * This is pure string work: no requests are made. Shorteners that genuinely require a
 * network round-trip (`vm.tiktok.com`, `t.co`, `bit.ly`) are Tier 1's problem, not this
 * module's, because resolving them costs a request and this tier costs nothing.
 */

import { hostOf, toUrl } from './find.ts';
import { isContentHost, isYouTubeHost } from './hosts.ts';

/** Redirectors that put their target in a named query parameter. */
const REDIRECT_PARAMS: Record<string, readonly string[]> = {
  'l.instagram.com': ['u'],
  'l.facebook.com': ['u'],
  'lm.facebook.com': ['u'],
  'l.messenger.com': ['u'],
  'away.vk.com': ['to'],
  'out.reddit.com': ['url'],
  'www.google.com': ['q', 'url', 'imgurl'],
  'google.com': ['q', 'url'],
  'news.url.google.com': ['url'],
  't.umblr.com': ['z'],
  'steamcommunity.com': ['url'],
  'href.li': [],
  'href.hu': [],
};

const MAX_UNWRAP_DEPTH = 5;

/**
 * One unwrapping step. Returns the target URL, or null when this URL is not a wrapper.
 */
function unwrapOnce(url: URL): URL | null {
  const host = hostOf(url);
  const path = url.pathname;

  // YouTube's own attribution wrapper carries a *relative* target
  // (`/attribution_link?u=%2Fwatch%3Fv%3DID`), so it must be resolved against a base.
  if (isYouTubeHost(host) && path === '/attribution_link') {
    const target = url.searchParams.get('u');
    if (target) return resolveAgainstYouTube(target);
  }

  // `youtube.com/oembed?url=...` wraps a canonical watch URL.
  if (isYouTubeHost(host) && (path === '/oembed' || path === '/youtubei/v1/oembed')) {
    const target = url.searchParams.get('url');
    if (target) return toUrl(target);
  }

  // YouTube's *outbound* redirector. The target is deliberately followed even though it
  // usually points away from YouTube — the point is to classify it honestly rather than
  // report a youtube.com URL that contains no video.
  if (isYouTubeHost(host) && path === '/redirect') {
    const target = url.searchParams.get('q');
    if (target) return toUrl(target);
  }

  // Prefix-style wrappers: `https://href.li/?https://youtu.be/ID`
  if ((host === 'href.li' || host === 'href.hu') && url.search.length > 1) {
    return toUrl(decodeURIComponent(url.search.slice(1)));
  }

  for (const key of REDIRECT_PARAMS[host] ?? []) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    const target = toUrl(value);
    if (target) return target;
  }

  // Generic fallback for redirectors we have never heard of. Only fires on hosts that
  // are not themselves content, and only when a parameter value resolves to a host we
  // actually care about — so an arbitrary `?ref=https://example.com` is left alone.
  if (!isContentHost(host)) {
    for (const [, value] of url.searchParams) {
      if (!/^https?%3a|^https?:/i.test(value)) continue;
      const target = toUrl(value);
      if (target && isContentHost(hostOf(target))) return target;
    }
  }

  return null;
}

function resolveAgainstYouTube(target: string): URL | null {
  try {
    return new URL(target, 'https://www.youtube.com');
  } catch {
    return null;
  }
}

/**
 * Follow wrappers until a non-wrapper is reached.
 *
 * Depth-capped and cycle-guarded: a redirector that points at itself, or a chain built
 * to loop, terminates instead of spinning.
 */
export function unwrapRedirects(url: URL): URL {
  let current = url;
  const seen = new Set<string>([current.toString()]);

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    const next = unwrapOnce(current);
    if (!next) break;
    const key = next.toString();
    if (seen.has(key)) break;
    seen.add(key);
    current = next;
  }

  return current;
}
