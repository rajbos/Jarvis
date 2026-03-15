import { normalizeGitHubUrl } from '../shared/utils';
import type { LocalRepo } from '../types';

interface LocalRepoCardProps {
  repo: LocalRepo;
  notifCount?: number;
  onClick: () => void;
}

export function LocalRepoCard({ repo, notifCount, onClick }: LocalRepoCardProps) {
  // Collect unique GitHub full-names from all remotes
  const githubRemotes = repo.remotes
    .map((r) => ({ name: r.name, fullName: normalizeGitHubUrl(r.url) }))
    .filter((r): r is { name: string; fullName: string } => r.fullName !== null);

  return (
    <div class="repo-card" onClick={onClick}>
      <div class="repo-card-name" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{repo.name}</span>
        {notifCount != null && notifCount > 0 && (
          <span
            class="notif-badge"
            title={`${notifCount} unread notification${notifCount !== 1 ? 's' : ''}`}
          >
            {notifCount}
          </span>
        )}
      </div>
      <div class="repo-card-desc" style={{ color: '#8899aa', fontSize: '0.74rem' }}>{repo.localPath}</div>
      <div class="repo-card-meta">
        {repo.remotes.map((r) => (
          <span key={r.name} class="repo-card-badge" title={r.url}>{r.name}</span>
        ))}
        {repo.lastScanned && (
          <span class="repo-card-date">
            scanned {new Date(repo.lastScanned).toLocaleDateString()}
          </span>
        )}
      </div>
      {githubRemotes.length > 0 && (
        <div class="repo-card-meta" style={{ marginTop: '0.25rem' }}>
          {githubRemotes.map((r) => (
            <span key={r.name} class="local-linked-badge" title={`Remote: ${r.name}`}>
              {'\uD83D\uDD17'} {r.fullName}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
