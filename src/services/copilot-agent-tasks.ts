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
 * List non-archived agent tasks updated since `since`. The API has no
 * "active only" filter we can rely on across states, so callers filter with
 * {@link isTaskRelevant}.
 */
export async function listCopilotAgentTasks(
  accessToken: string,
  options: { since?: string; perPage?: number } = {},
): Promise<ListCloudTasksResult> {
  const params = new URLSearchParams({ per_page: String(options.perPage ?? 50), is_archived: 'false' });
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
  const tasks = (body.tasks ?? [])
    .filter((t) => !t.archived_at)
    .map(toTask)
    .filter((t): t is CloudAgentTask => t !== null);
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
