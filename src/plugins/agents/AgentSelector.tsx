// ── Agent Selector Modal ──────────────────────────────────────────────────────
import { useState, useEffect } from 'preact/hooks';
import type { AgentDefinition } from '../types';
import { relativeAge } from '../shared/utils';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface AgentSelectorProps {
  repoFullName: string;
  workflowFilter?: string;
  onClose: () => void;
  onSessionStarted: (sessionId: number) => void;
}

export function AgentSelector({ repoFullName, workflowFilter, onClose, onSessionStarted }: AgentSelectorProps) {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchingWorkflows, setFetchingWorkflows] = useState(false);
  const [cachedInfo, setCachedInfo] = useState<{ fetchedAt: string | null; runCount: number } | null>(null);
  const [cacheLoading, setCacheLoading] = useState(true);

  useEffect(() => {
    window.jarvis.agentsList()
      .then((defs) => {
        setAgents(defs);
        if (defs.length > 0) setSelectedId(defs[0].id);
      })
      .catch(() => setError('Could not load agent definitions'))
      .finally(() => setLoading(false));

    window.jarvis.githubGetCachedWorkflowInfo(repoFullName)
      .then(setCachedInfo)
      .catch(() => setCachedInfo({ fetchedAt: null, runCount: 0 }))
      .finally(() => setCacheLoading(false));
  }, [repoFullName]);

  const cacheAgeMs = cachedInfo?.fetchedAt
    ? Date.now() - new Date(cachedInfo.fetchedAt).getTime()
    : null;
  const isFresh = cacheAgeMs !== null && cacheAgeMs < ONE_DAY_MS;
  const hasCache = (cachedInfo?.runCount ?? 0) > 0;

  const refreshCachedInfo = () =>
    window.jarvis.githubGetCachedWorkflowInfo(repoFullName)
      .then(setCachedInfo)
      .catch(() => {/* non-fatal */});

  const handleFetchWorkflows = async () => {
    setFetchingWorkflows(true);
    setError(null);
    try {
      const result = await window.jarvis.githubFetchWorkflowRuns(repoFullName);
      if (result.error) {
        setError(result.error);
      } else {
        await refreshCachedInfo();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetchingWorkflows(false);
    }
  };

  const handleStart = async () => {
    if (!selectedId) return;
    setRunning(true);
    setError(null);
    try {
      const result = await window.jarvis.agentsRun(selectedId, 'repo', repoFullName, workflowFilter);
      if (result.error) {
        setError(result.error);
        setRunning(false);
      } else {
        onSessionStarted(result.sessionId);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  };

  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;

  const renderWorkflowSection = () => {
    if (cacheLoading) {
      return (
        <div class="agent-workflow-fetch">
          <p class="agent-workflow-hint">Checking for cached workflow data…</p>
        </div>
      );
    }

    if (!hasCache) {
      return (
        <div class="agent-workflow-fetch">
          <p class="agent-workflow-hint">
            No cached workflow data. Fetch first to enable analysis.
          </p>
          <button
            class="agent-fetch-btn"
            onClick={() => void handleFetchWorkflows()}
            disabled={fetchingWorkflows || running}
          >
            {fetchingWorkflows ? 'Fetching…' : 'Fetch workflow data'}
          </button>
        </div>
      );
    }

    if (!isFresh) {
      return (
        <div class="agent-workflow-fetch">
          <p class="agent-workflow-hint agent-workflow-stale">
            {'⚠️ Cached data is outdated (fetched '}
            {relativeAge(cachedInfo!.fetchedAt!)}
            {', '}
            {cachedInfo!.runCount}
            {cachedInfo!.runCount === 1 ? ' run' : ' runs'}
            {'). Fetch fresh data to continue.'}
          </p>
          <button
            class="agent-fetch-btn"
            onClick={() => void handleFetchWorkflows()}
            disabled={fetchingWorkflows || running}
          >
            {fetchingWorkflows ? 'Fetching…' : 'Refresh workflow data'}
          </button>
        </div>
      );
    }

    // Fresh cache available
    return (
      <div class="agent-workflow-fetch">
        <p class="agent-workflow-hint agent-workflow-fresh">
          {'✓ '}
          {cachedInfo!.runCount}
          {cachedInfo!.runCount === 1 ? ' run' : ' runs'}
          {' cached · fetched '}
          {relativeAge(cachedInfo!.fetchedAt!)}
        </p>
        <button
          class="agent-fetch-btn"
          onClick={() => void handleFetchWorkflows()}
          disabled={fetchingWorkflows || running}
        >
          {fetchingWorkflows ? 'Fetching…' : 'Refresh workflow data'}
        </button>
      </div>
    );
  };

  return (
    <div class="agent-selector-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="agent-selector-modal">
        <div class="agent-selector-header">
          <span class="agent-selector-title">{'🤖 Run Agent Analysis'}</span>
          <button class="agent-selector-close" onClick={onClose} title="Cancel">{'✕'}</button>
        </div>

        <div class="agent-selector-scope">
          <span class="agent-scope-label">Repository:</span>
          <span class="agent-scope-value">{repoFullName}</span>
        </div>
        {workflowFilter && (
          <div class="agent-selector-scope">
            <span class="agent-scope-label">Workflow:</span>
            <span class="agent-scope-value agent-scope-workflow">{workflowFilter}</span>
          </div>
        )}

        {loading ? (
          <p class="agent-selector-loading">Loading agents…</p>
        ) : agents.length === 0 ? (
          <p class="agent-selector-empty">No agent definitions found.</p>
        ) : (
          <>
            <div class="agent-selector-field">
              <label class="agent-selector-label" htmlFor="agent-select">Agent:</label>
              <select
                id="agent-select"
                class="agent-selector-select"
                value={selectedId ?? ''}
                onChange={(e) => setSelectedId(Number((e.target as HTMLSelectElement).value))}
                disabled={running}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>

            {selectedAgent && (
              <p class="agent-selector-description">{selectedAgent.description}</p>
            )}

            {renderWorkflowSection()}
          </>
        )}

        {error && <p class="agent-selector-error">{error}</p>}

        <div class="agent-selector-actions">
          <button class="agent-cancel-btn" onClick={onClose} disabled={running}>
            Cancel
          </button>
          <button
            class="agent-start-btn"
            onClick={() => void handleStart()}
            disabled={running || loading || !selectedId || !isFresh}
            title={!isFresh ? 'Fetch workflow data first' : undefined}
          >
            {running ? 'Starting…' : 'Start Analysis'}
          </button>
        </div>
      </div>
    </div>
  );
}

