// ── Claude (Claude Code OAuth) rate limit service ────────────────────────────
//
// Connects to the user's Claude subscription by reusing the OAuth credentials
// that Claude Code stores locally in ~/.claude/.credentials.json. Unlike a
// Console API key, these credentials reflect the actual Pro/Max subscription
// rate limits (unified 5-hour and 7-day windows).
//
// Rate-limit state is read from the `anthropic-ratelimit-unified-*` response
// headers on a minimal /v1/messages probe (max_tokens: 1). When the limit is
// exhausted the API responds with HTTP 429 and a `retry-after` header; the
// `*-reset` headers tell us when each window lifts.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ── Credentials ───────────────────────────────────────────────────────────────

export interface ClaudeCredentials {
  accessToken: string;
  refreshToken?: string;
  /** Expiry in milliseconds since epoch (as stored by Claude Code). */
  expiresAt?: number;
  subscriptionType?: string;
  scopes?: string[];
}

/** Path to the Claude Code credentials file (%USERPROFILE%\.claude\.credentials.json on Windows). */
export function getClaudeCredentialsPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return path.join(home, '.claude', '.credentials.json');
}

/**
 * Load Claude Code OAuth credentials from disk. Returns null when the file is
 * missing, unreadable, or does not contain a claudeAiOauth access token.
 */
export function loadClaudeCodeCredentials(filePath: string = getClaudeCredentialsPath()): ClaudeCredentials | null {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
        subscriptionType?: string;
        rateLimitTier?: string;
        scopes?: string[];
      };
    };
    const oauth = raw.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
      subscriptionType: oauth.subscriptionType ?? oauth.rateLimitTier,
      scopes: Array.isArray(oauth.scopes) ? oauth.scopes : undefined,
    };
  } catch (err) {
    console.warn('[Claude] Failed to read Claude Code credentials:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** True when the token expires within the next `skewMs` (default 60s). */
export function isTokenExpired(expiresAt: number | undefined, nowMs: number = Date.now(), skewMs = 60_000): boolean {
  if (typeof expiresAt !== 'number' || Number.isNaN(expiresAt)) return true;
  return expiresAt <= nowMs + skewMs;
}

/**
 * True when a token is worth trying. Tokens with a missing or zero expiry
 * (Claude Code sometimes writes expiresAt: 0) are considered usable — a 401
 * from the API is the authoritative signal, and callers retry with a refresh.
 */
export function isTokenPotentiallyUsable(expiresAt: number | undefined, nowMs: number = Date.now()): boolean {
  if (typeof expiresAt !== 'number' || Number.isNaN(expiresAt) || expiresAt === 0) return true;
  return !isTokenExpired(expiresAt, nowMs);
}

// ── Token refresh ─────────────────────────────────────────────────────────────

// Public OAuth client id used by Claude Code (not a secret).
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_ENDPOINTS = [
  'https://console.anthropic.com/v1/oauth/token',
  'https://api.anthropic.com/v1/oauth/token',
];

export interface RefreshedClaudeToken {
  accessToken: string;
  refreshToken: string;
  /** Expiry in milliseconds since epoch. */
  expiresAt: number;
}

/**
 * Exchange a refresh token for a new access token. Tries both known token
 * endpoints. Returns null when the refresh fails (caller should re-read the
 * credentials file or prompt re-auth via Claude Code).
 */
export async function refreshClaudeToken(refreshToken: string): Promise<RefreshedClaudeToken | null> {
  for (const endpoint of TOKEN_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'anthropic' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: CLAUDE_OAUTH_CLIENT_ID,
        }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!data.access_token) continue;
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? refreshToken,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      };
    } catch {
      // try the next endpoint
    }
  }
  return null;
}

// ── OAuth (PKCE) sign-in ──────────────────────────────────────────────────────
//
// Uses the same public OAuth client as Claude Code, so the resulting token
// carries the user's subscription rate limits. The flow is out-of-band: the
// browser lands on a page that displays the authorization code, and the user
// pastes it back into Jarvis.

const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference';

export interface PkcePair {
  verifier: string;
  challenge: string;
  state: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a PKCE verifier/challenge pair. In this flow `state` equals the verifier. */
export function generatePkce(): PkcePair {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
  // The Anthropic authorization server expects state to be the verifier value.
  return { verifier, challenge, state: verifier };
}

/** Build the authorize URL the user must visit in a browser. */
export function buildAuthorizeUrl(pkce: PkcePair): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Split a pasted authorization code into code + state. The callback page
 * displays them joined as `code#state`; a bare code is also accepted.
 */
export function parseAuthorizationCode(pasted: string): { code: string; state?: string } | null {
  const trimmed = pasted.trim();
  if (!trimmed) return null;
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx === -1) return { code: trimmed };
  const code = trimmed.slice(0, hashIdx);
  const state = trimmed.slice(hashIdx + 1);
  return code ? { code, state: state || undefined } : null;
}

/**
 * Exchange an authorization code for tokens. Returns null on failure.
 */
export async function exchangeCodeForToken(code: string, verifier: string, state?: string): Promise<RefreshedClaudeToken | null> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    code_verifier: verifier,
  };
  if (state) body.state = state;

  for (const endpoint of TOKEN_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'anthropic' },
        body: JSON.stringify(body),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!data.access_token) continue;
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? '',
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      };
    } catch {
      // try the next endpoint
    }
  }
  return null;
}

