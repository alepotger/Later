/**
 * MULTI mode.
 *
 * The property under test throughout is isolation: two accounts on one instance must never see
 * or write to each other's playlist, and the thing that separates them is a token or a signed
 * cookie rather than a `WHERE` clause somebody remembered to add.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/core/bytes.ts';
import {
  getAccountById,
  listRecentItems,
  setAccountIngestTokenHash,
  setAccountTelegramChatId,
  upsertAccount,
} from '../../src/db/repo.ts';
import type { Account } from '../../src/db/schema.ts';
import { signValue } from '../../src/http/session.ts';
import { createHarness, type Harness, T0 } from '../helpers/harness.ts';

const SESSION_SECRET = 'test-session-secret';

async function multiHarness(extra: Record<string, unknown> = {}): Promise<Harness> {
  return await createHarness({
    config: {
      mode: 'MULTI',
      allowedEmails: ['owner@example.com', 'second@example.com'],
      ...extra,
    },
  });
}

/** A second account, with its own ingest token. Returns the plaintext token. */
async function addAccount(
  harness: Harness,
  email: string,
  googleUserId: string,
): Promise<{ account: Account; token: string }> {
  const account = await upsertAccount(
    harness.db,
    {
      googleUserId,
      email,
      displayName: email,
      refreshTokenCipher: await harness.runtime.vault.encrypt('refresh-2'),
      accessTokenCipher: await harness.runtime.vault.encrypt('access-2'),
      accessTokenExpiresAt: T0.getTime() + 3_600_000,
    },
    T0.getTime(),
  );
  const token = `token-for-${googleUserId}-long-enough-to-be-realistic`;
  await setAccountIngestTokenHash(harness.db, account.id, await sha256Hex(token), T0.getTime());
  return { account, token };
}

async function sessionCookieFor(accountId: string): Promise<string> {
  const value = await signValue(
    SESSION_SECRET,
    'session',
    accountId,
    T0.getTime() + 60 * 60 * 1000,
  );
  return `later_session=${value}`;
}

describe('MULTI ingest authentication', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await multiHarness();
  });

  it('rejects the instance-wide INGEST_TOKEN, which authenticates nothing in MULTI', async () => {
    const response = await harness.ingest('https://youtu.be/dQw4w9WgXcQ');
    expect(response.status).toBe(401);
  });

  it('routes a share to the account that owns the presented token', async () => {
    const { account: second, token } = await addAccount(harness, 'second@example.com', 'google-2');

    const response = await harness.ingest('https://youtu.be/dQw4w9WgXcQ', { token });
    expect(response.status).toBe(202);
    await harness.drain();

    const theirs = await listRecentItems(harness.db, second.id, 10);
    const owners = await listRecentItems(harness.db, harness.account.id, 10);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.resolvedVideoId).toBe('dQw4w9WgXcQ');
    // The share belongs to exactly one account, not to whoever happened to be created first.
    expect(owners).toHaveLength(0);
  });

  it('returns the same 401 for an unknown token as for a missing one', async () => {
    const unknown = await harness.ingest('https://youtu.be/dQw4w9WgXcQ', { token: 'nope' });
    const missing = await harness.request('/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"text":"https://youtu.be/dQw4w9WgXcQ"}',
    });

    expect(unknown.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(await unknown.json()).toEqual(await missing.json());
  });

  it('keeps working after a token is replaced, and stops accepting the old one', async () => {
    const { account, token: original } = await addAccount(harness, 'second@example.com', 'g2');

    const replacement = 'a-freshly-minted-token-value-for-the-same-account';
    await setAccountIngestTokenHash(
      harness.db,
      account.id,
      await sha256Hex(replacement),
      T0.getTime(),
    );

    expect((await harness.ingest('https://youtu.be/aaaaaaaaaaa', { token: original })).status).toBe(
      401,
    );
    expect(
      (await harness.ingest('https://youtu.be/dQw4w9WgXcQ', { token: replacement })).status,
    ).toBe(202);
  });
});

