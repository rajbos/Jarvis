import { useState } from 'preact/hooks';
import { LocalRepoCard } from './LocalRepoCard';
import type { LocalRepo } from '../types';

type LocalSortKey = 'name' | 'scanned';

interface LocalRepoPanelViewProps {
  title: string;
  repos: LocalRepo[];
  onClose: () => void;
}

export function LocalRepoPanelView({ title, repos, onClose }: LocalRepoPanelViewProps) {
  const [sortKey, setSortKey] = useState<LocalSortKey>('name');

  const sorted = [...repos].sort((a, b) => {
    if (sortKey === 'name') return a.name.localeCompare(b.name);
    const ta = a.lastScanned ? new Date(a.lastScanned).getTime() : 0;
    const tb = b.lastScanned ? new Date(b.lastScanned).getTime() : 0;
    return tb - ta;
  });

  return (
    <div class="repo-panel">
      <div class="repo-panel-header">
        <span class="repo-panel-title">{title}</span>
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>
      <div class="repo-panel-filter">
        <label class="filter-label" style={{ gap: '0.6rem' }}>
          Sort:
          <select
            value={sortKey}
            onChange={(e: Event) => setSortKey((e.target as HTMLSelectElement).value as LocalSortKey)}
            class="local-sort-select"
          >
            <option value="name">Name A–Z</option>
            <option value="scanned">Last Scanned</option>
          </select>
        </label>
      </div>
      {sorted.length === 0 ? (
        <div style={{ color: '#99a', fontSize: '0.85rem', padding: '0.5rem' }}>No repositories found</div>
      ) : (
        sorted.map((repo) => (
          <LocalRepoCard
            key={repo.localPath}
            repo={repo}
            onClick={() => void window.jarvis.localOpenFolder(repo.localPath)}
          />
        ))
      )}
    </div>
  );
}
