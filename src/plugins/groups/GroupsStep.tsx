import { StatusBadge } from '../shared/StatusBadge';
import type { Group } from '../types';

interface GroupsStepProps {
  groups: Group[];
  onToggle: () => void;
}

export function GroupsStep({ groups, onToggle }: GroupsStepProps) {
  const totalRepos = groups.reduce((s, g) => s + g.localRepoCount + g.githubRepoCount, 0);

  let badgeStatus: 'pending' | 'in-progress' | 'completed' = 'pending';
  let badgeLabel = 'Configure';
  let detail = 'Click to create source groups and assign repos to them.';

  if (groups.length > 0) {
    badgeStatus = 'completed';
    badgeLabel = 'Ready';
    detail = `${groups.length} group${groups.length !== 1 ? 's' : ''} — ${totalRepos} repo${totalRepos !== 1 ? 's' : ''} assigned`;
  }

  return (
    <div
      class="step secrets-step secrets-step-clickable"
      id="groups-step"
      onClick={onToggle}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
        <h2 style={{ marginBottom: 0 }}>
          Groups <StatusBadge status={badgeStatus} label={badgeLabel} />
        </h2>
        <span style={{ color: '#99a', fontSize: '0.8rem' }}>{'›'}</span>
      </div>
      <div style={{ fontSize: '0.85rem', color: '#aaa' }}>{detail}</div>
    </div>
  );
}
