/**
 * Google OAuth 2.0.
 *
 * The scope requested is exactly one:
 *
 *     https://www.googleapis.com/auth/youtube
 *
 * That is the narrowest scope that can write to a playlist. Google classifies it as
 * *sensitive*, which is what causes the 7-day refresh-token expiry for apps left in Testing
 * publishing status — the single most likely reason a stranger's deployment dies quietly.
 * See docs/adr/0005-token-lifecycle-and-reauth.md.
 *
 * Note what this module does NOT do: Gemini cannot grant, proxy, or substitute for any of
 * this. Playlist writes require an OAuth token, full stop. See ADR-0009.
 */

import { bytesToBase64Url, randomBytes, randomToken } from '../core/bytes.ts';
import { classifyGoogleError, YouTubeError } from '../core/errors.ts';

export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';
export const USERINFO_SCOPE = 'openid email profile';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenSet {
  accessToken: string;
  /** Absent when Google chooses not to reissue one — do not overwrite the stored value. */
  refreshToken: string | undefined;
  expiresAt: number;
  scope: string | undefined;
}

export interface GoogleIdentity {
  googleUserId: string;
  email: string;
  name: string | undefined;
}

/** PKCE verifier and its S256 challenge. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = bytesToBase64Url(randomBytes(48));
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier) as unknown as ArrayBuffer,
  );
  return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) };
}

export function createState(): string {
  return randomToken(24);
}

export function buildAuthorizeUrl(
  config: OAuthClientConfig,
  options: { state: string; codeChallenge: string; loginHint?: string },
): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', `${YOUTUBE_SCOPE} ${USERINFO_SCOPE}`);
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  // `offline` is what produces a refresh token at all. Without it Later would work for one
  // hour and then stop, which is a far more confusing failure than no authorisation.
  url.searchParams.set('access_type', 'offline');
  // Forces the consent screen even on repeat authorisation, so a re-auth after
  // `invalid_grant` reliably yields a *new* refresh token rather than none.
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');

  if (options.loginHint) url.searchParams.set('login_hint', options.loginHint);
  return url.toString();
}

async function postToken(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<TokenSet> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (cause) {
    throw new YouTubeError('transient', 'Could not reach the Google token endpoint.', { cause });
  }

  const payload = await safeJson(response);

  if (!response.ok) {
    // classifyGoogleError maps `{"error":"invalid_grant"}` onto its own terminal kind, which
    // is the whole point: it must never be retried and must trigger a re-auth notification.
    throw classifyGoogleError(response.status, payload);
  }

  const data = payload as Record<string, unknown>;
  const accessToken = typeof data.access_token === 'string' ? data.access_token : undefined;
  if (!accessToken) {
    throw new YouTubeError('client_error', 'Google token response contained no access_token.');
  }

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    // 60s of slack so a token is never used in the last moment of its life.
    expiresAt: now() + (expiresIn - 60) * 1000,
    scope: typeof data.scope === 'string' ? data.scope : undefined,
  };
}

export async function exchangeCode(
  config: OAuthClientConfig,
  input: { code: string; codeVerifier: string },
  deps: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.codeVerifier,
  });
  return await postToken(body, deps.fetch ?? fetch, deps.now ?? Date.now);
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * Throws a `YouTubeError` of kind `invalid_grant` when the refresh token is dead. Callers
 * must treat that as terminal — park the work, notify the user, do not retry. Retrying is
 * how a deployment goes silent for a week.
 */
export async function refreshAccessToken(
  config: Pick<OAuthClientConfig, 'clientId' | 'clientSecret'>,
  refreshToken: string,
  deps: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return await postToken(body, deps.fetch ?? fetch, deps.now ?? Date.now);
}

export async function fetchIdentity(
  accessToken: string,
  deps: { fetch?: typeof fetch } = {},
): Promise<GoogleIdentity> {
  const fetchImpl = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch (cause) {
    throw new YouTubeError('transient', 'Could not reach the Google userinfo endpoint.', { cause });
  }

  const payload = await safeJson(response);
  if (!response.ok) throw classifyGoogleError(response.status, payload);

  const data = payload as Record<string, unknown>;
  const sub = typeof data.sub === 'string' ? data.sub : undefined;
  const email = typeof data.email === 'string' ? data.email : undefined;
  if (!sub || !email) {
    throw new YouTubeError('client_error', 'Google userinfo response was missing sub or email.');
  }
  return {
    googleUserId: sub,
    email: email.toLowerCase(),
    name: typeof data.name === 'string' ? data.name : undefined,
  };
}

/**
 * Revoke a token, best effort.
 *
 * Used when a SOLO deployer disconnects. Failure is not propagated: the local state is the
 * thing that matters, and the user can always revoke at myaccount.google.com/permissions.
 */
export async function revokeToken(
  token: string,
  deps: { fetch?: typeof fetch } = {},
): Promise<boolean> {
  try {
    const response = await (deps.fetch ?? fetch)('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}
