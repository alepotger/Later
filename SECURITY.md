# Security

Later is self-hosted software that holds an OAuth token allowing it to modify your YouTube account. That deserves a straight account of what it protects, what it doesn't, and where the sharp edges are.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository (Security → Report a vulnerability). Please don't open a public issue for anything exploitable.

Include what you did, what happened, and what you expected. A rough proof of concept helps more than a careful writeup.

This is a personal open-source project with no security team and no bounty. Expect a best-effort response within a week or so.

## What Later holds

| Data | Sensitivity | Where |
|---|---|---|
| Google **refresh token** | **high** — grants ongoing write access to your YouTube account | encrypted at rest |
| Google access token | medium — short-lived | encrypted at rest |
| `INGEST_TOKEN` | high — lets anyone add to your playlist | your `.env` / host secret store, and each client |
| `TOKEN_ENCRYPTION_KEY` | **critical** — decrypts the above | your `.env` / host secret store, never the database |
| Shared URLs and captions | low–medium — reveals what you're watching | plaintext in your database |
| Resolved video IDs, titles, channels | low | plaintext, cached |

**Later stores the minimum it needs.** Video IDs, short metadata strings, item status. It does not retain third-party video content, thumbnails, descriptions, or transcripts beyond the pipeline run that needed them.

## Encryption at rest

Refresh and access tokens are encrypted with **AES-256-GCM** via WebCrypto — the same code path on every runtime, no dependency. Each record gets a fresh random 96-bit IV, and GCM's authentication tag means tampering is detected rather than silently decrypted into something else.

The key comes from `TOKEN_ENCRYPTION_KEY` (32 bytes, base64) and **is never written to the database**. An attacker who exfiltrates the database — a leaked D1 export, a stolen volume, a careless backup — gets ciphertext.

### Key management, plainly

- **Generate it yourself:** `openssl rand -base64 32`. Nothing in this repo generates, defaults, or ships a key. There is no fallback value to forget to change.
- **Losing it** makes every stored token undecryptable. Everyone re-authorises. Recoverable, annoying.
- **Rotating it** has the same effect — there is deliberately no re-encryption migration, because a rotation path is more code and more risk than one re-auth.
- **Back it up** wherever you keep passwords. On a hosted deployment it lives in the platform's secret store (`wrangler secret put`), not in a file.

## Ingest endpoint

`POST /api/ingest` is authenticated with a bearer token, compared in constant time, rate limited per token, and never logged. The reasoning — including why HMAC signing is available but not the default — is in [ADR-0008](docs/adr/0008-ingest-authentication.md).

The threat this addresses is real and mundane: **URLs leak** — into logs, screenshots, browser history, a Shortcut shared with a friend. An unauthenticated ingest endpoint is an invitation to fill a stranger's playlist.

The blast radius of a stolen `INGEST_TOKEN` is bounded to *adding videos to one playlist*. It cannot read your YouTube data, cannot touch your Google account, and cannot reach anything else in your deployment. That bounding is deliberate.

**Rotating it:** change `INGEST_TOKEN`, restart, then update each client (iOS Shortcut, PWA, Telegram config). There's no automatic distribution — with a handful of clients, doing it by hand is the honest answer.

## OAuth scope

Later requests exactly one scope:

```
https://www.googleapis.com/auth/youtube
```

This is the narrowest scope that can write to a playlist. Later does **not** request `youtube.force-ssl`, `youtubepartner`, `youtube.upload`, or any Drive, Gmail, or profile scope.

**You can revoke it at any time**, without Later's cooperation, at [myaccount.google.com/permissions](https://myaccount.google.com/permissions). Later will detect the revocation within a day via its keep-alive check, mark the account `reauth_required`, and stop.

## No telemetry

There is none. Not opt-out, not anonymised, not "just crash reports" — absent.

Nothing about your usage leaves your deployment except:

- API calls to Google (YouTube, OAuth, and Gemini if you configure it)
- oEmbed calls to TikTok/Instagram, if Tier 1 is on
- Telegram, if you configure the bot — meaning Telegram sees the links you forward
- Your own `NOTIFY_WEBHOOK_URL`, if you set one

Every third party in that list is one you chose, and all but Google are optional. If you want usage insight, the database is right there.

## Platform terms of service

Later uses official, documented, public APIs only: YouTube Data API v3, TikTok and Instagram oEmbed, Telegram Bot API.

It does **not** scrape, replay cookies, drive headless browsers, rotate proxies, or call unofficial endpoints. This is a security property, not just a legal one: a repo that encourages ToS violations exposes everyone who deploys it, and cookie-replay designs require handing a self-hosted service long-lived session credentials — far worse than a revocable scoped token.

Where a platform doesn't permit something, Later ships a documented limitation. The clearest example is [Watch Later itself](docs/adr/0004-watch-later-is-unreachable.md).

## Known limitations, stated rather than buried

These are accepted trade-offs, not oversights:

- **Shared URLs and captions are stored in plaintext.** Only the tokens are encrypted. Someone with database access learns what you've been sharing. Encrypting content too would break search and dedupe for little gain against the realistic threat.
- **The bearer token sits in plaintext on your phone**, inside the Shortcut. As safe as your phone.
- **`reauth_required` is a denial-of-service on yourself if you miss the notification.** Mitigated by notifying, by the persistent web banner, and by keeping every pending item so nothing is lost when you fix it.
- **MULTI mode users share one API quota.** One user can exhaust the day for everyone. Inherent to Google's per-project quota; surfaced in the UI. See [ADR-0013](docs/adr/0013-solo-and-multi-modes.md).
- **`.env` on disk is as protected as the machine it's on.** For hosted deployments, use the platform secret store instead.
- **A fresh deployment is claimable until you authorise it.** In SOLO mode the first successful OAuth claims the instance and every later attempt is refused — but that first one has to be open, or you could not complete setup. The window is between deploy and your own authorisation. On a new deployment, authorise before sharing the URL. There is no way to close this without a second credential, which would mean inventing an account system that §12 rules out.

## Secret hygiene in this repository

- `.env` and friends are gitignored; only `.env.example`, which contains no values, is committed.
- CI runs **gitleaks over the full git history** on every push — not just the diff, because "no secrets in history" can't be shown by a diff scan.
- No key, token, or password is ever defaulted, generated, or committed by this project. Anything that looks like a credential in this repo is a placeholder or an example, and none of them work.
