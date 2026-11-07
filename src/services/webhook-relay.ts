// ── GitHub webhook relay client ───────────────────────────────────────────────
// Push-based alternative to polling GitHub for PR / check changes. A GitHub
// App or OAuth app the user configures sends webhooks to an Azure Function
// they host; the function keeps a short log of the events it accepted and
// Jarvis polls *that* log (cheap, outside GitHub's rate limits) to learn which
// PRs changed. See docs/WEBHOOK-RELAY.md for the function's contract.
//
// This module is the Jarvis side: fetch new events from the relay, reduce raw
// webhook payloads to the few facts the agent-session sweep cares about, and
// remember which PRs changed since the last sweep.

import { logger } from './logger';

export interface WebhookRelayConfig {
  /** Base URL of the relay (the Azure Function app), e.g. https://jarvis-relay.azurewebsites.net/api */
  url: string;
  /** Bearer token the relay expects from Jarvis. */
  token: string;
}

/** What the relay stores per accepted webhook delivery. */
export interface RelayEnvelope {
  /** Monotonic id assigned by the relay; Jarvis resumes from the last one it saw. */
  id: string;
  /** GitHub delivery id (X-GitHub-Delivery header). */
  deliveryId?: string;
  /** Webhook event name (X-GitHub-Event header): pull_request, check_run, … */
  event: string;
  receivedAt: string;
  /** The webhook payload as GitHub sent it (the relay may trim it to the fields below). */
  payload: Record<string, unknown>;
}

/** The facts Jarvis keeps from a webhook, independent of the event type. */
export interface PrChangeEvent {
  id: string;
  receivedAt: string;
  event: string;
  action: string | null;
  repoFullName: string;
  /** PR number(s) the event is about; empty when it could not be tied to a PR. */
  prNumbers: number[];
  headSha: string | null;
  /** Why the sweep should look again. */
  summary: string;
}

export type RelayFetchResult =
  | { ok: true; events: RelayEnvelope[]; cursor: string | null }
  | { ok: false; status: number; error: string };

/** Webhook events worth subscribing to; everything else is ignored by {@link summarizeWebhookEvent}. */
export const RELAY_EVENTS_OF_INTEREST = ['pull_request', 'pull_request_review', 'check_run', 'check_suite', 'workflow_run', 'status', 'issue_comment'] as const;

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function prNumbersOf(list: unknown): number[] {
  if (!Array.isArray(list)) return [];
  return list.map((p) => num((p as { number?: unknown })?.number)).filter((n): n is number => n !== null);
}

/**
 * Reduce a raw webhook to the PR(s) it touches. Returns null for events that
 * cannot affect a PR's readiness (pushes to main, stars, …). Pure; exported
 * for tests.
 */
export function summarizeWebhookEvent(envelope: RelayEnvelope): PrChangeEvent | null {
  const { event, payload } = envelope;
  const repoFullName = str((payload.repository as { full_name?: unknown } | undefined)?.full_name);
  if (!repoFullName) return null;
  const action = str(payload.action);
  const base = { id: envelope.id, receivedAt: envelope.receivedAt, event, action, repoFullName };

  switch (event) {
    case 'pull_request':
    case 'pull_request_review': {
      const pr = payload.pull_request as { number?: unknown; head?: { sha?: unknown } } | undefined;
      const number = num(pr?.number);
      if (number === null) return null;
      return { ...base, prNumbers: [number], headSha: str(pr?.head?.sha), summary: `${event} ${action ?? ''}`.trim() };
    }
    case 'issue_comment': {
      const issue = payload.issue as { number?: unknown; pull_request?: unknown } | undefined;
      const number = num(issue?.number);
      if (number === null || !issue?.pull_request) return null;
      return { ...base, prNumbers: [number], headSha: null, summary: `comment ${action ?? ''}`.trim() };
    }
    case 'check_run':
    case 'check_suite': {
      const obj = payload[event] as { head_sha?: unknown; pull_requests?: unknown; name?: unknown; conclusion?: unknown; status?: unknown } | undefined;
      const prNumbers = prNumbersOf(obj?.pull_requests);
      const headSha = str(obj?.head_sha);
      if (prNumbers.length === 0 && !headSha) return null;
      const name = str(obj?.name);
      const state = str(obj?.conclusion) ?? str(obj?.status);
      return { ...base, prNumbers, headSha, summary: `${event}${name ? ` ${name}` : ''}${state ? ` ${state}` : ''}` };
    }
    case 'workflow_run': {
      const run = payload.workflow_run as { head_sha?: unknown; pull_requests?: unknown; name?: unknown; conclusion?: unknown; status?: unknown } | undefined;
      const prNumbers = prNumbersOf(run?.pull_requests);
      const headSha = str(run?.head_sha);
      if (prNumbers.length === 0 && !headSha) return null;
      const state = str(run?.conclusion) ?? str(run?.status);
      return { ...base, prNumbers, headSha, summary: `workflow ${str(run?.name) ?? ''} ${state ?? ''}`.replace(/\s+/g, ' ').trim() };
    }
    case 'status': {
      const headSha = str(payload.sha);
      if (!headSha) return null;
      return { ...base, prNumbers: [], headSha, summary: `status ${str(payload.context) ?? ''} ${str(payload.state) ?? ''}`.replace(/\s+/g, ' ').trim() };
    }
    default:
      return null;
  }
}

