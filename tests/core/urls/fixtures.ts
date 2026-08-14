/**
 * Tier 0 extraction fixtures.
 *
 * These are the regression surface for the highest-value code in the project. Every URL
 * shape here either appears in real share-sheet output or is a shape that would silently
 * corrupt a video ID if mishandled.
 *
 * When you find a URL form Later gets wrong, add it here first, watch it fail, then fix
 * the extractor. Please paste the actual string your share sheet produced — synthetic
 * examples miss the interesting cases.
 */

/** Well-known 11-character ID, used wherever the specific video does not matter. */
export const ID = 'dQw4w9WgXcQ';
/** Exercises the full legal ID charset, including `-` and `_`. */
export const ID_MIXED = 'a-b_cD3fGh1';
/** Trailing `-` and `_` are legal and must survive punctuation trimming. */
export const ID_TRAILING_DASH = 'abcdefghij-';
export const ID_TRAILING_UNDERSCORE = 'abcdefghij_';
export const ID_SECOND = '9bZkp7q19f0';

export const PLAYLIST_ID = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';

const ZWSP = String.fromCodePoint(0x200b);
const LDQUO = String.fromCodePoint(0x201c);
const RDQUO = String.fromCodePoint(0x201d);
const ELLIPSIS = String.fromCodePoint(0x2026);
const NBSP = String.fromCodePoint(0x00a0);

export interface Fixture {
  name: string;
  input: string;
  /** Expected video IDs, in order of first appearance. */
  videos?: string[];
  /** Expected start offsets, positionally aligned with `videos`. */
  starts?: (number | undefined)[];
  playlists?: string[];
  channels?: string[];
  platforms?: { platform: 'tiktok' | 'instagram'; isShortlink: boolean }[];
  /** Expected count of URLs found but not resolvable to a video. */
  others?: number;
}

