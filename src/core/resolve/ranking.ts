/**
 * Ranking search results against an LLM's guess, and deciding whether to trust the answer.
 *
 * The rule this module exists to enforce: **the LLM never picks the video.** It produces
 * candidate descriptions; the video ID always comes from `search.list`, and a result only wins
 * if it actually resembles what was described. A hallucinated video ID cannot reach a playlist
 * because we never accept one.
 *
 * Pure. No network, no LLM, no clock. See docs/adr/0009.
 */

import { channelSimilarity, titleSimilarity } from './similarity.ts';

/** What an LLM proposes: a description of a video, never an ID. */
export interface VideoCandidate {
  titleGuess: string;
  channelGuess?: string | undefined;
  topic?: string | undefined;
  /** The model's own confidence, 0..1. Treated as a ceiling, never as the answer. */
  confidence: number;
}

export interface SearchCandidate {
  videoId: string;
  title: string;
  channelTitle: string;
}

export interface RankedResult {
  videoId: string;
  title: string;
  channelTitle: string;
  /** Final confidence, 0..1. This is what the threshold is applied to. */
  confidence: number;
  titleScore: number;
  channelScore: number;
  /** Position in the original search results, 0-based. */
  rank: number;
}

/**
 * How much a channel match matters when the LLM offered one.
 *
 * Weighted heavily because channel is the strongest disambiguator in practice: dozens of
 * videos share a title like "Why Planes Fly", and the channel is what tells them apart.
 */
const CHANNEL_WEIGHT = 0.45;
const TITLE_WEIGHT = 0.55;

/**
 * Small penalty for results further down the search list.
 *
 * Deliberately small — YouTube's own ranking is a weak signal about *which* video was meant,
 * and letting it dominate would just reproduce "first result wins", which is exactly the
 * behaviour that puts wrong videos in playlists.
 */
function rankPenalty(rank: number): number {
  return Math.min(0.06, rank * 0.015);
}

export function rankResults(candidate: VideoCandidate, results: SearchCandidate[]): RankedResult[] {
  const modelCeiling = clamp01(candidate.confidence);

  const ranked = results.map((result, rank): RankedResult => {
    const titleScore = titleSimilarity(candidate.titleGuess, result.title);

    const hasChannelGuess = Boolean(candidate.channelGuess?.trim());
    const channelScore = hasChannelGuess
      ? channelSimilarity(candidate.channelGuess ?? '', result.channelTitle)
      : 0;

    // Without a channel guess, title carries the whole weight rather than being scaled down
    // by a channel score that was never available.
    const match = hasChannelGuess
      ? titleScore * TITLE_WEIGHT + channelScore * CHANNEL_WEIGHT
      : titleScore;

    // The model's confidence is a ceiling, not an addend: a model that is sure about a video
    // we cannot corroborate should still score low.
    const confidence = clamp01(modelCeiling * match - rankPenalty(rank));

    return {
      videoId: result.videoId,
      title: result.title,
      channelTitle: result.channelTitle,
      confidence,
      titleScore,
      channelScore,
      rank,
    };
  });

  return ranked.sort((a, b) => b.confidence - a.confidence || a.rank - b.rank);
}

export type ResolutionDecision =
  | { action: 'add'; result: RankedResult }
  | { action: 'review'; result: RankedResult; reason: string }
  | { action: 'give_up'; reason: string };

/**
 * Decide what to do with the ranked results.
 *
 * Three outcomes, and the middle one is the important one: below the threshold an item is
 * *held for review*, never added. A wrong video in someone's playlist destroys trust faster
 * than a missing right one, so the bias is always towards asking.
 */
export function decide(ranked: RankedResult[], threshold: number): ResolutionDecision {
  const best = ranked[0];
  if (!best) return { action: 'give_up', reason: 'No search results matched that description.' };

  if (best.confidence >= threshold) {
    // One more guard: a strong overall score built on a weak title match usually means the
    // channel matched and the video did not, which is the classic wrong-video-right-channel
    // failure. Send it to review rather than trusting the arithmetic.
    if (best.titleScore < 0.34) {
      return {
        action: 'review',
        result: best,
        reason: 'The channel looks right but the title does not clearly match.',
      };
    }
    return { action: 'add', result: best };
  }

  // A near-tie between the top two means the description did not distinguish them, which is
  // exactly when a human glance is worth more than a coin flip.
  const runnerUp = ranked[1];
  if (runnerUp && best.confidence - runnerUp.confidence < 0.05 && best.confidence > 0.2) {
    return {
      action: 'review',
      result: best,
      reason: 'Two videos matched that description about equally well.',
    };
  }

  if (best.confidence <= 0.15) {
    return {
      action: 'give_up',
      reason: 'Nothing on YouTube matched that description closely enough to guess.',
    };
  }

  return {
    action: 'review',
    result: best,
    reason: 'Not confident enough to add this automatically.',
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
