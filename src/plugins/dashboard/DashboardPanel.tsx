import { useState, useEffect, useCallback } from 'preact/hooks';
import type {
  DashboardSummary,
  RepoHealthStatus,
  HealthWarning,
  StoredNotification,
} from '../types';

// ── Sub-components ────────────────────────────────────────────────────────────

function WarningIcon({ kind }: { kind: HealthWarning['kind'] }) {
  switch (kind) {
    case 'branch-no-upstream': return <span title="Unpushed branch">🔀</span>;
    case 'no-remote': return <span title="No remote">🚫</span>;
    case 'has-notifications': return <span title="Notifications">🔔</span>;
    case 'failed-workflows': return <span title="Failed runs">❌</span>;
    default: return <span>⚠️</span>;
  }
}

function subjectTypeIcon(subjectType: string): string {
  switch (subjectType) {
    case 'PullRequest': return '🔃';
    case 'Issue': return '🐛';
    case 'Release': return '🏷️';
    case 'Commit': return '📝';
    case 'Discussion': return '💬';
    case 'CheckSuite': return '⚙️';
    default: return '📌';
  }
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'assign': return 'Assigned';
    case 'author': return 'Author';
    case 'comment': return 'Comment';
    case 'ci_activity': return 'CI';
    case 'invitation': return 'Invited';
    case 'manual': return 'Subscribed';
    case 'mention': return 'Mentioned';
    case 'review_requested': return 'Review requested';
    case 'security_alert': return 'Security';
    case 'state_change': return 'State change';
    case 'subscribed': return 'Watching';
    case 'team_mention': return 'Team mention';
    default: return reason;
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Lazily loads and displays notifications for a single repo. */
function NotificationList({ repoFullName }: { repoFullName: string }) {
  const [notifications, setNotifications] = useState<StoredNotification[] | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.jarvis.listNotificationsForRepo(repoFullName);
      setNotifications(list);
    } catch (err) {
      console.error('[Dashboard] Failed to load notifications:', err);
      setNotifications([]);
    } finally {
      setLoading(false);
    }
  }, [repoFullName]);

  useEffect(() => { void load(); }, [load]);

  const handleDismiss = async (id: string) => {
    try {
      await window.jarvis.dismissNotification(id);
      setNotifications((prev) => prev?.filter((n) => n.id !== id) ?? null);
    } catch (err) {
      console.error('[Dashboard] Failed to dismiss notification:', err);
    }
  };

  const handleOpenOnGitHub = (n: StoredNotification) => {
    // subject_url is an API URL; build the web URL from repo + subject
    const webUrl = `https://github.com/${n.repo_full_name}`;
    window.jarvis.openUrl(webUrl);
  };

  if (loading) {
    return <div class="dash-notif-loading">Loading notifications…</div>;
  }

  if (!notifications || notifications.length === 0) {
    return <div class="dash-notif-empty">No notifications</div>;
  }

  return (
    <div class="dash-notif-list">
      <div class="dash-notif-header">🔔 Notifications ({notifications.length})</div>
      {notifications.map((n) => (
        <div key={n.id} class="dash-notif-item">
          <span class="dash-notif-icon" title={n.subject_type}>{subjectTypeIcon(n.subject_type)}</span>
          <div class="dash-notif-body">
            <span class="dash-notif-title">{n.subject_title}</span>
            <span class="dash-notif-meta">
              <span class={`dash-notif-reason dash-reason-${n.reason}`}>{reasonLabel(n.reason)}</span>
              <span class="dash-notif-time">{timeAgo(n.updated_at)}</span>
            </span>
          </div>
          <div class="dash-notif-actions">
            <button
              class="dash-action-btn dash-notif-btn"
              onClick={(e) => { e.stopPropagation(); handleOpenOnGitHub(n); }}
              title="Open on GitHub"
            >🌐</button>
            <button
              class="dash-action-btn dash-notif-btn"
              onClick={(e) => { e.stopPropagation(); void handleDismiss(n.id); }}
              title="Dismiss notification"
            >✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The active card filter drives what appears below the cards. */
type CardFilter = 'all' | 'healthy' | 'warnings' | 'notifications' | 'failed-runs';

function SummaryCards({
  summary,
  healthyCount,
  active,
  onSelect,
}: {
  summary: DashboardSummary;
  healthyCount: number;
  active: CardFilter;
  onSelect: (f: CardFilter) => void;
}) {
  const toggle = (f: CardFilter) => onSelect(active === f ? 'all' : f);

  return (
    <div class="dashboard-summary-cards">
      <div
        class={`dash-card dash-card-clickable ${active === 'all' ? 'dash-card-selected' : ''}`}
        onClick={() => onSelect('all')}
      >
        <div class="dash-card-value">{summary.totalRepos}</div>
        <div class="dash-card-label">Local Repos</div>
      </div>
      <div
        class={`dash-card dash-card-clickable ${healthyCount > 0 ? 'dash-card-ok' : ''} ${active === 'healthy' ? 'dash-card-selected' : ''}`}
        onClick={() => toggle('healthy')}
      >
        <div class="dash-card-value">{healthyCount}</div>
        <div class="dash-card-label">All Good</div>
      </div>
      <div
        class={`dash-card dash-card-clickable ${summary.reposWithWarnings > 0 ? 'dash-card-warn' : ''} ${active === 'warnings' ? 'dash-card-selected' : ''}`}
        onClick={() => toggle('warnings')}
      >
        <div class="dash-card-value">{summary.reposWithWarnings}</div>
        <div class="dash-card-label">Need Attention</div>
      </div>
      <div
        class={`dash-card dash-card-clickable ${summary.totalNotifications > 0 ? 'dash-card-info' : ''} ${active === 'notifications' ? 'dash-card-selected' : ''}`}
        onClick={() => toggle('notifications')}
      >
        <div class="dash-card-value">{summary.totalNotifications}</div>
        <div class="dash-card-label">Notifications</div>
      </div>
      <div
        class={`dash-card dash-card-clickable ${summary.totalFailedRuns > 0 ? 'dash-card-danger' : ''} ${active === 'failed-runs' ? 'dash-card-selected' : ''}`}
        onClick={() => toggle('failed-runs')}
      >
        <div class="dash-card-value">{summary.totalFailedRuns}</div>
        <div class="dash-card-label">Failed Runs</div>
      </div>
    </div>
  );
}

function RepoHealthRow({
  status,
  warnings,
  expanded,
  pushState,
  onToggle,
  onOpenFolder,
  onOpenGitHub,
  onPushBranch,
}: {
  status: RepoHealthStatus;
  warnings: HealthWarning[];
  expanded: boolean;
  pushState?: 'idle' | 'pushing' | 'done' | 'error';
  onToggle: () => void;
  onOpenFolder: (localPath: string) => void;
  onOpenGitHub: (repoFullName: string) => void;
  onPushBranch: (localPath: string, branch: string) => void;
}) {
  return (
    <div class={`dash-repo-row ${warnings.length > 0 ? 'dash-repo-warn' : ''} ${expanded ? 'dash-repo-expanded' : ''}`}>
      <div class="dash-repo-summary" onClick={onToggle} title="Click to expand">
        <div class="dash-repo-main">
          <span class="dash-repo-chevron">{expanded ? '▾' : '▸'}</span>
          <span class="dash-repo-name">{status.repoName}</span>
          {status.currentBranch && (
            <span class="dash-repo-branch" title={status.upstreamRef ? `→ ${status.upstreamRef}` : 'no upstream'}>
              🌿 {status.currentBranch}
              {status.hasUpstream && <span class="dash-upstream-ok" title={`Tracking ${status.upstreamRef}`}> ✓</span>}
            </span>
          )}
          {status.linkedGithubRepo && (
            <span class="dash-repo-link" title={status.linkedGithubRepo}>
              🔗 {status.linkedGithubRepo}
            </span>
          )}
        </div>
        <div class="dash-repo-warnings">
          {warnings.map((w, i) => (
            <span key={i} class={`dash-warning-pill dash-warning-${w.kind}`} title={w.message}>
              {w.kind === 'has-notifications' && status.notificationCount > 0 && (
                <span class="dash-pill-count">{status.notificationCount}</span>
              )}
              <WarningIcon kind={w.kind} />
            </span>
          ))}
          {warnings.length === 0 && (
            <span class="dash-ok-pill">✅</span>
          )}
        </div>
      </div>

      {expanded && (
        <div class="dash-repo-detail">
          {/* Info rows */}
          <div class="dash-detail-grid">
            <div class="dash-detail-row">
              <span class="dash-detail-label">Path</span>
              <span class="dash-detail-value dash-detail-path">{status.localPath}</span>
            </div>
            {status.currentBranch && (
              <div class="dash-detail-row">
                <span class="dash-detail-label">Branch</span>
                <span class="dash-detail-value">
                  {status.currentBranch}
                  {status.hasUpstream
                    ? <span class="dash-detail-ok"> → {status.upstreamRef}</span>
                    : <span class="dash-detail-problem"> (no upstream tracking)</span>}
                </span>
              </div>
            )}
            <div class="dash-detail-row">
              <span class="dash-detail-label">Remotes</span>
              <span class="dash-detail-value">
                {status.remoteCount > 0 ? `${status.remoteCount} configured` : 'None — local only'}
              </span>
            </div>
            {status.linkedGithubRepo && (
              <div class="dash-detail-row">
                <span class="dash-detail-label">GitHub</span>
                <span class="dash-detail-value">{status.linkedGithubRepo}</span>
              </div>
            )}
            {status.notificationCount > 0 && (
              <div class="dash-detail-row">
                <span class="dash-detail-label">Notifications</span>
                <span class="dash-detail-value">{status.notificationCount} unread</span>
              </div>
            )}
            {status.failedWorkflowRuns > 0 && (
              <div class="dash-detail-row">
                <span class="dash-detail-label">Failed Runs</span>
                <span class="dash-detail-value">{status.failedWorkflowRuns} in last 7 days</span>
              </div>
            )}
          </div>

          {/* Inline notification list */}
          {status.notificationCount > 0 && status.linkedGithubRepo && (
            <NotificationList repoFullName={status.linkedGithubRepo} />
          )}

          {/* Actionable guidance per warning */}
          {warnings.length > 0 && (
            <div class="dash-detail-actions-list">
              {warnings.map((w, i) => (
                <div key={i} class="dash-detail-action">
                  <WarningIcon kind={w.kind} />
                  <span class="dash-detail-action-text">{actionAdvice(w)}</span>
                  {w.kind === 'branch-no-upstream' && status.currentBranch && (
                    <button
                      class={`dash-action-btn dash-action-btn-inline ${pushState === 'done' ? 'dash-btn-done' : ''} ${pushState === 'error' ? 'dash-btn-error' : ''}`}
                      onClick={(e) => { e.stopPropagation(); onPushBranch(status.localPath, status.currentBranch!); }}
                      title={pushState === 'done' ? 'Pushed successfully!' : pushState === 'error' ? 'Push failed — click to retry' : `git push --set-upstream origin ${status.currentBranch}`}
                      disabled={pushState === 'pushing'}
                    >
                      {pushState === 'pushing' && '⏳ Pushing…'}
                      {pushState === 'done' && '✅ Pushed!'}
                      {pushState === 'error' && '❌ Failed — Retry'}
                      {(!pushState || pushState === 'idle') && '🚀 Push upstream'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div class="dash-detail-buttons">
            <button class="dash-action-btn" onClick={(e) => { e.stopPropagation(); onOpenFolder(status.localPath); }}>
              📂 Open folder
            </button>
            {status.linkedGithubRepo && (
              <button class="dash-action-btn" onClick={(e) => { e.stopPropagation(); onOpenGitHub(status.linkedGithubRepo!); }}>
                🌐 Open on GitHub
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Return actionable advice for each warning kind. */
function actionAdvice(w: HealthWarning): string {
  switch (w.kind) {
    case 'branch-no-upstream':
      return 'Push this branch upstream or switch to a tracked branch if the work is done.';
    case 'no-remote':
      return 'Add a remote (e.g. git remote add origin <url>) to back up this repo.';
    case 'has-notifications':
      return 'Check your GitHub notifications for this repo — reviews, issues, or CI updates waiting.';
    case 'failed-workflows':
      return 'Recent CI runs failed — check the Actions tab on GitHub for details.';
    default:
      return w.message;
  }
}

// ── Filtering helpers ─────────────────────────────────────────────────────────

function filterRepos(
  repos: RepoHealthStatus[],
  warningMap: Map<number, HealthWarning[]>,
  card: CardFilter,
): RepoHealthStatus[] {
  switch (card) {
    case 'healthy':
      return repos.filter((r) => (warningMap.get(r.localRepoId)?.length ?? 0) === 0);
    case 'warnings':
      return repos.filter((r) => {
        const w = warningMap.get(r.localRepoId) ?? [];
        return w.some((h) => h.kind === 'branch-no-upstream' || h.kind === 'no-remote');
      });
    case 'notifications':
      return repos.filter((r) => r.notificationCount > 0);
    case 'failed-runs':
      return repos.filter((r) => r.failedWorkflowRuns > 0);
    default:
      return repos;
  }
}

function sectionTitle(card: CardFilter, count: number): string {
  switch (card) {
    case 'healthy': return `✅ Healthy Repos (${count})`;
    case 'warnings': return `⚠️ Repos Needing Attention (${count})`;
    case 'notifications': return `🔔 Repos with Notifications (${count})`;
    case 'failed-runs': return `❌ Repos with Failed Runs (${count})`;
    default: return `🗂️ All Repositories (${count})`;
  }
}

function emptyMessage(card: CardFilter): string {
  switch (card) {
    case 'healthy': return 'No repos without warnings right now.';
    case 'warnings': return 'No repos with warnings — all clear! 🎉';
    case 'notifications': return 'No unread notifications — inbox zero! 📭';
    case 'failed-runs': return 'No failed runs — everything is green! ✅';
    default: return 'No local repos found.';
  }
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export function DashboardPanel() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [cardFilter, setCardFilter] = useState<CardFilter>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [pushStates, setPushStates] = useState<Record<number, 'idle' | 'pushing' | 'done' | 'error'>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sum = await window.jarvis.dashboardGetSummary();
      setSummary(sum);
    } catch (err) {
      console.error('[Dashboard] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleOpenFolder = (localPath: string) => {
    window.jarvis.localOpenFolder(localPath);
  };

  const handleOpenGitHub = (repoFullName: string) => {
    window.jarvis.openUrl(`https://github.com/${repoFullName}`);
  };

  const handlePushBranch = async (localPath: string, branch: string) => {
    // Find the repo id from the path
    const repo = summary?.repos.find((r) => r.localPath === localPath);
    const repoId = repo?.localRepoId ?? -1;

    setPushStates((prev) => ({ ...prev, [repoId]: 'pushing' }));
    try {
      const result = await window.jarvis.dashboardPushBranchUpstream(localPath, branch);
      if (result.ok) {
        setPushStates((prev) => ({ ...prev, [repoId]: 'done' }));
        // Refresh dashboard after a short delay so the warning clears
        setTimeout(() => { void load(); }, 2000);
      } else {
        console.error('[Dashboard] Push upstream failed:', result.error);
        setPushStates((prev) => ({ ...prev, [repoId]: 'error' }));
      }
    } catch (err) {
      console.error('[Dashboard] Push upstream error:', err);
      setPushStates((prev) => ({ ...prev, [repoId]: 'error' }));
    }
  };

  if (loading && !summary) {
    return (
      <div class="dashboard-panel">
        <div class="dash-loading">Loading dashboard…</div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div class="dashboard-panel">
        <div class="dash-empty">No local repos configured. Add scan folders in the Setup tab.</div>
      </div>
    );
  }

  // Build warnings lookup: repoId → warnings[]
  const warningMap = new Map<number, HealthWarning[]>();
  for (const w of summary.warnings) {
    warningMap.set(w.repoId, w.warnings);
  }

  // Count healthy repos (no warnings at all)
  const healthyCount = summary.repos.filter(
    (r) => (warningMap.get(r.localRepoId)?.length ?? 0) === 0,
  ).length;

  // Filter repos based on the selected card
  const displayRepos = filterRepos(summary.repos, warningMap, cardFilter);

  // Sort: repos with warnings first, then alphabetical
  const sorted = [...displayRepos].sort((a, b) => {
    const aW = warningMap.get(a.localRepoId)?.length ?? 0;
    const bW = warningMap.get(b.localRepoId)?.length ?? 0;
    if (aW > 0 && bW === 0) return -1;
    if (aW === 0 && bW > 0) return 1;
    return a.repoName.localeCompare(b.repoName);
  });

  return (
    <div class="dashboard-panel">
      <div class="dash-header">
        <h2>📊 Dashboard</h2>
        <div class="dash-header-right">
          <span class="dash-updated">Last updated: {new Date(summary.generatedAt).toLocaleTimeString()}</span>
          <button class="dash-refresh-btn" onClick={load} disabled={loading} title="Refresh">
            {loading ? '⏳' : '🔄'} Refresh
          </button>
        </div>
      </div>

      <SummaryCards summary={summary} healthyCount={healthyCount} active={cardFilter} onSelect={setCardFilter} />

      {/* Repo health list — filtered by selected card */}
      <div class="dash-section">
        <h3>{sectionTitle(cardFilter, sorted.length)}</h3>
        <div class="dash-repo-list">
          {sorted.length === 0 && (
            <div class="dash-empty">{emptyMessage(cardFilter)}</div>
          )}
          {sorted.map((repo) => (
            <RepoHealthRow
              key={repo.localRepoId}
              status={repo}
              warnings={warningMap.get(repo.localRepoId) ?? []}
              expanded={expandedId === repo.localRepoId}
              pushState={pushStates[repo.localRepoId] ?? 'idle'}
              onToggle={() => setExpandedId(expandedId === repo.localRepoId ? null : repo.localRepoId)}
              onOpenFolder={handleOpenFolder}
              onOpenGitHub={handleOpenGitHub}
              onPushBranch={handlePushBranch}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
