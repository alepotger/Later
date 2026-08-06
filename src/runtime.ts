/**
 * The composition root.
 *
 * Everything impure is constructed here and nowhere else, so the rest of the codebase takes
 * its dependencies as arguments and can be handed fixtures instead. This file is the only
 * place that knows whether we are talking to real Google or to recorded responses.
 */

import { geminiLlm, openAiCompatibleLlm } from './adapters/llm/providers.ts';
import {
  createTelegramClient,
  type TelegramClient,
  type TelegramConfig,
  telegramNotifier,
} from './adapters/notify/telegram.ts';
import { fanout, webhookNotifier } from './adapters/notify/webhook.ts';
import { createOEmbedClient, type PlatformMetadataPort } from './adapters/platform/oembed.ts';
import {
  createFixtureYouTubeClient,
  type FixtureYouTubeClient,
} from './adapters/youtube/fixture.ts';
import { createGoogleYouTubeClient } from './adapters/youtube/google.ts';
import type { Config } from './config.ts';
import { createVault, type Vault } from './crypto/vault.ts';
import type { Db } from './db/index.ts';
import type { ResolveDeps } from './pipeline/resolve.ts';
import type { WorkerDeps } from './pipeline/worker.ts';
import type { Clock } from './ports/clock.ts';
import { systemClock } from './ports/clock.ts';
import { fixtureLlm, type LlmPort, noopLlm } from './ports/llm.ts';
import { createLogger, type Logger } from './ports/logger.ts';
import { type Notifier, nonBlocking, nullNotifier } from './ports/notifier.ts';
import type { QuotaRecorder, YouTubeClient } from './ports/youtube.ts';
import { createPlaylistService, type PlaylistService } from './services/playlist.ts';
import { createQuotaService, type QuotaService } from './services/quota.ts';
import { createTokenService, type TokenService } from './services/tokens.ts';

/** Per-account services. The YouTube client and quota ledger are both account-scoped. */
export interface AccountScope extends ResolveDeps {
  youtube: YouTubeClient;
  quota: QuotaService;
  playlists: PlaylistService;
}

export interface Runtime {
  config: Config;
  db: Db;
  clock: Clock;
  logger: Logger;
  vault: Vault;
  notifier: Notifier;
  tokens: TokenService;
  /** Present only when a bot token is configured. Used by the ingress route to reply. */
  telegram: TelegramClient | undefined;
  telegramConfig: TelegramConfig | undefined;
  forAccount(accountId: string): Promise<AccountScope>;
  worker(): Promise<WorkerDeps>;
  /** Run work after the response has been sent. Abstracts `waitUntil` vs a detached promise. */
  schedule(task: () => Promise<unknown>): void;
}

export interface BuildRuntimeOptions {
  config: Config;
  db: Db;
  clock?: Clock;
  logger?: Logger;
  notifier?: Notifier;
  /** Cloudflare's `ctx.waitUntil`, when running as a Worker. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Overridden in tests to avoid touching the network. */
  fetch?: typeof fetch;
  /**
   * Supply the YouTube client directly.
   *
   * Used by tests so each one gets its own isolated fixture client rather than the
   * process-wide one that `USE_FIXTURES=true` relies on. Receives the real quota recorder,
   * so quota accounting still flows through the ledger and exhaustion behaviour is genuinely
   * exercised rather than simulated.
   */
  youtubeFor?: (accountId: string, quota: QuotaRecorder) => YouTubeClient;
  /** Override Tier 2 in tests, so no key and no network are needed. */
  llm?: LlmPort;
  /** Override Tier 1 in tests. */
  platform?: PlatformMetadataPort;
}

/** Pick the Tier 2 provider from config. See docs/adr/0009. */
function buildLlm(config: Config, logger: Logger, fetchImpl?: typeof fetch): LlmPort {
  const deps = { logger, ...(fetchImpl ? { fetch: fetchImpl } : {}) };
  switch (config.llm.provider) {
    case 'gemini':
      return config.llm.geminiApiKey
        ? geminiLlm({ apiKey: config.llm.geminiApiKey, model: config.llm.model }, deps)
        : noopLlm;
    case 'openai-compatible':
      return config.llm.openaiBaseUrl
        ? openAiCompatibleLlm(
            {
              baseUrl: config.llm.openaiBaseUrl,
              apiKey: config.llm.openaiApiKey,
              model: config.llm.model,
            },
            deps,
          )
        : noopLlm;
    case 'fixture':
      return fixtureLlm();
    default:
      return noopLlm;
  }
}

