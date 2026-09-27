// ── Active agent sessions collector ───────────────────────────────────────────
// Merges every session source (local Copilot CLI/app, local Claude Code,
// Copilot cloud agent tasks), links each session to its pull request and
// evaluates that PR's readiness for human review.

import type {
  ActiveAgentSession,
  ActiveSessionEntry,
  ActiveSessionSourceStatus,
  ActiveSessionsSnapshot,
  AgentActivity,
  PrReadiness,
  ReadinessStage,
} from '../plugins/types';
import { resolveGitContext } from './git-context';
import {
  discoverClaudeLocalSessions,
  discoverCopilotLocalSessions,
  type LocalSessionDiscoveryOptions,
} from './local-agent-sessions';
import {
  cloudStateToActivity,
  fetchRepoFullNameById,
  isTaskRelevant,
  listCopilotAgentTasks,
  type CloudAgentTask,
} from './copilot-agent-tasks';
import { evaluatePrReadiness, fetchPullRequests, prLookupKey, type PrLookup, type PrLookupResult } from './pr-readiness';

export interface CollectActiveSessionsOptions extends LocalSessionDiscoveryOptions {
  /** GitHub user token; without it only local sessions are listed (no PR data). */
  accessToken: string | null;
  /** How long a finished cloud task with a PR stays listed. */
  cloudFinishedWindowMs?: number;
}

/** Branches that never carry an agent's PR — skip the lookup to save API calls. */
const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);

export function describeAgentActivity(activity: AgentActivity): ReadinessStage {
  switch (activity) {
    case 'working': return { light: 'amber', label: 'Working', detail: 'The agent is actively working.', blocking: false };
    case 'queued': return { light: 'amber', label: 'Queued', detail: 'The agent task is queued and has not started yet.', blocking: false };
    case 'waiting_for_user': return { light: 'amber', label: 'Needs input', detail: 'The agent is waiting for your input or approval.', blocking: false };
    case 'idle': return { light: 'green', label: 'Idle', detail: 'The agent finished its turn and is idle.', blocking: false };
    case 'completed': return { light: 'green', label: 'Done', detail: 'The agent task completed.', blocking: false };
    case 'failed': return { light: 'red', label: 'Failed', detail: 'The agent task failed, timed out or was cancelled.', blocking: false };
    default: return { light: 'grey', label: 'Unknown', detail: 'Could not determine what the agent is doing.', blocking: false };
  }
}

function verdictFor(pr: PrReadiness | null): Pick<ActiveSessionEntry, 'verdict' | 'verdictLabel'> {
  if (!pr) return { verdict: 'no_pr', verdictLabel: 'No PR yet' };
  if (pr.state !== 'OPEN') return { verdict: 'closed', verdictLabel: pr.state === 'MERGED' ? 'Merged' : 'Closed' };
  if (pr.ready) return { verdict: 'ready', verdictLabel: pr.isDraft ? 'Ready for review (draft)' : 'Ready for review' };
  const parts = pr.waitingOn.map((w) => (w === 'checks' ? 'checks' : 'Copilot review'));
  return { verdict: 'waiting', verdictLabel: `Waiting on ${parts.join(' + ')}` };
}

const VERDICT_ORDER: Record<ActiveSessionEntry['verdict'], number> = { ready: 0, waiting: 1, no_pr: 2, closed: 3 };

function sortEntries(entries: ActiveSessionEntry[]): ActiveSessionEntry[] {
  return entries.sort((a, b) => {
    const byVerdict = VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict];
    if (byVerdict !== 0) return byVerdict;
    return (Date.parse(b.session.updatedAt ?? '') || 0) - (Date.parse(a.session.updatedAt ?? '') || 0);
  });
}

function cloudTaskToSession(task: CloudAgentTask): ActiveAgentSession {
  return {
    key: `cloud:copilot:${task.id}`,
    provider: 'copilot',
    origin: 'cloud',
    client: 'Copilot cloud agent',
    sessionId: task.id,
    title: task.name,
    cwd: null,
    repoFullName: null,
    branch: task.headRef,
    activity: cloudStateToActivity(task.state),
    startedAt: task.createdAt,
    updatedAt: task.updatedAt,
    cloudTaskId: task.id,
    pid: null,
  };
}

interface PendingLink {
  session: ActiveAgentSession;
  /** Lookups to try in order; the first that finds a PR wins. */
  lookups: PrLookup[];
}

