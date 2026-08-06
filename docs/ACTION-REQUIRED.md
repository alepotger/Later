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
