# ADR-0010 — Telegram as the primary notification channel

**Status:** accepted · **Date:** 2026-08-05

## Context

The 202-immediately design ([ADR-0007](0007-async-work-cron-driven-jobs.md)) means the user is gone before the outcome is known. That makes a notification channel structural, not a nicety — without one, "did it work?" is only answerable by opening a web page, and the entire premise is that they never do.

Three things must reach the user:

| Event | Urgency |
|---|---|
| Added *(optional, off by default — success should be silent)* | low |
| Held for review — needs one tap | medium |
| `reauth_required` — Later is dead until you act | **high** ([ADR-0005](0005-token-lifecycle-and-reauth.md)) |

The third is the one that must not fail. It is the difference between a week-long silent outage and a fifteen-second fix.

## Decision

**Telegram is the primary channel, and it is also an ingress adapter. Web UI is the always-present fallback. A generic webhook covers everyone else.**

| Channel | Setup cost | Notes |
|---|---|---|
| **Telegram** | one BotFather chat, ~3 min | push to every device, free, no store, **also an ingress** |
| Web UI banner | none | always on, cannot be missed if they visit, easily missed if they don't |
| Generic webhook | a URL | ntfy, Discord, Slack, Home Assistant, anything |

The reason Telegram wins is that **it is the only option that costs nothing and solves two problems with one setup step.** The brief calls it "wildly underrated" and that's right: a user forwards a Reel to the bot from any app on any OS with no install, and the same bot delivers "held for review — tap to confirm" back into the same thread. Ingress and egress in one conversation, one console step, zero infrastructure.

That symmetry is worth spelling out, because it's the actual argument: without Telegram, a deployer needs an ingress adapter *and* a notification channel — two setup paths. With it, they need one, and it works on every platform including desktop.

**Success notifications default to off.** A tool whose job is to remove friction shouldn't add a notification per share. The default is silence on success, a notification when something needs the user, and a loud one when Later is broken.

Delivery is best-effort and never blocks the pipeline: a failed notification is logged, and the item's state in the database remains the source of truth. A notification outage must not become a playlist outage.

**Interactive confirmation** uses inline keyboard buttons — "Add" / "Skip" — on review items, with the callback handled by the same webhook. That is what makes the review inbox one tap from the notification rather than a trip to a web page.

## Rejected

**Email.** Universal, and needs an SMTP provider or an API key (another signup, another set of secrets), lands in spam, and is a terrible fit for "tap to confirm". Rejected on setup cost and interaction model.

**Web Push (VAPID).** Genuinely appealing — no third party, works with the PWA we're already building, browser-native. Rejected as *primary* because subscription management, key generation, and per-browser quirks are real work, iOS support requires the PWA be installed to the home screen first, and it delivers nothing on desktop unless the browser is running. Reasonable later addition for Android PWA users; not the thing to depend on for the `reauth_required` message.

**SMS / WhatsApp.** Both cost money and need business API approval.

**Discord webhook as primary.** Zero-cost and easy, and delivery is unreliable when the user isn't in the app, with no clean way to accept a button press back. Supported via the generic webhook.

**Native push via an app.** §12 rules out an app store app for v1.

## Consequences

- The `Notifier` port has multiple implementations, including a fixture that records calls for assertions — so notification behaviour is tested without sending anything anywhere.
- Telegram is in **Batch 2** of the console work. Until then, notifications land in the web UI and the logs only, which is exactly why the web banner is not optional.
- **The bot must be locked down.** A bot's username is discoverable, so `TELEGRAM_ALLOWED_CHAT_IDS` is mandatory when the bot is enabled — without it, a stranger who finds the bot can write to the playlist. Startup refuses to enable the bot without it. See [ADR-0008](0008-ingest-authentication.md).
- Telegram is a third party seeing the links a user shares. This is disclosed in SETUP.md, and the whole channel is optional — the web UI path involves no third party at all.
- No telemetry anywhere in this, per §7. Notifications go to the user's own bot, configured with the user's own token. Nothing reports to the author.

## Revisit if

- **Web Push proves solid enough** on both iOS-installed-PWA and Android to carry `reauth_required` reliably. Then it becomes the recommended zero-third-party default, with Telegram staying for ingress.
- **Telegram becomes unavailable** in a deployer's country, which happens. The generic webhook is the documented escape hatch.
- **Notification volume annoys anyone.** The next step is batching into a digest, never silence for the high-urgency class.
