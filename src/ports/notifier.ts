/**
 * Notifications.
 *
 * The ingest endpoint answers in milliseconds and the work happens afterwards, so a
 * notification is how the user learns what happened. One of these messages is structural
 * rather than nice-to-have: `reauth_required` is the difference between a fifteen-second fix
 * and a silent week-long outage.
 *
 * Delivery is best effort and must never block or fail the pipeline — the database remains
 * the source of truth, and a notification outage must not become a playlist outage.
 */

export type Notification =
  | { kind: 'item_added'; videoId: string; title: string; playlistName: string }
  | { kind: 'item_held'; itemId: string; guess: string; confidence: number; reviewUrl: string }
  | { kind: 'item_failed'; reason: string; sharedText: string }
  /** High urgency. Later has stopped working and only the user can fix it. */
  | { kind: 'reauth_required'; email: string; reauthUrl: string; publishingStatus: string }
  | { kind: 'quota_exhausted'; retryAt: Date; queued: number };

export interface Notifier {
  send(notification: Notification): Promise<void>;
}

/** Discards everything. The default when no channel is configured. */
export const nullNotifier: Notifier = {
  async send() {},
};

/** Records notifications for assertions, and lets tests simulate a failing channel. */
export function recordingNotifier(options: { failing?: boolean } = {}): Notifier & {
  sent: Notification[];
} {
  const sent: Notification[] = [];
  return {
    sent,
    async send(notification) {
      if (options.failing) throw new Error('injected notification channel failure');
      sent.push(notification);
    },
  };
}

/**
 * Wrap a notifier so a delivery failure is logged and swallowed.
 *
 * Applied at the composition root, so no caller has to remember to try/catch around
 * something as peripheral as a notification.
 */
export function nonBlocking(
  inner: Notifier,
  onError: (error: unknown, notification: Notification) => void,
): Notifier {
  return {
    async send(notification) {
      try {
        await inner.send(notification);
      } catch (error) {
        onError(error, notification);
      }
    },
  };
}
