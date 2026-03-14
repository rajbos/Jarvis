import { StatusBadge } from '../shared/StatusBadge';
import type { ScanFolder, LocalScanProgress } from '../types';

interface LocalReposStepProps {
  folders: ScanFolder[] | null;
  scanProgress: LocalScanProgress | null;
  scanFinished: boolean;
  onToggle: () => void;
}

export function LocalReposStep({
  folders,
  scanProgress,
  scanFinished,
  onToggle,
}: LocalReposStepProps) {
  const configured = folders !== null && folders.length > 0;
  const totalRepos = folders?.reduce((s, f) => s + (f.repoCount ?? 0), 0) ?? 0;
  const scanning = scanProgress?.phase === 'scanning';

  let badgeStatus: 'pending' | 'completed' | 'in-progress' = 'pending';
  let badgeLabel = 'Configure';
  let detail = 'Click to configure local repository folders.';

  if (configured && (scanFinished || scanProgress?.phase === 'done')) {
    badgeStatus = 'completed';
    badgeLabel = 'Ready';
    detail = `${totalRepos.toLocaleString()} local repo${totalRepos !== 1 ? 's' : ''} found`;
  } else if (configured && scanning) {
    badgeStatus = 'in-progress';
    badgeLabel = 'Scanning';
    detail = scanProgress?.currentFolder
      ? `Scanning ${scanProgress.currentFolder}…`
      : `Scanning… (${scanProgress?.reposFound ?? 0} repos found)`;
  } else if (configured) {
    badgeStatus = 'in-progress';
    badgeLabel = 'Ready';
    detail = `${folders!.length} folder${folders!.length !== 1 ? 's' : ''} configured — click to browse`;
  }

  return (
    <div
      class={`step local-repos-step${configured ? ' local-repos-step-clickable' : ''}`}
      id="local-repos-step"
      onClick={onToggle}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
        <h2 style={{ marginBottom: 0 }}>
          Local Repositories <StatusBadge status={badgeStatus} label={badgeLabel} />
        </h2>
        {configured && <span style={{ color: '#99a', fontSize: '0.8rem' }}>{'›'}</span>}
      </div>
      <div style={{ fontSize: '0.85rem', color: '#aaa' }}>{detail}</div>
    </div>
  );
}
