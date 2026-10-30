/**
 * The two LLM adapters, and specifically how they fail.
 *
 * The success path is a thin wrapper over `parseCandidates`, which has its own tests. What is
 * asserted here is the failure reporting, because that is what a real deployment got wrong:
 * the adapter logged only an HTTP status. One key returned a 402 about billing and a 404 about
 * a retired model — two unrelated faults, only one of them blocking — and the status codes
 * could not tell them apart. An evening went into the wrong one. Both response bodies named
 * their own cause in plain English throughout.
 *
 * So: the body is read, the message is logged, and a failure never throws.
 */

import { describe, expect, it } from 'vitest';
import {
  geminiLlm,
  namedReplacementModel,
  openAiCompatibleLlm,
} from '../../src/adapters/llm/providers.ts';
import type { LogFields, Logger } from '../../src/ports/logger.ts';

interface Line {
  level: string;
  message: string;
  fields: LogFields;
}

function recordingLogger(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields: fields ?? {} });
    };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return { logger, lines };
}

function respondWith(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

const INPUT = { text: 'that video about why planes fly', platform: 'unknown' } as const;

const DEPLETED = JSON.stringify({
  error: {
    code: 402,
    message: 'Your prepayment credits are depleted.',
    status: 'RESOURCE_EXHAUSTED',
  },
});

/** Google's actual wording, which names the model to move to. */
const RETIRED = JSON.stringify({
  error: {
    code: 404,
    message:
      'This model models/gemini-2.5-flash is no longer available to new users. ' +
      'Please update your code to use models/gemini-3.8-flash for the latest features.',
    status: 'NOT_FOUND',
  },
});

const ANSWER = JSON.stringify({
  candidates: [
    {
      content: {
        parts: [
          {
            text: JSON.stringify({
              candidates: [
                { titleGuess: 'How Do Planes Fly?', channelGuess: 'Veritasium', confidence: 0.8 },
              ],
            }),
          },
        ],
      },
    },
  ],
});

/** Answers each request from the queue, recording which model each one asked for. */
function scripted(replies: { status: number; body: string }[]): {
  fetch: typeof fetch;
  models: string[];
} {
  const models: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    models.push(decodeURIComponent(url.split('/models/')[1]?.split(':')[0] ?? ''));
    const next = replies.shift() ?? { status: 500, body: '{}' };
    return new Response(next.body, { status: next.status });
  }) as unknown as typeof fetch;
  return { fetch: impl, models };
}

describe('gemini adapter failure reporting', () => {
  it('logs the message the API sent, not just the status', async () => {
    const { logger, lines } = recordingLogger();
    const llm = geminiLlm(
      { apiKey: 'k', model: 'gemini-2.5-flash' },
      { logger, fetch: respondWith(402, DEPLETED) },
    );

    expect(await llm.extractCandidates(INPUT)).toEqual([]);

    const warning = lines.find((line) => line.message === 'gemini call failed');
    expect(warning?.fields).toMatchObject({
      status: 402,
      apiMessage: 'Your prepayment credits are depleted.',
      apiStatus: 'RESOURCE_EXHAUSTED',
    });
  });

  it('surfaces a retired model id, which a 404 alone cannot distinguish from billing', async () => {
    // The response that was actually blocking Tier 2 in the field. The same key also produced
    // the 402 above, so the two faults were indistinguishable by status — and the one that
    // mattered was this one. Naming the replacement is the whole value of the line.
    const { logger, lines } = recordingLogger();
    const llm = geminiLlm(
      { apiKey: 'k', model: 'gemini-2.5-flash' },
      {
        logger,
        fetch: respondWith(
          404,
          JSON.stringify({
            error: {
              code: 404,
              message:
                'This model models/gemini-2.5-flash is no longer available to new users. ' +
                'Please update your code to use models/gemini-3.8-flash for the latest features.',
              status: 'NOT_FOUND',
            },
          }),
        ),
      },
    );

    await llm.extractCandidates(INPUT);

    const logged = lines.find((line) => line.message === 'gemini call failed')?.fields.apiMessage;
    expect(logged).toContain('no longer available to new users');
    expect(logged).toContain('models/gemini-3.8-flash');
  });

  it('still logs a usable line when the body is not JSON', async () => {
    const { logger, lines } = recordingLogger();
    const llm = geminiLlm(
      { apiKey: 'k', model: 'gemini-2.5-flash' },
      { logger, fetch: respondWith(503, '<html>upstream exploded</html>') },
    );

    expect(await llm.extractCandidates(INPUT)).toEqual([]);

    const warning = lines.find((line) => line.message === 'gemini call failed');
    expect(warning?.fields.status).toBe(503);
    expect(warning?.fields.apiMessage).toBeUndefined();
  });

  it('never throws when the call itself fails', async () => {
    const { logger, lines } = recordingLogger();
    const llm = geminiLlm(
      { apiKey: 'k', model: 'gemini-2.5-flash' },
      {
        logger,
        fetch: (async () => {
          throw new TypeError('fetch failed');
        }) as unknown as typeof fetch,
      },
    );

    expect(await llm.extractCandidates(INPUT)).toEqual([]);
    expect(lines.find((line) => line.message === 'gemini call threw')?.fields.error).toBe(
      'TypeError: fetch failed',
    );
  });
});

