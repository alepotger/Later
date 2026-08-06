/**
 * Every database query in one place.
 *
 * Written as plain functions taking a `Db` rather than classes, and written once for both
 * drivers. Two constraints from D1 shape the code here and are worth knowing before
 * editing:
 *
 *  1. **No interactive transactions.** Anything needing atomicity must be a single
 *     statement, which is why the job claim is a conditional `UPDATE ... RETURNING`
 *     rather than a read-then-write.
 *  2. **Upserts are `ON CONFLICT`,** not read-then-insert, so two concurrent ingests of
 *     the same share cannot both win.
 */

import { and, asc, desc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { newId } from './ids.ts';
import type { Db } from './index.ts';
import {
  type Account,
  type AccountStatus,
  accounts,
  type Item,
  type ItemSource,
  type ItemStatus,
  items,
  type Job,
  type JobKind,
  jobs,
  oauthStates,
  type PlaylistEntry,
  playlistEntries,
  quotaLedger,
  rateLimits,
  type VideoAvailability,
  type VideoCacheRow,
  videoCache,
} from './schema.ts';

// ─── Accounts ────────────────────────────────────────────────────────────────

export async function getAccountById(db: Db, id: string): Promise<Account | undefined> {
  const rows = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
  return rows[0];
}

export async function getAccountByGoogleUserId(
  db: Db,
  googleUserId: string,
): Promise<Account | undefined> {
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.googleUserId, googleUserId))
    .limit(1);
  return rows[0];
}

/**
 * Find an account by the SHA-256 hash of its ingest token. MULTI mode only.
 *
 * The token itself is never stored, so a leaked database cannot be used to post shares.
 */
export async function getAccountByIngestTokenHash(
  db: Db,
  hash: string,
): Promise<Account | undefined> {
  const rows = await db.select().from(accounts).where(eq(accounts.ingestTokenHash, hash)).limit(1);
  return rows[0];
}

export async function getAccountByTelegramChatId(
  db: Db,
  chatId: string,
): Promise<Account | undefined> {
  const rows = await db.select().from(accounts).where(eq(accounts.telegramChatId, chatId)).limit(1);
  return rows[0];
}

export async function setAccountIngestTokenHash(
  db: Db,
  accountId: string,
  hash: string,
  now: number,
): Promise<void> {
  await db
    .update(accounts)
    .set({ ingestTokenHash: hash, updatedAt: now })
    .where(eq(accounts.id, accountId));
}

export async function setAccountTelegramChatId(
  db: Db,
  accountId: string,
  chatId: string | null,
  now: number,
): Promise<void> {
  await db
    .update(accounts)
    .set({ telegramChatId: chatId, updatedAt: now })
    .where(eq(accounts.id, accountId));
}

export async function listAccounts(db: Db): Promise<Account[]> {
  return await db.select().from(accounts).orderBy(asc(accounts.createdAt));
}

