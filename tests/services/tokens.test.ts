/**
 * The token refresh path, tested against a stubbed Google token endpoint.
 *
 * This is the primary route to `invalid_grant` — the failure that kills a deployment seven
 * days after setup if it is treated as a generic error. Every branch here is built and
 * verified with no real credentials, which is what let the OAuth console work be deferred.
 */

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { createVault } from '../../src/crypto/vault.ts';
import { openNodeDb } from '../../src/db/node.ts';
import { getAccountById, upsertAccount } from '../../src/db/repo.ts';
import { jobs } from '../../src/db/schema.ts';
import { fixedClock } from '../../src/ports/clock.ts';
import { silentLogger } from '../../src/ports/logger.ts';
import { recordingNotifier } from '../../src/ports/notifier.ts';
import { createTokenService, ReauthRequiredError } from '../../src/services/tokens.ts';
import { T0, TEST_KEY, testConfig } from '../helpers/harness.ts';

interface Stub {
  fetch: typeof fetch;
  calls: { url: string; body: string }[];
}

/** A stub Google token endpoint that replays a queued sequence of responses. */
function stubGoogle(responses: { status: number; body: unknown }[]): Stub {
  const calls: { url: string; body: string }[] = [];
  let index = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, body: String(init?.body ?? '') });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(next?.body ?? {}), {
      status: next?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

async function setup(stub: Stub, options: { expired?: boolean } = {}) {
  const { db, close } = openNodeDb(':memory:');
  migrate(db as never, { migrationsFolder: 'drizzle' });

  const config = testConfig();
  const vault = await createVault(TEST_KEY);
  const clock = fixedClock(T0);
  const notifier = recordingNotifier();

  const account = await upsertAccount(
    db,
    {
      googleUserId: 'g1',
      email: 'owner@example.com',
      refreshTokenCipher: await vault.encrypt('stored-refresh-token'),
      accessTokenCipher: await vault.encrypt('stored-access-token'),
      accessTokenExpiresAt: options.expired ? T0.getTime() - 1000 : T0.getTime() + 3_600_000,
    },
    T0.getTime(),
  );

  const tokens = createTokenService({
    db,
    config,
    vault,
    clock,
    logger: silentLogger,
    notifier,
    fetch: stub.fetch,
  });

  return { db, close, tokens, account, vault, notifier, clock };
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('access token caching', () => {
  it('uses the cached token without calling Google when it is still valid', async () => {
    const stub = stubGoogle([]);
    const ctx = await setup(stub);
    cleanup = ctx.close;

    expect(await ctx.tokens.getAccessToken(ctx.account.id)).toBe('stored-access-token');
    expect(stub.calls).toHaveLength(0);
  });

  it('refreshes once the cached token has expired', async () => {
    const stub = stubGoogle([
      { status: 200, body: { access_token: 'fresh-access', expires_in: 3600 } },
    ]);
    const ctx = await setup(stub, { expired: true });
    cleanup = ctx.close;

    expect(await ctx.tokens.getAccessToken(ctx.account.id)).toBe('fresh-access');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toContain('oauth2.googleapis.com/token');
    expect(stub.calls[0]?.body).toContain('grant_type=refresh_token');
  });

  it('stores the new access token encrypted, never in plaintext', async () => {
    const stub = stubGoogle([
      { status: 200, body: { access_token: 'fresh-access', expires_in: 3600 } },
    ]);
    const ctx = await setup(stub, { expired: true });
    cleanup = ctx.close;

    await ctx.tokens.getAccessToken(ctx.account.id);
    const account = await getAccountById(ctx.db, ctx.account.id);
    expect(account?.accessTokenCipher).not.toContain('fresh-access');
    expect(await ctx.vault.decrypt(account?.accessTokenCipher ?? '')).toBe('fresh-access');
  });

  it('applies a safety margin so a token is never used in its final moments', async () => {
    const stub = stubGoogle([
      { status: 200, body: { access_token: 'fresh-access', expires_in: 3600 } },
    ]);
    const ctx = await setup(stub, { expired: true });
    cleanup = ctx.close;

    await ctx.tokens.getAccessToken(ctx.account.id);
    const account = await getAccountById(ctx.db, ctx.account.id);
    // 3600s minus 60s of slack.
    expect(account?.accessTokenExpiresAt).toBe(T0.getTime() + 3540 * 1000);
  });
});

describe('refresh token rotation', () => {
  it('persists a rotated refresh token when Google sends one', async () => {
    const stub = stubGoogle([
      {
        status: 200,
        body: { access_token: 'a', expires_in: 3600, refresh_token: 'rotated-refresh' },
      },
    ]);
    const ctx = await setup(stub, { expired: true });
    cleanup = ctx.close;

    await ctx.tokens.getAccessToken(ctx.account.id);
    const account = await getAccountById(ctx.db, ctx.account.id);
    expect(await ctx.vault.decrypt(account?.refreshTokenCipher ?? '')).toBe('rotated-refresh');
  });

  it('keeps the stored refresh token when Google omits one', async () => {
    const stub = stubGoogle([{ status: 200, body: { access_token: 'a', expires_in: 3600 } }]);
    const ctx = await setup(stub, { expired: true });
    cleanup = ctx.close;

    await ctx.tokens.getAccessToken(ctx.account.id);
    const account = await getAccountById(ctx.db, ctx.account.id);
    // Clobbering this with null would lock the account out on the next refresh — a bug that
    // only shows up on the second authorisation.
    expect(await ctx.vault.decrypt(account?.refreshTokenCipher ?? '')).toBe('stored-refresh-token');
  });
});

describe('invalid_grant is terminal and loud', () => {
  const INVALID_GRANT = {
    status: 400,
    body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
  };

  it('throws ReauthRequiredError rather than a generic error', async () => {
    const ctx = await setup(stubGoogle([INVALID_GRANT]), { expired: true });
    cleanup = ctx.close;

    await expect(ctx.tokens.getAccessToken(ctx.account.id)).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
  });

  it('moves the account to reauth_required', async () => {
    const ctx = await setup(stubGoogle([INVALID_GRANT]), { expired: true });
    cleanup = ctx.close;

    await ctx.tokens.getAccessToken(ctx.account.id).catch(() => {});
    expect((await getAccountById(ctx.db, ctx.account.id))?.status).toBe('reauth_required');
  });

  it('notifies exactly once with a re-auth link', async () => {
    const ctx = await setup(stubGoogle([INVALID_GRANT]), { expired: true });
    cleanup = ctx.close;

    await ctx.tokens.getAccessToken(ctx.account.id).catch(() => {});
    await ctx.tokens.getAccessToken(ctx.account.id).catch(() => {});
    await ctx.tokens.getAccessToken(ctx.account.id).catch(() => {});

    const reauth = ctx.notifier.sent.filter((n) => n.kind === 'reauth_required');
    expect(reauth).toHaveLength(1);
    expect(reauth[0]).toMatchObject({ reauthUrl: 'http://localhost:8787/auth/start' });
  });

  it('does not retry — one call to Google, not several', async () => {
    const stub = stubGoogle([INVALID_GRANT]);
    const ctx = await setup(stub, { expired: true });
    cleanup = ctx.close;

    await ctx.tokens.getAccessToken(ctx.account.id).catch(() => {});
    expect(stub.calls).toHaveLength(1);
  });

  it('stops using the tokens on subsequent calls without contacting Google again', async () => {
    const stub = stubGoogle([INVALID_GRANT]);
    const ctx = await setup(stub, { expired: true });
    cleanup = ctx.close;

    await ctx.tokens.getAccessToken(ctx.account.id).catch(() => {});
    await ctx.tokens.getAccessToken(ctx.account.id).catch(() => {});
    expect(stub.calls).toHaveLength(1);
  });

  it('parks pending work rather than failing it', async () => {
    const ctx = await setup(stubGoogle([INVALID_GRANT]), { expired: true });
    cleanup = ctx.close;

    await ctx.db.insert(jobs).values({
      id: 'job1',
      kind: 'resolve_item',
      accountId: ctx.account.id,
      itemId: 'itm1',
      status: 'pending',
      attempts: 0,
      runAfter: T0.getTime(),
      createdAt: T0.getTime(),
      updatedAt: T0.getTime(),
    });

    await ctx.tokens.getAccessToken(ctx.account.id).catch(() => {});

    const rows = await ctx.db.select().from(jobs);
    expect(rows[0]?.status).toBe('parked');
  });
});

describe('transient failures are not mistaken for expiry', () => {
  it('propagates a 503 without touching the account status', async () => {
    const ctx = await setup(
      stubGoogle([{ status: 503, body: { error: { message: 'backend error' } } }]),
      { expired: true },
    );
    cleanup = ctx.close;

    await expect(ctx.tokens.getAccessToken(ctx.account.id)).rejects.not.toBeInstanceOf(
      ReauthRequiredError,
    );
    expect((await getAccountById(ctx.db, ctx.account.id))?.status).toBe('active');
    expect(ctx.notifier.sent).toHaveLength(0);
  });

  it('keep-alive treats a transient failure as fine and retries next sweep', async () => {
    const ctx = await setup(stubGoogle([{ status: 500, body: {} }]));
    cleanup = ctx.close;

    expect(await ctx.tokens.touch(ctx.account.id)).toBe('ok');
    expect((await getAccountById(ctx.db, ctx.account.id))?.status).toBe('active');
  });
});

describe('keep-alive', () => {
  it('refreshes even when the cached token is still valid', async () => {
    const stub = stubGoogle([
      { status: 200, body: { access_token: 'kept-alive', expires_in: 3600 } },
    ]);
    const ctx = await setup(stub);
    cleanup = ctx.close;

    expect(await ctx.tokens.touch(ctx.account.id)).toBe('ok');
    expect(stub.calls).toHaveLength(1);
  });

  it('reports a dead token so the sweep can surface it within a day', async () => {
    const ctx = await setup(stubGoogle([{ status: 400, body: { error: 'invalid_grant' } }]));
    cleanup = ctx.close;

    expect(await ctx.tokens.touch(ctx.account.id)).toBe('reauth_required');
    expect(ctx.notifier.sent.filter((n) => n.kind === 'reauth_required')).toHaveLength(1);
  });
});

describe('re-authorisation releases the backlog', () => {
  it('flips the account back to active and unparks its jobs', async () => {
    const ctx = await setup(stubGoogle([{ status: 400, body: { error: 'invalid_grant' } }]), {
      expired: true,
    });
    cleanup = ctx.close;

    await ctx.db.insert(jobs).values({
      id: 'job1',
      kind: 'resolve_item',
      accountId: ctx.account.id,
      itemId: 'itm1',
      status: 'pending',
      attempts: 0,
      runAfter: T0.getTime(),
      createdAt: T0.getTime(),
      updatedAt: T0.getTime(),
    });

    await ctx.tokens.getAccessToken(ctx.account.id).catch(() => {});
    expect((await ctx.db.select().from(jobs))[0]?.status).toBe('parked');

    await ctx.tokens.onReauthorised(ctx.account.id);

    expect((await getAccountById(ctx.db, ctx.account.id))?.status).toBe('active');
    expect((await ctx.db.select().from(jobs))[0]?.status).toBe('pending');
  });
});

describe('an undecryptable stored token', () => {
  it('is reported as needing re-authorisation, not as a crash', async () => {
    const ctx = await setup(stubGoogle([]), { expired: true });
    cleanup = ctx.close;

    // Simulate TOKEN_ENCRYPTION_KEY having been changed under us.
    const otherVault = await createVault(new Uint8Array(32).fill(7));
    await ctx.db
      .update((await import('../../src/db/schema.ts')).accounts)
      .set({ refreshTokenCipher: await otherVault.encrypt('unreadable') });

    await expect(ctx.tokens.getAccessToken(ctx.account.id)).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/);
    expect((await getAccountById(ctx.db, ctx.account.id))?.status).toBe('reauth_required');
  });
});
