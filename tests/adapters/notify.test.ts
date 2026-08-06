/**
 * Notification rendering and the Telegram adapter.
 *
 * The `reauth_required` wording is asserted in detail on purpose: it is the one message that
 * has to make a person act, and if it is vague the deployment simply stays broken. Everything
 * else here guards the two rules that keep a notification channel from becoming a liability —
 * a failing channel must not break the pipeline, and an un-allowlisted chat must be ignored.
 */

import { describe, expect, it } from 'vitest';
import {
  createTelegramClient,
  isAllowedChat,
  parseTelegramUpdate,
  telegramNotifier,
  type TelegramConfig,
} from '../../src/adapters/notify/telegram.ts';
import { renderNotification, toPlainText } from '../../src/adapters/notify/messages.ts';
import { fanout, webhookNotifier } from '../../src/adapters/notify/webhook.ts';
import { silentLogger } from '../../src/ports/logger.ts';
import { recordingNotifier, type Notification } from '../../src/ports/notifier.ts';

const CONFIG: TelegramConfig = {
  botToken: '123:ABC',
  allowedChatIds: ['4242'],
  webhookSecret: 'secret',
};

interface Captured {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function stubFetch(options: { ok?: boolean } = {}): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    });
    const ok = options.ok !== false;
    return new Response(JSON.stringify({ ok, result: true }), { status: ok ? 200 : 500 });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

describe('reauth_required wording', () => {
  const base = {
    kind: 'reauth_required' as const,
    email: 'owner@example.com',
    reauthUrl: 'https://later.example.com/auth/start',
  };

  it('says what broke and that nothing was lost', () => {
    const rendered = renderNotification({ ...base, publishingStatus: 'production' });
    expect(rendered.title).toMatch(/stopped saving/i);
    expect(rendered.body).toContain('owner@example.com');
    expect(rendered.body).toMatch(/nothing has been lost/i);
    expect(rendered.body).toMatch(/queued/i);
  });

  it('carries a one-tap action', () => {
    const rendered = renderNotification({ ...base, publishingStatus: 'production' });
    expect(rendered.action).toEqual({
      label: 'Reconnect Google',
      url: 'https://later.example.com/auth/start',
    });
  });

  it('is marked urgent, so channels do not deliver it quietly', () => {
    expect(renderNotification({ ...base, publishingStatus: 'production' }).urgent).toBe(true);
  });

  it('explains the 7-day cause when the app is still in Testing', () => {
    const rendered = renderNotification({ ...base, publishingStatus: 'testing' });
    expect(rendered.body).toMatch(/every 7 days/);
    expect(rendered.body).toMatch(/Publish app/);
    expect(rendered.body).toMatch(/GOOGLE_OAUTH_PUBLISHING_STATUS=production/);
  });

  it('omits that paragraph in production, where it would be noise', () => {
    const rendered = renderNotification({ ...base, publishingStatus: 'production' });
    expect(rendered.body).not.toMatch(/every 7 days/);
  });
});

describe('other notifications', () => {
  it('renders a save with the title and destination', () => {
    const rendered = renderNotification({
      kind: 'item_added',
      videoId: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      playlistName: 'Later',
    });
    expect(rendered.body).toBe('Never Gonna Give You Up → Later');
    expect(rendered.urgent).toBe(false);
  });

  it('falls back to the video ID when there is no title', () => {
    const rendered = renderNotification({
      kind: 'item_added',
      videoId: 'dQw4w9WgXcQ',
      title: '',
      playlistName: 'Later',
    });
    expect(rendered.body).toContain('dQw4w9WgXcQ');
  });

  it('states the confidence as a percentage for a held item', () => {
    const rendered = renderNotification({
      kind: 'item_held',
      itemId: 'itm_1',
      guess: 'Why Planes Really Fly',
      confidence: 0.62,
      reviewUrl: 'https://later.example.com/review/itm_1',
    });
    expect(rendered.body).toContain('62% sure');
    expect(rendered.body).toMatch(/has not been added/);
    expect(rendered.action?.url).toContain('/review/itm_1');
  });

  it('truncates a long shared text rather than dumping a whole caption', () => {
    const rendered = renderNotification({
      kind: 'item_failed',
      reason: 'No YouTube video found.',
      sharedText: 'x'.repeat(500),
    });
    expect(rendered.body.length).toBeLessThan(300);
    expect(rendered.body).toContain('…');
  });

  it('collapses whitespace in shared text so it reads as one line', () => {
    const rendered = renderNotification({
      kind: 'item_failed',
      reason: 'nope',
      sharedText: 'lots\n\n  of\t\twhitespace',
    });
    expect(rendered.body).toContain('lots of whitespace');
  });

  it('formats the quota retry time readably, not as a raw ISO string', () => {
    const rendered = renderNotification({
      kind: 'quota_exhausted',
      retryAt: new Date('2026-08-07T07:00:00Z'),
      queued: 3,
    });
    expect(rendered.body).toContain('2026-08-07 07:00 UTC');
    expect(rendered.body).toContain('3 videos are');
    expect(rendered.body).toMatch(/nothing has been lost/i);
  });

  it('gets the singular right for one queued video', () => {
    const rendered = renderNotification({
      kind: 'quota_exhausted',
      retryAt: new Date('2026-08-07T07:00:00Z'),
      queued: 1,
    });
    expect(rendered.body).toContain('1 video is');
  });
});

