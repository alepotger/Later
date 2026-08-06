# ADR-0013 — SOLO by default, MULTI as an explicit opt-in

**Status:** accepted · **Date:** 2026-08-05

## Context

§6 requires two modes: SOLO for one person, MULTI for a shared family/friends instance. The temptation is to build MULTI and treat SOLO as "MULTI with one user", because that is the architecturally tidy answer.

It's the wrong answer here, for a reason that isn't about architecture: **95% of deployers want SOLO, and multi-user machinery is exactly what makes a project intimidating to deploy.** Every "which user is this?" concept in the onboarding path spends the 15-minute budget. If the tidy abstraction makes the common case harder to set up, it has failed at the thing this project is actually optimising.

There is also a hard constraint that no amount of architecture removes: **all users of one instance share one Google Cloud project's 10,000-unit daily quota** ([ADR-0006](0006-quota-strategy.md)). The OAuth client is per-project, so per-user quota isn't available without each user creating their own project — which is SOLO.

## Decision

**One data model that is multi-account throughout. One code path. A `LATER_MODE` switch that changes only authorisation policy and UI, never storage.**

The `accounts` table exists in both modes and every row — items, jobs, quota ledger entries — carries an `account_id`. There is no single-user schema and no migration between modes.

What the mode actually changes:

| | `SOLO` (default) | `MULTI` |
|---|---|---|
| Who may complete OAuth | **the first person only**; locked after | anyone on `LATER_ALLOWED_EMAILS` |
| Ingest routing | the one account, implicitly | resolved from the token or Telegram chat ID |
| `INGEST_TOKEN` | one, shared | one per account |
| Web UI | no account concepts visible | account switcher, per-account status |
| Quota display | "units today" | per-account **and** instance total |

**SOLO's important property is the lock.** The first successful OAuth claims the instance; every subsequent attempt is refused. Without that, a deployer's `/auth/start` URL is an open invitation for a stranger to attach their account. It's the mistake a self-hoster shouldn't have to think about, so the default prevents it rather than documenting it.

MULTI additionally requires an explicit email allowlist. Not "anyone who has the URL" — that's the same open-door problem with more steps. Startup refuses to run in MULTI with an empty allowlist.

**MULTI is honest about the quota it can't fix.** The mode warns at startup and shows instance-wide consumption in the UI: with a 9,000-unit budget, four people sharing an instance have ~45 URL-bearing shares each per day, and the docs point at the quota increase form. Splitting a fixed pool is a documented limitation, not something to paper over.

## Rejected

**SOLO only, MULTI never.** Simpler and violates §6. Also genuinely useful: a shared household instance is a real want.

**A separate single-user schema for SOLO.** Optimises the wrong thing. It would mean two data models, two sets of queries, two sets of bugs, and no migration path for someone who starts SOLO and later wants their partner on it. The `account_id` column costs nothing.

**MULTI as the default.** Correct-feeling and wrong for the audience. It would put user management in front of everyone to serve a small minority.

**Per-user Google Cloud projects inside MULTI.** Would genuinely solve quota, and requires every user to do the entire Batch 1 console session — i.e. it *is* SOLO, deployed several times, which is already a supported answer and a better one for anyone who cares about quota isolation. Documented as the recommendation for larger groups.

**Open registration in MULTI.** No.

## Consequences

- **One code path.** Ingest resolves an account and proceeds; no `if (solo)` branches in the pipeline. The mode is checked at two edges — the OAuth start handler and the UI — and nowhere else.
- SOLO onboarding never mentions users, accounts, or allowlists. Someone can deploy Later without knowing MULTI exists.
- The `account_id` foreign key is present from the first migration, so no schema change is ever needed to switch modes. Flip the env var, add an allowlist, authorise a second person.
- MULTI needs per-account ingest tokens, so the token check resolves an account rather than comparing against one value. In SOLO that is a single-row lookup — same code, trivially cheap.
- A shared instance can have one user exhaust the day's quota for everyone. Inherent to the platform. Surfaced in the UI so it is diagnosable rather than mysterious, and the honest fix is a quota increase or separate deployments.

## Revisit if

- **MULTI gets real use and quota contention becomes the top complaint.** Then per-account daily sub-budgets — reserving a share of the pool per user so one person can't starve the rest. Deliberately not built speculatively; the ledger already has the shape for it.
- **Someone wants MULTI without an allowlist**, e.g. a Workspace domain. Then allow a domain suffix rule, still explicit, never open.
- **SOLO's first-auth lock proves annoying** — a deployer who authorises the wrong Google account needs a documented reset, which should be a config flag rather than a database edit.
