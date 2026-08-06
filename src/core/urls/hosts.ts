/** Host predicates, kept in one place so "is this YouTube?" has exactly one answer. */

import { hostOf } from './find.ts';

function isOrSubdomainOf(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isYouTubeHost(host: string): boolean {
  return (
    host === 'youtu.be' ||
    isOrSubdomainOf(host, 'youtube.com') ||
    isOrSubdomainOf(host, 'youtube-nocookie.com')
  );
}

/**
 * TikTok *content* hosts. `vm.` and `vt.` are shortlink hosts and still count as content
 * here — they resolve to a video, they just need a network round-trip first (Tier 1).
 */
export function isTikTokHost(host: string): boolean {
  return isOrSubdomainOf(host, 'tiktok.com');
}

/**
 * Instagram *content* hosts, listed explicitly rather than by suffix.
 *
 * This matters: `l.instagram.com` is a subdomain of instagram.com but is a link
 * redirector, not content. Treating it as content would mean never unwrapping the
 * YouTube URL sitting inside its `u` parameter — which is one of the most common
 * real-world shapes for a shared Reel.
 */
const INSTAGRAM_CONTENT_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'instagr.am',
  'www.instagr.am',
]);

export function isInstagramHost(host: string): boolean {
  return INSTAGRAM_CONTENT_HOSTS.has(host);
}

/** A host whose URLs can carry something we ultimately want to resolve. */
export function isContentHost(host: string): boolean {
  return isYouTubeHost(host) || isTikTokHost(host) || isInstagramHost(host);
}

export function isContentUrl(url: URL): boolean {
  return isContentHost(hostOf(url));
}
