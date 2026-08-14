/**
 * Text normalisation for whatever the OS share sheet hands us.
 *
 * Share sheets are inconsistent and messy. The same TikTok can arrive as a bare URL,
 * a URL plus a caption, HTML-escaped text from a webview, or a caption with the URL
 * buried three lines down surrounded by emoji. This module makes the text boring
 * before anything tries to parse it.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  // Straight-quote equivalents are enough here; we are looking for URLs, not prose.
  ldquo: '"',
  rdquo: '"',
  lsquo: "'",
  rsquo: "'",
  hellip: '…',
  ndash: '–',
  mdash: '—',
};

/**
 * Zero-width and formatting characters. Instagram and TikTok captions collect these
 * from emoji sequences and RTL text, and a stray U+200B inside a URL breaks parsing
 * in a way that is very hard to see when you read the string.
 */
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

/** Unicode spaces that should behave as ordinary separators. */
const UNICODE_SPACE_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const digits = isHex ? body.slice(2) : body.slice(1);
      const code = Number.parseInt(digits, isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Prepare shared text for URL extraction.
 *
 * Entities are decoded before invisible characters are stripped, so that an escaped
 * `&amp;` in a query string becomes a real separator, and a `&#8203;` becomes a
 * zero-width space that the next step then removes.
 */
export function normaliseText(input: string): string {
  return decodeHtmlEntities(input)
    .replace(INVISIBLE_RE, '')
    .replace(UNICODE_SPACE_RE, ' ')
    .replace(/\r\n?/g, '\n');
}
