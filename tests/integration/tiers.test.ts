/**
 * Tiers 1 and 2, end to end, plus the review inbox.
 *
 * The property most of these defend: **Later never adds a video it is not confident about.**
 * Several of them assert that it declines to act, because the failure this guards against is
 * confident wrongness, not timidity.
 *
 * Also asserts the quota invariant from ADR-0006 — `search.list` costs 100 units and must never
 * be reached when a URL is already present in the share.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fixturePlatformMetadata } from '../../src/adapters/platform/oembed.ts';
import { listRecentItems, listPlaylistEntries } from '../../src/db/repo.ts';
import { fixtureLlm } from '../../src/ports/llm.ts';
import type { VideoCandidate } from '../../src/core/resolve/ranking.ts';
import { createHarness, type Harness } from '../helpers/harness.ts';

const VIDEO = 'dQw4w9WgXcQ';
const PLANES = 'a-b_cD3fGh1'; // "Why Planes Really Fly" by Veritasium, in the fixture corpus
const SEEDED = [{ id: 'PLseeded', title: 'Later' }];

let harness: Harness | undefined;
afterEach(() => {
  harness?.close();
  harness = undefined;
});

/** A harness with Tier 1 and/or Tier 2 wired to fixtures. */
async function make(options: {
  captions?: Record<string, { text: string; authorName?: string }>;
  candidates?: Record<string, VideoCandidate[]>;
  searchResults?: Record<
    string,
    { videoId: string; title: string; channelTitle: string; channelId: string }[]
  >;
  threshold?: number;
  llmProvider?: 'none' | 'fixture';
}): Promise<Harness> {
  harness = await createHarness({
    youtube: {
      playlists: SEEDED,
      ...(options.searchResults ? { searchResults: options.searchResults } : {}),
    },
    config: {
      resolve: {
        confidenceThreshold: options.threshold ?? 0.75,
        enablePlatformMetadata: true,
        instagramOembedToken: undefined,
        enableTranscript: false,
      },
      llm: {
        provider: options.candidates || options.llmProvider === 'fixture' ? 'fixture' : 'none',
        geminiApiKey: undefined,
        openaiBaseUrl: undefined,
        openaiApiKey: undefined,
        model: 'fixture',
      },
    },
    llm: fixtureLlm(options.candidates ?? {}),
    platform: fixturePlatformMetadata(options.captions ?? {}),
  });
  return harness;
}

describe('Tier 1 — platform captions, free', () => {
  it('finds a YouTube link hiding in a TikTok caption', async () => {
    const h = await make({
      captions: {
        'tiktok.com': { text: `full video here youtu.be/${VIDEO}`, authorName: 'someone' },
      },
    });

    await h.ingest('https://www.tiktok.com/@someone/video/7234567890123456789');
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('added');
    expect(items[0]?.resolvedTier).toBe(1);
    expect(items[0]?.resolvedVideoId).toBe(VIDEO);
  });

  it('costs no search quota, because the caption had the answer', async () => {
    const h = await make({
      captions: { 'tiktok.com': { text: `youtu.be/${VIDEO}` } },
    });
    await h.ingest('https://vm.tiktok.com/ZMabcdefg/');
    await h.drain();

    expect(h.youtube.calls.some((call) => call.operation === 'search.list')).toBe(false);
  });

  it('works for an Instagram reel too', async () => {
    const h = await make({
      captions: { 'instagram.com': { text: `watch the original: youtube.com/watch?v=${VIDEO}` } },
    });
    await h.ingest('https://www.instagram.com/reel/CxYzAbCdEfG/');
    await h.drain();

    expect((await listRecentItems(h.db, h.account.id))[0]?.resolvedTier).toBe(1);
  });

  it('falls through honestly when the caption has no link and no LLM is configured', async () => {
    const h = await make({
      captions: { 'tiktok.com': { text: 'just a caption with no links at all' } },
    });
    await h.ingest('https://www.tiktok.com/@someone/video/7234567890123456789');
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('unresolvable');
    expect(items[0]?.failureReason).toMatch(/LLM provider/i);
  });

  it('survives oEmbed returning nothing', async () => {
    const h = await make({ captions: {} });
    await h.ingest('https://www.tiktok.com/@someone/video/7234567890123456789');
    await h.drain();
    expect((await listRecentItems(h.db, h.account.id))[0]?.status).toBe('unresolvable');
  });
});

