/**
 * Tiers 1 and 2 of the resolution pipeline.
 *
 * Ordered by cost, cheapest first, stopping at the first confident answer:
 *
 *   Tier 1 — read the TikTok/Instagram caption via oEmbed, then re-run Tier 0 on it.
 *            Zero YouTube quota. Resolves the very common "Reel whose caption has the link".
 *   Tier 2 — an LLM turns prose into candidate descriptions, then ONE `search.list` (100 units)
 *            finds real videos, which are ranked against the description.
 *
 * The LLM never picks the video. It describes; `search.list` identifies; the ranker decides
 * whether the two agree well enough to trust. See docs/adr/0006 and 0009.
 */

import type { PlatformMetadataPort } from '../adapters/platform/oembed.ts';
import { resolveShortlink } from '../adapters/platform/oembed.ts';
import type { Config } from '../config.ts';
import { decide, type RankedResult, rankResults } from '../core/resolve/ranking.ts';
import type { PlatformLink } from '../core/types.ts';
import { extractFromText } from '../core/urls/extract.ts';
import type { LlmPort } from '../ports/llm.ts';
import type { Logger } from '../ports/logger.ts';
import type { YouTubeClient } from '../ports/youtube.ts';

export interface TierDeps {
  config: Config;
  logger: Logger;
  youtube: YouTubeClient;
  llm: LlmPort;
  platform: PlatformMetadataPort;
  fetch?: typeof fetch;
}

export type TierOutcome =
  /** Resolved with enough confidence to add straight away. */
  | { kind: 'video'; videoId: string; tier: number; confidence: number }
  /** Resolved, but not confidently enough. Hold it for one tap. */
  | {
      kind: 'review';
      videoId: string;
      tier: number;
      confidence: number;
      guess: string;
      reason: string;
    }
  /** Nothing found. Say so honestly rather than guessing. */
  | { kind: 'none'; reason: string };

/**
 * Try the higher tiers in cost order.
 *
 * `text` is the raw share. Tier 0 has already failed on it by the time this is called.
 */
export async function resolveHigherTiers(deps: TierDeps, text: string): Promise<TierOutcome> {
  const extraction = extractFromText(text);

  // ─── Tier 1: platform captions, free ──────────────────────────────────────
  const captions: string[] = [];

  if (deps.config.resolve.enablePlatformMetadata && extraction.platformLinks.length > 0) {
    for (const link of extraction.platformLinks.slice(0, 3)) {
      const caption = await fetchCaption(deps, link);
      if (!caption) continue;
      captions.push(caption);

      // The caption often *contains* the YouTube link outright. That is a Tier 0 hit reached
      // through Tier 1, and it costs nothing beyond the oEmbed call.
      const fromCaption = extractFromText(caption).videos[0];
      if (fromCaption) {
        deps.logger.info('resolved via platform caption', {
          tier: 1,
          platform: link.platform,
          videoId: fromCaption.videoId,
        });
        return { kind: 'video', videoId: fromCaption.videoId, tier: 1, confidence: 1 };
      }
    }
  }

  // ─── Tier 2: language understanding, 100 units ────────────────────────────
  if (deps.config.llm.provider === 'none') {
    return {
      kind: 'none',
      reason:
        captions.length > 0
          ? 'That post has no YouTube link in its caption. Configure an LLM provider to let Later work out which video it means.'
          : 'No YouTube link found, and no LLM provider is configured to interpret a description.',
    };
  }

  // Feed the model the caption as well as the original text — the caption is usually where the
  // actual recommendation lives, and the share text is often just "check this out".
  const combined = [text, ...captions].join('\n\n').trim();
  const platform = extraction.platformLinks[0]?.platform;

  const candidates = await deps.llm.extractCandidates({
    text: combined,
    platform: platform ?? 'unknown',
  });

  const best = candidates[0];
  if (!best) {
    return {
      kind: 'none',
      reason: 'Could not work out which video that refers to.',
    };
  }

  // One search, for the best candidate only. At 100 units each, trying every candidate would
  // burn the daily budget in a dozen shares.
  const query = [best.titleGuess, best.channelGuess].filter(Boolean).join(' ');
  const results = await deps.youtube.search(query, 8);

  const ranked = rankResults(best, results);
  const decision = decide(ranked, deps.config.resolve.confidenceThreshold);

  if (decision.action === 'add') {
    logRanking(deps.logger, 'resolved via search', query, decision.result);
    return {
      kind: 'video',
      videoId: decision.result.videoId,
      tier: 2,
      confidence: decision.result.confidence,
    };
  }

  if (decision.action === 'review') {
    logRanking(deps.logger, 'held for review', query, decision.result);
    return {
      kind: 'review',
      videoId: decision.result.videoId,
      tier: 2,
      confidence: decision.result.confidence,
      guess: decision.result.title,
      reason: decision.reason,
    };
  }

  deps.logger.info('gave up rather than guessing', { tier: 2, query, results: results.length });
  return { kind: 'none', reason: decision.reason };
}

async function fetchCaption(deps: TierDeps, link: PlatformLink): Promise<string | null> {
  let url = link.url;

  // A vm./vt. link is opaque; oEmbed needs the canonical URL behind it.
  if (link.isShortlink) {
    const resolved = await resolveShortlink(url, {
      logger: deps.logger,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    if (resolved) url = resolved;
  }

  const metadata = await deps.platform.fetchMetadata(url, link.platform);
  if (!metadata) {
    deps.logger.debug('no platform metadata available', { platform: link.platform });
    return null;
  }

  return [metadata.text, metadata.authorName].filter(Boolean).join(' — ') || null;
}

function logRanking(logger: Logger, message: string, query: string, result: RankedResult): void {
  logger.info(message, {
    tier: 2,
    query,
    videoId: result.videoId,
    confidence: Number(result.confidence.toFixed(3)),
    titleScore: Number(result.titleScore.toFixed(3)),
    channelScore: Number(result.channelScore.toFixed(3)),
    rank: result.rank,
  });
}
