import { useState } from 'preact/hooks';
import type { LocalRepo, NotificationCounts } from '../types';
import { getImmediateChildren, normalizeGitHubUrl } from '../shared/utils';

interface LocalSubfolderPanelProps {
  path: string;
  repos: LocalRepo[];
  notifCounts: NotificationCounts | null;
  canGoBack: boolean;
  initialSortByNotifs?: boolean;
  onSelectChild: (childPath: string) => void;
  onBack: () => void;
  onConfigure: () => void;
  onClearNotif: () => void;
  onSortChange: (sortByNotifs: boolean) => void;
}

export function LocalSubfolderPanel({
  path,
  repos,
  notifCounts,
  canGoBack,
  initialSortByNotifs = false,
  onSelectChild,
  onBack,
  onConfigure,
  onClearNotif,
  onSortChange,
}: LocalSubfolderPanelProps) {
  const [sortByNotifs, setSortByNotifs] = useState(initialSortByNotifs);

  const children = getImmediateChildren(path, repos);
  const folderName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const totalRepos = repos.length;

  /** Sum notification counts for all repos under a child folder path. */
  function childNotifCount(childPath: string): number {
    if (!notifCounts) return 0;
    const norm = childPath.replace(/[\\/]+$/, '');
    return repos
      .filter((r) => r.localPath === norm || r.localPath.startsWith(norm + '/') || r.localPath.startsWith(norm + '\\'))
      .reduce((sum, r) => {
        for (const remote of r.remotes) {
          const fn = normalizeGitHubUrl(remote.url);
          if (fn) sum += notifCounts.perRepo[fn] ?? 0;
        }
        return sum;
      }, 0);
  }

  const totalNotifs = notifCounts
    ? children.reduce((s, c) => s + childNotifCount(c.path), 0)
    : 0;

  const sorted = sortByNotifs
    ? [...children].sort((a, b) => childNotifCount(b.path) - childNotifCount(a.path))
    : children;

  return (
    <div class="repo-panel">
      <div class="repo-panel-header">
        {canGoBack && (
          <button class="repo-panel-close" title="Back" onClick={onBack}>&#8249;</button>
        )}
        <span class="repo-panel-title">{folderName}</span>
        <span class="local-panel-count">{totalRepos.toLocaleString()} repo{totalRepos !== 1 ? 's' : ''}</span>
        <span style={{ flex: 1 }} />
        {notifCounts && totalNotifs > 0 && (
          <span
            class={`notif-badge notif-badge-large notif-badge-clickable${sortByNotifs ? ' notif-badge-active' : ''}`}
            title={sortByNotifs ? 'Sorting by notifications — click to reset' : `${totalNotifs} unread — click to sort`}
            onClick={() => { const next = !sortByNotifs; setSortByNotifs(next); onSortChange(next); }}
          >
            {'\uD83D\uDD14'} {totalNotifs}
          </span>
        )}
        <button class="repo-panel-close" title="Configure folders" onClick={onConfigure}>&#9881;</button>
      </div>
      <div class="org-list" style={{ marginTop: '0.5rem' }}>
        {sorted.length === 0 ? (
          <div style={{ color: '#99a', fontSize: '0.82rem', padding: '0.35rem 0' }}>No repositories found</div>
        ) : (
          sorted.map((child) => {
            const nc = childNotifCount(child.path);
            return (
              <div
                key={child.path}
                class="org-item"
                onClick={() => { onClearNotif(); onSelectChild(child.path); }}
              >
                <span class="org-label" title={child.path}>{child.name}</span>
                <span class="org-meta-combined">
                  {nc > 0 && (
                    <span class="notif-badge" title={`${nc} unread`}>{nc}</span>
                  )}
                  <span class="org-repos-count">{child.repoCount.toLocaleString()} repo{child.repoCount !== 1 ? 's' : ''}</span>
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
