/**
 * The web UI.
 *
 * Four screens and about a dozen interactions. Server-rendered, no client framework, forms
 * that work without JavaScript — which matters because a lot of these page loads happen
 * inside the in-app browsers that share sheets open. See ADR-0011.
 */

import type { Config } from '../config.ts';
import type { Item, ItemStatus, VideoCacheRow } from '../db/schema.ts';
import { playlistUrl } from '../services/playlist.ts';
import type { QuotaSummary } from '../services/quota.ts';
import { type Html, html, when } from './html.ts';

const STYLES = `
:root{--bg:#fbfbfa;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e4e4e1;--card:#fff;
--ok:#16794a;--warn:#8a5a00;--bad:#a32020;--accent:#1f5fbf;--radius:10px}
@media (prefers-color-scheme:dark){:root{--bg:#161617;--fg:#ececec;--muted:#9a9a9a;
--line:#2e2e30;--card:#1f1f21;--ok:#4ec98a;--warn:#e0a83a;--bad:#f08080;--accent:#7fb0f5}}
*{box-sizing:border-box}
body{margin:0;padding:0;background:var(--bg);color:var(--fg);
font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
-webkit-text-size-adjust:100%}
.wrap{max-width:44rem;margin:0 auto;padding:1.5rem 1.1rem 4rem}
header{display:flex;align-items:baseline;gap:.6rem;margin-bottom:.25rem}
h1{font-size:1.5rem;margin:0;letter-spacing:-.02em}
h2{font-size:1.05rem;margin:2rem 0 .6rem;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:.9rem;margin:0 0 1.5rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
padding:1rem;margin:0 0 1rem}
textarea{width:100%;min-height:5.5rem;padding:.7rem;font:inherit;font-size:1rem;
border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);resize:vertical}
button{font:inherit;font-weight:600;padding:.6rem 1.1rem;border:0;border-radius:8px;
background:var(--accent);color:#fff;cursor:pointer}
button:hover{filter:brightness(1.08)}
button.secondary{background:transparent;color:var(--accent);border:1px solid var(--line)}
.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:.7rem}
a{color:var(--accent)}
.banner{border-left:3px solid var(--warn);background:var(--card);border-radius:6px;
padding:.8rem 1rem;margin:0 0 1rem;font-size:.92rem}
.banner.bad{border-left-color:var(--bad)}
.banner.ok{border-left-color:var(--ok)}
.banner strong{display:block;margin-bottom:.2rem}
ul.items{list-style:none;margin:0;padding:0}
ul.items li{border-bottom:1px solid var(--line);padding:.7rem 0;display:flex;
gap:.7rem;align-items:flex-start}
ul.items li:last-child{border-bottom:0}
.pill{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
padding:.2rem .45rem;border-radius:5px;white-space:nowrap;flex-shrink:0;margin-top:.15rem}
.pill.added{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
.pill.duplicate,.pill.pending,.pill.deferred,.pill.parked,.pill.held_for_review
{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
.pill.failed,.pill.unresolvable,.pill.blocked,.pill.rejected
{background:color-mix(in srgb,var(--bad) 14%,transparent);color:var(--bad)}
.item-body{min-width:0;flex:1}
.item-title{font-weight:600;overflow-wrap:anywhere}
.item-meta{color:var(--muted);font-size:.83rem;overflow-wrap:anywhere}
.meter{height:5px;background:var(--line);border-radius:3px;overflow:hidden;margin:.5rem 0 .3rem}
.meter span{display:block;height:100%;background:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.8rem}
.stat b{display:block;font-size:1.3rem;letter-spacing:-.02em}
.stat span{color:var(--muted);font-size:.8rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;
background:var(--card);border:1px solid var(--line);border-radius:4px;padding:.05rem .3rem}
footer{margin-top:2.5rem;color:var(--muted);font-size:.82rem;border-top:1px solid var(--line);
padding-top:1rem}
`;

