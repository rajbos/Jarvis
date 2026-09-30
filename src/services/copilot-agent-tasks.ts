// ── GitHub Copilot cloud agent tasks ──────────────────────────────────────────
// Lists the authenticated user's Copilot agent tasks (cloud agent sessions)
// via the agent tasks REST API. Needs a *user* token (OAuth app token or PAT;
// fine-grained PATs need the "Agent tasks" read permission) — GitHub App
// installation tokens are not supported by this endpoint.

import type { AgentActivity } from '../plugins/types';

const GITHUB_API = 'https://api.github.com';
const AGENT_TASKS_API_VERSION = '2026-03-10';

// Documented task states: queued, in_progress, completed, failed, idle,
// waiting_for_user, timed_out, cancelled.
const ACTIVE_STATES: ReadonlySet<string> = new Set(['queued', 'in_progress', 'idle', 'waiting_for_user']);

export interface CloudAgentTask {
  id: string;
  name: string | null;
  state: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** 0 / null when the task isn't bound to a repository. */
  repositoryId: number | null;
  /** GraphQL node ids of PRs the task produced. */
  pullRequestNodeIds: string[];
  headRef: string | null;
  baseRef: string | null;
}

export type ListCloudTasksResult =
  | { ok: true; tasks: CloudAgentTask[] }
  | { ok: false; status: number; error: string };

/** Billing units a cloud task session consumed (see the task detail API). */
export interface CloudTaskSessionUsage {
  kind: 'ai_credits' | 'premium_requests';
  amount: number;
}

/** One Copilot cloud session inside an agent task. */
export interface CloudTaskSession {
  model: string | null;
  usage: CloudTaskSessionUsage | null;
}

export type FetchTaskSessionsResult =
  | { ok: true; sessions: CloudTaskSession[] }
  | { ok: false; status: number; error: string };

interface RawTaskSession {
  model?: string | null;
  usage?: { type?: string; amount?: number; credits?: number } | null;
}

/**
 * Detect whether a task session came from the cloud agent or a CLI/remote
 * session: cloud-agent sessions have a non-empty `model` or a `usage` block.
 */
export function isCloudAgentSession(session: RawTaskSession): boolean {
  if (typeof session.model === 'string' && session.model !== '') return true;
  if (session.usage !== null && session.usage !== undefined) return true;
  return false;
}

/**
 * Read a session's billing units. `ai_credits` amounts are nano-credits
 * (divide by 1e9); the API has also been observed reporting the amount as
 * `usage.credits` (already in credits). `premium_requests` is a plain,
 * possibly fractional count for older sessions.
 */
function readSessionUsage(session: RawTaskSession): CloudTaskSessionUsage | null {
  const usage = session.usage;
  if (!usage) return null;
  if (typeof usage.credits === 'number' && Number.isFinite(usage.credits)) {
    return { kind: 'ai_credits', amount: usage.credits };
  }
  if (typeof usage.amount === 'number' && Number.isFinite(usage.amount)) {
    if (usage.type === 'ai_credits') return { kind: 'ai_credits', amount: usage.amount / 1_000_000_000 };
    return { kind: 'premium_requests', amount: usage.amount };
  }
  return null;
}

/**
 * Fetch one task's sessions via the task detail API. Failures are reported
 * but never block listing the task itself — callers decide whether to skip.
 */
export async function fetchCopilotTaskSessions(
  accessToken: string,
  taskId: string,
): Promise<FetchTaskSessionsResult> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}/agents/tasks/${encodeURIComponent(taskId)}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': AGENT_TASKS_API_VERSION,
      },
    });
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { ok: false, status: response.status, error: `Agent task detail API ${response.status}: ${text.slice(0, 200)}` };
  }

  const body = (await response.json()) as { sessions?: RawTaskSession[] };
  const sessions = (Array.isArray(body.sessions) ? body.sessions : [])
    .filter(isCloudAgentSession)
    .map((s) => ({
      model: typeof s.model === 'string' && s.model !== '' ? s.model : null,
      usage: readSessionUsage(s),
    }));
  return { ok: true, sessions };
}

