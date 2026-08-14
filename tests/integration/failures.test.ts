/**
 * The failure modes that decide whether a stranger's deployment survives.
 *
 * Straight from §11 of the brief:
 *   - token expiry produces a clear notification and a working re-auth — not silence
 *   - quota exhaustion queues and retries — never drops
 *   - duplicates never double-add
 *
 * All three are exercised end-to-end with no credentials, which is the whole point of the
 * fixture client existing before the OAuth console work was done.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { nextQuotaReset } from '../../src/core/quota.ts';
import {
  getAccountById,
  listPlaylistEntries,
  listRecentItems,
  sumQuotaForDate,
} from '../../src/db/repo.ts';
import { jobs } from '../../src/db/schema.ts';
import { createHarness, type Harness, T0 } from '../helpers/harness.ts';

const VIDEO = 'dQw4w9WgXcQ';
const VIDEO2 = '9bZkp7q19f0';
const SEEDED_PLAYLIST = [{ id: 'PLseeded', title: 'Later' }];

let harness: Harness | undefined;

afterEach(() => {
  harness?.close();
  harness = undefined;
});

async function make(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness(options);
  return harness;
}

describe('quota exhaustion queues and retries, never drops', () => {
  it('defers the item instead of failing it', async () => {
    // Budget covers videos.list (1) + playlists.list (1) but not the 50-unit insert.
    const h = await make({
      youtube: { playlists: SEEDED_PLAYLIST },
      config: { quota: { dailyBudget: 51, resetTimeZone: 'America/Los_Angeles' } },
    });

    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('deferred');
    expect(items[0]?.failureReason).toMatch(/quota/i);
    // The promise that matters: nothing was lost.
    expect(items[0]?.failureReason).toMatch(/won't be lost|will not be lost/i);
  });

  it('keeps the video out of the playlist rather than half-adding it', async () => {
    const h = await make({
      youtube: { playlists: SEEDED_PLAYLIST },
      config: { quota: { dailyBudget: 51, resetTimeZone: 'America/Los_Angeles' } },
    });

    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    // The claim row must have been rolled back, or the video would be marked as saved when
    // it is not — the one outcome worse than a duplicate.
    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(0);
    expect([...h.youtube.playlistContents.values()].flat()).toEqual([]);
  });

  it('reschedules the job for the next quota reset', async () => {
    const h = await make({
      youtube: { playlists: SEEDED_PLAYLIST },
      config: { quota: { dailyBudget: 51, resetTimeZone: 'America/Los_Angeles' } },
    });

    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    const rows = await h.db.select().from(jobs);
    const job = rows[0];
    expect(job?.status).toBe('pending');
    expect(job?.runAfter).toBe(nextQuotaReset(T0, 'America/Los_Angeles').getTime());
  });

  it('does not consume a retry attempt, so quota can never exhaust the retries', async () => {
    const h = await make({
      youtube: { playlists: SEEDED_PLAYLIST },
      config: { quota: { dailyBudget: 51, resetTimeZone: 'America/Los_Angeles' } },
    });

    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    // Claiming the job incremented `attempts` to 1; the quota deferral must give it back.
    // Without this, a share sitting behind a busy quota for a few days would eventually be
    // marked permanently failed for reasons of accounting rather than anything being wrong
    // with it.
    const rows = await h.db.select().from(jobs);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.attempts).toBe(0);
  });

  it('saves the video once quota is available again', async () => {
    const h = await make({
      youtube: { playlists: SEEDED_PLAYLIST },
      config: { quota: { dailyBudget: 51, resetTimeZone: 'America/Los_Angeles' } },
    });

    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();
    expect((await listRecentItems(h.db, h.account.id))[0]?.status).toBe('deferred');

    // Next quota day: the ledger is keyed per day, so yesterday's spend no longer counts.
    h.clock.set(nextQuotaReset(T0, 'America/Los_Angeles').getTime() + 60_000);
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('added');
    expect([...h.youtube.playlistContents.values()].flat()).toEqual([VIDEO]);
  });

  it('records spend in the ledger against the Pacific quota day', async () => {
    const h = await make({ youtube: { playlists: SEEDED_PLAYLIST } });
    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    // 2026-08-06T20:00Z is 13:00 Pacific on the 6th.
    expect(await sumQuotaForDate(h.db, '2026-08-06')).toBe(52);
    expect(await sumQuotaForDate(h.db, '2026-08-07')).toBe(0);
  });
});

describe('token expiry is loud, not silent', () => {
  it('parks the item, flips the account, and notifies exactly once', async () => {
    const h = await make({ youtube: { playlists: SEEDED_PLAYLIST } });
    h.youtube.failNext({ kind: 'invalid_grant' });

    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('parked');

    const account = await getAccountById(h.db, h.account.id);
    expect(account?.status).toBe('reauth_required');

    const reauth = h.notifications.filter((n) => n.kind === 'reauth_required');
    expect(reauth).toHaveLength(1);
  });

  it('sends a re-auth link that actually points at the auth flow', async () => {
    const h = await make({ youtube: { playlists: SEEDED_PLAYLIST } });
    h.youtube.failNext({ kind: 'invalid_grant' });
    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    const notification = h.notifications.find((n) => n.kind === 'reauth_required');
    expect(notification).toMatchObject({
      kind: 'reauth_required',
      email: 'owner@example.com',
      reauthUrl: 'http://localhost:8787/auth/start',
    });

    // And that link must serve something, not 404.
    const response = await h.request(
      (notification as { reauthUrl: string }).reauthUrl.replace('http://localhost:8787', ''),
      { redirect: 'manual' },
    );
    expect([302, 200]).toContain(response.status);
  });

  it('does not re-notify on every subsequent attempt', async () => {
    const h = await make({ youtube: { playlists: SEEDED_PLAYLIST } });
    h.youtube.failNext({ kind: 'invalid_grant' });
    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    // More shares arrive while authorisation is dead.
    await h.ingest(`https://youtu.be/${VIDEO2}`);
    await h.drain();
    await h.drain();

    expect(h.notifications.filter((n) => n.kind === 'reauth_required')).toHaveLength(1);
  });

  it('parks the queue rather than failing it, so nothing is lost', async () => {
    const h = await make({ youtube: { playlists: SEEDED_PLAYLIST } });
    h.youtube.failNext({ kind: 'invalid_grant' });
    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    const rows = await h.db.select().from(jobs);
    expect(rows.every((job) => job.status === 'parked')).toBe(true);
    expect(rows.some((job) => job.status === 'failed')).toBe(false);
  });

  it('drains the backlog after re-authorisation', async () => {
    const h = await make({ youtube: { playlists: SEEDED_PLAYLIST } });
    h.youtube.failNext({ kind: 'invalid_grant' });

    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();
    // A second share made during the dead window.
    await h.ingest(`https://youtu.be/${VIDEO2}`);
    await h.drain();

    expect([...h.youtube.playlistContents.values()].flat()).toEqual([]);

    // The user taps the re-auth link and reconnects.
    await h.runtime.tokens.onReauthorised(h.account.id);
    await h.drain();

    // Both shares from the outage land. This is the difference between an outage and
    // data loss.
    expect([...h.youtube.playlistContents.values()].flat().sort()).toEqual([VIDEO, VIDEO2].sort());
    const items = await listRecentItems(h.db, h.account.id);
    expect(items.every((item) => item.status === 'added')).toBe(true);
  });

  it('refuses to use tokens while the account is awaiting re-authorisation', async () => {
    const h = await make({ youtube: { playlists: SEEDED_PLAYLIST } });
    await h.runtime.tokens.markReauthRequired(h.account.id, 'test');

    await expect(h.runtime.tokens.getAccessToken(h.account.id)).rejects.toThrow(
      /awaiting re-authorisation/i,
    );
  });
});

describe('transient failures retry rather than fail', () => {
  it('recovers after a single 503', async () => {
    const h = await make({ youtube: { playlists: SEEDED_PLAYLIST } });
    h.youtube.failNext({ kind: 'transient', times: 1 });

    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    // Backoff pushes the retry into the future, so advance and sweep again.
    h.clock.advance(60_000);
    await h.drain();

    expect((await listRecentItems(h.db, h.account.id))[0]?.status).toBe('added');
  });

  it('gives up after the retry budget and records why', async () => {
    const h = await make({ youtube: { playlists: SEEDED_PLAYLIST } });
    h.youtube.failNext({ kind: 'transient', times: 50 });

    await h.ingest(`https://youtu.be/${VIDEO}`);
    for (let i = 0; i < 10; i += 1) {
      await h.drain();
      h.clock.advance(2 * 60 * 60 * 1000);
    }

    const rows = await h.db.select().from(jobs);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.lastError).toMatch(/transient|503/i);
  });
});

describe('Watch Later is refused in code, not just in documentation', () => {
  it('throws a named error rather than issuing a doomed API call', async () => {
    const h = await make({ youtube: { playlists: [{ id: 'WL', title: 'Later' }] } });

    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('failed');
    expect(items[0]?.failureReason).toMatch(/Watch Later/i);
    expect(items[0]?.failureReason).toMatch(/2016/);
  });

  it('spends no insert quota on a doomed write', async () => {
    const h = await make({ youtube: { playlists: [{ id: 'WL', title: 'Later' }] } });
    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();
    expect(h.youtube.calls.some((call) => call.operation === 'playlistItems.insert')).toBe(false);
  });
});

describe('a broken notification channel never breaks the pipeline', () => {
  it('still saves the video when notifications throw', async () => {
    const h = await make({
      youtube: { playlists: SEEDED_PLAYLIST },
      notifierFailing: true,
      config: {
        notify: {
          telegramBotToken: undefined,
          telegramAllowedChatIds: [],
          telegramWebhookSecret: undefined,
          webhookUrl: undefined,
          onSuccess: true,
        },
      },
    });

    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    expect((await listRecentItems(h.db, h.account.id))[0]?.status).toBe('added');
    expect([...h.youtube.playlistContents.values()].flat()).toEqual([VIDEO]);
  });
});

describe('the playlist going missing heals itself', () => {
  it('re-creates the playlist and retries the insert', async () => {
    const h = await make({ youtube: { playlists: SEEDED_PLAYLIST } });

    // First share succeeds and caches the playlist ID.
    await h.ingest(`https://youtu.be/${VIDEO}`);
    await h.drain();

    // The user deletes the playlist in the YouTube app. The account still has the old ID
    // cached, so the next insert hits a playlist that no longer exists.
    h.youtube.removePlaylist('PLseeded');

    await h.ingest(`https://youtu.be/${VIDEO2}`);
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    const second = items.find((item) => item.resolvedVideoId === VIDEO2);
    expect(second?.status).toBe('added');

    // A fresh playlist was created and the video landed in it.
    const created = h.youtube.calls.filter((call) => call.operation === 'playlists.insert');
    expect(created).toHaveLength(1);
    expect([...h.youtube.playlistContents.values()].flat()).toEqual([VIDEO2]);
  });
});
