# Troubleshooting

Ordered by how likely you are to hit it. The first entry accounts for most reports.

> The failure modes below are verified properties of Google's APIs ([verification log](docs/verification-log.md)). The handling described for each is implemented and covered by tests, with one exception noted where it appears: the live Google OAuth round-trip has not yet been run against real credentials.

---

## "It worked for a week, then just stopped"

**This is the single most common way a Later deployment dies.** If it stopped working roughly 7 days after you set it up, this is almost certainly it, and it is not a bug in Later.

**Cause.** Your OAuth consent screen is in **Testing** publishing status with **External** user type. Because the YouTube scope is classified *sensitive*, Google revokes refresh tokens after exactly 7 days in that configuration. Your token was deleted by Google.

**Confirm it.** Look for `invalid_grant` in your logs, or an account showing `reauth_required` in the web UI. If you configured a notification channel, you were told the day it happened.

**Fix, permanently:**

1. Go to **https://console.cloud.google.com/auth/overview**
2. Check **"Publishing status"**. If it says **"Testing"**, click **"Publish app"** → **"Confirm"**
3. Confirm it now reads **"In production"**
4. Set `GOOGLE_OAUTH_PUBLISHING_STATUS=production` in your config and restart
5. Re-authorise once, via the link in your notification or the banner in the web UI

Nothing shared during the outage is lost. Items are parked, not failed, and drain once you re-authorise.

**"Isn't Production dangerous for an unverified app?"** No. You'll click past an "unverified app" warning once — it means Google hasn't reviewed your app, which is true, and you are the developer. Verification is only needed to remove that warning or exceed 100 users, and it can take weeks. For personal use, unverified Production is the right configuration. See [ADR-0005](docs/adr/0005-token-lifecycle-and-reauth.md).

---

## "My videos aren't in Watch Later"

**They never will be, and that's not fixable.** Google removed API access to the Watch Later playlist on 12 September 2016. `playlistItems.insert` against `WL` fails, and no OAuth scope changes that.

Later writes to a real playlist named `Later` (or whatever `LATER_PLAYLIST_NAME` says) that it created in your account. Look for it under your playlists in the YouTube app — you can pin it to your sidebar or Library.

Later will not work around this with headless browsers or cookie replay: it violates YouTube's Terms of Service, it breaks without warning, and it would make this repo unsafe for anyone to deploy. Full reasoning in [ADR-0004](docs/adr/0004-watch-later-is-unreachable.md).

---

## Running out of quota

### "Nothing has been added since some time this afternoon"

**Cause.** You've hit the daily API quota. Default is 10,000 units/day, and it resets at **midnight Pacific Time** — not midnight where you are.

**Confirm it.** The web UI shows units spent today against your budget. Logs will show quota refusals or `quotaExceeded`.

**Nothing is lost.** Items are queued with a retry scheduled for the next reset. That's a requirement, not best-effort.

**Why you ran out:**

| Cause | What to do |
|---|---|
| Genuinely heavy use | ~190 linked shares/day is the ceiling. Request a quota increase. |
| Lots of shares needing search | Each costs 151 units vs 51. A caption with no link is 3× the price. |
| MULTI mode | Everyone shares one 10,000-unit pool. Consider separate deployments. |
| Something else uses this project | Later's default budget of 9,000 leaves headroom, but a second app can still exhaust the real 10,000. |
| Tier 0 failing on a URL form | Should be free, became a search. **Please open an issue with the URL** — that's a bug worth fixing and it's cheap to fix. |

### Raising the quota

The 10,000-unit default belongs to your Google Cloud *project*, not to you or to Later, and it is the same number for everyone. To increase it you have to ask Google.

1. Open **https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas** with your `later` project selected
2. Confirm the current limit reads **10,000** "Queries per day" — that is the number Later's default budget of 9,000 sits under
3. Click the **"YouTube API Services - Audit and Quota Extension Form"** link, or search that exact phrase
4. Fill it in. It asks what your application does, who uses it, and how it complies with the YouTube API Services Terms of Service