export async function countAccounts(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)` }).from(accounts);
  return Number(rows[0]?.n ?? 0);
}

/** The single account in SOLO mode, or undefined before anyone has authorised. */
export async function getSoloAccount(db: Db): Promise<Account | undefined> {
  const rows = await db.select().from(accounts).orderBy(asc(accounts.createdAt)).limit(1);
  return rows[0];
}

export interface UpsertAccountInput {
  googleUserId: string;
  email: string;
  displayName?: string | null;
  refreshTokenCipher?: string | null;
  accessTokenCipher?: string | null;
  accessTokenExpiresAt?: number | null;
}

/**
 * Create or update an account after a successful OAuth exchange.
 *
 * A refresh token is only overwritten when Google actually sent a new one. Google omits it
 * on repeat consents, and clobbering the stored value with null would lock the account out
 * on the next refresh — a bug that only shows up on the *second* authorisation.
 */
export async function upsertAccount(
  db: Db,
  input: UpsertAccountInput,
  now: number,
): Promise<Account> {
  const existing = await getAccountByGoogleUserId(db, input.googleUserId);

  if (existing) {
    const patch: Partial<Account> = {
      email: input.email,
      displayName: input.displayName ?? existing.displayName,
      status: 'active',
      reauthNotifiedAt: null,
      updatedAt: now,
    };
    if (input.refreshTokenCipher) patch.refreshTokenCipher = input.refreshTokenCipher;
    if (input.accessTokenCipher !== undefined) patch.accessTokenCipher = input.accessTokenCipher;
    if (input.accessTokenExpiresAt !== undefined) {
      patch.accessTokenExpiresAt = input.accessTokenExpiresAt;
      patch.lastTokenRefreshAt = now;
    }

    await db.update(accounts).set(patch).where(eq(accounts.id, existing.id));
    const refreshed = await getAccountById(db, existing.id);
    if (!refreshed) throw new Error('account vanished during upsert');
    return refreshed;
  }

  const row = {
    id: newId('acc'),
    googleUserId: input.googleUserId,
    email: input.email,
    displayName: input.displayName ?? null,
    status: 'active' as AccountStatus,
    refreshTokenCipher: input.refreshTokenCipher ?? null,
    accessTokenCipher: input.accessTokenCipher ?? null,
    accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
    lastTokenRefreshAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(accounts).values(row);
  const created = await getAccountById(db, row.id);
  if (!created) throw new Error('account insert did not persist');
  return created;
}

export async function setAccountTokens(
  db: Db,
  accountId: string,
  patch: {
    refreshTokenCipher?: string;
    accessTokenCipher?: string | null;
    accessTokenExpiresAt?: number | null;
  },
  now: number,
): Promise<void> {
  const update: Partial<Account> = { updatedAt: now, lastTokenRefreshAt: now };
  if (patch.refreshTokenCipher) update.refreshTokenCipher = patch.refreshTokenCipher;
  if (patch.accessTokenCipher !== undefined) update.accessTokenCipher = patch.accessTokenCipher;
  if (patch.accessTokenExpiresAt !== undefined) {
    update.accessTokenExpiresAt = patch.accessTokenExpiresAt;
  }
  await db.update(accounts).set(update).where(eq(accounts.id, accountId));
}

export async function setAccountStatus(
  db: Db,
  accountId: string,
  status: AccountStatus,
  now: number,
): Promise<void> {
  await db.update(accounts).set({ status, updatedAt: now }).where(eq(accounts.id, accountId));
}

export async function markReauthNotified(db: Db, accountId: string, now: number): Promise<void> {
  await db
    .update(accounts)
    .set({ reauthNotifiedAt: now, updatedAt: now })
    .where(eq(accounts.id, accountId));
}

export async function setAccountPlaylist(
  db: Db,
  accountId: string,
  playlistId: string,
  playlistName: string,
  now: number,
): Promise<void> {
  await db
    .update(accounts)
    .set({ playlistId, playlistName, updatedAt: now })
    .where(eq(accounts.id, accountId));
}

/** Accounts whose access token has not been touched since `staleBefore`. */
export async function listAccountsNeedingKeepAlive(
  db: Db,
  staleBefore: number,
): Promise<Account[]> {
  return await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.status, 'active'),
        or(
          sql`${accounts.lastTokenRefreshAt} IS NULL`,
          lte(accounts.lastTokenRefreshAt, staleBefore),
        ),
      ),
    );
}

// ─── Items ───────────────────────────────────────────────────────────────────

export interface NewItemInput {
  accountId: string;
  idempotencyKey: string;
  shareKey: string;
  source: ItemSource;
  rawText: string;
  status?: ItemStatus;
  resolvedVideoId?: string | null;
  resolvedTier?: number | null;
  confidence?: number | null;
  requestId?: string | null;
}

export interface InsertItemResult {
  item: Item;
  /** False when an item with this idempotency key already existed. */
  created: boolean;
}

/**
 * Insert an item, or return the existing one for the same idempotency key.
 *
 * This is where "same share twice, one playlist entry" is enforced. Uses
 * `ON CONFLICT DO NOTHING` so two concurrent requests cannot both create a row — the loser
 * reads back the winner's row rather than erroring.
 */
export async function insertItemIdempotent(
  db: Db,
  input: NewItemInput,
  now: number,
): Promise<InsertItemResult> {
  const row = {
    id: newId('itm'),
    accountId: input.accountId,
    idempotencyKey: input.idempotencyKey,
    shareKey: input.shareKey,
    source: input.source,
    rawText: input.rawText,
    status: input.status ?? ('pending' as ItemStatus),
    resolvedVideoId: input.resolvedVideoId ?? null,
    resolvedTier: input.resolvedTier ?? null,
    confidence: input.confidence ?? null,
    requestId: input.requestId ?? null,
    createdAt: now,
    updatedAt: now,
  };

  const inserted = await db.insert(items).values(row).onConflictDoNothing().returning();
  const created = inserted[0];
  if (created) return { item: created, created: true };

  const existing = await db
    .select()
    .from(items)
    .where(
      and(eq(items.accountId, input.accountId), eq(items.idempotencyKey, input.idempotencyKey)),
    )
    .limit(1);
  const found = existing[0];
  if (!found) throw new Error('item insert conflicted but no existing row found');
  return { item: found, created: false };
}

export async function getItemById(db: Db, id: string): Promise<Item | undefined> {
  const rows = await db.select().from(items).where(eq(items.id, id)).limit(1);
  return rows[0];
}

export async function updateItem(
  db: Db,
  id: string,
  patch: {
    status?: ItemStatus;
    resolvedVideoId?: string | null;
    resolvedTier?: number | null;
    confidence?: number | null;
    failureReason?: string | null;
  },
  now: number,
): Promise<void> {
  await db
    .update(items)
    .set({ ...patch, updatedAt: now })
    .where(eq(items.id, id));
}

export async function listItemsByShareKey(db: Db, shareKey: string): Promise<Item[]> {
  return await db
    .select()
    .from(items)
    .where(eq(items.shareKey, shareKey))
    .orderBy(asc(items.createdAt));
}

export async function listRecentItems(db: Db, accountId: string, limit = 25): Promise<Item[]> {
  return await db
    .select()
    .from(items)
    .where(eq(items.accountId, accountId))
    .orderBy(desc(items.createdAt))
    .limit(limit);
}

export async function listItemsByStatus(
  db: Db,
  accountId: string,
  statuses: ItemStatus[],
  limit = 100,
): Promise<Item[]> {
  return await db
    .select()
    .from(items)
    .where(and(eq(items.accountId, accountId), inArray(items.status, statuses)))
    .orderBy(desc(items.createdAt))
    .limit(limit);
}

export async function countItemsByStatus(
  db: Db,
  accountId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: items.status, n: sql<number>`count(*)` })
    .from(items)
    .where(eq(items.accountId, accountId))
    .groupBy(items.status);

  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = Number(row.n);
  return out;
}

// ─── Playlist entries: the duplicate guard ───────────────────────────────────

/**
 * Whether this video is already in this account's playlist.
 *
 * The `UNIQUE(account_id, video_id)` constraint behind this is the only thing preventing
 * duplicates — YouTube stopped rejecting duplicate inserts in 2016, so there is no
 * server-side backstop.
 */
export async function hasPlaylistEntry(
  db: Db,
  accountId: string,
  videoId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: playlistEntries.id })
    .from(playlistEntries)
    .where(and(eq(playlistEntries.accountId, accountId), eq(playlistEntries.videoId, videoId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Record an addition. Returns false when the video was already recorded.
 *
 * `ON CONFLICT DO NOTHING` makes this the atomic claim: two concurrent pipeline runs for
 * the same video both call this, exactly one gets `true`, and only that one calls YouTube.
 */
export async function recordPlaylistEntry(
  db: Db,
  input: {
    accountId: string;
    videoId: string;
    playlistId: string;
    playlistItemId?: string | null;
    itemId?: string | null;
  },
  now: number,
): Promise<boolean> {
  const inserted = await db
    .insert(playlistEntries)
    .values({
      id: newId('ple'),
      accountId: input.accountId,
      videoId: input.videoId,
      playlistId: input.playlistId,
      playlistItemId: input.playlistItemId ?? null,
      itemId: input.itemId ?? null,
      addedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  return inserted.length > 0;
}

export async function deletePlaylistEntry(
  db: Db,
  accountId: string,
  videoId: string,
): Promise<void> {
  await db
    .delete(playlistEntries)
    .where(and(eq(playlistEntries.accountId, accountId), eq(playlistEntries.videoId, videoId)));
}

export async function listPlaylistEntries(
  db: Db,
  accountId: string,
  limit = 50,
): Promise<PlaylistEntry[]> {
  return await db
    .select()
    .from(playlistEntries)
    .where(eq(playlistEntries.accountId, accountId))
    .orderBy(desc(playlistEntries.addedAt))
    .limit(limit);
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export async function enqueueJob(
  db: Db,
  input: { kind: JobKind; accountId?: string | null; itemId?: string | null; runAfter?: number },
  now: number,
): Promise<void> {
  await db
    .insert(jobs)
    .values({
      id: newId('job'),
      kind: input.kind,
      accountId: input.accountId ?? null,
      itemId: input.itemId ?? null,
      status: 'pending',
      attempts: 0,
      runAfter: input.runAfter ?? now,
      createdAt: now,
      updatedAt: now,
    })
    // One job per (item, kind). Re-ingesting an idempotent share must not pile up jobs.
    .onConflictDoNothing();
}

/**
 * Put an item's job back on the queue, whether or not one already exists.
 *
 * Used when a held item is confirmed from the review inbox. Confirmation deliberately re-runs
 * the normal pipeline rather than adding the video directly, so the dedupe claim and the quota
 * gate still apply — a separate "the user said yes" path is how those guards get bypassed.
 */
export async function requeueItemJob(
  db: Db,
  input: { accountId: string; itemId: string },
  now: number,
): Promise<void> {
  const updated = await db
    .update(jobs)
    .set({ status: 'pending', runAfter: now, attempts: 0, lastError: null, updatedAt: now })
    .where(and(eq(jobs.itemId, input.itemId), eq(jobs.kind, 'resolve_item')))
    .returning({ id: jobs.id });

  if (updated.length > 0) return;

  await db
    .insert(jobs)
    .values({
      id: newId('job'),
      kind: 'resolve_item',
      accountId: input.accountId,
      itemId: input.itemId,
      status: 'pending',
      attempts: 0,
      runAfter: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

/**
 * Atomically claim one due job.
 *
 * A single conditional `UPDATE` because D1 has no interactive transactions. The apparently
 * redundant status/lease predicate in the outer `WHERE` is the compare-and-swap: a losing
 * concurrent claim matches zero rows and returns nothing.
 *
 * Also reclaims jobs whose lease expired, so a worker that died mid-flight does not leave
 * work stuck in `running` forever.
 */
export async function claimNextJob(db: Db, now: number, leaseMs: number): Promise<Job | undefined> {
  const lockedUntil = now + leaseMs;
  const rows = await db.all<Job>(sql`
    UPDATE jobs
       SET status = 'running',
           attempts = attempts + 1,
           locked_until = ${lockedUntil},
           updated_at = ${now}
     WHERE id = (
             SELECT id FROM jobs
              WHERE (status = 'pending' AND run_after <= ${now})
                 OR (status = 'running' AND locked_until IS NOT NULL AND locked_until <= ${now})
              ORDER BY run_after ASC
              LIMIT 1
           )
       AND (
             (status = 'pending' AND run_after <= ${now})
          OR (status = 'running' AND locked_until IS NOT NULL AND locked_until <= ${now})
           )
    RETURNING id,
              kind,
              account_id  AS accountId,
              item_id     AS itemId,
              status,
              attempts,
              run_after   AS runAfter,
              locked_until AS lockedUntil,
              last_error  AS lastError,
              created_at  AS createdAt,
              updated_at  AS updatedAt
  `);
  return rows[0];
}

export async function finishJob(db: Db, jobId: string, now: number): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'done', lockedUntil: null, lastError: null, updatedAt: now })
    .where(eq(jobs.id, jobId));
}

export async function failJob(db: Db, jobId: string, error: string, now: number): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'failed', lockedUntil: null, lastError: error, updatedAt: now })
    .where(eq(jobs.id, jobId));
}

/**
 * Reschedule a job.
 *
 * `consumeAttempt: false` is used for quota deferral: running out of quota is not a
 * failure of the job, and letting it burn retry attempts would eventually mark a perfectly
 * valid share as permanently failed for accounting reasons.
 */
export async function rescheduleJob(
  db: Db,
  jobId: string,
  runAfter: number,
  now: number,
  options: { error?: string; consumeAttempt?: boolean } = {},
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: 'pending',
    runAfter,
    lockedUntil: null,
    updatedAt: now,
  };
  if (options.error !== undefined) patch.lastError = options.error;
  if (options.consumeAttempt === false) {
    patch.attempts = sql`max(0, ${jobs.attempts} - 1)`;
  }
  await db.update(jobs).set(patch).where(eq(jobs.id, jobId));
}

/** Hold a job indefinitely — used while an account is `reauth_required`. */
export async function parkJob(db: Db, jobId: string, reason: string, now: number): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'parked', lockedUntil: null, lastError: reason, updatedAt: now })
    .where(eq(jobs.id, jobId));
}

/** Release every parked job for an account, after successful re-authorisation. */
export async function unparkJobsForAccount(
  db: Db,
  accountId: string,
  now: number,
): Promise<number> {
  const released = await db
    .update(jobs)
    .set({ status: 'pending', runAfter: now, lastError: null, updatedAt: now })
    .where(and(eq(jobs.accountId, accountId), eq(jobs.status, 'parked')))
    .returning({ id: jobs.id });
  return released.length;
}

export async function countJobsByStatus(db: Db): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: jobs.status, n: sql<number>`count(*)` })
    .from(jobs)
    .groupBy(jobs.status);
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = Number(row.n);
  return out;
}

// ─── Quota ledger ────────────────────────────────────────────────────────────

/**
 * Units spent across the whole instance for a quota day.
 *
 * Instance-wide, not per account, because the 10,000-unit allowance belongs to the Google
 * Cloud project — everyone sharing a deployment shares the pool.
 */
export async function sumQuotaForDate(db: Db, quotaDate: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${quotaLedger.unitsSpent}), 0)` })
    .from(quotaLedger)
    .where(eq(quotaLedger.quotaDate, quotaDate));
  return Number(rows[0]?.total ?? 0);
}

