# Deploying Later

Two supported targets. Both are first-class, both run the same code against the same schema, and you can move between them by copying one SQLite file.

|  | Cloudflare Workers + D1 | Docker |
|---|---|---|
| Cost | free tier, no card | your machine |
| Setup | one button, ~10 min | `docker compose up`, ~5 min |
| Public HTTPS URL | included | you arrange it |
| Cron (the retry sweep) | included, 1-minute | internal timer |
| Where your data lives | Cloudflare D1 | a named Docker volume |

**If you have no strong preference, pick Cloudflare.** The phone clients all need a public HTTPS URL, and that is the part self-hosting makes you solve yourself.

You need [Batch 1 of `docs/ACTION-REQUIRED.md`](docs/ACTION-REQUIRED.md) done first — deploying without a Google OAuth client gives you a service that starts and then refuses to do anything.

---

## Option A — Cloudflare Workers

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alepotger/Later)

The button copies this repository into *your* GitHub account, creates the D1 database declared in [`wrangler.jsonc`](wrangler.jsonc), writes the real `database_id` into your copy, and deploys. You end up owning everything; nothing routes through the author.

Then follow **[Batch 4](docs/ACTION-REQUIRED.md#batch-4--deploy)**, which has the exact click path, the two secrets you must set afterwards, and the redirect URI you have to add to your OAuth client.

### Or from the command line

```bash
pnpm install
npx wrangler login
npx wrangler d1 create later-db          # copy the database_id it prints into wrangler.jsonc

npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put INGEST_TOKEN     # SOLO only; MULTI mints per-account tokens
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put SESSION_SECRET

pnpm run deploy                          # applies migrations, then deploys
```

`pnpm run deploy` runs `wrangler d1 migrations apply later-db --remote` before `wrangler deploy`, in that order deliberately: a Worker live against a database missing a column fails every request, while a database ahead of the code is harmless.

Afterwards, set `PUBLIC_BASE_URL` to the deployed origin — it is used to build the OAuth redirect URI, and Google requires a byte-exact match:

```bash
npx wrangler deploy --var PUBLIC_BASE_URL:https://later.<your-subdomain>.workers.dev
```

or add it to the `vars` block in `wrangler.jsonc` and redeploy.

### What the free tier gives you

100,000 requests/day, 5 million D1 row reads/day, 100,000 D1 writes/day, and cron triggers at one-minute granularity. Later's own YouTube quota (10,000 units/day) runs out long before any of those. See [ADR-0002](docs/adr/0002-hosting-cloudflare-workers-primary.md).

---

## Option B — Docker

```bash
git clone https://github.com/alepotger/Later.git && cd Later
cp .env.example .env      # fill in the five required values — see SETUP.md Step 2
docker compose up -d --build
```

Open **http://localhost:8787**.

Requires Docker Compose v2.24 or newer. Want to look around first, with no credentials and nothing reaching Google?

```bash
docker compose --profile demo up --build
```

That runs the fixtures build on a `tmpfs`, so it cannot be confused with your real data and disappears when you stop it.

| | |
|---|---|
| Logs | `docker compose logs -f later` |
| Restart after an `.env` change | `docker compose up -d` |
| Upgrade | `git pull && docker compose up -d --build` |
| Back up | `docker run --rm -v later_later-data:/data -v "$PWD:/out" alpine cp /data/later.db /out/` |
| Delete everything | `docker compose down -v` |

Your database is a named volume (`later_later-data`), not a bind mount. That is deliberate: SQLite in WAL mode on a bind-mounted host directory is a reliable source of locking failures on macOS and Windows.

### Giving it a public URL

The container listens on `8787` and does not terminate TLS. Put it behind something that does — Caddy, nginx, Traefik, or a Cloudflare Tunnel — and set `PUBLIC_BASE_URL` to the external HTTPS origin. Later warns at startup if `PUBLIC_BASE_URL` is `http` on a non-loopback host, because OAuth tokens and ingest secrets would be travelling in the clear.

For a quick test without any of that:

```bash
cloudflared tunnel --url http://localhost:8787
```

### Running it without Docker

```bash
pnpm install --prod=false
pnpm run build
DATABASE_PATH=./data/later.db node dist/later.js
```

Node 22 or newer. The bundle is a single file plus `drizzle/` (read at boot by the migrator) and `node_modules` (for the native SQLite driver).

---

## Choosing SOLO or MULTI

`LATER_MODE=SOLO` is the default and what you want unless several people share the instance.

```dotenv
LATER_MODE=MULTI
LATER_ALLOWED_EMAILS=you@example.com,partner@example.com
```

In MULTI, each person authorises their own Google account, writes to their own playlist, and gets their own ingest token from the web UI after connecting. `INGEST_TOKEN` is ignored.

**The one thing MULTI cannot fix:** everyone on the instance shares one 10,000-unit daily YouTube quota, because the allowance belongs to the Google Cloud project rather than the user. Four people means roughly 45 link-bearing shares each per day. If that is not enough, the honest answers are a [quota increase](TROUBLESHOOTING.md#running-out-of-quota) or one deployment per person — not a change to Later. [ADR-0013](docs/adr/0013-solo-and-multi-modes.md).

---

## After deploying, in this order

1. **Add the redirect URI to your OAuth client.** `https://<your-origin>/auth/callback`, exactly, no trailing slash. Google matches byte-for-byte.
2. **Set `PUBLIC_BASE_URL`** to the same origin, and redeploy.
3. **Authorise immediately.** On a fresh SOLO deployment, whoever reaches `/auth/start` first claims the instance — every later attempt is refused, which is the protection, but the first one is open by necessity. Do it before you share the URL.
4. **Publish your OAuth app to Production** if you have not. In Testing, Google revokes your refresh token after exactly 7 days. [SETUP.md](SETUP.md#the-one-decision-that-will-bite-you-later).
5. **Set up a notification channel** — otherwise the message telling you authorisation expired is only visible on a web page you have no reason to open. [SETUP.md Step 6](SETUP.md#step-6--get-told-when-something-needs-you).
6. **Then set up the phone clients.** [clients/](clients/) — they need the public URL you now have.

Something not working? [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
