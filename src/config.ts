/**
 * Configuration parsing and validation.
 *
 * `parseConfig` is a pure function over a plain environment record, so every validation
 * rule and every error message is unit-testable with no process and no files.
 *
 * The error messages matter more than they look. A stranger with a half-filled `.env` is
 * the most common failure state this project has, and the difference between
 * "TOKEN_ENCRYPTION_KEY is invalid" and a message that includes the command to generate
 * a correct one is most of the 15-minute onboarding budget.
 */

import { base64ToBytes } from './core/bytes.ts';

export type Mode = 'SOLO' | 'MULTI';
export type PublishingStatus = 'testing' | 'production';
export type LlmProvider = 'none' | 'gemini' | 'openai-compatible' | 'fixture';
export type PlaylistPrivacy = 'private' | 'unlisted' | 'public';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  mode: Mode;
  allowedEmails: string[];
  publicBaseUrl: string;
  logLevel: LogLevel;
  playlist: { name: string; privacy: PlaylistPrivacy };
  ingest: { token: string; hmacSecret: string | undefined; rateLimitPerMinute: number };
  google: { clientId: string; clientSecret: string; publishingStatus: PublishingStatus };
  secrets: { tokenEncryptionKey: Uint8Array; sessionSecret: string };
  quota: { dailyBudget: number; resetTimeZone: string };
  resolve: {
    confidenceThreshold: number;
    enablePlatformMetadata: boolean;
    instagramOembedToken: string | undefined;
    enableTranscript: boolean;
  };
  llm: {
    provider: LlmProvider;
    geminiApiKey: string | undefined;
    openaiBaseUrl: string | undefined;
    openaiApiKey: string | undefined;
    model: string;
  };
  notify: {
    telegramBotToken: string | undefined;
    telegramAllowedChatIds: string[];
    telegramWebhookSecret: string | undefined;
    webhookUrl: string | undefined;
    onSuccess: boolean;
  };
  databasePath: string;
  useFixtures: boolean;
}

