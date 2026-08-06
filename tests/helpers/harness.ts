/**
 * Integration test harness.
 *
 * Builds a complete Later instance over in-memory SQLite and an isolated fixture YouTube
 * client, then exercises it through real HTTP requests against the real Hono router. The
 * fixture boundary is the *network*, not our own code, so routing, middleware, SQL,
 * migrations, and the pipeline are all genuinely under test.
 *
 * No credentials, no network, no clock dependency.
 */

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  createFixtureYouTubeClient,
  type FixtureYouTubeClient,
  type FixtureYouTubeOptions,
} from '../../src/adapters/youtube/fixture.ts';
import type { Config } from '../../src/config.ts';
import { randomBytes } from '../../src/core/bytes.ts';
import type { Db } from '../../src/db/index.ts';
import { openNodeDb } from '../../src/db/node.ts';
import { upsertAccount } from '../../src/db/repo.ts';
import type { Account } from '../../src/db/schema.ts';
import { createApp } from '../../src/http/app.ts';
import { fixedClock } from '../../src/ports/clock.ts';
import { silentLogger } from '../../src/ports/logger.ts';
import type { Notification } from '../../src/ports/notifier.ts';
import { recordingNotifier } from '../../src/ports/notifier.ts';
import type { QuotaRecorder } from '../../src/ports/youtube.ts';
import { buildRuntime, type Runtime } from '../../src/runtime.ts';

export const INGEST_TOKEN = 'test-ingest-token-long-enough-to-pass-validation';
export const TEST_KEY = randomBytes(32);

/** 6 August 2026, 13:00 Pacific — comfortably mid-quota-day. */
export const T0 = new Date('2026-08-06T20:00:00Z');

export function testConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    mode: 'SOLO',
    allowedEmails: [],
    publicBaseUrl: 'http://localhost:8787',
    logLevel: 'error',
    playlist: { name: 'Later', privacy: 'private' },
    ingest: { token: INGEST_TOKEN, hmacSecret: undefined, rateLimitPerMinute: 30 },
    google: {
      clientId: 'test.apps.googleusercontent.com',
      clientSecret: 'test-secret',
      publishingStatus: 'production',
    },
    secrets: { tokenEncryptionKey: TEST_KEY, sessionSecret: 'test-session-secret' },
    quota: { dailyBudget: 9000, resetTimeZone: 'America/Los_Angeles' },
    resolve: {
      confidenceThreshold: 0.75,
      enablePlatformMetadata: true,
      instagramOembedToken: undefined,
      enableTranscript: false,
    },
    llm: {
      provider: 'none',
      geminiApiKey: undefined,
      openaiBaseUrl: undefined,
      openaiApiKey: undefined,
      model: 'none',
    },
    notify: {
      telegramBotToken: undefined,
      telegramAllowedChatIds: [],
      telegramWebhookSecret: undefined,
      webhookUrl: undefined,
      onSuccess: false,
    },
    databasePath: ':memory:',
    useFixtures: false,
  };
  return { ...base, ...overrides };
}

export interface Harness {
  runtime: Runtime;
  db: Db;
  config: Config;
  youtube: FixtureYouTubeClient;
  clock: ReturnType<typeof fixedClock>;
  notifications: Notification[];
  /** The connected account, unless the harness was built with `connect: false`. */
  account: Account;
  /** Send a request through the real router. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** POST /api/ingest with the bearer token already attached. */
  ingest(text: string, init?: { token?: string; source?: string }): Promise<Response>;
  /** Drain the job queue the way the cron sweep would. */
  drain(max?: number): Promise<void>;
  close(): void;
}

