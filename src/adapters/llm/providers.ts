/**
 * LLM providers.
 *
 * Two implementations behind one interface, both plain `fetch` so they run unchanged on
 * Workers. Gemini is the default when a provider is configured — not on model quality, but
 * because it lives in the *same Google Cloud project* the deployer already created for
 * YouTube, which is one fewer account to make. See docs/adr/0009 and its revisions.
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
import type { LogFields, Logger } from '../../ports/logger.ts';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Budget for the whole attempt, retry included. Cost and latency stay bounded and predictable:
 * there is no retry for a flaky network — only the one for a model id the API itself replaced,
 * which is a different request rather than the same one hopefully going better.
 */
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

/**
 * Read what the API actually said, rather than inferring from the status code.
 *
 * One Gemini key was seen returning a 402 about billing and a 404 about a retired model. They
 * were two different faults, only one of them blocking, and no status code could have told
 * them apart — while the body said which was which in plain English the whole time. Guessing
 * at a response that is sitting right there cost a first-time deployer an evening.
 *
 * Both error shapes are handled — Google's `{error:{message,status}}` and OpenAI's
 * `{error:{message,type,code}}` — because every provider here can fail for billing reasons and
 * the operator should not have to know whose JSON they are looking at.
 */
async function readErrorDetail(response: Response): Promise<LogFields> {
  return response
    .text()
    .then((raw) => {
      const parsed = JSON.parse(raw) as {
        error?: { message?: string; status?: string; type?: string; code?: string | number };
      };
      const error = parsed.error;
      if (!error) return {};
      const kind = error.status ?? error.type;
      return {
        ...(error.message ? { apiMessage: error.message.trim() } : {}),
        ...(kind ? { apiStatus: kind } : {}),
      };
    })
    .catch(() => ({}));
}

/**
 * The replacement model a provider names in its own rejection, if it names one.
 *
 * Google retires a model for *new* keys first and says what to use instead:
 *
 *   "This model models/gemini-2.5-flash is no longer available to new users.
 *    Please update your code to use models/gemini-3.8-flash"
 *
 * Anchored on "use models/…" so it takes the replacement rather than the dead id earlier in
 * the same sentence. The trailing strip handles an id that ends the sentence — version numbers
 * make dots legal inside the name, so the character class cannot simply exclude them.
 */
export function namedReplacementModel(apiMessage: string | undefined): string | undefined {
  return /\buse\s+models\/([\w.-]+)/i.exec(apiMessage ?? '')?.[1]?.replace(/[.,;:]+$/, '');
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

  /**
   * The model actually being called, which can differ from the configured one.
   *
   * Google retires models for new API keys before existing ones, so a default written months
   * ago keeps working for everyone already deployed and fails for everyone setting up. That is
   * exactly what happened here, and the person it happens to has no way to know the string is
   * the problem. When the API names its own replacement, using it is not a guess.
   *
   * Sticky for the life of the adapter so only the first call pays for the discovery. It is
   * never written back to configuration: the operator is told, loudly, to set LLM_MODEL, and
   * a fresh isolate re-learns it in one request if they do not.
   */
  let activeModel = options.model;

  const callModel = (model: string, body: unknown, signal: AbortSignal) =>
    fetchImpl(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
      body: JSON.stringify(body),
      signal,
    });

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
          let response = await callModel(activeModel, body, signal);

          if (!response.ok) {
            const detail = await readErrorDetail(response);
            const message = typeof detail.apiMessage === 'string' ? detail.apiMessage : undefined;
            const replacement = namedReplacementModel(message);

            if (replacement === undefined || replacement === activeModel) {
              deps.logger.warn('gemini call failed', {
                status: response.status,
                model: activeModel,
                ...detail,
              });
              return null;
            }

            // Warn rather than info: the retry keeps Tier 2 working today, but the stale
            // string is still in someone's configuration and will outlive this isolate.
            deps.logger.warn('gemini model retired — retrying with the replacement it named', {
              configured: activeModel,
              replacement,
              action: `set LLM_MODEL=${replacement}`,
              ...detail,
            });
            activeModel = replacement;

            // One retry, inside the same timeout, so latency stays bounded. If the named
            // replacement also fails there is nothing further to try.
            response = await callModel(activeModel, body, signal);
            if (!response.ok) {
              deps.logger.warn('gemini call failed', {
                status: response.status,
                model: activeModel,
                ...(await readErrorDetail(response)),
              });
              return null;
            }
          }

          const payload = (await response.json()) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
          };
          return payload.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
        },
        TIMEOUT_MS,
        (error) => {
          deps.logger.warn('gemini call threw', {
            model: activeModel,
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
            deps.logger.warn('llm call failed', {
              status: response.status,
              endpoint,
              ...(await readErrorDetail(response)),
            });
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
