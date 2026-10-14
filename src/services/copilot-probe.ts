// ── Copilot usage endpoint probe ─────────────────────────────────────────────
//
// The flyout's debug view lets the user try the GitHub endpoints that report
// Copilot usage (user / organization / enterprise billing reports and the
// internal quota endpoint) to see why their totals differ. The renderer only
// ever names a path; the token stays in the main process, and only an
// allowlist of read-only billing paths is ever requested.

import type { CopilotRawResponse } from '../plugins/types';

const SEGMENT = '[A-Za-z0-9][A-Za-z0-9_.-]*';
const REPORT = '(?:ai_credit|premium_request)/usage|usage(?:/summary)?';
const PATH_RE = new RegExp(
  `^/(?:copilot_internal/user|(?:users|organizations|enterprises)/${SEGMENT}/settings/billing/(?:${REPORT}))$`,
);

const QUERY_KEYS = new Set(['year', 'month', 'day', 'user', 'model', 'product', 'organization']);
const QUERY_VALUE_RE = /^[\w .:+()/-]{1,100}$/;

export type ProbeSource = 'gh-cli' | 'oauth' | 'pat';

export const PROBE_SOURCES: readonly ProbeSource[] = ['gh-cli', 'oauth', 'pat'];

export function isProbeSource(value: unknown): value is ProbeSource {
  return typeof value === 'string' && (PROBE_SOURCES as readonly string[]).includes(value);
}

export type ProbeRequest = { ok: true; endpoint: string } | { ok: false; error: string };

/** Validate a user-supplied path (+ query) and normalise it; only allowlisted read-only paths pass. */
export function parseProbeRequest(input: unknown): ProbeRequest {
  if (typeof input !== 'string') return { ok: false, error: 'Endpoint must be a path such as /users/octocat/settings/billing/ai_credit/usage' };
  const trimmed = input.trim();
  const queryAt = trimmed.indexOf('?');
  const path = queryAt === -1 ? trimmed : trimmed.slice(0, queryAt);
  if (!PATH_RE.test(path)) {
    return {
      ok: false,
      error: 'Only /copilot_internal/user and /users|organizations|enterprises/{name}/settings/billing/(ai_credit|premium_request)/usage, /usage and /usage/summary can be tried',
    };
  }
  if (queryAt === -1) return { ok: true, endpoint: path };

  const query = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(trimmed.slice(queryAt + 1))) {
    if (!QUERY_KEYS.has(key)) return { ok: false, error: `Query parameter "${key}" is not supported (use ${[...QUERY_KEYS].join(', ')})` };
    if (!QUERY_VALUE_RE.test(value)) return { ok: false, error: `Invalid value for "${key}"` };
    query.append(key, value);
  }
  const qs = query.toString();
  return { ok: true, endpoint: qs ? `${path}?${qs}` : path };
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

/** GET one validated endpoint with `token` and return the raw answer; never throws. */
export async function probeEndpoint(
  token: string,
  endpoint: string,
  apiBase = 'https://api.github.com',
): Promise<CopilotRawResponse> {
  const internal = endpoint.startsWith('/copilot_internal/');
  try {
    const res = await fetch(`${apiBase}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: internal ? 'application/json' : 'application/vnd.github+json',
        ...(internal ? { 'User-Agent': 'Jarvis-Agent/0.1.0' } : { 'X-GitHub-Api-Version': '2026-03-10' }),
      },
    });
    const body = await res.text().catch(() => '');
    return { endpoint, status: res.status, body: parseBody(body) };
  } catch (err) {
    return { endpoint, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * One log line describing an answer: status plus the numbers that matter for
 * triage, never the raw body (the quota answer carries tracking ids).
 */
export function summarizeProbeResponse(raw: CopilotRawResponse): string {
  const body = raw.body as Record<string, unknown> | string | null;
  const head = `GET ${raw.endpoint} -> ${raw.status || 'no response'}`;
  if (typeof body === 'string') return `${head}: ${body.slice(0, 200)}`;
  if (!body || typeof body !== 'object') return head;

  if (Array.isArray(body.usageItems)) {
    const byModel = new Map<string, number>();
    let total = 0;
    for (const item of body.usageItems as Array<{ model?: unknown; sku?: unknown; grossQuantity?: unknown }>) {
      const gross = Number(item?.grossQuantity) || 0;
      total += gross;
      const key = String(item?.model ?? item?.sku ?? 'other');
      byModel.set(key, (byModel.get(key) ?? 0) + gross);
    }
    const top = [...byModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([model, credits]) => `${model}=${Math.round(credits * 100) / 100}`).join(', ');
    return `${head}: ${body.usageItems.length} items, gross ${Math.round(total * 100) / 100} AIC${top ? ` (top: ${top})` : ''}`;
  }

  const premium = (body.quota_snapshots as { premium_interactions?: Record<string, unknown> } | undefined)?.premium_interactions;
  if (premium) {
    const orgs = Array.isArray(body.organization_login_list) ? (body.organization_login_list as unknown[]).join(',') : '';
    return `${head}: plan=${String(body.copilot_plan)} credits_used=${String(premium.credits_used)} entitlement=${String(premium.entitlement)} remaining=${String(premium.remaining)}${orgs ? ` orgs=${orgs}` : ''}`;
  }

  return typeof body.message === 'string' ? `${head}: ${body.message.slice(0, 200)}` : head;
}