describe('toPlainText', () => {
  it('includes the action as a labelled URL', () => {
    const text = toPlainText(
      renderNotification({
        kind: 'reauth_required',
        email: 'a@b.c',
        reauthUrl: 'https://x.example/auth/start',
        publishingStatus: 'production',
      }),
    );
    expect(text).toContain('Reconnect Google: https://x.example/auth/start');
  });
});

describe('telegram sending', () => {
  it('posts to the bot API with the chat id and text', async () => {
    const stub = stubFetch();
    const client = createTelegramClient(CONFIG, { logger: silentLogger, fetch: stub.fetch });
    expect(await client.sendMessage('4242', 'hello')).toBe(true);

    expect(stub.calls[0]?.url).toBe('https://api.telegram.org/bot123:ABC/sendMessage');
    expect(stub.calls[0]?.body).toMatchObject({ chat_id: '4242', text: 'hello' });
  });

  it('never sets parse_mode, so a title with markup characters cannot drop the message', async () => {
    const stub = stubFetch();
    const client = createTelegramClient(CONFIG, { logger: silentLogger, fetch: stub.fetch });
    await client.sendMessage('4242', 'a *title* with _underscores_ and [brackets]');
    expect(stub.calls[0]?.body).not.toHaveProperty('parse_mode');
  });

  it('renders an action as an inline keyboard button', async () => {
    const stub = stubFetch();
    const client = createTelegramClient(CONFIG, { logger: silentLogger, fetch: stub.fetch });
    await client.sendMessage('4242', 'x', { action: { label: 'Go', url: 'https://e.example' } });
    expect(stub.calls[0]?.body).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: 'Go', url: 'https://e.example' }]] },
    });
  });

  it('returns false rather than throwing when the API errors', async () => {
    const stub = stubFetch({ ok: false });
    const client = createTelegramClient(CONFIG, { logger: silentLogger, fetch: stub.fetch });
    expect(await client.sendMessage('4242', 'x')).toBe(false);
  });

  it('returns false rather than throwing when the network fails', async () => {
    const failing = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const client = createTelegramClient(CONFIG, { logger: silentLogger, fetch: failing });
    expect(await client.sendMessage('4242', 'x')).toBe(false);
  });

  it('sends urgent messages audibly and everything else silently', async () => {
    const stub = stubFetch();
    const client = createTelegramClient(CONFIG, { logger: silentLogger, fetch: stub.fetch });
    const notifier = telegramNotifier(client, CONFIG, true);

    await notifier.send({
      kind: 'reauth_required',
      email: 'a@b.c',
      reauthUrl: 'https://x/auth',
      publishingStatus: 'production',
    });
    await notifier.send({ kind: 'item_added', videoId: 'v', title: 't', playlistName: 'Later' });

    expect(stub.calls[0]?.body).toMatchObject({ disable_notification: false });
    expect(stub.calls[1]?.body).toMatchObject({ disable_notification: true });
  });

  it('suppresses success notifications when NOTIFY_ON_SUCCESS is off', async () => {
    const stub = stubFetch();
    const client = createTelegramClient(CONFIG, { logger: silentLogger, fetch: stub.fetch });
    const notifier = telegramNotifier(client, CONFIG, false);

    await notifier.send({ kind: 'item_added', videoId: 'v', title: 't', playlistName: 'Later' });
    expect(stub.calls).toHaveLength(0);

    // But a failure still gets through — that setting is about noise, not about silence.
    await notifier.send({ kind: 'item_failed', reason: 'nope', sharedText: 'x' });
    expect(stub.calls).toHaveLength(1);
  });

  it('fans out to every allowlisted chat', async () => {
    const stub = stubFetch();
    const config = { ...CONFIG, allowedChatIds: ['1', '2', '3'] };
    const client = createTelegramClient(config, { logger: silentLogger, fetch: stub.fetch });
    await telegramNotifier(client, config, false).send({
      kind: 'item_failed',
      reason: 'x',
      sharedText: 'y',
    });
    expect(stub.calls.map((c) => (c.body as { chat_id: string }).chat_id)).toEqual(['1', '2', '3']);
  });
});

