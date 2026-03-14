import type { Repo } from '../types';

interface RepoCardProps {
  repo: Repo;
  showOwner?: boolean;
  notifCount?: number;
  onClick: () => void;
  onNotifClick?: (e: MouseEvent) => void;
}

export function RepoCard({ repo, showOwner, notifCount, onClick, onNotifClick }: RepoCardProps) {
  const owner = repo.full_name.split('/')[0];
  return (
    <div class="repo-card" onClick={onClick}>
      <div class="repo-card-name" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>
          {showOwner && <span class="repo-card-owner">{owner} / </span>}
          {repo.name}
        </span>
        {notifCount != null && notifCount > 0 && (
          <span
            class="notif-badge"
            title={`${notifCount} unread notification${notifCount !== 1 ? 's' : ''} \u2014 click to view`}
            onClick={onNotifClick}
          >
            {notifCount}
          </span>
        )}
      </div>
      {repo.description && <div class="repo-card-desc">{repo.description}</div>}
      <div class="repo-card-meta">
        {repo.language && <span class="repo-card-lang">{repo.language}</span>}
        {!!repo.private && <span class="repo-card-badge">private</span>}
        {!!repo.fork && <span class="repo-card-badge">fork</span>}
        {!!repo.fork && repo.parent_full_name && (
          <span class="repo-card-date">{'\u2190 ' + repo.parent_full_name}</span>
        )}
        {!!repo.archived && <span class="repo-card-badge">archived</span>}
        {repo.default_branch && <span class="repo-card-date">{repo.default_branch}</span>}
        {repo.last_pushed_at && (
          <span class="repo-card-date">
            pushed {new Date(repo.last_pushed_at).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}
