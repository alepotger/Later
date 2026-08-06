/**
 * Generic webhook notifier.
 *
 * The escape hatch for anyone who doesn't want Telegram, or can't reach it — ntfy, Discord,
 * Slack, Home Assistant, a personal endpoint. One POST with a stable JSON shape.
 */

import type { Logger } from '../../ports/logger.ts';
import type { Notification, Notifier } from '../../ports/notifier.ts';
import { renderNotification, toPlainText } from './messages.ts';

export function webhookNotifier(
  url: string,
  deps: { logger: Logger; fetch?: typeof fetch },
  notifyOnSuccess: boolean,
): Notifier {
  const fetchImpl = deps.fetch ?? fetch;

  return {
    async send(notification: Notification): Promise<void> {
      if (notification.kind === 'item_added' && !notifyOnSuccess) return;

      const rendered = renderNotification(notification);

      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // ntfy reads these; other receivers ignore them harmlessly.
            title: rendered.title,
            priority: rendered.urgent ? 'high' : 'default',
          },
          body: JSON.stringify({
            kind: notification.kind,
            title: rendered.title,
            message: rendered.body,
            text: toPlainText(rendered),
            urgent: rendered.urgent,
            ...(rendered.action
              ? { actionLabel: rendered.action.label, actionUrl: rendered.action.url }
              : {}),
          }),
        });

        if (!response.ok) {
          deps.logger.warn('notify webhook returned an error status', { status: response.status });
        }
      } catch (error) {
        deps.logger.warn('notify webhook threw', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

/**
 * Send to every configured channel.
 *
 * Each is attempted independently: one broken channel must not stop the others, because the
 * message being suppressed might be the one telling the user Later has stopped working.
 */
export function fanout(notifiers: Notifier[]): Notifier {
  return {
    async send(notification: Notification): Promise<void> {
      await Promise.allSettled(notifiers.map((notifier) => notifier.send(notification)));
    },
  };
}