export async function addQuotaSpend(
  db: Db,
  accountId: string,
  quotaDate: string,
  units: number,
  now: number,
): Promise<void> {
  await db
    .insert(quotaLedger)
    .values({
      id: newId('qta'),
      accountId,
      quotaDate,
      unitsSpent: units,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [quotaLedger.accountId, quotaLedger.quotaDate],
      set: {
        unitsSpent: sql`${quotaLedger.unitsSpent} + ${units}`,
        updatedAt: now,
      },
    });
}

export async function quotaByAccountForDate(
  db: Db,
  quotaDate: string,
): Promise<{ accountId: string; unitsSpent: number }[]> {
  return await db
    .select({ accountId: quotaLedger.accountId, unitsSpent: quotaLedger.unitsSpent })
    .from(quotaLedger)
    .where(eq(quotaLedger.quotaDate, quotaDate));
}

// ─── Video cache ─────────────────────────────────────────────────────────────

export async function getCachedVideos(db: Db, videoIds: string[]): Promise<VideoCacheRow[]> {
  if (videoIds.length === 0) return [];
  return await db.select().from(videoCache).where(inArray(videoCache.videoId, videoIds));
}

export async function putCachedVideo(
  db: Db,
  row: {
    videoId: string;
    title?: string | null;
    channelTitle?: string | null;
    channelId?: string | null;
    durationSeconds?: number | null;
    availability: VideoAvailability;
  },
  now: number,
): Promise<void> {
  await db
    .insert(videoCache)
    .values({
      videoId: row.videoId,
      title: row.title ?? null,
      channelTitle: row.channelTitle ?? null,
      channelId: row.channelId ?? null,
      durationSeconds: row.durationSeconds ?? null,
      availability: row.availability,
      fetchedAt: now,
    })
    .onConflictDoUpdate({
      target: videoCache.videoId,
      set: {
        title: row.title ?? null,
        channelTitle: row.channelTitle ?? null,
        channelId: row.channelId ?? null,
        durationSeconds: row.durationSeconds ?? null,
        availability: row.availability,
        fetchedAt: now,
      },
    });
}

