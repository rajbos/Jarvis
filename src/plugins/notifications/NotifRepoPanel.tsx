import { useState, useEffect } from 'preact/hooks';
import { relativeAge, notifDescription, isDirect } from '../shared/utils';
import type { StoredNotification } from '../types';
import { AgentSelector } from '../agents/AgentSelector';

// Minimum notifications in a group to show the Analyse button
const ANALYSE_THRESHOLD = 1;

// ── Failure hint extraction ───────────────────────────────────────────────────

interface FailureHint {
  failingJob: string | null;
  errorHint: string | null;
}

/**
 * Extract the most useful single error line from a GitHub Actions log excerpt.
 * Strips the leading ISO timestamp that Actions prepends to every line.
 */
function extractErrorHint(logExcerpt: string | null): string | null {
  if (!logExcerpt) return null;
  const stripTs = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/;
  const errorRe = /##\[error\]|error:|failed to |exception:|fatal:/i;
  const lines = logExcerpt.split('\n');
  // Prefer a line that looks like an explicit error
  for (const raw of lines) {
    const line = raw.replace(stripTs, '').trim();
    if (line && errorRe.test(line)) return line.slice(0, 140);
  }
  // Fall back to the first non-empty line
  for (const raw of lines) {
    const line = raw.replace(stripTs, '').trim();
    if (line) return line.slice(0, 140);
  }
  return null;
}

// Subject types treated as workflow/CI notifications for grouping purposes
const WORKFLOW_TYPES = new Set(['CheckSuite', 'WorkflowRun']);

/**
 * Extract the base workflow name from a notification subject_title.
 * "Upgrade C# dependencies workflow run, Attempt #2 failed for main branch"
 * → "Upgrade C# dependencies"
 */
function normalizeWorkflowName(title: string): string {
  const m = title.match(/^(.+?)\s+workflow\s+run/i);
  return m ? m[1].trim() : title;
}

/**
 * Extract the branch name from a notification subject_title.
 * "… failed for main branch" → "main"
 */
function extractBranchFromTitle(title: string): string | null {
  const m = title.match(/\bfor\s+(\S+)\s+branch\b/i);
  return m ? m[1] : null;
}

const TYPE_ICON: Record<string, string> = {
  Issue: '\uD83D\uDC1B',
  PullRequest: '\uD83D\uDD00',
  Release: '\uD83C\uDF89',
  Commit: '\uD83D\uDCBE',
  Discussion: '\uD83D\uDCAC',
  CheckSuite: '\u274C',
};

// ── Workflow grouping ─────────────────────────────────────────────────────────

interface NotifGroup {
  /** Normalised workflow name for CI groups, null for the "other" catch-all */
  workflowName: string | null;
  /** Branch extracted from the notification title (e.g. "main") */
  branch: string | null;
  notifications: StoredNotification[];
}

/**
 * Group notifications by workflow name when there are 2 or more distinct
 * workflow names. Otherwise returns a single flat group (no grouping needed).
 */
function groupNotifications(notifications: StoredNotification[]): { groups: NotifGroup[]; isGrouped: boolean } {
  const workflowNotifs = notifications.filter((n) => WORKFLOW_TYPES.has(n.subject_type));
  const otherNotifs = notifications.filter((n) => !WORKFLOW_TYPES.has(n.subject_type));

  // Group by normalised workflow name so "Attempt #2" variants merge with their parent
  const byWorkflow = new Map<string, { notifs: StoredNotification[]; branch: string | null }>();
  for (const n of workflowNotifs) {
    const name = normalizeWorkflowName(n.subject_title);
    if (!byWorkflow.has(name)) byWorkflow.set(name, { notifs: [], branch: extractBranchFromTitle(n.subject_title) });
    byWorkflow.get(name)!.notifs.push(n);
  }

  // Show grouped view whenever there is at least one CI workflow notification
  const isGrouped = workflowNotifs.length >= 1 || otherNotifs.length > 0;

  if (!isGrouped) {
    return { groups: [{ workflowName: null, branch: null, notifications }], isGrouped: false };
  }

  const groups: NotifGroup[] = [];
  for (const [name, { notifs, branch }] of byWorkflow) {
    groups.push({ workflowName: name, branch, notifications: notifs });
  }
  if (otherNotifs.length > 0) {
    groups.push({ workflowName: null, branch: null, notifications: otherNotifs });
  }
  return { groups, isGrouped: true };
}