export function layout(options: {
  title: string;
  body: Html;
  config: Config;
  banner?: Html | null;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow">
<title>${options.title}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<link rel="apple-touch-icon" href="/icon-192.png">
<style>${STYLES}</style>
</head>
<body><div class="wrap">
<header><h1>Later</h1></header>
${options.banner?.toString() ?? ''}
${options.body.toString()}
<footer>
Later saves to a playlist it created, <strong>not</strong> your native Watch&nbsp;Later —
Google removed API access to that in 2016.
<a href="https://github.com/alepotger/Later#read-this-first-later-cannot-write-to-your-real-watch-later">Why</a>.
</footer>
</div></body></html>`;
}

/** The standing warning for an OAuth app left in Testing status. */
export function testingModeBanner(): Html {
  return html`<div class="banner">
    <strong>Authorisation will expire in 7 days</strong>
    Your Google OAuth app is in <code>Testing</code> status, so Google revokes the refresh
    token after a week and Later stops saving videos. Fix it once: open
    <a href="https://console.cloud.google.com/auth/overview">Google Auth Platform</a>, click
    <strong>Publish app</strong>, then set
    <code>GOOGLE_OAUTH_PUBLISHING_STATUS=production</code>.
  </div>`;
}

export function reauthBanner(email: string): Html {
  return html`<div class="banner bad">
    <strong>Later has stopped saving videos</strong>
    Google authorisation for ${email} has expired or been revoked. Everything you shared since
    then is still queued and will be saved as soon as you reconnect.
    <div class="row"><a href="/auth/start"><button>Reconnect Google</button></a></div>
  </div>`;
}

/** The first screen a fresh deployment shows. */
export function setupPage(config: Config): string {
  const body = html`
    <p class="sub">Connect the Google account whose playlist Later should write to.</p>
    <div class="card">
      <h2 style="margin-top:0">Not connected yet</h2>
      <p>
        Later will create a private playlist called <code>${config.playlist.name}</code> in your
        account and add videos there.
      </p>
      <div class="row"><a href="/auth/start"><button>Connect Google</button></a></div>
    </div>
    ${when(
      config.google.publishingStatus === 'testing',
      () => html`<div class="banner">
        <strong>Before you connect: publish your OAuth app</strong>
        It is currently in <code>Testing</code>, which means Google will revoke access after 7
        days. Publishing takes one click and is free — see
        <code>docs/ACTION-REQUIRED.md</code> step 6.
      </div>`,
    )}
    ${when(
      config.useFixtures,
      () => html`<div class="banner">
        <strong>Fixtures mode</strong>
        <code>USE_FIXTURES=true</code>, so nothing reaches YouTube and no video is really
        saved. Good for looking around; set it to <code>false</code> when you want it to work.
      </div>`,
    )}
  `;
  return layout({ title: 'Later — setup', body, config });
}

/**
 * MULTI mode with no session cookie.
 *
 * Deliberately not the SOLO setup page: this instance is already running and probably already
 * has other people on it, so the message is "identify yourself", not "finish setting me up".
 */
export function signInPage(config: Config): string {
  const body = html`
    <p class="sub">This instance is shared. Sign in with Google to see your own shares.</p>
    <div class="card">
      <h2 style="margin-top:0">Sign in</h2>
      <p>
        Later will create a private playlist called <code>${config.playlist.name}</code> in your
        account and add videos there. It cannot see anyone else's.
      </p>
      <div class="row"><a href="/auth/start"><button>Continue with Google</button></a></div>
      <p class="item-meta" style="margin-bottom:0">
        Only accounts listed in <code>LATER_ALLOWED_EMAILS</code> can connect. If yours is not
        on it, ask whoever runs this instance.
      </p>
    </div>
  `;
  return layout({ title: 'Later — sign in', body, config });
}

/**
 * A freshly minted ingest token, shown exactly once.
 *
 * Only the SHA-256 is stored, so this is genuinely the only time it can be displayed — which
 * is worth saying on the screen rather than letting someone discover it by closing the tab.
 */
export function ingestTokenPanel(token: string, publicBaseUrl: string): Html {
  return html`<div class="banner ok">
    <strong>Your personal ingest token — copy it now</strong>
    Later stores only a hash of this, so it cannot be shown again. It is what the iOS Shortcut,
    the Telegram bot and <code>curl</code> use to prove a share is yours.
    <pre
      style="overflow-x:auto;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:.6rem;margin:.7rem 0 0"
    ><code>${token}</code></pre>
    <div class="item-meta" style="margin-top:.5rem">
      Test it: <code>curl -X POST ${publicBaseUrl}/api/ingest -H "authorization: Bearer ${token}"
      -d '{"text":"https://youtu.be/dQw4w9WgXcQ"}' -H 'content-type: application/json'</code>
    </div>
  </div>`;
}

/**
 * The account panel, MULTI only.
 *
 * SOLO shows none of this: one account, one token in `.env`, nothing to choose or link. Adding
 * it there would spend the onboarding budget on concepts that do not apply.
 */
export function multiAccountPanel(options: {
  email: string;
  hasIngestToken: boolean;
  telegramLinkCode: string | null;
  telegramLinked: boolean;
  /** Your spend against the instance's, because the daily budget is one shared pool. */
  quota: { yours: number; instance: number; budget: number };
}): Html {
  return html`<h2>Your account</h2>
    <div class="card">
      <div class="item-meta">Signed in as ${options.email}</div>
      <p style="margin:.5rem 0 0">
        You have used <strong>${options.quota.yours}</strong> of the
        ${options.quota.instance} units spent on this instance today, out of
        ${options.quota.budget}. The daily budget belongs to the Google Cloud project, so
        everyone here shares one pool.
      </p>

      <div class="row">
        <form method="post" action="/account/ingest-token">
          <button type="submit" class="secondary">
            ${options.hasIngestToken ? 'Replace my ingest token' : 'Create my ingest token'}
          </button>
        </form>
        <form method="post" action="/auth/signout">
          <button type="submit" class="secondary">Sign out</button>
        </form>
      </div>
      ${when(
        options.hasIngestToken,
        () => html`<p class="item-meta" style="margin:.6rem 0 0">
          Replacing it immediately stops every client using the old one. You will need to paste
          the new token into your Shortcut or PWA again.
        </p>`,
      )}

      ${when(
        options.telegramLinkCode !== null,
        () => html`<hr style="border:0;border-top:1px solid var(--line);margin:1rem 0" />
          <div class="item-meta">Connect Telegram</div>
          <p style="margin:.3rem 0 0">
            Send this to the bot. It expires in 15 minutes and links that chat to your account.
          </p>
          <pre
            style="overflow-x:auto;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:.6rem;margin:.6rem 0 0"
          ><code>/link ${options.telegramLinkCode}</code></pre>`,
      )}
      ${when(
        options.telegramLinked,
        () => html`<hr style="border:0;border-top:1px solid var(--line);margin:1rem 0" />
          <div class="item-meta">Telegram is connected to this account.</div>
          <div class="row">
            <form method="post" action="/account/telegram/unlink">
              <button type="submit" class="secondary">Disconnect Telegram</button>
            </form>
          </div>`,
      )}
    </div>`;
}

const STATUS_LABEL: Record<ItemStatus, string> = {
  pending: 'queued',
  added: 'saved',
  duplicate: 'already saved',
  held_for_review: 'needs review',
  rejected: 'skipped',
  unresolvable: 'no video found',
  blocked: 'unavailable',
  deferred: 'waiting for quota',
  parked: 'waiting for reconnect',
  failed: 'failed',
};

function itemRow(item: Item, titles: Map<string, string>): Html {
  const title = item.resolvedVideoId ? titles.get(item.resolvedVideoId) : undefined;
  const shown = title ?? item.rawText.slice(0, 140) ?? '(empty share)';
  return html`<li>
    <span class="pill ${item.status}">${STATUS_LABEL[item.status]}</span>
    <div class="item-body">
      <div class="item-title">${shown}</div>
      <div class="item-meta">
        ${
          item.resolvedVideoId
            ? html`<a href="https://www.youtube.com/watch?v=${item.resolvedVideoId}"
              >${item.resolvedVideoId}</a
            >
            &middot; `
            : null
        }${item.source}${item.failureReason ? html` &middot; ${item.failureReason}` : null}
      </div>
    </div>
  </li>`;
}

export function homePage(options: {
  config: Config;
  email: string;
  playlistId: string | null;
  playlistName: string;
  items: Item[];
  titles: Map<string, string>;
  quota: QuotaSummary;
  counts: Record<string, number>;
  needsReauth: boolean;
  /** Prefilled from the PWA share target so the box is ready to submit. */
  prefill?: string;
  flash?: Html | null;
  /** MULTI's account panel. Absent in SOLO, which has no account concepts at all. */
  extras?: Html | null;
}): string {
  const { config, quota } = options;

  const banner = options.needsReauth
    ? reauthBanner(options.email)
    : config.google.publishingStatus === 'testing'
      ? testingModeBanner()
      : null;

  const body = html`
    <p class="sub">
      Saving to
      ${
        options.playlistId
          ? html`<a href="${playlistUrl(options.playlistId)}">${options.playlistName}</a>`
          : options.playlistName
      }
      as ${options.email}
    </p>

    ${options.flash ?? null}

    <div class="card">
      <form method="post" action="/share">
        <label for="text"><strong>Paste a link or a caption</strong></label>
        <textarea
          id="text"
          name="text"
          placeholder="https://youtu.be/... or a TikTok/Reel link, or paste the whole caption"
          autofocus
        >${options.prefill ?? ''}</textarea>
        <div class="row">
          <button type="submit">Save it</button>
          <span class="item-meta">Also the debugging tool: shows exactly what was extracted.</span>
        </div>
      </form>
    </div>

    <h2>Today's API budget</h2>
    <div class="card">
      <div class="meter"><span style="width:${quota.percentUsed}%"></span></div>
      <div class="item-meta">
        ${quota.spent} of ${quota.budget} units used (${quota.percentUsed}%) &middot; resets
        ${quota.nextReset.toISOString().replace('T', ' ').slice(0, 16)} UTC
      </div>
      <div class="grid" style="margin-top:.9rem">
        <div class="stat">
          <b>${quota.sharesLeft.withLink}</b><span>more links today</span>
        </div>
        <div class="stat">
          <b>${quota.sharesLeft.needingSearch}</b><span>if they need searching</span>
        </div>
        <div class="stat"><b>${options.counts.added ?? 0}</b><span>saved all time</span></div>
      </div>
    </div>

    <h2>Recent shares</h2>
    <div class="card">
      ${
        options.items.length === 0
          ? html`<p class="item-meta" style="margin:0">
            Nothing yet. Paste a link above, or set up the share sheet so you never have to
            open this page again.
          </p>`
          : html`<ul class="items">
            ${options.items.map((item) => itemRow(item, options.titles))}
          </ul>`
      }
    </div>

    ${options.extras ?? null}
  `;

  return layout({ title: 'Later', body, config, banner });
}

/** Shown right after a paste, and after the PWA share target fires. */
export function shareResultFlash(options: {
  added: number;
  duplicate: number;
  pending: number;
  failed: number;
  rejection: string | null;
  /**
   * True when idempotency matched and no new work was created.
   *
   * Without this the message would read "1 saved" for a share that was already handled,
   * because the underlying item genuinely is saved — accurate but misleading, since the user
   * just pressed the button and would reasonably read it as a fresh save.
   */
  alreadyAccepted?: boolean;
}): Html {
  if (options.rejection && options.added + options.duplicate + options.pending === 0) {
    return html`<div class="banner bad"><strong>Nothing saved</strong>${options.rejection}</div>`;
  }

  if (options.alreadyAccepted) {
    return html`<div class="banner ok">
      <strong>Already shared</strong>You have sent that one before, so there is nothing to do.
    </div>`;
  }

  const parts: string[] = [];
  if (options.added > 0) parts.push(`${options.added} saved`);
  if (options.duplicate > 0) parts.push(`${options.duplicate} already in the playlist`);
  if (options.pending > 0) parts.push(`${options.pending} queued`);
  if (options.failed > 0) parts.push(`${options.failed} could not be saved`);

  return html`<div class="banner ok">
    <strong>Got it</strong>${parts.join(' &middot; ') || 'Accepted.'}
  </div>`;
}

export function errorPage(config: Config, title: string, detail: string): string {
  return layout({
    title: `Later — ${title}`,
    config,
    body: html`<div class="card">
      <h2 style="margin-top:0">${title}</h2>
      <p>${detail}</p>
      <div class="row"><a href="/"><button class="secondary">Back</button></a></div>
    </div>`,
  });
}

/**
 * The review inbox.
 *
 * Everything here is a video Later resolved but was not confident enough to add. Each row
 * shows what was shared, what Later thinks it is, and how sure it was — so the decision is
 * informed rather than a blind yes/no.
 */
export function reviewPage(options: {
  config: Config;
  items: Item[];
  videos: Map<string, VideoCacheRow>;
}): string {
  const body = html`
    <p class="sub">
      Videos Later resolved but was not confident enough to add on its own. One tap each.
    </p>

    ${
      options.items.length === 0
        ? html`<div class="card">
            <p style="margin:0">
              Nothing waiting. Later only holds something back when it is unsure — most shares
              never land here.
            </p>
            <div class="row"><a href="/"><button class="secondary">Back</button></a></div>
          </div>`
        : html`${options.items.map((item) => reviewRow(item, options.videos))}`
    }
  `;
  return layout({ title: 'Later — review', body, config: options.config });
}

function reviewRow(item: Item, videos: Map<string, VideoCacheRow>): Html {
  const video = item.resolvedVideoId ? videos.get(item.resolvedVideoId) : undefined;
  const percent = Math.round((item.confidence ?? 0) * 100);

  return html`<div class="card">
    <div class="item-meta" style="margin-bottom:.4rem">You shared</div>
    <div style="margin-bottom:.9rem">${item.rawText.slice(0, 240)}</div>

    <div class="item-meta" style="margin-bottom:.4rem">Later thinks this is</div>
    <div class="item-title">
      ${
        item.resolvedVideoId
          ? html`<a href="https://www.youtube.com/watch?v=${item.resolvedVideoId}"
              >${video?.title || item.resolvedVideoId}</a
            >`
          : 'nothing it could identify'
      }
    </div>
    ${when(video?.channelTitle, () => html`<div class="item-meta">${video?.channelTitle}</div>`)}

    <div class="meter" style="margin-top:.7rem"><span style="width:${percent}%"></span></div>
    <div class="item-meta">${percent}% confident &middot; ${item.failureReason ?? ''}</div>

    <div class="row">
      <form method="post" action="/review/${item.id}/confirm">
        <button type="submit">Add it</button>
      </form>
      <form method="post" action="/review/${item.id}/reject">
        <button type="submit" class="secondary">Skip</button>
      </form>
    </div>
  </div>`;
}
