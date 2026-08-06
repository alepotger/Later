import { randomToken } from '../core/bytes.ts';

/**
 * Primary keys.
 *
 * Random rather than sequential, because item IDs appear in URLs (the review inbox) and a
 * sequential ID there would let anyone enumerate someone else's shares.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomToken(12)}`;
}
