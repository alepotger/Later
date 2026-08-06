/**
 * Telegram, as both notification channel and ingress adapter.
 *
 * The reason it is the recommended path: one BotFather chat gets you push notifications on
 * every device *and* a way to forward a Reel from any app on any OS with nothing installed.
 * Everything else needs two setups. See docs/adr/0010-notifications-telegram-primary.md.
 *
 * Only the Bot API over `fetch` — no SDK, so this runs unchanged on Workers.
 */

import type { Logger } from '../../ports/logger.ts';
import type { Notification, Notifier } from '../../ports/notifier.ts';
import { renderNotification } from './messages.ts';

const API_BASE = 'https://api.telegram.org';

export interface TelegramConfig {
  botToken: string;
  /** Numeric chat IDs allowed to talk to the bot, and the ones notifications go to. */
  allowedChatIds: string[];
  webhookSecret?: string | undefined;
}

export interface TelegramClient {
  sendMessage(chatId: string, text: string, options?: SendOptions): Promise<boolean>;
  setWebhook(url: string, secret: string): Promise<boolean>;
  deleteWebhook(): Promise<boolean>;
  getMe(): Promise<{ username: string } | null>;
}

export interface SendOptions {
  /** Rendered as an inline keyboard button. */
  action?: { label: string; url: string };
  /** Suppress the notification sound for low-priority messages. */
  silent?: boolean;
}

export function createTelegramClient(
  config: TelegramConfig,
  deps: { logger: Logger; fetch?: typeof fetch },
): TelegramClient {
  const fetchImpl = deps.fetch ?? fetch;

  async function call(method: string, body: unknown): Promise<unknown | null> {
    try {
      const response = await fetchImpl(`${API_BASE}/bot${config.botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        result?: unknown;
        description?: string;
      } | null;

      if (!response.ok || payload?.ok !== true) {
        // Logged, never thrown: a notification failure must not become a playlist failure.
        deps.logger.warn('telegram api call failed', {
          method,
          status: response.status,
          description: payload?.description ?? null,
        });
        return null;
      }
      return payload.result ?? true;
    } catch (error) {
      deps.logger.warn('telegram api call threw', {
        method,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return {
    async sendMessage(chatId, text, options = {}) {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text,
        // No parse_mode. Video titles and captions contain underscores, asterisks, and
        // brackets, and Telegram rejects the whole message if the markup does not balance —
        // so a title with a stray `*` would silently drop the notification. Plain text always
        // delivers, which matters more than bold.
        link_preview_options: { is_disabled: true },
        disable_notification: options.silent === true,
      };

      if (options.action) {
        body.reply_markup = {
          inline_keyboard: [[{ text: options.action.label, url: options.action.url }]],
        };
      }

      return (await call('sendMessage', body)) !== null;
    },

    async setWebhook(url, secret) {
      return (
        (await call('setWebhook', {
          url,
          secret_token: secret,
          // Only what Later acts on. `callback_query` is here for the Phase 3 review inbox.
          allowed_updates: ['message', 'callback_query'],
          drop_pending_updates: true,
        })) !== null
      );
    },

    async deleteWebhook() {
      return (await call('deleteWebhook', { drop_pending_updates: true })) !== null;
    },

    async getMe() {
      const result = await call('getMe', {});
      if (result === null || typeof result !== 'object') return null;
      const username = (result as { username?: unknown }).username;
      return typeof username === 'string' ? { username } : null;
    },
  };
}

/** Fan a notification out to every allowlisted chat. */
export function telegramNotifier(
  client: TelegramClient,
  config: TelegramConfig,
  notifyOnSuccess: boolean,
): Notifier {
  return {
    async send(notification: Notification): Promise<void> {
      if (notification.kind === 'item_added' && !notifyOnSuccess) return;

      const rendered = renderNotification(notification);
      const text = `${rendered.title}\n\n${rendered.body}`;

      for (const chatId of config.allowedChatIds) {
        await client.sendMessage(chatId, text, {
          ...(rendered.action ? { action: rendered.action } : {}),
          silent: !rendered.urgent,
        });
      }
    },
  };
}

// ─── Inbound updates ─────────────────────────────────────────────────────────

export interface TelegramMessage {
  chatId: string;
  fromId: string | null;
  text: string;
  messageId: number;
}

/**
 * Pull the shareable text out of an update.
 *
 * Forwarded messages are the main case: a Reel forwarded from Instagram arrives as a message
 * whose text is the caption plus URL, which is exactly what the pipeline wants. Returns null
 * for updates with nothing to ingest (stickers, joins, edits).
 */
export function parseTelegramUpdate(update: unknown): TelegramMessage | null {
  if (typeof update !== 'object' || update === null) return null;
  const message = (update as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;

  const m = message as {
    message_id?: unknown;
    chat?: { id?: unknown };
    from?: { id?: unknown };
    text?: unknown;
    caption?: unknown;
  };

  const chatId = m.chat?.id;
  if (typeof chatId !== 'number' && typeof chatId !== 'string') return null;

  // `caption` covers a forwarded photo or video with the link in its caption.
  const raw = typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : '';
  if (raw.trim() === '') return null;

  return {
    chatId: String(chatId),
    fromId:
      typeof m.from?.id === 'number' || typeof m.from?.id === 'string' ? String(m.from.id) : null,
    text: raw,
    messageId: typeof m.message_id === 'number' ? m.message_id : 0,
  };
}

/**
 * Whether this chat may talk to the bot.
 *
 * A bot's username is discoverable, so without an allowlist anyone who finds it could write to
 * the owner's playlist. Config refuses to start with the bot enabled and this list empty.
 */
export function isAllowedChat(config: TelegramConfig, chatId: string): boolean {
  return config.allowedChatIds.includes(chatId);
}