describe('Tier 2 — language understanding', () => {
  const planesCandidate: VideoCandidate = {
    titleGuess: 'Why Planes Really Fly',
    channelGuess: 'Veritasium',
    confidence: 0.95,
  };

  it('resolves a caption that only describes a video', async () => {
    const h = await make({
      candidates: { veritasium: [planesCandidate] },
      searchResults: {
        '*': [
          {
            videoId: 'wrong',
            title: 'How Planes Land',
            channelTitle: 'Aviation Weekly',
            channelId: 'UC0',
          },
          {
            videoId: PLANES,
            title: 'Why Planes Really Fly',
            channelTitle: 'Veritasium',
            channelId: 'UC0',
          },
        ],
      },
    });

    await h.ingest('that Veritasium video about why planes fly is unreal');
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('added');
    expect(items[0]?.resolvedTier).toBe(2);
    expect(items[0]?.resolvedVideoId).toBe(PLANES);
    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(1);
  });

  it('spends exactly one search, not one per candidate', async () => {
    const h = await make({
      candidates: {
        veritasium: [
          planesCandidate,
          { titleGuess: 'Another Guess', confidence: 0.8 },
          { titleGuess: 'A Third Guess', confidence: 0.7 },
        ],
      },
      searchResults: {
        '*': [
          {
            videoId: PLANES,
            title: 'Why Planes Really Fly',
            channelTitle: 'Veritasium',
            channelId: 'UC0',
          },
        ],
      },
    });

    await h.ingest('that Veritasium one about planes');
    await h.drain();

    // At 100 units each, searching every candidate would burn the day in a dozen shares.
    expect(h.youtube.calls.filter((call) => call.operation === 'search.list')).toHaveLength(1);
  });

  it('never picks a video the LLM named directly — the ID always comes from search', async () => {
    const h = await make({
      // A model trying to smuggle an ID through the title field.
      candidates: { hallucinate: [{ titleGuess: 'dQw4w9WgXcQ', confidence: 1 }] },
      searchResults: { '*': [] },
    });

    await h.ingest('hallucinate something for me');
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('unresolvable');
    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(0);
  });

  it('holds for review when the model was unsure', async () => {
    const h = await make({
      candidates: { unsure: [{ ...planesCandidate, confidence: 0.5 }] },
      searchResults: {
        '*': [
          {
            videoId: PLANES,
            title: 'Why Planes Really Fly',
            channelTitle: 'Veritasium',
            channelId: 'UC0',
          },
        ],
      },
    });

    await h.ingest('unsure about that planes one');
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('held_for_review');
    expect(items[0]?.resolvedVideoId).toBe(PLANES);
    // Crucially: nothing was added.
    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(0);
  });

  it('notifies about a held item with a review link', async () => {
    const h = await make({
      candidates: { unsure: [{ ...planesCandidate, confidence: 0.5 }] },
      searchResults: {
        '*': [
          {
            videoId: PLANES,
            title: 'Why Planes Really Fly',
            channelTitle: 'Veritasium',
            channelId: 'UC0',
          },
        ],
      },
    });
    await h.ingest('unsure about that planes one');
    await h.drain();

    const held = h.notifications.find((n) => n.kind === 'item_held');
    expect(held).toMatchObject({ kind: 'item_held' });
    expect((held as { reviewUrl: string }).reviewUrl).toContain('/review');
  });

  it('gives up rather than guessing when nothing resembles the description', async () => {
    const h = await make({
      candidates: { planes: [planesCandidate] },
      searchResults: {
        '*': [
          {
            videoId: 'x',
            title: 'Sourdough For Beginners',
            channelTitle: 'Bread',
            channelId: 'UC0',
          },
        ],
      },
    });

    await h.ingest('that planes video');
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('unresolvable');
    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(0);
  });

  it('reports honestly when the model returns nothing', async () => {
    const h = await make({ candidates: { '*': [] }, llmProvider: 'fixture' });
    await h.ingest('some text that references nothing in particular');
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('unresolvable');
    expect(h.youtube.calls.some((call) => call.operation === 'search.list')).toBe(false);
  });

  it('feeds the caption to the model, not just the share text', async () => {
    const llm = fixtureLlm({ '*': [] });
    harness = await createHarness({
      youtube: { playlists: SEEDED },
      config: {
        llm: {
          provider: 'fixture',
          geminiApiKey: undefined,
          openaiBaseUrl: undefined,
          openaiApiKey: undefined,
          model: 'fixture',
        },
      },
      llm,
      platform: fixturePlatformMetadata({
        'tiktok.com': { text: 'the Veritasium one about planes' },
      }),
    });

    await harness.ingest('https://www.tiktok.com/@someone/video/7234567890123456789');
    await harness.drain();

    // The caption is usually where the recommendation lives; the share text is often just
    // "check this out".
    expect(llm.calls[0]?.text).toContain('Veritasium');
    expect(llm.calls[0]?.platform).toBe('tiktok');
  });
});

