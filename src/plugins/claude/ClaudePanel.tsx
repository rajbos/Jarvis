import { useState } from 'preact/hooks';
import type { ClaudeStatus, ClaudeRateLimit, ClaudeRateLimitWindow, ClaudeCloudCredits, ClaudeExtraUsage } from '../types';
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

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function CloudCreditsRow({ credits }: { credits: ClaudeCloudCredits }) {
  const { remaining, total, currency, expiresAt } = credits;
  const leftFraction = remaining !== null && total !== null && total > 0 ? remaining / total : null;
  const color = leftFraction === null ? '#99aabb' : leftFraction <= 0.1 ? '#f44336' : leftFraction <= 0.25 ? '#ff9800' : '#4caf50';
  const value =
    remaining !== null && total !== null
      ? `${formatMoney(remaining, currency)} of ${formatMoney(total, currency)} left`
      : remaining !== null
        ? `${formatMoney(remaining, currency)} left`
        : `${formatMoney(total as number, currency)} granted`;
  return (
    <div style={{ marginBottom: '0.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: '#99aabb' }}>
        <span>Cloud session credits</span>
        <span style={{ color, fontWeight: 600 }}>{value}</span>
      </div>
      {expiresAt !== null && (
        <div style={{ fontSize: '0.75rem', color: '#667' }}>
          Expires {new Date(expiresAt * 1000).toLocaleString()}
        </div>
      )}
    </div>
  );
}

function ExtraUsageRow({ extra }: { extra: ClaudeExtraUsage }) {
  if (!extra.enabled && extra.used === null) return null;
  const used = extra.used !== null ? formatMoney(extra.used, extra.currency) : '—';
  const value = extra.monthlyLimit !== null ? `${used} of ${formatMoney(extra.monthlyLimit, extra.currency)}` : `${used} used`;
  const pct = extra.utilization !== null ? Math.round(extra.utilization * 100) : null;
  const color = !extra.enabled ? '#667' : pct !== null && pct >= 100 ? '#f44336' : pct !== null && pct >= 80 ? '#ff9800' : '#99aabb';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: '#99aabb', marginBottom: '0.5rem' }}>
      <span>Extra usage{extra.enabled ? '' : ' (off)'}</span>
      <span style={{ color, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

export function ClaudePanel({ status, rateLimit, refreshing, onRefresh, onDisconnect, onClose }: ClaudePanelProps) {
  const [oauthPending, setOauthPending] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const handleConnect = async () => {
    setBusy(true);
    setOauthError(null);
    try {
      const result = await window.jarvis.beginClaudeOAuth();
      if (result.ok) {
        setOauthPending(true);
      } else {
        setOauthError(result.error ?? 'Could not start sign-in');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleComplete = async () => {
    setBusy(true);
    setOauthError(null);
    try {
      const result = await window.jarvis.completeClaudeOAuth(code);
      if (result.ok) {
        setOauthPending(false);
        setCode('');
        onRefresh();
      } else {
        setOauthError(result.error ?? 'Sign-in failed');
      }
    } finally {
      setBusy(false);
    }
  };

  if (!status.connected) {
    return (
      <div class="org-panel ollama-panel">
        <div class="org-panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Claude AI</span>
          <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
        </div>
        {status.error && (
          <div style={{ fontSize: '0.82rem', color: '#99aabb', marginBottom: '0.75rem' }}>{status.error}</div>
        )}
        {oauthError && (
          <div style={{ fontSize: '0.8rem', color: '#ff8080', marginBottom: '0.6rem' }}>{oauthError}</div>
        )}
        {!oauthPending ? (
          <button
            style={{ fontSize: '0.82rem', padding: '0.4rem 1rem', background: '#0a3d1f', color: '#51cf66', border: '1px solid #2b8a3e', borderRadius: '5px', cursor: 'pointer' }}
            disabled={busy}
            onClick={() => void handleConnect()}
          >
            {busy ? 'Opening browser…' : 'Sign in with Claude'}
          </button>
        ) : (
          <div>
            <div style={{ fontSize: '0.82rem', color: '#99aabb', marginBottom: '0.5rem' }}>
              A browser tab was opened. Authorize Jarvis, then paste the code shown on the confirmation page:
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type="text"
                value={code}
                placeholder="Paste code here"
                style={{ flex: 1, fontSize: '0.82rem', padding: '0.35rem 0.5rem', background: '#0f3460', color: '#dde', border: '1px solid #2b5c9e', borderRadius: '5px' }}
                onInput={(e) => setCode((e.target as HTMLInputElement).value)}
              />
              <button
                style={{ fontSize: '0.82rem', padding: '0.35rem 0.9rem', background: '#0a3d1f', color: '#51cf66', border: '1px solid #2b8a3e', borderRadius: '5px', cursor: 'pointer' }}
                disabled={busy || !code.trim()}
                onClick={() => void handleComplete()}
              >
                {busy ? 'Verifying…' : 'Connect'}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const plan = status.subscriptionType ?? 'unknown plan';
  return (
    <div class="org-panel ollama-panel">
      <div class="org-panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Claude AI</span>
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>
      <div style={{ fontSize: '0.82rem', color: '#99aabb', marginBottom: '0.75rem' }}>
        Subscription: <code style={{ background: '#0f3460', padding: '0.1rem 0.4rem', borderRadius: '3px' }}>{plan}</code>
        {' '}{status.source === 'stored' ? 'via Jarvis sign-in' : 'via Claude Code credentials'}
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
      {rateLimit?.cloudCredits && <CloudCreditsRow credits={rateLimit.cloudCredits} />}
      {rateLimit?.extraUsage && <ExtraUsageRow extra={rateLimit.extraUsage} />}

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
