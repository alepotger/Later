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
 *
 * MULTI adds a third answer to "which human": a chat linked to an account with `/link`, using a
 * short-lived code from the web UI. In MULTI a linked chat is itself proof of ownership, so
 * `TELEGRAM_ALLOWED_CHAT_IDS` becomes optional — asking the deployer to edit `.env` and redeploy
 * for every household member would defeat the mode.
 */

import type { Hono } from 'hono';
import { isAllowedChat, parseTelegramUpdate } from '../../adapters/notify/telegram.ts';
import { timingSafeEqual } from '../../core/bytes.ts';
import { getAccountById, listItemsByShareKey, setAccountTelegramChatId } from '../../db/repo.ts';
import { processOne } from '../../pipeline/worker.ts';
import type { Runtime } from '../../runtime.ts';
import { ingest, summariseItems } from '../../services/ingest.ts';
import { resolveTelegramAccount } from '../accounts.ts';
import type { AppBindings } from '../middleware.ts';
import { verifyValue } from '../session.ts';

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

    const multi = runtime.config.mode === 'MULTI';
    const account = await resolveTelegramAccount(runtime, message.chatId);

    // SOLO: the env allowlist is the only gate, and config refuses to start without one.
    //
    // MULTI: an empty allowlist means "anyone may talk", because `/link` with a signed code is
    // the real gate and an unlinked chat can do nothing else. A deployer who *does* set an
    // allowlist in MULTI has opted into a narrower door, so it is still enforced.
    const permitted = multi
      ? telegramConfig.allowedChatIds.length === 0 || isAllowedChat(telegramConfig, message.chatId)
      : isAllowedChat(telegramConfig, message.chatId);

    if (!permitted) {
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
          (multi && !account
            ? `First, connect this chat to your account: open ${runtime.config.publicBaseUrl} ` +
              'and send me the /link command it shows you.'
            : `Status and recent saves: ${runtime.config.publicBaseUrl}`),
      );
      return c.json({ ok: true });
    }
    if (command === '/id') {
      // Genuinely useful during setup: this is how a deployer finds the number to allowlist.
      await telegram.sendMessage(message.chatId, `This chat's ID is ${message.chatId}`);
      return c.json({ ok: true });
    }

    if (multi && message.text.trim().toLowerCase().startsWith('/link')) {
      const reply = await linkChat(runtime, message.chatId, message.text.trim().slice(5).trim());
      await telegram.sendMessage(message.chatId, reply);
      return c.json({ ok: true });
    }

    if (!account) {
      await telegram.sendMessage(
        message.chatId,
        multi
          ? `This chat is not connected to an account yet. Open ${runtime.config.publicBaseUrl} ` +
              'and send me the /link command shown there.'
          : 'No Google account is connected yet. Open ' +
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

/**
 * Bind this chat to the account named in a signed link code. MULTI only.
 *
 * The code is an HMAC over the account ID with a 15-minute expiry, so nothing needs storing and
 * a code that leaks after the fact is inert. Re-linking overwrites, which is also the fix for
 * "I linked the wrong chat".
 */
async function linkChat(runtime: Runtime, chatId: string, code: string): Promise<string> {
  const now = runtime.clock.now().getTime();
  const accountId = await verifyValue(
    runtime.config.secrets.sessionSecret,
    'telegram-link',
    code,
    now,
  );
  if (!accountId) {
    return 'That link code is not valid or has expired. Open Later in a browser and copy a fresh one — they last 15 minutes.';
  }

  const account = await getAccountById(runtime.db, accountId);
  if (!account) return 'That link code refers to an account that no longer exists.';

  await setAccountTelegramChatId(runtime.db, account.id, chatId, now);
  return `Linked to ${account.email}. Forward me anything with a YouTube link in it.`;
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
