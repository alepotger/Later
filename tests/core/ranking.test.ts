/**
 * Ranking and the confidence gate.
 *
 * These tests exist to enforce one rule: never add a low-confidence guess to someone's
 * playlist. Most of them assert that Later *declines* to act — the failure mode this guards
 * against is confident wrongness, not timidity.
 */

import { describe, expect, it } from 'vitest';
import {
  decide,
  rankResults,
  type SearchCandidate,
  type VideoCandidate,
} from '../../src/core/resolve/ranking.ts';
import {
  channelSimilarity,
  containment,
  diceSimilarity,
  normalise,
  titleSimilarity,
  tokenise,
} from '../../src/core/resolve/similarity.ts';

const THRESHOLD = 0.75;

const results = (...rows: [string, string, string][]): SearchCandidate[] =>
  rows.map(([videoId, title, channelTitle]) => ({ videoId, title, channelTitle }));

describe('normalisation', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalise('  Why  Planes, Really-Fly!  ')).toBe('why planes really fly');
  });

  it('strips diacritics so accented spellings still match', () => {
    expect(normalise('Veritásium')).toBe('veritasium');
  });

  it('keeps non-Latin scripts rather than deleting them', () => {
    expect(normalise('강남스타일')).toBe('강남스타일');
  });

  it('drops only genuinely empty stopwords', () => {
    // "why" and "how" start a huge share of explainer titles, so removing them would make
    // those titles collide with each other.
    expect(tokenise('the why of a thing')).toEqual(['why', 'thing']);
  });
});

describe('similarity measures', () => {
  it('scores an exact title as 1', () => {
    expect(titleSimilarity('Why Planes Really Fly', 'Why Planes Really Fly')).toBe(1);
  });

  it('scores a short guess inside a long real title highly', () => {
    expect(titleSimilarity('Gangnam Style', 'PSY - GANGNAM STYLE M/V')).toBeGreaterThan(0.9);
  });

  it('scores unrelated titles near zero', () => {
    expect(titleSimilarity('Why Planes Fly', 'Baking Sourdough At Home')).toBeLessThan(0.15);
  });

  it('handles empty input without dividing by zero', () => {
    expect(diceSimilarity('', 'anything')).toBe(0);
    expect(containment('', '')).toBe(0);
    expect(titleSimilarity('', '')).toBe(0);
  });

  it('treats an exact channel as 1 and an "official" suffix as near-exact', () => {
    expect(channelSimilarity('Veritasium', 'Veritasium')).toBe(1);
    expect(channelSimilarity('Veritasium', 'Veritasium Official')).toBeGreaterThan(0.9);
  });

  it('refuses a weak channel overlap rather than scoring it partially', () => {
    // Short and distinctive: a partial match usually means a different channel, not a sloppy
    // rendering of the same one.
    expect(channelSimilarity('Veritasium', 'Kurzgesagt')).toBe(0);
  });
});

describe('ranking', () => {
  it('puts the best title-and-channel match first', () => {
    const candidate: VideoCandidate = {
      titleGuess: 'why planes fly',
      channelGuess: 'Veritasium',
      confidence: 0.9,
    };
    const ranked = rankResults(
      candidate,
      results(
        ['wrong1', 'How Planes Land Safely', 'Some Aviation Channel'],
        ['right', 'Why Planes Really Fly', 'Veritasium'],
        ['wrong2', 'Why Birds Fly', 'Nature Docs'],
      ),
    );
    expect(ranked[0]?.videoId).toBe('right');
  });

  it('treats the model confidence as a ceiling, not an addend', () => {
    const perfect = results(['v', 'Why Planes Really Fly', 'Veritasium']);
    const sure = rankResults(
      { titleGuess: 'Why Planes Really Fly', channelGuess: 'Veritasium', confidence: 1 },
      perfect,
    );
    const unsure = rankResults(
      { titleGuess: 'Why Planes Really Fly', channelGuess: 'Veritasium', confidence: 0.4 },
      perfect,
    );
    expect(sure[0]?.confidence).toBeGreaterThan(unsure[0]?.confidence ?? 1);
    expect(unsure[0]?.confidence).toBeLessThanOrEqual(0.4);
  });

  it('lets title carry full weight when no channel was guessed', () => {
    const ranked = rankResults(
      { titleGuess: 'Why Planes Really Fly', confidence: 1 },
      results(['v', 'Why Planes Really Fly', 'Anyone']),
    );
    // Without this, a missing channel guess would silently halve every score.
    expect(ranked[0]?.confidence).toBeGreaterThan(0.9);
  });

  it('applies only a small penalty for search position', () => {
    const ranked = rankResults(
      { titleGuess: 'Exact Title Here', confidence: 1 },
      results(['first', 'Completely Different Thing', 'X'], ['second', 'Exact Title Here', 'Y']),
    );
    // YouTube's own ordering is a weak signal about which video was *meant*.
    expect(ranked[0]?.videoId).toBe('second');
  });

  it('returns an empty list for no results rather than throwing', () => {
    expect(rankResults({ titleGuess: 'x', confidence: 1 }, [])).toEqual([]);
  });

  it('clamps a nonsensical model confidence', () => {
    const ranked = rankResults(
      { titleGuess: 'Exact', confidence: 99 },
      results(['v', 'Exact', 'C']),
    );
    expect(ranked[0]?.confidence).toBeLessThanOrEqual(1);

    const nan = rankResults(
      { titleGuess: 'Exact', confidence: Number.NaN },
      results(['v', 'Exact', 'C']),
    );
    expect(nan[0]?.confidence).toBe(0);
  });
});

