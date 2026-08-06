# ADR-0006 — Cheapest-first resolution, a quota ledger, and queue-don't-drop

**Status:** accepted · **Date:** 2026-08-05 · **Verified:** [verification log](../verification-log.md)

## Context

Verified unit costs, against a default of **10,000 units/day per Google Cloud project**, resetting at midnight Pacific Time:

| Operation | Units | |
|---|---|---|
| `videos.list` | 1 | |
| `playlistItems.list` | 1 | |
| `playlists.list` | 1 | |
| `playlistItems.insert` | 50 | |
| `playlists.insert` | 50 | once per account, ever |
| **`search.list`** | **100** | ← |

**One search costs as much as one hundred video lookups.** Roughly 100 searches exhausts an entire day.

The two shapes a single share can take are therefore wildly different in price:

| Path | Cost | Notes |
|---|---|---|
| YouTube URL present in the shared text | **51** | 1 to validate, 50 to insert |
| No URL — must be searched for | **151+** | 100 to search, 1 to validate, 50 to insert |

~190 URL-bearing shares/day, or ~65 search-requiring ones. For one person that is enormous headroom. For a careless implementation — searching before checking for a URL, or re-fetching metadata it already has — it is a service that dies at lunchtime.

## Decision

### 1. Cheapest-first, and short-circuit hard

The pipeline is ordered by cost and determinism, and **stops at the first confident answer**:

| Tier | Method | YouTube quota |
|---|---|---|
| 0 | Regex a YouTube URL out of the shared text | **0** |
| 1 | TikTok / Instagram oEmbed → re-run Tier 0 on the caption | **0** |
| 2 | LLM extracts candidates → one `search.list` | **100** |
| 3 | Transcript / OCR → Tier 2 (opt-in, off by default) | 100 |

Tiers 0 and 1 are free of YouTube quota entirely. **`search.list` is never called when a URL is present** — that is an invariant with a test, not an intention.

This is also why Tier 0 is the highest-value code in the repo, and why it gets exhaustive fixtures: it handles the majority of real shares at zero cost, and every case it fails to parse falls through into the 100-unit path.

### 2. A quota ledger, checked before spending and written after

Every YouTube call goes through a client that declares its cost. Before the call, the ledger is checked against the budget for the current quota-day; after, the units are recorded. Nothing calls YouTube directly — the cost declaration is the price of admission to the client, so an untracked call is a type error rather than an oversight.

The quota day is computed in **America/Los_Angeles**, because that is when Google resets it. Using UTC would give a rolling window that is wrong for most of the world by up to eight hours.

`YOUTUBE_DAILY_QUOTA_BUDGET` defaults to **9,000, not 10,000** — a deliberate ~10% margin. The reserve absorbs the calls a user makes through other tools on the same project, and any cost we've mis-modelled. Hitting our own budget produces a queued item; hitting Google's produces a hard `quotaExceeded` mid-operation, which is a worse place to be.

### 3. Exhaustion queues, never drops

On budget exhaustion or a `quotaExceeded` response, the item is **kept**, its job's `run_after` is set to the next quota reset, and the user is notified once that things are delayed. The share is not lost. §11 states this as a requirement and it is the correct behaviour anyway: the entire value proposition is "I don't have to think about this again", and a dropped share breaks it permanently.

### 4. Cache everything resolved

`video_cache`, keyed by video ID, holds title, channel, duration, and availability. Video metadata is effectively immutable, so a video is never looked up twice. The cache also means the review inbox and notifications render without spending a unit.

The cache stores **only** what the pipeline needs to make decisions and show the user what it did — IDs and short metadata strings. No thumbnails, no descriptions, no captions retained past the pipeline run, per §7.

### 5. Make it visible

Units spent today, budget, and percentage appear in the web UI and in structured logs. A deployer should be able to answer "why did it stop?" without instrumentation, and a deployer who can see 8,900/9,000 understands their problem instantly.

## Rejected

**Search first, filter later.** 100 units to answer a question a regex answers for free.

**No budget tracking, react to `quotaExceeded`.** Simpler, and it converts a predictable degradation into an unpredictable mid-operation failure with nothing recorded about how it got there. It also makes the "why did it stop?" question unanswerable.

**Multi-tenant on one project's quota without documenting it.** A shared instance divides one 10,000-unit pool among all users. Nothing stops the design from doing it, so MULTI mode makes it explicit in [ADR-0013](0013-solo-and-multi-modes.md) and the docs cover requesting an increase.

**Per-user quota via each user bringing their own API key.** Would genuinely solve MULTI-mode quota. Rejected because the OAuth client is per-project too, so this would mean each user creating their own Google Cloud project — which is SOLO mode with extra steps.

**UTC quota days.** Off by up to eight hours from Google's reset, so the budget would refill at the wrong time and the "retry tomorrow" job would fire before quota returned.

## Consequences

- Every YouTube call declares its cost. Adding a new call means stating a price, which keeps the model honest as the code grows.
- The ledger is a table with `UNIQUE(account_id, quota_date)`, incremented atomically. Cheap, auditable, survives restarts.
- Estimating cost *before* the call means transiently over-reserving when a call fails. Accepted: over-counting is safe, under-counting is not.
- Unit costs are hardcoded from verified documentation. If Google reprices, our accounting drifts — which is precisely what the 10% reserve absorbs, and the costs live in one table with a comment pointing at the verification log.
- The tiering has a real product cost: Tier 0 failing to recognise an exotic URL form turns a free operation into a 100-unit one, or a review-inbox item. Hence exhaustive fixtures.

## Revisit if

- **Google changes unit costs or the default quota.** One table to update, plus the verification log.
- **A deployer gets a quota increase approved** — then the budget is just config, which it already is.
- **Tier 2 usage turns out higher than expected**, e.g. most Reels have no link in the caption. That would argue for a per-day search cap distinct from the overall budget, so searches can't consume the whole day and starve inserts. Worth watching once there is real usage data; not worth building speculatively.
