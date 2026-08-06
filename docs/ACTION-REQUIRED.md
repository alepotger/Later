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
