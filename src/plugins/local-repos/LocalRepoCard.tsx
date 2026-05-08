import { normalizeGitHubUrl } from '../shared/utils';
import type { LocalRepo } from '../types';

interface LocalRepoCardProps {
  repo: LocalRepo;
  notifCount?: number;
  /** All local paths for this deduplicated repo group (only passed when 2+). */
  allLocalPaths?: string[];
  /** Called when the user opens a specific local path (only used when allLocalPaths is passed). */
  onOpenPath?: (path: string) => void;
  onClick: () => void;
}

export function LocalRepoCard({ repo, notifCount, allLocalPaths, onOpenPath, onClick }: LocalRepoCardProps) {
  // Collect unique GitHub full-names from all remotes
  const githubRemotes = repo.remotes
    .map((r) => ({ name: r.name, fullName: normalizeGitHubUrl(r.url) }))
    .filter((r): r is { name: string; fullName: string } => r.fullName !== null);

  const isMultiPath = allLocalPaths != null && allLocalPaths.length > 1;

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
      {isMultiPath ? (
        <div style={{ marginTop: '0.2rem' }}>
          <span style={{ color: '#8899aa', fontSize: '0.74rem' }}>
            {'\uD83D\uDCC1'} {allLocalPaths.length} local copies:
          </span>
          {allLocalPaths.map((p) => (
            <div
              key={p}
              style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.12rem' }}
            >
              <span style={{ color: '#8899aa', fontSize: '0.74rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p}>{p}</span>
              {onOpenPath && (
                <button
                  title={`Open ${p}`}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0.2rem', color: '#8899aa', fontSize: '0.8rem' }}
                  onClick={(e: Event) => { e.stopPropagation(); onOpenPath(p); }}
                >
                  {'\uD83D\uDCC2'}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div class="repo-card-desc" style={{ color: '#8899aa', fontSize: '0.74rem' }}>{repo.localPath}</div>
      )}
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
