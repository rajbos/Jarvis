import type { Org, NotificationCounts } from '../types';

interface OrgPanelProps {
  orgs: Org[];
  directRepoCount: number;
  starredRepoCount: number;
  activeOrg: string | null;
  notifCounts: NotificationCounts | null;
  notifFetching: boolean;
  sortByNotifs: boolean;
  currentUserLogin: string | null;
  favoritedOrgs: Set<string>;
  onSelectOrg: (orgLogin: string | null, displayName: string) => void;
  onNotifDive: (owner: string, displayName: string, kind: 'owner' | 'starred') => void;
  onSortToggle: () => void;
  onRefresh: () => void;
  onToggleFavoriteOrg: (orgLogin: string) => void;
}

export function OrgPanel({
  orgs,
  directRepoCount,
  starredRepoCount,
  activeOrg,
  notifCounts,
  notifFetching,
  sortByNotifs,
  currentUserLogin,
  favoritedOrgs,
  onSelectOrg,
  onNotifDive,
  onSortToggle,
  onRefresh,
  onToggleFavoriteOrg,
}: OrgPanelProps) {
  const sorted = sortByNotifs && notifCounts
    ? [...orgs].sort((a, b) => {
        const na = notifCounts.perOrg[a.login] ?? 0;
        const nb = notifCounts.perOrg[b.login] ?? 0;
        return nb - na || a.login.localeCompare(b.login);
      })
    : orgs;

  const personalCount = currentUserLogin ? (notifCounts?.perOrg[currentUserLogin] ?? 0) : 0;
  const starredCount = notifCounts?.starredTotal ?? 0;
  const totalNotifs = notifCounts?.total ?? 0;
  const fetchedAt = notifCounts?.fetchedAt ?? null;

  return (
    <div class="org-panel">
      <div class="org-panel-header" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.6rem' }}>
        <span style={{ fontWeight: 700 }}>Organizations</span>
        <span style={{ flex: 1 }} />
        {notifFetching && (
          <span style={{ fontSize: '0.7rem', color: '#667', fontStyle: 'italic' }}>refreshing\u2026</span>
        )}
        {!notifFetching && fetchedAt && (
          <span style={{ fontSize: '0.7rem', color: '#556' }} title={`Last refreshed ${new Date(fetchedAt).toLocaleTimeString()}`}>
            {new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        <span
          class={`notif-refresh-btn${notifFetching ? ' notif-refresh-btn-spinning' : ''}`}
          title={notifFetching ? 'Refreshing\u2026' : 'Refresh notifications'}
          onClick={notifFetching ? undefined : onRefresh}
        >{'\u21BB'}</span>
        {totalNotifs > 0 && (
          <span
            class={`notif-badge notif-badge-large notif-badge-clickable${sortByNotifs ? ' notif-badge-active' : ''}`}
            title={sortByNotifs ? 'Sorting by notifications \u2014 click to reset' : `${totalNotifs} unread \u2014 click to sort`}
            onClick={onSortToggle}
          >
            {'\uD83D\uDD14'} {totalNotifs}
          </span>
        )}
        {totalNotifs === 0 && notifCounts !== null && !notifFetching && (
          <span style={{ fontSize: '0.72rem', color: '#556' }}>{'\u2714\uFE0F'}</span>
        )}
      </div>

      <div class="org-list">
        {sorted.map((org) => {
          const nc = notifCounts?.perOrg[org.login] ?? 0;
          const isFav = favoritedOrgs.has(org.login);
          return (
            <div
              key={org.login}
              class={`org-item${activeOrg === org.login ? ' active' : ''}`}
              onClick={() => onSelectOrg(org.login, org.login)}
            >
              <span class="org-label">{org.login}</span>
              <span class="org-meta-combined">
                {nc > 0 && (
                  <span
                    class="notif-badge notif-badge-clickable"
                    title={`${nc} unread \u2014 click to view`}
                    onClick={(e: MouseEvent) => { e.stopPropagation(); onNotifDive(org.login, org.login, 'owner'); }}
                  >
                    {nc}
                  </span>
                )}
                <span class="org-repos-count">{org.repoCount.toLocaleString()} repo{org.repoCount !== 1 ? 's' : ''}</span>
              </span>
              <span
                class={`fav-star${isFav ? ' fav-star-active' : ''}`}
                title={isFav ? 'Remove from secrets scan favorites' : 'Add to secrets scan favorites'}
                onClick={(e: MouseEvent) => { e.stopPropagation(); onToggleFavoriteOrg(org.login); }}
              >
                {isFav ? '\u2605' : '\u2606'}
              </span>
              <label class="toggle" onClick={(e: MouseEvent) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={org.discoveryEnabled}
                  onChange={(e: Event) => {
                    e.stopPropagation();
                    window.jarvis.setOrgEnabled(org.login, (e.target as HTMLInputElement).checked);
                  }}
                />
                <span class="slider" />
              </label>
            </div>
          );
        })}

        {directRepoCount > 0 && (
          <div
            class={`org-item${activeOrg === '__direct__' ? ' active' : ''}`}
            onClick={() => onSelectOrg(null, 'Personal & collaborator')}
          >
            <span class="org-label" style={{ fontStyle: 'italic' }}>{'\uD83D\uDC64 Personal'}</span>
            <span class="org-meta-combined">
              {personalCount > 0 && (
                <span
                  class="notif-badge notif-badge-clickable"
                  title={`${personalCount} unread \u2014 click to view`}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    if (currentUserLogin) onNotifDive(currentUserLogin, 'Personal', 'owner');
                  }}
                >
                  {personalCount}
                </span>
              )}
              <span class="org-repos-count">{directRepoCount.toLocaleString()} repo{directRepoCount !== 1 ? 's' : ''}</span>
            </span>
          </div>
        )}

        {starredRepoCount > 0 && (
          <div
            class={`org-item${activeOrg === '__starred__' ? ' active' : ''}`}
            onClick={() => onSelectOrg('__starred__', '\u2B50 Starred')}
          >
            <span class="org-label" style={{ fontStyle: 'italic' }}>{'\u2B50 Starred'}</span>
            <span class="org-meta-combined">
              {starredCount > 0 && (
                <span
                  class="notif-badge notif-badge-clickable"
                  title={`${starredCount} unread \u2014 click to view`}
                  onClick={(e: MouseEvent) => { e.stopPropagation(); onNotifDive('', '\u2B50 Starred', 'starred'); }}
                >
                  {starredCount}
                </span>
              )}
              <span class="org-repos-count">{starredRepoCount.toLocaleString()} repo{starredRepoCount !== 1 ? 's' : ''}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
