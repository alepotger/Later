# ADR-0003 — SQLite dialect everywhere, Drizzle ORM

**Status:** accepted · **Date:** 2026-08-05

## Context

[ADR-0002](0002-hosting-cloudflare-workers-primary.md) commits to two deployment targets. That normally means two database configurations, which normally means two sets of migrations, two sets of SQL quirks, and a self-host path that quietly breaks because nobody runs it.

The data itself is tiny and boring: a handful of accounts, one row per shared item, a job queue, a quota ledger, and a video metadata cache. Relational, because dedupe and queue semantics want `UNIQUE` constraints and transactions. But small — one person's realistic usage is a few thousand rows a year.

## Decision

**One SQL dialect — SQLite — across every target, with [Drizzle ORM](https://orm.drizzle.team) as the query builder and migration tool.**

| Target | Driver |
|---|---|
| Cloudflare Workers | D1 (`drizzle-orm/d1`) |
| Node container / local dev | local SQLite file (`drizzle-orm/better-sqlite3`) |
| Tests | in-memory SQLite, migrated fresh per suite |

D1 *is* SQLite. That is the whole insight this decision rests on: choosing SQLite as the dialect means the Cloudflare target and the self-host target share **one schema definition, one set of generated migrations, and one set of queries**, differing only in which driver object is handed to Drizzle at startup. The self-host path is not a port; it is the same SQL against a different file handle.

Drizzle over the alternatives because its schema is plain TypeScript (so the types are derived, not duplicated), it generates SQL migration files that can be read and reviewed, it has first-class D1 support, and it adds no runtime beyond a query builder — which matters given ADR-0001's Web-standard constraint.

Planned tables, all with an explicit `UNIQUE` where correctness depends on it:

| Table | Purpose | Key constraint |
|---|---|---|
| `accounts` | one row per authorised Google account; encrypted tokens, playlist ID, status | `UNIQUE(google_user_id)` |
| `items` | one row per ingested share; source text, resolved video, status, confidence | `UNIQUE(account_id, idempotency_key)` |
| `playlist_entries` | what we have actually added | `UNIQUE(account_id, video_id)` ← the dedupe backstop |
| `jobs` | work to do, with attempt count and `run_after` | index on `(status, run_after)` |
| `quota_ledger` | units spent per account per quota-day | `UNIQUE(account_id, quota_date)` |
| `video_cache` | resolved video metadata, so nothing is fetched twice | `UNIQUE(video_id)` |
| `rate_limits` | fixed-window counters for ingest | `UNIQUE(bucket, window_start)` |

`playlist_entries` with its `UNIQUE(account_id, video_id)` is the reason duplicates can never double-add. Per the [verification log](../verification-log.md), YouTube itself stopped rejecting duplicate inserts in 2016, so there is **no server-side backstop** — this constraint is the only thing standing between a user and a playlist with the same video in it four times.

## Rejected

**Postgres** (Neon / Supabase / Vercel). The instinct for "a real database", and genuinely better at concurrency, migrations at scale, and rich types. Rejected because it forces the deployer to provision a database as a separate console step on *every* deployment path, which is the exact cost ADR-0002 was chosen to avoid — and because nothing in this workload needs anything Postgres has and SQLite doesn't. Choosing it would mean paying a permanent onboarding tax for capability we would never use.

**Cloudflare KV.** Free, simple, and already there. Rejected because dedupe wants a unique constraint and the job queue wants atomic claim semantics. Building either on eventually-consistent key-value storage means writing a correctness-critical layer by hand, badly. KV may still be used for genuinely ephemeral caching later, which needs no ADR.

**Durable Objects.** The idiomatic Cloudflare answer for per-user coordination, and would be elegant for the job queue. Rejected because it has no counterpart on the self-host path, so adopting it would fork the architecture — the precise outcome this ADR exists to prevent.

**Prisma.** Better-known, nicer studio tooling. Rejected on the Workers story (heavier, historically awkward at the edge) and because the schema lives in a bespoke DSL rather than TypeScript.

**Raw SQL with a hand-rolled migration runner.** Genuinely tempting at this size, and would have zero ORM dependency. Rejected because the type derivation Drizzle gives is worth more than the dependency costs, and because a hand-rolled migration runner is a thing every project regrets writing.

## Consequences

Good:

- One schema, one migration set, two targets. The self-host path cannot silently diverge, because there is nothing to diverge.
- Tests run against real SQLite in memory, not a mock or a stub. The queries under test are the queries that ship.
- `docker compose` is one service and one volume — no database container at all, which is why the compose file will be about fifteen lines.

Bad, and accepted:

- **SQLite's type system is loose.** Timestamps are stored as integer epoch milliseconds and booleans as integers, by convention, enforced by the Drizzle schema rather than by the database.
- **No native `JSONB`.** Blobs of JSON (raw share payloads, LLM candidate lists) are stored as `TEXT` and parsed at the boundary, with the parse validated rather than trusted.
- **D1 has no interactive transactions.** Multi-statement atomicity uses batch semantics, which constrains how the job claim is written — it must be a single conditional `UPDATE ... RETURNING`, not a read-then-write. This is a real constraint and it is why the job queue design in [ADR-0007](0007-async-work-cron-driven-jobs.md) looks the way it does.
- Migrations must be applied on both paths: `wrangler d1 migrations apply` in the deploy script, and automatically at boot on the Node path.

## Revisit if

- **MULTI mode grows past a handful of users on one instance** to the point where D1's write throughput or the single-writer model bites. Realistically that is dozens of users sharing one 10,000-unit quota, which is already impossible for quota reasons long before it is a database problem.
- **We need a query SQLite genuinely can't express well** — recursive analytics, full-text ranking over large corpora. Not in scope; §12 rules out analytics entirely.
- **D1 diverges from SQLite semantics** enough that "one dialect" stops being true.
