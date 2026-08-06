# ADR-0009 — Gemini as the default LLM, behind an interface, always optional

**Status:** accepted · **Date:** 2026-08-05

## Context

The brief records the owner's original instinct: *"permissions to YouTube may be better reached via Google Gemini."* It asks that this be corrected rather than silently designed around. The correction matters, because building on the premise would waste real time chasing a path that does not exist.

**Gemini cannot grant YouTube write access.** Adding a video to a playlist requires an OAuth 2.0 access token minted for a client that requested the `https://www.googleapis.com/auth/youtube` scope, with the user's consent, presented to `youtube.googleapis.com`. Gemini is a text-generation API reached with an API key. It has no user-consent model, issues no OAuth tokens, and proxies no other Google API's authorisation. There is no configuration, agent tool, or extension where "having Gemini" reduces the YouTube OAuth requirement by one step.

**But the instinct is half-right, and it's worth being precise about which half.** YouTube Data API v3 and the Gemini API are enabled in the *same Google Cloud project*, from the same console, in the same sitting — see [ACTION-REQUIRED.md](../ACTION-REQUIRED.md), where they are literally adjacent steps. The setup paths converge even though the authorisation models don't. That is almost certainly what prompted the thought, and it's a reasonable thing to have half-inferred from the console.

Where an LLM *does* earn its place is the actual hard problem. A Reel caption says *"this Veritasium video on why planes fly is incredible"* with no link anywhere. Turning that into `{title_guess, channel_guess, topic, confidence}` is a language problem, and it is the one part of this pipeline that regexes genuinely cannot do.

## Decision

**An `LlmPort` interface with exactly one method. Gemini is the default implementation. The whole layer is optional and the product works fully without it.**

```ts
interface LlmPort {
  extractCandidates(input: {
    text: string;
    platform?: 'tiktok' | 'instagram' | 'unknown';
  }): Promise<VideoCandidate[]>;   // { titleGuess, channelGuess, topic, confidence }
}
```

One method, structured output, no chat, no tools, no memory, no agent loop. §12 rules out an "AI agent framework abstraction layer" and it is right to: this is a pipeline, and the LLM is a function inside it that turns prose into candidate structs.

Shipped implementations:

| `LLM_PROVIDER` | Behaviour |
|---|---|
| `none` (**default**) | Tier 2 disabled. Tiers 0/1 work. Unresolvable items go to the review inbox. |
| `gemini` | `generativelanguage.googleapis.com` REST, API key header, JSON-constrained response |
| `openai-compatible` | any base URL speaking the chat-completions shape — Ollama, OpenRouter, LM Studio, OpenAI |
| `fixture` | canned responses. Used in tests and dev; no key, no network. |

**Gemini is the default choice when a provider is configured**, for reasons specific to this project rather than model quality:

- Free tier covers the Flash models with no card required — the free-tier mandate again
- **Same Google Cloud project the deployer already made for YouTube.** One extra click during a session they're already having. For a public repo optimising onboarding, this is the deciding factor.
- Plain REST with an API-key header, so it works under ADR-0001's Web-standard constraint with no SDK

`none` is the default *value* because §8 requires that an API key never be a hard requirement, and because Tier 0 alone handles the majority of real shares. Someone who deploys Later without ever reading about LLMs gets a working product.

### Guardrails on the LLM's output

The model proposes; it never disposes:

1. **Output is validated, not trusted.** Response parsed and schema-checked; a malformed response is a Tier 2 miss, not a crash.
2. **The LLM never picks the video.** It produces search *candidates*. The video ID comes from `search.list`, then ranking by title/channel similarity against the candidate. A hallucinated video ID can't reach the playlist because we never accept one.
3. **Confidence gates the write.** Below `RESOLVE_CONFIDENCE_THRESHOLD` (default 0.75) → review inbox, one tap to confirm. Never auto-add a guess. Polluting a playlist destroys trust faster than failing to add something.
4. **Shared text is data, not instructions.** Captions are attacker-controllable in the general case — anyone can write a caption. The prompt is structured so caption text is a delimited input field, and since the only consumable output is a candidate struct that must then survive search-and-rank, prompt injection has no privileged action available to it.
5. **One call per item, maximum.** No retry loops, no multi-turn refinement. Cost and latency stay bounded and predictable.

## Rejected

**Using Gemini to obtain YouTube access.** Not possible. Documented here and in the README so it isn't re-attempted.

**An LLM as the primary resolver, for every share.** Slower, costlier, non-deterministic, and worse than a regex at the one job that matters most — a URL sitting in the text. Tier 0 must stay first.

**Making an LLM key mandatory.** Forbidden by §8 and wrong on its own merits: it would put a second API signup between a stranger and their first saved video.

**An agent framework** (LangChain, tool-calling loop, multi-step planner). One prompt, one structured response. Anything more is the speculative generality §12 rules out.

**OpenAI as default.** Comparable or better at the task; needs a card, and a second vendor relationship for a deployer who already has a Google Cloud project open. Available via `openai-compatible` for anyone who wants it.

**Local models as default** (Ollama). Free and private, and unavailable to someone deploying to a free serverless tier. Supported through the same `openai-compatible` adapter, which is the right amount of effort for it.

## Consequences

- The provider-agnostic seam is one interface with one method, so "swap the provider" is a real capability rather than a claim. `fixture` means Tier 2 logic — including ranking and confidence — is fully testable with no key and no network, which is what keeps §9's mandate true for Phase 3.
- Tier 2 needs `GEMINI_API_KEY`, which means a console step. It is in Batch 3, deliberately after the product already works, so nobody is blocked on it.
- Provider differences in structured-output support have to be handled per adapter. Gemini has a JSON response mode; the OpenAI-compatible path can't assume one and must tolerate prose-wrapped JSON. Contained inside the adapters.
- The default being `none` means a deployer who wants Tier 2 has to opt in and will read one paragraph to find out why. Correct trade.

## Revisit if

- **Tier 0 + Tier 1 coverage turns out to be near-total** in real usage — then Tier 2 is a rarely-used luxury and could be trimmed rather than extended. Worth measuring locally before extending Tier 3.
- **Gemini's free tier changes**, or Flash models leave it. Then the default flips to whatever is free with no card, and existing deployers are unaffected since it's config.
- **Structured output diverges** enough between providers that one interface stops fitting cleanly.
