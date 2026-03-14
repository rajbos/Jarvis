import { useState } from 'preact/hooks';
import { RepoCard } from './RepoCard';
import type { Repo, NotificationCounts } from '../types';

interface RepoPanelViewProps {
  title: string;
  repos: Repo[];
  loading: boolean;
  orgLogin: string | null;
  currentUserLogin: string | null;
  notifCounts: NotificationCounts | null;
  sortByNotifs: boolean;
  onSortToggle: () => void;
  onClose: () => void;
  onOpenRepoNotif: (repoFullName: string) => void;
  onRefreshAll?: () => void;
  refreshingAll?: boolean;
}

export function RepoPanelView({
  title,
  repos,
  loading,
  orgLogin,
  currentUserLogin,
  notifCounts,
  sortByNotifs,
  onSortToggle,
  onClose,
  onOpenRepoNotif,
  onRefreshAll,
  refreshingAll,
}: RepoPanelViewProps) {
  const [hideMyRepos, setHideMyRepos] = useState(true);

  const showFilter = orgLogin === null;
  const showOwner = orgLogin === null || orgLogin === '__starred__';

  let filteredRepos =
    showFilter && hideMyRepos && currentUserLogin
      ? repos.filter((r) => !r.full_name.startsWith(currentUserLogin + '/'))
      : repos;

  if (sortByNotifs && notifCounts) {
    filteredRepos = [...filteredRepos].sort((a, b) => {
      const na = notifCounts.perRepo[a.full_name] ?? 0;
      const nb = notifCounts.perRepo[b.full_name] ?? 0;
      return nb - na;
    });
  }

  const repoNotifTotal = notifCounts
    ? filteredRepos.reduce((s, r) => s + (notifCounts.perRepo[r.full_name] ?? 0), 0)
    : 0;

  return (
    <div class="repo-panel">
      <div class="repo-panel-header">
        <span class="repo-panel-title">{title}</span>
        <span style={{ flex: 1 }} />
        {onRefreshAll && notifCounts && repoNotifTotal > 0 && (
          <span
            class={`notif-refresh-btn${refreshingAll ? ' notif-refresh-btn-spinning' : ''}`}
            title={refreshingAll ? 'Refreshing\u2026' : 'Refresh notifications'}
            onClick={refreshingAll ? undefined : onRefreshAll}
          >{'\u21BB'}</span>
        )}
        {notifCounts && repoNotifTotal > 0 && (
          <span
            class={`notif-badge notif-badge-clickable${sortByNotifs ? ' notif-badge-active' : ''}`}
            title={sortByNotifs ? 'Sorting by notifications \u2014 click to reset' : `${repoNotifTotal} unread \u2014 click to sort`}
            onClick={onSortToggle}
          >
            {'\uD83D\uDD14'} {repoNotifTotal}
          </span>
        )}
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>
      {showFilter && (
        <div class="repo-panel-filter">
          <label class="filter-label">
            <input
              type="checkbox"
              checked={hideMyRepos}
              onChange={() => setHideMyRepos(!hideMyRepos)}
            />{' '}
            Hide my repos
          </label>
        </div>
      )}
      {loading && (
        <div class="repo-panel-loading">
          <span class="repo-panel-spinner" />{' '}Loading repositories...
        </div>
      )}
      {!loading && (
        filteredRepos.length === 0 ? (
          <div style={{ color: '#99a', fontSize: '0.85rem', padding: '0.5rem' }}>
            {repos.length === 0 ? 'No repositories found' : 'No repositories (all filtered)'}
          </div>
        ) : (
          filteredRepos.map((repo) => {
            const nc = notifCounts?.perRepo[repo.full_name] ?? 0;
            return (
              <RepoCard
                key={repo.full_name}
                repo={repo}
                showOwner={showOwner}
                notifCount={nc}
                onClick={nc > 0
                  ? () => void onOpenRepoNotif(repo.full_name)
                  : () => window.jarvis.openUrl('https://github.com/' + repo.full_name)}
                onNotifClick={nc > 0 ? (e: MouseEvent) => { e.stopPropagation(); void onOpenRepoNotif(repo.full_name); } : undefined}
              />
            );
          })
        )
      )}
    </div>
  );
}