export interface HarnessOptions {
  config?: Partial<Config>;
  /** Skip creating an account, to test the not-connected paths. */
  connect?: boolean;
  /** Seed the fixture YouTube client — pre-existing playlists, extra videos, search results. */
  youtube?: FixtureYouTubeOptions;
  notifierFailing?: boolean;
  /**
   * Pass `null` to let the runtime build its real notification channels from config, instead of
   * substituting the recording one. Used by the Telegram tests, which need the actual adapter.
   */
  notifier?: null;
  /** Stub outbound HTTP (Telegram, Google token endpoint). The YouTube client is separate. */
  fetch?: typeof fetch;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const config = testConfig(options.config);
  const { db, close } = openNodeDb(':memory:');

  // Real migrations, so the schema under test is the schema that ships.
  migrate(db as never, { migrationsFolder: 'drizzle' });

  const clock = fixedClock(T0);
  const notifier = recordingNotifier(
    options.notifierFailing === undefined ? {} : { failing: options.notifierFailing },
  );

  // The fixture client is created once, but the quota recorder it reports to is per-account
  // and only exists once `forAccount` runs. Forwarding through a mutable reference keeps a
  // single client (so playlist contents accumulate across requests, as in production) while
  // still routing every unit through the real DB-backed ledger — which is what makes the
  // quota-exhaustion tests genuine rather than simulated.
  let currentQuota: QuotaRecorder | undefined;
  const youtube: FixtureYouTubeClient = createFixtureYouTubeClient({
    // Defaults to no playlists, so find-or-create must actually create — the real
    // first-run path.
    playlists: [],
    ...options.youtube,
    quota: {
      reserve: (operation, units) => currentQuota?.reserve(operation, units) ?? Promise.resolve(),
      record: (operation, units) => currentQuota?.record(operation, units) ?? Promise.resolve(),
    },
  });

  // Collect the work `runtime.schedule` kicks off after a response, so tests can await it.
  // This is exactly the Cloudflare `waitUntil` contract, so the tests exercise the same
  // fast path production uses rather than a special-cased synchronous one.
  const pending: Promise<unknown>[] = [];

  const runtime = await buildRuntime({
    config,
    db,
    clock,
    logger: silentLogger,
    // `notifier: null` means "use the channels config asks for", so the real adapters run.
    ...(options.notifier === null ? {} : { notifier }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    youtubeFor: (_accountId, quota) => {
      currentQuota = quota;
      return youtube;
    },
    waitUntil: (promise) => {
      pending.push(promise);
    },
  });

  let account: Account | undefined;
  if (options.connect !== false) {
    account = await upsertAccount(
      db,
      {
        googleUserId: 'google-user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
        refreshTokenCipher: await runtime.vault.encrypt('refresh-token-1'),
        accessTokenCipher: await runtime.vault.encrypt('access-token-1'),
        // Valid for an hour, so nothing tries to refresh unless a test wants it to.
        accessTokenExpiresAt: T0.getTime() + 3_600_000,
      },
      T0.getTime(),
    );
  }

  const app = createApp(runtime);

  const harness: Harness = {
    runtime,
    db,
    config,
    youtube,
    clock,
    notifications: notifier.sent,
    // Non-null assertion is safe: every caller that reads `account` builds with connect!==false.
    account: account as Account,

    async request(path, init) {
      return await app.fetch(new Request(`http://localhost:8787${path}`, init));
    },

    async ingest(text, init = {}) {
      return await app.fetch(
        new Request('http://localhost:8787/api/ingest', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${init.token ?? INGEST_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ text, source: init.source ?? 'api' }),
        }),
      );
    },

    async drain(max = 25) {
      // First let the inline fast path finish — it has usually already claimed the job.
      // Loop because a settled task can schedule more work.
      for (let guard = 0; guard < 10 && pending.length > 0; guard += 1) {
        const inFlight = pending.splice(0, pending.length);
        await Promise.all(inFlight);
      }
      // Then sweep, exactly as cron would, to pick up anything the fast path did not finish.
      const { sweep } = await import('../../src/pipeline/worker.ts');
      await sweep(await runtime.worker(), max);
    },

    close,
  };

  return harness;
}
