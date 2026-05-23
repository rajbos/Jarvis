/** @jsxImportSource preact */
import { useState, useEffect, useRef } from 'preact/hooks';

interface RuddrProjectRow {
  name: string;
  path: string;
  discoveredAt: string | null;
}

/** Formats an ISO datetime string (or null) as a localised date. */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function RuddrProjectsPanel(props: { onGroupCreated?: () => void }) {
  const { onGroupCreated } = props;
  const [projects, setProjects] = useState<RuddrProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [width, setWidth] = useState(240);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);

  // Notify the rest of the page when panel width changes
  useEffect(() => {
    document.documentElement.style.setProperty('--ruddr-panel-width', `${width}px`);
    window.dispatchEvent(new CustomEvent('ruddr-panel-resize', { detail: width }));
  }, [width]);

  // Clean up on unmount
  useEffect(() => {
    return () => { document.documentElement.style.removeProperty('--ruddr-panel-width'); };
  }, []);
  const [newGroupName, setNewGroupName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await window.jarvis.groupsListRuddrProjects();
      if (res.ok) setProjects(res.projects);
    } catch (err) {
      console.error('[RuddrProjectsPanel] load failed:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();

    // Refresh whenever a sync completes so newly discovered projects appear
    const unsub = window.jarvis.onNewRuddrProjects(() => { load(); });
    return () => { unsub(); };
  }, []);

  // ── Drag-to-resize ──────────────────────────────────────────────────────────
  const startResize = (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelRef.current?.offsetWidth ?? width;

    const onMouseMove = (ev: MouseEvent) => {
      // Panel is on the right side: dragging left (smaller clientX) widens it
      const delta = startX - ev.clientX;
      setWidth(Math.max(180, Math.min(600, startWidth + delta)));
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // ── Create group linked to a Ruddr project ──────────────────────────────────
  const openCreate = (projectName: string) => {
    setCreatingFor(projectName);
    setNewGroupName(projectName);
    setCreateError(null);
  };

  const cancelCreate = () => {
    setCreatingFor(null);
    setNewGroupName('');
    setCreateError(null);
  };

  const handleCreate = async (projectName: string) => {
    const name = newGroupName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const createRes = await window.jarvis.groupsCreate(name);
      if (!createRes.ok || createRes.id == null) {
        setCreateError(createRes.error ?? 'Failed to create group');
        return;
      }
      await window.jarvis.groupsSetRuddrProject(createRes.id, projectName);
      setCreatingFor(null);
      setNewGroupName('');
      onGroupCreated?.();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const filtered = filter.trim()
    ? projects.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : projects;

  return (
    <div class="ruddr-projects-panel" ref={panelRef} style={{ width: `${width}px` }}>
      {/* Drag-to-resize handle on the left edge */}
      <div class="ruddr-projects-panel__resize-handle" onMouseDown={startResize} title="Drag to resize" />

      <div class="ruddr-projects-panel__header">
        <h3>Ruddr Projects</h3>
        <span class="ruddr-projects-panel__count">{projects.length} known</span>
      </div>

      <input
        class="ruddr-projects-panel__filter"
        type="search"
        placeholder="Filter…"
        value={filter}
        onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
      />

      {loading && <div class="ruddr-projects-panel__loading">Loading…</div>}

      {!loading && filtered.length === 0 && (
        <div class="ruddr-projects-panel__empty">
          {filter ? 'No matches.' : 'No projects cached yet. Click Refresh in the dashboard.'}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <ul class="ruddr-projects-panel__list">
          {filtered.map((p) => (
            <li key={p.path} class="ruddr-projects-panel__item">
              <div class="ruddr-projects-panel__item-row">
                <span class="ruddr-projects-panel__name">{p.name}</span>
                <button
                  class="ruddr-projects-panel__create-btn"
                  onClick={() => creatingFor === p.name ? cancelCreate() : openCreate(p.name)}
                  title="Create a new group linked to this project"
                >+</button>
              </div>
              {p.discoveredAt && (
                <span class="ruddr-projects-panel__date" title={p.discoveredAt}>
                  {formatDate(p.discoveredAt)}
                </span>
              )}
              {creatingFor === p.name && (
                <form
                  class="ruddr-projects-panel__create-form"
                  onSubmit={(e) => { e.preventDefault(); void handleCreate(p.name); }}
                >
                  <input
                    class="ruddr-projects-panel__create-input"
                    type="text"
                    value={newGroupName}
                    onInput={(e) => setNewGroupName((e.target as HTMLInputElement).value)}
                    placeholder="Group name"
                    autofocus
                    disabled={creating}
                  />
                  {createError && (
                    <span class="ruddr-projects-panel__create-error">{createError}</span>
                  )}
                  <div class="ruddr-projects-panel__create-actions">
                    <button
                      type="submit"
                      class="ruddr-projects-panel__create-submit"
                      disabled={creating || !newGroupName.trim()}
                    >{creating ? '…' : 'Create'}</button>
                    <button
                      type="button"
                      class="ruddr-projects-panel__create-cancel"
                      onClick={cancelCreate}
                      disabled={creating}
                    >✕</button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
