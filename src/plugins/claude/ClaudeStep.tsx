import { StatusBadge } from '../shared/StatusBadge';
import type { ClaudeStatus, ClaudeRateLimit } from '../types';

interface ClaudeStepProps {
  status: ClaudeStatus | null;
  rateLimit: ClaudeRateLimit | null;
  onToggle: () => void;
}

export function ClaudeStep({ status, rateLimit, onToggle }: ClaudeStepProps) {
  let badgeStatus: 'pending' | 'completed' | 'in-progress' = 'in-progress';
  let badgeLabel = 'Checking...';
  let detail = 'Looking for Claude Code credentials…';

  if (status !== null) {
    if (status.connected) {
      const plan = status.subscriptionType ? ` (${status.subscriptionType})` : '';
      if (rateLimit?.limited) {
        badgeStatus = 'pending';
        badgeLabel = 'Rate limited';
        detail = 'Claude usage limit reached — see the ticker below for the reset time.';
      } else {
        badgeStatus = 'completed';
        badgeLabel = 'Connected';
        detail = `Using your Claude${plan} account via Claude Code credentials — click for rate limit details`;
      }
    } else {
      badgeStatus = 'pending';
      badgeLabel = 'Not connected';
      detail = 'Click to sign in with your Claude account.';
    }
  }

  return (
    <div
      class="step ollama-step-clickable"
      id="claude-step"
      onClick={status !== null ? onToggle : undefined}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
        <h2 style={{ marginBottom: 0 }}>
          Claude AI <StatusBadge status={badgeStatus} label={badgeLabel} />
        </h2>
        {status !== null && (
          <span style={{ color: '#99a', fontSize: '0.8rem' }}>{'›'}</span>
        )}
      </div>
      <div style={{ fontSize: '0.85rem', color: '#aaa' }}>{detail}</div>
    </div>
  );
}
