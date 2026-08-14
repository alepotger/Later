# ADR-0004 — Watch Later is unreachable; use an app-owned playlist and say so

**Status:** accepted · **Date:** 2026-08-05 · **Verified:** [verification log](../verification-log.md)

## Context

The project is called Later. The obvious expectation is that it writes to YouTube's native **Watch Later** queue. It cannot, and no version of it ever will.

Verified against the YouTube Data API v3 Revision History: since **12 September 2016**, `contentDetails.relatedPlaylists.watchLater` returns the literal string `"WL"` for every channel; `playlists.list` and `playlistItems.list` against `WL` return empty lists; `playlistItems.insert` against it fails. This is a deliberate, permanent removal. It is not a scope problem — no OAuth scope restores it — and it has not been reversed in the ten years since.

Two paths follow from that. One is to be honest and slightly disappointing. The other is to simulate a browser session and pretend.

## Decision

**Write to a dedicated, app-created, user-owned YouTube playlist. Name it `Later` by default, make the name configurable, and state the limitation in the README above the fold.**

1. **Find-or-create, never assume.** On first authorisation, list the user's own playlists and look for one matching the configured name; create it if absent; store its ID on the account row. The playlist may be deleted or renamed by the user at any time, so a failed insert against a stored ID re-runs find-or-create once before giving up. Never treat the stored ID as guaranteed.
2. **Refuse `WL` explicitly, in code.** If a playlist ID of `WL` or `HL` ever reaches the YouTube client, it throws a named error rather than issuing a doomed API call. This exists so that the constraint is expressed as behaviour with a test, not as a comment somebody deletes in 2028.
3. **Deduplicate ourselves.** The same 2016 revision removed YouTube's duplicate rejection: `playlistItems.insert` will happily add the same video twice. There is no server-side backstop. The `UNIQUE(account_id, video_id)` constraint in [ADR-0003](0003-sqlite-dialect-everywhere-drizzle.md) is the only thing preventing a polluted playlist, which promotes dedupe from hygiene to correctness.
4. **Tell the truth prominently.** README, above the fold, before installation, with the date and the mechanism. A product whose name implies one thing while doing another is broken regardless of how well the code works — and a deployer who discovers this on day three will reasonably conclude the project misled them.
5. **Soften it where we legitimately can.** The playlist is real, so it syncs across devices and can be pinned in the YouTube app. Later surfaces a deep link that opens it directly. That is a genuine consolation, and it is a nice-to-have, not core.

## Rejected

**Headless browser automation, cookie replay, or the private InnerTube endpoints.** These would technically work today. Rejected without hesitation, on four independent grounds, any one of which is sufficient:

- It violates YouTube's Terms of Service. This repo is meant to be deployed by strangers; shipping them a ToS violation as a default is not a decision I get to make on their behalf.
- It requires the deployer to hand long-lived session cookies to a self-hosted service — a far worse security posture than a scoped OAuth token they can revoke in one click.
- It breaks on YouTube's schedule, not ours, and the failure mode is silent.
- It would make the repo a liability for everyone who deploys it.

The brief flags this as a wrong turn, and it is right. **The correct output of an impossible requirement is a documented limitation, not a workaround.**

**Quietly writing to a playlist and calling it "Watch Later" in the UI.** The path of least user disappointment in the first five minutes and the most in the first week. Rejected: the disappointment is not avoided, only deferred and compounded.

**Renaming the project.** Considered seriously — "Later" does over-promise. Rejected because the name describes the *user intent* ("watch this later") rather than a specific YouTube feature, the ambiguity is resolved honestly in the first screenful of the README, and the alternative is a worse name for a correctly-scoped product.

## Consequences

- The destination playlist is a first-class entity with its own lifecycle: created, cached, possibly deleted by the user, re-created on demand. Every insert path must tolerate its absence.
- Two extra API calls on first auth (`playlists.list` at 1 unit, `playlists.insert` at 50 if needed), once per account, cached forever after. Negligible against the daily budget.
- **Dedupe is correctness-critical**, and gets tests both at the constraint level and through the fixture client.
- Default playlist privacy is `private`, configurable. Defaulting to public would leak someone's viewing intentions, which is not a default anyone should have to discover.
- A support burden that never fully goes away: some people will still ask why it isn't in their Watch Later. The README is the answer, and it is why the README leads with it.

## Revisit if

- **Google restores write access to `WL`.** Extremely unlikely after a decade, and it would be a headline change. If it happened, the destination becomes configurable and `WL` becomes an option — the find-or-create indirection means this is a small change, which is a nice accident of the design.
- **A first-party alternative appears** — a supported "queue" API, or something in a future YouTube surface. Worth checking annually, not more.
- **The deep-link consolation turns out to matter more than expected.** If people mainly want quick access to the playlist, that argues for investing in the link and the pin instructions rather than anything cleverer.
