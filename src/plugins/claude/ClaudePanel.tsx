import type { ClaudeStatus, ClaudeRateLimit, ClaudeRateLimitWindow } from '../types';
import { formatDurationUntil } from '../shared/utils';

interface ClaudePanelProps {
  status: ClaudeStatus;
  rateLimit: ClaudeRateLimit | null;
  refreshing: boolean;
  onRefresh: () => void;
  onDisconnect: () => void;
  onClose: () => void;
}

function WindowRow({ label, win }: { label: string; win: ClaudeRateLimitWindow | null }) {
  if (!win) {
    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: '#99aabb', marginBottom: '0.35rem' }}>
        <span>{label}</span>
        <span style={{ color: '#667' }}>no data</span>
      </div>
    );
  }
  const pct = win.utilization !== null ? Math.round(win.utilization * 100) : null;
  const color = win.limited ? '#f44336' : pct !== null && pct >= 80 ? '#ff9800' : '#4caf50';
  return (
    <div style={{ marginBottom: '0.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: '#99aabb' }}>
        <span>{label}</span>
        <span style={{ color, fontWeight: 600 }}>
          {win.limited ? 'exhausted' : pct !== null ? `${pct}% used` : 'ok'}
        </span>
      </div>
      {win.reset !== null && (
        <div style={{ fontSize: '0.75rem', color: '#667' }}>
          {formatDurationUntil(win.reset)} · {new Date(win.reset * 1000).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

export function ClaudePanel({ status, rateLimit, refreshing, onRefresh, onDisconnect, onClose }: ClaudePanelProps) {
  const plan = status.subscriptionType ?? 'unknown plan';
  return (
    <div class="org-panel ollama-panel">
      <div class="org-panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Claude AI</span>
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>
      <div style={{ fontSize: '0.82rem', color: '#99aabb', marginBottom: '0.75rem' }}>
        Subscription: <code style={{ background: '#0f3460', padding: '0.1rem 0.4rem', borderRadius: '3px' }}>{plan}</code>
        {' '}via Claude Code credentials
      </div>

      {rateLimit?.error && (
        <div style={{ fontSize: '0.8rem', color: '#ff9800', marginBottom: '0.6rem' }}>
          Last check failed: {rateLimit.error}
        </div>
      )}

      {rateLimit?.limited && (
        <div style={{ fontSize: '0.85rem', color: '#f44336', fontWeight: 600, marginBottom: '0.6rem' }}>
          ⏳ Rate limited{rateLimit.resetAt !== null ? ` — ${formatDurationUntil(rateLimit.resetAt)}` : ''}
        </div>
      )}

      <WindowRow label="5-hour window" win={rateLimit?.fiveHour ?? null} />
      <WindowRow label="7-day window" win={rateLimit?.sevenDay ?? null} />

      {rateLimit?.fetchedAt && (
        <div style={{ fontSize: '0.72rem', color: '#556', marginBottom: '0.75rem' }}>
          Last checked {new Date(rateLimit.fetchedAt).toLocaleTimeString()}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          style={{ fontSize: '0.78rem', padding: '0.25rem 0.75rem', background: '#0f3460', color: '#7ab3ff', border: '1px solid #2b5c9e', borderRadius: '5px', cursor: 'pointer' }}
          disabled={refreshing}
          onClick={onRefresh}
        >
          {refreshing ? 'Checking…' : '↻ Check now'}
        </button>
        <button
          style={{ fontSize: '0.78rem', padding: '0.25rem 0.75rem', background: '#3d0a0a', color: '#ff8080', border: '1px solid #8a2b2b', borderRadius: '5px', cursor: 'pointer' }}
          title="Clear the cached token Jarvis keeps for refreshes. Claude Code's own credentials are not touched."
          onClick={onDisconnect}
        >
          Forget cached token
        </button>
      </div>
    </div>
  );
}