/**
 * A single fixture client per process.
 *
 * Module-level so that `USE_FIXTURES=true` behaves like a real deployment across requests —
 * a playlist you added to stays added, and dedupe is observable in the UI.
 *
 * The quota recorder is per-account and does not exist when the client is built, so it is
 * reached through a mutable reference set on each `forAccount` call. Without this the quota
 * meter in fixtures mode would permanently read zero, which would quietly misrepresent one of
 * the things a person is most likely to be evaluating.
 */
let sharedFixtureClient: FixtureYouTubeClient | undefined;
let currentFixtureQuota: QuotaRecorder | undefined;

export function fixtureClient(quota?: QuotaRecorder): FixtureYouTubeClient {
  currentFixtureQuota = quota;
  if (!sharedFixtureClient) {
    sharedFixtureClient = createFixtureYouTubeClient({
      playlists: [{ id: 'PLfixtureLater', title: 'Later' }],
      quota: {
        reserve: (operation, units) =>
          currentFixtureQuota?.reserve(operation, units) ?? Promise.resolve(),
        record: (operation, units) =>
          currentFixtureQuota?.record(operation, units) ?? Promise.resolve(),
      },
    });
  }
  return sharedFixtureClient;
}

export async function buildRuntime(options: BuildRuntimeOptions): Promise<Runtime> {
  const { config, db } = options;
  const clock = options.clock ?? systemClock;
  const baseLogger = options.logger ?? createLogger({ level: config.logLevel });

  // Build the configured channels. An explicit `notifier` (tests) replaces them entirely.
  let telegram: TelegramClient | undefined;
  let telegramConfig: TelegramConfig | undefined;
  const channels: Notifier[] = [];

  if (config.notify.telegramBotToken) {
    telegramConfig = {
      botToken: config.notify.telegramBotToken,
      allowedChatIds: config.notify.telegramAllowedChatIds,
      webhookSecret: config.notify.telegramWebhookSecret,
    };
    telegram = createTelegramClient(telegramConfig, {
      logger: baseLogger,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    channels.push(telegramNotifier(telegram, telegramConfig, config.notify.onSuccess));
  }

  if (config.notify.webhookUrl) {
    channels.push(
      webhookNotifier(
        config.notify.webhookUrl,
        { logger: baseLogger, ...(options.fetch ? { fetch: options.fetch } : {}) },
        config.notify.onSuccess,
      ),
    );
  }

  const configured: Notifier =
    options.notifier ?? (channels.length === 0 ? nullNotifier : fanout(channels));

  // A notification failure must never become a playlist failure.
  const notifier = nonBlocking(configured, (error, notification) => {
    baseLogger.warn('notification delivery failed', {
      kind: notification.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Tier 2 provider. `none` is the default and the product works fully without it.
  const llm: LlmPort = options.llm ?? buildLlm(config, baseLogger, options.fetch);
  const platform: PlatformMetadataPort =
    options.platform ??
    createOEmbedClient({
      logger: baseLogger,
      instagramToken: config.resolve.instagramOembedToken,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });

  const vault = await createVault(config.secrets.tokenEncryptionKey);

  const tokens = createTokenService({
    db,
    config,
    vault,
    clock,
    logger: baseLogger,
    notifier,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  async function forAccount(accountId: string): Promise<AccountScope> {
    const logger = baseLogger.child({ accountId });
    const quota = createQuotaService({ db, config, clock, accountId });

    const youtube: YouTubeClient = options.youtubeFor
      ? options.youtubeFor(accountId, quota)
      : config.useFixtures
        ? fixtureClient(quota)
        : createGoogleYouTubeClient({
            getAccessToken: () => tokens.getAccessToken(accountId),
            quota,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          });

    const playlists = createPlaylistService({ db, config, clock, logger, youtube });

    return {
      db,
      config,
      clock,
      logger,
      notifier,
      youtube,
      quota,
      playlists,
      tokens,
      llm,
      platform,
    };
  }

  const runtime: Runtime = {
    config,
    db,
    clock,
    logger: baseLogger,
    vault,
    notifier,
    tokens,
    telegram,
    telegramConfig,
    forAccount,

    async worker(): Promise<WorkerDeps> {
      // A worker needs *some* scope to start from; per-job scopes are built by `forAccount`.
      const placeholder = await forAccount('__unscoped__');
      return { ...placeholder, tokens, forAccount };
    },

    schedule(task) {
      const promise = task().catch((error: unknown) => {
        baseLogger.error('scheduled task failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      if (options.waitUntil) {
        // Workers: keeps the isolate alive past the response.
        options.waitUntil(promise);
      }
      // Node: the detached promise is already running, and the catch above means an
      // unhandled rejection cannot take the process down.
    },
  };

  return runtime;
}
