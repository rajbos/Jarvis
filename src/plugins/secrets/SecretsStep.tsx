import { StatusBadge } from '../shared/StatusBadge';

interface SecretsStepProps {
  scanned: boolean;
  scanning: boolean;
  secretCount: number;
  repoCount: number;
  onToggle: () => void;
}

export function SecretsStep({
  scanned,
  scanning,
  secretCount,
  repoCount,
  onToggle,
}: SecretsStepProps) {
  let badgeStatus: 'pending' | 'in-progress' | 'completed' = 'pending';
  let badgeLabel = 'Not scanned';
  let detail = 'Click to scan your personal repos for GitHub Actions secrets.';

  if (scanning) {
    badgeStatus = 'in-progress';
    badgeLabel = 'Scanning';
    detail = 'Scanning repositories for secrets…';
  } else if (scanned) {
    badgeStatus = 'completed';
    badgeLabel = 'Scanned';
    detail = secretCount === 0
      ? `No secrets found across ${repoCount} repo${repoCount !== 1 ? 's' : ''}`
      : `${secretCount} secret${secretCount !== 1 ? 's' : ''} across ${repoCount} repo${repoCount !== 1 ? 's' : ''}`;
  }

  return (
    <div
      class="step secrets-step secrets-step-clickable"
      id="secrets-step"
      onClick={onToggle}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
        <h2 style={{ marginBottom: 0 }}>
          Secrets <StatusBadge status={badgeStatus} label={badgeLabel} />
        </h2>
        <span style={{ color: '#99a', fontSize: '0.8rem' }}>{'›'}</span>
      </div>
      <div style={{ fontSize: '0.85rem', color: '#aaa' }}>{detail}</div>
    </div>
  );
}
