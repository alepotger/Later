#!/usr/bin/env tsx
/**
 * `pnpm check:llm` — ask the configured provider one real question and print what came back.
 *
 * This exists because Tier 2 failing looks exactly like Tier 2 having nothing to say. Both end
 * with the item in review and the same sentence on screen. Telling them apart meant deploying,
 * tailing logs, sharing something, and reading JSON — four steps, each of which can go wrong on
 * its own, to answer a yes/no question.
 *
 * It calls the *real* adapter with the *real* prompt rather than an approximation, so a pass
 * here means the pipeline's Tier 2 works. A check that can pass while the thing it checks is
 * broken is worse than no check.
 *
 * Exits 0 on a working provider, 1 on anything else.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geminiLlm, openAiCompatibleLlm } from '../src/adapters/llm/providers.ts';
import type { LlmPort } from '../src/ports/llm.ts';
import type { LogFields, Logger } from '../src/ports/logger.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

const bold = (s: string) => `\u001b[1m${s}\u001b[0m`;
const dim = (s: string) => `\u001b[2m${s}\u001b[0m`;
const green = (s: string) => `\u001b[32m${s}\u001b[0m`;
const red = (s: string) => `\u001b[31m${s}\u001b[0m`;
const yellow = (s: string) => `\u001b[33m${s}\u001b[0m`;

/**
 * A share with no link in it — the only kind of share Tier 2 ever sees.
 *
 * Deliberately a real, famous video rather than a toy string: a provider that returns something
 * plausible for this is a provider that will return something plausible for a Reel caption.
 */
const SAMPLE = 'that Veritasium video explaining why planes actually fly, the one about lift';

/** Captures what the adapter logged, so this script can explain it rather than dump JSON. */
function capturingLogger(captured: LogFields[]): Logger {
  const record = (fields?: LogFields) => {
    if (fields) captured.push(fields);
  };
  const logger: Logger = {
    debug: (_m, f) => record(f),
    info: (_m, f) => record(f),
    warn: (_m, f) => record(f),
    error: (_m, f) => record(f),
    child: () => logger,
  };
  return logger;
}

function fail(message: string, ...detail: string[]): never {
  console.error(`\n${red('✗')} ${bold(message)}`);
  for (const line of detail) console.error(`  ${line}`);
  console.error('');
  process.exit(1);
}

/**
 * Turn the provider's own words into the next thing to do.
 *
 * Keyed on the message text, never the status code: a credit-exhausted Gemini account was
 * observed answering 404 to one call and 402 to the next, which sends you hunting a model name
 * that was never wrong. See docs/adr/0009 and TROUBLESHOOTING.md.
 */
function interpret(apiMessage: string | undefined, provider: string): string[] {
  const text = (apiMessage ?? '').toLowerCase();
  const billing =
    text.includes('prepayment credits') ||
    text.includes('billing') ||
    text.includes('insufficient') ||
    text.includes('credit balance');

  if (billing && provider !== 'gemini') {
    return [
      'That provider is refusing the call for payment, not for anything to do with Later.',
      'Top the account up, or set LLM_PROVIDER=none — Tiers 0 and 1 are free and handle',
      'every share whose text already contains the link, which is most of them.',
    ];
  }

  if (billing) {
    return [
      'The Gemini API has no free allowance on this project. Your key is fine; there is',
      'nothing to spend against it.',
      '',
      `  ${bold('Free thing to try first:')} make a key in a project with no billing attached,`,
      '  at https://aistudio.google.com/apikey → Create API key → in a new project.',
      '  If a free tier is available to your account, that key will work and this costs you',
      '  nothing to find out.',
      '',
      `  ${bold('If that fails too:')} fund the prepaid wallet in AI Studio itself, not in the`,
      '  Google Cloud console — https://aistudio.google.com/plan_information. Google Cloud',
      '  credit is reported not to count until the AI Studio balance is positive.',
      '',
      `  ${bold('Or skip Tier 2:')} set LLM_PROVIDER=none. Tiers 0 and 1 are free and handle`,
      '  every share whose text already contains the link, which is most of them.',
    ];
  }

  if (text.includes('not found') || text.includes('not supported') || text.includes('model')) {
    return provider === 'gemini'
      ? [
          'That model id looks wrong or retired. List the ones this key can actually use:',
          '',
          dim('  curl -s -H "x-goog-api-key: $GEMINI_API_KEY" \\'),
          dim('    https://generativelanguage.googleapis.com/v1beta/models | grep \'"name"\''),
          '',
          'Then set LLM_MODEL in .env to one of them.',
        ]
      : ['That model id looks wrong or retired. Check LLM_MODEL against what the endpoint offers.'];
  }

  if (text.includes('api key') || text.includes('api_key') || text.includes('permission')) {
    return [
      'The key was rejected. Either it is wrong, it was revoked, or the Generative Language',
      'API is not enabled on its project:',
      '',
      '  https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com',
    ];
  }

  if (text.includes('quota') || text.includes('rate')) {
    return ['Rate limited. Wait a minute and run this again.'];
  }

  return [];
}

