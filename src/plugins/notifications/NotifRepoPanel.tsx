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

interface NotifRepoPanelProps {
  repoFullName: string;
  notifications: StoredNotification[];
  onClose: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  onDismiss?: (id: string) => void;
}

export function NotifRepoPanel({ repoFullName, notifications, onClose, onRefresh, refreshing, onDismiss }: NotifRepoPanelProps) {
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

  return (
    <div class="repo-panel">
      <div class="repo-panel-header">
        <span class="repo-panel-title">{repoFullName.split('/')[1]}</span>
        <span style={{ flex: 1 }} />
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
      {notifications.map((n) => (
        <div
          key={n.id}
          class="org-item"
          style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '0.25rem', cursor: 'pointer' }}
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
