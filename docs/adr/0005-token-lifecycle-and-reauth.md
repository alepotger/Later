# ADR-0005 — Token lifecycle: `invalid_grant`, keep-alive, and loud re-auth

**Status:** accepted · **Date:** 2026-08-05 · **Verified:** [verification log](../verification-log.md)

## Context

This is the failure mode most likely to kill a stranger's deployment, and it does so a week after they conclude the project works.

Verified: the `.../auth/youtube` scope is classified **sensitive**. For an **External** OAuth consent screen with publishing status **Testing**, Google **revokes refresh tokens after 7 days**. Publishing to **Production** removes the expiry; an unverified Production app still shows an "unverified app" interstitial and is still capped at 100 users, but its refresh tokens survive. Separately, any refresh token unused for **six months** is invalidated.

The naive implementation stores a refresh token, uses it, and on failure logs an error and retries. Seven days after a delighted deployer finishes setup, Later silently stops adding videos. They notice a fortnight later, having lost the shares in between. Then they open an issue titled "stopped working after a week", and so does everyone else.

**The token failing is not the bug. Failing silently is the bug.** Expiry is a designed-for state transition, not an exception.

## Decision

### 1. `invalid_grant` is its own thing, never a generic error

Google returns HTTP 400 with `{"error": "invalid_grant"}` for a refresh token that has been revoked, expired, or superseded. It is **terminal**: no amount of retrying fixes it, and retrying makes it worse by burning attempts and hiding the real state.

The token refresh path classifies outcomes into exactly three buckets, and each has a distinct handler:

| Outcome | Meaning | Action |
|---|---|---|
| `invalid_grant` | user consent is gone | **terminal** — set `reauth_required`, stop, notify |
| 5xx / network / timeout | Google is having a moment | retry with backoff |
| other 4xx | our bug — bad client config, wrong scope | terminal, log loudly, do not notify the user about something they can't fix |

### 2. Accounts have an explicit status, and it gates work

```
active  ──invalid_grant──►  reauth_required  ──successful re-auth──►  active
   └──user revokes in Google account settings──┘   (same transition)
```

`reauth_required` means: **stop trying, keep every pending item, and do not lose anything.** Jobs for that account are parked rather than failed, so when the user re-authorises, the backlog drains and the shares they made during the dead week still land. This is the difference between an outage and data loss.

### 3. Notify actively, with a one-tap fix

On the transition into `reauth_required`, send exactly one notification through the configured channel ([ADR-0010](0010-notifications-telegram-primary.md)) containing a direct re-auth link. Once, not on every subsequent attempt — because the surest way to get a notification channel muted is to use it as a retry log.

The web UI carries a persistent banner while the state holds, so the information is available even if the notification is missed or no channel is configured.

### 4. Store rotated refresh tokens

Google may return a new `refresh_token` on a refresh response. When it does, persist it. Dropping it means running on borrowed time against a token Google considers superseded. Cheap to do, invisible when right, and a very confusing bug when wrong.

### 5. Keep-alive against the six-month rule

A daily cron refreshes any access token older than a threshold, so no refresh token ever sits unused long enough to hit the six-month invalidation. Cost is one token endpoint call per account per day — not YouTube quota, since the OAuth token endpoint is not quota-metered.

This also doubles as **early detection**: it surfaces a revoked token within a day of revocation rather than at the moment the user next shares something and expects it to work.

### 6. Make the Testing/Production decision explicit and informed

The deployer records their publishing status in `GOOGLE_OAUTH_PUBLISHING_STATUS`. On `testing`, Later shows a standing warning in the UI and in startup logs: *authorisation will expire in 7 days; here's how to change it.*

This is self-declared. Google exposes no API for an app to read its own publishing status, so Later **asks rather than detects** — the brief allowed either, and detection is not available. Asking is honest; inferring it from a 7-day-old token failure would be inference after the damage.

The recommendation in the docs is unambiguous: **publish to Production.** The unverified-app warning is a one-time click-through for a personal deployment; a token that dies weekly is a broken product.

## Rejected

**Treating `invalid_grant` as retryable.** Guarantees silence exactly when the user most needs a signal.

**Silent re-auth on next web visit.** Better than nothing, and still wrong: the user has no reason to visit the web UI. The whole product thesis is that they never open it.

**Asking every deployer to complete Google verification.** Verification takes weeks and can require a security assessment. Requiring it would make the 15-minute onboarding claim impossible. Unverified Production is the right recommendation for a personal deployment, and verification is documented as the path for anyone who wants to grow past 100 users.

**Detecting publishing status by probing.** The only signal is a token dying after 7 days, which is exactly the outcome we are trying to warn about in advance.

## Consequences

- The token refresh path is one of the most heavily tested parts of the codebase, using the fixture client's injectable failures. `invalid_grant`, 5xx-then-success, and rotation are all covered by tests written **before** real credentials exist — which is what makes §9's "never be blocked" mandate real rather than aspirational.
- Refresh tokens are encrypted at rest with AES-GCM via WebCrypto, keyed by `TOKEN_ENCRYPTION_KEY`. Key management is documented in [SECURITY.md](../../SECURITY.md).
- One extra cron trigger, and one extra token call per account per day.
- Some deployers will still choose Testing. They will be warned in three places; after that it is their call, and the notification path means they will find out in a day rather than a fortnight.

## Revisit if

- **Google changes the 7-day rule**, or exposes publishing status via an API. The latter would let us replace the self-declared env var with detection, which would be strictly better.
- **The keep-alive turns out to be unnecessary** because normal usage already touches tokens often enough. It is cheap insurance against the idle case — a user who stops sharing for a while and expects it to work when they come back.
- **Notification fatigue appears.** If one notification per transition is still too many, the next step is a digest, not silence.