/**
 * Fetch events the relay accepted after `cursor` (its `id`), oldest first.
 * The relay answers `{ events: RelayEnvelope[], cursor: string | null }`.
 */
export async function fetchRelayEvents(config: WebhookRelayConfig, cursor: string | null, fetchImpl: typeof fetch = fetch): Promise<RelayFetchResult> {
  const url = new URL('events', config.url.endsWith('/') ? config.url : `${config.url}/`);
  if (cursor) url.searchParams.set('after', cursor);
  url.searchParams.set('limit', '200');
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    });
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { ok: false, status: response.status, error: `Relay ${response.status}: ${text.slice(0, 200)}` };
  }
  const body = (await response.json()) as { events?: unknown; cursor?: unknown };
  const events = (Array.isArray(body.events) ? body.events : []).filter(
    (e): e is RelayEnvelope => !!e && typeof e === 'object' && typeof (e as RelayEnvelope).id === 'string' && typeof (e as RelayEnvelope).event === 'string',
  );
  const last = events[events.length - 1]?.id ?? null;
  return { ok: true, events, cursor: str(body.cursor) ?? last ?? cursor };
}

// ── Changed-PR tracking ───────────────────────────────────────────────────────
// The sweep in active-sessions.ts can consult this to re-query only the PRs
// that changed (and to run right away when one did), instead of every PR
// every two minutes.

const changed = new Map<string, PrChangeEvent>();
let cursor: string | null = null;

export function prChangeKey(repoFullName: string, prNumber: number): string {
  return `${repoFullName.toLowerCase()}#${prNumber}`;
}

/** Record that a PR (or a head sha, when the webhook had no PR) changed. */
export function markPrChanged(change: PrChangeEvent): void {
  if (change.prNumbers.length === 0) {
    changed.set(`${change.repoFullName.toLowerCase()}@${change.headSha}`, change);
    return;
  }
  for (const n of change.prNumbers) changed.set(prChangeKey(change.repoFullName, n), change);
}

/** PRs that changed since the last {@link takeChangedPrs}; keyed by {@link prChangeKey} or `repo@sha`. */
export function takeChangedPrs(): Map<string, PrChangeEvent> {
  const out = new Map(changed);
  changed.clear();
  return out;
}

export function peekChangedPrCount(): number {
  return changed.size;
}

export function getRelayCursor(): string | null {
  return cursor;
}

/** Exposed for tests. */
export function resetWebhookRelayState(): void {
  changed.clear();
  cursor = null;
}

export interface RelayPollResult {
  fetched: number;
  relevant: number;
  cursor: string | null;
  error?: string;
}

/**
 * One poll: pull new events from the relay, reduce them and mark the PRs
 * they touch as changed. Returns what happened for the task log.
 */
export async function pollWebhookRelay(config: WebhookRelayConfig, fetchImpl: typeof fetch = fetch): Promise<RelayPollResult> {
  const result = await fetchRelayEvents(config, cursor, fetchImpl);
  if (!result.ok) {
    logger.warn(`[WebhookRelay] Poll failed: ${result.error}`);
    return { fetched: 0, relevant: 0, cursor, error: result.error };
  }
  let relevant = 0;
  for (const envelope of result.events) {
    const change = summarizeWebhookEvent(envelope);
    if (!change) continue;
    relevant++;
    markPrChanged(change);
    logger.debug(`[WebhookRelay] ${change.repoFullName}${change.prNumbers.map((n) => `#${n}`).join(',')} ${change.summary}`);
  }
  cursor = result.cursor;
  if (result.events.length > 0) logger.info(`[WebhookRelay] ${result.events.length} event(s), ${relevant} about PRs; cursor ${cursor}`);
  return { fetched: result.events.length, relevant, cursor };
}
