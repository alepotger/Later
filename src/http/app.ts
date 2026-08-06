/**
 * The HTTP surface.
 *
 * One router, mounted by both entry points. The contract that matters most is on
 * `POST /api/ingest`: authenticate, validate, write a durable row, answer `202` in
 * milliseconds, and do the work afterwards. A share sheet must never wait.
 */

import { Hono } from 'hono';
import {
  countItemsByStatus,
  getCachedVideos,
  getSoloAccount,
  listItemsByShareKey,
  listRecentItems,
} from '../db/repo.ts';
import type { Account, ItemSource } from '../db/schema.ts';
import { processOne } from '../pipeline/worker.ts';
import type { Runtime } from '../runtime.ts';
import { ingest, summariseItems } from '../services/ingest.ts';
import { html } from './html.ts';
import { ICON_192_PNG_BASE64, ICON_512_PNG_BASE64 } from './icons.ts';
import {
  type AppBindings,
  rateLimit,
  requireIngestAuth,
  withRequestContext,
} from './middleware.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerReviewRoutes } from './routes/review.ts';
import { registerTelegramRoutes } from './routes/telegram.ts';
import { errorPage, homePage, setupPage, shareResultFlash } from './views.ts';

const VALID_SOURCES: ItemSource[] = ['web', 'ios-shortcut', 'pwa', 'telegram', 'api'];

