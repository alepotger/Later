/**
 * The Telegram webhook, end to end.
 *
 * Two guards decide whether this endpoint is safe to expose, and both are tested here: the
 * secret token proves the caller is Telegram, and the chat allowlist proves which human is
 * talking. A bot's username is discoverable, so without the second one anyone who finds the bot
 * could write to the owner's playlist.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { listPlaylistEntries, listRecentItems } from '../../src/db/repo.ts';
import { createHarness, type Harness } from '../helpers/harness.ts';

const VIDEO = 'dQw4w9WgXcQ';
const SECRET = 'telegram-webhook-secret';
const CHAT = '4242';

let harness: Harness | undefined;

afterEach(() => {
  harness?.close();
  harness = undefined;
});

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

/** A harness with Telegram configured, capturing every outbound Bot API call. */
async function withTelegram(
  options: { allowedChatIds?: string[]; secret?: string | undefined } = {},
): Promise<{ h: Harness; sent: Sent[] }> {
  const sent: Sent[] = [];
  const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as unknown as typeof fetch;

  harness = await createHarness({
    config: {
      notify: {
        telegramBotToken: '123:ABC',
        telegramAllowedChatIds: options.allowedChatIds ?? [CHAT],
        telegramWebhookSecret: 'secret' in options ? options.secret : SECRET,
        webhookUrl: undefined,
        onSuccess: false,
      },
    },
    // The runtime builds the real Telegram notifier from config; only the network is stubbed.
    notifier: null,
    fetch: stubFetch,
  });

  return { h: harness, sent };
}

async function postUpdate(
  h: Harness,
  update: unknown,
  options: { secret?: string | null } = {},
): Promise<Response> {
  const secret = options.secret === undefined ? SECRET : options.secret;
  return await h.request('/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret }),
    },
    body: JSON.stringify(update),
  });
}

const message = (text: string, chatId: string = CHAT) => ({
  update_id: 1,
  message: { message_id: 7, chat: { id: Number(chatId) }, from: { id: 99 }, text },
});

describe('the webhook secret', () => {
  it('accepts a request carrying the right secret', async () => {
    const { h } = await withTelegram();
    const response = await postUpdate(h, message(`https://youtu.be/${VIDEO}`));
    expect(response.status).toBe(200);
    await h.drain();
    expect(await listRecentItems(h.db, h.account.id)).toHaveLength(1);
  });

  it('ignores a request with the wrong secret', async () => {
    const { h } = await withTelegram();
    await postUpdate(h, message(`https://youtu.be/${VIDEO}`), { secret: 'wrong' });
    await h.drain();
    expect(await listRecentItems(h.db, h.account.id)).toHaveLength(0);
  });

  it('ignores a request with no secret header at all', async () => {
    const { h } = await withTelegram();
    await postUpdate(h, message(`https://youtu.be/${VIDEO}`), { secret: null });
    await h.drain();
    expect(await listRecentItems(h.db, h.account.id)).toHaveLength(0);
  });

  it('still answers 200 to a rejected request, so Telegram does not retry forever', async () => {
    const { h } = await withTelegram();
    const response = await postUpdate(h, message('x'), { secret: 'wrong' });
    expect(response.status).toBe(200);
  });

  it('rejects everything when no secret is configured, rather than running open', async () => {
    const { h } = await withTelegram({ secret: undefined });
    await postUpdate(h, message(`https://youtu.be/${VIDEO}`), { secret: null });
    await h.drain();
    expect(await listRecentItems(h.db, h.account.id)).toHaveLength(0);
  });
});

describe('the chat allowlist', () => {
  it('ingests from an allowlisted chat', async () => {
    const { h } = await withTelegram();
    await postUpdate(h, message(`check this youtu.be/${VIDEO}`));
    await h.drain();

    const items = await listRecentItems(h.db, h.account.id);
    expect(items[0]?.status).toBe('added');
    expect(items[0]?.source).toBe('telegram');
    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(1);
  });

  it('ignores a chat that is not allowlisted, and says nothing back', async () => {
    const { h, sent } = await withTelegram();
    await postUpdate(h, message(`https://youtu.be/${VIDEO}`, '9999'));
    await h.drain();

    expect(await listRecentItems(h.db, h.account.id)).toHaveLength(0);
    // Silence is deliberate: a stranger probing the bot should learn nothing about it.
    expect(sent).toHaveLength(0);
  });

  it('ignores every chat when the allowlist is empty', async () => {
    const { h } = await withTelegram({ allowedChatIds: [] });
    await postUpdate(h, message(`https://youtu.be/${VIDEO}`));
    await h.drain();
    expect(await listRecentItems(h.db, h.account.id)).toHaveLength(0);
  });
});

