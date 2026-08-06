/**
 * Telegram ingress.
 *
 * Forward a Reel or a TikTok to the bot from any app on any OS, with nothing installed, and it
 * lands in the playlist. This is the lowest-friction path Later has and the one worth
 * recommending — see docs/adr/0010-notifications-telegram-primary.md.
 *
 * Two independent checks guard it, and both matter:
 *
 *  1. The webhook secret proves the request really came from Telegram.
 *  2. The chat allowlist proves *which human* is talking. A bot's username is discoverable, so
 *     without this anyone who stumbles on the bot could write to the owner's playlist.
 */

import type { Hono } from 'hono';
import { isAllowedChat, parseTelegramUpdate } from '../../adapters/notify/telegram.ts';
import { timingSafeEqual } from '../../core/bytes.ts';
import { getSoloAccount, listItemsByShareKey } from '../../db/repo.ts';
import { processOne } from '../../pipeline/worker.ts';
import { ingest, summariseItems } from '../../services/ingest.ts';
import type { AppBindings } from '../middleware.ts';

export function registerTelegramRoutes(app: Hono<AppBindings>): void {
  app.post('/telegram/webhook', async (c) => {
    const runtime = c.get('runtime');
    const logger = c.get('logger');
    const { telegram, telegramConfig } = runtime;

    if (!telegram || !telegramConfig) {
      // Not configured. 404 rather than 503 so an unconfigured deployment does not advertise
      // that the endpoint exists at all.
      return c.notFound();
    }

    // Telegram sends the secret in this header on every update.
    const presented = c.req.header('x-telegram-bot-api-secret-token') ?? '';
    const expected = telegramConfig.webhookSecret ?? '';
    if (expected === '' || !timingSafeEqual(presented, expected)) {
      logger.warn('telegram webhook rejected: bad secret token');
      // 200 anyway. A non-2xx makes Telegram retry the same update indefinitely, and there is
      // nothing to retry — the caller is not Telegram.
      return c.json({ ok: true });
    }

    const update = await c.req.json().catch(() => null);
    const message = parseTelegramUpdate(update);
    if (!message) {
      // Stickers, joins, edits, callback queries — nothing to ingest. Acknowledge and move on.
      return c.json({ ok: true });
    }

    if (!isAllowedChat(telegramConfig, message.chatId)) {
      // Silent by design: no reply, so a stranger probing the bot learns nothing about
      // whether it exists or who owns it.
      logger.warn('telegram message from a chat that is not allowlisted', {
        chatId: message.chatId,
      });
      return c.json({ ok: true });
    }

    // A couple of conversational commands, so the bot is not a black hole.
    const command = message.text.trim().toLowerCase();
    if (command === '/start' || command === '/help') {
      await telegram.sendMessage(
        message.chatId,
        'Send or forward me anything with a YouTube link in it and I will save the video to ' +
          `your ${runtime.config.playlist.name} playlist.\n\n` +
          'Forwarding a Reel or a TikTok works — I read the caption for a link.\n\n' +
          `Status and recent saves: ${runtime.config.publicBaseUrl}`,
      );
      return c.json({ ok: true });
    }
    if (command === '/id') {
      // Genuinely useful during setup: this is how a deployer finds the number to allowlist.
      await telegram.sendMessage(message.chatId, `This chat's ID is ${message.chatId}`);
      return c.json({ ok: true });
    }

    const account = await getSoloAccount(runtime.db);
    if (!account) {
      await telegram.sendMessage(
        message.chatId,
        'No Google account is connected yet. Open ' +
          `${runtime.config.publicBaseUrl}/auth/start to connect one.`,
      );
      return c.json({ ok: true });
    }

    const result = await ingest(
      {
        db: runtime.db,
        clock: runtime.clock,
        logger,
        hasLlm: runtime.config.llm.provider !== 'none',
      },
      {
        accountId: account.id,
        text: message.text,
        source: 'telegram',
        requestId: c.get('requestId'),
      },
    );

    // Telegram expects a prompt 200 or it retries the update, so the work happens after the
    // response — and the reply is sent from inside that scheduled task once outcomes are known.
    runtime.schedule(async () => {
      const worker = await runtime.worker();
      for (let i = 0; i < result.items.length + 1; i += 1) {
        if (!(await processOne(worker))) break;
      }

      const settled = await listItemsByShareKey(runtime.db, result.shareKey);
      const summary = summariseItems(settled);
      const reply = describeOutcome(summary, result.rejection, runtime.config.playlist.name);
      await telegram.sendMessage(message.chatId, reply);
    });

    return c.json({ ok: true });
  });
}

function describeOutcome(
  summary: { added: number; duplicate: number; pending: number; failed: number },
  rejection: string | null,
  playlistName: string,
): string {
  if (summary.added > 0) {
    return summary.added === 1
      ? `Saved to ${playlistName}.`
      : `Saved ${summary.added} videos to ${playlistName}.`;
  }
  if (summary.duplicate > 0) return 'Already in your playlist — nothing to do.';
  if (summary.pending > 0) return 'Got it. Still working on that one; I will follow up.';
  return rejection ?? 'I could not find a YouTube video in that.';
}