describe('a retired model id heals itself', () => {
  it('retries with the replacement Google names, and succeeds', async () => {
    const { logger, lines } = recordingLogger();
    const { fetch: impl, models } = scripted([
      { status: 404, body: RETIRED },
      { status: 200, body: ANSWER },
    ]);
    const llm = geminiLlm({ apiKey: 'k', model: 'gemini-2.5-flash' }, { logger, fetch: impl });

    const candidates = await llm.extractCandidates(INPUT);

    expect(models).toEqual(['gemini-2.5-flash', 'gemini-3.8-flash']);
    expect(candidates).toHaveLength(1);
    expect(lines.find((line) => line.message.includes('retired'))?.fields).toMatchObject({
      configured: 'gemini-2.5-flash',
      replacement: 'gemini-3.8-flash',
      action: 'set LLM_MODEL=gemini-3.8-flash',
    });
  });

  it('learns once — later calls go straight to the replacement', async () => {
    // Otherwise every single ingest pays for a failed request first, which is a quiet tax on
    // a deployment whose only symptom is that it was always a bit slower than it should be.
    const { logger } = recordingLogger();
    const { fetch: impl, models } = scripted([
      { status: 404, body: RETIRED },
      { status: 200, body: ANSWER },
      { status: 200, body: ANSWER },
    ]);
    const llm = geminiLlm({ apiKey: 'k', model: 'gemini-2.5-flash' }, { logger, fetch: impl });

    await llm.extractCandidates(INPUT);
    await llm.extractCandidates(INPUT);

    expect(models).toEqual(['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.8-flash']);
  });

  it('gives up after one retry rather than chasing a chain', async () => {
    const { logger, lines } = recordingLogger();
    const { fetch: impl, models } = scripted([
      { status: 404, body: RETIRED },
      { status: 404, body: RETIRED },
    ]);
    const llm = geminiLlm({ apiKey: 'k', model: 'gemini-2.5-flash' }, { logger, fetch: impl });

    expect(await llm.extractCandidates(INPUT)).toEqual([]);
    expect(models).toHaveLength(2);
    expect(lines.filter((line) => line.message === 'gemini call failed')).toHaveLength(1);
  });

  it('does not retry a failure that names no replacement', async () => {
    const { logger } = recordingLogger();
    const { fetch: impl, models } = scripted([{ status: 402, body: DEPLETED }]);
    const llm = geminiLlm({ apiKey: 'k', model: 'gemini-2.5-flash' }, { logger, fetch: impl });

    expect(await llm.extractCandidates(INPUT)).toEqual([]);
    expect(models).toEqual(['gemini-2.5-flash']);
  });
});

describe('namedReplacementModel', () => {
  it('takes the replacement, not the dead id earlier in the same sentence', () => {
    expect(
      namedReplacementModel(
        'This model models/gemini-2.5-flash is no longer available to new users. ' +
          'Please update your code to use models/gemini-3.8-flash for the latest features.',
      ),
    ).toBe('gemini-3.8-flash');
  });

  it('strips sentence-final punctuation without touching version dots', () => {
    expect(namedReplacementModel('Please use models/gemini-4-pro.')).toBe('gemini-4-pro');
    expect(namedReplacementModel('use models/gemini-2.5-flash-lite-preview-09-2025, which')).toBe(
      'gemini-2.5-flash-lite-preview-09-2025',
    );
  });

  it('finds nothing when nothing is named', () => {
    expect(namedReplacementModel('models/foo is not found for API version v1beta')).toBeUndefined();
    expect(namedReplacementModel(undefined)).toBeUndefined();
  });
});

describe('openai-compatible adapter failure reporting', () => {
  it('reads the error body too — every provider can fail for billing', async () => {
    const { logger, lines } = recordingLogger();
    const llm = openAiCompatibleLlm(
      { baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'gpt-4o-mini' },
      {
        logger,
        fetch: respondWith(
          429,
          JSON.stringify({
            error: { message: 'You exceeded your current quota.', type: 'insufficient_quota' },
          }),
        ),
      },
    );

    expect(await llm.extractCandidates(INPUT)).toEqual([]);

    expect(lines.find((line) => line.message === 'llm call failed')?.fields).toMatchObject({
      status: 429,
      apiMessage: 'You exceeded your current quota.',
      apiStatus: 'insufficient_quota',
    });
  });

  it('parses a normal answer', async () => {
    const { logger } = recordingLogger();
    const llm = openAiCompatibleLlm(
      { baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'gpt-4o-mini' },
      {
        logger,
        fetch: respondWith(
          200,
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    candidates: [
                      {
                        titleGuess: 'How Do Planes Fly?',
                        channelGuess: 'Veritasium',
                        confidence: 0.8,
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        ),
      },
    );

    expect(await llm.extractCandidates(INPUT)).toEqual([
      { titleGuess: 'How Do Planes Fly?', channelGuess: 'Veritasium', confidence: 0.8 },
    ]);
  });
});
