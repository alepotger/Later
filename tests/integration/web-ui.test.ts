/**
 * The web UI.
 *
 * Rarely visited and load-bearing when it is: the paste box is the fallback ingress and the
 * debugging tool, and the banners are the safety net when no notification channel is
 * configured.
 *
 * The flash-message cases below are a regression suite for a bug found by following SETUP.md
 * literally — re-pasting an identical link reported "1 saved" a second time, which is
 * technically true and reads as a fresh save.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.ts';

const VIDEO = 'dQw4w9WgXcQ';
const VIDEO2 = '9bZkp7q19f0';

let harness: Harness | undefined;

afterEach(() => {
  harness?.close();
  harness = undefined;
});

async function make(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness(options);
  return harness;
}

/** Post to the paste box and return the flash banner's text. */
async function paste(h: Harness, text: string): Promise<string> {
  const response = await h.request('/share', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ text }).toString(),
  });
  const html = (await response.text()).replace(/\n/g, ' ');
  const match = /banner (?:ok|bad)">\s*<strong>(.*?)<\/strong>(.*?)<\/div>/.exec(html);
  return match ? `${match[1]} — ${match[2]?.trim()}` : '(no flash)';
}

describe('paste box outcomes are distinguishable', () => {
  it('reports a fresh save', async () => {
    const h = await make();
    expect(await paste(h, `https://youtu.be/${VIDEO}`)).toMatch(/Got it — 1 saved/);
  });

  it('reports a re-share as already shared, not as a second save', async () => {
    const h = await make();
    await paste(h, `https://youtu.be/${VIDEO}`);
    expect(await paste(h, `https://youtu.be/${VIDEO}`)).toMatch(/Already shared/);
  });

  it('reports the same video via a different URL form as already in the playlist', async () => {
    const h = await make();
    await paste(h, `https://youtu.be/${VIDEO}`);
    expect(await paste(h, `look at this youtube.com/watch?v=${VIDEO}`)).toMatch(
      /1 already in the playlist/,
    );
  });

  it('explains a channel link rather than just failing', async () => {
    const h = await make();
    expect(await paste(h, 'https://youtube.com/@veritasium')).toMatch(
      /Nothing saved — That looks like a YouTube channel link/,
    );
  });

  it('handles a second, different video normally', async () => {
    const h = await make();
    await paste(h, `https://youtu.be/${VIDEO}`);
    expect(await paste(h, `https://youtu.be/${VIDEO2}`)).toMatch(/Got it — 1 saved/);
  });

  it('ignores an empty paste without an error', async () => {
    const h = await make();
    expect(await paste(h, '   ')).toBe('(no flash)');
  });
});

describe('the home page', () => {
  it('shows the destination playlist and the account', async () => {
    const h = await make();
    const body = await (await h.request('/')).text();
    expect(body).toContain('owner@example.com');
    expect(body).toContain('Later');
  });

  it('shows the real video title once resolved, not the raw share text', async () => {
    const h = await make();
    await h.ingest(`some caption https://youtu.be/${VIDEO}`);
    await h.drain();

    const body = await (await h.request('/')).text();
    expect(body).toContain('Never Gonna Give You Up');
  });

  it('shows quota as something actionable, not just a unit count', async () => {
    const h = await make();
    const body = await (await h.request('/')).text();
    expect(body).toMatch(/of 9000 units used/);
    expect(body).toMatch(/more links today/);
  });

  it('warns about the 7-day expiry when the OAuth app is in Testing', async () => {
    const h = await make({
      config: {
        google: {
          clientId: 'x.apps.googleusercontent.com',
          clientSecret: 'y',
          publishingStatus: 'testing',
        },
      },
    });
    const body = await (await h.request('/')).text();
    expect(body).toContain('Authorisation will expire in 7 days');
    expect(body).toContain('Publish app');
  });

  it('does not warn when the app is published', async () => {
    const h = await make();
    const body = await (await h.request('/')).text();
    expect(body).not.toContain('Authorisation will expire in 7 days');
  });

  it('shows the reauth banner with a working link when authorisation is dead', async () => {
    const h = await make();
    await h.runtime.tokens.markReauthRequired(h.account.id, 'test');

    const body = await (await h.request('/')).text();
    expect(body).toContain('Later has stopped saving videos');
    expect(body).toContain('/auth/start');
  });

  it('states the Watch Later limitation on every page', async () => {
    const h = await make();
    const body = await (await h.request('/')).text();
    expect(body).toMatch(/not<\/strong> your native Watch/);
    expect(body).toContain('2016');
  });
});

describe('escaping', () => {
  it('does not render markup from shared text', async () => {
    const h = await make();
    await paste(h, '<img src=x onerror="alert(1)"> no link here');

    const body = await (await h.request('/')).text();
    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&lt;img src=x');
  });
});

describe('PWA share target', () => {
  it('prefills the box from the Android share sheet parameters', async () => {
    const h = await make();
    const response = await h.request(
      `/share-target?title=Cool&text=${encodeURIComponent(`watch youtu.be/${VIDEO}`)}&url=https://vm.tiktok.com/ZMabc/`,
    );
    const body = await response.text();
    expect(body).toContain('Shared from another app');
    expect(body).toContain(`youtu.be/${VIDEO}`);
  });

  it('advertises a GET share target, which needs no service worker', async () => {
    const h = await make();
    const manifest = (await (await h.request('/manifest.webmanifest')).json()) as {
      share_target: { method: string; action: string };
    };
    expect(manifest.share_target.method).toBe('GET');
    expect(manifest.share_target.action).toBe('/share-target');
  });
});

describe('operational endpoints', () => {
  it('serves healthz', async () => {
    const h = await make();
    expect(await (await h.request('/healthz')).json()).toEqual({ ok: true, mode: 'SOLO' });
  });

  it('echoes a request id so logs can be correlated', async () => {
    const h = await make();
    const response = await h.request('/healthz', { headers: { 'x-request-id': 'abc123' } });
    expect(response.headers.get('x-request-id')).toBe('abc123');
  });

  it('generates a request id when the client does not send one', async () => {
    const h = await make();
    const response = await h.request('/healthz');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('renders a 404 page rather than a blank response', async () => {
    const h = await make();
    const response = await h.request('/nope');
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Not found');
  });
});

describe('SOLO mode locks the instance to one account', () => {
  it('redirects an already-connected instance away from /auth/start', async () => {
    const h = await make();
    const response = await h.request('/auth/start', { redirect: 'manual' });
    // Already connected and healthy, so there is nothing to authorise — a stranger who finds
    // the URL cannot attach their own account.
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
  });

  it('allows re-authorisation when the account needs it', async () => {
    const h = await make();
    await h.runtime.tokens.markReauthRequired(h.account.id, 'test');
    const response = await h.request('/auth/start', { redirect: 'manual' });
    // Now it must proceed, or the re-auth link in the notification would be a dead end.
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('accounts.google.com');
  });

  it('requests exactly one YouTube scope, with offline access and forced consent', async () => {
    const h = await make();
    await h.runtime.tokens.markReauthRequired(h.account.id, 'test');
    const location = (await h.request('/auth/start', { redirect: 'manual' })).headers.get(
      'location',
    );
    const url = new URL(location ?? '');
    const scopes = (url.searchParams.get('scope') ?? '').split(' ');

    expect(scopes).toContain('https://www.googleapis.com/auth/youtube');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/youtube.force-ssl');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/youtubepartner');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});
