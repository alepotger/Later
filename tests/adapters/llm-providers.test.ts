/**
 * The two LLM adapters, and specifically how they fail.
 *
 * The success path is a thin wrapper over `parseCandidates`, which has its own tests. What is
 * asserted here is the failure reporting, because that is what a real deployment got wrong:
 * the adapter logged only an HTTP status, and a depleted-credits Gemini account answered 404
 * to one call and 402 to the next. The operator spent an evening replacing a model id that was
 * never wrong, while the response body said "Your prepayment credits are depleted" in English.
 *
 * So: the body is read, the message is logged, and a failure never throws.
 */

import { describe, expect, it } from 'vitest';
import { geminiLlm, openAiCompatibleLlm } from '../../src/adapters/llm/providers.ts';
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

  it('reports the same body when the status is the misleading 404', async () => {
    // The exact pair observed in the field: one condition, two status codes. Whoever reads the
    // log must reach the same conclusion either way, which only holds if the body is what is
    // being read.
    const { logger, lines } = recordingLogger();
    const llm = geminiLlm(
      { apiKey: 'k', model: 'gemini-2.5-flash' },
      { logger, fetch: respondWith(404, DEPLETED) },
    );

    await llm.extractCandidates(INPUT);

    expect(lines.find((line) => line.message === 'gemini call failed')?.fields.apiMessage).toBe(
      'Your prepayment credits are depleted.',
    );
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