// ─── Rate limiting ───────────────────────────────────────────────────────────

/**
 * Increment a fixed-window counter and return the new count.
 *
 * A single upsert so concurrent requests cannot both read the same pre-increment value.
 */
export async function incrementRateLimit(
  db: Db,
  bucket: string,
  windowStart: number,
): Promise<number> {
  const rows = await db
    .insert(rateLimits)
    .values({ id: newId('rl'), bucket, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.bucket, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });
  return Number(rows[0]?.count ?? 1);
}

export async function pruneRateLimits(db: Db, before: number): Promise<void> {
  await db.delete(rateLimits).where(lte(rateLimits.windowStart, before));
}

// ─── OAuth handshake state ───────────────────────────────────────────────────

export async function putOAuthState(
  db: Db,
  input: { state: string; codeVerifier: string; redirectTo?: string | null; expiresAt: number },
  now: number,
): Promise<void> {
  await db.insert(oauthStates).values({
    state: input.state,
    codeVerifier: input.codeVerifier,
    redirectTo: input.redirectTo ?? null,
    expiresAt: input.expiresAt,
    createdAt: now,
  });
}

/**
 * Consume an OAuth state, single use.
 *
 * Deletes with `RETURNING` so a replayed callback finds nothing — the state is spent by the
 * act of reading it, which is what makes it a CSRF defence rather than a suggestion.
 */
export async function takeOAuthState(
  db: Db,
  state: string,
  now: number,
): Promise<{ codeVerifier: string; redirectTo: string | null } | undefined> {
  const rows = await db.delete(oauthStates).where(eq(oauthStates.state, state)).returning({
    codeVerifier: oauthStates.codeVerifier,
    redirectTo: oauthStates.redirectTo,
    expiresAt: oauthStates.expiresAt,
  });

  const row = rows[0];
  if (!row) return undefined;
  if (row.expiresAt <= now) return undefined;
  return { codeVerifier: row.codeVerifier, redirectTo: row.redirectTo };
}

export async function pruneOAuthStates(db: Db, now: number): Promise<void> {
  await db.delete(oauthStates).where(lte(oauthStates.expiresAt, now));
}
