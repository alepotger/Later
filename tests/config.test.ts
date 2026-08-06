/**
 * Config validation.
 *
 * A stranger with a half-filled `.env` is this project's most common failure state, so these
 * tests assert on the *messages*, not just the pass/fail — an error that does not say what to
 * do next costs more than the 15-minute onboarding budget can afford.
 */

import { describe, expect, it } from 'vitest';
import { type Env, formatConfigProblems, parseConfig } from '../src/config.ts';

const MINIMAL: Env = {
  INGEST_TOKEN: 'a'.repeat(43),
  GOOGLE_CLIENT_ID: '123.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'GOCSPX-example',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  SESSION_SECRET: 'session-secret-value',
  GOOGLE_OAUTH_PUBLISHING_STATUS: 'production',
};

function errorsFor(env: Env): string[] {
  const result = parseConfig(env);
  return result.ok ? [] : result.errors;
}

function warningsFor(env: Env): string[] {
  return parseConfig(env).warnings;
}

describe('a minimal valid configuration', () => {
  it('parses', () => {
    const result = parseConfig(MINIMAL);
    expect(result.ok).toBe(true);
  });

  it('defaults to SOLO mode with a private playlist called Later', () => {
    const result = parseConfig(MINIMAL);
    if (!result.ok) throw new Error('expected ok');
    expect(result.config.mode).toBe('SOLO');
    expect(result.config.playlist).toEqual({ name: 'Later', privacy: 'private' });
  });

  it('defaults the quota budget below Google’s hard limit', () => {
    const result = parseConfig(MINIMAL);
    if (!result.ok) throw new Error('expected ok');
    expect(result.config.quota.dailyBudget).toBe(9000);
    expect(result.config.quota.resetTimeZone).toBe('America/Los_Angeles');
  });

  it('defaults to no LLM, so the product works without one', () => {
    const result = parseConfig(MINIMAL);
    if (!result.ok) throw new Error('expected ok');
    expect(result.config.llm.provider).toBe('none');
  });
});

describe('required values produce actionable errors', () => {
  it('tells you how to generate INGEST_TOKEN', () => {
    const errors = errorsFor({ ...MINIMAL, INGEST_TOKEN: undefined });
    expect(errors.join('\n')).toMatch(/INGEST_TOKEN is required/);
    expect(errors.join('\n')).toMatch(/openssl rand -base64 32/);
  });

  it('points at the handoff doc for the Google client', () => {
    const errors = errorsFor({ ...MINIMAL, GOOGLE_CLIENT_ID: undefined });
    expect(errors.join('\n')).toMatch(/ACTION-REQUIRED/);
  });

  it('rejects a short ingest token as guessable', () => {
    const errors = errorsFor({ ...MINIMAL, INGEST_TOKEN: 'hunter2' });
    expect(errors.join('\n')).toMatch(/only 7 characters/);
  });

  it('explains an encryption key of the wrong length', () => {
    const errors = errorsFor({
      ...MINIMAL,
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64'),
    });
    expect(errors.join('\n')).toMatch(/16 bytes.*needs exactly 32/s);
  });

  it('explains an encryption key that is not base64', () => {
    const errors = errorsFor({ ...MINIMAL, TOKEN_ENCRYPTION_KEY: 'not!valid!base64!' });
    expect(errors.join('\n')).toMatch(/not valid base64/);
  });

  it('reports several problems at once rather than one at a time', () => {
    const errors = errorsFor({});
    expect(errors.length).toBeGreaterThan(3);
  });
});