describe('the quota invariant holds across all tiers', () => {
  it('never searches when the share already contains a URL', async () => {
    const h = await make({
      candidates: { '*': [{ titleGuess: 'should never be asked', confidence: 1 }] },
      searchResults: {
        '*': [{ videoId: 'nope', title: 'nope', channelTitle: 'nope', channelId: 'UC0' }],
      },
    });

    await h.ingest(`omg watch this youtu.be/${VIDEO}`);
    await h.drain();

    expect(h.youtube.calls.some((call) => call.operation === 'search.list')).toBe(false);
    expect((await listRecentItems(h.db, h.account.id))[0]?.resolvedTier).toBe(0);
  });

  it('defers rather than dropping when the search would exceed the budget', async () => {
    const h = await make({
      candidates: { planes: [{ titleGuess: 'Why Planes Really Fly', confidence: 0.95 }] },
      searchResults: {
        '*': [
          {
            videoId: PLANES,
            title: 'Why Planes Really Fly',
            channelTitle: 'Veritasium',
            channelId: 'UC0',
          },
        ],
      },
      // Enough for a lookup but not for the 100-unit search.
      threshold: 0.5,
    });
    // Rebuild with a tight budget.
    h.close();
    harness = await createHarness({
      youtube: {
        playlists: SEEDED,
        searchResults: {
          '*': [
            {
              videoId: PLANES,
              title: 'Why Planes Really Fly',
              channelTitle: 'Veritasium',
              channelId: 'UC0',
            },
          ],
        },
      },
      config: {
        quota: { dailyBudget: 60, resetTimeZone: 'America/Los_Angeles' },
        llm: {
          provider: 'fixture',
          geminiApiKey: undefined,
          openaiBaseUrl: undefined,
          openaiApiKey: undefined,
          model: 'fixture',
        },
      },
      llm: fixtureLlm({ '*': [{ titleGuess: 'Why Planes Really Fly', confidence: 0.95 }] }),
      platform: fixturePlatformMetadata(),
    });

    await harness.ingest('that planes video');
    await harness.drain();

    const items = await listRecentItems(harness.db, harness.account.id);
    expect(items[0]?.status).toBe('deferred');
    expect(items[0]?.failureReason).toMatch(/quota/i);
  });
});

describe('the review inbox', () => {
  async function withHeldItem(): Promise<Harness> {
    const h = await make({
      candidates: {
        unsure: [
          { titleGuess: 'Why Planes Really Fly', channelGuess: 'Veritasium', confidence: 0.5 },
        ],
      },
      searchResults: {
        '*': [
          {
            videoId: PLANES,
            title: 'Why Planes Really Fly',
            channelTitle: 'Veritasium',
            channelId: 'UC0',
          },
        ],
      },
    });
    await h.ingest('unsure about that planes one');
    await h.drain();
    return h;
  }

  it('lists held items with what Later thinks and how sure it is', async () => {
    const h = await withHeldItem();
    const body = await (await h.request('/review')).text();

    expect(body).toContain('Why Planes Really Fly');
    expect(body).toContain('Veritasium');
    expect(body).toMatch(/% confident/);
    expect(body).toContain('Add it');
    expect(body).toContain('Skip');
  });

  it('adds the video when confirmed', async () => {
    const h = await withHeldItem();
    const item = (await listRecentItems(h.db, h.account.id))[0];

    const response = await h.request(`/review/${item?.id}/confirm`, { method: 'POST' });
    expect(response.status).toBe(302);
    await h.drain();

    const after = (await listRecentItems(h.db, h.account.id))[0];
    expect(after?.status).toBe('added');
    // A human confirming is better evidence than any score.
    expect(after?.confidence).toBe(1);
    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(1);
  });

  it('still applies the dedupe guard on confirmation', async () => {
    const h = await withHeldItem();
    // The same video arrives by a direct link and is added first.
    await h.ingest(`https://youtu.be/${PLANES}`);
    await h.drain();
    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(1);

    const held = (await listRecentItems(h.db, h.account.id)).find(
      (i) => i.status === 'held_for_review',
    );
    await h.request(`/review/${held?.id}/confirm`, { method: 'POST' });
    await h.drain();

    // Confirmation goes through the normal pipeline, so it hits the duplicate check rather
    // than bypassing it.
    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(1);
    const after = await listRecentItems(h.db, h.account.id);
    expect(after.find((i) => i.id === held?.id)?.status).toBe('duplicate');
  });

  it('marks an item rejected when skipped, and adds nothing', async () => {
    const h = await withHeldItem();
    const item = (await listRecentItems(h.db, h.account.id))[0];

    await h.request(`/review/${item?.id}/reject`, { method: 'POST' });

    expect((await listRecentItems(h.db, h.account.id))[0]?.status).toBe('rejected');
    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(0);
  });

  it('shows an empty state rather than a blank page', async () => {
    const h = await make({});
    const body = await (await h.request('/review')).text();
    expect(body).toContain('Nothing waiting');
  });

  it('refuses an item id that is not yours', async () => {
    const h = await withHeldItem();
    const response = await h.request('/review/itm_doesnotexist/confirm', { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('ignores a confirm on an item that is not held', async () => {
    const h = await make({});
    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();
    const item = (await listRecentItems(h.db, h.account.id))[0];

    const response = await h.request(`/review/${item?.id}/confirm`, { method: 'POST' });
    expect(response.status).toBe(302);
    // Still added once, not twice.
    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(1);
  });
});
