/**
 * Database schema — SQLite dialect, one definition for every deployment target.
 *
 * D1 *is* SQLite, so Cloudflare and the self-hosted Node path share this schema, these
 * migrations, and these queries, differing only in which driver is handed to Drizzle at
 * startup. See docs/adr/0003-sqlite-dialect-everywhere-drizzle.md.
 *
 * Conventions, enforced here because SQLite will not enforce them for us:
 *  - timestamps are integer epoch milliseconds
 *  - booleans are integers, 0 or 1
 *  - JSON blobs are TEXT, parsed and validated at the boundary rather than trusted
 */

import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const ACCOUNT_STATUSES = ['active', 'reauth_required', 'disabled'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * One row per authorised Google account.
 *
 * Present in both SOLO and MULTI mode — there is no single-user schema, so switching
 * modes never needs a migration. See docs/adr/0013-solo-and-multi-modes.md.
 */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    googleUserId: text('google_user_id').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),

    status: text('status', { enum: ACCOUNT_STATUSES }).notNull().default('active'),

    /**
     * AES-256-GCM ciphertext, never plaintext. The key lives in the environment and is
     * never written to the database, so a leaked database dump yields nothing usable.
     */
    refreshTokenCipher: text('refresh_token_cipher'),
    accessTokenCipher: text('access_token_cipher'),
    accessTokenExpiresAt: integer('access_token_expires_at'),

    /** The app-owned destination playlist. Nullable until first find-or-create. */
    playlistId: text('playlist_id'),
    playlistName: text('playlist_name'),

    /** MULTI mode: per-account ingest credential, stored only as a SHA-256 hash. */
    ingestTokenHash: text('ingest_token_hash'),

    /** Drives the keep-alive sweep that defends against the six-month idle rule. */
    lastTokenRefreshAt: integer('last_token_refresh_at'),
    /** Set when the reauth notification was sent, so it is sent once and not per retry. */
    reauthNotifiedAt: integer('reauth_notified_at'),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('accounts_google_user_id_uq').on(t.googleUserId),
    index('accounts_status_idx').on(t.status),
  ],
);

export const ITEM_STATUSES = [
  /** Accepted, not yet processed. */
  'pending',
  /** Successfully added to the playlist. */
  'added',
  /** Already in the playlist. Working correctly, not a failure. */
  'duplicate',
  /** Resolved below the confidence threshold; waiting for one tap. */
  'held_for_review',
  /** The user declined it from the review inbox. */
  'rejected',
  /** No YouTube video could be found in the share. */
  'unresolvable',
  /** Video exists but is private, deleted, or region-blocked. */
  'blocked',
  /** Quota exhausted; retrying after the next reset. Never dropped. */
  'deferred',
  /** Account needs re-authorisation. Held, not failed, so nothing is lost. */
  'parked',
  /** Retries exhausted against a genuine error. */
  'failed',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const ITEM_SOURCES = ['web', 'ios-shortcut', 'pwa', 'telegram', 'api'] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];

/**
 * One row per video we are trying to save.
 *
 * A share containing three YouTube links becomes three rows sharing a `shareKey`, each
 * with its own status — so a share where one video is private and two are fine reports
 * exactly that, rather than a single ambiguous outcome. A share with no link yet becomes
 * one row awaiting a later tier.
 */
export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),

    /**
     * Idempotency key. Derived from the account, the normalised share text, and the
     * specific video when one is already known, so re-sharing the same thing twice can
     * never produce two playlist entries.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    /** Groups the rows that came from a single share. */
    shareKey: text('share_key').notNull(),

    source: text('source', { enum: ITEM_SOURCES }).notNull(),
    /** The raw shared text, kept so the review inbox can show what arrived. */
    rawText: text('raw_text').notNull(),

    status: text('status', { enum: ITEM_STATUSES }).notNull().default('pending'),

    resolvedVideoId: text('resolved_video_id'),
    /** Which tier resolved it: 0 URL, 1 oEmbed, 2 LLM, 3 transcript. */
    resolvedTier: integer('resolved_tier'),
    confidence: real('confidence'),
    /** Human-readable reason for a non-success status, shown in the UI verbatim. */
    failureReason: text('failure_reason'),

    /** Ties this row to the log lines for the request that created it. */
    requestId: text('request_id'),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('items_account_idempotency_uq').on(t.accountId, t.idempotencyKey),
    index('items_account_status_idx').on(t.accountId, t.status),
    index('items_share_key_idx').on(t.shareKey),
    index('items_created_at_idx').on(t.createdAt),
  ],
);