> **You'll know this worked when** the "Queries per day" figure on the quotas page goes above 10,000. Then raise `YOUTUBE_DAILY_QUOTA_BUDGET` to about 90% of the new number.

**Set expectations honestly:** this is a manual review, approval is not automatic, and it is not quick — plan in weeks, not days. A personal instance saving a few dozen videos a day does not need it. If you are sharing an instance with three other people and hitting the ceiling, one deployment per person is faster and gives each of you a full allowance. Details in [ADR-0006](docs/adr/0006-quota-strategy.md).

---

## "I set it in `.env` but the deployed Worker ignores it"

**Cloudflare only.** `wrangler deploy` does not read `.env` — never has. A bare `wrangler deploy` uses whatever is baked into `wrangler.jsonc`, so anything you changed locally silently does not apply.

The usual symptom is a deployment that keeps warning **"authorisation will expire in 7 days"** after you published your OAuth app to Production and set `GOOGLE_OAUTH_PUBLISHING_STATUS=production`. The warning is wrong, and the cure is to send the value:

```bash
pnpm deploy:cloudflare
```

That reads your whole `.env` and sends every key — secrets via `wrangler secret put`, everything else via `--var`. See [DEPLOY.md](DEPLOY.md#how-env-reaches-a-worker).

**Already deployed and just want the one variable changed?** Either:

```bash
pnpm exec wrangler deploy --var GOOGLE_OAUTH_PUBLISHING_STATUS:production
```

or in the dashboard: **Workers & Pages** → **later** → **Settings** → **Variables and Secrets** → **Add** → type **Text**, name `GOOGLE_OAUTH_PUBLISHING_STATUS`, value `production` → **Deploy**.

The dashboard edit is overwritten by the next `wrangler deploy` that does not pass the same value, so fix `.env` and re-run the script if you want it to stick.

**This does not affect Docker or local Node** — both read `.env` directly.

---

## `redirect_uri_mismatch` when authorising

Google requires the redirect URI to match a registered one **byte for byte**.

Check all of these:

| Check | Note |
|---|---|
| `PUBLIC_BASE_URL` has **no trailing slash** | `http://localhost:8787`, not `.../` |
| The full callback path is registered | `.../auth/callback` — the path counts |
| `localhost` vs `127.0.0.1` | Google treats these as **different URIs**. Register both. |
| Port matches | 8787 by default on every target — the Node server takes its port from `PUBLIC_BASE_URL` |
| `http` vs `https` | `http` only for loopback; deployed must be `https` |
| Deployed URL is registered at all | It isn't by default — Batch 4 adds it |

The error page itself shows the URI that was attempted. Copy it from there and add it verbatim under **"Authorized redirect URIs"** on your OAuth client — that's faster than reasoning about it.

---

## "This app isn't verified"

Expected. Your app is unverified because you haven't submitted it for review, and for personal use you shouldn't.

Click **"Advanced"** → **"Go to Later (unsafe)"**. Once, then never again for that account.

You are the developer of the app you are authorising. Verification exists to protect users from *other people's* apps.

---

## Ingest returns `401`

The `Authorization: Bearer <token>` header doesn't match a token Later recognises.

- Whitespace or a newline copied along with the token — the most common cause by a mile
- The header must be exactly `Authorization: Bearer <token>` — the space matters
- You rotated `INGEST_TOKEN` but didn't update the client (Shortcut, PWA, Telegram config)
- **In MULTI mode, `INGEST_TOKEN` is not a valid token at all.** Each account mints its own from the web UI after connecting Google; the instance-wide one authenticates nothing. Sign in, press **"Create my ingest token"**, and copy the value it shows once
- You set `INGEST_HMAC_SECRET`, which makes signatures mandatory and **breaks the iOS Shortcut** — unset it unless you're deliberately using HMAC ([ADR-0008](docs/adr/0008-ingest-authentication.md))

## Ingest returns `429`

Rate limited. Default 30/minute per token. Genuine bursts are rare; if you're seeing this from normal use, a client is probably retrying in a loop — check that before raising `INGEST_RATE_LIMIT_PER_MINUTE`.

---

## "It said saved, but the video isn't in the playlist"

`202 Accepted` means *accepted*, not *added* — by design, so the share sheet never blocks. Check the item's state in the web UI. Common outcomes:

| State | Meaning |
|---|---|
| `pending` | queued; up to a minute if the fast path didn't complete |
| `held_for_review` | resolved below the confidence threshold, waiting for one tap |
| `duplicate` | already in the playlist. Working correctly. |
| `unresolvable` | no YouTube video found in the share |
| `blocked` | video is private, deleted, or region-blocked |
| `deferred` | quota exhausted; retrying after reset |
| `parked` | account needs re-authorisation — see the first entry |

## "It added the wrong video"

Tier 2 resolved a description to a video that ranked well but was wrong.

Remove it from the playlist, then **raise `RESOLVE_CONFIDENCE_THRESHOLD`** (default `0.75`) toward `0.85`–`0.9`. More items land in review; fewer wrong ones get added silently. A wrong video costs more trust than a missing right one, so err high.

Setting it to `1.0` effectively means "only trust actual URLs", which is a legitimate configuration.

## "Everything goes to review and nothing gets added automatically"

Almost certainly no LLM configured (`LLM_PROVIDER=none`, the default) *and* the shares have no YouTube URL in them. Tier 0 can't resolve a caption that only *describes* a video.

Either set up Tier 2 (`LLM_PROVIDER=gemini` + `GEMINI_API_KEY`) or accept the review step for those shares. If shares that *do* contain a URL are landing in review, that's a Tier 0 bug — **please open an issue with the URL**.

## "Duplicates got added twice"

This shouldn't be possible — a `UNIQUE(account_id, video_id)` constraint prevents it, and it's tested. Note that YouTube itself stopped rejecting duplicate inserts in 2016, so Later's constraint is the only guard.

If you're seeing genuine duplicates, that's a real bug. Please open an issue with both playlist entries and the two item records.

---

## Telegram bot doesn't respond

1. **In SOLO,** `TELEGRAM_ALLOWED_CHAT_IDS` must contain **your** numeric chat ID. Later ignores anyone not on it — silently and on purpose, because the bot's username is discoverable and an open bot would let strangers write to your playlist. Send the bot `/id` to find the number.
2. The webhook must be registered with your `PUBLIC_BASE_URL`. It can't reach `localhost` — use a deployed instance or a tunnel.
3. `TELEGRAM_WEBHOOK_SECRET` must match what was set when the webhook was registered.

**In MULTI, the bot replies but says the chat is not connected.** That is the linking step, not a fault: sign in to the web UI, copy the `/link ...` command from the account panel, and send it to the bot. Codes expire after 15 minutes; if yours has, reload the page for a fresh one.

## PWA doesn't appear in the Android share sheet

The PWA must be **installed to the home screen** first — "Add to Home screen" from the browser menu. `share_target` isn't offered to a site you've merely visited. It also requires HTTPS, so a `localhost` instance won't work; and iOS doesn't support `share_target` at all, which is why the iOS Shortcut exists.

---

## Getting help

Before opening an issue, please include:

- What you shared (the URL or text, redacted if you like)
- The item's state from the web UI
- The relevant log lines, **with your request ID** — every request has one, and it ties the whole pipeline run together
- Your `LATER_MODE`, `LLM_PROVIDER`, and `GOOGLE_OAUTH_PUBLISHING_STATUS`

**Never paste `INGEST_TOKEN`, `TOKEN_ENCRYPTION_KEY`, `GOOGLE_CLIENT_SECRET`, or a refresh token into an issue.** Nobody needs them to help you.
