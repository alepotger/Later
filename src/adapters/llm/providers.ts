/**
 * LLM providers.
 *
 * Two implementations behind one interface, both plain `fetch` so they run unchanged on
 * Workers. Gemini is the default when a provider is configured — not on model quality, but
 * because it lives in the *same Google Cloud project* the deployer already created for
 * YouTube, which is one fewer account to make. It is not free; nothing here is. See
 * docs/adr/0009 and its 2026-10-29 revision.
 *
 * Neither ever throws for a bad response. A Tier 2 miss sends the item to review; it must not
 * take down the pipeline.
 */

import type { VideoCandidate } from '../../core/resolve/ranking.ts';
import {
  buildUserMessage,
  CANDIDATE_PROMPT,
  type LlmInput,
  type LlmPort,
  parseCandidates,
} from '../../ports/llm.ts';
import type { Logger } from '../../ports/logger.ts';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** One call per item, no retries. Cost and latency stay bounded and predictable. */
const TIMEOUT_MS = 12_000;

interface ProviderDeps {
  logger: Logger;
  fetch?: typeof fetch;
}

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  onError: (error: unknown) => void,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await work(controller.signal);
  } catch (error) {
    // Never silent. A bare `catch { return null }` here made a DNS failure, an abort and a
    // malformed response indistinguishable from "the model had no idea" — all three surfaced
    // to the user as the same sentence, with nothing in the logs to tell them apart.
    onError(error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function describeThrow(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError'
      ? `timed out after ${TIMEOUT_MS}ms`
      : `${error.name}: ${error.message}`;
  }
  return String(error);
}

export function geminiLlm(options: { apiKey: string; model: string }, deps: ProviderDeps): LlmPort {
  const fetchImpl = deps.fetch ?? fetch;

  return {
    async extractCandidates(input: LlmInput): Promise<VideoCandidate[]> {
      const body = {
        systemInstruction: { parts: [{ text: CANDIDATE_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: buildUserMessage(input) }] }],
        generationConfig: {
          // Gemini can constrain output to JSON, which removes a whole class of parse failure.
          responseMimeType: 'application/json',
          temperature: 0.1, // this is extraction, not writing
          maxOutputTokens: 512,
        },
      };

      const text = await withTimeout(
        async (signal) => {
          const response = await fetchImpl(
            `${GEMINI_BASE}/models/${encodeURIComponent(options.model)}:generateContent`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-goog-api-key': options.apiKey,
              },
              body: JSON.stringify(body),
              signal,
            },
          );

          if (!response.ok) {
            // Read what the API actually said rather than inferring from the status code.
            // A depleted-credits account was observed returning 404 to one call and 402 to the
            // next, so status-based guesses sent the operator hunting a retired model id while
            // the body said "Your prepayment credits are depleted" in plain English. The body
            // is small, it is the only authoritative account of the failure, and guessing at
            // it costs more than reading it.
            const detail = await response
              .text()
              .then((raw) => {
                const parsed = JSON.parse(raw) as { error?: { message?: string; status?: string } };
                return {
                  ...(parsed.error?.message ? { apiMessage: parsed.error.message.trim() } : {}),
                  ...(parsed.error?.status ? { apiStatus: parsed.error.status } : {}),
                };
              })
              .catch(() => ({}));

            deps.logger.warn('gemini call failed', {
              status: response.status,
              model: options.model,
              ...detail,
            });
            return null;
          }

          const payload = (await response.json()) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
          };
          return payload.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
        },
        TIMEOUT_MS,
        (error) => {
          deps.logger.warn('gemini call threw', {
            model: options.model,
            error: describeThrow(error),
          });
        },
      );

      if (text === null) return [];
      const candidates = parseCandidates(text);
      deps.logger.info('gemini returned candidates', {
        count: candidates.length,
        ...(candidates.length === 0 ? { rawPrefix: text.slice(0, 200) } : {}),
      });
      return candidates;
    },
  };
}

/**
 * Anything speaking the OpenAI chat-completions shape: OpenAI, OpenRouter, Ollama, LM Studio.
 *
 * Unlike Gemini this cannot assume a JSON response mode, so the parser has to tolerate prose
 * wrapping and code fences — which it does.
 */
export function openAiCompatibleLlm(
  options: { baseUrl: string; apiKey?: string | undefined; model: string },
  deps: ProviderDeps,
): LlmPort {
  const fetchImpl = deps.fetch ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    async extractCandidates(input: LlmInput): Promise<VideoCandidate[]> {
      const text = await withTimeout(
        async (signal) => {
          const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              // Local runtimes like Ollama need no key, so it is genuinely optional.
              ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: options.model,
              temperature: 0.1,
              max_tokens: 512,
              messages: [
                { role: 'system', content: CANDIDATE_PROMPT },
                { role: 'user', content: buildUserMessage(input) },
              ],
            }),
            signal,
          });

          if (!response.ok) {
            deps.logger.warn('llm call failed', { status: response.status, endpoint });
            return null;
          }

          const payload = (await response.json()) as {
            choices?: { message?: { content?: string } }[];
          };
          return payload.choices?.[0]?.message?.content ?? null;
        },
        TIMEOUT_MS,
        (error) => {
          deps.logger.warn('llm call threw', {
            endpoint,
            model: options.model,
            error: describeThrow(error),
          });
        },
      );

      if (text === null) return [];
      const candidates = parseCandidates(text);
      deps.logger.info('llm returned candidates', {
        count: candidates.length,
        ...(candidates.length === 0 ? { rawPrefix: text.slice(0, 200) } : {}),
      });
      return candidates;
    },
  };
}
