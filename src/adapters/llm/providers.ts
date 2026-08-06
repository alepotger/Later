/**
 * LLM providers.
 *
 * Two implementations behind one interface, both plain `fetch` so they run unchanged on
 * Workers. Gemini is the default when a provider is configured — not on model quality, but
 * because its free tier needs no card and it lives in the *same Google Cloud project* the
 * deployer already created for YouTube. For a project optimising onboarding, that is the
 * deciding factor. See docs/adr/0009.
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
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await work(controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

      const text = await withTimeout(async (signal) => {
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
          deps.logger.warn('gemini call failed', { status: response.status });
          return null;
        }

        const payload = (await response.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        return payload.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
      }, TIMEOUT_MS);

      if (text === null) return [];
      return parseCandidates(text);
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
      const text = await withTimeout(async (signal) => {
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
      }, TIMEOUT_MS);

      if (text === null) return [];
      return parseCandidates(text);
    },
  };
}
