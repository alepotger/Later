# Contributing

Thanks for looking. Later is small on purpose, and the fastest way to get a change merged is to understand why it's shaped the way it is.

The fastest way in: `pnpm install && USE_FIXTURES=true pnpm dev`. No credentials needed — see below.

## Start here

Read [`PLAN.md`](PLAN.md) for the shape of the thing, then the [ADRs](docs/adr/) for any area you're touching. Each ADR says what was rejected and why, which will usually answer "why isn't this just X?" faster than an issue thread.

## Setup

```bash
pnpm install
pnpm check      # format, lint, typecheck, test — run this before pushing
pnpm test       # tests only, in watch mode
pnpm dev        # local server against fixtures — no credentials needed
```

**You do not need Google credentials to develop Later.** Set `USE_FIXTURES=true` and every outbound call is served from recorded responses. The whole pipeline — resolution, quota accounting, token refresh, `invalid_grant`, quota exhaustion — runs offline, and the tests do too. That's a deliberate architectural property ([ADR-0001](docs/adr/0001-typescript-hono-web-standard-runtime.md)), not a convenience.

## Rules that actually matter

**1. The core stays pure.** URL extraction, normalisation, ranking, confidence scoring, and quota arithmetic take plain data and return plain data. No `fetch`, no database, no `Date.now()`, no environment access. Anything touching the world goes behind a port. This is why the interesting code is trivially testable.

**2. Web-standard APIs only.** The same code runs on Cloudflare Workers and Node. Use `fetch`, `crypto.subtle`, `URL`, `TextEncoder`. Reaching for `node:fs`, `node:crypto`, or `process` outside an entry file or a runtime adapter will fail on the primary deployment target. New dependencies must work on both — check before adding one.

**3. Never call YouTube without declaring a cost.** All calls go through the YouTube client, which checks the quota ledger before spending and records after ([ADR-0006](docs/adr/0006-quota-strategy.md)). A `search.list` costs 100 units against a 10,000/day budget; an untracked call is how a deployment silently dies at lunchtime.

**4. Never add a low-confidence guess to someone's playlist.** Below the threshold, an item is held for review. A wrong video destroys trust faster than a missing right one.

**5. No scraping, ever.** Official public APIs only. If a platform doesn't permit something, the answer is a documented limitation, not a workaround. See [ADR-0004](docs/adr/0004-watch-later-is-unreachable.md) for the canonical case — this is not negotiable, and a PR that adds cookie replay or headless browsing will be closed.

**6. No telemetry.** Not by default, not opt-out, not "anonymous". See [SECURITY.md](SECURITY.md).

**7. Don't build the anti-goals.** [§12 of the brief](PLAN.md) rules out native apps, analytics dashboards, gamification, billing, agent frameworks, and speculative generality. They're ruled out to keep this deployable by a stranger in 15 minutes.

## The URL extractor deserves special care

Tier 0 — pulling a YouTube URL out of shared text — is the highest-value code in the repo. It handles the majority of real shares at zero quota cost, and every case it misses becomes a 100-unit search or a manual review.

**If you find a URL form it mishandles, that's a great contribution, and the fix is a fixture.** Add the real-world input to the fixture file with the expected video ID, watch it fail, then fix the extractor. Please include the actual string your share sheet produced, messy bits and all — synthetic examples miss the interesting cases.

## Commits and PRs

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`. Small, coherent commits with messages that say why.

For a PR: what changed, why, and how you verified it. If it changes behaviour, it needs a test. If it changes a decision recorded in an ADR, update the ADR in the same PR — or add a new one that supersedes it. An ADR that's quietly false is worse than no ADR.

CI runs format, lint, typecheck, and the test suite; checks that generated migrations match `schema.ts`; bundles both deploy targets (the Worker bundle is what catches a `node:` API leaking into shared code); and scans the full git history for secrets. `pnpm check` locally covers everything except the last two.

## Formatting

Biome, and its output is not up for debate — run `pnpm check` and take what it gives you. Not Prettier; the details differ slightly and that's fine.

## Reporting bugs

The genuinely useful bug reports include the request ID from the logs (every request has one, and it ties a whole pipeline run together), the item's state from the web UI, and what you shared. [TROUBLESHOOTING.md](TROUBLESHOOTING.md) covers the known failure modes — worth a look first, particularly if things stopped working after about a week.

**Never paste secrets into an issue.** No token, key, or client secret is needed to help you.

## Security

Don't open a public issue for anything exploitable — see [SECURITY.md](SECURITY.md).