async function openNotifUrl(n: StoredNotification): Promise<void> {
  if (n.subject_type === 'CheckSuite') {
    if (n.subject_url) {
      const runUrl = await window.jarvis.getRunUrlForCheckSuite(n.subject_url);
      window.jarvis.openUrl(runUrl ?? `https://github.com/${n.repo_full_name}/actions`);
    } else {
      window.jarvis.openUrl(`https://github.com/${n.repo_full_name}/actions`);
    }
    return;
  }
  if (n.subject_type === 'WorkflowRun') {
    const url = n.subject_url
      ? n.subject_url.replace('https://api.github.com/repos/', 'https://github.com/')
      : `https://github.com/${n.repo_full_name}/actions`;
    window.jarvis.openUrl(url);
    return;
  }
  const url = n.subject_url
    ? n.subject_url
        .replace('https://api.github.com/repos/', 'https://github.com/')
        .replace(/\/pulls\/(\d+)$/, '/pull/$1')
        .replace(/\/issues\/(\d+)$/, '/issues/$1')
        .replace(/\/commits\/([a-f0-9]+)$/, '/commit/$1')
        .replace(/\/releases\/(\d+)$/, '/releases')
    : `https://github.com/${n.repo_full_name}`;
  window.jarvis.openUrl(url);
}

// ── Notification row ──────────────────────────────────────────────────────────

