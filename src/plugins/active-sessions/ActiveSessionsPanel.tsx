// ── Agent sessions view ───────────────────────────────────────────────────────
// Shows every running Copilot / Claude session (local or cloud), the PR it is
// working on, and traffic lights for the stages that gate human review:
//   Agent (informational) · Checks · Copilot review  →  verdict
import { useEffect, useState } from 'preact/hooks';
import type {
  ActiveSessionEntry,
  ActiveSessionSourceStatus,
  ActiveSessionsSnapshot,
  AgentProvider,
  LocalSessionUsage,
  ReadinessStage,
} from '../types';
import type { CloudTaskSession } from '../../services/copilot-agent-tasks';
import { isIpcError } from '../types';
import { ClaudeIcon, CopilotIcon } from '../shared/BrandIcons';

function ProviderIcon({ provider }: { provider: AgentProvider }) {
  if (provider === 'claude') {
    return (
      <span class="as-provider as-provider--claude" title="Claude Code">
        <ClaudeIcon size={18} />
      </span>
    );
  }
  return (
    <span class="as-provider as-provider--copilot" title="GitHub Copilot">
      <CopilotIcon size={18} />
    </span>
  );
}

function Light({ name, stage }: { name: string; stage: ReadinessStage }) {
  return (
    <div class={`as-light as-light--${stage.light}${stage.blocking ? ' as-light--blocking' : ''}`} title={`${name}: ${stage.detail}`}>
      <span class="as-light-dot" />
      <span class="as-light-text">
        <span class="as-light-name">{name}</span>
        <span class="as-light-label">{stage.label}</span>
      </span>
    </div>
  );
}

const NO_PR_STAGE: ReadinessStage = { light: 'grey', label: '—', detail: 'No pull request linked yet.', blocking: false };

function formatCredits(usage: CloudTaskSession['usage']): string | null {
  if (!usage) return null;
  if (usage.kind === 'premium_requests') {
    return `${usage.amount % 1 === 0 ? usage.amount : usage.amount.toFixed(1)} premium req`;
  }
  return formatCreditAmount(usage.amount);
}

function formatCreditAmount(amount: number): string {
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(2)} credits`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** Chip text for a local session: exact Copilot credits, otherwise an estimated dollar cost. */
function formatLocalUsage(usage: LocalSessionUsage): { label: string; title: string } {
  const model = usage.primaryModel ?? 'session';
  const more = usage.models.length > 1 ? ` +${usage.models.length - 1}` : '';
  const tokens = `${formatTokens(usage.totalTokens)} tokens`;
  const models = usage.models.join(', ') || 'unknown model';
  if (usage.credits !== null) {
    return {
      label: `${model}${more} · ${formatCreditAmount(usage.credits)}`,
      title: `Billed so far (from the local session log): ${formatCreditAmount(usage.credits)}, ${tokens}
Models: ${models}`,
    };
  }
  const usd = usage.estimatedUsd >= 10 ? usage.estimatedUsd.toFixed(0) : usage.estimatedUsd.toFixed(2);
  return {
    label: `${model}${more} · ~$${usd}`,
    title: `Estimated at API rates from ${tokens} — not a bill
