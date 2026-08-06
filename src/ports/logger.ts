/**
 * Structured logging.
 *
 * The goal, from §10 of the brief: when someone opens an issue, the logs should answer it.
 * That means every line is JSON, every line carries the request ID, and secrets never
 * appear even by accident.
 */

import type { LogLevel } from '../config.ts';

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derive a logger that carries extra fields on every line — used for request IDs. */
  child(fields: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Field names whose values are redacted.
 *
 * Matched case-insensitively as substrings, so `refreshToken`, `refresh_token_cipher`, and
 * `REFRESH_TOKEN` are all caught. Belt and braces: nothing should be logging these in the
 * first place, but a logger is exactly the place where a careless spread of a config
 * object turns into a secret in a support ticket.
 */
const REDACT_PATTERNS = [
  'token',
  'secret',
  'password',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'client_secret',
  'code_verifier',
  'cipher',
  'key',
];

const REDACTED = '[redacted]';

function shouldRedact(field: string): boolean {
  const lowered = field.toLowerCase();
  // `requestId` and `idempotencyKey` contain "key"/"id" but are safe and genuinely useful.
  if (lowered === 'requestid' || lowered === 'request_id') return false;
  if (lowered === 'idempotencykey' || lowered === 'idempotency_key') return false;
  if (lowered === 'sharekey' || lowered === 'share_key') return false;
  return REDACT_PATTERNS.some((pattern) => lowered.includes(pattern));
}

export function redactFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = shouldRedact(key) ? REDACTED : value;
  }
  return out;
}

export interface LoggerOptions {
  level: LogLevel;
  base?: LogFields;
  /** Injected so tests can capture output instead of writing to stdout. */
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions): Logger {
  const { level, base = {}, sink = (line) => console.log(line) } = options;
  const threshold = LEVEL_ORDER[level];

  function emit(logLevel: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[logLevel] < threshold) return;
    const record = {
      level: logLevel,
      msg: message,
      ...redactFields(base),
      ...redactFields(fields ?? {}),
    };
    sink(JSON.stringify(record));
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLogger({ level, base: { ...base, ...fields }, sink }),
  };
}

/** A logger that records nothing, for tests that do not assert on output. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