export async function collectActiveSessions(options: CollectActiveSessionsOptions): Promise<ActiveSessionsSnapshot> {
  const now = options.now?.() ?? Date.now();
  const token = options.accessToken;

  const sources: ActiveSessionsSnapshot['sources'] = {
    copilotLocal: { ok: true, count: 0 },
    claudeLocal: { ok: true, count: 0 },
    copilotCloud: { ok: true, count: 0 },
  };
  const fail = (err: unknown): ActiveSessionSourceStatus => ({ ok: false, count: 0, error: err instanceof Error ? err.message : String(err) });

  // ── Local sessions ──────────────────────────────────────────────────────────
  let mirroredTaskIds = new Set<string>();
  const localSessions: ActiveAgentSession[] = [];
  const [copilotResult, claudeResult] = await Promise.allSettled([
    (async () => discoverCopilotLocalSessions(options))(),
    (async () => discoverClaudeLocalSessions(options))(),
  ]);
  if (copilotResult.status === 'fulfilled') {
    mirroredTaskIds = copilotResult.value.mirroredTaskIds;
    localSessions.push(...copilotResult.value.sessions);
    sources.copilotLocal = { ok: true, count: copilotResult.value.sessions.length };
  } else {
    sources.copilotLocal = fail(copilotResult.reason);
  }
  if (claudeResult.status === 'fulfilled') {
    localSessions.push(...claudeResult.value);
    sources.claudeLocal = { ok: true, count: claudeResult.value.length };
  } else {
    sources.claudeLocal = fail(claudeResult.reason);
  }

  const links: PendingLink[] = [];
  for (const session of localSessions) {
    const git = session.cwd ? resolveGitContext(session.cwd) : null;
    session.repoFullName = git?.repoFullName ?? null;
    session.branch = git?.branch ?? null;
    const lookups: PrLookup[] = [];
    // Match on the local branch name: a worktree created from origin/main tracks
    // `main` as its upstream, and stacked branches track their parent branch.
    const branch = git?.branch ?? null;
    if (git && branch && !DEFAULT_BRANCHES.has(branch)) {
      const pushOwner = git.repoFullName?.split('/')[0];
      for (const repo of git.repoCandidates) {
        const isPushRepo = repo === git.repoFullName;
        lookups.push({ kind: 'branch', repoFullName: repo, branch, headOwner: isPushRepo ? undefined : pushOwner });
      }
    }
    links.push({ session, lookups });
  }

  // ── Cloud sessions ──────────────────────────────────────────────────────────
  if (!token) {
    sources.copilotCloud = { ok: true, count: 0, skipped: true, error: 'Not signed in to GitHub' };
  } else {
    const since = new Date(now - (options.cloudFinishedWindowMs ?? 24 * 60 * 60 * 1000)).toISOString();
    const listed = await listCopilotAgentTasks(token, { since });
    if (!listed.ok) {
      sources.copilotCloud = { ok: false, count: 0, error: listed.error };
    } else {
      const tasks = listed.tasks.filter(
        (t) => !mirroredTaskIds.has(t.id) && isTaskRelevant(t, now, options.cloudFinishedWindowMs),
      );
      sources.copilotCloud = { ok: true, count: tasks.length };
      const repoNames = new Map<number, string | null>();
      for (const task of tasks) {
        const session = cloudTaskToSession(task);
        const lookups: PrLookup[] = task.pullRequestNodeIds.map((nodeId) => ({ kind: 'node', nodeId }));
        if (task.repositoryId !== null) {
          if (!repoNames.has(task.repositoryId)) {
            repoNames.set(task.repositoryId, await fetchRepoFullNameById(token, task.repositoryId));
          }
          session.repoFullName = repoNames.get(task.repositoryId) ?? null;
          if (lookups.length === 0 && session.repoFullName && task.headRef) {
            lookups.push({ kind: 'branch', repoFullName: session.repoFullName, branch: task.headRef });
          }
        }
        links.push({ session, lookups });
      }
    }
  }

  // ── PR linking + readiness ──────────────────────────────────────────────────
  const results: Map<string, PrLookupResult> = token
    ? await fetchPullRequests(token, links.flatMap((l) => l.lookups))
    : new Map();
  const checkedAt = new Date(now).toISOString();

  const entries: ActiveSessionEntry[] = [];
  for (const { session, lookups } of links) {
    let pr: PrReadiness | null = null;
    let prError: string | null = null;
    for (const lookup of lookups) {
      const result = results.get(prLookupKey(lookup));
      if (!result) continue;
      if (!result.ok) {
        prError = result.error;
        continue;
      }
      if (result.pr) {
        pr = evaluatePrReadiness(result.pr, checkedAt);
        prError = null;
        break;
      }
    }
    if (pr) {
      session.repoFullName = pr.repoFullName;
      session.branch = session.branch ?? pr.headRef;
    }

    // A finished cloud task whose PR is already merged/closed isn't active any more.
    if (session.origin === 'cloud' && pr && pr.state !== 'OPEN' && (session.activity === 'completed' || session.activity === 'failed')) {
      continue;
    }

    entries.push({
      session,
      agent: describeAgentActivity(session.activity),
      pr,
      prError: token ? prError : null,
      ...(!token && lookups.length > 0
        ? { verdict: 'no_pr' as const, verdictLabel: 'Sign in to GitHub to check PR' }
        : verdictFor(pr)),
    });
  }

  sortEntries(entries);
  return {
    entries,
    sources,
    readyCount: entries.filter((e) => e.verdict === 'ready').length,
    refreshedAt: checkedAt,
  };
}
