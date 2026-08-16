# Later

[![CI](https://github.com/alepotger/Later/actions/workflows/ci.yml/badge.svg)](https://github.com/alepotger/Later/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![No telemetry](https://img.shields.io/badge/telemetry-none-brightgreen.svg)](SECURITY.md#no-telemetry)

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

**Phase 4 code-complete.** Share a YouTube link and it lands in your playlist, deduplicated, with quota tracked and token expiry handled. iOS Shortcut, Android PWA share target, and a Telegram bot all hit the same endpoint. A Reel whose caption only *describes* a video is resolved through oEmbed and an optional LLM — or honestly held for one-tap review when Later is not sure. Deploy it with one button or one `docker compose up`, for yourself or for a household. 495 tests, none of which need credentials.

Start with [SETUP.md](SETUP.md) to run it locally, or [DEPLOY.md](DEPLOY.md) to put it somewhere your phone can reach.

**Not yet verified against a live deployment:** the author has not yet run a real Google OAuth round-trip or built the Docker image on a machine with a Docker daemon. Both are written and covered by tests against stubs; neither has been observed working end to end with real credentials. Tracked in [PLAN.md](PLAN.md) and [docs/verification-log.md](docs/verification-log.md).

Later is being built in phases, and `main` is kept working at every phase boundary. See [PLAN.md](PLAN.md) for what's built and what's next.

| Phase | What it delivers | Status |
|---|---|---|
| 0 | Verified constraints, ADRs, console prerequisites | ✅ done |
| 1 | The spine: share a YouTube link → it lands in the playlist | ✅ done |
| 2 | iOS Shortcut, Android PWA share target, Telegram bot, notifications | ✅ done |
| 3 | Resolving videos that are *described* but not linked | ✅ done |
| 4 | Multi-user, one-click deploy, docs pass | ✅ done |

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

**One instance, or one per household.** `SOLO` is the default: one Google account, locked to the first person who authorises. `LATER_MODE=MULTI` lets several people on an email allowlist each connect their own account and write to their own playlist — sharing, unavoidably, one daily API quota. [ADR-0013](docs/adr/0013-solo-and-multi-modes.md).

## About Gemini

The original instinct behind this project was that YouTube permissions might be easier to reach through Gemini. That is worth correcting plainly, because building on it would waste a lot of time:

- **Gemini cannot grant YouTube write access.** Adding a video to a playlist requires Google OAuth 2.0 with the YouTube Data API v3 scope. Gemini can't grant, proxy, or substitute for that. There is no path.
- **The instinct is half-right about setup, though.** YouTube Data API v3 and the Gemini API live in the *same Google Cloud project*, enabled from the same console in one sitting. The setup genuinely converges — that's almost certainly what prompted the thought.
- **Gemini's real job here is language.** Turning *"that Kurzgesagt video everyone's talking about"* into a search query is exactly what an LLM is for. That's Tier 2 and Tier 3 above, and it's the only place Later uses one — behind an interface, with Gemini as the default, and entirely optional.

See [ADR-0009](docs/adr/0009-llm-provider-and-the-gemini-question.md).

## Deploying it

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alepotger/Later)

```bash
docker compose up -d --build     # or self-host, if you'd rather
```

Later is built so that one person with no budget can run it: **Cloudflare Workers + D1 on the free tier** as the primary target (no card, no cold-start penalty, cron included), and a **Docker** path for anyone who'd rather self-host. Both are first-class. See [DEPLOY.md](DEPLOY.md) and [ADR-0002](docs/adr/0002-hosting-cloudflare-workers-primary.md).

The button copies this repository into *your* GitHub account, creates the D1 database, and deploys. You still need your own Google OAuth client first — [Batch 1](docs/ACTION-REQUIRED.md) is the 15-minute console sitting that produces it.

### "Can I just use your instance?"

**There isn't one, and there won't be.** Not reluctance — the platform makes it impossible:

- Google caps an unverified OAuth app at **100 users**. Getting past that needs a security assessment that can take weeks.
- The **10,000-unit daily quota belongs to the Google Cloud project**, not the user. One shared instance means ~190 saved videos per *day, in total, across everyone* — about what one enthusiastic person uses alone.
- Later refuses open registration by design. Even `MULTI` mode requires an explicit email allowlist, because a URL that anyone can find and attach their Google account to is not a feature ([ADR-0013](docs/adr/0013-solo-and-multi-modes.md)).

So Later is self-hosted, and that is the point rather than a compromise. Your Google Cloud project, your OAuth client, your quota, your database, your playlist. Nobody — including me — can see what you save, because there is nowhere central for it to go.

Deploying your own is one button and about 15 minutes, most of which is Google's console.

Everything is yours: your Google Cloud project, your OAuth client, your keys, your data. Nothing is tied to the author's account, there is no hosted service, and there is **no telemetry of any kind** — not opt-out, just absent.

**[SETUP.md](SETUP.md) walks you through it.** Step 0 takes two minutes and needs no credentials at all:

```bash
git clone https://github.com/alepotger/Later.git && cd Later
pnpm install
USE_FIXTURES=true pnpm dev
```

When you want the real thing, `pnpm setup` generates your secrets and `pnpm deploy:cloudflare` does the whole Cloudflare deploy. The only parts left for a human are the two browser sessions nobody can do on your behalf: creating a Google OAuth client, and registering the redirect URI against it.

That runs the whole pipeline against recorded API responses, so you can see exactly what Later does before deciding whether to set up a Google Cloud project. The console work, when you want it, is batched into one ~15-minute sitting in **[docs/ACTION-REQUIRED.md](docs/ACTION-REQUIRED.md)**.

### Two things that will bite you, documented up front

**Your OAuth app will stop working after 7 days if you leave it in "Testing".** Google revokes refresh tokens after 7 days for External apps in Testing status, because the YouTube scope is classified sensitive. Publish to "Production" — you'll still see an "unverified app" warning you can click past, but the tokens stop dying. Later detects this case explicitly and notifies you with a re-auth link rather than failing silently. [ADR-0005](docs/adr/0005-token-lifecycle-and-reauth.md)

**Your daily API quota is 10,000 units and a single search costs 100 of them.** Later is built cheapest-first for this reason, tracks every unit it spends, and when the budget runs out it queues work for tomorrow instead of dropping it. [ADR-0006](docs/adr/0006-quota-strategy.md)

## Documentation

| | |
|---|---|
| [SETUP.md](SETUP.md) | Get it running locally |
| [DEPLOY.md](DEPLOY.md) | Cloudflare or Docker, and SOLO vs MULTI |
| [clients/](clients/) | Share sheet setup: [iOS](clients/ios/), [Android](clients/android/), [Telegram](clients/telegram/) |
| [PLAN.md](PLAN.md) | Phase plan and current state |
| [docs/ACTION-REQUIRED.md](docs/ACTION-REQUIRED.md) | Console steps only a human can do |
| [docs/adr/](docs/adr/) | Every significant decision, and what would make me revisit it |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | The failure modes above, and how to get out of them |
| [SECURITY.md](SECURITY.md) | Threat model, secret handling, reporting |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to work on this |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Be decent to people; the longer version |

## Contributing

Issues and pull requests are welcome. The most valuable report you can file is **a URL form Tier 0 failed to recognise** — it becomes a permanent test fixture, and it turns a 151-unit search back into a 51-unit save for everyone. There is [an issue template](.github/ISSUE_TEMPLATE/1-url-not-recognised.yml) just for that.

Before proposing a feature, please read the [anti-goals](PLAN.md#anti-goals--deliberately-not-built). Some things are deliberately not built and the reasoning is written down, so nobody has to argue it twice. Arguing the reasoning is fair game; every ADR ends with a **"Revisit if"** section for exactly that.

[CONTRIBUTING.md](CONTRIBUTING.md) has the rules that actually matter — chiefly that the core stays pure, that nothing calls YouTube without declaring a quota cost, and that no low-confidence guess ever reaches someone's playlist.

## Licence

[MIT](LICENSE). Fork it, deploy it, change it, sell it — but if you redistribute it, keep the honesty about Watch Later. Someone will otherwise waste an afternoon finding out.