function buildProvider(logger: Logger): { port: LlmPort; label: string; provider: string } {
  const provider = process.env.LLM_PROVIDER?.trim() || 'none';

  if (provider === 'none') {
    fail(
      'LLM_PROVIDER=none, so there is nothing to check.',
      'That is a valid configuration — Tier 2 is off and Tiers 0 and 1 still work.',
      'To enable Tier 2, set LLM_PROVIDER=gemini or openai-compatible in .env.',
    );
  }

  if (provider === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      fail('LLM_PROVIDER=gemini but GEMINI_API_KEY is empty in .env.');
    }
    const model = process.env.LLM_MODEL?.trim() || 'gemini-2.5-flash';
    return { port: geminiLlm({ apiKey, model }, { logger }), label: `gemini · ${model}`, provider };
  }

  if (provider === 'openai-compatible') {
    const baseUrl = process.env.OPENAI_BASE_URL?.trim();
    if (!baseUrl) {
      fail('LLM_PROVIDER=openai-compatible but OPENAI_BASE_URL is empty in .env.');
    }
    const model = process.env.LLM_MODEL?.trim() || 'gpt-4o-mini';
    const apiKey = process.env.OPENAI_API_KEY?.trim() || undefined;
    return {
      port: openAiCompatibleLlm({ baseUrl, apiKey, model }, { logger }),
      label: `${baseUrl} · ${model}`,
      provider,
    };
  }

  return fail(`LLM_PROVIDER=${provider} is not a provider Later knows.`);
}

async function main(): Promise<void> {
  if (!existsSync(envPath)) {
    fail('No .env found.', 'Run `pnpm configure` first.');
  }
  process.loadEnvFile(envPath);

  const captured: LogFields[] = [];
  const { port, label, provider } = buildProvider(capturingLogger(captured));

  console.log(`\n${bold('Checking Tier 2')} ${dim(`(${label})`)}`);
  console.log(dim(`  asking: "${SAMPLE}"`));

  const started = Date.now();
  const candidates = await port.extractCandidates({ text: SAMPLE, platform: 'unknown' });
  const elapsed = Date.now() - started;

  // The adapters never throw — a failure arrives as an empty array plus a log line. That is
  // right for the pipeline and useless for a human, which is the whole reason for this script.
  const failure = captured.find((f) => 'status' in f || 'error' in f);

  if (failure) {
    const apiMessage = typeof failure.apiMessage === 'string' ? failure.apiMessage : undefined;
    console.error(`\n${red('✗')} ${bold('The provider refused the call.')}`);
    if (apiMessage) console.error(`\n  ${bold('It said:')} ${apiMessage}`);
    if (failure.status !== undefined) console.error(dim(`  HTTP ${failure.status}`));
    if (typeof failure.error === 'string') console.error(`  ${failure.error}`);

    const advice = interpret(apiMessage ?? (failure.error as string | undefined), provider);
    if (advice.length > 0) {
      console.error('');
      for (const line of advice) console.error(`  ${line}`);
    }
    console.error('');
    process.exit(1);
  }

  if (candidates.length === 0) {
    console.log(`\n${yellow('~')} ${bold('The provider answered, but named no video.')}`);
    console.log('  The connection and the key work. The model just had nothing to offer for');
    console.log('  that sentence, which is a legitimate outcome — though for this particular');
    console.log('  sample it suggests a weak model. Try a larger one via LLM_MODEL.');
    console.log('');
    process.exit(1);
  }

  console.log(`\n${green('✓')} ${bold('Tier 2 works.')} ${dim(`${elapsed}ms`)}`);
  for (const candidate of candidates) {
    const named = [candidate.titleGuess, candidate.channelGuess].filter(Boolean).join(' — ');
    console.log(`  ${named} ${dim(`(confidence ${candidate.confidence})`)}`);
  }
  console.log(
    `\n${dim('Later searches YouTube for these and ranks the results; it never takes an id from the model.')}\n`,
  );
}

main().catch((error: unknown) => {
  fail('The check itself crashed.', error instanceof Error ? error.message : String(error));
});
