import { useEffect, useState } from 'preact/hooks';
import { IconButton } from '../shared/IconButton';
import type { PruneCandidate, PruneCandidates, PruneResultItem } from '../types';

interface BranchPrunePanelProps {
  repoName: string;
  repoPath: string;
  onClose: () => void;
}

const PRUNE_LOOKUP_NOTE: Record<PruneCandidates['prLookup'], string | null> = {
  ok: null,
  partial: 'Some pull requests could not be checked — those branches are kept.',
  unavailable: 'No GitHub account could check pull requests — only branches whose upstream is gone can be offered.',
  'no-github-remote': 'This repository has no GitHub remote — only branches whose upstream is gone can be offered.',
};

function errorOf(value: unknown): string | null {
  return value && typeof value === 'object' && 'ok' in value && (value as { ok: unknown }).ok === false
    ? String((value as { error?: unknown }).error ?? 'Unknown error')
    : null;
}

/** Cleanup candidates for one local repo: merged/closed branches and their idle worktrees. */
export function BranchPrunePanel({ repoName, repoPath, onClose }: BranchPrunePanelProps) {
  const [data, setData] = useState<PruneCandidates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Items awaiting confirmation: exactly what will be deleted.
  const [confirming, setConfirming] = useState<PruneCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<PruneResultItem[]>([]);
  const [showSkipped, setShowSkipped] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await window.jarvis.localGetPruneCandidates(repoPath);
      const err = errorOf(res);
      if (err) setError(err); else setData(res as PruneCandidates);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [repoPath]);

  async function runPrune(items: PruneCandidate[]) {
    setBusy(true);
    try {
      const res = await window.jarvis.localPrune(repoPath, items.map((c) => ({ branch: c.branch, sha: c.sha })));
      const err = errorOf(res);
      if (err) setError(err); else setResults((prev) => [...(res as { results: PruneResultItem[] }).results, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirming(null);
      setBusy(false);
      await load();
    }
  }

  const candidates = data?.candidates ?? [];
  const note = data ? PRUNE_LOOKUP_NOTE[data.prLookup] : null;

  return (
    <div class="repo-panel prune-panel" id="branch-prune-panel">
      <div class="repo-panel-header">
        <span class="repo-panel-title">Branch cleanup · {repoName}</span>
        <span style={{ flex: 1 }} />
        <IconButton icon={<>&#8635;</>} label="Rescan" onClick={() => void load()} disabled={loading || busy} />
        <IconButton icon={<>&times;</>} label="Close" onClick={onClose} />
      </div>
      <div style={{ color: '#8899aa', fontSize: '0.74rem', marginBottom: '0.5rem', wordBreak: 'break-all' }}>{repoPath}</div>

      {loading && <div style={{ color: '#99a', fontSize: '0.85rem' }}>Checking branches and worktrees…</div>}
      {error && <div style={{ color: '#ff8787', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{error}</div>}
      {note && <div style={{ color: '#ffd43b', fontSize: '0.78rem', marginBottom: '0.5rem' }}>{note}</div>}

      {confirming && (
        <div class="prune-confirm" style={{ border: '1px solid #ff6b6b', borderRadius: '6px', padding: '0.6rem', marginBottom: '0.6rem' }}>
          <div style={{ fontWeight: 600, marginBottom: '0.3rem' }}>
            Delete {confirming.length} branch{confirming.length === 1 ? '' : 'es'}?
          </div>
          <ul style={{ margin: '0 0 0.5rem 1rem', padding: 0, fontSize: '0.78rem', color: '#c8c8c8' }}>
            {confirming.map((c) => (
              <li key={c.id} style={{ wordBreak: 'break-all' }}>
                <code>{c.branch}</code> ({c.sha.slice(0, 7)})
                {c.worktreePath && <div style={{ color: '#8899aa' }}>+ remove worktree {c.worktreePath}</div>}
              </li>
            ))}
          </ul>
          <div style={{ fontSize: '0.74rem', color: '#8899aa', marginBottom: '0.5rem' }}>
            Their work is on GitHub; to restore one later run <code>git branch &lt;name&gt; &lt;sha&gt;</code>.
          </div>
          <button disabled={busy} onClick={() => void runPrune(confirming)}>{busy ? 'Deleting…' : `Delete ${confirming.length}`}</button>{' '}
          <button disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
        </div>
      )}

      {data && !loading && candidates.length === 0 && (
        <div style={{ color: '#99a', fontSize: '0.85rem' }}>Nothing to clean up.</div>
      )}

      {candidates.length > 1 && !confirming && (
        <div style={{ marginBottom: '0.5rem' }}>
          <button disabled={busy} onClick={() => setConfirming(candidates)}>Prune all ({candidates.length})…</button>
        </div>
      )}

      {candidates.map((c) => (
        <div key={c.id} class="repo-card prune-item" style={{ cursor: 'default' }}>
          <div class="repo-card-name" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{ flex: 1, wordBreak: 'break-all' }}>{c.branch}</span>
            <button disabled={busy || confirming !== null} onClick={() => setConfirming([c])}>Prune…</button>
          </div>
          <div class="repo-card-meta">
            <span class="repo-card-badge">{c.detail}</span>
            {c.worktreePath && <span class="repo-card-badge" title={c.worktreePath}>worktree</span>}
            {c.committedAt && <span class="repo-card-date">last commit {new Date(c.committedAt).toLocaleDateString()}</span>}
          </div>
          {c.worktreePath && <div style={{ color: '#8899aa', fontSize: '0.74rem', wordBreak: 'break-all' }}>{c.worktreePath}</div>}
        </div>
      ))}

      {results.length > 0 && (
        <div style={{ marginTop: '0.6rem', fontSize: '0.78rem' }}>
          {results.map((r) => (
            <div key={`${r.id}-${r.ok}`} style={{ color: r.ok ? '#69db7c' : '#ff8787', wordBreak: 'break-all' }}>
              {r.ok ? `Deleted ${r.branch} (${r.sha.slice(0, 7)})${r.worktreeRemoved ? ' and its worktree' : ''}` : `${r.branch}: ${r.error}`}
            </div>
          ))}
        </div>
      )}

      {data && data.skipped.length > 0 && (
        <div style={{ marginTop: '0.6rem' }}>
          <button class="btn-link" onClick={() => setShowSkipped(!showSkipped)}>
            {showSkipped ? 'Hide' : 'Show'} {data.skipped.length} kept branch{data.skipped.length === 1 ? '' : 'es'}
          </button>
          {showSkipped && (
            <ul style={{ margin: '0.3rem 0 0 1rem', padding: 0, fontSize: '0.76rem', color: '#8899aa' }}>
              {data.skipped.map((s) => (
                <li key={s.branch} style={{ wordBreak: 'break-all' }}><code>{s.branch}</code> — {s.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