describe('the 7-day expiry warning', () => {
  it('warns loudly when the OAuth app is left in Testing', () => {
    const warnings = warningsFor({ ...MINIMAL, GOOGLE_OAUTH_PUBLISHING_STATUS: 'testing' });
    const text = warnings.join('\n');
    expect(text).toMatch(/7 DAYS/);
    expect(text).toMatch(/Publish app/);
    expect(text).toMatch(/console\.cloud\.google\.com/);
  });

  it('is silent in production', () => {
    expect(warningsFor(MINIMAL).join('\n')).not.toMatch(/7 DAYS/);
  });

  it('defaults to testing, so the warning is the default state', () => {
    const result = parseConfig({ ...MINIMAL, GOOGLE_OAUTH_PUBLISHING_STATUS: undefined });
    if (!result.ok) throw new Error('expected ok');
    expect(result.config.google.publishingStatus).toBe('testing');
    expect(result.warnings.join('\n')).toMatch(/7 DAYS/);
  });
});

describe('MULTI mode refuses to run wide open', () => {
  it('requires an allowlist', () => {
    const errors = errorsFor({ ...MINIMAL, LATER_MODE: 'MULTI' });
    expect(errors.join('\n')).toMatch(/LATER_ALLOWED_EMAILS/);
    expect(errors.join('\n')).toMatch(/open registration/);
  });

  it('accepts a lowercased allowlist', () => {
    const result = parseConfig({
      ...MINIMAL,
      LATER_MODE: 'multi',
      LATER_ALLOWED_EMAILS: 'A@example.com, b@example.com',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.config.mode).toBe('MULTI');
    expect(result.config.allowedEmails).toEqual(['a@example.com', 'b@example.com']);
  });

  it('rejects an unknown mode', () => {
    expect(errorsFor({ ...MINIMAL, LATER_MODE: 'TEAM' }).join('\n')).toMatch(/SOLO or MULTI/);
  });
});

describe('Telegram cannot be left open to strangers', () => {
  it('requires an allowlist when a bot token is set', () => {
    const errors = errorsFor({ ...MINIMAL, TELEGRAM_BOT_TOKEN: '123:abc' });
    expect(errors.join('\n')).toMatch(/TELEGRAM_ALLOWED_CHAT_IDS is empty/);
    expect(errors.join('\n')).toMatch(/discoverable/);
  });

  it('rejects a username where a numeric chat ID belongs', () => {
    const errors = errorsFor({
      ...MINIMAL,
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_ALLOWED_CHAT_IDS: '@alessandro',
    });
    expect(errors.join('\n')).toMatch(/not a numeric chat ID/);
  });

  it('accepts negative chat IDs, which is what groups have', () => {
    const result = parseConfig({
      ...MINIMAL,
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_ALLOWED_CHAT_IDS: '-1001234567890,42',
    });
    expect(result.ok).toBe(true);
  });
});

describe('quota and threshold bounds', () => {
  it('warns when the budget exceeds Google’s default allowance', () => {
    const warnings = warningsFor({ ...MINIMAL, YOUTUBE_DAILY_QUOTA_BUDGET: '20000' });
    expect(warnings.join('\n')).toMatch(/above the default Google allowance/);
  });

  it('rejects a nonsensical time zone and points at the right default', () => {
    const errors = errorsFor({ ...MINIMAL, YOUTUBE_QUOTA_RESET_TZ: 'Mars/Olympus_Mons' });
    expect(errors.join('\n')).toMatch(/not a valid IANA time zone/);
    expect(errors.join('\n')).toMatch(/America\/Los_Angeles/);
  });

  it('rejects a confidence threshold outside 0..1', () => {
    expect(errorsFor({ ...MINIMAL, RESOLVE_CONFIDENCE_THRESHOLD: '5' }).join('\n')).toMatch(
      /between 0 and 1/,
    );
  });

  it('warns that a zero threshold adds every guess unreviewed', () => {
    const warnings = warningsFor({ ...MINIMAL, RESOLVE_CONFIDENCE_THRESHOLD: '0' });
    expect(warnings.join('\n')).toMatch(/without review/);
  });

  it('reports a non-numeric value rather than silently defaulting', () => {
    expect(errorsFor({ ...MINIMAL, INGEST_RATE_LIMIT_PER_MINUTE: 'lots' }).join('\n')).toMatch(
      /must be a number/,
    );
  });
});

describe('PUBLIC_BASE_URL', () => {
  it('strips a trailing slash, because OAuth requires an exact match', () => {
    const result = parseConfig({ ...MINIMAL, PUBLIC_BASE_URL: 'https://later.example.com/' });
    if (!result.ok) throw new Error('expected ok');
    expect(result.config.publicBaseUrl).toBe('https://later.example.com');
  });

  it('rejects a value that is not a URL, with an example', () => {
    const errors = errorsFor({ ...MINIMAL, PUBLIC_BASE_URL: 'later.example.com' });
    expect(errors.join('\n')).toMatch(/not a valid URL/);
    expect(errors.join('\n')).toMatch(/no trailing slash/);
  });

  it('warns about plain http on a non-loopback host', () => {
    const warnings = warningsFor({ ...MINIMAL, PUBLIC_BASE_URL: 'http://later.example.com' });
    expect(warnings.join('\n')).toMatch(/unencrypted/);
  });

  it('does not warn about http on localhost, which OAuth permits', () => {
    const warnings = warningsFor({ ...MINIMAL, PUBLIC_BASE_URL: 'http://localhost:8787' });
    expect(warnings.join('\n')).not.toMatch(/unencrypted/);
  });
});

describe('HMAC opt-in warns about the iOS Shortcut', () => {
  it('says the shipped Shortcut cannot sign', () => {
    const warnings = warningsFor({ ...MINIMAL, INGEST_HMAC_SECRET: 'x'.repeat(32) });
    expect(warnings.join('\n')).toMatch(/iOS Shortcut cannot sign/);
  });
});

describe('LLM provider wiring', () => {
  it('requires a key for gemini', () => {
    expect(errorsFor({ ...MINIMAL, LLM_PROVIDER: 'gemini' }).join('\n')).toMatch(
      /requires GEMINI_API_KEY/,
    );
  });

  it('requires a base URL for an OpenAI-compatible provider', () => {
    expect(errorsFor({ ...MINIMAL, LLM_PROVIDER: 'openai-compatible' }).join('\n')).toMatch(
      /requires OPENAI_BASE_URL/,
    );
  });

  it('picks a sensible default model per provider', () => {
    const result = parseConfig({ ...MINIMAL, LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' });
    if (!result.ok) throw new Error('expected ok');
    expect(result.config.llm.model).toBe('gemini-2.5-flash');
  });
});

describe('fixtures mode', () => {
  it('runs with no credentials at all, so the app can be tried before setup', () => {
    const result = parseConfig({ USE_FIXTURES: 'true' });
    expect(result.ok).toBe(true);
    expect(result.warnings.join('\n')).toMatch(/no video will actually be added/);
  });

  it('still validates values that are present', () => {
    const errors = errorsFor({ USE_FIXTURES: 'true', LATER_MODE: 'NONSENSE' });
    expect(errors.join('\n')).toMatch(/SOLO or MULTI/);
  });
});

describe('warning about no notification channel', () => {
  it('points out you will only find out by visiting the web UI', () => {
    const warnings = warningsFor(MINIMAL);
    expect(warnings.join('\n')).toMatch(/only see\s+results by visiting the web UI/);
  });
});

describe('formatConfigProblems', () => {
  it('lists errors and points at .env.example', () => {
    const text = formatConfigProblems(parseConfig({}));
    expect(text).toMatch(/cannot start/);
    expect(text).toMatch(/\.env\.example/);
  });

  it('renders warnings even when the config is valid', () => {
    const text = formatConfigProblems(
      parseConfig({ ...MINIMAL, GOOGLE_OAUTH_PUBLISHING_STATUS: 'testing' }),
    );
    expect(text).toMatch(/7 DAYS/);
    expect(text).not.toMatch(/cannot start/);
  });

  it('is empty for a clean configuration', () => {
    const text = formatConfigProblems(
      parseConfig({ ...MINIMAL, TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_ALLOWED_CHAT_IDS: '42' }),
    );
    expect(text).toBe('');
  });
});
