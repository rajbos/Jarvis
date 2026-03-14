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

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [ctxMenu]);

  const handleDismiss = async (id: string) => {
    setCtxMenu(null);
    await window.jarvis.dismissNotification(id);
    onDismiss?.(id);
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
