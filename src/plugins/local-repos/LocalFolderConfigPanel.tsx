import type { ScanFolder } from '../types';

interface LocalFolderConfigPanelProps {
  folders: ScanFolder[];
  onAdd: () => void;
  onRemove: (path: string) => void;
  onStartScan: () => void;
  onClose: () => void;
  scanning: boolean;
}

export function LocalFolderConfigPanel({
  folders,
  onAdd,
  onRemove,
  onStartScan,
  onClose,
  scanning,
}: LocalFolderConfigPanelProps) {
  return (
    <div class="org-panel local-config-panel">
      <div class="org-panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Configure Folders</span>
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>
      <p style={{ fontSize: '0.82rem', color: '#c8c8c8', marginBottom: '0.75rem' }}>
        Add folders to scan for Git repositories. You can add specific repo folders or parent directories.
      </p>
      <button
        class="local-add-folder-btn"
        onClick={onAdd}
        disabled={scanning}
        style={{ width: '100%', marginBottom: '0.75rem' }}
      >
        + Choose Folder…
      </button>
      {folders.length === 0 ? (
        <div style={{ color: '#99a', fontSize: '0.82rem', padding: '0.35rem 0' }}>No folders configured yet.</div>
      ) : (
        <ul class="local-folder-list">
          {folders.map((f) => (
            <li key={f.path} class="local-folder-item">
              <span class="local-folder-path" title={f.path}>{f.path}</span>
              <span class="local-folder-count">
                {f.repoCount ?? 0} repo{(f.repoCount ?? 0) !== 1 ? 's' : ''}
              </span>
              <button
                class="local-folder-remove"
                title="Remove folder"
                onClick={() => onRemove(f.path)}
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}
      {folders.length > 0 && (
        <button
          onClick={onStartScan}
          disabled={scanning}
          style={{ marginTop: '0.75rem', width: '100%' }}
        >
          {scanning ? 'Scanning…' : 'Scan Now'}
        </button>
      )}
    </div>
  );
}
