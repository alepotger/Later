# Telegram — forward anything to a bot

**The most underrated path, and the one worth setting up first.** It works from any app on any OS — iOS, Android, desktop, web — with nothing installed, and the same bot delivers Later's notifications back to you.

That last part is the real argument: every other route needs an ingress *and* a separate notification channel. This is one setup for both. See [ADR-0010](../../docs/adr/0010-notifications-telegram-primary.md).

## Setup (~5 minutes)

### 1. Create the bot

Message **[@BotFather](https://t.me/BotFather)** in Telegram:

- Send `/newbot`
- Choose a display name (anything — `My Later`)
- Choose a username ending in `bot` (must be globally unique — `alex_later_9f2bot`)

BotFather replies with a token like `8123456789:AAF-abcdefgh...`. That goes in `TELEGRAM_BOT_TOKEN`.

> **You'll know this worked when** BotFather says "Done! Congratulations on your new bot" and gives you a token.

### 2. Generate a webhook secret

```bash
openssl rand -hex 32
```

Put it in `TELEGRAM_WEBHOOK_SECRET`. This is how Later knows an incoming update genuinely came from Telegram.

### 3. Find your chat ID

Start a chat with your new bot and send `/id`. It replies with the number.

Put it in `TELEGRAM_ALLOWED_CHAT_IDS`.

**This is mandatory, and it is not a formality.** Your bot's username is discoverable by anyone — that's how Telegram works. Without an allowlist, a stranger who finds it could add videos to your playlist. Later refuses to start with a bot token set and this list empty.

> Chicken-and-egg: `/id` needs the webhook registered, which needs the bot configured. If you'd rather not restart twice, message [@userinfobot](https://t.me/userinfobot) instead — it replies with your ID and needs no setup.

### 4. Register the webhook

Telegram pushes updates to you, so it needs a **public HTTPS URL** — a `localhost` instance cannot receive them.

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://YOUR-LATER-URL/telegram/webhook",
    "secret_token": "YOUR_WEBHOOK_SECRET",
    "allowed_updates": ["message", "callback_query"],
    "drop_pending_updates": true
  }'
```

> **You'll know this worked when** the response is `{"ok":true,"result":true,"description":"Webhook was set"}`.

Check it any time:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

`last_error_message` in that response is the single most useful debugging field here — it tells you exactly what Telegram saw when it tried to reach you.

### 5. Use it

Forward anything with a YouTube link in it. From TikTok or Instagram: Share → Telegram → your bot.

Commands:

| | |
|---|---|
| `/start`, `/help` | What the bot does |
| `/id` | This chat's numeric ID (for the allowlist) |
| anything else | Treated as a share |

## What it reads

Message text and photo/video **captions** — so forwarding a Reel works, because the caption comes with it. Later then runs the same pipeline as every other ingress: a YouTube link in the text costs no quota at all.

If the forwarded caption has no YouTube link, you'll get an honest answer saying so. With an LLM configured (Phase 3) Later will instead try to work out which video it means.

## Privacy

Telegram sees the links you forward, because it's a Telegram bot. If that's not acceptable, the [generic webhook](../../.env.example) sends notifications anywhere, and the web paste box involves no third party at all. The channel is entirely optional.

## Troubleshooting

| What you see | Cause |
|---|---|
| Bot never replies | Webhook not registered, or unreachable. Check `getWebhookInfo` → `last_error_message`. |
| Bot ignores you completely | Your chat ID isn't in `TELEGRAM_ALLOWED_CHAT_IDS`. Silence is deliberate — a stranger probing the bot learns nothing. Send `/id` and add the number. |
| Later won't start | Bot token set with an empty allowlist. That's the guard working. |
| Replies once then stops | `TELEGRAM_WEBHOOK_SECRET` doesn't match what you passed to `setWebhook`. Re-register. |
| Same message handled repeatedly | Later always returns 200, so this shouldn't happen. If it does, it's a bug worth reporting. |
