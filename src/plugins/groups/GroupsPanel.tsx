import { useState, useEffect } from 'preact/hooks';
import type { Group, GroupDetail, LocalRepo, OnedriveFolderInfo, OnedriveFile, UrlShortcutInfo } from '../types';

// ── GroupsPanel ───────────────────────────────────────────────────────────────
// Allows users to create, rename, delete groups and assign local/remote repos
// to them.

interface GroupsPanelProps {
  onClose: () => void;
  onOpenOneNote?: (filePath: string) => void;
}

export function GroupsPanel({ onClose, onOpenOneNote }: GroupsPanelProps) {
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

  // OneDrive state
  const [onedriveDiscovering, setOnedriveDiscovering] = useState(false);
  const [onedriveRescanningId, setOnedriveRescanningId] = useState<number | null>(null);
  const [expandedFolderId, setExpandedFolderId] = useState<number | null>(null);
  const [folderFiles, setFolderFiles] = useState<Record<number, OnedriveFile[]>>({});
  // Cache parsed .url shortcut info keyed by file path
  const [urlShortcuts, setUrlShortcuts] = useState<Record<string, UrlShortcutInfo & { loading?: boolean }>>({});

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

  // ── OneDrive handlers ────────────────────────────────────────────────────────

  const handleOnedriveDiscover = async () => {
    if (!selectedGroup) return;
    setOnedriveDiscovering(true);
    try {
      await window.jarvis.onedriveDiscoverForGroup(selectedGroup.id);
      const detail = await window.jarvis.groupsGet(selectedGroup.id);
      setSelectedGroup(detail);
    } catch (err) {
      console.error('[Groups] OneDrive discover failed:', err);
    } finally {
      setOnedriveDiscovering(false);
    }
  };

  const handleOnedriveRescan = async (folderId: number) => {
    setOnedriveRescanningId(folderId);
    try {
      await window.jarvis.onedriveRescanFiles(folderId);
      const detail = await window.jarvis.groupsGet(selectedGroup!.id);
      setSelectedGroup(detail);
      // Refresh file list if expanded
      if (expandedFolderId === folderId) {
        const files = await window.jarvis.onedriveListFilesForFolder(folderId);
        setFolderFiles((prev) => ({ ...prev, [folderId]: files }));
      }
    } catch (err) {
      console.error('[Groups] OneDrive rescan failed:', err);
    } finally {
      setOnedriveRescanningId(null);
    }
  };

  const handleToggleFiles = async (folder: OnedriveFolderInfo) => {
    if (expandedFolderId === folder.id) {
      setExpandedFolderId(null);
      return;
    }
    setExpandedFolderId(folder.id);
    if (!folderFiles[folder.id]) {
      const files = await window.jarvis.onedriveListFilesForFolder(folder.id);
      setFolderFiles((prev) => ({ ...prev, [folder.id]: files }));
      // Pre-load URL shortcut info for .url files
      if (folder.folderPath) {
        for (const f of files.filter((f) => f.extension === '.url')) {
          const fullPath = folder.folderPath + '\\' + f.relativePath;
          if (!urlShortcuts[fullPath]) {
            setUrlShortcuts((prev) => ({ ...prev, [fullPath]: { url: '', isOneNote: false, isSharePoint: false, loading: true } }));
            window.jarvis.onedriveReadUrlShortcut(fullPath).then((result) => {
              if (result.ok && result.url) {
                setUrlShortcuts((prev) => ({
                  ...prev,
                  [fullPath]: { url: result.url!, isOneNote: result.isOneNote ?? false, isSharePoint: result.isSharePoint ?? false },
                }));
              } else {
                setUrlShortcuts((prev) => ({ ...prev, [fullPath]: { url: '', isOneNote: false, isSharePoint: false } }));
              }
            }).catch(() => {
              setUrlShortcuts((prev) => ({ ...prev, [fullPath]: { url: '', isOneNote: false, isSharePoint: false } }));
            });
          }
        }
      }
    }
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

      <div class="groups-split">
        {/* LEFT: create form + group list */}
        <div class="groups-split-left">
          <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem' }}>
            <input
              type="text"
              placeholder="New group name…"
              value={newName}
              onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button onClick={handleCreate} disabled={creating || !newName.trim()} class="btn-save">
              {creating ? '…' : 'Create'}
            </button>
          </div>

          {error && (
            <div style={{ color: '#f88', fontSize: '0.82rem', marginBottom: '0.5rem' }}>{error}</div>
          )}

          {loading && <div style={{ color: '#99a', fontSize: '0.82rem' }}>Loading…</div>}

          {!loading && groups.length === 0 && (
            <div style={{ color: '#99a', fontSize: '0.82rem', padding: '0.35rem 0' }}>
              No groups yet — create one above.
            </div>
          )}

          {!loading && groups.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {groups.map((g) => (
                <li
                  key={g.id}
                  style={{
                    padding: '0.4rem 0.5rem',
                    marginBottom: '0.25rem',
                    borderRadius: '5px',
                    background: selectedGroup?.id === g.id ? '#2a2a3a' : '#1e1e2a',
                    border: selectedGroup?.id === g.id ? '1px solid #555' : '1px solid transparent',
                    cursor: 'pointer',
                  }}
                  onClick={() => void handleSelectGroup(g.id)}
                >
                  {renamingId === g.id ? (
                    <div style={{ display: 'flex', gap: '0.3rem' }} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={renameValue}
                        onInput={(e) => setRenameValue((e.target as HTMLInputElement).value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void handleRename(g.id); if (e.key === 'Escape') setRenamingId(null); }}
                        style={{ flex: 1, minWidth: 0, fontSize: '0.82rem' }}
                      />
                      <button class="btn-save" onClick={() => void handleRename(g.id)} disabled={renaming} style={{ padding: '0.1rem 0.4rem', fontSize: '0.78rem' }}>
                        {renaming ? '…' : 'Save'}
                      </button>
                      <button class="btn-secondary" onClick={() => setRenamingId(null)} style={{ padding: '0.1rem 0.4rem', fontSize: '0.78rem' }}>
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#dde', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</div>
                        <div style={{ fontSize: '0.75rem', color: '#778' }}>
                          {g.localRepoCount + g.githubRepoCount} repo{g.localRepoCount + g.githubRepoCount !== 1 ? 's' : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.15rem', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                        <button
                          title="Rename"
                          onClick={() => handleStartRename(g)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#99a', fontSize: '0.8rem', padding: '0.1rem 0.25rem' }}
                        >
                          ✏️
                        </button>
                        <button
                          title="Delete"
                          onClick={() => void handleDelete(g.id, g.name)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f88', fontSize: '0.8rem', padding: '0.1rem 0.25rem' }}
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
        </div>

        {/* RIGHT: selected group detail */}
        <div class="groups-split-right">
          {!selectedGroup ? (
            <div style={{ color: '#556', fontSize: '0.82rem', padding: '0.5rem 0' }}>
              Select a group to view and manage its repositories.
            </div>
          ) : (
            <>
              <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#cce', marginBottom: '0.6rem' }}>
                {selectedGroup.name}
              </div>

              {/* Local repo members */}
              <div style={{ fontSize: '0.8rem', color: '#99a', marginBottom: '0.25rem', fontWeight: 600 }}>
                Local repos ({selectedGroup.localRepos.length})
              </div>
              {selectedGroup.localRepos.length === 0 && (
                <div style={{ fontSize: '0.78rem', color: '#667', marginBottom: '0.4rem' }}>None added yet.</div>
              )}
              {selectedGroup.localRepos.map((r) => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.2rem 0.4rem', marginBottom: '0.2rem', background: '#1a1a26', borderRadius: '4px' }}>
                  <div style={{ minWidth: 0 }}>
                    <span style={{ fontSize: '0.83rem', color: '#ccc' }}>{r.name}</span>
                    <span style={{ fontSize: '0.73rem', color: '#778', marginLeft: '0.4rem', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.localPath}</span>
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
              <div style={{ fontSize: '0.8rem', color: '#99a', marginBottom: '0.25rem', fontWeight: 600, marginTop: '0.6rem' }}>
                Remote repos ({selectedGroup.githubRepos.length})
              </div>
              {selectedGroup.githubRepos.length === 0 && (
                <div style={{ fontSize: '0.78rem', color: '#667', marginBottom: '0.4rem' }}>None added yet.</div>
              )}
              {selectedGroup.githubRepos.map((r) => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.2rem 0.4rem', marginBottom: '0.2rem', background: '#1a1a26', borderRadius: '4px' }}>
                  <span style={{ fontSize: '0.83rem', color: '#ccc', fontFamily: 'monospace' }}>{r.fullName}</span>
                  <button
                    title="Remove from group"
                    onClick={() => void handleRemoveGithubRepo(r.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f88', fontSize: '0.8rem', padding: '0.1rem 0.3rem', flexShrink: 0 }}
                  >
                    ✕
                  </button>
                </div>
              ))}

              {/* OneDrive customer folder */}
              <div style={{ marginTop: '0.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                  <div style={{ fontSize: '0.8rem', color: '#99a', fontWeight: 600 }}>
                    Customer Data (OneDrive)
                  </div>
                  <button
                    class="btn-save"
                    style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem' }}
                    onClick={() => void handleOnedriveDiscover()}
                    disabled={onedriveDiscovering}
                  >
                    {onedriveDiscovering ? 'Scanning…' : '🔍 Discover'}
                  </button>
                </div>

                {selectedGroup.onedriveFolders.length === 0 && (
                  <div style={{ fontSize: '0.78rem', color: '#667' }}>
                    No OneDrive roots configured. Add roots in Settings first, then click Discover.
                  </div>
                )}

                {selectedGroup.onedriveFolders.map((folder) => (
                  <div
                    key={folder.id}
                    style={{ marginBottom: '0.4rem', background: '#1a1a26', borderRadius: '4px', overflow: 'hidden' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.3rem 0.5rem' }}>
                      <div style={{ minWidth: 0 }}>
                        <span style={{ fontSize: '0.82rem', color: '#ccd', fontWeight: 600 }}>{folder.rootLabel}</span>
                        {folder.status === 'found' ? (
                          <span style={{ marginLeft: '0.4rem', fontSize: '0.72rem', color: '#6a9', background: '#1a3a1a', padding: '0.1rem 0.3rem', borderRadius: '3px' }}>
                            ✓ found
                          </span>
                        ) : (
                          <span style={{ marginLeft: '0.4rem', fontSize: '0.72rem', color: '#f88', background: '#3a1a1a', padding: '0.1rem 0.3rem', borderRadius: '3px' }}>
                            ✕ not found
                          </span>
                        )}
                        {folder.status === 'found' && (
                          <span style={{ marginLeft: '0.4rem', fontSize: '0.72rem', color: '#778' }}>
                            {folder.fileCount} file{folder.fileCount !== 1 ? 's' : ''}
                            {folder.lastScanned ? ` · scanned ${new Date(folder.lastScanned).toLocaleDateString()}` : ''}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}>
                        {folder.status === 'found' && (
                          <>
                            <button
                              title="Rescan files"
                              class="btn-secondary"
                              style={{ padding: '0.1rem 0.35rem', fontSize: '0.72rem' }}
                              onClick={() => void handleOnedriveRescan(folder.id)}
                              disabled={onedriveRescanningId === folder.id}
                            >
                              {onedriveRescanningId === folder.id ? '…' : '↻'}
                            </button>
                            <button
                              title={expandedFolderId === folder.id ? 'Hide files' : 'Show files'}
                              class="btn-secondary"
                              style={{ padding: '0.1rem 0.35rem', fontSize: '0.72rem' }}
                              onClick={() => void handleToggleFiles(folder)}
                            >
                              {expandedFolderId === folder.id ? '▲' : '▼'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {folder.status === 'found' && folder.folderPath && (
                      <div style={{ paddingLeft: '0.5rem', paddingBottom: '0.2rem', fontSize: '0.7rem', color: '#556', fontFamily: 'monospace' }}>
                        {folder.folderPath}
                      </div>
                    )}

                    {expandedFolderId === folder.id && (
                      <div style={{ borderTop: '1px solid #2a2a3a', maxHeight: '200px', overflowY: 'auto' }}>
                        {(folderFiles[folder.id] ?? []).length === 0 ? (
                          <div style={{ padding: '0.35rem 0.5rem', fontSize: '0.77rem', color: '#556' }}>No files indexed.</div>
                        ) : (
                          (folderFiles[folder.id] ?? []).map((f) => {
                            const isOneNote = f.extension === '.one';
                            const isUrlShortcut = f.extension === '.url';
                            const fullPath = folder.folderPath
                              ? folder.folderPath + '\\' + f.relativePath
                              : null;
                            const shortcutInfo = fullPath ? urlShortcuts[fullPath] : null;
                            const isOneNoteUrl = isUrlShortcut && shortcutInfo?.isOneNote;
                            return (
                              <div
                                key={f.id}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.2rem 0.5rem', borderBottom: '1px solid #1e1e28' }}
                              >
                                <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                                  {isOneNote && (
                                    <span style={{ fontSize: '0.78rem', flexShrink: 0 }}>📓</span>
                                  )}
                                  {isUrlShortcut && (
                                    <span style={{ fontSize: '0.78rem', flexShrink: 0 }}>{isOneNoteUrl ? '📓🌐' : '🔗'}</span>
                                  )}
                                  <div style={{ minWidth: 0 }}>
                                    <span style={{ fontSize: '0.78rem', color: (isOneNote || isOneNoteUrl) ? '#cce' : '#bbc' }}>{f.name}</span>
                                    {isUrlShortcut && shortcutInfo?.isSharePoint && (
                                      <span style={{ marginLeft: '0.35rem', fontSize: '0.68rem', color: '#88a', background: '#1a1a30', padding: '0.05rem 0.25rem', borderRadius: '3px' }}>
                                        SharePoint
                                      </span>
                                    )}
                                    {f.relativePath !== f.name && (
                                      <span style={{ fontSize: '0.68rem', color: '#556', marginLeft: '0.3rem', fontFamily: 'monospace' }}>
                                        {f.relativePath}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0, paddingLeft: '0.5rem' }}>
                                  <span style={{ fontSize: '0.7rem', color: '#667' }}>
                                    {f.lastModified ? new Date(f.lastModified).toLocaleDateString() : '—'}
                                  </span>
                                  {isOneNote && fullPath && onOpenOneNote && (
                                    <button
                                      title="View note content"
                                      class="btn-secondary"
                                      style={{ padding: '0.05rem 0.3rem', fontSize: '0.7rem' }}
                                      onClick={() => onOpenOneNote(fullPath)}
                                    >
                                      📖
                                    </button>
                                  )}
                                  {isUrlShortcut && shortcutInfo?.url && (
                                    <button
                                      title={`Open in ${shortcutInfo.isOneNote ? 'OneNote' : 'browser'}: ${shortcutInfo.url}`}
                                      class="btn-secondary"
                                      style={{ padding: '0.05rem 0.3rem', fontSize: '0.7rem' }}
                                      onClick={() => void window.jarvis.shellOpenUrl(shortcutInfo.url)}
                                    >
                                      🌐
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Add local repo */}
              {localRepos.length > 0 && (
                <div style={{ marginTop: '0.75rem' }}>
                  <div style={{ fontSize: '0.8rem', color: '#99a', marginBottom: '0.25rem', fontWeight: 600 }}>
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
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '160px', overflowY: 'auto' }}>
                      {availableLocalRepos.map((r) => (
                        <li
                          key={r.id}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.2rem 0.4rem', marginBottom: '0.2rem', background: '#1a1a26', borderRadius: '4px', cursor: 'pointer' }}
                          onClick={() => void handleAddLocalRepo(r.id)}
                        >
                          <div style={{ minWidth: 0 }}>
                            <span style={{ fontSize: '0.82rem', color: '#bbc' }}>{r.name}</span>
                            <span style={{ fontSize: '0.72rem', color: '#667', marginLeft: '0.4rem', fontFamily: 'monospace' }}>{r.localPath}</span>
                          </div>
                          <span style={{ color: '#6a9', fontSize: '0.9rem', flexShrink: 0, paddingLeft: '0.3rem' }}>＋</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
