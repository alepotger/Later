# ADR-0011 — Server-rendered HTML templates, no client framework

**Status:** accepted · **Date:** 2026-08-05 · **Revised:** 2026-08-06 during Phase 1 (JSX → tagged template; see "Revision" at the end)

## Context

Later needs a web surface, and it is small. The complete list:

1. **Paste box** — a textarea and a button. Also the debugging tool: paste a link, see exactly what the pipeline extracted.
2. **Review inbox** — a list of held items, each with confirm/reject.
3. **Status** — auth state, playlist link, quota spent today, the `reauth_required` banner.
4. **Auth start/callback** — two redirects and a success page.
5. **PWA share target landing** — receives the share, fires the ingest, says "Saved".

That is four pages and roughly a dozen interactions. There is no realtime, no complex client state, no offline editing, no drag-and-drop. §12 explicitly rules out dashboards and analytics, so it will not grow into one.

## Decision

**A ~40-line auto-escaping `html` tagged template, rendered on the server. Plain CSS in one file. Small amounts of vanilla JS where it earns its place. No build step for the frontend, no React, no client-side router.**

- **An `html` tagged template that escapes every interpolation by default.** Composition is ordinary function calls returning `Html` values; nesting is just interpolating one into another. Emitting raw markup requires an explicit `raw()`, so the unsafe path is the one you have to type out on purpose.
- **Forms post and redirect.** Confirm/reject in the review inbox are `<form method="post">` submissions. They work without JavaScript, which means they work in the odd in-app browser contexts that share sheets produce — which is exactly where this UI will actually be used.
- **Progressive enhancement only.** The PWA share-target page needs ~20 lines of inline JS to fire the ingest and show a result. The paste box gets a fetch-based submit so it doesn't navigate. Both work without JS, just less prettily.
- **One CSS file**, system font stack, respects `prefers-color-scheme`. No framework, no preprocessor, no utility classes.
- **PWA bits hand-written**: `manifest.webmanifest` with `share_target`, plus a minimal service worker only if the share target needs one.

On the share target specifically: the manifest uses **`method: "GET"`** so the Android share sheet passes `title`/`text`/`url` as query parameters to a normal page load. That requires no service worker at all. The `POST`+`multipart` variant needs a service worker to intercept the request, which is more moving parts for a marginally slicker result. GET first; revisit if the extra browser tab proves annoying enough to matter.

## Rejected

**React / Next.js.** The default reflex. Rejected because it brings a build pipeline, a client bundle, and a hydration model to render a textarea and a list — and because it would couple the deploy story to one host, contradicting [ADR-0002](0002-hosting-cloudflare-workers-primary.md). See also [ADR-0001](0001-typescript-hono-web-standard-runtime.md).

**HTMX or Alpine.** A good fit at this size and genuinely tempting for the review inbox. Rejected because form-post-and-redirect already handles every interaction we have, so this would be a dependency and a mental model added for polish alone. If the inbox grows interactive, HTMX is the first thing to reach for.

**Svelte / Vue / SolidStart.** All lighter than React and all still a build pipeline and a client runtime for four pages.

**A template language** (Nunjucks, Handlebars, EJS). Would work, and is a dependency plus a second syntax to learn for four pages.

**JSX** (Hono's `hono/jsx`). This was the original decision here, and it was revised during implementation — see below.

**API-only, no web UI.** Considered, since the product's whole thesis is that the user never opens the web app. Rejected on three counts: the paste box is the fallback ingress for every platform and the primary debugging tool; the review inbox has to live somewhere; and the `reauth_required` banner is the safety net when no notification channel is configured. The UI is rarely visited and load-bearing when it is.

## Consequences

Good:

- **No frontend build step.** One TypeScript compilation produces the whole application. CI is lint, typecheck, test — no bundler config to maintain, no lockfile churn from a frontend tree.
- **Nothing to hydrate, so nothing to hydrate wrong.** The pages render identically everywhere, including the in-app browsers that share sheets open.
- Works with JavaScript disabled or broken, which is a real condition inside some in-app webviews.
- Page weight is a few KB. Meaningful on mobile data, which is where every real interaction happens.

Bad, and accepted:

- **Anything genuinely interactive gets tedious.** Optimistic UI, live quota updates, or an inbox that updates without a reload would all be awkward. None are needed.
- Contributors expecting React will find this unusual and will need the reasoning, which is why this ADR exists.
- Full page reload on every confirm/reject. Fine for a list someone visits occasionally; would be poor for a list they work through in bulk.

## Revisit if

- **The review inbox becomes a place people spend time**, e.g. Tier 2/3 push a lot of items into it and users triage in batches. Then HTMX for partial updates, still without a build step.
- **A feature genuinely needs client state** — offline queueing in the PWA is the plausible one.
- **The GET share target's extra browser tab proves annoying** in real use. Then the `POST`+service-worker variant, which is a contained change to the manifest and one new file.

## Revision, 2026-08-06 — JSX replaced by a tagged template

The original decision was Hono's server-rendered JSX. Wiring it up in Phase 1 showed the "no build step" claim in this ADR was not actually true of JSX: it needs a `jsx`/`jsxImportSource` pair configured in **three** places that each resolve it differently — `tsconfig.json` for typechecking, the test runner's transform, and the bundler for each of the two deploy targets. Vitest 4 moved from esbuild to oxc mid-stack, which surfaced this as a real configuration conflict rather than a theoretical cost.

Weighed against what JSX was buying — composition and type-checked templates for four pages — that is a poor trade. A tagged template gets both properties with **zero** transform configuration:

```ts
const page = html`<main><h1>${title}</h1>${rows.map(row)}</main>`;
```

Composition is function calls, values are typed, and every interpolation is escaped unless explicitly wrapped in `raw()`. It is plain TypeScript, so all three toolchains parse it with no configuration at all.

Two things genuinely got better, not just simpler. Escaping is now **on by default and off by exception**, which is the safer polarity — JSX's `dangerouslySetInnerHTML` is a louder name but the same hazard, and here the hazard is user-supplied caption text rendered back into the review inbox. And the frontend now shares the "Web-standard APIs only" property of the rest of the codebase ([ADR-0001](0001-typescript-hono-web-standard-runtime.md)) rather than depending on a compiler feature.

What got worse: no structural validation of the markup. A malformed tag is a runtime bug a JSX compiler would have caught. Mitigated by the templates being small and by rendering tests asserting on output, but it is a real loss and worth naming.

**Everything else in this ADR stands** — server-rendered, no client framework, forms that work without JavaScript, one CSS file. Only the templating mechanism changed. Revisit alongside the triggers above.
