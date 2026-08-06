# ADR-0012 — pnpm, Vitest, Biome, gitleaks, GitHub Actions

**Status:** accepted · **Date:** 2026-08-05

## Context

Grouped into one ADR because these choices are individually unremarkable and collectively serve one goal: **a stranger clones the repo, runs two commands, and everything works.** Every extra tool, config file, and setup step is friction on the contribution path and a thing that can rot.

CI must cover what §10 requires: lint, typecheck, test, secret scan.

## Decision

| Concern | Choice |
|---|---|
| Package manager | **pnpm** |
| Test runner | **Vitest** |
| Lint + format | **Biome** |
| Type checking | `tsc --noEmit`, strict |
| Secret scanning | **gitleaks** in CI, full history |
| CI | **GitHub Actions** |
| Commits | Conventional Commits |

**pnpm** — fast, strict about phantom dependencies (which matters under ADR-0001's Web-standard discipline: a package that only works on Node shouldn't be reachable by accident), and the disk-efficient store is pleasant. `packageManager` is pinned in `package.json` so Corepack gives everyone the same version.

**Vitest** — TypeScript and ESM with no configuration, fast watch mode, `node:test`-compatible assertions if we ever want out. Two test flavours, both credential-free:

- **Pure unit tests** over the core: URL extraction, normalisation, ranking, confidence, quota arithmetic. No mocks needed, because the core has no I/O.
- **Integration tests** driving real HTTP requests through the Hono app against in-memory SQLite and the fixture YouTube client. These exercise real routing, real SQL, and real middleware — the fixture boundary is the *network*, not our own code.

The bar for the URL extractor is exhaustive fixtures. It handles the majority of real shares at zero quota cost ([ADR-0006](0006-quota-strategy.md)), it is pure and fixture-driven, and every case it misses becomes a 100-unit search or a review-inbox item. There is no excuse for it to be undertested.

**Biome** over ESLint + Prettier — one tool, one config file, one dependency, no plugin resolution, and fast enough that the pre-commit path stays instant. ESLint's rule ecosystem is deeper; nothing here needs it.

**gitleaks** scanning **full history**, not just the diff. §11 requires zero secrets in git history, and a diff-only scan can't prove that. The repo also carries a `.env.example` full of empty values by design, and the config makes sure that file doesn't produce noise.

**Conventional Commits** — the commit log is the changelog, and it makes "when did this break?" answerable. No enforcement hook; the discipline is worth more than the ceremony.

CI matrix runs the test suite **against both database drivers** — D1's local emulation and the file-backed SQLite path — because [ADR-0003](0003-sqlite-dialect-everywhere-drizzle.md)'s "one dialect, two drivers" claim is only true if something checks it. Untested, the self-host path would rot within a month.

## Rejected

**npm.** Universal and needs no `packageManager` pin. Rejected on speed and on its looseness about undeclared dependencies.

**Bun** as runtime and test runner. Fast and pleasant. Rejected because it adds a third runtime to a project that already deliberately supports two, and its Cloudflare Workers story isn't the primary path anyway. Contributors would need to install it; pnpm+Node they already have.

**Jest.** Needs configuration to be happy with ESM and TypeScript. Vitest needs none.

**ESLint + Prettier.** The conventional answer, and two tools, two configs, a plugin tree, and a slower run for rules we won't use.

**Husky / lint-staged pre-commit hooks.** Rejected: hooks that fail confusingly are a bad first experience for a contributor, and CI is the real gate. A documented `pnpm check` is enough.

**TruffleHog** instead of gitleaks. Comparable; gitleaks' config format is simpler for allowlisting `.env.example`.

**Changesets / semantic-release.** This is a self-hosted app, not a published package. Versioning ceremony would serve nobody.

## Consequences

- `pnpm install && pnpm check` is the whole contributor onboarding. `check` runs format, lint, typecheck, and tests.
- **Every test runs with no credentials and no network.** That is the property §9 demands, and it is enforced by there being no code path in tests that can reach the internet — the fixture client is the only YouTube implementation wired into the test container.
- Two CI jobs (per-driver) means slightly longer CI for a much stronger portability guarantee.
- Biome's formatting is non-negotiable and differs from Prettier in small ways. Documented in CONTRIBUTING.md so nobody fights it.
- gitleaks over full history gets slower as history grows. Irrelevant at this size.

## Revisit if

- **A needed lint rule exists only in the ESLint ecosystem.** Then ESLint joins for that rule alone, and Biome stays as the formatter.
- **CI time becomes annoying.** The per-driver matrix is the thing to trim first, by running the full matrix only on `main` and PRs that touch the data layer.
- **The project ever ships as a package.** Then versioning tooling earns its place. Not planned.