export type ConfigResult =
  | { ok: true; config: Config; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

export type Env = Record<string, string | undefined>;

/**
 * Placeholders used only when `USE_FIXTURES=true`.
 *
 * This exists so that `pnpm dev` works from a clean checkout with no `.env` at all —
 * the fastest way for someone to see what Later does before deciding to set up a Google
 * Cloud project. Safe because fixtures mode makes no outbound calls and touches no real
 * account, and loudly warned about so it cannot be mistaken for a working config.
 */
const FIXTURE_PLACEHOLDER = 'fixtures-mode-placeholder-not-a-secret';

const DEFAULT_MODELS: Record<string, string> = {
  gemini: 'gemini-2.5-flash',
  'openai-compatible': 'gpt-4o-mini',
};

function str(env: Env, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = str(env, key)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function list(env: Env, key: string): string[] {
  return (str(env, key) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function oneOf<T extends string>(
  env: Env,
  key: string,
  allowed: readonly T[],
  fallback: T,
  errors: string[],
): T {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const lowered = raw.toLowerCase() as T;
  if (allowed.includes(lowered)) return lowered;
  errors.push(`${key} must be one of ${allowed.join(' | ')} — got ${JSON.stringify(raw)}.`);
  return fallback;
}

function num(
  env: Env,
  key: string,
  fallback: number,
  bounds: { min: number; max: number },
  errors: string[],
): number {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    errors.push(`${key} must be a number — got ${JSON.stringify(raw)}.`);
    return fallback;
  }
  if (value < bounds.min || value > bounds.max) {
    errors.push(`${key} must be between ${bounds.min} and ${bounds.max} — got ${value}.`);
    return fallback;
  }
  return value;
}

/** Required, unless fixtures mode is standing in for real credentials. */
function required(
  env: Env,
  key: string,
  useFixtures: boolean,
  errors: string[],
  howToGet: string,
): string {
  const value = str(env, key);
  if (value !== undefined) return value;
  if (useFixtures) return FIXTURE_PLACEHOLDER;
  errors.push(`${key} is required. ${howToGet}`);
  return '';
}

export function parseConfig(env: Env): ConfigResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const useFixtures = bool(env, 'USE_FIXTURES', false);

  if (useFixtures) {
    warnings.push(
      'USE_FIXTURES=true — all YouTube, oEmbed, and LLM calls are served from recorded ' +
        'fixtures. Nothing reaches your real account and no video will actually be added.',
    );
  }

  const mode = parseMode(env, errors);

  const allowedEmails = list(env, 'LATER_ALLOWED_EMAILS').map((e) => e.toLowerCase());
  if (mode === 'MULTI' && allowedEmails.length === 0) {
    errors.push(
      'LATER_MODE=MULTI requires LATER_ALLOWED_EMAILS to list the Google accounts allowed ' +
        'to authorise. Refusing to start with an open registration endpoint that can write ' +
        'to a YouTube playlist.',
    );
  }
  if (mode === 'MULTI' && allowedEmails.length > 1) {
    warnings.push(
      `LATER_MODE=MULTI with ${allowedEmails.length} allowed accounts. They share one daily ` +
        'YouTube quota, because the allowance belongs to the Google Cloud project rather than ' +
        'the user — one person can exhaust the day for everyone. See TROUBLESHOOTING.md ' +
        '("Running out of quota") for the increase request, or deploy separately per person.',
    );
  }

  const publicBaseUrlRaw = str(env, 'PUBLIC_BASE_URL') ?? 'http://localhost:8787';
  let publicBaseUrl = publicBaseUrlRaw.replace(/\/+$/, '');
  try {
    const parsed = new URL(publicBaseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      errors.push(
        `PUBLIC_BASE_URL must be http or https — got ${JSON.stringify(publicBaseUrlRaw)}.`,
      );
    }
    if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
      warnings.push(
        `PUBLIC_BASE_URL uses http on a non-loopback host (${parsed.hostname}). OAuth tokens ` +
          'and ingest secrets would travel unencrypted; use https for anything deployed.',
      );
    }
    publicBaseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    errors.push(
      `PUBLIC_BASE_URL is not a valid URL: ${JSON.stringify(publicBaseUrlRaw)}. ` +
        'Example: https://later.example.workers.dev (no trailing slash).',
    );
  }

  // MULTI issues one token per account from the web UI and never consults this one, so it is
  // optional there — and warned about if set, because a secret that does nothing is a secret
  // someone will eventually assume is doing something.
  const ingestToken = required(
    env,
    'INGEST_TOKEN',
    useFixtures || mode === 'MULTI',
    errors,
    "Generate one with: openssl rand -base64 32 | tr '+/' '-_' | tr -d '='",
  );
  if (mode === 'MULTI' && str(env, 'INGEST_TOKEN') !== undefined) {
    warnings.push(
      'INGEST_TOKEN is ignored in MULTI mode. Each account mints its own from the web UI ' +
        'after connecting Google; this value authenticates nothing.',
    );
  }
  if (ingestToken !== '' && ingestToken !== FIXTURE_PLACEHOLDER && ingestToken.length < 20) {
    errors.push(
      `INGEST_TOKEN is only ${ingestToken.length} characters. Anyone who guesses it can add ` +
        "videos to your playlist. Generate one with: openssl rand -base64 32 | tr '+/' '-_' | tr -d '='",
    );
  }

  const hmacSecret = str(env, 'INGEST_HMAC_SECRET');
  if (hmacSecret !== undefined) {
    warnings.push(
      'INGEST_HMAC_SECRET is set, so ingest requests must carry an HMAC signature. The ' +
        'shipped iOS Shortcut cannot sign requests and will get 401s. Unset this unless ' +
        'every one of your clients signs.',
    );
  }

  const clientId = required(
    env,
    'GOOGLE_CLIENT_ID',
    useFixtures,
    errors,
    'See docs/ACTION-REQUIRED.md Batch 1 Step 7. It ends in .apps.googleusercontent.com',
  );
  if (
    clientId !== '' &&
    clientId !== FIXTURE_PLACEHOLDER &&
    !clientId.endsWith('.apps.googleusercontent.com')
  ) {
    warnings.push(
      'GOOGLE_CLIENT_ID does not end in .apps.googleusercontent.com, which is unusual. ' +
        'Check you copied the Client ID and not the project number.',
    );
  }

  const clientSecret = required(
    env,
    'GOOGLE_CLIENT_SECRET',
    useFixtures,
    errors,
    'See docs/ACTION-REQUIRED.md Batch 1 Step 7. It starts with GOCSPX-',
  );

  const publishingStatus = oneOf(
    env,
    'GOOGLE_OAUTH_PUBLISHING_STATUS',
    ['testing', 'production'] as const,
    'testing',
    errors,
  );
  if (publishingStatus === 'testing') {
    warnings.push(
      'GOOGLE_OAUTH_PUBLISHING_STATUS=testing — Google will revoke your refresh token after ' +
        '7 DAYS and Later will stop adding videos. Fix it permanently: Google Cloud console ' +
        'https://console.cloud.google.com/auth/overview -> "Publish app" -> "Confirm", then ' +
        'set this to production. See TROUBLESHOOTING.md.',
    );
  }

  const tokenEncryptionKey = parseEncryptionKey(env, useFixtures, errors);

  const sessionSecret = required(
    env,
    'SESSION_SECRET',
    useFixtures,
    errors,
    'Generate one with: openssl rand -base64 32',
  );

  const dailyBudget = num(
    env,
    'YOUTUBE_DAILY_QUOTA_BUDGET',
    9000,
    { min: 51, max: 1_000_000 },
    errors,
  );
  if (dailyBudget > 10_000) {
    warnings.push(
      `YOUTUBE_DAILY_QUOTA_BUDGET is ${dailyBudget}, above the default Google allowance of ` +
        '10,000 units/day. Unless you have an approved quota increase, Later will hit ' +
        "Google's hard limit before its own budget and fail mid-operation instead of queueing.",
    );
  }

  const resetTimeZone = str(env, 'YOUTUBE_QUOTA_RESET_TZ') ?? 'America/Los_Angeles';
  if (!isValidTimeZone(resetTimeZone)) {
    errors.push(
      `YOUTUBE_QUOTA_RESET_TZ is not a valid IANA time zone: ${JSON.stringify(resetTimeZone)}. ` +
        "Google's quota resets at midnight Pacific, so the default America/Los_Angeles is " +
        'almost certainly what you want.',
    );
  }

  const confidenceThreshold = num(
    env,
    'RESOLVE_CONFIDENCE_THRESHOLD',
    0.75,
    { min: 0, max: 1 },
    errors,
  );
  if (confidenceThreshold === 0) {
    warnings.push(
      'RESOLVE_CONFIDENCE_THRESHOLD=0 means every guess is added to your playlist without ' +
        'review, including low-confidence ones. A wrong video costs more trust than a ' +
        'missing right one.',
    );
  }

  const llmProvider = oneOf(
    env,
    'LLM_PROVIDER',
    ['none', 'gemini', 'openai-compatible', 'fixture'] as const,
    'none',
    errors,
  );
  const geminiApiKey = str(env, 'GEMINI_API_KEY');
  const openaiBaseUrl = str(env, 'OPENAI_BASE_URL');
  const openaiApiKey = str(env, 'OPENAI_API_KEY');

  if (llmProvider === 'gemini' && geminiApiKey === undefined && !useFixtures) {
    errors.push('LLM_PROVIDER=gemini requires GEMINI_API_KEY. Get one from Google AI Studio.');
  }
  if (llmProvider === 'openai-compatible' && openaiBaseUrl === undefined) {
    errors.push(
      'LLM_PROVIDER=openai-compatible requires OPENAI_BASE_URL, e.g. ' +
        'https://api.openai.com/v1 or http://localhost:11434/v1 for Ollama.',
    );
  }

  const telegramBotToken = str(env, 'TELEGRAM_BOT_TOKEN');
  const telegramAllowedChatIds = list(env, 'TELEGRAM_ALLOWED_CHAT_IDS');
  // MULTI is exempt: there, a chat proves ownership by running `/link` with a signed,
  // short-lived code from the web UI, and an unlinked chat can do nothing but link. Requiring
  // the env allowlist as well would mean editing config and redeploying for every new person,
  // which is the friction MULTI exists to remove.
  if (mode === 'SOLO' && telegramBotToken !== undefined && telegramAllowedChatIds.length === 0) {
    errors.push(
      'TELEGRAM_BOT_TOKEN is set but TELEGRAM_ALLOWED_CHAT_IDS is empty. Your bot username is ' +
        'discoverable, so anyone who finds it could add videos to your playlist. List your own ' +
        'numeric chat ID, or unset TELEGRAM_BOT_TOKEN.',
    );
  }
  for (const id of telegramAllowedChatIds) {
    if (!/^-?\d+$/.test(id)) {
      errors.push(
        `TELEGRAM_ALLOWED_CHAT_IDS contains ${JSON.stringify(id)}, which is not a numeric chat ` +
          'ID. Use the number, not the @username.',
      );
    }
  }

  const webhookUrl = str(env, 'NOTIFY_WEBHOOK_URL');
  if (webhookUrl !== undefined && !/^https?:\/\//i.test(webhookUrl)) {
    errors.push(`NOTIFY_WEBHOOK_URL must be an http(s) URL — got ${JSON.stringify(webhookUrl)}.`);
  }

  if (telegramBotToken === undefined && webhookUrl === undefined) {
    warnings.push(
      'No notification channel configured. Later will still work, but you will only see ' +
        'results by visiting the web UI — including the message telling you that ' +
        'authorisation expired and Later has stopped working.',
    );
  }

  // Everything below is parsed *before* the error check, so that a bad LOG_LEVEL or
  // LATER_PLAYLIST_PRIVACY is reported rather than silently discarded.
  const logLevel = oneOf(
    env,
    'LOG_LEVEL',
    ['debug', 'info', 'warn', 'error'] as const,
    'info',
    errors,
  );
  const playlistPrivacy = oneOf(
    env,
    'LATER_PLAYLIST_PRIVACY',
    ['private', 'unlisted', 'public'] as const,
    'private',
    errors,
  );
  const rateLimitPerMinute = num(
    env,
    'INGEST_RATE_LIMIT_PER_MINUTE',
    30,
    { min: 1, max: 10_000 },
    errors,
  );

  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    warnings,
    config: {
      mode,
      allowedEmails,
      publicBaseUrl,
      logLevel,
      playlist: {
        name: str(env, 'LATER_PLAYLIST_NAME') ?? 'Later',
        privacy: playlistPrivacy,
      },
      ingest: { token: ingestToken, hmacSecret, rateLimitPerMinute },
      google: { clientId, clientSecret, publishingStatus },
      secrets: { tokenEncryptionKey, sessionSecret },
      quota: { dailyBudget, resetTimeZone },
      resolve: {
        confidenceThreshold,
        enablePlatformMetadata: bool(env, 'ENABLE_PLATFORM_METADATA', true),
        instagramOembedToken: str(env, 'INSTAGRAM_OEMBED_TOKEN'),
        enableTranscript: bool(env, 'ENABLE_TRANSCRIPT_RESOLUTION', false),
      },
      llm: {
        provider: llmProvider,
        geminiApiKey,
        openaiBaseUrl,
        openaiApiKey,
        model: str(env, 'LLM_MODEL') ?? DEFAULT_MODELS[llmProvider] ?? 'none',
      },
      notify: {
        telegramBotToken,
        telegramAllowedChatIds,
        telegramWebhookSecret: str(env, 'TELEGRAM_WEBHOOK_SECRET'),
        webhookUrl,
        onSuccess: bool(env, 'NOTIFY_ON_SUCCESS', false),
      },
      databasePath: str(env, 'DATABASE_PATH') ?? './data/later.db',
      useFixtures,
    },
  };
}

