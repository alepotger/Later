# Setting up Later

**Target: fork to first saved video in under 15 minutes.** If any step here takes longer than it should, or a label doesn't match what you see, that's a bug — please open an issue.

Before anything else, the thing worth knowing: **Later does not write to your native YouTube "Watch Later" queue.** Google closed API access to it in 2016. Later creates a normal playlist called `Later` in your account and writes there. [Full explanation](README.md#read-this-first-later-cannot-write-to-your-real-watch-later).

---

## Step 0 — See it work before setting anything up (2 minutes, optional)

Worth doing. It costs nothing and tells you whether you want the rest.

```bash
git clone https://github.com/alepotger/Later.git
cd Later
pnpm install
USE_FIXTURES=true pnpm dev
```

Open **http://localhost:8787**, click **Connect Google** (in fixtures mode this connects a local stand-in — no Google account involved), then paste a YouTube link into the box.

Everything runs against recorded API responses. Nothing reaches Google, nothing touches a real playlist, and no credentials exist. You'll see the real pipeline, the real dedupe, and the real quota accounting.

When you're done, `Ctrl-C` and continue below.

> No `pnpm`? `npm install -g pnpm`, or use `corepack enable`.

---

## Step 1 — Google Cloud setup (15 minutes, once)

This is the only part that needs a browser, and it's all free — no card, no identity check.

**Follow [`docs/ACTION-REQUIRED.md`](docs/ACTION-REQUIRED.md) Batch 1.** It has exact click paths, exact values, and a "you'll know this worked when…" for every step. Don't paraphrase it from memory; the labels matter.

It covers:

1. Create a Google Cloud project
2. Enable YouTube Data API v3
3. Configure the OAuth consent screen
4. Add the `.../auth/youtube` scope
5. Add yourself as a test user
6. **Decide: Testing or Production** ← the one that matters, see below
7. Create an OAuth client and register the redirect URIs
8. Copy the client ID and secret into `.env`
9. Generate three local secrets

### The one decision that will bite you later

**Publish your OAuth app to Production.** If you leave it in **Testing**, Google revokes your refresh token after **exactly 7 days** and Later silently stops saving videos. The `.../auth/youtube` scope is classified sensitive, which is what triggers that rule.

Publishing is one click and free. You'll click past an "unverified app" warning once during authorisation — that's expected, it means Google hasn't reviewed your app, which is true, and you are the developer.

Later will warn you constantly if you choose Testing, and will notify you with a re-auth link when the token dies rather than failing quietly. But it's much better not to need that.

---

## Step 2 — Configure

```bash
cp .env.example .env
```

Fill in the five required values. Every variable is documented inline in the file.

| Variable | Where it comes from |
|---|---|
| `GOOGLE_CLIENT_ID` | Batch 1 step 7 — ends in `.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Batch 1 step 7 — starts with `GOCSPX-` |
| `INGEST_TOKEN` | `openssl rand -base64 32 \| tr '+/' '-_' \| tr -d '='` (SOLO only) |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `SESSION_SECRET` | `openssl rand -base64 32` |

Plus, if you published to Production in step 1:

```dotenv
GOOGLE_OAUTH_PUBLISHING_STATUS=production
```

**Keep `TOKEN_ENCRYPTION_KEY` somewhere safe.** It decrypts your stored Google token. Lose it and you re-authorise; there's no other consequence, but it's avoidable annoyance.

`.env` is gitignored, and CI scans the full git history for secrets on every push.

---

### Sharing the instance with other people

Skip this unless you need it. By default Later is `SOLO`: one Google account, locked to whoever authorises first.

```dotenv
LATER_MODE=MULTI
LATER_ALLOWED_EMAILS=you@example.com,partner@example.com
```

Each person then connects their own Google account, writes to their own playlist, and mints their own ingest token from the web UI. `INGEST_TOKEN` is ignored. The catch, which Later cannot fix: everyone shares one 10,000-unit daily API quota. [DEPLOY.md](DEPLOY.md#choosing-solo-or-multi) has the numbers.

---

## Step 3 — Run it

```bash
pnpm dev
```

If anything in `.env` is missing or malformed, Later refuses to start and tells you exactly what and how to fix it. That's the intended behaviour, not a failure.

Open **http://localhost:8787** and click **Connect Google**:

1. Choose the Google account whose playlist you want to write to
2. On "Google hasn't verified this app", click **Advanced** → **Go to Later (unsafe)** — expected, once
3. Grant the YouTube permission

You'll land on a page confirming which account is connected and that the `Later` playlist was created.

> **`redirect_uri_mismatch`?** Google requires a byte-exact match. The error page shows the URI it tried; copy that into **Authorized redirect URIs** on your OAuth client. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#redirect_uri_mismatch-when-authorising).

---

## Step 4 — Save your first video

Paste a YouTube link into the box and press **Save it**.

> **You'll know this worked when** the page says "Got it · 1 saved", the video appears under "Recent shares" with a **saved** badge and its real title, and it's in your `Later` playlist in the YouTube app.

Now paste the same link again. You should get **"Already shared — you have sent that one before"**, and no second entry appears. Paste the *same video* as a different URL form (say `youtube.com/watch?v=...` instead of `youtu.be/...`) and you'll get **"1 already in the playlist"** instead — a different check catching it one layer down.

Both matter, and it's worth knowing why there are two: YouTube stopped rejecting duplicate playlist inserts in 2016, so nothing upstream will stop a video going in four times. Later's own constraints are the only guard, which is what lets you share carelessly.

**That's the product working.** Everything below is about making it convenient.

---

## Step 5 — Get it onto your phone

This is the point of Later: never opening a web page. Three routes, all hitting the same endpoint.

**They all need a URL your phone can reach**, which `localhost` is not. Either [deploy first](DEPLOY.md) — that is the recommended order, and it is one button — or run a tunnel:

```bash
cloudflared tunnel --url http://localhost:8787   # prints a temporary HTTPS URL
```

Set `PUBLIC_BASE_URL` to that URL and restart.

| Route | Setup | Guide |
|---|---|---|
| **Telegram bot** | ~5 min | [clients/telegram/](clients/telegram/) |
| **iOS Shortcut** | ~2 min | [clients/ios/](clients/ios/) |
| **Android PWA** | ~1 min | [clients/android/](clients/android/) |

**Start with Telegram if you're only doing one.** It works from every app on every OS with nothing installed, and the same bot delivers Later's notifications back to you — including the one telling you authorisation expired. Every other route needs a separate notification channel.

You can always test the endpoint directly:

```bash
curl -X POST http://localhost:8787/api/ingest \
  -H "authorization: Bearer $YOUR_INGEST_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"omg watch this youtu.be/dQw4w9WgXcQ","source":"api"}'
```

It answers `202 Accepted` immediately and does the work afterwards — that's what makes the share sheet feel instant instead of making you wait on a spinner. It deliberately accepts messy input, because share sheets produce messy input: a bare URL, a URL with tracking junk, a caption with the link buried three lines down, JSON, form-encoded, or `text/plain`.

## Step 6 — Get told when something needs you

Optional, and worth two minutes. Without a notification channel you'll only find out things by visiting the web UI — including the message saying authorisation expired and Later has stopped working.

- **Telegram** — set up in Step 5, nothing more to do
- **Anything else** — set `NOTIFY_WEBHOOK_URL` to an ntfy topic, a Discord webhook, a Slack webhook, or your own endpoint

Successful saves are silent by default (`NOTIFY_ON_SUCCESS=false`) — a tool that removes friction shouldn't add a notification per share. Failures, items needing review, and expired authorisation always notify.

## What's not built yet

Being straight about this so you know what you're getting:

| | Status |
|---|---|
| Save a YouTube link → playlist | ✅ works |
| Duplicate protection | ✅ works |
| Quota tracking and queue-on-exhaustion | ✅ works |
| Token expiry detection and re-auth | ✅ works |
| iOS Shortcut · Android PWA · Telegram bot | ✅ built (needs a reachable URL) |
| Notifications (Telegram / webhook) | ✅ works |
| Resolving a caption that *describes* a video | ✅ works (needs an LLM key for Tier 2) |
| One-click deploy · `docker compose up` | ✅ works — see [DEPLOY.md](DEPLOY.md) |
| Several people on one instance (`LATER_MODE=MULTI`) | ✅ works |

Two things have never been run for real by the author: a live Google OAuth round-trip, and a Docker image build (this development environment has no Docker daemon). Both are written and tested against stubs. If either fails for you, that is worth an issue — see [PLAN.md](PLAN.md).

Current state is always in [PLAN.md](PLAN.md).

---

## Reference

**Commands**

| | |
|---|---|
| `pnpm dev` | Run locally with reload |
| `USE_FIXTURES=true pnpm dev` | Run with no credentials, against recorded responses |
| `pnpm check` | Format, lint, typecheck, test |
| `pnpm test` | Tests in watch mode |
| `pnpm db:generate` | Regenerate migrations after a schema change |

**Endpoints**

| | |
|---|---|
| `GET /` | Paste box, recent shares, quota |
| `GET /healthz` | Liveness |
| `POST /api/ingest` | The endpoint every client uses |
| `GET /auth/start` | Begin (or renew) Google authorisation |
| `GET /share-target` | Android PWA share target |
| `GET /review` | Items resolved below the confidence threshold |
| `POST /account/ingest-token` | MULTI only: mint this account's token |

**When something goes wrong:** [TROUBLESHOOTING.md](TROUBLESHOOTING.md). If it stopped working after about a week, read the first entry.
