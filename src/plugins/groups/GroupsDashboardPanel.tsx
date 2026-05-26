/** @jsxImportSource preact */
import { useState, useEffect } from 'preact/hooks';
import type { Group, RuddrProjectMatch, RuddrBudget, RuddrProjectInfo } from '../types';
import { RuddrProjectsPanel } from './RuddrProjectsPanel';

// ── GroupsDashboardPanel ──────────────────────────────────────────────────────
// A high-level dashboard view over every configured group (project).
// Each group is represented by a summary card. Stats and detail will be
// added incrementally — the component is deliberately minimal for now.

export function GroupsDashboardPanel() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [ruddrVisible, setRuddrVisible] = useState(true);
  const [budgetData, setBudgetData] = useState<Record<string, RuddrBudget>>({});
  const [budgetChecking, setBudgetChecking] = useState<string | null>(null);
  const [newRuddrProjects, setNewRuddrProjects] = useState<Array<{ name: string; path: string }>>([]); 

  const loadData = async () => {
    setLoading(true);
    try {
      const [groupsList, budgetCache] = await Promise.all([
        window.jarvis.groupsList(),
        window.jarvis.groupsGetRuddrBudgetCache().catch(() => ({ ok: true, budgets: {} })),
      ]);
      setGroups(groupsList);
      const initialBudgets: Record<string, RuddrBudget> = budgetCache.ok ? budgetCache.budgets : {};
      setBudgetData(initialBudgets);

      // Auto-fetch budgets for linked projects that aren't in the cache yet
      const allProjectNames = groupsList.flatMap((g: Group) => g.ruddrProjectNames ?? []);
      const missing = allProjectNames.filter((n: string) => !initialBudgets[n]);
      for (const name of missing) {
        setBudgetChecking(name);
        try {
          const result = await window.jarvis.groupsGetRuddrBudget(name);
          setBudgetData((prev) => ({ ...prev, [name]: result }));
        } catch (err) {
          setBudgetData((prev) => ({
            ...prev,
            [name]: { ok: false, error: err instanceof Error ? err.message : String(err) },
          }));
        }
      }
      setBudgetChecking(null);
    } catch (err) {
      console.error('[GroupsDashboard] Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();

    // Auto-refresh budget data every 30 seconds
    const interval = setInterval(() => {
      window.jarvis.groupsGetRuddrBudgetCache()
        .catch(() => ({ ok: true, budgets: {} }))
        .then((budgetCache) => {
          if (budgetCache.ok) {
            setBudgetData(budgetCache.budgets);
          }
        });
    }, 30000);

    // Refresh when window regains focus
    const onFocus = () => {
      loadData();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  useEffect(() => {
    // Subscribe to new-project notifications pushed from main process
    const unsub = window.jarvis.onNewRuddrProjects((projects) => {
      setNewRuddrProjects((prev) => {
        const existing = new Set(prev.map((p) => p.path));
        const fresh = projects.filter((p) => !existing.has(p.path));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
    });
    return () => { unsub(); };
  }, []);

  const handleRefresh = async () => {
    // Sync the Ruddr project list first (detect new projects, persist to DB).
    // Also triggers refreshLinkedProjectDetails in the background for any projects
    // missing note or cloud folder URL.
    window.jarvis.groupsSyncRuddrCacheNow().catch(() => { /* non-fatal */ });
    // Show a fetching indicator on note/cloud folder fields while the background
    // scrape runs (cleared when the main process fires project-details-refreshed).
    setDetailsLoading(true);
    // Re-fetch budget for every currently linked Ruddr project across all cards.
    const allProjectNames = groups.flatMap((g) => g.ruddrProjectNames);
    if (allProjectNames.length === 0) return;
    setLoading(true);
    for (const name of allProjectNames) {
      setBudgetChecking(name);
      try {
        const result = await window.jarvis.groupsGetRuddrBudget(name);
        setBudgetData((prev) => ({ ...prev, [name]: result }));
      } catch (err) {
        setBudgetData((prev) => ({
          ...prev,
          [name]: { ok: false, error: err instanceof Error ? err.message : String(err) },
        }));
      }
    }
    setBudgetChecking(null);
    setLoading(false);
  };

  const handleRuddrLinked = (groupId: number, names: string[]) => {
    setGroups((prev) =>
      prev.map((g) => g.id === groupId ? { ...g, ruddrProjectNames: names } : g),
    );
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
        <button
          class="dash-toggle-ruddr-btn"
          onClick={() => setRuddrVisible((v) => !v)}
          title={ruddrVisible ? 'Hide Ruddr Projects panel' : 'Show Ruddr Projects panel'}
        >
          {ruddrVisible ? '◀ Ruddr' : '▶ Ruddr'}
        </button>
      </div>

      <div class="groups-dash-body">
        <div class="groups-dash-main">
          {/* ── New Ruddr project notification banners ── */}
          {newRuddrProjects.length > 0 && (
            <div class="groups-dash-new-projects">
              {newRuddrProjects.map((p) => {
                const editUrl = 'https://www.ruddr.io' + p.path.replace('/portfolio/projects/', '/portfolio/projects/edit/');
                return (
                  <div class="groups-dash-new-project-banner" key={p.path}>
                    <span class="groups-dash-new-project-icon">🆕</span>
                    <span class="groups-dash-new-project-name">{p.name}</span>
                    <button
                      class="groups-dash-new-project-edit"
                      onClick={() => void window.jarvis.shellOpenUrl(editUrl)}
                      title="Edit in Ruddr"
                    >Edit ↗</button>
                    <button
                      class="groups-dash-new-project-dismiss"
                      onClick={() => setNewRuddrProjects((prev) => prev.filter((x) => x.path !== p.path))}
                      title="Dismiss"
                    >✕</button>
                  </div>
                );
              })}
            </div>
          )}

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
                <GroupCard key={group.id} group={group} onRuddrLinked={handleRuddrLinked}
                  detailsLoading={detailsLoading}
                  budgetData={budgetData} setBudgetData={setBudgetData}
                  budgetChecking={budgetChecking} setBudgetChecking={setBudgetChecking} />
              ))}
            </div>
          )}
        </div>

        {ruddrVisible && <RuddrProjectsPanel onGroupCreated={loadData} />}
      </div>
    </div>
  );
}

