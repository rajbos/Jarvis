import type { Repo } from '../types';

const COLLAB_LABELS: Record<string, string> = {
  pr: '\uD83D\uDD00 PR',
  issue: '\uD83D\uDCDD issue',
  collaborator: '\uD83E\uDD1D collaborator',
};

function formatCollabReason(reason: string): string {
  return reason
    .split(',')
    .map((r) => COLLAB_LABELS[r.trim()] ?? r.trim())
    .join(' · ');
}

interface RepoCardProps {
  repo: Repo;
  showOwner?: boolean;
  notifCount?: number;
  favorited?: boolean;
  onClick: () => void;
  onNotifClick?: (e: MouseEvent) => void;
  onToggleFavorite?: (e: MouseEvent) => void;
}

export function RepoCard({ repo, showOwner, notifCount, favorited, onClick, onNotifClick, onToggleFavorite }: RepoCardProps) {
  const owner = repo.full_name.split('/')[0];
  return (
    <div class="repo-card" onClick={onClick}>
      <div class="repo-card-name" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>
          {showOwner && <span class="repo-card-owner">{owner} / </span>}
          {repo.name}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          {onToggleFavorite != null && (
            <span
              class={`fav-star${favorited ? ' fav-star-active' : ''}`}
              title={favorited ? 'Remove from secrets scan favorites' : 'Add to secrets scan favorites'}
              onClick={onToggleFavorite}
            >
              {favorited ? '\u2605' : '\u2606'}
            </span>
          )}
          {notifCount != null && notifCount > 0 && (
            <span
              class="notif-badge"
              title={`${notifCount} unread notification${notifCount !== 1 ? 's' : ''} \u2014 click to view`}
              onClick={onNotifClick}
            >
              {notifCount}
            </span>
          )}
        </span>
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
        {repo.collaboration_reason && !['owner', 'org_member'].includes(repo.collaboration_reason) && (
          <span class="repo-card-badge repo-card-collab-badge" title={`Collaboration: ${repo.collaboration_reason}`}>
            {formatCollabReason(repo.collaboration_reason)}
          </span>
        )}
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
