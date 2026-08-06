# ADR-0001 — TypeScript on Web-standard APIs, Hono as the HTTP layer

**Status:** accepted · **Date:** 2026-08-05

## Context

Later must run in two places that a stranger might plausibly choose: a free serverless host (for the one-click deploy) and a container on their own machine (for `docker compose up`). Both are mandated by the brief, so the runtime choice is really a *portability* choice.

The work itself is undemanding: parse text, call three or four HTTPS endpoints, write a few rows. No heavy computation, no long-lived connections, no streaming. What is demanding is that a huge share of the logic must be testable with no credentials at all (§9), which argues for a language with cheap, fast, dependency-free unit testing.

## Decision

**TypeScript, strict mode, targeting Web-standard APIs as the lowest common denominator**, with [Hono](https://hono.dev) as the HTTP layer.

Concretely, the code is only allowed to assume these platform primitives:

- `fetch`, `Request`, `Response`, `Headers`, `URL`, `URLSearchParams`
- `crypto.subtle` (AES-GCM for token encryption, HMAC-SHA256, SHA-256) and `crypto.getRandomValues`
- `TextEncoder` / `TextDecoder`, `structuredClone`

All of those exist unchanged in Node 20+, Cloudflare Workers, Deno, and Bun. Anything outside that set — a filesystem, a process, a SQLite driver, a timer that survives a response — is reached only through an injected port.

Hono is the HTTP layer because it is built on `Request`/`Response` rather than wrapping a Node-specific server, so the same router runs on both targets with a different entry file and nothing else changed. It also brings server-rendered JSX (see [ADR-0011](0011-frontend-server-rendered-no-framework.md)), which removes the need for a separate frontend stack.

## Rejected

**Next.js.** The Vercel-native answer, and genuinely pleasant for the review inbox. Rejected because it drags in React, a build pipeline, and a rendering model to serve what is fundamentally a paste box and a list — and because it couples the deployment story to one host, which is exactly the coupling this project cannot afford. The frontend here is a few hundred lines of HTML.

**Python + FastAPI.** Fine language for the text-wrangling parts, and the ecosystem for LLM work is deeper. Rejected on the deployment mandate: there is no free always-warm serverless Python host with an auto-provisioning one-click deploy button comparable to Cloudflare's, so choosing Python means either paying for hosting or accepting a cold-start penalty that breaks the "no waiting" promise.

**Go.** Excellent single-static-binary self-host story, and would be my choice if `docker compose` were the *only* target. Rejected because the serverless free-tier options are worse, and because the iteration cost on the string-and-JSON-heavy parts of this codebase — URL parsing, oEmbed shapes, LLM responses — is meaningfully higher than TypeScript's for no benefit at this scale.

**Node-specific TypeScript** (Express/Fastify + `node:` APIs throughout). The path of least resistance, and it forecloses the free serverless target entirely. The discipline of the Web-standard subset costs very little in practice and is what buys the two-target story.

## Consequences

Good:

- One codebase, two entry files. `src/entry/worker.ts` and `src/entry/node.ts` are each expected to be well under a hundred lines; everything meaningful is shared.
- The pure core — URL extraction, ranking, confidence, quota arithmetic — imports nothing and needs no runtime at all. That is the bulk of the interesting code and all of the high-value tests.
- `crypto.subtle` being the only crypto means encryption-at-rest and HMAC work identically everywhere, with no dependency.

Bad, and accepted:

- The Web-standard subset rules out some convenient libraries. Every dependency has to be checked for runtime compatibility before adoption, which is friction on every new dependency for the life of the project.
- `crypto.subtle` is async-only. Key derivation and encryption become `await`-ed calls in places where a sync call would read better.
- Cloudflare Workers impose a CPU-time limit per request. Fine for this workload, but it constrains Tier 3 (see revisit).

## Revisit if

- **Tier 3 (transcripts/OCR) turns out to need real CPU.** That would exceed the Workers CPU budget and push the heavy path to the Node target or an external service. Tier 3 is opt-in and off by default partly to keep this contained.
- **A dependency we genuinely need is Node-only.** So far nothing on the list is: Drizzle, the Google OAuth and YouTube REST calls, the Gemini REST call, and the Telegram Bot API are all plain `fetch` or runtime-agnostic.
- **The frontend grows past a few screens.** If the review inbox becomes a real application rather than a list with buttons, the no-framework position ([ADR-0011](0011-frontend-server-rendered-no-framework.md)) goes first, and this ADR would follow only if that failed too.
