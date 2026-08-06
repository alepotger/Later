# Later — build plan

Living document. Updated at every phase boundary and whenever a decision changes.

**Current state: Phase 1 code-complete. The product works — a shared YouTube link lands in the playlist. 296 tests, all green, none needing credentials.**

The one thing not yet verified against reality is the live Google OAuth round-trip, which needs [Batch 1](docs/ACTION-REQUIRED.md) of the console work. Everything either side of it is tested against the fixture client, including `invalid_grant` and quota exhaustion.

---

## The one sentence this project is measured against

> A person is scrolling Instagram Reels or TikTok, sees a video that recommends a YouTube video, taps Share → Later, and the recommended YouTube video appears in their YouTube playlist. No further interaction. Under three taps.

And the half that is equally load-bearing: **it must work for anyone who forks or deploys this repo**, not just the author.

---

## Architecture in one screen

```
                     ┌─────────────────────────────────────────┐
   iOS Shortcut ────► │  POST /api/ingest                       │
   PWA share target ► │  bearer auth · rate limit · idempotent  │ ──► 202 Accepted
   Telegram bot ────► │  writes one `items` row, enqueues job   │     (milliseconds)
   Web paste box ───► └─────────────────────────────────────────┘
                                        │
                       ┌────────────────┴─────────────────┐
                       │  inline via waitUntil (fast path) │
                       │  cron sweep (retry / quota queue) │
                       └────────────────┬─────────────────┘
                                        ▼
                          ┌──────────────────────────┐
                          │  resolution pipeline     │  pure functions, no I/O in core
                          │  Tier 0 → 1 → 2 → 3      │  stops at first confident answer
                          └────────────┬─────────────┘
                                       ▼
                          ┌──────────────────────────┐
                          │  quota ledger gate       │  refuses to spend past budget
                          └────────────┬─────────────┘
                                       ▼
                          ┌──────────────────────────┐
                          │  YouTube client          │  real | fixture (no creds needed)
                          │  find-or-create playlist │
                          │  videos.list → validate  │
                          │  playlistItems.insert    │
                          └────────────┬─────────────┘
                                       ▼
                             notify (Telegram / web)
```

### Layering rule

The core is **pure TypeScript with no runtime coupling** — no Node APIs, no Cloudflare APIs, no network. URL extraction, normalisation, candidate ranking, confidence scoring, and quota accounting are all pure functions over plain data. Everything that touches the world (HTTP, DB, clock, crypto, YouTube, LLM) is an interface implemented per runtime and per test.

This is what makes §9's mandate achievable: **every layer is developable and testable with zero real credentials.** A fixture YouTube client and a seeded DB let the whole pipeline run offline, and that is the default in tests and in `dev` mode.

It is a pipeline, not an agent framework. Deliberately. ([ADR-0007](docs/adr/0007-async-work-cron-driven-jobs.md))

---

## Decisions

Every significant choice is an ADR in [`docs/adr/`](docs/adr/), each recording what was chosen, what was rejected, why, and what would make me revisit it.

| ADR | Decision |
|---|---|
| [0001](docs/adr/0001-typescript-hono-web-standard-runtime.md) | TypeScript on Web-standard APIs, Hono as the HTTP layer |
| [0002](docs/adr/0002-hosting-cloudflare-workers-primary.md) | Cloudflare Workers + D1 primary; Node container for self-host |
| [0003](docs/adr/0003-sqlite-dialect-everywhere-drizzle.md) | SQLite dialect everywhere (D1 + local file), Drizzle ORM |
| [0004](docs/adr/0004-watch-later-is-unreachable.md) | Watch Later is unreachable; app-owned playlist instead |
| [0005](docs/adr/0005-token-lifecycle-and-reauth.md) | Token lifecycle, `invalid_grant`, keep-alive, re-auth |
| [0006](docs/adr/0006-quota-strategy.md) | Cheapest-first pipeline, quota ledger, queue-and-retry |
| [0007](docs/adr/0007-async-work-cron-driven-jobs.md) | Cron-driven job table, no external queue |
| [0008](docs/adr/0008-ingest-authentication.md) | Bearer token ingest auth (not HMAC) + rate limiting |
| [0009](docs/adr/0009-llm-provider-and-the-gemini-question.md) | Gemini default behind an interface, always optional |
| [0010](docs/adr/0010-notifications-telegram-primary.md) | Telegram as primary notification channel |
| [0011](docs/adr/0011-frontend-server-rendered-no-framework.md) | Server-rendered HTML templates, no client framework |
| [0012](docs/adr/0012-tooling-pnpm-vitest-biome.md) | pnpm, Vitest, Biome, gitleaks, GitHub Actions |
| [0013](docs/adr/0013-solo-and-multi-modes.md) | SOLO default, MULTI opt-in |