describe('MULTI web session', () => {
  it('shows a sign-in page rather than the setup page when there is no cookie', async () => {
    const harness = await multiHarness();
    const body = await (await harness.request('/')).text();

    expect(body).toContain('Sign in');
    expect(body).toContain('Continue with Google');
    // The SOLO setup wording would be wrong here: the instance is already set up.
    expect(body).not.toContain('Not connected yet');
  });

  it('shows the session account, and only its own shares', async () => {
    const harness = await multiHarness();
    const { account: second, token } = await addAccount(harness, 'second@example.com', 'g2');

    await harness.ingest('https://youtu.be/dQw4w9WgXcQ', { token });
    await harness.drain();

    const theirs = await (
      await harness.request('/', { headers: { cookie: await sessionCookieFor(second.id) } })
    ).text();
    expect(theirs).toContain('second@example.com');
    expect(theirs).toContain('dQw4w9WgXcQ');

    const owners = await (
      await harness.request('/', {
        headers: { cookie: await sessionCookieFor(harness.account.id) },
      })
    ).text();
    expect(owners).toContain('owner@example.com');
    expect(owners).not.toContain('dQw4w9WgXcQ');
  });

  it('refuses a cookie signed with the wrong secret', async () => {
    const harness = await multiHarness();
    const forged = await signValue(
      'not-the-session-secret',
      'session',
      harness.account.id,
      T0.getTime() + 60_000,
    );

    const body = await (
      await harness.request('/', { headers: { cookie: `later_session=${forged}` } })
    ).text();
    expect(body).toContain('Continue with Google');
  });

  it('refuses an expired cookie', async () => {
    const harness = await multiHarness();
    const stale = await signValue(
      SESSION_SECRET,
      'session',
      harness.account.id,
      T0.getTime() - 1000,
    );

    const body = await (
      await harness.request('/', { headers: { cookie: `later_session=${stale}` } })
    ).text();
    expect(body).toContain('Continue with Google');
  });

  it('refuses a Telegram link code presented as a session cookie', async () => {
    const harness = await multiHarness();
    // Same key, same account, same format — only the purpose differs. Without domain
    // separation this 15-minute code would grant a 30-day session.
    const linkCode = await signValue(
      SESSION_SECRET,
      'telegram-link',
      harness.account.id,
      T0.getTime() + 60_000,
    );

    const body = await (
      await harness.request('/', { headers: { cookie: `later_session=${linkCode}` } })
    ).text();
    expect(body).toContain('Continue with Google');
  });

  it('mints a token that immediately works, and shows it exactly once', async () => {
    const harness = await multiHarness();
    const cookie = await sessionCookieFor(harness.account.id);

    const minted = await harness.request('/account/ingest-token', {
      method: 'POST',
      headers: { cookie },
    });
    expect(minted.status).toBe(200);

    const body = await minted.text();
    const match = /<code>([A-Za-z0-9_-]{30,})<\/code>/.exec(body);
    expect(match).not.toBeNull();
    const token = match?.[1] as string;

    expect((await harness.ingest('https://youtu.be/dQw4w9WgXcQ', { token })).status).toBe(202);

    // Reloading the page must not show it again — only the hash is stored.
    const reloaded = await (await harness.request('/', { headers: { cookie } })).text();
    expect(reloaded).not.toContain(token);
  });

  it('signs out by clearing the cookie', async () => {
    const harness = await multiHarness();
    const response = await harness.request('/auth/signout', {
      method: 'POST',
      headers: { cookie: await sessionCookieFor(harness.account.id) },
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('404s the account routes in SOLO, where they have no meaning', async () => {
    const harness = await createHarness();
    const response = await harness.request('/account/ingest-token', { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('never shows the account panel in SOLO', async () => {
    const harness = await createHarness();
    const body = await (await harness.request('/')).text();
    expect(body).not.toContain('Your account');
    expect(body).not.toContain('Sign out');
  });
});

describe('MULTI Telegram linking', () => {
  const CHAT = '4242';

  function telegramHarness(): Promise<Harness> {
    return createHarness({
      config: {
        mode: 'MULTI',
        allowedEmails: ['owner@example.com', 'second@example.com'],
        notify: {
          telegramBotToken: 'bot-token',
          // Deliberately empty: in MULTI, linking replaces the env allowlist.
          telegramAllowedChatIds: [],
          telegramWebhookSecret: 'hook-secret',
          webhookUrl: undefined,
          onSuccess: false,
        },
      },
      notifier: null,
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
  }

  async function send(harness: Harness, text: string, chatId = CHAT): Promise<Response> {
    return await harness.request('/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'hook-secret',
      },
      body: JSON.stringify({
        update_id: 1,
        message: { message_id: 1, chat: { id: Number(chatId) }, text },
      }),
    });
  }

  it('links a chat to the account named in a signed code', async () => {
    const harness = await telegramHarness();
    const code = await signValue(
      SESSION_SECRET,
      'telegram-link',
      harness.account.id,
      T0.getTime() + 60_000,
    );

    expect((await send(harness, `/link ${code}`)).status).toBe(200);

    const account = await getAccountById(harness.db, harness.account.id);
    expect(account?.telegramChatId).toBe(CHAT);
  });

  it('rejects an expired code and leaves the chat unlinked', async () => {
    const harness = await telegramHarness();
    const stale = await signValue(
      SESSION_SECRET,
      'telegram-link',
      harness.account.id,
      T0.getTime() - 1,
    );

    await send(harness, `/link ${stale}`);

    const account = await getAccountById(harness.db, harness.account.id);
    expect(account?.telegramChatId).toBeNull();
  });

  it('ingests to the linked account and not to anyone else', async () => {
    const harness = await telegramHarness();
    const { account: second } = await addAccount(harness, 'second@example.com', 'g2');
    await setAccountTelegramChatId(harness.db, second.id, CHAT, T0.getTime());

    await send(harness, 'look at this https://youtu.be/dQw4w9WgXcQ');
    await harness.drain();

    expect(await listRecentItems(harness.db, second.id, 10)).toHaveLength(1);
    expect(await listRecentItems(harness.db, harness.account.id, 10)).toHaveLength(0);
  });

  it('does not ingest from an unlinked chat', async () => {
    const harness = await telegramHarness();

    await send(harness, 'https://youtu.be/dQw4w9WgXcQ', '9999');
    await harness.drain();

    expect(await listRecentItems(harness.db, harness.account.id, 10)).toHaveLength(0);
  });
});