/** `LATER_MODE` is conventionally upper case, but accept any casing. */
function parseMode(env: Env, errors: string[]): Mode {
  const raw = str(env, 'LATER_MODE');
  if (raw === undefined) return 'SOLO';
  const upper = raw.toUpperCase();
  if (upper === 'SOLO' || upper === 'MULTI') return upper;
  errors.push(`LATER_MODE must be SOLO or MULTI — got ${JSON.stringify(raw)}.`);
  return 'SOLO';
}

function parseEncryptionKey(env: Env, useFixtures: boolean, errors: string[]): Uint8Array {
  const raw = str(env, 'TOKEN_ENCRYPTION_KEY');
  const howToGet = 'Generate one with: openssl rand -base64 32';

  if (raw === undefined) {
    if (useFixtures) return new Uint8Array(32);
    errors.push(`TOKEN_ENCRYPTION_KEY is required. ${howToGet}`);
    return new Uint8Array(32);
  }

  const bytes = base64ToBytes(raw);
  if (bytes === null) {
    errors.push(`TOKEN_ENCRYPTION_KEY is not valid base64. ${howToGet}`);
    return new Uint8Array(32);
  }
  if (bytes.length !== 32) {
    errors.push(
      `TOKEN_ENCRYPTION_KEY decodes to ${bytes.length} bytes; AES-256-GCM needs exactly 32. ` +
        howToGet,
    );
    return new Uint8Array(32);
  }
  return bytes;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Render config problems as something a human can act on without reading source. */
export function formatConfigProblems(result: ConfigResult): string {
  const lines: string[] = [];
  if (!result.ok) {
    lines.push(`Later cannot start — ${result.errors.length} configuration problem(s):`, '');
    for (const error of result.errors) lines.push(`  ✗ ${error}`);
    lines.push('', '  Every variable is documented in .env.example.');
  }
  if (result.warnings.length > 0) {
    if (lines.length > 0) lines.push('');
    for (const warning of result.warnings) lines.push(`  ! ${warning}`);
  }
  return lines.join('\n');
}
