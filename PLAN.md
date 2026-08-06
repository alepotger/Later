# Later — build plan

Living document. Updated at every phase boundary and whenever a decision changes.

**Current state: Phase 4 code-complete. Every phase in the plan is built. 494 tests, all green, none needing credentials.**

Four things are written and tested but not yet verified against reality, all for the same reason — this build environment has no credentials, no phone, no Docker daemon, and no route to `api.telegram.org`:

| | Needs |
|---|---|
| The live Google OAuth round-trip | Batch 1 (done) + one local run by the owner |
| Telegram ingress and notifications | Batch 2, and a public HTTPS URL |
| iOS Shortcut / Android PWA | Batch 2, and a physical phone |
| The Docker image build | a Docker daemon — CI now builds it, starts it, and shares a video through it |

**A sequencing correction:** the phone clients cannot reach `localhost`, and Telegram *pushes* to a webhook, so **Batch 4 (deploy) should be done before Batch 2**, inverting the phase numbering. This is stated at the top of Batch 2 rather than left to be discovered.

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

### Phase 2 — Ingress ✅ *code-complete (~9 units)*

| # | Work | Verified how |
|---|---|---|
| ✅ 2.1 | Notification rendering, kept pure so the wording is testable | 31 unit tests, incl. the exact `reauth_required` text |
| ✅ 2.2 | Telegram notifier + Bot API client | stubbed `fetch`; `api.telegram.org` is unreachable from here |
| ✅ 2.3 | Telegram ingress webhook — secret token + chat allowlist | 18 end-to-end tests through the real router |
| ✅ 2.4 | Generic webhook notifier (ntfy/Discord/Slack/anything) | unit tests incl. a failing endpoint |
| ✅ 2.5 | Fan-out across channels, isolated failures | one broken channel cannot silence the others |
| ✅ 2.6 | PWA installability: real 192/512 PNG icons, maskable variant | generated, pixel-verified, served and checked over HTTP |
| ✅ 2.7 | iOS Shortcut: generated `.plist` + manual recipe | plist re-parses; **never run on a device** |
| ✅ 2.8 | Client docs for iOS, Android, Telegram | written, with the failure modes for each |
| ✅ 2.9 | Batch 2 handoff | in `ACTION-REQUIRED.md`, with the deploy-first correction |

**Two honest limitations, not deferrals:**

- **The iOS `.plist` has never been imported on a real iPhone.** The manual five-action recipe is the recommended route and needs no settings changes. Apple only allows frictionless import from an *iCloud link*, and only a person holding a device can create one — so that particular artefact cannot be generated by anyone but the owner.
- **Nothing here has talked to real Telegram.** The adapter is covered by stubs at the network boundary; `api.telegram.org` is blocked by this environment's egress policy.

### Phase 3 — Intelligence ✅ *code-complete (~10 units)*

| # | Work | Verified how |
|---|---|---|
| ✅ 3.1 | Tier 1: TikTok + Instagram oEmbed, tokenless, plus shortlink resolution | fixture port; 5 end-to-end tests |
| ✅ 3.2 | Similarity and ranking, pure | 24 unit tests incl. diacritics and non-Latin scripts |
| ✅ 3.3 | Tier 2: LLM candidate extraction behind `LlmPort` | Gemini + OpenAI-compatible + fixture + none |
| ✅ 3.4 | Response parsing as an untrusted boundary | 22 tests: fences, prose, wrong types, hostile input |
| ✅ 3.5 | Confidence gate and the review inbox | 22 end-to-end tests |
| ✅ 3.6 | Batch 3 handoff | in `ACTION-REQUIRED.md`, marked optional |

**The invariant the whole phase is built around: the LLM never picks the video.** It produces
candidate *descriptions*; the ID always comes from `search.list`; the ranker decides whether the
two agree. A hallucinated ID is structurally unable to reach a playlist, and there is a test
that feeds a model a video ID in the title field and asserts nothing is added.

Three guards on top of the threshold, each with a test:
- a strong overall score built on a weak *title* match goes to review — the classic
  wrong-video-right-channel failure
- a near-tie between the top two results goes to review, because the description did not
  actually distinguish them
- confirming from the review inbox re-runs the **normal pipeline** rather than adding directly,
  so the dedupe claim and the quota gate still apply

### Phase 4 — Public-ready ✅ *code-complete (~10 units)*

