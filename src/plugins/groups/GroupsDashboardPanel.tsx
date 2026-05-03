import { useState, useEffect } from 'preact/hooks';
import type { Group } from '../types';

// ── GroupsDashboardPanel ──────────────────────────────────────────────────────
// A high-level dashboard view over every configured group (project).
// Each group is represented by a summary card. Stats and detail will be
// added incrementally — the component is deliberately minimal for now.

export function GroupsDashboardPanel() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    window.jarvis.groupsList()
      .then((list) => setGroups(list))
      .catch((err: unknown) => console.error('[GroupsDashboard] Failed to load groups:', err))
      .finally(() => setLoading(false));
  }, []);

  const handleRefresh = () => {
    setLoading(true);
    window.jarvis.groupsList()
      .then((list) => setGroups(list))
      .catch((err: unknown) => console.error('[GroupsDashboard] Failed to reload groups:', err))
      .finally(() => setLoading(false));
  };

  return (
    <div class="groups-dashboard-panel">
      <div class="groups-dash-header">
        <h2>📁 Groups Dashboard</h2>
        <button
          class="dash-refresh-btn"
          onClick={handleRefresh}
          disabled={loading}
          title="Refresh"
        >
          <svg
            class={loading ? 'dash-refresh-icon dash-refresh-icon--spinning' : 'dash-refresh-icon'}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
            stroke-linecap="round" stroke-linejoin="round"
          >
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {loading && groups.length === 0 && (
        <div class="dash-loading">Loading groups…</div>
      )}

      {!loading && groups.length === 0 && (
        <div class="dash-empty">
          No groups configured yet. Add groups in the <strong>Setup → Groups</strong> tab.
        </div>
      )}

      {groups.length > 0 && (
        <div class="groups-dash-grid">
          {groups.map((group) => (
            <GroupCard key={group.id} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── GroupCard ─────────────────────────────────────────────────────────────────

function GroupCard({ group }: { group: Group }) {
  return (
    <div class="groups-dash-card">
      <div class="groups-dash-card-name">{group.name}</div>
      <div class="groups-dash-card-stats">
        <span class="groups-dash-stat" title="Local repositories">
          <span class="groups-dash-stat-icon">💻</span>
          <span class="groups-dash-stat-value">{group.localRepoCount}</span>
          <span class="groups-dash-stat-label">local repo{group.localRepoCount !== 1 ? 's' : ''}</span>
        </span>
        <span class="groups-dash-stat" title="GitHub repositories">
          <span class="groups-dash-stat-icon">🐙</span>
          <span class="groups-dash-stat-value">{group.githubRepoCount}</span>
          <span class="groups-dash-stat-label">GitHub repo{group.githubRepoCount !== 1 ? 's' : ''}</span>
        </span>
      </div>
    </div>
  );
}
