import { StatusBadge } from '../shared/StatusBadge';
import { formatNumber } from '../shared/utils';
import type { DiscoveryProgress } from '../types';

interface DiscoverySectionProps {
  progress: DiscoveryProgress | null;
  finished: boolean;
  onToggleOrgs: () => void;
}

export function DiscoverySection({ progress, finished, onToggleOrgs }: DiscoverySectionProps) {
  let badgeStatus: 'pending' | 'completed' | 'in-progress' = 'in-progress';
  let badgeLabel = 'Starting...';
  let detail = 'Scanning organizations and repositories...';

  if (finished || (progress && progress.phase === 'done')) {
    badgeStatus = 'completed';
    badgeLabel = 'Complete';
    const p = progress!;
    detail = `Found ${formatNumber(p.orgsFound)} org${p.orgsFound !== 1 ? 's' : ''} and ${formatNumber(p.reposFound)} repo${p.reposFound !== 1 ? 's' : ''}`;
  } else if (progress) {
    badgeStatus = 'in-progress';
    badgeLabel = 'Running';
    const phaseLabels: Record<string, string> = {
      orgs: 'Discovering organizations...',
      repos: `Scanning org repositories... (${formatNumber(progress.reposFound)} repos so far)`,
      'user-repos': `Scanning personal + collaborator repos... (${formatNumber(progress.reposFound)} repos so far)`,
      starred: `Fetching starred repos... (${formatNumber(progress.reposFound)} repos so far)`,
      'pat-repos': progress.currentOrg
        ? `PAT: scanning ${progress.currentOrg}... (${formatNumber(progress.reposFound)} new repos)`
        : `PAT: scanning collaborator repos... (${formatNumber(progress.reposFound)} new repos)`,
    };
    detail = phaseLabels[progress.phase] || 'Working...';
    if (progress.orgsFound > 0) {
      detail += ` \u2014 ${formatNumber(progress.orgsFound)} org${progress.orgsFound !== 1 ? 's' : ''} found`;
    }
  }

  return (
    <div style={{ marginTop: '1rem' }}>
      <div class="discovery-toggle" onClick={onToggleOrgs}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Repository Discovery <span style={{ color: '#99a', fontSize: '0.8rem' }}>{'\u203A'}</span>
          </span>
          <StatusBadge status={badgeStatus} label={badgeLabel} />
        </div>
        <div style={{ fontSize: '0.85rem', color: '#aaa' }}>{detail}</div>
      </div>
    </div>
  );
}
