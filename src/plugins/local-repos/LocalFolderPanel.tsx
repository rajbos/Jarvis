import type { ScanFolder } from '../types';

interface LocalFolderPanelProps {
  folders: ScanFolder[];
  activeFolder: string | null;
  onSelectFolder: (folderPath: string) => void;
  onConfigure: () => void;
}

export function LocalFolderPanel({
  folders,
  activeFolder,
  onSelectFolder,
  onConfigure,
}: LocalFolderPanelProps) {
  return (
    <div class="org-panel">
      <div class="org-panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Local Folders</span>
        <button
          class="repo-panel-close"
          title="Configure folders"
          onClick={onConfigure}
          style={{ fontSize: '0.85rem', padding: '0.1rem 0.4rem' }}
        >
          ⚙
        </button>
      </div>
      <div class="org-list">
        {folders.map((folder) => {
          const label = folder.path.split(/[\\/]/).filter(Boolean).pop() ?? folder.path;
          return (
            <div
              key={folder.path}
              class={`org-item${activeFolder === folder.path ? ' active' : ''}`}
              onClick={() => onSelectFolder(folder.path)}
            >
              <span class="org-label" title={folder.path}>{label}</span>
              <span class="org-meta">
                {(folder.repoCount ?? 0).toLocaleString()} repo{(folder.repoCount ?? 0) !== 1 ? 's' : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
