import { describe, expect, it } from 'vitest';
import { extractFromText, hasVideos } from '../../../src/core/urls/extract.ts';
import { trimTrailingPunctuation } from '../../../src/core/urls/find.ts';
import { decodeHtmlEntities, normaliseText } from '../../../src/core/urls/text.ts';
import { parseTimeOffset } from '../../../src/core/urls/youtube.ts';
import { fixtures, ID } from './fixtures.ts';

describe('extractFromText fixtures', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const result = extractFromText(fixture.input);

      if (fixture.videos !== undefined) {
        expect(result.videos.map((v) => v.videoId)).toEqual(fixture.videos);
      }
      if (fixture.starts !== undefined) {
        expect(result.videos.map((v) => v.startSeconds)).toEqual(fixture.starts);
      }
      if (fixture.playlists !== undefined) {
        expect(result.playlists.map((p) => p.playlistId)).toEqual(fixture.playlists);
      }
      if (fixture.channels !== undefined) {
        expect(result.channels.map((c) => c.ref)).toEqual(fixture.channels);
      }
      if (fixture.platforms !== undefined) {
        expect(
          result.platformLinks.map((p) => ({ platform: p.platform, isShortlink: p.isShortlink })),
        ).toEqual(fixture.platforms);
      }
      if (fixture.others !== undefined) {
        expect(result.otherUrls).toHaveLength(fixture.others);
      }
    });
  }
});

describe('canonical URL construction', () => {
  it('rebuilds the watch URL from the ID, so tracking params cannot survive', () => {
    const { videos } = extractFromText(
      `https://www.youtube.com/watch?v=${ID}&si=abc&utm_source=ig&feature=share&pp=xyz`,
    );
    expect(videos[0]?.canonicalUrl).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });

  it('keeps the original URL for provenance', () => {
    const source = `https://youtu.be/${ID}?si=abc`;
    const { videos } = extractFromText(source);
    expect(videos[0]?.sourceUrl).toBe(source);
  });

  it('records the unwrapped URL as the source, not the redirector', () => {
    const { videos } = extractFromText(`https://l.instagram.com/?u=https%3A%2F%2Fyoutu.be%2F${ID}`);
    expect(videos[0]?.sourceUrl).toBe(`https://youtu.be/${ID}`);
  });
});

describe('hasVideos', () => {
  it('is true when Tier 0 resolved something', () => {
    expect(hasVideos(extractFromText(`youtu.be/${ID}`))).toBe(true);
  });

  it('is false for a caption that only describes a video', () => {
    expect(hasVideos(extractFromText('that Kurzgesagt one about black holes'))).toBe(false);
  });
});

describe('parseTimeOffset', () => {
  const cases: [string, number | undefined][] = [
    ['42', 42],
    ['42s', 42],
    ['0', 0],
    ['90s', 90],
    ['1m30s', 90],
    ['2m', 120],
    ['1h', 3600],
    ['1h2m3s', 3723],
    ['1h30m', 5400],
    ['', undefined],
    ['   ', undefined],
    ['banana', undefined],
    ['12x', undefined],
    ['-5', undefined],
    ['1.5', undefined],
  ];

  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)} as ${String(expected)}`, () => {
      expect(parseTimeOffset(input)).toBe(expected);
    });
  }
});

describe('trimTrailingPunctuation', () => {
  it('strips sentence punctuation', () => {
    expect(trimTrailingPunctuation('https://youtu.be/abc.')).toBe('https://youtu.be/abc');
    expect(trimTrailingPunctuation('https://youtu.be/abc!?')).toBe('https://youtu.be/abc');
  });

  it('strips an unbalanced closing paren but keeps a balanced one', () => {
    expect(trimTrailingPunctuation('https://e.com/a)')).toBe('https://e.com/a');
    expect(trimTrailingPunctuation('https://e.com/a_(b)')).toBe('https://e.com/a_(b)');
  });

  it('never strips hyphens or underscores, which are legal in video IDs', () => {
    expect(trimTrailingPunctuation('https://youtu.be/abcdefghij-')).toBe(
      'https://youtu.be/abcdefghij-',
    );
    expect(trimTrailingPunctuation('https://youtu.be/abcdefghij_')).toBe(
      'https://youtu.be/abcdefghij_',
    );
  });
});

describe('text normalisation', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeHtmlEntities('a&amp;b')).toBe('a&b');
    expect(decodeHtmlEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeHtmlEntities('&#63;')).toBe('?');
    expect(decodeHtmlEntities('&#x3F;')).toBe('?');
  });

  it('leaves unknown entities alone rather than mangling them', () => {
    expect(decodeHtmlEntities('&notarealentity;')).toBe('&notarealentity;');
  });

  it('strips zero-width characters', () => {
    expect(normaliseText(`ab${String.fromCodePoint(0x200b)}cd`)).toBe('abcd');
  });

  it('normalises CRLF', () => {
    expect(normaliseText('a\r\nb')).toBe('a\nb');
  });
});

describe('redirect unwrapping safety', () => {
  it('does not follow a parameter pointing at an uninteresting host', () => {
    const result = extractFromText('https://example.com/x?ref=https%3A%2F%2Fother.example.com%2Fy');
    expect(result.videos).toHaveLength(0);
    expect(result.otherUrls).toEqual([
      'https://example.com/x?ref=https%3A%2F%2Fother.example.com%2Fy',
    ]);
  });

  it('terminates on a redirector that points at itself', () => {
    const self = 'https://redir.example.com/go';
    const looping = `${self}?target=${encodeURIComponent(`${self}?target=${encodeURIComponent(self)}`)}`;
    expect(() => extractFromText(looping)).not.toThrow();
  });
});
