# Architecture decision records

One record per significant decision. Each states what was chosen, what was rejected, why, and **what would make me revisit it** — that last part is the one that stops an ADR from becoming a monument.

Format is deliberately short. These are working notes for whoever inherits this, not a design document.

| # | Decision | Status |
|---|---|---|
| [0001](0001-typescript-hono-web-standard-runtime.md) | TypeScript on Web-standard APIs, Hono as the HTTP layer | accepted |
| [0002](0002-hosting-cloudflare-workers-primary.md) | Cloudflare Workers + D1 primary; Node container for self-host | accepted |
| [0003](0003-sqlite-dialect-everywhere-drizzle.md) | SQLite dialect everywhere, Drizzle ORM | accepted |
| [0004](0004-watch-later-is-unreachable.md) | Watch Later is unreachable; app-owned playlist instead | accepted |
| [0005](0005-token-lifecycle-and-reauth.md) | Token lifecycle, `invalid_grant`, keep-alive, re-auth | accepted |
| [0006](0006-quota-strategy.md) | Cheapest-first pipeline, quota ledger, queue-and-retry | accepted |
| [0007](0007-async-work-cron-driven-jobs.md) | Cron-driven job table, no external queue | accepted |
| [0008](0008-ingest-authentication.md) | Bearer token ingest auth, not HMAC | accepted |
| [0009](0009-llm-provider-and-the-gemini-question.md) | Gemini default behind an interface, always optional | accepted |
| [0010](0010-notifications-telegram-primary.md) | Telegram as primary notification channel | accepted |
| [0011](0011-frontend-server-rendered-no-framework.md) | Server-rendered JSX, no client framework | accepted |
| [0012](0012-tooling-pnpm-vitest-biome.md) | pnpm, Vitest, Biome, gitleaks, GitHub Actions | accepted |
| [0013](0013-solo-and-multi-modes.md) | SOLO default, MULTI opt-in | accepted |

## Where I disagreed with the brief

Two of these depart from the mission brief, as it invited. Both are argued in place rather than silently designed around:

- **[ADR-0008](0008-ingest-authentication.md)** — the brief offers "a shared secret or HMAC signature". I chose the shared secret and argue against making HMAC the default, because an iOS Shortcut cannot compute an HMAC without contortions, and a security control that makes the flagship client unbuildable is a net loss.
- **[ADR-0002](0002-hosting-cloudflare-workers-primary.md)** — no disagreement with the brief, but it records why the obvious answer (Vercel) loses on two specific free-tier limits.

And one place where the brief's research has been overtaken by events, in our favour: Instagram oEmbed appears to no longer require a token. See the [verification log](../verification-log.md).
