# ADR-0002 — Cloudflare Workers + D1 as the primary host; Node container for self-host

**Status:** accepted · **Date:** 2026-08-05

## Context

The brief sets four constraints that together eliminate most of the field:

1. **Free tier deployable** — "a person with no budget must be able to run this"
2. **One-click deploy button** that actually works
3. **`docker compose up`** from a clean checkout, also actually working
4. **Fork → first saved video in under 15 minutes**, for a non-technical person

Constraint 4 is the one that does the real work, because every console step spends the budget. Provisioning a database by hand is 3–5 minutes and a signup; configuring a cron service is another. Whatever host we pick, the fewer resources the deployer creates by hand, the more likely the 15-minute claim survives contact with a stranger.

There is also a hard product constraint hiding in §4: the ingest endpoint must respond effectively instantly, because an iOS Shortcut sitting on a spinner is the failure the whole project exists to avoid. **A host that cold-starts from zero on an idle service is disqualified**, not merely suboptimal.

## Decision

**Primary: Cloudflare Workers + D1, free plan.** **Self-host: the same application as a Node process in a container, with SQLite on a volume.**

Cloudflare wins on all four constraints at once:

- **Genuinely free, no card.** 100k requests/day; this workload is a few dozen.
- **No idle spin-down.** Isolates start in single-digit milliseconds, so an ingest after three days of silence is as fast as one after three seconds.
- **Cron Triggers on the free plan**, 1-minute minimum. Two triggers is all we need (job sweep, token keep-alive) and no external scheduler has to be created.
- **The deploy button provisions the database.** "Deploy to Cloudflare" parses `wrangler.jsonc`, creates the D1 database, writes the binding into a fresh repo in the clicker's own account, and prompts for secrets. **The deployer never creates a database by hand.** This single fact is worth several minutes of the 15-minute budget and removes an entire class of "which connection string?" support burden.
- D1 free tier (5 GB, 5M row reads/day) is three orders of magnitude beyond what one person's playlist needs.

The self-host path runs the *same* application through a Node entry file against a local SQLite file. This is not a second implementation: [ADR-0003](0003-sqlite-dialect-everywhere-drizzle.md) keeps one SQL dialect and one migration set across both, and [ADR-0007](0007-async-work-cron-driven-jobs.md) keeps scheduling internal so the container needs no sidecar. `docker compose up` gets one service and one volume.

## Rejected

**Vercel Hobby.** The obvious answer, and it loses on two specific numbers rather than on vibes:

- **Hobby cron jobs run at most once per day, with a limit of two.** Our daily jobs fit that, but it leaves no room for a minutes-scale retry sweep, and it means a transient failure at 09:00 waits until tomorrow instead of a minute. That is a materially worse product.
- **No database is provisioned by the deploy button.** Postgres arrives via a separate Marketplace integration — more clicks, another account, another consent screen, inside a 15-minute budget.

Vercel's deploy button is otherwise the best in the business, and if the cron limits changed this decision would be close.

**Render free tier.** Free web services spin down after inactivity and cold-start in tens of seconds. That directly breaks the product: the share sheet would hang. Free Postgres also expires. Disqualified on constraint from §4, not on cost.

**Fly.io / Railway.** Both good platforms, neither has a real free tier in 2026 — Fly is pay-as-you-go, Railway is trial-then-paid. Fails constraint 1.

**Cloudflare Queues** for the async work. Requires the paid Workers plan. See [ADR-0007](0007-async-work-cron-driven-jobs.md).

**Deno Deploy.** Free tier and no cold-start problem, so a real contender. Rejected because the persistence story for a relational workload is weaker for our needs than D1, and the deploy-button-provisions-your-database property is the specific thing winning this decision.

## Consequences

Good:

- Zero-cost, always-warm, no card, database included, scheduler included. A stranger clicks one button and has infrastructure.
- Cloudflare's button forking the repo into the clicker's own account is the right ownership model for a project whose second mandate is "works for anyone who forks it".

Bad, and accepted:

- **Two runtimes to keep working.** Mitigated hard by ADR-0001's Web-standard discipline and ADR-0003's single dialect, but CI must exercise both or the self-host path will rot. It will be tested on both targets, and that is a standing cost.
- **Workers CPU-time limits** bound what Tier 3 can ever do in-request.
- **`wrangler` is a required dev dependency** for the primary path, and its local D1 emulation is not byte-identical to production. The Node+SQLite target partly covers this by giving a second, independent execution of the same SQL.
- We inherit a platform dependency on one vendor's free tier remaining free. The mitigation is that the Node path is a genuine, tested escape hatch to any container host — not an afterthought.

## Revisit if

- **Cloudflare's free tier materially changes** — the Node container path becomes primary and the docs swap emphasis. Deliberately cheap to do.
- **Vercel raises Hobby cron frequency and adds button-provisioned storage.** Then Vercel likely wins on familiarity alone.
- **Workers CPU limits block Tier 3**, and Tier 3 turns out to matter more than expected. Then the heavy path moves to the Node target and Workers stays the ingest front door.
- **The 15-minute test fails on the Cloudflare path in practice.** The whole justification here is deploy-time simplicity; if a real stranger can't do it, the premise is wrong and I should find out by testing rather than by asserting.
