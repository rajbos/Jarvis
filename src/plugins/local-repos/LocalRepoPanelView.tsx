import { useState } from 'preact/hooks';
import { LocalRepoCard } from './LocalRepoCard';
import { deduplicateLocalRepos, formatNumber } from '../shared/utils';
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

  const deduped = deduplicateLocalRepos(repos);

  function getNotifCount(githubFullName: string | null): number {
    return githubFullName && notifCounts ? (notifCounts.perRepo[githubFullName] ?? 0) : 0;
  }

  const sorted = [...deduped].sort((a, b) => {
    if (sortKey === 'notifs') return getNotifCount(b.githubFullName) - getNotifCount(a.githubFullName) || a.primaryRepo.name.localeCompare(b.primaryRepo.name);
    if (sortKey === 'scanned') {
      const ta = a.primaryRepo.lastScanned ? new Date(a.primaryRepo.lastScanned).getTime() : 0;
      const tb = b.primaryRepo.lastScanned ? new Date(b.primaryRepo.lastScanned).getTime() : 0;
      return tb - ta;
    }
    return a.primaryRepo.name.localeCompare(b.primaryRepo.name);
  });

  const totalNotifs = deduped.reduce((s, g) => s + getNotifCount(g.githubFullName), 0);
  const totalLocalPaths = repos.length;
  const hasDuplicates = deduped.some((g) => g.isDuplicate);

  return (
    <div class="repo-panel">
      <div class="repo-panel-header">
        <button class="repo-panel-close" title="Back" onClick={onClose}>&#8249;</button>
        <span class="repo-panel-title">{title}</span>
        <span class="local-panel-count">
          {formatNumber(deduped.length)} repo{deduped.length !== 1 ? 's' : ''}
          {hasDuplicates && (
            <span title={`${totalLocalPaths} local copies across ${deduped.length} unique repo${deduped.length !== 1 ? 's' : ''}`}> ({totalLocalPaths} local copies)</span>
          )}
        </span>
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
        sorted.map((group) => {
          const { primaryRepo, githubFullName, allLocalPaths, isDuplicate } = group;
          const notifCount = getNotifCount(githubFullName);
          const handleClick = githubFullName && notifCount > 0
            ? () => { onClearNotif(); onOpenRepoNotif(githubFullName); }
            : () => { onClearNotif(); void window.jarvis.localOpenFolder(primaryRepo.localPath); };
          return (
            <LocalRepoCard
              key={primaryRepo.localPath}
              repo={primaryRepo}
              notifCount={notifCount}
              allLocalPaths={isDuplicate ? allLocalPaths : undefined}
              onOpenPath={(p) => { onClearNotif(); void window.jarvis.localOpenFolder(p); }}
              onClick={handleClick}
            />
          );
        })
      )}
    </div>
  );
}