Models: ${models}`,
  };
}

/** "14:32" for today, "Yesterday 14:32" / "Mon 14:32" / "12 Sep 14:32" otherwise. */
function formatLastActive(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

function openUrl(url: string) {
  void window.jarvis.openUrl(url);
}

function SessionRow({ entry }: { entry: ActiveSessionEntry }) {
  const { session, pr } = entry;
  const folder = session.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? null;
  const title = session.title ?? pr?.title ?? folder ?? session.sessionId.slice(0, 8);

  return (
    <div class={`as-row as-row--${entry.verdict}`}>
      <ProviderIcon provider={session.provider} />
      <div class="as-row-main">
        <div class="as-row-title" title={title}>{title}</div>
        <div class="as-row-meta">
          <span class={`as-chip as-chip--${session.origin}`}>{session.origin === 'cloud' ? '☁ Cloud' : '🖥 Local'}</span>
          <span class="as-row-client">{session.client}</span>
          {session.repoFullName && <span class="as-row-repo">{session.repoFullName}</span>}
          {session.branch && <span class="as-row-branch" title="Branch">⎇ {session.branch}</span>}
          {session.branch && session.branchPushed === false && !pr && (
            <span class="as-chip as-chip--unpushed" title="This branch only exists locally — it has not been pushed to any remote yet.">
              ⚠ Not pushed
            </span>
          )}
          {(session.cloudSessions ?? []).slice(0, 3).map((cs, i) => (
            <span key={i} class="as-chip as-chip--model" title={`Copilot cloud agent session: ${cs.model ?? 'unknown model'}`}>
              {cs.model ?? 'session'}{formatCredits(cs.usage) ? ` · ${formatCredits(cs.usage)}` : ''}
            </span>
          ))}
          {session.localUsage && (() => {
            const { label, title } = formatLocalUsage(session.localUsage);
            return <span class="as-chip as-chip--model" title={title}>{label}</span>;
          })()}
          {(session.cloudSessions?.length ?? 0) > 3 && (
            <span class="as-chip as-chip--model" title={`${session.cloudSessions!.length} Copilot cloud agent sessions`}>
              +{session.cloudSessions!.length - 3} more
            </span>
          )}
          {session.updatedAt && (
            <span class="as-row-active" title={`Last active ${new Date(session.updatedAt).toLocaleString()}`}>
              🕒 {formatLastActive(session.updatedAt)}
            </span>
          )}
          {pr && (
            <button class="as-pr-link" title={`Open ${pr.url}`} onClick={() => openUrl(pr.url)}>
              #{pr.prNumber}
            </button>
          )}
          {pr?.isDraft && <span class="as-chip as-chip--draft">Draft</span>}
          {entry.prAccount && (
            <span class="as-chip as-chip--account" title={`PR checked as @${entry.prAccount} — the account assigned to this repo or its owner (Settings → GitHub Accounts)`}>
              as @{entry.prAccount}
            </span>
          )}
        </div>
        {entry.prError && <div class="as-row-error" title={entry.prError}>PR lookup failed: {entry.prError}</div>}
      </div>
      <div class="as-lights">
        <Light name="Agent" stage={entry.agent} />
        <Light name="Checks" stage={pr?.checks ?? NO_PR_STAGE} />
        <Light name="Copilot review" stage={pr?.copilotReview ?? NO_PR_STAGE} />
      </div>
      <div class={`as-verdict as-verdict--${entry.verdict}`}>{entry.verdictLabel}</div>
    </div>
  );
}

type SourceKey = keyof ActiveSessionsSnapshot['sources'];
type SourceFilter = 'all' | SourceKey;

const SOURCES: Array<{ key: SourceKey; label: string; description: string }> = [
  { key: 'copilotLocal', label: 'Copilot local', description: 'Running Copilot CLI / app sessions on this machine (~/.copilot/session-state).' },
  { key: 'claudeLocal', label: 'Claude local', description: 'Running Claude Code sessions on this machine (~/.claude/sessions).' },
  { key: 'copilotCloud', label: 'Copilot cloud', description: 'Your Copilot cloud agent tasks from the GitHub agent tasks API (last 24h).' },
];

function sourceOf(entry: ActiveSessionEntry): SourceKey {
  if (entry.session.origin === 'cloud') return 'copilotCloud';
  return entry.session.provider === 'claude' ? 'claudeLocal' : 'copilotLocal';
}

function sourceTooltip(description: string, s: ActiveSessionSourceStatus): string {
  const lines = [description];
  if (s.skipped) lines.push(`Skipped${s.error ? `: ${s.error}` : ''}`);
  else if (!s.ok) lines.push(`Error: ${s.error ?? 'unknown'}`);
  if (s.hidden) lines.push(`${s.hidden} finished task(s) hidden because their PR was closed without merging.`);
  return lines.join('\n');
}

function SourcePills({ snapshot, entries, filter, onChange, showMerged, mergedCount, onToggleMerged }: {
  snapshot: ActiveSessionsSnapshot;
  /** Entries that pass the merged filter; the pill counts are based on these. */
  entries: ActiveSessionEntry[];
  filter: SourceFilter;
  onChange: (f: SourceFilter) => void;
  showMerged: boolean;
  mergedCount: number;
  onToggleMerged: () => void;
}) {
  const counts: Record<SourceKey, number> = { copilotLocal: 0, claudeLocal: 0, copilotCloud: 0 };
  for (const entry of entries) counts[sourceOf(entry)]++;

  return (
    <div class="as-pills" role="group" aria-label="Filter by source">
      <button
        class={`as-pill${filter === 'all' ? ' as-pill--active' : ''}`}
        aria-pressed={filter === 'all'}
        onClick={() => onChange('all')}
      >
        All <span class="as-pill-count">{entries.length}</span>
      </button>
      {SOURCES.map(({ key, label, description }) => {
        const status = snapshot.sources[key];
        const state = status.skipped ? ' as-pill--skipped' : !status.ok ? ' as-pill--error' : '';
        const active = filter === key;
        return (
          <button
            key={key}
            class={`as-pill${active ? ' as-pill--active' : ''}${state}`}
            aria-pressed={active}
            title={sourceTooltip(description, status)}
            onClick={() => onChange(active ? 'all' : key)}
          >
            {label}{' '}
            <span class="as-pill-count">
              {status.skipped ? 'off' : !status.ok ? '!' : counts[key]}
            </span>
            {status.hidden ? <span class="as-pill-hidden">+{status.hidden} hidden</span> : null}
          </button>
        );
      })}
      <button
        class={`as-pill as-pill--merged${showMerged ? ' as-pill--active' : ''}`}
        aria-pressed={showMerged}
        title={showMerged ? 'Showing sessions whose PR is merged — click to hide them.' : 'Sessions whose PR is merged are hidden — click to show them.'}
        onClick={onToggleMerged}
      >
        Merged <span class="as-pill-count">{mergedCount}</span>
      </button>
    </div>
  );
}

export function ActiveSessionsPanel() {
  const [snapshot, setSnapshot] = useState<ActiveSessionsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SourceFilter>('all');
  const [showMerged, setShowMerged] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const result = await window.jarvis.refreshActiveSessions();
      if (isIpcError(result)) {
        setError(result.error);
      } else {
        setSnapshot(result);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.jarvis.onActiveSessionsUpdated((s) => {
      if (!cancelled) setSnapshot(s);
    });
    window.jarvis.getActiveSessions()
      .then((cached) => {
        if (cancelled) return;
        if (cached && !isIpcError(cached)) {
          setSnapshot(cached);
          setLoading(false);
        } else {
          void refresh();
        }
      })
      .catch((err: unknown) => {
        console.error('[ActiveSessions] Failed to load snapshot:', err);
        void refresh();
      });
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  const sourceErrors = snapshot
    ? Object.entries(snapshot.sources).filter(([, s]) => !s.ok && s.error).map(([name, s]) => `${name}: ${s.error}`)
    : [];
  const mergedCount = snapshot ? snapshot.entries.filter((e) => e.verdict === 'merged').length : 0;
  const listed = snapshot ? snapshot.entries.filter((e) => showMerged || e.verdict !== 'merged') : [];
  const visible = listed.filter((e) => filter === 'all' || sourceOf(e) === filter);

  return (
    <div class="adh-panel as-panel">
      <div class="adh-header">
        <div class="adh-header-left">
          <span class="adh-title">Agent Sessions</span>
          {snapshot && (
            <span class="adh-subtitle">
              {listed.length} active · {snapshot.readyCount} ready for review · updated {new Date(snapshot.refreshedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        <div class="adh-header-right">
          <button class="adh-tab" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? 'Checking…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      <div class="as-legend">
        A PR is <strong>ready for review</strong> once every check on its latest commit has finished and, when a
        Copilot code review is attached, Copilot has reviewed that latest commit.
      </div>

      {snapshot && (
        <SourcePills
          snapshot={snapshot}
          entries={listed}
          filter={filter}
          onChange={setFilter}
          showMerged={showMerged}
          mergedCount={mergedCount}
          onToggleMerged={() => setShowMerged((v) => !v)}
        />
      )}

      {error && <div class="as-error">Refresh failed: {error}</div>}
      {sourceErrors.map((e) => <div key={e} class="as-error">{e}</div>)}

      {loading ? (
        <div class="adh-loading">Looking for active sessions…</div>
      ) : !snapshot || snapshot.entries.length === 0 ? (
        <div class="adh-empty">No active Copilot or Claude sessions found.</div>
      ) : visible.length === 0 ? (
        <div class="adh-empty">
          {listed.length === 0 && mergedCount > 0
            ? `No open sessions — ${mergedCount} merged hidden.`
            : 'No sessions from this source right now.'}
        </div>
      ) : (
        <div class="as-list">
          {visible.map((entry) => <SessionRow key={entry.session.key} entry={entry} />)}
        </div>
      )}

    </div>
  );
}
