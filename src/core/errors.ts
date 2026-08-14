/**
 * Typed failures.
 *
 * The point of this file is that `invalid_grant` and `quotaExceeded` are *not* generic
 * errors. Each drives a different, deliberate behaviour:
 *
 *  - `invalid_grant`   -> terminal. Stop retrying, park the work, notify the user.
 *  - `quota_exceeded`  -> defer to the next reset. Do not consume a retry attempt.
 *  - `transient`       -> retry with backoff.
 *  - everything else   -> terminal, but our bug rather than the user's.
 *
 * Collapsing these into one error type is how a deployment ends up failing silently for a
 * week, so the distinction is enforced by the type system.
 */

export type YouTubeErrorKind =
  /** Refresh token revoked, expired, or superseded. Terminal — see ADR-0005. */
  | 'invalid_grant'
  /** Daily quota gone. Defer, never drop — see ADR-0006. */
  | 'quota_exceeded'
  /** Video or playlist does not exist, or was deleted. */
  | 'not_found'
  /** Video is private, or the account may not touch it. */
  | 'forbidden'
  /** Region-blocked or otherwise unplayable where it matters. */
  | 'blocked'
  /** 5xx, network failure, timeout. Retry. */
  | 'transient'
  /** An attempt to write to a system playlist Google removed API access to in 2016. */
  | 'unwritable_playlist'
  /** Misconfiguration on our side: bad client, wrong scope, malformed request. */
  | 'client_error';

export class YouTubeError extends Error {
  readonly kind: YouTubeErrorKind;
  readonly status: number | undefined;
  /** Google's `reason` string, kept verbatim because it is genuinely useful in logs. */
  readonly reason: string | undefined;

  constructor(
    kind: YouTubeErrorKind,
    message: string,
    options: { status?: number; reason?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'YouTubeError';
    this.kind = kind;
    this.status = options.status;
    this.reason = options.reason;
  }

  /** True when retrying could plausibly succeed without the user doing anything. */
  get isRetryable(): boolean {
    return this.kind === 'transient';
  }

  /** True when the work should be held rather than failed, because it can resume later. */
  get isDeferrable(): boolean {
    return this.kind === 'quota_exceeded' || this.kind === 'invalid_grant';
  }
}

/**
 * Map a Google API error response onto a kind.
 *
 * Google is inconsistent about where the useful signal lives — sometimes the HTTP status,
 * sometimes `error.errors[].reason`, sometimes the top-level `error` string on the OAuth
 * endpoints — so all three are inspected.
 */
export function classifyGoogleError(status: number, body: unknown): YouTubeError {
  const reason = extractReason(body);
  const message = extractMessage(body) ?? `Google API returned ${status}`;

  // The OAuth token endpoint signals a dead refresh token this way, with a 400.
  if (reason === 'invalid_grant') {
    return new YouTubeError(
      'invalid_grant',
      'Google rejected the refresh token (invalid_grant). Authorisation must be renewed.',
      { status, reason },
    );
  }

  if (
    reason === 'quotaExceeded' ||
    reason === 'dailyLimitExceeded' ||
    reason === 'rateLimitExceeded' ||
    reason === 'userRateLimitExceeded'
  ) {
    // rateLimitExceeded is short-term rather than daily, but deferring is safe for both
    // and never loses the item.
    return new YouTubeError('quota_exceeded', `YouTube API quota exhausted (${reason}).`, {
      status,
      reason,
    });
  }

  if (status === 404 || reason === 'videoNotFound' || reason === 'playlistNotFound') {
    return new YouTubeError('not_found', message, { status, reason });
  }

  if (status === 401) {
    return new YouTubeError('invalid_grant', `Google rejected the access token: ${message}`, {
      status,
      reason,
    });
  }

  if (status === 403) {
    if (reason === 'forbidden' || reason === 'playlistItemsNotAccessible') {
      return new YouTubeError('forbidden', message, { status, reason });
    }
    return new YouTubeError('forbidden', message, { status, reason });
  }

  if (status === 429) {
    return new YouTubeError('quota_exceeded', message, { status, reason });
  }

  if (status >= 500) {
    return new YouTubeError('transient', message, { status, reason });
  }

  return new YouTubeError('client_error', message, { status, reason });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function extractReason(body: unknown): string | undefined {
  const root = asRecord(body);
  if (!root) return undefined;

  // OAuth endpoints: { "error": "invalid_grant", "error_description": "..." }
  if (typeof root.error === 'string') return root.error;

  const error = asRecord(root.error);
  if (!error) return undefined;

  const errors = error.errors;
  if (Array.isArray(errors)) {
    const first = asRecord(errors[0]);
    const reason = first?.reason;
    if (typeof reason === 'string') return reason;
  }

  const status = error.status;
  return typeof status === 'string' ? status : undefined;
}

function extractMessage(body: unknown): string | undefined {
  const root = asRecord(body);
  if (!root) return undefined;

  if (typeof root.error_description === 'string') return root.error_description;

  const error = asRecord(root.error);
  const message = error?.message;
  return typeof message === 'string' ? message : undefined;
}

/** Thrown when configuration is wrong in a way that should stop the process. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