export const fixtures: Fixture[] = [
  // ─── Canonical URL forms ────────────────────────────────────────────────────
  { name: 'watch, www', input: `https://www.youtube.com/watch?v=${ID}`, videos: [ID] },
  { name: 'watch, no www', input: `https://youtube.com/watch?v=${ID}`, videos: [ID] },
  { name: 'watch, plain http', input: `http://www.youtube.com/watch?v=${ID}`, videos: [ID] },
  { name: 'watch, mobile host', input: `https://m.youtube.com/watch?v=${ID}`, videos: [ID] },
  { name: 'watch, music host', input: `https://music.youtube.com/watch?v=${ID}`, videos: [ID] },
  { name: 'youtu.be short form', input: `https://youtu.be/${ID}`, videos: [ID] },
  { name: 'shorts', input: `https://www.youtube.com/shorts/${ID}`, videos: [ID] },
  { name: 'live', input: `https://www.youtube.com/live/${ID}`, videos: [ID] },
  { name: 'embed', input: `https://www.youtube.com/embed/${ID}`, videos: [ID] },
  { name: 'legacy /v/', input: `https://www.youtube.com/v/${ID}`, videos: [ID] },
  { name: 'nocookie embed', input: `https://www.youtube-nocookie.com/embed/${ID}`, videos: [ID] },
  {
    name: 'uppercase scheme and host, ID case preserved',
    input: `HTTPS://YOUTU.BE/${ID}`,
    videos: [ID],
  },

  // ─── Missing scheme (people paste bare hosts constantly) ────────────────────
  { name: 'bare youtu.be', input: `youtu.be/${ID}`, videos: [ID] },
  { name: 'bare www.youtube.com', input: `www.youtube.com/watch?v=${ID}`, videos: [ID] },
  { name: 'bare youtube.com', input: `youtube.com/watch?v=${ID}`, videos: [ID] },
  { name: 'bare m.youtube.com', input: `m.youtube.com/watch?v=${ID}`, videos: [ID] },

  // ─── Tracking parameters ───────────────────────────────────────────────────
  {
    name: 'youtu.be with ?si= share token',
    input: `https://youtu.be/${ID}?si=AbCdEf123`,
    videos: [ID],
  },
  {
    name: 'watch with feature and utm noise',
    input: `https://www.youtube.com/watch?v=${ID}&feature=share&utm_source=ig&utm_medium=social`,
    videos: [ID],
  },
  {
    name: 'v is not the first parameter',
    input: `https://www.youtube.com/watch?feature=share&v=${ID}`,
    videos: [ID],
  },
  {
    name: 'shorts with feature',
    input: `https://www.youtube.com/shorts/${ID}?feature=share`,
    videos: [ID],
  },
  {
    name: 'video inside a playlist yields the video only',
    input: `https://www.youtube.com/watch?v=${ID}&list=${PLAYLIST_ID}&index=3`,
    videos: [ID],
    playlists: [],
  },
  {
    name: 'fbclid and igshid are discarded',
    input: `https://youtu.be/${ID}?fbclid=IwAR123&igshid=abc`,
    videos: [ID],
  },

  // ─── Timestamps ────────────────────────────────────────────────────────────
  { name: 't as bare seconds', input: `https://youtu.be/${ID}?t=42`, videos: [ID], starts: [42] },
  {
    name: 't with s suffix',
    input: `https://www.youtube.com/watch?v=${ID}&t=90s`,
    videos: [ID],
    starts: [90],
  },
  {
    name: 't as minutes and seconds',
    input: `https://www.youtube.com/watch?v=${ID}&t=1m30s`,
    videos: [ID],
    starts: [90],
  },
  {
    name: 't as hours, minutes, seconds',
    input: `https://www.youtube.com/watch?v=${ID}&t=1h2m3s`,
    videos: [ID],
    starts: [3723],
  },
  {
    name: 'start parameter',
    input: `https://www.youtube.com/watch?v=${ID}&start=15`,
    videos: [ID],
    starts: [15],
  },
  {
    name: 'no timestamp leaves start undefined',
    input: `https://youtu.be/${ID}`,
    videos: [ID],
    starts: [undefined],
  },
  {
    name: 'malformed & instead of ? before timestamp',
    input: `https://youtu.be/${ID}&t=42`,
    videos: [ID],
    starts: [42],
  },
  {
    name: 'unparseable timestamp is ignored, video still found',
    input: `https://youtu.be/${ID}?t=banana`,
    videos: [ID],
    starts: [undefined],
  },

  // ─── Embedded in prose, with punctuation ───────────────────────────────────
  { name: 'URL mid-sentence', input: `omg watch this youtu.be/${ID} it is insane`, videos: [ID] },
  { name: 'trailing full stop', input: `check youtu.be/${ID}.`, videos: [ID] },
  { name: 'trailing comma', input: `see youtu.be/${ID}, then tell me`, videos: [ID] },
  { name: 'multiple trailing punctuation', input: `watch: youtu.be/${ID}!!!`, videos: [ID] },
  { name: 'wrapped in parentheses', input: `(https://youtu.be/${ID})`, videos: [ID] },
  { name: 'markdown link', input: `[great video](https://youtu.be/${ID})`, videos: [ID] },
  { name: 'angle brackets', input: `<https://youtu.be/${ID}>`, videos: [ID] },
  { name: 'double quotes', input: `"https://youtu.be/${ID}"`, videos: [ID] },
  {
    name: 'smart quotes from iOS autocorrect',
    input: `${LDQUO}https://youtu.be/${ID}${RDQUO}`,
    videos: [ID],
  },
  { name: 'trailing unicode ellipsis', input: `youtu.be/${ID}${ELLIPSIS}`, videos: [ID] },
  {
    name: 'non-breaking space before URL',
    input: `watch this:${NBSP}youtu.be/${ID}`,
    videos: [ID],
  },
  {
    name: 'caption then URL on its own line',
    input: `This blew my mind\n\nhttps://youtu.be/${ID}\n\n#science`,
    videos: [ID],
  },
  {
    name: 'parenthesised sentence containing a URL keeps the closing paren out',
    input: `(this one https://youtu.be/${ID}) is better`,
    videos: [ID],
  },

  // ─── IDs at the edges of the legal charset ─────────────────────────────────
  {
    name: 'ID with hyphen and underscore',
    input: `https://youtu.be/${ID_MIXED}`,
    videos: [ID_MIXED],
  },
  {
    name: 'ID ending in a hyphen survives punctuation trimming',
    input: `https://youtu.be/${ID_TRAILING_DASH}`,
    videos: [ID_TRAILING_DASH],
  },
  {
    name: 'ID ending in an underscore survives punctuation trimming',
    input: `https://youtu.be/${ID_TRAILING_UNDERSCORE}`,
    videos: [ID_TRAILING_UNDERSCORE],
  },
  {
    name: 'ID ending in a hyphen followed by a full stop',
    input: `look: youtu.be/${ID_TRAILING_DASH}.`,
    videos: [ID_TRAILING_DASH],
  },

  // ─── Multiple videos and deduplication ─────────────────────────────────────
  {
    name: 'two different videos, order preserved',
    input: `first https://youtu.be/${ID} then https://youtu.be/${ID_SECOND}`,
    videos: [ID, ID_SECOND],
  },
  {
    name: 'same video twice in different forms collapses to one',
    input: `https://youtu.be/${ID} and https://www.youtube.com/watch?v=${ID}`,
    videos: [ID],
  },
  {
    name: 'duplicate keeps the first occurrence timestamp',
    input: `https://youtu.be/${ID}?t=30 ... https://youtu.be/${ID}?t=99`,
    videos: [ID],
    starts: [30],
  },

  // ─── HTML entities and invisible characters ────────────────────────────────
  {
    name: 'HTML-escaped ampersand in query',
    input: `https://www.youtube.com/watch?v=${ID}&amp;list=${PLAYLIST_ID}`,
    videos: [ID],
  },
  { name: 'HTML-escaped angle brackets', input: `&lt;https://youtu.be/${ID}&gt;`, videos: [ID] },
  { name: 'numeric entity', input: `https://youtu.be/${ID}&#63;t=42`, videos: [ID], starts: [42] },
  {
    name: 'zero-width space inside the URL',
    input: `https://youtu.be/${ID.slice(0, 4)}${ZWSP}${ID.slice(4)}`,
    videos: [ID],
  },

  // ─── Redirectors, unwrapped without touching the network ───────────────────
  {
    name: 'Instagram outbound wrapper',
    input: `https://l.instagram.com/?u=https%3A%2F%2Fyoutu.be%2F${ID}&e=ATxyz`,
    videos: [ID],
  },
  {
    name: 'Facebook l.php wrapper',
    input: `https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${ID}`,
    videos: [ID],
  },
  {
    name: 'Google url wrapper',
    input: `https://www.google.com/url?q=https://youtu.be/${ID}`,
    videos: [ID],
  },
  {
    name: 'YouTube attribution_link with a relative target',
    input: `https://www.youtube.com/attribution_link?a=xyz&u=%2Fwatch%3Fv%3D${ID}%26feature%3Dshare`,
    videos: [ID],
  },
  {
    name: 'href.li prefix wrapper',
    input: `https://href.li/?https://youtu.be/${ID}`,
    videos: [ID],
  },
  {
    name: 'unknown redirector with a URL-valued parameter',
    input: `https://redir.example.com/go?target=https%3A%2F%2Fyoutu.be%2F${ID}`,
    videos: [ID],
  },
  {
    name: 'YouTube oembed wrapper',
    input: `https://www.youtube.com/oembed?url=https%3A%2F%2Fyoutu.be%2F${ID}&format=json`,
    videos: [ID],
  },

  // ─── Must NOT produce a video ──────────────────────────────────────────────
  {
    name: 'lookalike domain is not YouTube',
    input: `https://notyoutube.com/watch?v=${ID}`,
    videos: [],
    others: 1,
  },
  {
    name: 'lookalike domain as a suffix is not YouTube',
    input: `https://myyoutube.com.evil.example/watch?v=${ID}`,
    videos: [],
    others: 1,
  },
  {
    name: 'ID too short is rejected, not padded',
    input: `https://youtu.be/tooshort`,
    videos: [],
    others: 1,
  },
  {
    name: 'ID too long is rejected, not truncated',
    input: `https://youtu.be/${ID}extra`,
    videos: [],
    others: 1,
  },
  {
    name: 'watch with a malformed v is rejected',
    input: `https://www.youtube.com/watch?v=short`,
    videos: [],
    others: 1,
  },
  { name: 'watch with no v at all', input: `https://www.youtube.com/watch`, videos: [], others: 1 },
  {
    name: 'email address containing youtube.com is not a link',
    input: `mail someone@youtube.com about it`,
    videos: [],
    others: 0,
  },
  {
    name: 'YouTube search results page is not a video',
    input: `https://www.youtube.com/results?search_query=cats`,
    videos: [],
    others: 1,
  },
  {
    name: 'YouTube feed is not a video',
    input: `https://www.youtube.com/feed/subscriptions`,
    videos: [],
    others: 1,
  },
  { name: 'empty input', input: '', videos: [], others: 0 },
  {
    name: 'prose with no URL at all is Tier 2 territory',
    input: 'that Veritasium video about why planes fly is incredible',
    videos: [],
    others: 0,
  },

  // ─── Playlists and channels get their own buckets ──────────────────────────
  {
    name: 'playlist URL',
    input: `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`,
    videos: [],
    playlists: [PLAYLIST_ID],
  },
  {
    name: 'playlist embed via videoseries',
    input: `https://www.youtube.com/embed/videoseries?list=${PLAYLIST_ID}`,
    videos: [],
    playlists: [PLAYLIST_ID],
  },
  {
    name: 'channel handle',
    input: `https://www.youtube.com/@veritasium`,
    videos: [],
    channels: ['@veritasium'],
  },
  {
    name: 'channel ID',
    input: `https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA`,
    videos: [],
    channels: ['UCHnyfMqiRRG1u-2MsSQLbXA'],
  },
  {
    name: 'legacy /c/ channel',
    input: `https://www.youtube.com/c/veritasium`,
    videos: [],
    channels: ['veritasium'],
  },
  {
    name: 'legacy /user/ channel',
    input: `https://www.youtube.com/user/1veritasium`,
    videos: [],
    channels: ['1veritasium'],
  },

  // ─── Platform links, which Tier 1 will follow up ───────────────────────────
  {
    name: 'TikTok vm shortlink',
    input: `https://vm.tiktok.com/ZMabcdefg/`,
    videos: [],
    platforms: [{ platform: 'tiktok', isShortlink: true }],
  },
  {
    name: 'TikTok vt shortlink',
    input: `https://vt.tiktok.com/ZSabcdefg/`,
    videos: [],
    platforms: [{ platform: 'tiktok', isShortlink: true }],
  },
  {
    name: 'TikTok /t/ shortlink path',
    input: `https://www.tiktok.com/t/ZTabcdefg/`,
    videos: [],
    platforms: [{ platform: 'tiktok', isShortlink: true }],
  },
  {
    name: 'TikTok canonical video URL',
    input: `https://www.tiktok.com/@someuser/video/7234567890123456789`,
    videos: [],
    platforms: [{ platform: 'tiktok', isShortlink: false }],
  },
  {
    name: 'Instagram reel',
    input: `https://www.instagram.com/reel/CxYzAbCdEfG/`,
    videos: [],
    platforms: [{ platform: 'instagram', isShortlink: false }],
  },
  {
    name: 'Instagram post',
    input: `https://www.instagram.com/p/CxYzAbCdEfG/?igshid=abc`,
    videos: [],
    platforms: [{ platform: 'instagram', isShortlink: false }],
  },

  // ─── Realistic composite shares ────────────────────────────────────────────
  {
    name: 'TikTok share text where the caption also carries the YouTube link',
    input:
      `Check out this video! The full thing is at youtu.be/${ID} ` +
      `https://vm.tiktok.com/ZMabcdefg/`,
    videos: [ID],
    platforms: [{ platform: 'tiktok', isShortlink: true }],
  },
  {
    name: 'iOS share sheet: title line then URL line',
    input: `Why Planes Really Fly - Veritasium\nhttps://www.youtube.com/watch?v=${ID}`,
    videos: [ID],
  },
  {
    name: 'Instagram wrapper plus caption prose',
    input:
      `omg this explains everything ${ELLIPSIS} ` +
      `https://l.instagram.com/?u=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${ID}%26si%3Dxyz&e=AT1`,
    videos: [ID],
  },
  {
    name: 'two videos plus a TikTok link plus junk',
    input:
      `1) youtu.be/${ID}\n2) https://www.youtube.com/shorts/${ID_SECOND}\n` +
      `via https://vm.tiktok.com/ZMabcdefg/ and https://example.com/blog`,
    videos: [ID, ID_SECOND],
    platforms: [{ platform: 'tiktok', isShortlink: true }],
    others: 1,
  },
];
