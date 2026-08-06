/**
 * HTTP middleware: request IDs, structured request logging, ingest auth, rate limiting.
 */

import type { Context, MiddlewareHandler, Next } from 'hono';
import { randomToken, timingSafeEqual } from '../core/bytes.ts';
import { hmacSha256Hex } from '../crypto/vault.ts';
import { incrementRateLimit } from '../db/repo.ts';
import type { Logger } from '../ports/logger.ts';
import type { Runtime } from '../runtime.ts';

export interface AppBindings {
  Variables: {
    runtime: Runtime;
    requestId: string;
    logger: Logger;
  };
}

/**
 * Attach a request ID to everything.
 *
 * Honours an inbound `x-request-id` so a client (or the Telegram adapter) can correlate, and
 * echoes it back. Every log line for the request, and every item row it creates, carries it —
 * which is what makes "the logs should answer the issue" achievable.
 */
export function withRequestContext(runtime: Runtime): MiddlewareHandler<AppBindings> {
  return async (c: Context<AppBindings>, next: Next) => {
    const requestId = c.req.header('x-request-id')?.slice(0, 64) || randomToken(8);
    const logger = runtime.logger.child({ requestId });

    c.set('runtime', runtime);
    c.set('requestId', requestId);
    c.set('logger', logger);
    c.header('x-request-id', requestId);

    const started = Date.now();
    await next();

    // The paste box and the share target are the only routes a human looks at; logging every
    // asset request at info level would drown the signal.
    const level = c.res.status >= 500 ? 'error' : c.res.status >= 400 ? 'warn' : 'info';
    logger[level]('request', {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Date.now() - started,
    });
  };
}

/**
 * Authenticate an ingest request.
 *
 * A bearer token compared in constant time. HMAC signing is supported but off by default —
 * see docs/adr/0008-ingest-authentication.md for why requiring it would make the iOS
 * Shortcut unbuildable.
 *
 * Failures are deliberately indistinguishable: a missing token, a wrong token, and a bad
 * signature all produce the same 401 with no detail.
 */
export function requireIngestAuth(): MiddlewareHandler<AppBindings> {
  return async (c: Context<AppBindings>, next: Next) => {
    const runtime = c.get('runtime');
    const { token, hmacSecret } = runtime.config.ingest;

    const header = c.req.header('authorization') ?? '';
    const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';

    if (presented === '' || !timingSafeEqual(presented, token)) {
      c.get('logger').warn('ingest rejected: bad or missing token');
      return c.json({ error: 'unauthorized' }, 401);
    }

    if (hmacSecret !== undefined) {
      const signature = c.req.header('x-later-signature') ?? '';
      // Hono caches the parsed body, so the handler can read it again after this.
      const expected = await hmacSha256Hex(hmacSecret, await c.req.text());
      if (!timingSafeEqual(signature.toLowerCase(), expected)) {
        c.get('logger').warn('ingest rejected: bad signature');
        return c.json({ error: 'unauthorized' }, 401);
      }
    }

    await next();
    return;
  };
}

/**
 * Fixed-window rate limit.
 *
 * Mounted *before* authentication so that failed attempts are counted too — otherwise the
 * endpoint is a free oracle for guessing the token. For the same reason, the bucket must not
 * be derived from anything the caller controls: keying it on the presented token would hand
 * an attacker a fresh allowance for every guess.
 */
export function rateLimit(
  bucketOf: (c: Context<AppBindings>) => string,
): MiddlewareHandler<AppBindings> {
  return async (c: Context<AppBindings>, next: Next) => {
    const runtime = c.get('runtime');
    const limit = runtime.config.ingest.rateLimitPerMinute;
    const now = runtime.clock.now().getTime();
    const windowStart = Math.floor(now / 60_000) * 60_000;

    const count = await incrementRateLimit(runtime.db, bucketOf(c), windowStart);
    if (count > limit) {
      c.get('logger').warn('rate limited', { count, limit });
      // Both sides of this must come from the injected clock. Mixing in `Date.now()` produced
      // a negative retry-after whenever the two disagreed — invisible in production, and a
      // latent bug the moment anything else drives the clock.
      c.header('retry-after', String(Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000))));
      return c.json({ error: 'rate_limited', limit, windowSeconds: 60 }, 429);
    }

    await next();
    return;
  };
}
