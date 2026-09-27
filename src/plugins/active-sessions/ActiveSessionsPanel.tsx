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
  ReadinessStage,
} from '../types';
import { isIpcError } from '../types';

function ProviderIcon({ provider }: { provider: AgentProvider }) {
  if (provider === 'claude') {
    return (
      <span class="as-provider as-provider--claude" title="Claude Code">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2zm6.5 12l.8 2.7 2.7.8-2.7.8-.8 2.7-.8-2.7-2.7-.8 2.7-.8.8-2.7z"
          />
        </svg>
      </span>
    );
  }
  return (
    <span class="as-provider as-provider--copilot" title="GitHub Copilot">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 3C7.6 3 4.4 5 4.1 8.6 2.8 9 2 10.2 2 11.6v2.2c0 1.2.6 2.3 1.6 2.8C5 19.4 8.2 21 12 21s7-1.6 8.4-4.4c1-.5 1.6-1.6 1.6-2.8v-2.2c0-1.4-.8-2.6-2.1-3C19.6 5 16.4 3 12 3zm-3.5 7.5c1.1 0 2 .9 2 2v1.5c0 1.1-.9 2-2 2s-2-.9-2-2v-1.5c0-1.1.9-2 2-2zm7 0c1.1 0 2 .9 2 2v1.5c0 1.1-.9 2-2 2s-2-.9-2-2v-1.5c0-1.1.9-2 2-2z"
        />
      </svg>
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
          {pr && (
            <button class="as-pr-link" title={`Open ${pr.url}`} onClick={() => openUrl(pr.url)}>
              #{pr.prNumber}
            </button>
          )}
          {pr?.isDraft && <span class="as-chip as-chip--draft">Draft</span>}
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

function sourceLabel(name: string, s: ActiveSessionSourceStatus): string {
  if (s.skipped) return `${name}: skipped${s.error ? ` (${s.error})` : ''}`;
  if (!s.ok) return `${name}: error`;
  return `${name}: ${s.count}`;
}

export function ActiveSessionsPanel() {
  const [snapshot, setSnapshot] = useState<ActiveSessionsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div class="adh-panel as-panel">
      <div class="adh-header">
        <div class="adh-header-left">
          <span class="adh-title">Agent Sessions</span>
          {snapshot && (
            <span class="adh-subtitle">
              {snapshot.entries.length} active · {snapshot.readyCount} ready for review · updated {new Date(snapshot.refreshedAt).toLocaleTimeString()}
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

      {error && <div class="as-error">Refresh failed: {error}</div>}
      {sourceErrors.map((e) => <div key={e} class="as-error">{e}</div>)}

      {loading ? (
        <div class="adh-loading">Looking for active sessions…</div>
      ) : !snapshot || snapshot.entries.length === 0 ? (
        <div class="adh-empty">No active Copilot or Claude sessions found.</div>
      ) : (
        <div class="as-list">
          {snapshot.entries.map((entry) => <SessionRow key={entry.session.key} entry={entry} />)}
        </div>
      )}

      {snapshot && (
        <div class="as-footer">
          {[
            sourceLabel('Copilot local', snapshot.sources.copilotLocal),
            sourceLabel('Claude local', snapshot.sources.claudeLocal),
            sourceLabel('Copilot cloud', snapshot.sources.copilotCloud),
          ].join(' · ')}
        </div>
      )}
    </div>
  );
}