describe('the decision gate', () => {
  it('adds a confident, corroborated match', () => {
    const ranked = rankResults(
      { titleGuess: 'Why Planes Really Fly', channelGuess: 'Veritasium', confidence: 0.95 },
      results(['right', 'Why Planes Really Fly', 'Veritasium']),
    );
    const decision = decide(ranked, THRESHOLD);
    expect(decision.action).toBe('add');
  });

  it('holds for review when the model was unsure, even with a good match', () => {
    const ranked = rankResults(
      { titleGuess: 'Why Planes Really Fly', channelGuess: 'Veritasium', confidence: 0.5 },
      results(['right', 'Why Planes Really Fly', 'Veritasium']),
    );
    expect(decide(ranked, THRESHOLD).action).toBe('review');
  });

  it('holds for review when the channel matched but the title did not', () => {
    // The classic wrong-video-right-channel failure: high arithmetic, wrong answer.
    const ranked = rankResults(
      { titleGuess: 'Why Planes Really Fly', channelGuess: 'Veritasium', confidence: 1 },
      results(['other', 'The Simplest Math Problem No One Can Solve', 'Veritasium']),
    );
    const decision = decide(ranked, 0.3);
    expect(decision.action).toBe('review');
    if (decision.action === 'review')
      expect(decision.reason).toMatch(/title does not clearly match/);
  });

  it('holds for review when two results match about equally well', () => {
    const ranked = rankResults(
      { titleGuess: 'Learn Python', confidence: 0.7 },
      results(['a', 'Learn Python', 'Channel A'], ['b', 'Learn Python', 'Channel B']),
    );
    const decision = decide(ranked, 0.95);
    expect(decision.action).toBe('review');
    if (decision.action === 'review') expect(decision.reason).toMatch(/about equally well/);
  });

  it('gives up rather than guessing when nothing resembles the description', () => {
    const ranked = rankResults(
      { titleGuess: 'Why Planes Really Fly', channelGuess: 'Veritasium', confidence: 0.9 },
      results(['x', 'Sourdough For Beginners', 'Bread Channel']),
    );
    expect(decide(ranked, THRESHOLD).action).toBe('give_up');
  });

  it('gives up on no results at all', () => {
    expect(decide([], THRESHOLD).action).toBe('give_up');
  });

  it('never adds anything below the threshold, at any threshold', () => {
    const ranked = rankResults(
      { titleGuess: 'Why Planes Really Fly', channelGuess: 'Veritasium', confidence: 0.8 },
      results(['right', 'Why Planes Really Fly', 'Veritasium']),
    );
    const best = ranked[0]?.confidence ?? 0;
    // Just above the achievable score: must not add.
    expect(decide(ranked, Math.min(1, best + 0.01)).action).not.toBe('add');
    // Just below: may add.
    expect(decide(ranked, Math.max(0, best - 0.01)).action).toBe('add');
  });

  it('a threshold of 1.0 means only a perfect corroborated match is ever auto-added', () => {
    const good = rankResults(
      { titleGuess: 'Why Planes Really Fly', channelGuess: 'Veritasium', confidence: 0.99 },
      results(['right', 'Why Planes Really Fly', 'Veritasium']),
    );
    expect(decide(good, 1).action).not.toBe('add');
  });
});
