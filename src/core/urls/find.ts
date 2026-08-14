/**
 * Finding URL candidates in free text.
 *
 * Share sheets hand over prose with URLs embedded in it, often without a scheme and
 * often with sentence punctuation stuck to the end. This module's job is to pull out
 * plausible URL substrings; deciding what they *mean* happens elsewhere.
 */

/**
 * Characters that terminate a URL when scanning prose.
 *
 * Deliberately excludes `(` and `)`, which appear inside real URLs — trailing
 * brackets are handled by balance-checking in `trimTrailingPunctuation` instead.
 */
const ASCII_URL_STOP = String.raw`\s<>"'|{}\\^\[\]`;

/**
 * Non-ASCII characters that also end a URL.
 *
 * Smart quotes and dashes matter far more than they look: iOS substitutes them
 * automatically, so a URL pasted from Notes or a caption arrives as `“youtu.be/ID”`.
 * Without these, the closing quote is swallowed into the path and the video ID silently
 * fails validation.
 *
 * The escapes are built from code points rather than written as literals so that nothing
 * in this file depends on invisible or easily-mangled characters surviving an edit.
 */
const UNICODE_URL_STOP = [
  0x2018,
  0x2019,
  0x201a,
  0x201b, // single quotes
  0x201c,
  0x201d,
  0x201e,
  0x201f, // double quotes
  0x00ab,
  0x00bb,
  0x2039,
  0x203a, // guillemets
  0x2013,
  0x2014,
  0x2026, // en dash, em dash, ellipsis
]
  .map((cp) => `\\u${cp.toString(16).padStart(4, '0')}`)
  .join('');

const URL_STOP = ASCII_URL_STOP + UNICODE_URL_STOP;

/** Hosts we recognise without a scheme, because people paste them bare constantly. */
const BARE_HOSTS = String.raw`(?:youtu\.be|(?:[\w-]+\.)*youtube\.com|(?:[\w-]+\.)*youtube-nocookie\.com|(?:[\w-]+\.)*tiktok\.com|(?:[\w-]+\.)*instagram\.com|instagr\.am)`;

/**
 * The leading lookbehind stops `notyoutube.com/watch?v=X` from matching the
 * `youtube.com/...` tail, and stops `someone@youtube.com` from being read as a link.
 */
const URL_RE = new RegExp(
  `(?<![\\w.@-])(?:https?://[^${URL_STOP}]+` +
    `|(?:www|m|music)\\.[^${URL_STOP}]+` +
    `|${BARE_HOSTS}(?:/[^${URL_STOP}]*)?)`,
  'gi',
);

const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** Sentence punctuation that is never meaningfully the last character of a shared URL. */
const TRAILING_JUNK = new Set(['.', ',', ';', ':', '!', '?', '"', "'"]);

function count(haystack: string, needle: string): number {
  let n = 0;
  for (const ch of haystack) if (ch === needle) n += 1;
  return n;
}

/**
 * Strip punctuation that belongs to the sentence rather than the URL.
 *
 * Note what is *not* stripped: `-` and `_`, because a YouTube video ID can legitimately
 * end with either. Trimming them would silently corrupt one ID in every few thousand.
 */
export function trimTrailingPunctuation(raw: string): string {
  let s = raw;
  while (s.length > 0) {
    const last = s.slice(-1);
    if (TRAILING_JUNK.has(last)) {
      s = s.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener !== undefined && count(s, last) > count(s, opener)) {
      s = s.slice(0, -1);
      continue;
    }
    break;
  }
  return s;
}

/** Every plausible URL in the text, in order of appearance, punctuation trimmed. */
export function findUrlCandidates(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const trimmed = trimTrailingPunctuation(match[0]);
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/**
 * Parse a candidate into a URL, supplying `https://` when the share omitted a scheme.
 *
 * Returns null rather than throwing for anything that is not a usable http(s) URL with
 * a dotted hostname — `mailto:`, `javascript:`, bare words, and malformed leftovers all
 * land here and are simply not URLs as far as the pipeline is concerned.
 */
export function toUrl(candidate: string): URL | null {
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url;
  } catch {
    return null;
  }
}

export function hostOf(url: URL): string {
  return url.hostname.toLowerCase();
}
