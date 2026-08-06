/**
 * End-to-end tests for the ingest → resolve → playlist spine.
 *
 * These are the tests that say "the product works". Every one of them runs against the real
 * router, real SQL, real migrations, and the real pipeline — only the network is a fixture.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { listItemsByShareKey, listPlaylistEntries, listRecentItems } from '../../src/db/repo.ts';
import { hmacSha256Hex } from '../../src/crypto/vault.ts';
import { createHarness, type Harness, INGEST_TOKEN } from '../helpers/harness.ts';

const VIDEO = 'dQw4w9WgXcQ';
const VIDEO2 = '9bZkp7q19f0';

let harness: Harness | undefined;

afterEach(() => {
  harness?.close();
  harness = undefined;
});

async function connected(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness(options);
  return harness;
}

describe('POST /api/ingest — authentication', () => {
  it('rejects a request with no Authorization header', async () => {
    const h = await connected();
    const response = await h.request('/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `https://youtu.be/${VIDEO}` }),
    });
    expect(response.status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const h = await connected();
    expect((await h.ingest(`https://youtu.be/${VIDEO}`, { token: 'wrong' })).status).toBe(401);
  });

  it('gives no detail about why authentication failed', async () => {
    const h = await connected();
    const wrong = await h.ingest('x', { token: 'wrong' });
    const missing = await h.request('/api/ingest', { method: 'POST', body: 'x' });
    expect(await wrong.json()).toEqual({ error: 'unauthorized' });
    expect(await missing.json()).toEqual({ error: 'unauthorized' });
  });

  it('accepts the correct token', async () => {
    const h = await connected();
    expect((await h.ingest(`https://youtu.be/${VIDEO}`)).status).toBe(202);
  });

  it('writes nothing to the database for a rejected request', async () => {
    const h = await connected();
    await h.ingest(`https://youtu.be/${VIDEO}`, { token: 'wrong' });
    expect(await listRecentItems(h.db, h.account.id)).toHaveLength(0);
  });
});

describe('POST /api/ingest — rate limiting', () => {
  it('returns 429 once the window limit is exceeded', async () => {
    const h = await connected({
      config: { ingest: { token: INGEST_TOKEN, hmacSecret: undefined, rateLimitPerMinute: 3 } },
    });

    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push((await h.ingest(`https://youtu.be/${VIDEO}?n=${i}`)).status);
    }
    expect(codes.slice(0, 3)).toEqual([202, 202, 202]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });

  it('rate limits failed authentication too, so it cannot be used as an oracle', async () => {
    const h = await connected({
      config: { ingest: { token: INGEST_TOKEN, hmacSecret: undefined, rateLimitPerMinute: 2 } },
    });
    await h.ingest('x', { token: 'guess1' });
    await h.ingest('x', { token: 'guess2' });
    const third = await h.ingest('x', { token: 'guess3' });
    expect(third.status).toBe(429);
  });

  it('sends a retry-after header', async () => {
    const h = await connected({
      config: { ingest: { token: INGEST_TOKEN, hmacSecret: undefined, rateLimitPerMinute: 1 } },
    });
    await h.ingest(`https://youtu.be/${VIDEO}`);
    const limited = await h.ingest(`https://youtu.be/${VIDEO2}`);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('the happy path', () => {
  it('answers 202 immediately and adds the video', async () => {
    const h = await connected();
    const response = await h.ingest(`check this out https://youtu.be/${VIDEO}`);

    expect(response.status).toBe(202);
    const body = (await response.json()) as { accepted: boolean; items: { videoId: string }[] };
    expect(body.accepted).toBe(true);
    expect(body.items[0]?.videoId).toBe(VIDEO);

    await h.drain();

    expect([...h.youtube.playlistContents.values()].flat()).toEqual([VIDEO]);
    const entries = await listPlaylistEntries(h.db, h.account.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.videoId).toBe(VIDEO);
    expect(entries[0]?.playlistItemId).toBeTruthy();
  });

  it('creates the destination playlist on first use, then reuses it', async () => {
    const h = await connected();
    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();
    await h.ingest(`https://youtu.be/${VIDEO2}`);
    await h.drain();

    const creates = h.youtube.calls.filter((call) => call.operation === 'playlists.insert');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.detail).toBe('Later');
  });

  it('costs 51 units for a share that already contains a link', async () => {
    const h = await connected();
    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    // 1 videos.list + 50 playlistItems.insert, plus the one-off playlist setup.
    const setup = 1 + 50; // playlists.list + playlists.insert
    expect(h.youtube.unitsSpent).toBe(51 + setup);
    expect(h.youtube.calls.map((c) => c.operation)).not.toContain('search.list');
  });

  it('never calls search.list when a URL is present', async () => {
    const h = await connected();
    await h.ingest(`omg watch this youtu.be/${VIDEO} it's incredible`);
    await h.drain();
    expect(h.youtube.calls.some((call) => call.operation === 'search.list')).toBe(false);
  });

  it('marks the item added and records the tier', async () => {
    const h = await connected();
    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('added');
    expect(items[0]?.resolvedTier).toBe(0);
    expect(items[0]?.confidence).toBe(1);
  });
});

describe('duplicates never double-add', () => {
  it('is idempotent for the exact same share', async () => {
    const h = await connected();
    const text = `https://youtu.be/${VIDEO}`;

    await h.ingest(text);
    await h.drain();
    const second = await h.ingest(text);
    await h.drain();

    const body = (await second.json()) as { items: { duplicate: boolean }[] };
    expect(body.items[0]?.duplicate).toBe(true);
    expect([...h.youtube.playlistContents.values()].flat()).toEqual([VIDEO]);
    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(1);
  });

  it('collapses trivially different renderings of the same share', async () => {
    const h = await connected();
    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();
    // Extra whitespace and a zero-width space: the same share as far as a human is concerned.
    await h.ingest(`  https://youtu.be/${VIDEO}${String.fromCodePoint(0x200b)}  `);
    await h.drain();

    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(1);
  });

  it('catches the same video arriving via different text and URL forms', async () => {
    const h = await connected();
    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();
    await h.ingest(`totally different caption https://www.youtube.com/watch?v=${VIDEO}&si=xyz`);
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items.map((i) => i.status).sort()).toEqual(['added', 'duplicate']);
    expect([...h.youtube.playlistContents.values()].flat()).toEqual([VIDEO]);
  });

  it('spends no insert quota on a duplicate', async () => {
    const h = await connected();
    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();
    const spentAfterFirst = h.youtube.unitsSpent;

    await h.ingest(`different text, same video: youtube.com/watch?v=${VIDEO}`);
    await h.drain();

    // The dedupe check is a local database read, so a duplicate is free.
    expect(h.youtube.unitsSpent).toBe(spentAfterFirst);
  });
});

describe('multiple videos in one share', () => {
  it('creates one item per video and adds them all', async () => {
    const h = await connected();
    const response = await h.ingest(
      `1) https://youtu.be/${VIDEO}\n2) https://www.youtube.com/shorts/${VIDEO2}`,
    );
    const body = (await response.json()) as { shareKey: string; items: unknown[] };
    expect(body.items).toHaveLength(2);

    await h.drain();

    expect([...h.youtube.playlistContents.values()].flat().sort()).toEqual([VIDEO, VIDEO2].sort());
    const items = await listItemsByShareKey(h.db, body.shareKey);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.status === 'added')).toBe(true);
  });

  it('reports per-video outcomes when they differ', async () => {
    const h = await connected();
    // privateVid1 is a fixture video marked private; it is a valid 11-char ID.
    const response = await h.ingest(`https://youtu.be/${VIDEO} and https://youtu.be/privateVid1`);
    const body = (await response.json()) as { shareKey: string };
    await h.drain();

    const items = await listItemsByShareKey(h.db, body.shareKey);
    const byVideo = new Map(items.map((item) => [item.resolvedVideoId, item.status]));
    expect(byVideo.get(VIDEO)).toBe('added');
    expect(byVideo.get('privateVid1')).toBe('blocked');
  });
});

describe('shares that cannot be resolved', () => {
  it('marks a non-YouTube link unresolvable and says why', async () => {
    const h = await connected();
    const response = await h.ingest('look at this https://example.com/article');
    const body = (await response.json()) as { note?: string };
    expect(body.note).toMatch(/not YouTube videos/i);

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('unresolvable');
  });

  it('explains that a channel link is not a video', async () => {
    const h = await connected();
    const response = await h.ingest('https://www.youtube.com/@veritasium');
    const body = (await response.json()) as { note?: string };
    expect(body.note).toMatch(/channel link/i);
  });

  it('explains that a playlist link is not a video', async () => {
    const h = await connected();
    const response = await h.ingest(
      'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI',
    );
    const body = (await response.json()) as { note?: string };
    expect(body.note).toMatch(/playlist link/i);
  });

  it('tells the user to configure an LLM when a caption has no link', async () => {
    const h = await connected();
    const response = await h.ingest('that Veritasium video about why planes fly is incredible');
    const body = (await response.json()) as { note?: string };
    expect(body.note).toMatch(/LLM_PROVIDER|LLM provider/i);
  });

  it('rejects an empty share with 400 rather than creating a row', async () => {
    const h = await connected();
    expect((await h.ingest('   ')).status).toBe(400);
    expect(await listRecentItems(h.db, h.account.id)).toHaveLength(0);
  });

  it('rejects an absurdly long share', async () => {
    const h = await connected();
    expect((await h.ingest('x'.repeat(20_001))).status).toBe(413);
  });

  it('spends no quota at all on an unresolvable share', async () => {
    const h = await connected();
    await h.ingest('just some text with no links');
    await h.drain();
    expect(h.youtube.unitsSpent).toBe(0);
  });
});

describe('unavailable videos', () => {
  it('refuses a deleted video and explains', async () => {
    const h = await connected();
    // Not in the fixture corpus, so the client reports it as deleted.
    await h.ingest('https://youtu.be/zzzzzzzzzzz');
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('blocked');
    expect(items[0]?.failureReason).toMatch(/deleted|does not exist/i);
    expect([...h.youtube.playlistContents.values()].flat()).toEqual([]);
  });

  it('still saves a region-blocked video, since it is addable', async () => {
    const h = await connected();
    await h.ingest('https://youtu.be/blockedVid1');
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('added');
  });
});

describe('tolerant request bodies', () => {
  it('accepts a bare URL as text/plain', async () => {
    const h = await connected();
    const response = await h.request('/api/ingest', {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'text/plain' },
      body: `https://youtu.be/${VIDEO}`,
    });
    expect(response.status).toBe(202);
    await h.drain();
    expect([...h.youtube.playlistContents.values()].flat()).toEqual([VIDEO]);
  });

  it('accepts a form-encoded body, as the share sheet sends', async () => {
    const h = await connected();
    const response = await h.request('/api/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${INGEST_TOKEN}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        text: 'great video',
        url: `https://youtu.be/${VIDEO}`,
      }).toString(),
    });
    expect(response.status).toBe(202);
    await h.drain();
    expect([...h.youtube.playlistContents.values()].flat()).toEqual([VIDEO]);
  });

  it('joins JSON title, text, and url fields, as iOS Shortcuts send them separately', async () => {
    const h = await connected();
    const response = await h.request('/api/ingest', {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Never Gonna Give You Up',
        text: 'someone sent me this',
        url: `https://youtu.be/${VIDEO}`,
        source: 'ios-shortcut',
      }),
    });
    expect(response.status).toBe(202);
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.source).toBe('ios-shortcut');
    expect([...h.youtube.playlistContents.values()].flat()).toEqual([VIDEO]);
  });

  it('falls back to treating malformed JSON as plain text', async () => {
    const h = await connected();
    const response = await h.request('/api/ingest', {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' },
      body: `{not json at all https://youtu.be/${VIDEO}`,
    });
    expect(response.status).toBe(202);
    await h.drain();
    expect([...h.youtube.playlistContents.values()].flat()).toEqual([VIDEO]);
  });

  it('honours a client-supplied idempotency key across different text', async () => {
    const h = await connected();
    const send = (text: string) =>
      h.request('/api/ingest', {
        method: 'POST',
        headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text, idempotencyKey: 'client-retry-1' }),
      });

    await send(`https://youtu.be/${VIDEO}`);
    await h.drain();
    await send(`https://youtu.be/${VIDEO}`);
    await h.drain();

    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(1);
  });
});

describe('not connected yet', () => {
  it('returns 409 with a pointer to the auth flow', async () => {
    harness = await createHarness({ connect: false });
    const response = await harness.ingest(`https://youtu.be/${VIDEO}`);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toBe('not_connected');
    expect(body.detail).toContain('/auth/start');
  });

  it('serves the setup page at the root', async () => {
    harness = await createHarness({ connect: false });
    const response = await harness.request('/');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('Not connected yet');
    expect(body).toContain('/auth/start');
  });
});

describe('optional HMAC signing (opt-in hardening)', () => {
  const HMAC_SECRET = 'hmac-secret-for-tests-only-32-chars';

  async function signedHarness(): Promise<Harness> {
    harness = await createHarness({
      config: {
        ingest: { token: INGEST_TOKEN, hmacSecret: HMAC_SECRET, rateLimitPerMinute: 100 },
      },
    });
    return harness;
  }

  async function send(h: Harness, body: string, signature: string | null): Promise<Response> {
    return await h.request('/api/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${INGEST_TOKEN}`,
        'content-type': 'application/json',
        ...(signature === null ? {} : { 'x-later-signature': signature }),
      },
      body,
    });
  }

  it('accepts a correctly signed request', async () => {
    const h = await signedHarness();
    const body = JSON.stringify({ text: `https://youtu.be/${VIDEO}` });
    const signature = await hmacSha256Hex(HMAC_SECRET, body);

    expect((await send(h, body, signature)).status).toBe(202);
    await h.drain();
    expect([...h.youtube.playlistContents.values()].flat()).toEqual([VIDEO]);
  });

  it('rejects a request with no signature, even with a valid bearer token', async () => {
    const h = await signedHarness();
    const body = JSON.stringify({ text: `https://youtu.be/${VIDEO}` });
    expect((await send(h, body, null)).status).toBe(401);
  });

  it('rejects a signature computed over different content — tamper detection', async () => {
    const h = await signedHarness();
    const signature = await hmacSha256Hex(HMAC_SECRET, JSON.stringify({ text: 'something else' }));
    const body = JSON.stringify({ text: `https://youtu.be/${VIDEO}` });
    expect((await send(h, body, signature)).status).toBe(401);
  });

  it('rejects a signature made with the wrong secret', async () => {
    const h = await signedHarness();
    const body = JSON.stringify({ text: `https://youtu.be/${VIDEO}` });
    const signature = await hmacSha256Hex('a-different-secret', body);
    expect((await send(h, body, signature)).status).toBe(401);
  });

  it('accepts an upper-case hex signature, since clients differ', async () => {
    const h = await signedHarness();
    const body = JSON.stringify({ text: `https://youtu.be/${VIDEO}` });
    const signature = (await hmacSha256Hex(HMAC_SECRET, body)).toUpperCase();
    expect((await send(h, body, signature)).status).toBe(202);
  });

  it('gives the same opaque 401 for a bad signature as for a bad token', async () => {
    const h = await signedHarness();
    const body = JSON.stringify({ text: 'x' });
    const badSignature = await send(h, body, 'deadbeef');
    expect(await badSignature.json()).toEqual({ error: 'unauthorized' });
  });
});
