# Verification log

Re-verification of the three load-bearing constraints, plus the platform-metadata assumptions, before any code was written.

**Date of verification: 2026-08-05.**

## A note on sources, stated plainly

The build environment for this session **cannot reach `developers.google.com`, `support.google.com`, `ai.google.dev`, `developers.facebook.com`, or `www.tiktok.com` directly** — the egress policy rejects the connection at the CONNECT layer with a 403. That is an organisation network policy, not a transient failure, and it was not worked around.

Verification therefore ran through a **web search tool that does reach those pages** and returns quoted extracts from them, corroborated against independent third-party write-ups where the quotes were ambiguous. Where a claim rests only on third-party sources rather than a quote from the primary doc, it is labelled as such below.

**Consequence for the build:** every one of these constraints is asserted by the code as a runtime behaviour, not as a comment. `invalid_grant` handling, quota accounting, and the `WL` refusal all get tests driven by the fixture client, so if any of these facts change, a test fails rather than a user silently losing their playlist. Anyone re-checking this log should confirm against the primary docs directly if they can reach them.

---

## §3.1 — Watch Later is unwritable — **CONFIRMED**

Quoted from the YouTube Data API v3 Revision History (via search extract):

> After September 12, 2016, the `contentDetails.relatedPlaylists.watchLater` property will return a value of `WL` for all channels.

> The watch history and watch later playlist IDs cannot be retrieved via the API. More specifically, requests to retrieve playlist details (`playlists.list`) or playlist items (`playlistItems.list`) for a channel's watch history or watch later playlist now return empty lists.

No later revision entry reverses this. Ten years on, it is settled behaviour, not a transitional state.

One **incidental** find worth recording, because it removes a piece of error handling we might otherwise have written: the same revision also notes that `playlistItems.insert` no longer errors on inserting a duplicate video, because the playlists that rejected duplicates are themselves no longer supported. So **YouTube will happily add the same video twice** — deduplication is entirely our responsibility and there is no server-side backstop. This makes the dedupe requirement in §11 load-bearing rather than defensive. Captured in [ADR-0004](adr/0004-watch-later-is-unreachable.md).

**Verdict: brief is correct. Design as stated — dedicated app-owned playlist, find-or-create, honest README.**

## §3.2 — 7-day refresh token expiry in Testing mode — **CONFIRMED**

Quoted from Google's OAuth 2.0 documentation (via search extract):

> If your publishing status is "Testing", and the user type setting below is "External", Google will revoke refresh tokens after 7 days.

Corroborated on all four sub-claims:

| Claim | Status | Note |
|---|---|---|
| 7-day revocation, External + Testing | confirmed | primary-doc quote above |
| Publishing to Production removes the 7-day expiry | confirmed | "Change the publishing status to 'In production' … to avoid the refresh token expiring in 7 days" |
| 100-user cap in Testing | confirmed | hard cap; the 101st user gets an error |
| Unverified + sensitive scope is still capped at 100 users in Production | confirmed | Production removes the *expiry*, not the cap or the warning screen |
| Tokens unused for six months are invalidated | confirmed | motivates the keep-alive cron |

The important nuance, which the brief already had right and which the design depends on: **Production and verified are different things.** An unverified Production app keeps its refresh tokens alive indefinitely, still shows the "unverified app" interstitial, and is still capped at 100 users. For a SOLO deployer that combination is entirely fine, and it is the recommendation. Verification is only needed to grow past 100 users or remove the warning screen.

**Verdict: brief is correct, including the operational failure mode it predicts.** This is the single most likely reason a stranger's deployment dies quietly, and it is designed for in [ADR-0005](adr/0005-token-lifecycle-and-reauth.md).

## §3.3 — Quota is small and unevenly priced — **CONFIRMED**

| Operation | Units |
|---|---|
| `videos.list` | 1 |
| `playlistItems.list` | 1 |
| `channels.list` | 1 |
| `playlists.list` | 1 |
| `playlistItems.insert` | 50 |
| `playlists.insert` | 50 |
| **`search.list`** | **100** |

Default project quota is **10,000 units/day**, per Google Cloud project (not per API key — all keys in a project share the pool), resetting at **midnight Pacific Time**.

The ratio the brief flags is real and it drives the architecture: **one search costs as much as 100 video lookups**. A Tier 0 hit — YouTube URL already present in the shared text — costs 1 unit for validation. A Tier 2 miss-and-search costs 100+, so ~100 of those per day exhausts everything. Cheapest-first is not an optimisation here, it is the difference between working and not. See [ADR-0006](adr/0006-quota-strategy.md).

**Verdict: brief is correct.**

---

## Additional verification — platform metadata (Tier 1)

Not part of §3, but checked in Phase 0 because the brief asked for an honest answer on Instagram rather than something that silently fails, and because it changes the Phase 3 design.

### TikTok oEmbed — **public and key-free.** Confirmed. Usable by any deployer with no setup.

### Instagram oEmbed — **the brief's assumption is now out of date, in our favour**

The brief says Instagram oEmbed "requires an approved app token" and asks whether that is feasible for a casual deployer. That was true from October 2020. It appears to have **changed on 15 June 2026**: Meta reversed the 2020 decision, and the oEmbed endpoints for Instagram, Facebook, and Threads can now be called **without an access token and without App Review**, for public content only. Token-based access still exists and may carry higher rate limits.

**Source confidence: medium.** This is corroborated by several independent write-ups but I could not read Meta's own documentation, which the egress policy blocks. It is recent enough that it postdates a lot of the surrounding internet.

**How the design absorbs this without betting on it:** Tier 1 treats the token as **optional**, tries tokenless first, uses a token if one is configured, and degrades to Tier 2 on any failure. So the feature works if the change is real, quietly costs nothing if it is not, and no casual deployer is ever *required* to register a Meta app. Confirming this needs one live HTTP call against a public Reel, which happens in Phase 3 — and if it turns out to be wrong, the honest documented limitation the brief asked for is what ships instead.

---

## Additional verification — platform choices

Checked because the hosting decision rests on them ([ADR-0002](adr/0002-hosting-cloudflare-workers-primary.md)).

| Fact | Status |
|---|---|
| Cloudflare Workers free: 100k requests/day | confirmed |
| Cron Triggers available on the **free** plan, 1-minute minimum interval | confirmed (3–5 triggers depending on source; we need 2) |
| D1 free: 5 GB storage, 5M rows read/day, 100k rows written/day | confirmed |
| "Deploy to Cloudflare" button parses wrangler config, **auto-provisions D1**, creates the repo in the clicker's account | confirmed — this is the reason Cloudflare wins the deploy-button requirement |
| Cloudflare Queues requires a paid plan | confirmed — hence the cron-driven job table in ADR-0007 |
| Gemini free tier covers the Flash models via REST with an API-key header; Pro models are paid-only as of 2026 | confirmed (rate-limit figures vary by source: 10 RPM, and either 250 or 1,500 requests/day) |

The Gemini rate-limit disagreement between sources does not affect the design: Tier 2 is invoked at most once per ingested item that lacks a URL, which is far below even the most conservative figure, and the LLM is optional anyway.