interface RawTask {
  id?: string;
  name?: string | null;
  state?: string;
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
  repository?: { id?: number } | null;
  artifacts?: Array<{ type?: string; data?: Record<string, unknown> }>;
}

function toTask(raw: RawTask): CloudAgentTask | null {
  if (!raw.id) return null;
  const pullRequestNodeIds: string[] = [];
  let headRef: string | null = null;
  let baseRef: string | null = null;
  for (const artifact of raw.artifacts ?? []) {
    const data = artifact.data ?? {};
    if (artifact.type === 'pull' && typeof data.global_id === 'string') pullRequestNodeIds.push(data.global_id);
    if (artifact.type === 'branch') {
      if (typeof data.head_ref === 'string') headRef = data.head_ref;
      if (typeof data.base_ref === 'string') baseRef = data.base_ref;
    }
  }
  const repoId = raw.repository?.id;
  return {
    id: raw.id,
    name: raw.name ?? null,
    state: raw.state ?? 'unknown',
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
    repositoryId: typeof repoId === 'number' && repoId > 0 ? repoId : null,
    pullRequestNodeIds,
    headRef,
    baseRef,
  };
}

/**
 * List non-archived agent tasks (optionally only those updated since `since`),
 * following pages until a short page or `maxPages`. The API has no "active
 * only" filter we can rely on across states, so callers filter with
 * {@link isTaskRelevant}. The endpoint has its own small rate limit
 * (60/hour), so callers should avoid full listings on every refresh.
 */
export async function listCopilotAgentTasks(
  accessToken: string,
  options: { since?: string; perPage?: number; maxPages?: number } = {},
): Promise<ListCloudTasksResult> {
  const perPage = options.perPage ?? 100;
  const maxPages = options.maxPages ?? 10;
  const tasks: CloudAgentTask[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({ per_page: String(perPage), page: String(page), is_archived: 'false' });
    if (options.since) params.set('since', options.since);

    let response: Response;
    try {
      response = await fetch(`${GITHUB_API}/agents/tasks?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': AGENT_TASKS_API_VERSION,
        },
      });
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const hint = response.status === 401 || response.status === 403 || response.status === 404
        ? ' (token may lack access to Copilot agent tasks)'
        : '';
      return { ok: false, status: response.status, error: `Agent tasks API ${response.status}${hint}: ${text.slice(0, 200)}` };
    }

    const body = (await response.json()) as { tasks?: RawTask[] };
    const raw = body.tasks ?? [];
    for (const t of raw) {
      if (t.archived_at) continue;
      const task = toTask(t);
      if (task) tasks.push(task);
    }
    if (raw.length < perPage) break;
  }
  return { ok: true, tasks };
}

/**
 * Keep tasks that are still running, plus recently finished ones that produced
 * a PR — a just-completed agent run is exactly when the PR may be waiting on
 * checks / Copilot review before a human should look.
 */
export function isTaskRelevant(task: CloudAgentTask, now: number, finishedWindowMs = 24 * 60 * 60 * 1000): boolean {
  if (ACTIVE_STATES.has(task.state)) return true;
  if (task.pullRequestNodeIds.length === 0) return false;
  const updated = task.updatedAt ? Date.parse(task.updatedAt) : NaN;
  return Number.isFinite(updated) && now - updated <= finishedWindowMs;
}

export function cloudStateToActivity(state: string): AgentActivity {
  switch (state) {
    case 'queued': return 'queued';
    case 'in_progress': return 'working';
    case 'idle': return 'idle';
    case 'waiting_for_user': return 'waiting_for_user';
    case 'completed': return 'completed';
    case 'failed':
    case 'timed_out':
    case 'cancelled':
      return 'failed';
    default:
      return 'unknown';
  }
}

/** Resolve a numeric repository id to `owner/repo`. Returns null when inaccessible. */
export async function fetchRepoFullNameById(accessToken: string, repoId: number): Promise<string | null> {
  try {
    const response = await fetch(`${GITHUB_API}/repositories/${repoId}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { full_name?: string };
    return body.full_name ?? null;
  } catch {
    return null;
  }
}
