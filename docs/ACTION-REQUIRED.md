# ACTION REQUIRED — human-in-a-browser steps

This file is **append-only**. New batches go at the bottom with a timestamp; nothing is ever overwritten, so the history of what was asked and when stays intact.

Each batch is designed to be done in **one sitting**, so console work is a few short sessions rather than a dozen interruptions.

---

## Batch 1 — Google Cloud, YouTube API, OAuth client

**Logged:** 2026-08-05 · **Needed before:** Phase 1 task 1.7 (OAuth flow) can be run for real
**Estimated time:** 15 minutes · **Waiting periods:** none — everything here is instant
**Blocks me?** No. Phase 1 is built and tested against a fixture YouTube client. Nothing waits on this.

### Before you start

- Be signed in to the Google account **whose YouTube playlist you want Later to write to**. If you have several, check the avatar in the top right before you begin — using the wrong account here is the single most common way to have to redo this batch.
- No payment details, no card, no identity verification. If anything asks for a card, you're in the wrong place.
- **Do not paste any of the secrets from this batch into our chat.** They go into your local `.env` file and nowhere else. I don't need them and shouldn't have them — Phase 1 is developed and tested entirely against recorded fixtures.

### A note on Google's UI labels

Google renamed this area of the console (it used to be "APIs & Services → OAuth consent screen", now it's "Google Auth Platform"). Both paths are given where they differ. If a label doesn't match exactly, the direct URLs are the reliable route — they've been stable across the rename.

---

### Step 1 — Create a Google Cloud project

1. Go to **https://console.cloud.google.com/projectcreate**
2. In **"Project name"**, enter: `later`
3. Leave **"Location"** as **"No organization"**
4. Click **"Create"**

Wait for the notification bell to show the project has been created, then make sure the project picker in the top bar reads **"later"** — if it still shows another project, click it and select `later`.

> **You'll know this worked when:** the top bar next to "Google Cloud" shows **later**, and you're on the project dashboard.

---

### Step 2 — Enable the YouTube Data API v3

1. Go to **https://console.cloud.google.com/apis/library/youtube.googleapis.com**
2. Confirm the project selector at the top still says **later**
3. Click **"Enable"**

> **You'll know this worked when:** the page changes to the API's management page, headed **"YouTube Data API v3"**, and the button that said "Enable" now says **"Manage"** (or the page shows "API enabled" with Metrics/Quotas tabs).

*Not doing Gemini yet.* It goes in Batch 3, after the product already works. It's not needed for anything in Phase 1, and adding it now would just be an extra thing to have got wrong.

---

### Step 3 — Configure the OAuth consent screen

1. Go to **https://console.cloud.google.com/auth/overview**
   *(older console: **"APIs & Services"** → **"OAuth consent screen"**)*
2. Click **"Get started"**
3. **"App name"**: `Later`
4. **"User support email"**: select your own email from the dropdown
5. Click **"Next"**
6. **"Audience"** → choose **"External"**

   Not "Internal" — Internal only exists for Google Workspace organisations and won't work for a personal Gmail account.
7. Click **"Next"**
8. **"Contact Information"** → enter your own email address
9. Click **"Next"**
10. Tick **"I agree to the Google API Services: User Data Policy"**
11. Click **"Continue"**, then **"Create"**

> **You'll know this worked when:** you land on the Google Auth Platform **"Overview"** page and the left-hand menu now lists **Branding**, **Audience**, **Clients**, **Data Access**, and **Verification Center**.

---

### Step 4 — Add the YouTube scope

1. In the left menu, click **"Data Access"**
2. Click **"Add or remove scopes"**
3. In **"Manually add scopes"** (the box below the scope table), paste exactly:

   ```
   https://www.googleapis.com/auth/youtube
   ```
4. Click **"Add to table"**
5. Tick the checkbox next to that scope in the table if it isn't already ticked
6. Click **"Update"**
7. Back on the Data Access page, click **"Save"**

> **You'll know this worked when:** the **"Your sensitive scopes"** section lists `.../auth/youtube` with the description **"Manage your YouTube account"**.

It appearing under **sensitive** rather than "non-sensitive" is correct and expected — that classification is exactly what causes the 7-day token expiry in Step 6. It is not a mistake and there is no non-sensitive alternative that can write to a playlist.

**Add only this one scope.** Later needs nothing else. Adding `youtube.force-ssl` or `youtubepartner` grants strictly more access than the app uses.

---

### Step 5 — Add yourself as a test user

1. In the left menu, click **"Audience"**
2. Scroll to **"Test users"**
3. Click **"+ Add users"**
4. Enter the Google account email you want Later to write to — the one from "Before you start"
5. Click **"Save"**

> **You'll know this worked when:** your email address is listed under "Test users".

Do this **even if** you plan to publish to Production in the next step. It costs nothing, and it means authorisation works immediately either way.

---

### Step 6 — DECISION: Testing or Production?

**⚠️ This is the most consequential choice in this batch. Getting it wrong means Later stops working in exactly seven days, quietly.**

The `.../auth/youtube` scope you just added is classified **sensitive**. For an **External** app left in **Testing**, Google **revokes your refresh token after 7 days** — Later loses access and stops adding videos.

| | **Testing** | **Production, unverified** ← recommended |
|---|---|---|
| Authorisation survives | **7 days**, then breaks | indefinitely |
| Consent screen | "unverified app" warning | same warning, one click past |
| User limit | 100 | 100 |
| Google review needed | no | no |
| Cost | free | free |

**My recommendation: Production.** The tradeoff in one line — you click through an "unverified app" warning once, and in exchange your authorisation doesn't die every week.

The warning is genuinely benign for your own app: it says Google hasn't reviewed it, which is true, and you are the developer. You click **"Advanced"** → **"Go to Later (unsafe)"** once during Step 8's auth flow and never see it again.

Verification (which removes the warning and the 100-user cap) is **not needed** and I'd advise against starting it — it can take weeks and may require a security assessment. It only matters if you want more than 100 people using your instance.

**To publish:**

1. Left menu → **"Overview"** (or **"Audience"**)
2. Click **"Publish app"**
3. Read the confirmation dialog, then click **"Confirm"**

> **You'll know this worked when:** the **"Publishing status"** on the Overview or Audience page reads **"In production"** instead of "Testing".

**Then record your choice** in `.env` — Later uses this to decide whether to warn you:

```dotenv
GOOGLE_OAUTH_PUBLISHING_STATUS=production   # or: testing
```

Google offers no API for an app to read its own publishing status, so Later has to be told. If you set `testing`, expect a standing warning in the UI and logs — that's deliberate, and Later will notify you with a re-auth link the moment the token dies rather than failing silently.

---

### Step 7 — Create the OAuth client

1. Left menu → **"Clients"**
2. Click **"+ Create client"**
3. **"Application type"**: select **"Web application"**

   Not "Desktop app" — Later runs a web server and needs a redirect URI it controls.
4. **"Name"**: `Later web client`
5. Under **"Authorized redirect URIs"**, click **"+ Add URI"** and add **all four** of these, exactly as written, one per URI slot:

   ```
   http://localhost:8787/auth/callback
   ```
   ```
   http://127.0.0.1:8787/auth/callback
   ```
   ```
   http://localhost:3000/auth/callback
   ```
   ```
   http://127.0.0.1:3000/auth/callback
   ```

   All four are real and all four are needed. Google treats `localhost` and `127.0.0.1` as **different** URIs and different OSes resolve differently, so registering both avoids a `redirect_uri_mismatch` that is very annoying to diagnose. Port 8787 is the Cloudflare Workers dev server; 3000 is the Node/Docker path. `http` (not `https`) is correct and permitted for loopback addresses only.

   Leave **"Authorized JavaScript origins"** empty — Later doesn't do browser-side OAuth.
6. Click **"Create"**

> **You'll know this worked when:** a dialog appears titled **"OAuth client created"** showing **"Client ID"** and **"Client secret"**.

**Your production URL is not in this list, on purpose.** It doesn't exist yet, and §9 forbids guessing it. Adding it is a 60-second step in Batch 4, once your deployment has a real hostname.

---

### Step 8 — Copy the credentials into `.env` (not into chat)

From that dialog — or later via **"Clients"** → click **"Later web client"**, where the secret can be re-shown or reset:

| Console field | Goes into `.env` as |
|---|---|
| **"Client ID"** (ends in `.apps.googleusercontent.com`) | `GOOGLE_CLIENT_ID` |
| **"Client secret"** (starts `GOCSPX-`) | `GOOGLE_CLIENT_SECRET` |

```bash
cp .env.example .env
# then edit .env and paste both values
```

`.env` is in `.gitignore`, and CI scans the full git history for secrets on every push. Even so: **don't paste these into our chat.** They'd end up in the transcript, and I have no use for them — Phase 1 is built against recorded fixtures precisely so that real credentials are only ever needed on your machine.

> **You'll know this worked when:** `.env` contains both values, `git status` does **not** list `.env` as a new file, and `GOOGLE_CLIENT_ID` ends in `.apps.googleusercontent.com`.

---

### Step 9 — Generate the local secrets (terminal, not browser)

Not console work, but it belongs in this sitting so the whole `.env` is finished at once. Run each and paste the output into the matching variable:

```bash
# INGEST_TOKEN — authenticates every share sent to /api/ingest
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='

# TOKEN_ENCRYPTION_KEY — encrypts your Google refresh token at rest (AES-GCM)
openssl rand -base64 32

# SESSION_SECRET — signs web UI session cookies
openssl rand -base64 32
```

No `openssl`? Any of these works:

```bash
python3 -c "import secrets;print(secrets.token_urlsafe(32))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Never** reuse one value for two variables, and never use a value that has appeared in this file, in a tutorial, or in a screenshot. Each is generated once, on your machine, by you.

> **You'll know this worked when:** all three are set in `.env`, each is a different ~44-character string, and none is still an empty `=`.

---

### Batch 1 done — what to tell me

Reply with just this. **No secrets.**

1. **"Batch 1 done"**
2. Your publishing status choice: **`production`** or **`testing`**
3. Anything where the console didn't match what's written above — wrong label, missing button, unexpected screen. That's a documentation bug and I'll fix it, since these instructions become `SETUP.md` for every stranger who deploys this.

I'll then finish Phase 1 against the fixture client and hand you `SETUP.md` with the exact commands to run your own first real end-to-end test: start the server, authorise, share a link, watch it land in the playlist. You run that part — it needs your credentials and your YouTube account, and neither should ever reach me.

---

## Batches 2–4 — drafted, not yet actionable

> **Superseded, 2026-08-06.** All three have since been written out in full, further down this file: [Batch 2](#batch-2--telegram-bot-and-the-ios-shortcut), [Batch 3](#batch-3--gemini-api-key-optional), [Batch 4](#batch-4--deploy). Follow those, not these sketches. The sketches are kept because this file is append-only — nothing here is ever rewritten or deleted, so you can always see what was promised versus what arrived.

Listed now so the total console cost of this project is visible up front rather than arriving as a surprise. **Do not do these yet** — each will be rewritten as a full, exact, step-by-step batch when its phase arrives, with every value resolved.

Some values in these batches **cannot honestly be written down yet**: your production redirect URI depends on a hostname that won't exist until Batch 4's deployment. §9 forbids guessing, so those steps stay drafts until the real value exists.

### Batch 2 — Telegram bot + iOS Shortcut *(before Phase 2, ~10 min)*
- Create a bot by messaging **@BotFather** in Telegram (`/newbot`) → `TELEGRAM_BOT_TOKEN`
- Get your own numeric chat ID → `TELEGRAM_ALLOWED_CHAT_IDS` (mandatory — without it, anyone who finds your bot can write to your playlist)
- Import the Later Shortcut on an iPhone and paste in your ingest URL and token
- **Needs a physical phone**, which is the part I can't do

### Batch 3 — Gemini API key *(before Phase 3, ~3 min)*
- Enable the **Generative Language API** in the *same* `later` project, or get a key from Google AI Studio → `GEMINI_API_KEY`
- Optional. Tiers 0 and 1 work without it; skipping it just means captions with no link land in the review inbox instead of resolving automatically
- This is the step where the "same Google Cloud project" convergence noted in the README becomes literal — same project, one extra click

### Batch 4 — Deploy *(before Phase 4 sign-off, ~15 min)*
- Create a Cloudflare account (free, no card)
- Click **"Deploy to Cloudflare"**, which provisions the D1 database and forks the repo into your account
- Paste the secrets from Batch 1 into the deployment
- **Add your production redirect URI** to the OAuth client from Step 7 — the URI will be `https://<your-worker>.<your-subdomain>.workers.dev/auth/callback`, which I'll give you resolved once the deployment exists
- Set `PUBLIC_BASE_URL` to the deployed origin
- Re-confirm publishing status from Step 6, since this is the point at which the 7-day clock starts mattering in earnest

---

## Status note — 2026-08-06

**Phase 1 has landed and Batch 1 above is now the blocking step.** Nothing was guessed or marked done in my absence; the batch is exactly as written.

Where things stand:

- The product works. Share a YouTube link and it lands in the playlist, deduplicated, with quota accounted for. 336 tests, none of which need a credential.
- The OAuth flow is written and tested against a **stubbed** Google token endpoint — every branch, including `invalid_grant`, refresh-token rotation, and transient failure. What it has never done is complete one **real** round-trip with Google. That is what Batch 1 unblocks, and it is the only Phase 1 item not verified.
- You can see everything else working right now without touching a console: `USE_FIXTURES=true pnpm dev`. See [SETUP.md](../SETUP.md) Step 0.

When you do Batch 1, the outputs go into your own local `.env` and nowhere else. I don't need them and shouldn't have them.

**One thing to know before you deploy** (relevant at Batch 4, not now): between a deployment going live and you completing authorisation, whoever reaches `/auth/start` first claims the instance. In SOLO mode every later attempt is then refused, which is the protection — but the *first* one is open by necessity. On a fresh deployment, authorise before sharing the URL with anyone. Recorded in [SECURITY.md](../SECURITY.md).

---

## Batch 2 — Telegram bot and the iOS Shortcut

**Logged:** 2026-08-06 · **Needed before:** the phone clients can be *used* (the code is written and tested)
**Estimated time:** ~10 minutes · **Waiting periods:** none
**Blocks me?** No. Phase 2 is complete and tested against stubs. This sandbox cannot reach `api.telegram.org` and has no iPhone, so live verification is yours.

### ⚠️ Read this first — do Batch 4 before this one

**Both clients need a URL your phone and Telegram can reach, and `localhost` is not one.**

- Telegram *pushes* updates to a webhook, so it needs a public HTTPS URL. There is no way around this.
- Your phone can't reach a server on your laptop either.

So the honest order is **deploy first, then set up the clients**. That inverts the phase numbering, and it is worth being straight about rather than sending you to configure a bot that cannot work.

Two options:

1. **Recommended: do Batch 4 (deploy to Cloudflare) first**, then come back here with your real URL. Free, no card, ~15 minutes.
2. **Or use a tunnel** for a local trial: `cloudflared tunnel --url http://localhost:8787` prints a temporary HTTPS URL. Set `PUBLIC_BASE_URL` to it, restart, and use it below. The URL changes every restart, so this is for trying things, not for living with.

Everything below assumes you have a public HTTPS base URL. It's written as `https://YOUR-LATER-URL`.

---

### Step 1 — Create the Telegram bot

1. Open Telegram and message **[@BotFather](https://t.me/BotFather)**
2. Send `/newbot`
3. **Name** (displayed): anything — `My Later`
4. **Username**: must be globally unique and end in `bot` — e.g. `alex_later_9f2bot`

> **You'll know this worked when** BotFather replies *"Done! Congratulations on your new bot"* and shows a token shaped like `8123456789:AAF-abc...`.

That token goes in `TELEGRAM_BOT_TOKEN`. **Don't paste it into our chat** — it is a full credential for the bot.

---

### Step 2 — Find your numeric chat ID

Message **[@userinfobot](https://t.me/userinfobot)**. It replies immediately with your ID, a number like `123456789`.

Put it in `TELEGRAM_ALLOWED_CHAT_IDS`.

> **You'll know this worked when** you have a plain number, not an `@username`.

**This is mandatory and Later refuses to start without it.** Your bot's username is discoverable by anyone — that is how Telegram works — so without an allowlist a stranger who finds it could add videos to your playlist.

*(Once the webhook is live you can also send `/id` to your own bot, which does the same thing. @userinfobot avoids the chicken-and-egg.)*

---

### Step 3 — Generate a webhook secret

```bash
openssl rand -hex 32
```

Put it in `TELEGRAM_WEBHOOK_SECRET`. This is how Later proves an incoming update really came from Telegram.

---

### Step 4 — Register the webhook

With all three values in your config and Later deployed and running:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://YOUR-LATER-URL/telegram/webhook",
    "secret_token": "<YOUR_WEBHOOK_SECRET>",
    "allowed_updates": ["message", "callback_query"],
    "drop_pending_updates": true
  }'
```

> **You'll know this worked when** the response is exactly:
> `{"ok":true,"result":true,"description":"Webhook was set"}`

Then send your bot a message containing a YouTube link.

> **You'll know the whole path works when** the bot replies **"Saved to Later"** within a second or two, and the video is in your playlist.

If it stays silent, the one command worth running is:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

`last_error_message` in that response tells you exactly what Telegram saw when it tried to reach you. Nothing else debugs this faster.

---

### Step 5 — The iOS Shortcut (needs a physical iPhone)

Full instructions with exact action names: **[`clients/ios/README.md`](../clients/ios/README.md)**.

**Use Route A — build it by hand.** It is five actions and about two minutes, and it needs no settings changes.

Route B (importing the shipped `clients/ios/Later.plist`) exists, but iOS only imports shortcut files frictionlessly from an **iCloud link**, and iCloud links can only be created by a person tapping Share on a real device — so I cannot generate one for you. Importing a plain file requires enabling *Settings → Shortcuts → Allow Untrusted Shortcuts*. **The generated file has never been tested on a real device.** If you try it and it misbehaves, that is a bug in `scripts/build-ios-shortcut.py` and worth reporting.

> **You'll know this worked when** sharing a TikTok from the TikTok app shows the "Sent to Later" notification straight away, and the video appears in your playlist. That is the ≤3-taps claim actually met.

**If you'd like to publish a signed iCloud link** so other people can one-tap install it: long-press your shortcut → **Share** → **Copy iCloud Link**. Send me the link (it is not a secret) and I will put it in the README. Only you can create it.

---

### Step 6 — Android PWA (needs an Android phone)

**[`clients/android/README.md`](../clients/android/README.md)** — open the deployed URL in Chrome, menu → **Add to Home screen** → **Install**.

> **You'll know this worked when** Later appears in the Android share sheet from TikTok or Instagram.

Requires HTTPS, which is another reason to deploy first. Icons are already served at `/icon-192.png` and `/icon-512.png`; without them Chrome would not offer to install at all.

---

### Batch 2 done — what to tell me

1. **"Batch 2 done"**, plus which parts you did (Telegram / iOS / Android)
2. The bot reply you got, or the `last_error_message` if it stayed silent
3. Your iCloud shortcut link, if you made one
4. Anything where the instructions didn't match what you saw

**No tokens, no secrets.** The bot token and webhook secret are credentials; they belong in your config only.

---

## Batch 3 — Gemini API key (optional)

**Logged:** 2026-08-06 · **Needed before:** Tier 2 can resolve a caption that only *describes* a video
**Estimated time:** ~3 minutes · **Waiting periods:** none · **Cost:** free, no card
**Blocks me?** No. Phase 3 is complete and tested against a fixture provider.

### Skip this if you like

Tiers 0 and 1 need no key and handle the majority of real shares:

- **Tier 0** — a YouTube link anywhere in the shared text. Free, exact, instant.
- **Tier 1** — a TikTok or Instagram caption containing a YouTube link, read via public oEmbed. Also free.

Tier 2 only matters for the case where a caption *describes* a video without linking it — *"that Veritasium one about why planes fly"*. Without a key, those land honestly as "no YouTube link found" rather than being guessed at.

**Cost warning worth knowing before you enable it:** each Tier 2 resolution spends **151 units** of your 10,000/day YouTube quota, versus 51 for a share with a link. That is roughly 65 searched shares a day instead of 190. Later spends at most one `search.list` per item regardless of how many candidates the model returns.

### Step 1 — Get a key

The quickest route:

1. Go to **https://aistudio.google.com/apikey**
2. Click **"Create API key"**
3. Choose **"Create API key in existing project"** and pick the **`later`** project from Batch 1

> **You'll know this worked when** you see a key starting with `AIza...`.

Using the same project is the convergence noted in the README: the Gemini API and YouTube Data API v3 live side by side in one Google Cloud project. **That is the only thing they share** — Gemini cannot grant, proxy, or substitute for YouTube access, which needs the OAuth you set up in Batch 1.

*(Alternative, same result: enable the **Generative Language API** at https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com with `later` selected, then create the key under **Credentials**.)*

### Step 2 — Configure

```dotenv
LLM_PROVIDER=gemini
GEMINI_API_KEY=AIza...
# Optional. Defaults to gemini-2.5-flash, which is on the free tier.
LLM_MODEL=gemini-2.5-flash
```

Later refuses to start with `LLM_PROVIDER=gemini` and no key, rather than silently disabling Tier 2.

### Step 3 — Try it

Share something that describes a video without linking it — *"that Veritasium video about why planes fly"*.

> **You'll know this worked when** either the video is saved with **tier 2** recorded against it, or it appears at `/review` with a confidence score and an **Add it** button.

**Both are correct outcomes.** Later only auto-adds above `RESOLVE_CONFIDENCE_THRESHOLD` (default `0.75`); anything less waits for one tap. A wrong video in your playlist costs more trust than a missing right one, so the bias is deliberately towards asking.

If too much lands in review, lower the threshold. If anything wrong gets added, raise it toward `0.85`–`0.9`. Setting it to `1.0` effectively means "only trust real URLs", which is a legitimate way to run.

### Not using Gemini?

Anything speaking the OpenAI chat-completions shape works, including a local model:

```dotenv
LLM_PROVIDER=openai-compatible
OPENAI_BASE_URL=http://localhost:11434/v1   # Ollama
OPENAI_API_KEY=                              # local runtimes need none
LLM_MODEL=llama3.2
```

### Batch 3 done — what to tell me

1. **"Batch 3 done"**, or "skipping Tier 2"
2. Whether a described-but-unlinked share resolved, went to review, or was declined
3. If it resolved the *wrong* video, the caption you shared and what it picked — that is a ranking bug and the fixtures for it live in `tests/core/ranking.test.ts`

**No keys in chat.** `GEMINI_API_KEY` is a credential.

---

## Batch 4 — Deploy

**Logged:** 2026-08-06 · **Needed before:** the phone clients can work at all, and before the project is finished
**Estimated time:** ~15 minutes for Cloudflare, ~5 for Docker · **Waiting periods:** none
**Blocks me?** Yes, for final sign-off. Everything is built and tested; this sandbox has no Cloudflare account and no Docker daemon, so a live deployment is yours to make.

**Do Batch 1 first.** Deploying without a Google OAuth client gives you a service that starts and then refuses to do anything useful.

**Do this before Batch 2.** Both phone clients need a public HTTPS URL, and `localhost` is not one.

### Choose your target first

| | **A — Cloudflare Workers** | **B — Docker** |
|---|---|---|
| Cost | free tier, no card | a machine you already have |
| Public HTTPS URL | included | you arrange it |
| Time | ~15 min | ~5 min + however long TLS takes you |

**Recommendation: A.** The phone clients need a public HTTPS URL and Cloudflare hands you one. Pick B only if you already run a homelab with a reverse proxy and want the data on a disk you can see.

Full reference for both: [DEPLOY.md](../DEPLOY.md).

---

### Option A — Cloudflare Workers

#### A1 — Create a Cloudflare account (2 min)

Go to **https://dash.cloudflare.com/sign-up**. Email and a password. No card, no identity check.

> **You'll know this worked when** you land on the Cloudflare dashboard with an account name in the top-left.

#### A2 — Click the deploy button (3 min)

Open the repository README and click **"Deploy to Cloudflare"**, or go straight to:

```
https://deploy.workers.cloudflare.com/?url=https://github.com/alepotger/Later
```

Cloudflare will ask to connect your GitHub account, then show a form:

- **Repository name** — `Later` is fine. This creates a **copy in your own GitHub account**; you are not pushing to mine.
- It will list the resources it is about to create. **`later-db` (D1 database)** must be one of them.

Click **"Create and deploy"**.

> **You'll know this worked when** the build finishes and the page shows a URL ending in `.workers.dev`. **Copy that URL — every remaining step needs it.** It looks like `https://later.something.workers.dev`.

If the build fails, open the build log and read the first error, not the last. Send it to me and I'll fix it.

#### A3 — Set the five secrets (4 min)

In the Cloudflare dashboard: **Workers & Pages** → **later** → **Settings** → **Variables and Secrets** → **"Add"**, and set **Type: Secret** for each.

| Name | Value | Where it came from |
|---|---|---|
| `GOOGLE_CLIENT_ID` | ends `.apps.googleusercontent.com` | Batch 1 step 7 |
| `GOOGLE_CLIENT_SECRET` | starts `GOCSPX-` | Batch 1 step 7 |
| `INGEST_TOKEN` | your 43-character token | Batch 1 step 9 |
| `TOKEN_ENCRYPTION_KEY` | your base64 32-byte key | Batch 1 step 9 |
| `SESSION_SECRET` | your third random value | Batch 1 step 9 |

Use the **same** values as your local `.env`. Especially `TOKEN_ENCRYPTION_KEY` — a different one there means the deployment cannot decrypt anything the local instance stored, and vice versa.

Then add one **plain text variable** (Type: Text, not Secret), using the URL from A2 with **no trailing slash**:

| Name | Value |
|---|---|
| `PUBLIC_BASE_URL` | `https://later.<your-subdomain>.workers.dev` |

Click **"Deploy"** to apply them.

> **You'll know this worked when** `https://<your-url>/healthz` returns `{"ok":true,"mode":"SOLO"}`.

#### A4 — Register the production redirect URI (2 min)

**This is the step people skip, and then authorisation fails with `redirect_uri_mismatch`.**

1. Go to **https://console.cloud.google.com/auth/clients** with your `later` project selected
2. Click your OAuth client (the one from Batch 1 step 7)
3. Under **"Authorized redirect URIs"**, click **"+ ADD URI"**
4. Paste your deployed callback — the A2 URL with `/auth/callback` on the end, exactly, no trailing slash:

```
https://later.<your-subdomain>.workers.dev/auth/callback
```

5. Click **"SAVE"**

> **You'll know this worked when** the URI is listed alongside the four `localhost` ones from Batch 1. Google can take a minute or two to propagate; if the next step fails with a mismatch, wait 60 seconds and retry before changing anything.

#### A5 — Authorise, immediately (2 min)

**Do this before you give the URL to anyone else.** On a fresh SOLO deployment, whoever reaches `/auth/start` first claims the instance. Every later attempt is refused — that is the protection — but the first one is open by necessity.

1. Open `https://<your-url>/`
2. Click **"Connect Google"**
3. Choose your account, click through **"Advanced"** → **"Go to Later (unsafe)"**, grant the YouTube permission

> **You'll know this worked when** the page says **"Connected as you@example.com"** and names the playlist it created.

#### A6 — Save a video (1 min)

Paste a YouTube link into the box and press **"Save it"**.

> **You'll know this worked when** the page says **"Got it · 1 saved"** and the video is in your `Later` playlist in the YouTube app.

**That is the whole product working, end to end, on a real deployment.** Everything after this is convenience.

---

### Option B — Docker

Needs Docker Desktop or Docker Engine with Compose **v2.24 or newer** (`docker compose version`).

#### B1 — Clone and configure (3 min)

```bash
git clone https://github.com/alepotger/Later.git && cd Later
cp .env.example .env
```

Fill in the five values from Batch 1, exactly as in [SETUP.md](../SETUP.md#step-2--configure). Set `PUBLIC_BASE_URL` to whatever external HTTPS origin you will actually use — not `localhost`, unless you only ever intend to use this from the same machine.

#### B2 — Start it (2 min, plus the first build)

```bash
docker compose up -d --build
docker compose logs -f later
```

> **You'll know this worked when** the log ends with `later is listening` and `curl http://localhost:8787/healthz` returns `{"ok":true,"mode":"SOLO"}`.

If it exits instead, the log will name every config value that is missing or malformed and how to generate it. That output is the fix; it is not a crash.

#### B3 — Give it a public URL

The container speaks plain HTTP on `8787` and does not terminate TLS. Put it behind Caddy, nginx, Traefik, or a Cloudflare Tunnel, then set `PUBLIC_BASE_URL` to the external origin and `docker compose up -d` again.

For a throwaway test:

```bash
cloudflared tunnel --url http://localhost:8787
```

#### B4–B6

Same as **A4**, **A5** and **A6** above, using your own origin in place of the `workers.dev` one.

---

### Decide: SOLO or MULTI

**Recommendation: leave it as SOLO** unless someone else is going to use this instance. SOLO is the default, needs no extra configuration, and locks the instance to your account after the first authorisation.

If you do want to share it:

```dotenv
LATER_MODE=MULTI
LATER_ALLOWED_EMAILS=you@example.com,someone@example.com
```

Each person then connects their own Google account, gets their own playlist, and mints their own ingest token from the web UI. `INGEST_TOKEN` stops being used.

**Know the trade before choosing it:** everyone on the instance shares one 10,000-unit daily YouTube quota, because the allowance belongs to the Google Cloud project rather than the user. Four people is roughly 45 link-bearing shares each per day. Later cannot fix that; the honest answers are a quota increase (slow, manual review) or one deployment per person.

### Decide: Testing or Production, again

You chose this in Batch 1 step 6, and this is the point where it starts costing you. If your OAuth app is still in **Testing**, Google will revoke the refresh token you just created **exactly 7 days from now** and Later will stop saving videos.

Publishing is one click and free: **https://console.cloud.google.com/auth/overview** → **"Publish app"** → **"Confirm"**, then set `GOOGLE_OAUTH_PUBLISHING_STATUS=production` and redeploy.

**Recommendation: publish.** The "unverified app" warning you click past once is not a risk to you — you are the developer of the app you are authorising.

### Batch 4 done — what to tell me

1. **"Batch 4 done"**, and which option you took
2. **Your deployed origin** (e.g. `https://later.something.workers.dev`) — not a secret, and I need it to write the exact client configuration in Batch 2
3. Whether A5 and A6 both worked, and the exact error if either did not
4. Your `LATER_MODE` and `GOOGLE_OAUTH_PUBLISHING_STATUS` choices

**No secrets in chat.** Not the client secret, not `TOKEN_ENCRYPTION_KEY`, not an ingest token. I do not need any of them and should not have them.

---

## Correction to Batch 1 — 2026-08-06

This file is append-only, so the original stands above and the fix lives here.

**Batch 1 step 7 says "Port 8787 is the Cloudflare Workers dev server; 3000 is the Node/Docker path."** The second half is wrong. Later's Node server takes its port from `PUBLIC_BASE_URL`, which defaults to `http://localhost:8787`, so **every local target listens on 8787 by default**. Port 3000 is only reached if you set `PUBLIC_BASE_URL` to a URL with no port at all.

**Nothing to redo.** Registering the two `:3000` redirect URIs was harmless — a registered URI that never gets used costs nothing, and it means the port still works if you ever set it. Keep all four.

Found by following `SETUP.md` from a clean clone and checking what the server actually printed, rather than what the docs claimed. `.env.example` and `TROUBLESHOOTING.md` have been corrected at the source.

---

## Batch 5 — Going public

**Logged:** 2026-08-06 · **Needed before:** anyone else can find or use this
**Estimated time:** ~10 minutes · **Waiting periods:** none
**Blocks me?** Partly. Step 1 is the real blocker and only you can authorise it.

### First, the thing that matters more than any step below

**"Public repo" and "public instance" are different, and only one of them is on offer.**

| | Public **repo** | Public **instance** |
|---|---|---|
| What it means | the code is open; anyone forks and deploys their own | your one deployment serves strangers |
| Supported? | **yes — this is the whole design** | **no, and not because it wasn't built** |
| Your `LATER_MODE` | stays `SOLO` | — |

A shared public instance is blocked by the platform, not by missing code:

- Google caps an **unverified OAuth app at 100 users**. Past that needs a security assessment measured in weeks.
- The **10,000-unit daily quota belongs to the Google Cloud project**, so a shared instance is ~190 saved videos per day *in total across everyone* — roughly what one enthusiastic person uses alone.
- Later refuses open registration by design. `MULTI` needs an explicit email allowlist and will not start without one ([ADR-0013](adr/0013-solo-and-multi-modes.md) rejected open registration explicitly).

So: **publish the repo, keep your own instance `SOLO`.** `MULTI` is for putting your partner or a flatmate on your instance — it is not the "public" switch.

---

### Step 1 — Merge the work onto `main` (2 min) ← the actual blocker

**Right now `github.com/alepotger/Later` is public and shows one file: a `README.md` containing the line `# Later`.** Every commit of actual work is on the branch `claude/later-project-setup-k1bagd`. Anyone who finds the repo today finds nothing.

I have not merged it, because pushing to a branch other than the one I was assigned needs your explicit say-so.

**Either tell me "merge it to main" and I will**, or do it yourself:

```bash
git checkout main
git pull
git merge --no-ff claude/later-project-setup-k1bagd
git push origin main
```

> **You'll know this worked when** `github.com/alepotger/Later` shows the full README with the CI badge, and the file list includes `src/`, `SETUP.md`, and `DEPLOY.md`.

One wrinkle: `main`'s single-line README and the branch's README are the same file, so git will report a conflict. Take the branch's version wholesale — `git checkout --theirs README.md && git add README.md`.

---

### Step 2 — Set the repo description and topics (2 min)

Go to **https://github.com/alepotger/Later** and click the **gear icon** next to "About" on the right.

**Description** — copy exactly:

```
Share a Reel or TikTok, get the YouTube video it recommends saved to a playlist. Self-hosted, no telemetry, deploys free.
```

**Topics** — add these one at a time:

```
youtube  youtube-api  self-hosted  cloudflare-workers  typescript  hono  pwa  telegram-bot  ios-shortcuts  share-target
```

Tick **"Releases"** and **"Packages"** off if you like; leave **"Use your GitHub Pages website"** unticked.

> **You'll know this worked when** the sidebar shows the description and a row of blue topic tags.

---

### Step 3 — Turn on private vulnerability reporting (1 min)

`SECURITY.md` tells people to report vulnerabilities privately through GitHub. That button does not exist until you enable it, so right now the instruction points at nothing.

1. **https://github.com/alepotger/Later/settings/security_analysis**
2. Find **"Private vulnerability reporting"**
3. Click **"Enable"**

> **You'll know this worked when** **https://github.com/alepotger/Later/security/advisories/new** loads a form instead of a 404. That is the exact URL the issue templates link to.

---

### Step 4 — Check the issue templates render (1 min)

1. **https://github.com/alepotger/Later/issues/new/choose**
2. You should see four templates — Tier 0 URL bug, bug report, setup help, idea — plus four links out to TROUBLESHOOTING, SETUP, the security form, and the Watch Later explanation.

> **You'll know this worked when** the chooser lists all four and none of the links 404. If you see a plain blank text box instead, the templates did not reach `main` — go back to step 1.

---

### Step 5 — Decide about a release tag (2 min, optional)

A tag gives people something to pin to and a "Releases" entry on the sidebar. My recommendation: **wait.** Tag `v0.1.0` after you have completed Batch 4 and personally watched a real video land in a real playlist. Tagging software that has never run against real Google credentials invites strangers to be your first integration test.

When you are ready:

```bash
git tag -a v0.1.0 -m "First working release"
git push origin v0.1.0
```

---

### Do NOT do these

- **Do not request Google OAuth verification.** It only removes the "unverified app" warning and the 100-user cap, neither of which matters when everyone runs their own instance. It can take weeks and may require a paid security assessment.
- **Do not set `LATER_MODE=MULTI` to "make it public".** It does not do that. It adds an email allowlist for people you name.
- **Do not put your deployed URL in the README.** It is a personal instance with your quota and your playlist behind it, and a public URL invites exactly the traffic it cannot serve.

### Batch 5 done — what to tell me

1. **"Batch 5 done"**, or **"merge it to main"** if you want me to do step 1
2. Whether the issue chooser rendered all four templates
3. Anything in the README that reads wrong to you now that it is the front page of a public project — that is the one thing I cannot judge from inside the repo

---

## Status note — Batch 5 step 1 is done

**2026-08-06.** You authorised the merge and it is done: `main` is now `ceef534`, carrying all 130 files. `github.com/alepotger/Later` shows the real project instead of a one-line README.

Steps 2, 3 and 4 of Batch 5 are still yours — repo description and topics, private vulnerability reporting, and eyeballing the issue chooser. None of them blocks anything; the repo is usable by a stranger right now without them.

**Step 3 is the one with a real consequence if skipped.** `SECURITY.md` and all four issue templates point at `/security/advisories/new`, and that URL 404s until private vulnerability reporting is switched on. Someone with a genuine vulnerability currently has nowhere private to send it, which is worse than having said nothing.

Step 5 — the release tag — still reads **wait**, for the same reason as before: nothing here has run against real Google credentials yet. Batch 4 first.

---

## Automation note — 2026-08-14

Two batches got shorter. Neither is superseded; the manual steps above still work and are still correct if you prefer them.

**Batch 1 step 9** — generating `INGEST_TOKEN`, `TOKEN_ENCRYPTION_KEY` and `SESSION_SECRET` — is now:

```bash
pnpm setup
```

It creates `.env` from `.env.example`, generates all three into it, and prints what is still missing. Safe to re-run: it never overwrites a value that is already set, which matters most for `TOKEN_ENCRYPTION_KEY` — replacing that one is the difference between your stored Google token still decrypting and re-authorising from scratch.

**Batch 4 option A steps A2, A3 and part of A5** are now:

```bash
pnpm exec wrangler login     # browser, once
pnpm deploy:cloudflare
```

That creates the D1 database, writes its ID into `wrangler.jsonc`, uploads the five secrets from `.env`, applies migrations, deploys, reads the `workers.dev` origin back out, redeploys with `PUBLIC_BASE_URL` set to it, checks `/healthz`, and prints your exact redirect URI. Safe to re-run.

### What is left, and why it cannot be automated

Four things, all of them a browser session against an account that is yours and that I hold no credentials for. §9 of the brief forbids guessing or fabricating any of it, so none of this is quietly assumed done anywhere in this repo:

| | Why only you can do it |
|---|---|
| **Batch 1** — create the Google Cloud project and OAuth client | It lives inside your Google account. There is no API to create an OAuth client; the console is the only route, by Google's design. |
| **Publish the OAuth app to Production** | Same console, same reason. Skip it and Google deletes your refresh token in exactly 7 days. |
| **Register the redirect URI** | Same console. `pnpm deploy:cloudflare` prints the exact string to paste, because it is the only party that knows your deployed hostname. |
| **`wrangler login`** | An OAuth handshake with your Cloudflare account. |

Everything else in this project now runs from a command line.
