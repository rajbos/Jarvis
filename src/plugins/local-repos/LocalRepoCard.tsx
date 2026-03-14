import type { LocalRepo } from '../types';

interface LocalRepoCardProps {
  repo: LocalRepo;
  onClick: () => void;
}

export function LocalRepoCard({ repo, onClick }: LocalRepoCardProps) {
  const linkedCount = repo.remotes.filter((r) => r.githubRepoId).length;

  return (
    <div class="repo-card" onClick={onClick}>
      <div class="repo-card-name">{repo.name}</div>
      <div class="repo-card-desc" style={{ color: '#8899aa', fontSize: '0.74rem' }}>{repo.localPath}</div>
      <div class="repo-card-meta">
        {repo.remotes.map((r) => (
          <span key={r.name} class="repo-card-badge" title={r.url}>{r.name}</span>
        ))}
        {linkedCount > 0 && (
          <span class="local-linked-badge" title="Linked to GitHub">
            {'\uD83D\uDD17'} {linkedCount} linked
          </span>
        )}
        {repo.lastScanned && (
          <span class="repo-card-date">
            scanned {new Date(repo.lastScanned).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}