function NotifRow({ n, onContextMenu }: { n: StoredNotification; onContextMenu: (e: MouseEvent) => void }) {
  return (
    <div
      key={n.id}
      class="org-item"
      style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '0.25rem', cursor: 'pointer' }}
      onClick={() => openNotifUrl(n)}
      onContextMenu={onContextMenu}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', width: '100%' }}>
        <span style={{ flexShrink: 0 }}>{TYPE_ICON[n.subject_type] ?? '\u2022'}</span>
        <span class="org-label" style={{ flex: 1, fontWeight: 500, whiteSpace: 'normal', lineHeight: 1.35 }}>{n.subject_title}</span>
        <span class={isDirect(n.reason) ? 'notif-involvement-direct' : 'notif-involvement-following'}>
          {isDirect(n.reason) ? 'involved' : 'following'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap', paddingLeft: '1.4rem' }}>
        <span class="repo-card-badge">{notifDescription(n.subject_type, n.reason)}</span>
        <span class="repo-card-date">{relativeAge(n.updated_at)}</span>
      </div>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface NotifRepoPanelProps {
  repoFullName: string;
  notifications: StoredNotification[];
  onClose: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  onDismiss?: (id: string) => void;
  onAgentSessionStarted?: (sessionId: number) => void;
}

export function NotifRepoPanel({ repoFullName, notifications, onClose, onRefresh, refreshing, onDismiss, onAgentSessionStarted }: NotifRepoPanelProps) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; notifId: string } | null>(null);
  const [agentTarget, setAgentTarget] = useState<{ workflowFilter?: string } | null>(null);
  const [recoveryMap, setRecoveryMap] = useState<Map<string, boolean>>(new Map());
  const [failureHintMap, setFailureHintMap] = useState<Map<string, FailureHint>>(new Map());
  const [checkingRecovery, setCheckingRecovery] = useState(false);
  const [dismissingGroup, setDismissingGroup] = useState<string | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [ctxMenu]);

  // Check whether each CI workflow group has since recovered on the same branch.
  // Uses cached workflow run data; fetches from GitHub if the cache is empty.
  useEffect(() => {
    const { groups: g, isGrouped: ig } = groupNotifications(notifications);
    const ciGroups = g.filter((gr) => gr.workflowName !== null);
    if (!ig || ciGroups.length === 0) return;

    let cancelled = false;
    setCheckingRecovery(true);

    const check = async () => {
      try {
        let summary = await window.jarvis.githubGetWorkflowSummary(repoFullName);
        if (summary.total_runs === 0) {
          await window.jarvis.githubFetchWorkflowRuns(repoFullName);
          summary = await window.jarvis.githubGetWorkflowSummary(repoFullName);
        }
        if (cancelled) return;

        const newMap = new Map<string, boolean>();
        const newHints = new Map<string, FailureHint>();
        for (const group of ciGroups) {
          const latestNotifTime = Math.max(...group.notifications.map((n) => new Date(n.updated_at).getTime()));
          const recovered = summary.recent_runs.some(
            (r) =>
              r.workflow_name === group.workflowName &&
              (group.branch === null || r.head_branch === group.branch) &&
              r.conclusion === 'success' &&
              new Date(r.run_started_at).getTime() > latestNotifTime,
          );
          newMap.set(group.workflowName!, recovered);
          if (!recovered) {
            // Find most recent failed run for this workflow and extract a hint
            const failedRun = summary.recent_runs.find(
              (r) =>
                r.workflow_name === group.workflowName &&
                (group.branch === null || r.head_branch === group.branch) &&
                r.conclusion !== 'success',
            );
            if (failedRun) {
              const jobs = summary.jobs_by_run[failedRun.id] ?? [];
              const failedJob = jobs.find((j) => j.conclusion === 'failure' || j.conclusion === 'cancelled') ?? null;
              newHints.set(group.workflowName!, {
                failingJob: failedJob?.name ?? null,
                errorHint: extractErrorHint(failedJob?.log_excerpt ?? null),
              });
            }
          }
        }
        setRecoveryMap(newMap);
        setFailureHintMap(newHints);
      } catch {
        // recovery check is best-effort; silently ignore errors
      } finally {
        if (!cancelled) setCheckingRecovery(false);
      }
    };

    void check();
    return () => { cancelled = true; };
  }, [repoFullName]);

  const handleDismiss = async (id: string) => {
    setCtxMenu(null);
    await window.jarvis.dismissNotification(id);
    onDismiss?.(id);
  };

  const handleDismissGroup = async (workflowName: string, ids: string[]) => {
    setDismissingGroup(workflowName);
    for (const id of ids) {
      await window.jarvis.dismissNotification(id);
      onDismiss?.(id);
    }
    setDismissingGroup(null);
  };

  const { groups, isGrouped } = groupNotifications(notifications);

  return (
    <div class="repo-panel">
      <div class="repo-panel-header">
        <span class="repo-panel-title">{repoFullName.split('/')[1]}</span>
        <span style={{ flex: 1 }} />
        {/* Show global Analyse button only when not grouped (single workflow or no CI notifs) */}
        {!isGrouped && notifications.length >= ANALYSE_THRESHOLD && (
          <button
            class="notif-analyse-btn"
            title="Analyse with an LLM agent — detects workflow failures, checks CI logs, and suggests fixes or issues to file"
            onClick={() => setAgentTarget({})}
          >
            {'🤖 Analyse'}
          </button>
        )}
        {onRefresh && (
          <span
            class={`notif-refresh-btn${refreshing ? ' notif-refresh-btn-spinning' : ''}`}
            title={refreshing ? 'Refreshing\u2026' : 'Refresh notifications for this repo'}
            onClick={refreshing ? undefined : onRefresh}
          >{'\u21BB'}</span>
        )}
        <span class="notif-badge notif-badge-large">{'\uD83D\uDD14'} {notifications.length}</span>
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>

      {isGrouped ? (
        // ── Grouped view ────────────────────────────────────────────────────
        groups.map((group) => (
          <div key={group.workflowName ?? '__other__'} class="notif-workflow-group">
            <div class="notif-workflow-group-header">
              <span class="notif-workflow-group-icon">
                {group.workflowName ? '\u2699\uFE0F' : '\uD83D\uDCCB'}
              </span>
              <span class="notif-workflow-group-name">
                {group.workflowName ?? 'Other notifications'}
                {group.workflowName && group.branch && (
                  <span class="notif-workflow-group-branch">{group.branch}</span>
                )}
              </span>
              <span class="notif-workflow-group-count">{group.notifications.length}</span>
              {/* Recovery status — shown while checking or after check completes */}
              {group.workflowName && checkingRecovery && (
                <span class="notif-group-status notif-group-status--checking">checking…</span>
              )}
              {group.workflowName && !checkingRecovery && recoveryMap.get(group.workflowName) === false && (
                <>
                  <span class="notif-group-status notif-group-status--failing">✗ Still failing</span>
                  <button
                    class={`notif-dismiss-group-btn${dismissingGroup === group.workflowName ? ' notif-dismiss-group-btn--busy' : ''}`}
                    disabled={dismissingGroup === group.workflowName}
                    onClick={() => handleDismissGroup(group.workflowName!, group.notifications.map((n) => n.id))}
                  >
                    {dismissingGroup === group.workflowName ? <span class="dismiss-spinner" /> : 'Dismiss all'}
                  </button>
                </>
              )}
              {group.workflowName && !checkingRecovery && recoveryMap.get(group.workflowName) === true && (
                <>
                  <span class="notif-group-status notif-group-status--recovered">✓ Recovered</span>
                  <button
                    class={`notif-dismiss-group-btn${dismissingGroup === group.workflowName ? ' notif-dismiss-group-btn--busy' : ''}`}
                    disabled={dismissingGroup === group.workflowName}
                    onClick={() => handleDismissGroup(group.workflowName!, group.notifications.map((n) => n.id))}
                  >
                    {dismissingGroup === group.workflowName ? <span class="dismiss-spinner" /> : 'Dismiss all'}
                  </button>
                </>
              )}
              {group.workflowName && group.notifications.length >= ANALYSE_THRESHOLD && (
                <button
                  class="notif-analyse-btn notif-analyse-btn--inline"
                  title={`Analyse "${group.workflowName}" with an LLM agent`}
                  onClick={() => setAgentTarget({ workflowFilter: group.workflowName! })}
                >
                  {'🤖 Analyse'}
                </button>
              )}
            </div>
            {/* Failure hint: show failing job + first error line from cached logs */}
            {group.workflowName && !checkingRecovery && recoveryMap.get(group.workflowName) === false && (() => {
              const hint = failureHintMap.get(group.workflowName!);
              if (!hint) return null;
              return (
                <div class="notif-failure-hint">
                  {hint.failingJob && <span class="notif-failure-hint-job">Job: {hint.failingJob}</span>}
                  {hint.errorHint && <code class="notif-failure-hint-error">{hint.errorHint}</code>}
                </div>
              );
            })()}
            {group.notifications.map((n) => (
              <NotifRow
                key={n.id}
                n={n}
                onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, notifId: n.id }); }}
              />
            ))}
          </div>
        ))
      ) : (
        // ── Flat view (single workflow or no CI) ────────────────────────────
        notifications.map((n) => (
          <NotifRow
            key={n.id}
            n={n}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, notifId: n.id }); }}
          />
        ))
      )}

      {ctxMenu && (
        <div
          class="notif-ctx-menu"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button class="notif-ctx-menu-item" onClick={() => handleDismiss(ctxMenu.notifId)}>
            Dismiss
          </button>
        </div>
      )}

      {agentTarget !== null && (
        <AgentSelector
          repoFullName={repoFullName}
          workflowFilter={agentTarget.workflowFilter}
          onClose={() => setAgentTarget(null)}
          onSessionStarted={(sessionId) => {
            setAgentTarget(null);
            onAgentSessionStarted?.(sessionId);
          }}
        />
      )}
    </div>
  );
}