describe('parsing telegram updates', () => {
  const message = (extra: Record<string, unknown>) => ({
    update_id: 1,
    message: { message_id: 7, chat: { id: 4242 }, from: { id: 99 }, ...extra },
  });

  it('reads message text', () => {
    expect(parseTelegramUpdate(message({ text: 'youtu.be/abc' }))).toEqual({
      chatId: '4242',
      fromId: '99',
      text: 'youtu.be/abc',
      messageId: 7,
    });
  });

  it('reads a caption, which is how a forwarded Reel arrives', () => {
    expect(parseTelegramUpdate(message({ caption: 'watch youtu.be/abc' }))?.text).toBe(
      'watch youtu.be/abc',
    );
  });

  it('coerces a numeric chat id to a string, so allowlist comparison is consistent', () => {
    expect(parseTelegramUpdate(message({ text: 'x' }))?.chatId).toBe('4242');
  });

  it('ignores updates with nothing to ingest', () => {
    expect(parseTelegramUpdate(message({ sticker: {} }))).toBeNull();
    expect(parseTelegramUpdate(message({ text: '   ' }))).toBeNull();
    expect(parseTelegramUpdate({ update_id: 1 })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 1, callback_query: {} })).toBeNull();
  });

  it('does not throw on malformed input', () => {
    for (const bad of [null, undefined, 'string', 42, [], {}, { message: 'not an object' }]) {
      expect(() => parseTelegramUpdate(bad)).not.toThrow();
      expect(parseTelegramUpdate(bad)).toBeNull();
    }
  });
});

describe('chat allowlist', () => {
  it('permits a listed chat and refuses everything else', () => {
    expect(isAllowedChat(CONFIG, '4242')).toBe(true);
    expect(isAllowedChat(CONFIG, '9999')).toBe(false);
    expect(isAllowedChat({ ...CONFIG, allowedChatIds: [] }, '4242')).toBe(false);
  });
});

describe('webhook notifier', () => {
  it('posts a stable JSON shape with ntfy-compatible headers', async () => {
    const stub = stubFetch();
    await webhookNotifier(
      'https://ntfy.example/later',
      { logger: silentLogger, fetch: stub.fetch },
      false,
    ).send({
      kind: 'reauth_required',
      email: 'a@b.c',
      reauthUrl: 'https://x/auth',
      publishingStatus: 'testing',
    });

    expect(stub.calls[0]?.headers.title).toMatch(/stopped saving/i);
    expect(stub.calls[0]?.headers.priority).toBe('high');
    expect(stub.calls[0]?.body).toMatchObject({
      kind: 'reauth_required',
      urgent: true,
      actionLabel: 'Reconnect Google',
    });
  });

  it('swallows a failing endpoint rather than throwing at the pipeline', async () => {
    const failing = (() => Promise.reject(new Error('dns'))) as unknown as typeof fetch;
    await expect(
      webhookNotifier('https://x.example', { logger: silentLogger, fetch: failing }, false).send({
        kind: 'item_failed',
        reason: 'x',
        sharedText: 'y',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('fanout', () => {
  it('delivers to every channel', async () => {
    const a = recordingNotifier();
    const b = recordingNotifier();
    const notification: Notification = { kind: 'item_failed', reason: 'x', sharedText: 'y' };
    await fanout([a, b]).send(notification);
    expect(a.sent).toEqual([notification]);
    expect(b.sent).toEqual([notification]);
  });

  it('still delivers to the others when one channel throws', async () => {
    const broken = recordingNotifier({ failing: true });
    const working = recordingNotifier();
    // The message being suppressed might be the one saying Later has stopped working, so one
    // broken channel must never silence the rest.
    await expect(
      fanout([broken, working]).send({ kind: 'item_failed', reason: 'x', sharedText: 'y' }),
    ).resolves.toBeUndefined();
    expect(working.sent).toHaveLength(1);
  });
});