describe('replies', () => {
  it('confirms a save in the same chat', async () => {
    const { h, sent } = await withTelegram();
    await postUpdate(h, message(`https://youtu.be/${VIDEO}`));
    await h.drain();

    const reply = sent.find((s) => s.url.includes('sendMessage'));
    expect(reply?.body).toMatchObject({ chat_id: CHAT });
    expect(String(reply?.body.text)).toMatch(/Saved to Later/);
  });

  it('says so when the video was already saved', async () => {
    const { h, sent } = await withTelegram();
    await postUpdate(h, message(`https://youtu.be/${VIDEO}`));
    await h.drain();
    sent.length = 0;

    // Same video, different text — so idempotency does not short-circuit it and the pipeline
    // reaches the duplicate check.
    await postUpdate(h, {
      ...message(`different caption youtube.com/watch?v=${VIDEO}`),
      update_id: 2,
    });
    await h.drain();

    const reply = sent.find((s) => s.url.includes('sendMessage'));
    expect(String(reply?.body.text)).toMatch(/[Aa]lready in your playlist/);
  });

  it('explains honestly when there is no YouTube link', async () => {
    const { h, sent } = await withTelegram();
    await postUpdate(h, message('that Veritasium one about planes'));
    await h.drain();

    const reply = sent.find((s) => s.url.includes('sendMessage'));
    expect(String(reply?.body.text)).toMatch(/could not find|LLM/i);
  });

  it('answers /start with what the bot does', async () => {
    const { h, sent } = await withTelegram();
    await postUpdate(h, message('/start'));

    const reply = sent.find((s) => s.url.includes('sendMessage'));
    expect(String(reply?.body.text)).toMatch(/forward me anything/i);
    expect(String(reply?.body.text)).toContain('Later playlist');
  });

  it('answers /id with the chat id, which is how setup finds it', async () => {
    const { h, sent } = await withTelegram();
    await postUpdate(h, message('/id'));

    const reply = sent.find((s) => s.url.includes('sendMessage'));
    expect(String(reply?.body.text)).toContain(CHAT);
  });

  it('does not create an item for a command', async () => {
    const { h } = await withTelegram();
    await postUpdate(h, message('/help'));
    await h.drain();
    expect(await listRecentItems(h.db, h.account.id)).toHaveLength(0);
  });
});

describe('malformed and irrelevant updates', () => {
  it('ignores updates with nothing to ingest', async () => {
    const { h } = await withTelegram();
    for (const update of [
      { update_id: 1 },
      { update_id: 2, message: { chat: { id: Number(CHAT) }, sticker: {} } },
      { update_id: 3, callback_query: { id: 'x' } },
    ]) {
      expect((await postUpdate(h, update)).status).toBe(200);
    }
    await h.drain();
    expect(await listRecentItems(h.db, h.account.id)).toHaveLength(0);
  });

  it('answers 200 to a body that is not JSON', async () => {
    const { h } = await withTelegram();
    const response = await h.request('/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': SECRET,
      },
      body: 'not json at all',
    });
    expect(response.status).toBe(200);
  });

  it('reads a caption, which is how a forwarded Reel arrives', async () => {
    const { h } = await withTelegram();
    await postUpdate(h, {
      update_id: 1,
      message: {
        message_id: 7,
        chat: { id: Number(CHAT) },
        from: { id: 99 },
        video: {},
        caption: `full video: youtu.be/${VIDEO}`,
      },
    });
    await h.drain();
    expect(await listPlaylistEntries(h.db, h.account.id)).toHaveLength(1);
  });
});

describe('when Telegram is not configured', () => {
  it('does not advertise the endpoint', async () => {
    harness = await createHarness();
    const response = await harness.request('/telegram/webhook', {
      method: 'POST',
      body: JSON.stringify(message('x')),
    });
    expect(response.status).toBe(404);
  });
});