| # | Work | Verified how |
|---|---|---|
| ✅ 4.1 | MULTI: ingest auth resolves an account instead of comparing one value | 17 end-to-end tests, incl. cross-account isolation |
| ✅ 4.2 | Per-account ingest tokens — minted in the UI, stored only as a SHA-256 hash | minted over real HTTP, used, and confirmed unreadable afterwards |
| ✅ 4.3 | Stateless signed web sessions and Telegram link codes | 18 unit tests, all about the ways verification must say no |
| ✅ 4.4 | `Dockerfile` + `docker-compose.yml`, with a credential-free demo profile | the runtime layout was reproduced and run locally; the **image build is CI-only** |
| ✅ 4.5 | "Deploy to Cloudflare" button and [DEPLOY.md](DEPLOY.md) covering both targets | button URL and `wrangler.jsonc` resource declaration; **never clicked** |
| ✅ 4.6 | Batch 4 handoff, with a recommendation at each decision | in `ACTION-REQUIRED.md` |
| ✅ 4.7 | Quota-increase instructions, with honest expectations | in `TROUBLESHOOTING.md` |
| ✅ 4.8 | The 15-minute stranger test, run against a clean clone | run; findings below |
| ✅ 4.9 | Docs pass across README, SETUP, SECURITY, TROUBLESHOOTING, `.env.example` | — |

**The design claim MULTI was built to test held.** ADR-0013 predicted the mode would be "a change to the token check alone". It was: `authenticateIngest` in `src/http/accounts.ts`. The pipeline, the job queue and the quota ledger were not touched, because every row already carried an `account_id` from the first migration.

**Two decisions worth naming:**

- **Tokens are stored as a SHA-256 hash and shown once.** A leaked database cannot be used to post shares. The cost is that losing a token has exactly one remedy — mint a new one.
- **Sessions and link codes are stateless HMACs, not a table.** A session table would cost a query per page load, a sweep job, and a migration, to protect a UI whose worst-case compromise is what an ingest token already grants. The purpose is signed into each message, so a 15-minute link code cannot be replayed as a 30-day cookie — there is a test for exactly that.

**One bug this phase's tests caught:** the Telegram permit check was written as two negations and inverted, so in MULTI a correctly *linked* chat was rejected while an unlinked one got through. It was caught by the test asserting a linked chat can share, not by reading the code.

**Two things this phase deliberately did not do:** neither the Docker image nor the deploy button has been exercised in this environment — there is no Docker daemon and no Cloudflare account. Rather than claim otherwise, CI now builds the image, starts the container, and pushes a share through it on every commit, and the deploy button is Batch 4's first step.

---

## Console batches

Per §9, human-in-a-browser work is batched so the owner does a few short sittings rather than eleven interruptions. Full instructions in [`docs/ACTION-REQUIRED.md`](docs/ACTION-REQUIRED.md).

| Batch | Needed before | Contents | Est. |
|---|---|---|---|
| **1** | Phase 1 finishes (1.7) | Google Cloud project · enable YouTube Data API v3 · OAuth consent screen · OAuth client + localhost redirect URI · generate local secrets | ~15 min |
| 2 | Phase 2 | Telegram bot via BotFather · import iOS Shortcut on a phone | ~10 min |
| 3 | Phase 3 | Gemini API key (same project) | ~3 min |
| **4** | **now — before Batch 2** | Cloudflare account · deploy · add production redirect URI · SOLO/MULTI decision · Testing→Production decision | ~15 min |

**All four batches are now written out in full** in `ACTION-REQUIRED.md`, in the order they should be done. Batch 1 is complete. Batch 4 should come next, before Batch 2: the phone clients and the Telegram webhook all need a public HTTPS URL, and `localhost` is not one.

One value still cannot honestly be written down — your deployed origin does not exist until you deploy. Batch 4 is structured so you observe it at step A2 and carry it into A3, A4 and A5, rather than my guessing a hostname. §9 forbids the guess.

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

- [x] Stranger goes fork → first saved video in under 15 minutes *(run against a clean clone in fixtures mode: clone → install → run → connect → share → dedupe, ~4 minutes. The Google-credential half of the path still depends on Batch 1, which is the owner's to run.)*
- [ ] TikTok containing a YouTube link, shared from a phone, lands in the playlist — ≤3 taps, no waiting *(clients built; needs a deploy and a phone to observe)*
- [x] Reel whose caption *describes* a video resolves, or is honestly held for review *(against fixture providers; a live model needs Batch 3)*
- [x] Duplicates never double-add — enforced by `UNIQUE(account_id, video_id)`, tested at both layers
- [x] Token expiry produces a notification and a working one-tap re-auth — not silence *(verified against a stubbed token endpoint; the live round-trip awaits Batch 1)*
- [x] Quota exhaustion queues and retries — never drops, and does not consume a retry attempt
- [x] README states the Watch Later limitation plainly, above the fold
- [x] `docker compose up` works from a clean checkout with only `.env` filled in *(the image build itself is verified by CI, not by me — this environment has no Docker daemon. The exact runtime layout the image ships, production-only `node_modules` plus the bundle plus `drizzle/`, was reproduced and run locally end to end.)*
- [x] Zero secrets in git history
- [x] CI green — lint, typecheck, 494 tests, migration-drift check, both deploy targets bundled, the Docker image built and driven, full-history secret scan
- [x] `ACTION-REQUIRED.md` complete and ordered for the current phase, with nothing guessed
