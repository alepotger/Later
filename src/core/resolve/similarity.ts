/**
 * Text similarity for ranking search results.
 *
 * Pure, so the ranking behaviour is testable without a network or an LLM. This is the code
 * that decides whether an LLM's guess is close enough to a real video to be trusted, so it is
 * deliberately conservative: it would rather score a correct match at 0.7 than score a wrong
 * one at 0.9.
 */

/**
 * Words too common to carry signal in a video title.
 *
 * Kept short on purpose. An aggressive stopword list starts removing words that genuinely
 * distinguish titles — "how", "why", and "what" are the first words of a great many
 * explainer videos, and dropping them makes those titles collide with each other.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'and',
  'or',
  'is',
  'it',
  'this',
  'that',
  'with',
  'from',
  'by',
]);

/** Lower-case, strip punctuation and diacritics, collapse whitespace. */
export function normalise(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // strip combining marks, so "Veritásium" ≈ "Veritasium"
      // Re-compose. NFD was only wanted for the diacritic strip above; leaving it decomposed
      // would also split Hangul into Jamo and hand back text that looks identical to its
      // input but is not equal to it.
      .normalize('NFC')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function tokenise(text: string): string[] {
  return normalise(text)
    .split(' ')
    .filter((word) => word.length > 0 && !STOPWORDS.has(word));
}

/**
 * Dice coefficient over token sets: `2|A∩B| / (|A|+|B|)`.
 *
 * Chosen over Jaccard because it is more forgiving of length differences, and search results
 * routinely carry more words than a guess does — "Why Planes Fly" against "Why Planes Really
 * Fly - The Full Story" should score well, and Jaccard punishes that harder than it deserves.
 */
export function diceSimilarity(a: string, b: string): number {
  const left = new Set(tokenise(a));
  const right = new Set(tokenise(b));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * How well one string is contained in another, as a fraction of the shorter one's tokens.
 *
 * Complements Dice for the very common case where a guess is a short fragment of a long
 * title. Dice alone would score "Gangnam Style" against "PSY - GANGNAM STYLE (강남스타일) M/V"
 * poorly purely because the real title has more tokens.
 */
export function containment(a: string, b: string): number {
  const left = new Set(tokenise(a));
  const right = new Set(tokenise(b));
  if (left.size === 0 || right.size === 0) return 0;

  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const token of smaller) if (larger.has(token)) shared += 1;
  return shared / smaller.size;
}

/** Combined title similarity, taking the more generous of the two measures. */
export function titleSimilarity(guess: string, actual: string): number {
  return Math.max(diceSimilarity(guess, actual), containment(guess, actual));
}

/**
 * Channel similarity.
 *
 * Stricter than title matching, and deliberately so: channel names are short and distinctive,
 * so a partial match usually means a *different* channel rather than a sloppy rendering of the
 * same one. "Veritasium" and "Veritasium Español" are not the same channel.
 */
export function channelSimilarity(guess: string, actual: string): number {
  const a = normalise(guess);
  const b = normalise(actual);
  if (a === '' || b === '') return 0;
  if (a === b) return 1;

  // Handles "veritasium" vs "veritasium official" and the @handle form.
  const stripped = (s: string) => s.replace(/\b(official|channel|tv|hd)\b/g, '').trim();
  if (stripped(a) === stripped(b)) return 0.95;

  const dice = diceSimilarity(a, b);
  // Below a real overlap, treat it as a different channel rather than a weak match.
  return dice >= 0.5 ? dice : 0;
}
