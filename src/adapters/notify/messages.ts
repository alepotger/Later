/**
 * Notification text.
 *
 * Pure functions, so the exact wording of every message is testable — which matters most for
 * `reauth_required`, the one message that has to make a person act. If that text is vague,
 * the deployment stays broken.
 *
 * Kept channel-agnostic: each adapter decides how to render a `RenderedNotification`.
 */

import type { Notification } from '../../ports/notifier.ts';

export interface RenderedNotification {
  /** Short, scannable. Used as the bold first line, or as a push title. */
  title: string;
  body: string;
  /** Primary action, when there is one. */
  action?: { label: string; url: string };
  /** High-urgency messages should bypass "quiet" delivery where a channel supports it. */
  urgent: boolean;
}

export function renderNotification(notification: Notification): RenderedNotification {
  switch (notification.kind) {
    case 'item_added':
      return {
        title: 'Saved',
        body: `${notification.title || notification.videoId} → ${notification.playlistName}`,
        urgent: false,
      };

    case 'item_held':
      return {
        title: 'Needs a quick check',
        body:
          `Later thinks this is "${notification.guess}" but is only ` +
          `${Math.round(notification.confidence * 100)}% sure, so it has not been added. ` +
          'Confirm or skip it and Later will remember.',
        action: { label: 'Review it', url: notification.reviewUrl },
        urgent: false,
      };

    case 'item_failed':
      return {
        title: 'Could not save that one',
        body: `${notification.reason}\n\nYou shared: ${truncate(notification.sharedText, 140)}`,
        urgent: false,
      };

    case 'reauth_required':
      // The most important string in the project. It has to say what broke, that nothing was
      // lost, what to do, and — when relevant — why it will keep happening.
      return {
        title: 'Later has stopped saving videos',
        body:
          `Google authorisation for ${notification.email} has expired or been revoked, so ` +
          'nothing new is being added.\n\n' +
          'Everything you shared since then is queued and will be saved as soon as you ' +
          'reconnect — nothing has been lost.' +
          (notification.publishingStatus === 'testing'
            ? '\n\nThis will happen again every 7 days until you publish your Google OAuth app ' +
              'to Production. It is one click and free: open Google Auth Platform, press ' +
              '"Publish app", then set GOOGLE_OAUTH_PUBLISHING_STATUS=production.'
            : ''),
        action: { label: 'Reconnect Google', url: notification.reauthUrl },
        urgent: true,
      };

    case 'quota_exhausted':
      return {
        title: 'Daily YouTube quota used up',
        body:
          `${notification.queued} ${notification.queued === 1 ? 'video is' : 'videos are'} ` +
          'queued and will be saved automatically after the quota resets at ' +
          `${formatWhen(notification.retryAt)}. Nothing has been lost — you can keep sharing.`,
        urgent: false,
      };
  }
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/** UTC, spelled out, because a bare ISO string in a phone notification is unreadable. */
function formatWhen(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Plain text, for a generic webhook or a log line. */
export function toPlainText(rendered: RenderedNotification): string {
  const parts = [rendered.title, '', rendered.body];
  if (rendered.action) parts.push('', `${rendered.action.label}: ${rendered.action.url}`);
  return parts.join('\n');
}