// ── Rate limit probing ────────────────────────────────────────────────────────

export interface ClaudeRateLimitWindow {
  /** Fraction of the window consumed, 0..1 (null when not reported). */
  utilization: number | null;
  /** Unix timestamp (seconds) when the window resets. */
  reset: number | null;
  /** True when this window is currently exhausted. */
  limited: boolean;
}

export interface ClaudeRateLimitProbe {
  /** HTTP status of the probe request. */
  status: number;
  /** True when the account is currently rate limited (any window). */
  limited: boolean;
  /** Unix timestamp (seconds) when the binding limit lifts; null when not limited. */
  resetAt: number | null;
  /** `retry-after` value in seconds when the probe was rejected with 429. */
  retryAfterSec: number | null;
  fiveHour: ClaudeRateLimitWindow | null;
  sevenDay: ClaudeRateLimitWindow | null;
  error?: string;
}

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
// Cheapest models for the 1-token probe; tried in order on model-not-found.
const PROBE_MODELS = ['claude-haiku-4-5', 'claude-3-5-haiku-latest'];

/** Parse a header that may be unix seconds or an ISO-8601 timestamp → unix seconds. */
function parseResetHeader(value: string | null): number | null {
  if (value === null) return null;
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && asNumber > 0) return asNumber;
  const asDate = Date.parse(value);
  return Number.isNaN(asDate) ? null : Math.floor(asDate / 1000);
}

function parseWindow(get: (name: string) => string | null, prefix: string): ClaudeRateLimitWindow | null {
  const utilizationRaw = get(`${prefix}-utilization`);
  const resetRaw = get(`${prefix}-reset`);
  const status = (get(`${prefix}-status`) ?? '').toLowerCase();
  const remainingRaw = get(`${prefix}-remaining`);
  if (utilizationRaw === null && resetRaw === null && status === '' && remainingRaw === null) return null;

  const utilization = utilizationRaw !== null && !Number.isNaN(Number(utilizationRaw)) ? Number(utilizationRaw) : null;
  const reset = parseResetHeader(resetRaw);
  const remaining = remainingRaw !== null && !Number.isNaN(Number(remainingRaw)) ? Number(remainingRaw) : null;

  const limited =
    status.includes('limit') ||
    status.includes('reject') ||
    remaining === 0 ||
    (utilization !== null && utilization >= 1);

  return { utilization, reset, limited };
}

/**
 * Pure header-parsing helper (exported for tests). `get` should behave like
 * `Headers.get`: return the header value or null when absent.
 */
export function parseRateLimitHeaders(status: number, get: (name: string) => string | null): ClaudeRateLimitProbe {
  const fiveHour = parseWindow(get, 'anthropic-ratelimit-unified-5h');
  const sevenDay = parseWindow(get, 'anthropic-ratelimit-unified-7d');

  const retryAfterRaw = get('retry-after');
  const retryAfterSec = retryAfterRaw !== null && !Number.isNaN(Number(retryAfterRaw)) ? Number(retryAfterRaw) : null;

  const overallStatus = (get('anthropic-ratelimit-unified-status') ?? '').toLowerCase();
  const overallReset = parseResetHeader(get('anthropic-ratelimit-unified-reset'));

  const rejected = status === 429 || overallStatus.includes('limit') || overallStatus.includes('reject');
  const limited = rejected || (fiveHour?.limited ?? false) || (sevenDay?.limited ?? false);

  // The binding constraint is the exhausted window that lifts last — both
  // windows must have capacity again before the account is usable.
  let resetAt: number | null = null;
  if (limited) {
    const candidates = [fiveHour, sevenDay]
      .filter((w): w is ClaudeRateLimitWindow => w !== null && w.limited && w.reset !== null)
      .map((w) => w.reset as number);
    if (candidates.length > 0) {
      resetAt = Math.max(...candidates);
    } else if (overallReset !== null) {
      resetAt = overallReset;
    } else if (retryAfterSec !== null) {
      resetAt = Math.floor(Date.now() / 1000) + retryAfterSec;
    }
  }

  return { status, limited, resetAt, retryAfterSec, fiveHour, sevenDay };
}

/**
 * Probe the Anthropic API with a 1-token request and read the unified
 * rate-limit headers. Rejected (429) probes do not consume quota.
 */
export async function checkClaudeRateLimit(accessToken: string): Promise<ClaudeRateLimitProbe> {
  let lastError: string | undefined;

  for (const model of PROBE_MODELS) {
    try {
      const res = await fetch(MESSAGES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
          'x-app': 'cli',
          'user-agent': 'claude-cli/2.0.0 (external, cli)',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          // Claude Code OAuth credentials require the Claude Code system prompt.
          system: "You are Claude Code, Anthropic's official CLI for Claude.",
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });

      const probe = parseRateLimitHeaders(res.status, (name) => res.headers.get(name));

      if (!res.ok && res.status !== 429) {
        const body = await res.text().catch(() => '');
        lastError = `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
        // Model not found → try the next probe model; otherwise give up.
        if (res.status === 404 && model !== PROBE_MODELS[PROBE_MODELS.length - 1]) continue;
        probe.error = lastError;
      }

      return probe;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    status: 0,
    limited: false,
    resetAt: null,
    retryAfterSec: null,
    fiveHour: null,
    sevenDay: null,
    error: lastError ?? 'Probe failed',
  };
}
