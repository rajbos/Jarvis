import { useState, useEffect } from 'preact/hooks';
import { relativeAge, notifDescription, isDirect } from '../shared/utils';
import type { StoredNotification } from '../types';

const TYPE_ICON: Record<string, string> = {
  Issue: '\uD83D\uDC1B',
  PullRequest: '\uD83D\uDD00',
  Release: '\uD83C\uDF89',
  Commit: '\uD83D\uDCBE',
  Discussion: '\uD83D\uDCAC',
  CheckSuite: '\u2705',
};

async function openNotifUrl(n: StoredNotification): Promise<void> {
  if (n.subject_type === 'CheckSuite' && n.subject_url) {
    const runUrl = await window.jarvis.getRunUrlForCheckSuite(n.subject_url);
    window.jarvis.openUrl(runUrl ?? `https://github.com/${n.repo_full_name}/actions`);
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

interface OrgNotifPanelProps {
  title: string;
  notifications: StoredNotification[];
  loading: boolean;
  onClose: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  onDismiss?: (id: string) => void;
}

export function OrgNotifPanel({ title, notifications, loading, onClose, onRefresh, refreshing, onDismiss }: OrgNotifPanelProps) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; notifId: string } | null>(null);
  const [closedByMeIds, setClosedByMeIds] = useState<string[]>([]);
  const [dismissingClosed, setDismissingClosed] = useState(false);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [ctxMenu]);

  // Check which issue notifications are for issues closed by the current user
  useEffect(() => {
    if (loading) return;
    const issueNotifs = notifications.filter((n) => n.subject_type === 'Issue' && n.subject_url);
    if (issueNotifs.length === 0) { setClosedByMeIds([]); return; }

    let cancelled = false;
    setClosedByMeIds([]);

    const run = async () => {
      const ids: string[] = [];
      const byUrl = new Map<string, typeof issueNotifs>();
      for (const n of issueNotifs) {
        if (!n.subject_url) continue;
        if (!byUrl.has(n.subject_url)) byUrl.set(n.subject_url, []);
        byUrl.get(n.subject_url)!.push(n);
      }

      const entries = [...byUrl.entries()];
      const CONCURRENCY = 6;
      let next = 0;
      const worker = async () => {
        while (next < entries.length) {
          const idx = next++;
          const [url, notifs] = entries[idx];
          try {
            const result = await window.jarvis.githubGetIssueState(url);
            if (cancelled) return;
            if (result?.state === 'closed' && result.closedByMe) {
              ids.push(...notifs.map((n) => n.id));
            }
          } catch { /* skip individual issue */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
      if (!cancelled) setClosedByMeIds(ids);
    };

    void run();
    return () => { cancelled = true; };
  }, [notifications, loading]);

  const handleDismiss = async (id: string) => {
    setCtxMenu(null);
    await window.jarvis.dismissNotification(id);
    onDismiss?.(id);
  };

  const handleDismissClosedByMe = async () => {
    setDismissingClosed(true);
    for (const id of closedByMeIds) {
      try {
        await window.jarvis.dismissNotification(id);
        onDismiss?.(id);
      } catch { /* skip */ }
    }
    setClosedByMeIds([]);
    setDismissingClosed(false);
  };

  // Group by repo
  const groups = new Map<string, StoredNotification[]>();
  for (const n of notifications) {
    if (!groups.has(n.repo_full_name)) groups.set(n.repo_full_name, []);
    groups.get(n.repo_full_name)!.push(n);
  }

  return (
    <div class="repo-panel">
      <div class="repo-panel-header">
        <span class="repo-panel-title">
          {'\uD83D\uDD14'} {title}
          {!loading && notifications.length > 0 && (
            <span class="notif-badge notif-badge-large" style={{ marginLeft: '0.4rem' }}>
              {notifications.length}
            </span>
          )}
        </span>
        {onRefresh && (
          <span
            class={`notif-refresh-btn${refreshing ? ' notif-refresh-btn-spinning' : ''}`}
            title={refreshing ? 'Refreshing\u2026' : 'Refresh notifications'}
            onClick={refreshing ? undefined : onRefresh}
          >{'\u21BB'}</span>
        )}
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>

      {loading && (
        <div style={{ color: '#99a', fontSize: '0.85rem', padding: '0.5rem' }}>Loading\u2026</div>
      )}
      {!loading && notifications.length === 0 && (
        <div style={{ color: '#99a', fontSize: '0.85rem', padding: '0.5rem' }}>No unread notifications</div>
      )}

      {!loading && closedByMeIds.length > 0 && (
        <div class="dash-recoverable-banner">
          <span class="dash-recoverable-icon">{'✓'}</span>
          <div class="dash-recoverable-body">
            <span class="dash-recoverable-title">Issues you closed</span>
            <span class="dash-recoverable-detail">
              {`${closedByMeIds.length} notification${closedByMeIds.length !== 1 ? 's' : ''} for issues closed by you`}
            </span>
          </div>
          <button
            class={`dash-recoverable-btn${dismissingClosed ? ' dash-recoverable-btn--busy' : ''}`}
            disabled={dismissingClosed}
            onClick={() => void handleDismissClosedByMe()}
          >
            {dismissingClosed
              ? <span class="dismiss-spinner" />
              : `Dismiss ${closedByMeIds.length}`}
          </button>
        </div>
      )}

      {!loading && Array.from(groups.entries()).map(([repoFullName, items]) => (
        <div key={repoFullName} style={{ marginBottom: '0.5rem' }}>
          <div
            class="org-item"
            style={{ borderRadius: '6px 6px 0 0', marginBottom: 0, cursor: 'pointer' }}
            onClick={() => window.jarvis.openUrl('https://github.com/' + repoFullName)}
          >
            <span class="org-label">{repoFullName.split('/')[1]}</span>
            <span class="notif-badge">{items.length}</span>
          </div>
          {items.map((n) => (
            <div
              key={n.id}
              class="org-item"
              style={{ borderRadius: 0, marginBottom: 0, borderTop: '1px solid #0a1f3e', flexDirection: 'column', alignItems: 'flex-start', gap: '0.25rem', cursor: 'pointer' }}
              onClick={() => openNotifUrl(n)}
              onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, notifId: n.id }); }}
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
          ))}
        </div>
      ))}

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
    </div>
  );
}