/**
 * What Later has actually added to a playlist.
 *
 * The unique constraint is the *only* thing preventing duplicates: YouTube stopped
 * rejecting duplicate `playlistItems.insert` calls in the same 2016 revision that
 * removed Watch Later access, so there is no server-side backstop. See
 * docs/verification-log.md.
 */
export const playlistEntries = sqliteTable(
  'playlist_entries',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    videoId: text('video_id').notNull(),
    playlistId: text('playlist_id').notNull(),
    /** YouTube's own ID for the playlist entry, needed to remove it later. */
    playlistItemId: text('playlist_item_id'),
    itemId: text('item_id'),
    addedAt: integer('added_at').notNull(),
  },
  (t) => [uniqueIndex('playlist_entries_account_video_uq').on(t.accountId, t.videoId)],
);

export const JOB_KINDS = ['resolve_item', 'token_keepalive'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ['pending', 'running', 'done', 'failed', 'parked'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * The work queue. A table rather than a managed queue service, because Cloudflare Queues
 * requires a paid plan and an external queue would add an account to the onboarding path.
 * See docs/adr/0007-async-work-cron-driven-jobs.md.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: JOB_KINDS }).notNull(),
    accountId: text('account_id'),
    itemId: text('item_id'),

    status: text('status', { enum: JOB_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),

    /** Not eligible to run before this time. Carries quota deferral and backoff. */
    runAfter: integer('run_after').notNull(),
    /** Lease expiry, so a job whose worker died is picked up again rather than stuck. */
    lockedUntil: integer('locked_until'),

    lastError: text('last_error'),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('jobs_due_idx').on(t.status, t.runAfter),
    uniqueIndex('jobs_item_kind_uq').on(t.itemId, t.kind),
  ],
);

/**
 * Units of YouTube API quota spent per day.
 *
 * `quotaDate` is a `YYYY-MM-DD` string in the configured reset time zone, not UTC:
 * Google's quota resets at midnight Pacific, and using UTC would refill the budget at
 * the wrong time by up to eight hours.
 *
 * Rows are per account, but the *gate* sums across all accounts for a date, because the
 * 10,000-unit allowance belongs to the Google Cloud project and everyone on the instance
 * shares it.
 */
export const quotaLedger = sqliteTable(
  'quota_ledger',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    quotaDate: text('quota_date').notNull(),
    unitsSpent: integer('units_spent').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('quota_ledger_account_date_uq').on(t.accountId, t.quotaDate),
    index('quota_ledger_date_idx').on(t.quotaDate),
  ],
);

export const VIDEO_AVAILABILITY = ['available', 'private', 'deleted', 'blocked'] as const;
export type VideoAvailability = (typeof VIDEO_AVAILABILITY)[number];

/**
 * Resolved video metadata, so nothing is ever looked up twice.
 *
 * Stores only what the pipeline needs to make decisions and show the user what it did.
 * No thumbnails, no descriptions, no captions — per the minimum-storage rule in
 * SECURITY.md.
 */
export const videoCache = sqliteTable('video_cache', {
  videoId: text('video_id').primaryKey(),
  title: text('title'),
  channelTitle: text('channel_title'),
  channelId: text('channel_id'),
  durationSeconds: integer('duration_seconds'),
  availability: text('availability', { enum: VIDEO_AVAILABILITY }).notNull(),
  fetchedAt: integer('fetched_at').notNull(),
});

/** Fixed-window rate limit counters for the ingest endpoint. */
export const rateLimits = sqliteTable(
  'rate_limits',
  {
    id: text('id').primaryKey(),
    bucket: text('bucket').notNull(),
    windowStart: integer('window_start').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [uniqueIndex('rate_limits_bucket_window_uq').on(t.bucket, t.windowStart)],
);

/**
 * Short-lived OAuth handshake state.
 *
 * Holds the CSRF `state` and the PKCE code verifier between `/auth/start` and
 * `/auth/callback`. Rows are single-use and swept once expired.
 */
export const oauthStates = sqliteTable(
  'oauth_states',
  {
    state: text('state').primaryKey(),
    codeVerifier: text('code_verifier').notNull(),
    redirectTo: text('redirect_to'),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('oauth_states_expires_idx').on(t.expiresAt)],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type PlaylistEntry = typeof playlistEntries.$inferSelect;
export type VideoCacheRow = typeof videoCache.$inferSelect;
