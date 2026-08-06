# Later

**You're scrolling Reels. A video recommends a YouTube video. Share → Later. It's in your playlist. Done.**

Two taps, no waiting, no app store. Later is a small self-hosted service that takes whatever your phone's share sheet hands it, finds the YouTube video being recommended, and adds it to a YouTube playlist you own.

---

## Read this first: Later cannot write to your real "Watch Later"

**It writes to a normal YouTube playlist called `Later` that it creates for you. It is not your native Watch Later queue.**

This is not a limitation of this project, a missing OAuth scope, or something a future release will fix. On **12 September 2016** Google removed API access to the Watch Later playlist. Today:

- `channels.list` → `contentDetails.relatedPlaylists.watchLater` returns the literal string `"WL"` for every channel
- `playlists.list` and `playlistItems.list` against `WL` return empty lists
- `playlistItems.insert` against `WL` fails

No OAuth scope changes this. There is no supported path, and Later will not use an unsupported one — no headless browsers, no cookie replay, no scraping the YouTube web app. Those break, they violate YouTube's Terms of Service, and they would make this repo unsafe for anyone to deploy. See [ADR-0004](docs/adr/0004-watch-later-is-unreachable.md).

**What you get instead:** a real playlist named `Later` (name configurable), owned by your account, that you can pin in the YouTube app and that syncs everywhere you're signed in. Later gives you a deep link to open it. In practice it does the job; it just isn't the same list.

If that's a dealbreaker, stop here — you'll save yourself 15 minutes.

---

## Status

**Phase 3 code-complete.** Share a YouTube link and it lands in your playlist, deduplicated, with quota tracked and token expiry handled. iOS Shortcut, Android PWA share target, and a Telegram bot all hit the same endpoint. A Reel whose caption only *describes* a video is resolved through oEmbed and an optional LLM — or honestly held for one-tap review when Later is not sure. 454 tests, none of which need credentials.

What is not built yet: multi-user mode and the one-click deploy (Phase 4). Start with [SETUP.md](SETUP.md).

Later is being built in phases, and `main` is kept working at every phase boundary. See [PLAN.md](PLAN.md) for what's built and what's next.

| Phase | What it delivers | Status |
|---|---|---|
| 0 | Verified constraints, ADRs, console prerequisites | ✅ done |
| 1 | The spine: share a YouTube link → it lands in the playlist | ✅ done |
| 2 | iOS Shortcut, Android PWA share target, Telegram bot, notifications | ✅ done |
| 3 | Resolving videos that are *described* but not linked | ✅ done |
| 4 | Multi-user, one-click deploy, docs pass | 🔜 next |

---

## How it works

```
share sheet ──┐
iOS Shortcut ─┤
PWA (Android) ┼──→ POST /api/ingest ──→ 202 Accepted (immediately)
Telegram bot ─┤                              │
web paste box ┘                              ↓
                                    resolution pipeline
                                    ├─ Tier 0  YouTube URL in the text     (free, exact)
                                    ├─ Tier 1  TikTok/Instagram oEmbed     (free, no key)
                                    ├─ Tier 2  LLM reads the caption       (optional)
                                    └─ Tier 3  transcript / OCR            (off by default)
                                              │
                                    confident? ─┬─ yes → add to playlist → notify
                                                └─ no  → review inbox, one tap to confirm
```

The endpoint answers in milliseconds and the work happens after. You never wait on a spinner, and you find out it worked from a notification.

**Most shares never cost a thing.** A TikTok or Reel whose caption contains a YouTube link is handled by Tier 0 — a regex and one cheap lookup. No LLM, no search, no API key beyond YouTube itself. Later works fully with no LLM configured.

## About Gemini

The original instinct behind this project was that YouTube permissions might be easier to reach through Gemini. That is worth correcting plainly, because building on it would waste a lot of time:

- **Gemini cannot grant YouTube write access.** Adding a video to a playlist requires Google OAuth 2.0 with the YouTube Data API v3 scope. Gemini can't grant, proxy, or substitute for that. There is no path.
- **The instinct is half-right about setup, though.** YouTube Data API v3 and the Gemini API live in the *same Google Cloud project*, enabled from the same console in one sitting. The setup genuinely converges — that's almost certainly what prompted the thought.
- **Gemini's real job here is language.** Turning *"that Kurzgesagt video everyone's talking about"* into a search query is exactly what an LLM is for. That's Tier 2 and Tier 3 above, and it's the only place Later uses one — behind an interface, with Gemini as the default, and entirely optional.

See [ADR-0009](docs/adr/0009-llm-provider-and-the-gemini-question.md).

## Deploying it

Later is built so that one person with no budget can run it: **Cloudflare Workers + D1 on the free tier** as the primary target (no card, no cold-start penalty, cron included), and a **`docker compose up`** path for anyone who'd rather self-host. Both are first-class. See [ADR-0002](docs/adr/0002-hosting-cloudflare-workers-primary.md).

Everything is yours: your Google Cloud project, your OAuth client, your keys, your data. Nothing is tied to the author's account, there is no hosted service, and there is **no telemetry of any kind** — not opt-out, just absent.

**[SETUP.md](SETUP.md) walks you through it.** Step 0 takes two minutes and needs no credentials at all:

```bash
git clone https://github.com/alepotger/Later.git && cd Later
pnpm install
USE_FIXTURES=true pnpm dev
```

That runs the whole pipeline against recorded API responses, so you can see exactly what Later does before deciding whether to set up a Google Cloud project. The console work, when you want it, is batched into one ~15-minute sitting in **[docs/ACTION-REQUIRED.md](docs/ACTION-REQUIRED.md)**.

### Two things that will bite you, documented up front

**Your OAuth app will stop working after 7 days if you leave it in "Testing".** Google revokes refresh tokens after 7 days for External apps in Testing status, because the YouTube scope is classified sensitive. Publish to "Production" — you'll still see an "unverified app" warning you can click past, but the tokens stop dying. Later detects this case explicitly and notifies you with a re-auth link rather than failing silently. [ADR-0005](docs/adr/0005-token-lifecycle-and-reauth.md)

**Your daily API quota is 10,000 units and a single search costs 100 of them.** Later is built cheapest-first for this reason, tracks every unit it spends, and when the budget runs out it queues work for tomorrow instead of dropping it. [ADR-0006](docs/adr/0006-quota-strategy.md)

## Documentation

| | |
|---|---|
| [SETUP.md](SETUP.md) | Get it running |
| [clients/](clients/) | Share sheet setup: [iOS](clients/ios/), [Android](clients/android/), [Telegram](clients/telegram/) |
| [PLAN.md](PLAN.md) | Phase plan and current state |
| [docs/ACTION-REQUIRED.md](docs/ACTION-REQUIRED.md) | Console steps only a human can do |
| [docs/adr/](docs/adr/) | Every significant decision, and what would make me revisit it |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | The failure modes above, and how to get out of them |
| [SECURITY.md](SECURITY.md) | Threat model, secret handling, reporting |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to work on this |

## Licence

[MIT](LICENSE).