export function createApp(runtime: Runtime): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use('*', withRequestContext(runtime));

  registerAuthRoutes(app);
  registerTelegramRoutes(app);
  registerReviewRoutes(app);

  // ─── Health ───────────────────────────────────────────────────────────────
  app.get('/healthz', (c) => c.json({ ok: true, mode: runtime.config.mode }));

  // ─── PWA manifest ─────────────────────────────────────────────────────────
  // `share_target` with method GET, so the Android share sheet passes the text as query
  // parameters to an ordinary page load and no service worker is needed. See ADR-0011.
  app.get('/manifest.webmanifest', (c) =>
    c.json(
      {
        name: 'Later',
        short_name: 'Later',
        description: 'Save the YouTube video a Reel or TikTok recommends.',
        start_url: '/',
        display: 'standalone',
        background_color: '#fbfbfa',
        theme_color: '#1f5fbf',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // A maskable copy, so Android can crop to its adaptive icon shape without
          // clipping the mark.
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        share_target: {
          action: '/share-target',
          method: 'GET',
          enctype: 'application/x-www-form-urlencoded',
          params: { title: 'title', text: 'text', url: 'url' },
        },
      },
      200,
      { 'content-type': 'application/manifest+json' },
    ),
  );

  // Icons are embedded in the bundle rather than served as static files, because the two
  // deploy targets handle static assets differently. Without a >=192px icon Android will not
  // offer "Add to Home screen", and without that there is no share target at all.
  for (const [path, base64] of [
    ['/icon-192.png', ICON_192_PNG_BASE64],
    ['/icon-512.png', ICON_512_PNG_BASE64],
  ] as const) {
    app.get(path, (c) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return c.body(bytes, 200, {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=31536000, immutable',
      });
    });
  }

  // ─── The ingest endpoint ──────────────────────────────────────────────────
  app.post(
    '/api/ingest',
    // Deliberately a single bucket for the whole endpoint, and deliberately *before* auth.
    // Keying it on the presented token would let an attacker rotate tokens to get a fresh
    // allowance per guess, which defeats the point.
    rateLimit(() => 'ingest'),
    requireIngestAuth(),
    async (c) => {
      const logger = c.get('logger');

      const account = await resolveIngestAccount(runtime);
      if (!account) {
        return c.json(
          {
            error: 'not_connected',
            detail: `No Google account is connected yet. Open ${runtime.config.publicBaseUrl}/auth/start first.`,
          },
          409,
        );
      }

      const payload = await readIngestBody(c);
      if (!payload.text || payload.text.trim() === '') {
        return c.json({ error: 'bad_request', detail: 'Provide a non-empty "text" field.' }, 400);
      }
      if (payload.text.length > 20_000) {
        return c.json(
          { error: 'bad_request', detail: 'Shared text is too long (max 20000).' },
          413,
        );
      }

      const result = await ingest(
        {
          db: runtime.db,
          clock: runtime.clock,
          logger,
          hasLlm: runtime.config.llm.provider !== 'none',
        },
        {
          accountId: account.id,
          text: payload.text,
          source: payload.source,
          ...(payload.idempotencyKey ? { idempotencyKey: payload.idempotencyKey } : {}),
          requestId: c.get('requestId'),
        },
      );

      // The durable row is already written, so this is an optimisation rather than the
      // mechanism: if the isolate dies here, the cron sweep picks the job up within a minute.
      const needsWork = result.items.some((item) => item.created && item.status === 'pending');
      if (needsWork) {
        runtime.schedule(async () => {
          const worker = await runtime.worker();
          // One job per created item, bounded so a huge share cannot run away.
          for (let i = 0; i < result.items.length + 1; i += 1) {
            if (!(await processOne(worker))) break;
          }
        });
      }

      return c.json(
        {
          accepted: true,
          shareKey: result.shareKey,
          items: result.items.map((item) => ({
            id: item.itemId,
            status: item.status,
            videoId: item.videoId,
            duplicate: !item.created,
          })),
          ...(result.rejection ? { note: result.rejection } : {}),
        },
        202,
      );
    },
  );

  // ─── Web UI ───────────────────────────────────────────────────────────────
  app.get('/', async (c) => {
    const account = await resolveIngestAccount(runtime);
    if (!account) return c.html(setupPage(runtime.config));
    return c.html(await renderHome(runtime, account, {}));
  });

  /** Paste box submit. Renders the outcome inline so it doubles as a debugging tool. */
  app.post('/share', async (c) => {
    const account = await resolveIngestAccount(runtime);
    if (!account) return c.html(setupPage(runtime.config));

    const form = await c.req.formData();
    const text = String(form.get('text') ?? '');
    if (text.trim() === '') {
      return c.html(await renderHome(runtime, account, {}));
    }

    const result = await ingest(
      {
        db: runtime.db,
        clock: runtime.clock,
        logger: c.get('logger'),
        hasLlm: runtime.config.llm.provider !== 'none',
      },
      { accountId: account.id, text, source: 'web', requestId: c.get('requestId') },
    );

    // The paste box is the debugging tool, so it waits for the work rather than returning a
    // spinner — unlike every other ingress, where the user has already left.
    const worker = await runtime.worker();
    for (let i = 0; i < result.items.length + 1; i += 1) {
      if (!(await processOne(worker))) break;
    }

    const settled = await listItemsByShareKey(runtime.db, result.shareKey);
    const summary = summariseItems(settled);

    // The paste box waited for the pipeline, so it knows the *final* reason. `result.rejection`
    // is the optimistic ingest-time note ("reading the text to work out which video it means"),
    // which would be stale and misleading by the time this renders.
    const settledReason = settled.find((item) => item.failureReason)?.failureReason ?? null;

    return c.html(
      await renderHome(runtime, account, {
        flash: shareResultFlash({
          ...summary,
          rejection: settledReason ?? result.rejection,
          // Idempotency matched everything, so this is a re-share rather than a new save.
          alreadyAccepted: result.items.every((item) => !item.created),
        }),
      }),
    );
  });

  /** Android PWA share target. Lands here, then auto-submits so it is still zero taps. */
  app.get('/share-target', async (c) => {
    const url = new URL(c.req.url);
    const shared = [
      url.searchParams.get('title'),
      url.searchParams.get('text'),
      url.searchParams.get('url'),
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n');

    const account = await resolveIngestAccount(runtime);
    if (!account) return c.html(setupPage(runtime.config));

    return c.html(
      await renderHome(runtime, account, {
        prefill: shared,
        flash: html`<div class="banner">
          <strong>Shared from another app</strong>
          Press <em>Save it</em> to confirm.
        </div>`,
      }),
    );
  });

  app.notFound((c) => c.html(errorPage(runtime.config, 'Not found', 'No such page.'), 404));

  app.onError((error, c) => {
    c.get('logger').error('unhandled request error', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (new URL(c.req.url).pathname.startsWith('/api/')) {
      return c.json({ error: 'internal_error' }, 500);
    }
    return c.html(
      errorPage(
        runtime.config,
        'Something went wrong',
        `The error has been logged with this request ID: ${c.get('requestId')}`,
      ),
      500,
    );
  });

  return app;
}

/**
 * Which account an ingest belongs to.
 *
 * SOLO resolves to the single account implicitly. MULTI will resolve it from the per-account
 * ingest token — the data model already carries `account_id` everywhere, so that is a change
 * to this function alone. See ADR-0013.
 */
async function resolveIngestAccount(runtime: Runtime): Promise<Account | undefined> {
  return await getSoloAccount(runtime.db);
}

interface IngestBody {
  text: string;
  source: ItemSource;
  idempotencyKey?: string;
}

/**
 * Read an ingest body tolerantly.
 *
 * Share sheets and Shortcuts are inconsistent: some send JSON, some send a form, some send a
 * bare URL as `text/plain`. All three are accepted, because rejecting one of them means an
 * ingress adapter that silently never works.
 */
async function readIngestBody(c: {
  req: { header(name: string): string | undefined; text(): Promise<string> };
}): Promise<IngestBody> {
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  const body = await c.req.text();

  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const text = [parsed.text, parsed.url, parsed.title]
        .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
        .join('\n');
      const source = typeof parsed.source === 'string' ? parsed.source : 'api';
      return {
        text,
        source: (VALID_SOURCES as string[]).includes(source) ? (source as ItemSource) : 'api',
        ...(typeof parsed.idempotencyKey === 'string'
          ? { idempotencyKey: parsed.idempotencyKey.slice(0, 128) }
          : {}),
      };
    } catch {
      // Malformed JSON is treated as plain text rather than rejected — the text is usually
      // still a perfectly good URL.
      return { text: body, source: 'api' };
    }
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(body);
    const text = [params.get('text'), params.get('url'), params.get('title')]
      .filter((v): v is string => Boolean(v && v.trim() !== ''))
      .join('\n');
    const source = params.get('source') ?? 'api';
    return {
      text,
      source: (VALID_SOURCES as string[]).includes(source) ? (source as ItemSource) : 'api',
    };
  }

  return { text: body, source: 'api' };
}

async function renderHome(
  runtime: Runtime,
  account: Account,
  options: { flash?: ReturnType<typeof html> | null; prefill?: string },
): Promise<string> {
  const items = await listRecentItems(runtime.db, account.id, 25);
  const counts = await countItemsByStatus(runtime.db, account.id);

  const videoIds = items
    .map((item) => item.resolvedVideoId)
    .filter((id): id is string => Boolean(id));
  const cached = await getCachedVideos(runtime.db, [...new Set(videoIds)]);
  const titles = new Map(
    cached.filter((row) => row.title).map((row) => [row.videoId, row.title as string]),
  );

  const scope = await runtime.forAccount(account.id);
  const quota = await scope.quota.summary();

  return homePage({
    config: runtime.config,
    email: account.email,
    playlistId: account.playlistId,
    playlistName: account.playlistName ?? runtime.config.playlist.name,
    items,
    titles,
    quota,
    counts,
    needsReauth: account.status === 'reauth_required',
    ...(options.prefill !== undefined ? { prefill: options.prefill } : {}),
    ...(options.flash !== undefined ? { flash: options.flash } : {}),
  });
}