---

## Phases

Sizing is in **work units** — one unit is roughly a coherent, independently reviewable, committable chunk. It is a measure of scope, not wall-clock time.

### Phase 0 — Orient ✅ *complete (~6 units)*

- [x] Re-verify §3.1 / §3.2 / §3.3 against live sources → [`docs/verification-log.md`](docs/verification-log.md)
- [x] 13 ADRs covering stack, DB, host, LLM, ingress, auth, async, notifications, modes
- [x] `PLAN.md`, `README.md` rewritten with the Watch Later limitation above the fold
- [x] `docs/ACTION-REQUIRED.md` — Batch 1, everything Phase 1 needs, one sitting
- [x] `.env.example` with the full documented config surface
- [x] `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `TROUBLESHOOTING.md`

**Deliberately deferred:** `SETUP.md` waits for Phase 1. Writing click-by-click setup instructions for a flow that does not exist yet would be fiction, and it would be wrong by the time it mattered. `TROUBLESHOOTING.md` exists now because the §3 failure modes are already verified and independent of the code.

### Phase 1 — The spine ✅ *code-complete (~14 units)*

**The product works**: paste a TikTok caption containing a YouTube URL and the video is in the playlist, deduplicated, with quota accounted for.

| # | Work | Blocked on console? |
|---|---|---|
| ✅ 1.1 | Project scaffold: pnpm, TS strict, Biome, Vitest, Hono, Drizzle, wrangler config | no |
| ✅ 1.2 | **Tier 0 URL extractor + exhaustive fixture suite** — the highest-value code in the repo | no |
| ✅ 1.3 | Schema + migrations: `accounts`, `items`, `jobs`, `quota_ledger`, `video_cache`, `rate_limits` | no |
| ✅ 1.4 | Ports & adapters: `Clock`, `KeyValue`, `Db`, `YouTubePort`, `LlmPort`, `Notifier` | no |
| ✅ 1.5 | **Fixture YouTube client** — recorded responses, quota accounting, injectable failures (`invalid_grant`, `quotaExceeded`, private/deleted video) | no |
| ✅ 1.6 | Token vault: AES-GCM encryption at rest via WebCrypto, rotation-aware | no |
| ⚠️ 1.7 | OAuth flow: `/auth/start`, `/auth/callback`, PKCE, state, refresh, `invalid_grant` → `reauth_required` | **yes — Batch 1** |
| ✅ 1.8 | Playlist resolver: find-or-create, cache the ID, never assume it exists | yes (real run only) |
| ✅ 1.9 | `POST /api/ingest`: bearer auth, rate limit, idempotency key, 202, `waitUntil` dispatch | no |
| ✅ 1.10 | Pipeline runner + quota gate + dedupe (both DB-side and playlist-side) | no |
| ✅ 1.11 | Web paste box + result view (also the debugging tool) | no |
| ✅ 1.12 | Structured logging with request IDs | no |
| ✅ 1.13 | CI: lint, typecheck, test, gitleaks secret scan | no |
| ✅ 1.14 | `SETUP.md` for the local/SOLO path, written and then read as a stranger | no |

Only **1.7** needed the console, and it is written and unit-tested against a stubbed Google token endpoint — every branch including `invalid_grant`, token rotation, and transient failure. What it has not done is complete one real round-trip with Google, which is the ⚠️ above and is waiting on [Batch 1](docs/ACTION-REQUIRED.md).

**What was verified, and how:**

- 296 tests, zero credentials, zero network. The fixture client is the only YouTube implementation wired into the test container.
- The real server was booted and driven over HTTP end to end: connect, share, re-share, dedupe, quota meter, PWA share target, structured logs.
- The Worker entry bundles for `workerd` via `wrangler deploy --dry-run`, which is the check that keeps ADR-0001's two-target promise honest — it fails if a `node:` API leaks into shared code.

**Two bugs the tests found, both worth recording:**

1. `RETURNING *` in the raw job-claim SQL returned snake_case columns, so `job.itemId` was always undefined and every job failed as malformed. Columns are now explicitly aliased.
2. The ingest rate-limit bucket was keyed on the *presented* token, so an attacker rotating tokens got a fresh allowance per guess — defeating the control entirely. It is now a single bucket, evaluated before authentication.

**And one found by following `SETUP.md` literally**, which is exactly why that is worth doing: re-pasting an identical link reported "1 saved" a second time. Accurate (the video *is* saved) and misleading (it reads as a fresh save). Now distinguishes "Already shared" from "already in the playlist" from "saved".

### Phase 2 — Ingress *(~9 units)*

iOS Shortcut (shipped file + setup guide) · PWA manifest `share_target` · Telegram bot as both ingress and notification channel · notification dispatch · the one-tap re-auth link that makes ADR-0005 real.

Needs **Batch 2** (BotFather, iOS import — both physical-device steps).

### Phase 3 — Intelligence *(~10 units)*

Tier 1 oEmbed (TikTok + Instagram, both tokenless — see verification log) · shortlink resolution · Tier 2 LLM candidate extraction · single `search.list` with title/channel similarity ranking · confidence scoring and threshold · review inbox.

Needs **Batch 3** (Gemini API key) — but Tier 1 and the whole confidence/review path are buildable and testable without it.

### Phase 4 — Public-ready *(~10 units)*

MULTI mode · Deploy to Cloudflare button · `docker compose up` from clean checkout · the 15-minute stranger test, run for real and fixed · quota-increase docs · deep link to the playlist.

Needs **Batch 4** (Cloudflare account, production redirect URI, publishing status decision).

---

## Console batches

Per §9, human-in-a-browser work is batched so the owner does a few short sittings rather than eleven interruptions. Full instructions in [`docs/ACTION-REQUIRED.md`](docs/ACTION-REQUIRED.md).

| Batch | Needed before | Contents | Est. |
|---|---|---|---|
| **1** | Phase 1 finishes (1.7) | Google Cloud project · enable YouTube Data API v3 · OAuth consent screen · OAuth client + localhost redirect URI · generate local secrets | ~15 min |
| 2 | Phase 2 | Telegram bot via BotFather · import iOS Shortcut on a phone | ~10 min |
| 3 | Phase 3 | Gemini API key (same project) | ~3 min |
| 4 | Phase 4 | Cloudflare account · deploy · add production redirect URI · Testing→Production decision | ~15 min |

Batch 1 is written and waiting. Batches 2–4 are drafted at the end of `ACTION-REQUIRED.md` so the shape is visible in advance, and will be finalised with exact resolved values when their phase arrives — a production redirect URI cannot be written down before the deployment exists, and §9 forbids guessing it.

---

## Anti-goals — deliberately not built

Recorded here because "we already decided not to" is the cheapest answer to a recurring suggestion, and because every one of these would make Later harder for a stranger to deploy.

- A native app-store app. The PWA and the iOS Shortcut cover it.
- Passwords or user accounts of any kind beyond Google OAuth.
- Any scraping that violates a platform's terms — in any form, for any reason. ([ADR-0004](docs/adr/0004-watch-later-is-unreachable.md))
- An "AI agent framework" abstraction. This is a pipeline; the LLM is one function inside it. ([ADR-0009](docs/adr/0009-llm-provider-and-the-gemini-question.md))
- Analytics dashboards, engagement metrics, streaks, gamification.
- Telemetry of any kind. Not opt-out — absent. ([SECURITY.md](SECURITY.md))
- Monetisation, billing, tiers.
- Platforms beyond Instagram, TikTok, and YouTube in v1.
- Speculative generality. Build what the one sentence at the top describes, build it properly, stop.

## Definition of done

Tracked against §11 of the brief. Nothing here is checked until it has actually been observed working.

- [ ] Stranger goes fork → first saved video in under 15 minutes
- [ ] TikTok containing a YouTube link, shared from a phone, lands in the playlist — ≤3 taps, no waiting
- [ ] Reel whose caption *describes* a video resolves, or is honestly held for review
- [x] Duplicates never double-add — enforced by `UNIQUE(account_id, video_id)`, tested at both layers
- [x] Token expiry produces a notification and a working one-tap re-auth — not silence *(verified against a stubbed token endpoint; the live round-trip awaits Batch 1)*
- [x] Quota exhaustion queues and retries — never drops, and does not consume a retry attempt
- [x] README states the Watch Later limitation plainly, above the fold
- [ ] `docker compose up` works from a clean checkout with only `.env` filled in
- [x] Zero secrets in git history
- [ ] CI green
- [x] `ACTION-REQUIRED.md` complete and ordered for the current phase, with nothing guessed
