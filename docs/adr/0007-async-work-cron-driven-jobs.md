# ADR-0007 — A job table swept by cron, not an external queue

**Status:** accepted · **Date:** 2026-08-05

## Context

§4 sets a hard latency requirement: `POST /api/ingest` returns `202 Accepted` immediately and all work happens afterwards. The user finds out via notification. Nobody waits.

That needs three things:

1. Somewhere durable to record "this needs doing" before responding
2. A way to do the work *after* the response has been sent
3. A way to retry later — for quota exhaustion ([ADR-0006](0006-quota-strategy.md)) and `reauth_required` ([ADR-0005](0005-token-lifecycle-and-reauth.md)), where "later" can mean tomorrow

Cloudflare Queues would be the idiomatic answer for (1) and (3). It requires the **paid** Workers plan, which collides with the free-tier mandate. External queues (Upstash, SQS) each add an account, a dashboard, and a console step — spending the 15-minute onboarding budget on infrastructure the user will never think about again.

## Decision

**A `jobs` table in SQLite, drained by two mechanisms: inline after the response for the fast path, and a cron sweep for everything else.**

```
POST /api/ingest
  ├─ validate, authenticate, rate limit
  ├─ INSERT item + job          (durable — survives everything from here on)
  ├─ schedule inline processing  (waitUntil on Workers / detached promise on Node)
  └─ return 202                  ← user is done, ~milliseconds

  ... response already sent ...
  └─ process job → success, or leave it for the sweep

cron * * * * *   →  claim due jobs, process, backoff on failure
cron 0 4 * * *   →  token keep-alive
```

**The durable write happens before the response.** The inline attempt is an optimisation for the common case, not the mechanism. If the isolate is killed, the process crashes, or the inline attempt throws, the job is still in the table and the sweep picks it up within a minute. Nothing depends on the fast path succeeding, which is what makes "never drops" true.

### Claiming without transactions

D1 has no interactive transactions ([ADR-0003](0003-sqlite-dialect-everywhere-drizzle.md)), so a read-then-write claim would race two concurrent sweeps. The claim is therefore a single conditional statement:

```sql
UPDATE jobs
   SET status = 'running', attempts = attempts + 1, locked_until = ?
 WHERE id = (SELECT id FROM jobs
              WHERE status = 'pending' AND run_after <= ?
              ORDER BY run_after LIMIT 1)
   AND status = 'pending'
RETURNING *
```

The redundant-looking `AND status = 'pending'` is the compare-and-swap: a loser's `UPDATE` matches zero rows and returns nothing. `locked_until` reaps jobs whose worker died mid-flight.

### Retry policy differs by failure class

Because "retry in a minute" and "retry tomorrow" are different problems:

| Failure | Retry |
|---|---|
| Transient (5xx, network, timeout) | exponential backoff, capped attempts, then `failed` |
| Quota exhausted | `run_after` = next quota reset, **attempts not incremented** |
| `reauth_required` | parked indefinitely; released when the account returns to `active` |
| Unresolvable (no candidate, private video) | terminal, user notified with the reason |

Quota exhaustion not consuming an attempt matters: it is not a failure of the job, and letting it burn attempts would eventually mark a perfectly valid share as permanently failed for reasons of accounting.

## Rejected

**Cloudflare Queues.** The right tool, behind a paywall that contradicts the free-tier mandate. Would be reconsidered instantly if it reached the free plan.

**External queue service** (Upstash, SQS, Inngest). Each adds an account, a dashboard, and secrets to the onboarding path for a workload of a few dozen jobs a day.

**Do the work synchronously and return 200.** Simplest possible thing, and it breaks the product. The share sheet would hold for the duration of two or three YouTube API round-trips, which is precisely the "waiting" §4 forbids.

**Fire-and-forget with no durable record.** Fast and loses shares on any crash, restart, or quota wall. §11 requires never dropping.

**`setInterval` in a long-lived Node process, with no job table.** Works on the self-host path only, and forks the architecture between targets. The job table is needed for quota deferral anyway — once it exists, the scheduler is just a trigger.

## Consequences

Good:

- **No external dependency for async work.** Zero extra console steps, zero extra secrets, works identically on both targets.
- The fast path is genuinely fast: a Tier 0 hit completes in a few hundred milliseconds after the response, so the notification often arrives before the user has finished swiping away.
- Every failure mode is a row someone can look at. "Why didn't my video get added?" is answerable from a `SELECT`.

Bad, and accepted:

- **Polling, not pushing.** Up to 60 seconds of latency for anything the inline path didn't finish. Irrelevant here — the user is already gone, and the fast path covers the common case.
- Each cron tick is a Worker request against the 100k/day free allowance. 1,440 ticks/day is 1.4% of it.
- A cron tick that finds nothing to do is a wasted invocation. At this scale, an acceptable trade for not running a scheduler.
- The claim SQL is subtle. It gets a concurrency test that runs two sweeps against the same pending job and asserts exactly one wins.

## Revisit if

- **Cloudflare Queues becomes free**, or the deployment moves to a paid plan for other reasons.
- **Job volume grows** past what a one-minute sweep can drain. Far beyond the design target.
- **Sub-second async latency becomes a product requirement** — e.g. the notification must land before the user closes the share sheet. Then the inline path needs to become the guaranteed path rather than the optimistic one.
