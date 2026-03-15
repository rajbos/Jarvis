import { useState } from 'preact/hooks';
import { LocalRepoCard } from './LocalRepoCard';
import { normalizeGitHubUrl } from '../shared/utils';
import type { LocalRepo, NotificationCounts } from '../types';

type LocalSortKey = 'name' | 'scanned' | 'notifs';

interface LocalRepoPanelViewProps {
  title: string;
  repos: LocalRepo[];
  notifCounts: NotificationCounts | null;
  initialSortKey?: LocalSortKey;
  onOpenRepoNotif: (repoFullName: string) => void;
  onClearNotif: () => void;
  onSortChange: (key: LocalSortKey) => void;
  onClose: () => void;
}

export function LocalRepoPanelView({ title, repos, notifCounts, initialSortKey = 'name', onOpenRepoNotif, onClearNotif, onSortChange, onClose }: LocalRepoPanelViewProps) {
  const [sortKey, setSortKey] = useState<LocalSortKey>(initialSortKey);

  /** Best GitHub full_name for a local repo — first linked remote wins. */
  function getFullName(repo: LocalRepo): string | null {
    for (const r of repo.remotes) {
      const fn = normalizeGitHubUrl(r.url);
      if (fn) return fn;
    }
    return null;
  }

  function getNotifCount(repo: LocalRepo): number {
    const fn = getFullName(repo);
    return fn && notifCounts ? (notifCounts.perRepo[fn] ?? 0) : 0;
  }

  const sorted = [...repos].sort((a, b) => {
    if (sortKey === 'notifs') return getNotifCount(b) - getNotifCount(a) || a.name.localeCompare(b.name);
    if (sortKey === 'scanned') {
      const ta = a.lastScanned ? new Date(a.lastScanned).getTime() : 0;
      const tb = b.lastScanned ? new Date(b.lastScanned).getTime() : 0;
      return tb - ta;
    }
    return a.name.localeCompare(b.name);
  });

  const totalNotifs = repos.reduce((s, r) => s + getNotifCount(r), 0);

  return (
    <div class="repo-panel">
      <div class="repo-panel-header">
        <button class="repo-panel-close" title="Back" onClick={onClose}>&#8249;</button>
        <span class="repo-panel-title">{title}</span>
        <span class="local-panel-count">{repos.length.toLocaleString()} repo{repos.length !== 1 ? 's' : ''}</span>
        <span style={{ flex: 1 }} />
        {notifCounts && totalNotifs > 0 && (
          <span
            class={`notif-badge notif-badge-large notif-badge-clickable${sortKey === 'notifs' ? ' notif-badge-active' : ''}`}
            title={sortKey === 'notifs' ? 'Sorting by notifications — click to reset' : `${totalNotifs} unread — click to sort`}
            onClick={() => { const k: LocalSortKey = sortKey === 'notifs' ? 'name' : 'notifs'; setSortKey(k); onSortChange(k); }}
          >
            {'\uD83D\uDD14'} {totalNotifs}
          </span>
        )}
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>
      <div class="repo-panel-filter">
        <label class="filter-label" style={{ gap: '0.6rem' }}>
          Sort:
          <select
            value={sortKey}
            onChange={(e: Event) => { const k = (e.target as HTMLSelectElement).value as LocalSortKey; setSortKey(k); onSortChange(k); }}
            class="local-sort-select"
          >
            <option value="name">Name A–Z</option>
            <option value="scanned">Last Scanned</option>
            <option value="notifs">Notifications</option>
          </select>
        </label>
      </div>
      {sorted.length === 0 ? (
        <div style={{ color: '#99a', fontSize: '0.85rem', padding: '0.5rem' }}>No repositories found</div>
      ) : (
        sorted.map((repo) => {
          const fullName = getFullName(repo);
          const notifCount = getNotifCount(repo);
          const handleClick = fullName && notifCount > 0
            ? () => { onClearNotif(); onOpenRepoNotif(fullName); }
            : () => { onClearNotif(); void window.jarvis.localOpenFolder(repo.localPath); };
          return (
            <LocalRepoCard
              key={repo.localPath}
              repo={repo}
              notifCount={notifCount}
              onClick={handleClick}
            />
          );
        })
      )}
    </div>
  );
}
