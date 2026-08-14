<!--
Thanks for contributing. Please keep this short — the diff is the record, this is the reasoning
that the diff cannot carry.

Full guidance: CONTRIBUTING.md
-->

## What and why

<!-- What changed, and what problem it solves. The "why" is the part reviewers cannot infer. -->

## How you verified it

<!--
"Tests pass" is CI's job, not yours. Say what you actually did:
  - the fixture or test that fails before and passes after
  - the thing you ran and watched work
  - `USE_FIXTURES=true pnpm dev` needs no credentials and exercises the whole pipeline
-->

## Checks

- [ ] `pnpm check` passes (format, lint, typecheck, tests)
- [ ] Behaviour changes have a test
- [ ] The core stayed pure — no `fetch`, database, clock, or `process` in `src/core/`
- [ ] Web-standard APIs only, so it still runs on both Workers and Node
- [ ] No new YouTube call outside the quota-accounted client
- [ ] No secrets, tokens, or real credentials anywhere in the diff
- [ ] Docs updated if setup, config, or behaviour changed — including `.env.example`

## Decisions

<!--
If this changes something recorded in docs/adr/, update that ADR here or add one superseding it.
An ADR that is quietly false is worse than no ADR.

If it touches an anti-goal in PLAN.md, say which and make the argument.

If it changes src/db/schema.ts, run `pnpm db:generate` and commit the migration — CI fails
otherwise, and a deployed database that does not match the code fails every request.
-->

N/A