// ── GroupCard ─────────────────────────────────────────────────────────────────

function GroupCard(props: {
  group: Group;
  onRuddrLinked: (groupId: number, names: string[]) => void;
  detailsLoading: boolean;
  budgetData: Record<string, RuddrBudget>;
  setBudgetData: (fn: (prev: Record<string, RuddrBudget>) => Record<string, RuddrBudget>) => void;
  budgetChecking: string | null;
  setBudgetChecking: (v: string | null) => void;
}) {
  const {
    group,
    onRuddrLinked,
    detailsLoading,
    budgetData,
    setBudgetData,
    budgetChecking,
    setBudgetChecking,
  } = props;
  const [ruddrSearching, setRuddrSearching] = useState(false);
  const [ruddrError, setRuddrError] = useState<string | null>(null);
  const [ruddrMatches, setRuddrMatches] = useState<RuddrProjectMatch[] | null>(null);
  const [ruddrLinking, setRuddrLinking] = useState<string | null>(null);
  const [ruddrNeedsLogin, setRuddrNeedsLogin] = useState(false);
  const [ruddrManualOpen, setRuddrManualOpen] = useState(false);
  const [ruddrManualFilter, setRuddrManualFilter] = useState('');
  const [ruddrAllProjects, setRuddrAllProjects] = useState<string[]>([]);
  /** allCount from the most recent search — used to detect thin caches. */
  const [ruddrLastCount, setRuddrLastCount] = useState(0);
  /** Per-project info (path, note) keyed by project name */
  const [projectInfo, setProjectInfo] = useState<Record<string, RuddrProjectInfo>>({});

  // Load project info for each linked Ruddr project
  useEffect(() => {
    const names = group.ruddrProjectNames ?? [];
    if (names.length === 0) return;
    for (const name of names) {
      if (projectInfo[name]) continue;
      window.jarvis.groupsGetRuddrProjectInfo(name)
        .then((res) => {
          if (res.ok && res.name) {
            setProjectInfo((prev) => ({
              ...prev,
              [name]: { name: res.name!, path: res.path!, note: res.note ?? null, cloudFolderUrl: res.cloudFolderUrl ?? null },
            }));
          }
        })
        .catch(() => { /* non-fatal */ });
    }
  }, [group.ruddrProjectNames]);

  // Re-fetch project info when the background refresh updates note/cloud folder data
  useEffect(() => {
    const unsub = window.jarvis.onRuddrProjectDetailsRefreshed(() => {
      setDetailsLoading(false);
      const names = group.ruddrProjectNames ?? [];
      for (const name of names) {
        window.jarvis.groupsGetRuddrProjectInfo(name)
          .then((res) => {
            if (res.ok && res.name) {
              setProjectInfo((prev) => ({
                ...prev,
                [name]: { name: res.name!, path: res.path!, note: res.note ?? null, cloudFolderUrl: res.cloudFolderUrl ?? null },
              }));
            }
          })
          .catch(() => { /* non-fatal */ });
      }
    });
    return () => { unsub(); };
  }, [group.ruddrProjectNames]);

  const handleOpenManual = async () => {
    setRuddrManualFilter('');
    if (ruddrAllProjects.length === 0) {
      const res = await window.jarvis.groupsGetRuddrCache();
      if (res.ok) setRuddrAllProjects(res.projects);
    }
    setRuddrManualOpen(true);
  };

  const handleFindRuddr = async (forceRefresh = false) => {
    setRuddrSearching(true);
    setRuddrError(null);
    setRuddrMatches(null);
    setRuddrNeedsLogin(false);
    setRuddrManualOpen(false);
    // If the last scrape returned a thin list, or the caller explicitly requested
    // a refresh, invalidate the server-side cache before re-searching.
    if (forceRefresh || (ruddrLastCount > 0 && ruddrLastCount < 50)) {
      await window.jarvis.groupsRefreshRuddrCache().catch(() => { /* non-fatal */ });
    }
    try {
      const result = await window.jarvis.groupsFindRuddrProjects(group.name);
      if (!result.ok) {
        if (result.error === 'login_required') {
          setRuddrNeedsLogin(true);
        } else if (result.error === 'ruddr_workspace_not_configured') {
          setRuddrError('Ruddr workspace not configured. Set it above in the dashboard header.');
        } else {
          setRuddrError(result.error ?? 'Unknown error');
        }
      } else {
        setRuddrMatches(result.matches ?? []);
        setRuddrLastCount(result.allCount ?? 0);
        if ((result.matches ?? []).length === 0)
          setRuddrError(`No matches found in ${result.allCount ?? 0} Ruddr projects`);
      }
    } catch (err) {
      setRuddrError(err instanceof Error ? err.message : String(err));
    } finally {
      setRuddrSearching(false);
    }
  };

  const handleLinkProject = async (projectName: string) => {
    setRuddrLinking(projectName);
    try {
      const result = await window.jarvis.groupsSetRuddrProject(group.id, projectName);
      if (result.ok) {
        const newNames = [...group.ruddrProjectNames];
        if (!newNames.includes(projectName)) newNames.push(projectName);
        onRuddrLinked(group.id, newNames);
        setRuddrError(null);
        // Keep matches open so more can be linked
      } else {
        setRuddrError(result.error ?? 'Failed to link project');
      }
    } catch (err) {
      setRuddrError(err instanceof Error ? err.message : String(err));
    } finally {
      setRuddrLinking(null);
    }
  };

  const handleUnlinkOne = async (projectName: string) => {
    try {
      const result = await window.jarvis.groupsRemoveRuddrProject(group.id, projectName);
      if (result.ok) {
        onRuddrLinked(group.id, group.ruddrProjectNames.filter((n) => n !== projectName));
      }
    } catch { /* ignore */ }
  };

  const handleCheckBudget = async (projectName: string) => {
    setBudgetChecking(projectName);
    try {
      const result = await window.jarvis.groupsGetRuddrBudget(projectName);
      setBudgetData((prev) => ({ ...prev, [projectName]: result }));
    } catch (err) {
      setBudgetData((prev) => ({
        ...prev,
        [projectName]: { ok: false, error: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setBudgetChecking(null);
    }
  };

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
        <span class="groups-dash-stat" title="Discovered OneDrive files">
          <span class="groups-dash-stat-icon">📄</span>
          <span class="groups-dash-stat-value">{group.fileCount}</span>
          <span class="groups-dash-stat-label">file{group.fileCount !== 1 ? 's' : ''}</span>
        </span>
      </div>

      {/* ── Ruddr project section ── */}
      <div class="groups-dash-ruddr">
        {/* Linked projects — each with its own unlink button */}
        {group.ruddrProjectNames.length > 0 && (
          <div class="groups-dash-ruddr-linked-list">
            {group.ruddrProjectNames.map((name) => (
              <div class="groups-dash-ruddr-linked-item" key={name}>
                <div class="groups-dash-ruddr-linked">
                  <span class="groups-dash-ruddr-icon">📋</span>
                  <span class="groups-dash-ruddr-name" title={name}>{name}</span>
                  <button
                    class="groups-dash-ruddr-budget-btn"
                    onClick={() => void handleCheckBudget(name)}
                    disabled={budgetChecking !== null}
                    title="Check budget on Ruddr"
                  >
                    {budgetChecking === name ? '⏳' : '💰'}
                  </button>
                  {budgetData[name]?.ok && budgetData[name].projectUrl && (
                    <button
                      class="groups-dash-ruddr-open-btn"
                      onClick={() => void window.jarvis.shellOpenUrl(budgetData[name].projectUrl!)}
                      title="Open in Ruddr"
                    >↗️</button>
                  )}
                  {projectInfo[name]?.path && (() => {
                    const editUrl = 'https://www.ruddr.io' + projectInfo[name].path.replace('/portfolio/projects/', '/portfolio/projects/edit/');
                    return (
                      <button
                        class="groups-dash-ruddr-edit-btn"
                        onClick={() => void window.jarvis.shellOpenUrl(editUrl)}
                        title="Edit project in Ruddr"
                      >✏️</button>
                    );
                  })()}
                  {projectInfo[name]?.cloudFolderUrl && (
                    <button
                      class="groups-dash-ruddr-edit-btn"
                      onClick={() => void window.jarvis.shellOpenUrl(projectInfo[name].cloudFolderUrl!)}
                      title="Open cloud folder"
                    >☁️</button>
                  )}
                  <button class="groups-dash-ruddr-unlink" onClick={() => void handleUnlinkOne(name)} title="Remove Ruddr link">✕</button>
                </div>
                {/* Project note */}
                <div class="groups-dash-ruddr-note">
                  {projectInfo[name]
                    ? (projectInfo[name].note
                      ? <span class="groups-dash-note-text">{projectInfo[name].note}</span>
                      : (detailsLoading
                        ? <span class="groups-dash-note-empty" title="Fetching note from Ruddr…">🔄 Fetching note…</span>
                        : <span class="groups-dash-note-empty" title="No note set for this project">❗ No note set</span>))
                    : null}
                  {projectInfo[name] && !projectInfo[name].cloudFolderUrl && (
                    detailsLoading
                      ? <span class="groups-dash-note-empty" title="Fetching cloud folder from Ruddr…">🔄 Fetching cloud folder…</span>
                      : <span class="groups-dash-note-empty" title="No cloud folder linked in Ruddr">☁️ No cloud folder</span>
                  )}
                </div>
                {budgetData[name] && (
                  <div class="groups-dash-budget-section">
                    {budgetData[name].ok ? (
                      <>
                        <div class="groups-dash-budget-table">
                          <div class="groups-dash-budget-cell">
                            <span class="groups-dash-budget-val">{budgetData[name].actualBillableHours ?? '?'}h</span>
                            <span class="groups-dash-budget-lbl">billable</span>
                          </div>
                          <div class="groups-dash-budget-cell">
                            <span class="groups-dash-budget-val">{budgetData[name].budget ?? '?'}h</span>
                            <span class="groups-dash-budget-lbl">budget</span>
                          </div>
                          <div class={`groups-dash-budget-cell${parseFloat(budgetData[name].budgetLeft ?? '0') < 0 ? ' groups-dash-budget-cell--over' : ''}`}>
                            <span class="groups-dash-budget-val">{budgetData[name].budgetLeft ?? '?'}h</span>
                            <span class="groups-dash-budget-lbl">left</span>
                          </div>
                        </div>
                        {budgetData[name].budget === '0' && (
                          <div class="groups-dash-budget-alerts">
                            <span class="groups-dash-budget-warn" title="No budget set for this project in Ruddr">⚠️ No budget set</span>
                          </div>
                        )}
                      </>
                    ) : (
                      <div class="groups-dash-budget-alerts">
                        <span class="groups-dash-budget-error">
                          {budgetData[name].error === 'ruddr_no_projects_found'
                            ? 'Ruddr project list is empty — browser extension may not have loaded the page yet. Click 💰 to retry.'
                            : budgetData[name].error === 'project_url_unknown'
                            ? 'Run "Find Ruddr project" first to cache the project URL'
                            : budgetData[name].error === 'project_not_in_ruddr'
                            ? `"${name}" not found in Ruddr — the name may differ. Use "Find Ruddr project" to re-link.`
                            : budgetData[name].error}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Find / Add button — always visible */}
        <button
          class="groups-dash-ruddr-btn"
          onClick={() => void handleFindRuddr()}
          disabled={ruddrSearching}
        >
          {ruddrSearching ? '🔍 Searching…' : group.ruddrProjectNames.length > 0 ? '🔍 Add Ruddr project' : '🔍 Find Ruddr project'}
        </button>

        {ruddrNeedsLogin && !ruddrSearching && (
          <div class="groups-dash-ruddr-login">
            <span class="groups-dash-ruddr-login-icon">🔒</span>
            <span class="groups-dash-ruddr-login-msg">Ruddr login required — browser opened</span>
            <button
              class="groups-dash-ruddr-login-retry"
              onClick={() => void handleFindRuddr()}
            >
              Retry
            </button>
          </div>
        )}

        {ruddrError && (
          <div class="groups-dash-ruddr-error">
            {ruddrError}
            {ruddrMatches !== null && ruddrMatches.length === 0 && (
              <>
                {ruddrLastCount > 0 && ruddrLastCount < 50 && (
                  <button
                    class="groups-dash-ruddr-manual-btn"
                    onClick={() => void handleFindRuddr(true)}
                    disabled={ruddrSearching}
                  >
                    Re-fetch project list
                  </button>
                )}
                <button
                  class="groups-dash-ruddr-manual-btn"
                  onClick={() => void handleOpenManual()}
                >
                  Link manually
                </button>
              </>
            )}
          </div>
        )}

        {ruddrMatches !== null && ruddrMatches.length > 0 && (
          <div class="groups-dash-ruddr-matches">
            {ruddrMatches.map((m) => {
              const alreadyLinked = group.ruddrProjectNames.includes(m.name);
              return (
                <div class="groups-dash-ruddr-match" key={m.name}>
                  <span class="groups-dash-ruddr-match-name">{m.name}</span>
                  <button
                    class={`groups-dash-ruddr-match-btn${alreadyLinked ? ' groups-dash-ruddr-match-btn--linked' : ''}`}
                    onClick={() => !alreadyLinked && void handleLinkProject(m.name)}
                    disabled={ruddrLinking !== null || alreadyLinked}
                  >
                    {alreadyLinked ? '✓' : ruddrLinking === m.name ? '…' : 'Link'}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {ruddrManualOpen && (
          <div class="groups-dash-ruddr-manual">
            <div class="groups-dash-ruddr-manual-header">
              <span>Pick a Ruddr project</span>
              <button
                class="groups-dash-ruddr-manual-close"
                onClick={() => setRuddrManualOpen(false)}
                title="Close"
              >✕</button>
            </div>
            <input
              class="groups-dash-ruddr-manual-search"
              type="text"
              placeholder="Filter…"
              value={ruddrManualFilter}
              onInput={(e) => setRuddrManualFilter((e.target as HTMLInputElement).value)}
            />
            <div class="groups-dash-ruddr-manual-list">
              {ruddrAllProjects
                .filter((p) => p.toLowerCase().includes(ruddrManualFilter.toLowerCase()))
                .map((p) => {
                  const alreadyLinked = group.ruddrProjectNames.includes(p);
                  return (
                    <div class="groups-dash-ruddr-manual-item" key={p}>
                      <span class="groups-dash-ruddr-manual-item-name" title={p}>{p}</span>
                      <button
                        class={`groups-dash-ruddr-match-btn${alreadyLinked ? ' groups-dash-ruddr-match-btn--linked' : ''}`}
                        onClick={() => !alreadyLinked && void handleLinkProject(p)}
                        disabled={ruddrLinking !== null || alreadyLinked}
                      >
                        {alreadyLinked ? '✓' : ruddrLinking === p ? '…' : 'Link'}
                      </button>
                    </div>
                  );
                })}
              {ruddrAllProjects.filter((p) => p.toLowerCase().includes(ruddrManualFilter.toLowerCase())).length === 0 && (
                <div class="groups-dash-ruddr-manual-empty">No projects match</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
