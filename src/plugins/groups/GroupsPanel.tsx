import { useState, useEffect } from 'preact/hooks';
import type { Group, GroupDetail, LocalRepo } from '../types';

// ── GroupsPanel ───────────────────────────────────────────────────────────────
// Allows users to create, rename, delete groups and assign local/remote repos
// to them.

interface GroupsPanelProps {
  onClose: () => void;
}

export function GroupsPanel({ onClose }: GroupsPanelProps) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Create form state
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  // Rename state
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);

  // Add repo search
  const [localRepos, setLocalRepos] = useState<LocalRepo[]>([]);
  const [repoSearch, setRepoSearch] = useState('');

  const refresh = async () => {
    try {
      const list = await window.jarvis.groupsList();
      setGroups(list);
      if (selectedGroup) {
        const detail = await window.jarvis.groupsGet(selectedGroup.id);
        setSelectedGroup(detail);
      }
    } catch (err) {
      console.error('[Groups] Failed to load groups:', err);
    }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [list, repos] = await Promise.all([
          window.jarvis.groupsList(),
          window.jarvis.localListRepos(),
        ]);
        setGroups(list);
        setLocalRepos(repos);
      } catch (err) {
        console.error('[Groups] init error:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSelectGroup = async (id: number) => {
    setRenamingId(null);
    const detail = await window.jarvis.groupsGet(id);
    setSelectedGroup(detail);
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError('');
    const result = await window.jarvis.groupsCreate(newName.trim());
    setCreating(false);
    if (!result.ok) {
      setError(result.error ?? 'Failed to create group');
      return;
    }
    setNewName('');
    await refresh();
    if (result.id) {
      const detail = await window.jarvis.groupsGet(result.id);
      setSelectedGroup(detail);
    }
  };

  const handleStartRename = (group: Group) => {
    setRenamingId(group.id);
    setRenameValue(group.name);
  };

  const handleRename = async (groupId: number) => {
    if (!renameValue.trim()) return;
    setRenaming(true);
    setError('');
    const result = await window.jarvis.groupsRename(groupId, renameValue.trim());
    setRenaming(false);
    if (!result.ok) {
      setError(result.error ?? 'Failed to rename group');
      return;
    }
    setRenamingId(null);
    await refresh();
  };

  const handleDelete = async (groupId: number, name: string) => {
    if (!confirm(`Delete group "${name}"? This cannot be undone.`)) return;
    setError('');
    const result = await window.jarvis.groupsDelete(groupId);
    if (!result.ok) {
      setError(result.error ?? 'Failed to delete group');
      return;
    }
    if (selectedGroup?.id === groupId) setSelectedGroup(null);
    await refresh();
  };

  const handleRemoveLocalRepo = async (localRepoId: number) => {
    if (!selectedGroup) return;
    await window.jarvis.groupsRemoveLocalRepo(selectedGroup.id, localRepoId);
    const detail = await window.jarvis.groupsGet(selectedGroup.id);
    setSelectedGroup(detail);
    await refresh();
  };

  const handleRemoveGithubRepo = async (githubRepoId: number) => {
    if (!selectedGroup) return;
    await window.jarvis.groupsRemoveGithubRepo(selectedGroup.id, githubRepoId);
    const detail = await window.jarvis.groupsGet(selectedGroup.id);
    setSelectedGroup(detail);
    await refresh();
  };

  const handleAddLocalRepo = async (localRepoId: number) => {
    if (!selectedGroup) return;
    await window.jarvis.groupsAddLocalRepo(selectedGroup.id, localRepoId);
    const detail = await window.jarvis.groupsGet(selectedGroup.id);
    setSelectedGroup(detail);
    await refresh();
  };

  // Repos not yet in the selected group (for the add panel)
  const memberLocalIds = new Set(selectedGroup?.localRepos.map((r) => r.id) ?? []);
  const availableLocalRepos = localRepos.filter(
    (r) =>
      !memberLocalIds.has(r.id) &&
      (repoSearch === '' ||
        r.name.toLowerCase().includes(repoSearch.toLowerCase()) ||
        r.localPath.toLowerCase().includes(repoSearch.toLowerCase())),
  );

  return (
    <div class="org-panel groups-panel">
      <div class="org-panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Source Groups</span>
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>

      <p style={{ fontSize: '0.82rem', color: '#c8c8c8', marginBottom: '0.75rem' }}>
        Groups let you organize local and remote repos under a named project, product, or customer
        so you can build focused knowledge and ask questions about them in the chat.
      </p>

      {/* Create new group */}
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.75rem' }}>
        <input
          type="text"
          placeholder="New group name…"
          value={newName}
          onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button onClick={handleCreate} disabled={creating || !newName.trim()} class="btn-save">
          {creating ? 'Creating…' : 'Create'}
        </button>
      </div>

      {error && (
        <div style={{ color: '#f88', fontSize: '0.82rem', marginBottom: '0.5rem' }}>{error}</div>
      )}

      {loading && <div style={{ color: '#99a', fontSize: '0.82rem' }}>Loading…</div>}

      {/* Group list */}
      {!loading && groups.length === 0 && (
        <div style={{ color: '#99a', fontSize: '0.82rem', padding: '0.35rem 0' }}>
          No groups yet — create one above.
        </div>
      )}

      {!loading && groups.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem' }}>
          {groups.map((g) => (
            <li
              key={g.id}
              style={{
                padding: '0.45rem 0.55rem',
                marginBottom: '0.3rem',
                borderRadius: '5px',
                background: selectedGroup?.id === g.id ? '#2a2a3a' : '#1e1e2a',
                border: selectedGroup?.id === g.id ? '1px solid #555' : '1px solid transparent',
                cursor: 'pointer',
              }}
              onClick={() => void handleSelectGroup(g.id)}
            >
              {renamingId === g.id ? (
                <div style={{ display: 'flex', gap: '0.4rem' }} onClick={(e) => e.stopPropagation()}>
                  <input
                    type="text"
                    value={renameValue}
                    onInput={(e) => setRenameValue((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleRename(g.id); if (e.key === 'Escape') setRenamingId(null); }}
                    style={{ flex: 1, minWidth: 0, fontSize: '0.85rem' }}
                  />
                  <button class="btn-save" onClick={() => void handleRename(g.id)} disabled={renaming} style={{ padding: '0.15rem 0.5rem', fontSize: '0.8rem' }}>
                    {renaming ? '…' : 'Save'}
                  </button>
                  <button class="btn-secondary" onClick={() => setRenamingId(null)} style={{ padding: '0.15rem 0.5rem', fontSize: '0.8rem' }}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <span style={{ fontWeight: 600, fontSize: '0.88rem', color: '#dde' }}>{g.name}</span>
                    <span style={{ marginLeft: '0.5rem', fontSize: '0.78rem', color: '#778' }}>
                      {g.localRepoCount + g.githubRepoCount} repo{g.localRepoCount + g.githubRepoCount !== 1 ? 's' : ''}
                      {g.localRepoCount > 0 && ` (${g.localRepoCount} local)`}
                      {g.githubRepoCount > 0 && ` (${g.githubRepoCount} remote)`}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.3rem' }} onClick={(e) => e.stopPropagation()}>
                    <button
                      title="Rename"
                      onClick={() => handleStartRename(g)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#99a', fontSize: '0.8rem', padding: '0.1rem 0.3rem' }}
                    >
                      ✏️
                    </button>
                    <button
                      title="Delete"
                      onClick={() => void handleDelete(g.id, g.name)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f88', fontSize: '0.8rem', padding: '0.1rem 0.3rem' }}
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Selected group detail */}
      {selectedGroup && (
        <div style={{ borderTop: '1px solid #333', paddingTop: '0.75rem' }}>
          <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#cce', marginBottom: '0.5rem' }}>
            {selectedGroup.name}
          </div>

          {/* Local repo members */}
          <div style={{ fontSize: '0.82rem', color: '#99a', marginBottom: '0.3rem', fontWeight: 600 }}>
            Local repos ({selectedGroup.localRepos.length})
          </div>
          {selectedGroup.localRepos.length === 0 && (
            <div style={{ fontSize: '0.8rem', color: '#667', marginBottom: '0.5rem' }}>None added yet.</div>
          )}
          {selectedGroup.localRepos.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.2rem 0.4rem', marginBottom: '0.2rem', background: '#1a1a26', borderRadius: '4px' }}>
              <div>
                <span style={{ fontSize: '0.85rem', color: '#ccc' }}>{r.name}</span>
                <span style={{ fontSize: '0.75rem', color: '#778', marginLeft: '0.4rem', fontFamily: 'monospace' }}>{r.localPath}</span>
              </div>
              <button
                title="Remove from group"
                onClick={() => void handleRemoveLocalRepo(r.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f88', fontSize: '0.8rem', padding: '0.1rem 0.3rem', flexShrink: 0 }}
              >
                ✕
              </button>
            </div>
          ))}

          {/* GitHub repo members */}
          <div style={{ fontSize: '0.82rem', color: '#99a', marginBottom: '0.3rem', fontWeight: 600, marginTop: '0.6rem' }}>
            Remote repos ({selectedGroup.githubRepos.length})
          </div>
          {selectedGroup.githubRepos.length === 0 && (
            <div style={{ fontSize: '0.8rem', color: '#667', marginBottom: '0.5rem' }}>None added yet.</div>
          )}
          {selectedGroup.githubRepos.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.2rem 0.4rem', marginBottom: '0.2rem', background: '#1a1a26', borderRadius: '4px' }}>
              <span style={{ fontSize: '0.85rem', color: '#ccc', fontFamily: 'monospace' }}>{r.fullName}</span>
              <button
                title="Remove from group"
                onClick={() => void handleRemoveGithubRepo(r.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f88', fontSize: '0.8rem', padding: '0.1rem 0.3rem', flexShrink: 0 }}
              >
                ✕
              </button>
            </div>
          ))}

          {/* Add local repo */}
          {localRepos.length > 0 && (
            <div style={{ marginTop: '0.75rem' }}>
              <div style={{ fontSize: '0.82rem', color: '#99a', marginBottom: '0.3rem', fontWeight: 600 }}>
                Add local repo to group
              </div>
              <input
                type="text"
                placeholder="Filter repos…"
                value={repoSearch}
                onInput={(e) => setRepoSearch((e.target as HTMLInputElement).value)}
                style={{ width: '100%', marginBottom: '0.35rem', boxSizing: 'border-box' }}
              />
              {availableLocalRepos.length === 0 ? (
                <div style={{ fontSize: '0.78rem', color: '#667' }}>
                  {repoSearch ? 'No matches.' : 'All discovered local repos are already in this group.'}
                </div>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '140px', overflowY: 'auto' }}>
                  {availableLocalRepos.map((r) => (
                    <li
                      key={r.id}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.2rem 0.4rem', marginBottom: '0.2rem', background: '#1a1a26', borderRadius: '4px', cursor: 'pointer' }}
                      onClick={() => void handleAddLocalRepo(r.id)}
                    >
                      <div>
                        <span style={{ fontSize: '0.83rem', color: '#bbc' }}>{r.name}</span>
                        <span style={{ fontSize: '0.73rem', color: '#667', marginLeft: '0.4rem', fontFamily: 'monospace' }}>{r.localPath}</span>
                      </div>
                      <span style={{ color: '#6a9', fontSize: '0.8rem', flexShrink: 0, paddingLeft: '0.3rem' }}>＋</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
