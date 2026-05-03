import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import './settings.css';

// ── Types (from preload API) ─────────────────────────────────────────────────

interface OAuthStatus {
  authenticated: boolean;
  login?: string;
  avatarUrl?: string;
}

interface PatStatus {
  hasPat: boolean;
  name?: string;
  login?: string;
  avatarUrl?: string;
}

interface OnedriveRoot {
  id: number;
  path: string;
  label: string;
  addedAt: string;
}

declare const window: Window & {
  jarvis: {
    getGitHubOAuthStatus(): Promise<OAuthStatus>;
    getPatStatus(): Promise<PatStatus>;
    savePat(pat: string): Promise<{ error?: string }>;
    deletePat(): Promise<void>;
    logout(): Promise<void>;
    startOAuthDiscovery(): Promise<void>;
    startPatDiscovery(): Promise<void>;
    agentsList(): Promise<Array<{ id: number; name: string; description: string; system_prompt: string }>>;
    agentsUpdate(agentId: number, systemPrompt: string): Promise<{ ok: boolean; error?: string }>;
    onedriveListRoots(): Promise<OnedriveRoot[]>;
    onedriveAddRoot(label: string, folderPath?: string): Promise<{ ok?: boolean; root?: OnedriveRoot; canceled?: boolean; error?: string }>;
    onedriveRemoveRoot(rootId: number): Promise<{ ok: boolean; error?: string }>;
  };
};

// ── User card ────────────────────────────────────────────────────────────────

function UserCard({ name, login, avatarUrl }: { name: string; login: string; avatarUrl?: string }) {
  return (
    <div class="user-card">
      {avatarUrl && <img class="user-avatar" src={avatarUrl} alt="" />}
      <div class="user-card-info">
        <div class="user-card-name">{name}</div>
        <div class="user-card-login">@{login}</div>
      </div>
    </div>
  );
}

// ── OAuth section ────────────────────────────────────────────────────────────

function OAuthSection() {
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [runningDiscovery, setRunningDiscovery] = useState(false);

  const refresh = async () => {
    try {
      setStatus(await window.jarvis.getGitHubOAuthStatus());
    } catch (err) {
      console.error('[Jarvis] Failed to check OAuth status:', err);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleLogout = async () => {
    if (!confirm('Sign out of GitHub? This will remove your OAuth session.')) return;
    await window.jarvis.logout();
    await refresh();
  };

  const handleDiscovery = async () => {
    setRunningDiscovery(true);
    try {
      await window.jarvis.startOAuthDiscovery();
    } catch (err) {
      console.error('OAuth discovery failed:', err);
    }
    setRunningDiscovery(false);
  };

  return (
    <div class="section">
      <h2>GitHub Account</h2>
      {status?.authenticated ? (
        <>
          <UserCard
            name={status.login || ''}
            login={status.login || ''}
            avatarUrl={status.avatarUrl}
          />
          <div class="btn-row">
            <button
              class="btn-secondary"
              onClick={handleDiscovery}
              disabled={runningDiscovery}
            >
              {runningDiscovery ? 'Starting\u2026' : 'Run OAuth Discovery'}
            </button>
            <div style={{ flex: 1 }} />
            <button class="btn-danger" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </>
      ) : (
        <p style={{ fontSize: '0.85rem', color: '#778' }}>Not signed in.</p>
      )}
    </div>
  );
}

// ── PAT section ──────────────────────────────────────────────────────────────

function PatSection() {
  const [status, setStatus] = useState<PatStatus | null>(null);
  const [patInput, setPatInput] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [runningDiscovery, setRunningDiscovery] = useState(false);

  const refresh = async () => {
    try {
      setStatus(await window.jarvis.getPatStatus());
    } catch (err) {
      console.error('[Jarvis] Failed to check PAT status:', err);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleSave = async () => {
    setError('');
    if (!patInput.trim()) {
      setError('Please enter a token');
      return;
    }
    setSaving(true);
    const result = await window.jarvis.savePat(patInput.trim());
    setSaving(false);
    if (result.error) {
      setError(result.error);
    } else {
      setPatInput('');
      setError('');
      await refresh();
    }
  };

  const handleRemove = async () => {
    await window.jarvis.deletePat();
    await refresh();
  };

  const handleDiscovery = async () => {
    setRunningDiscovery(true);
    try {
      await window.jarvis.startPatDiscovery();
    } catch (err) {
      console.error('PAT discovery failed:', err);
    }
    setRunningDiscovery(false);
  };

  return (
    <div class="section">
      <h2>GitHub Access — Personal Access Token</h2>

      {!status?.hasPat && (
        <div>
          <label for="pat-input">Enter token to add or replace PAT</label>
          <div class="btn-row" style={{ marginTop: 0 }}>
            <input
              type="password"
              id="pat-input"
              placeholder="ghp_... or github_pat_..."
              value={patInput}
              onInput={(e: Event) => setPatInput((e.target as HTMLInputElement).value)}
            />
            <button class="btn-save" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {status?.hasPat && (
        <>
          <UserCard
            name={status.name || status.login || 'PAT User'}
            login={status.login || ''}
            avatarUrl={status.avatarUrl}
          />
          <div class="btn-row">
            <button
              class="btn-secondary"
              onClick={handleDiscovery}
              disabled={runningDiscovery}
            >
              {runningDiscovery ? 'Running\u2026' : 'Run PAT Discovery'}
            </button>
            <div style={{ flex: 1 }} />
            <button class="btn-danger" onClick={handleRemove}>
              Remove
            </button>
          </div>
        </>
      )}

      {error && <div class="pat-error">{error}</div>}

      <p class="hint">
        A PAT with <code>repo</code> + <code>read:org</code> scopes discovers repos in orgs that
        block OAuth apps.
      </p>
    </div>
  );
}

// ── Agent Prompts section ─────────────────────────────────────────────

interface AgentDef {
  id: number;
  name: string;
  description: string;
  system_prompt: string;
}

function AgentPromptsSection() {
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    window.jarvis.agentsList().then((list) => {
      setAgents(list);
      if (list.length > 0) {
        setSelectedId(list[0].id);
        setPrompt(list[0].system_prompt);
      }
    }).catch(console.error);
  }, []);

  const selectAgent = (id: number) => {
    const agent = agents.find((a) => a.id === id);
    if (!agent) return;
    setSelectedId(id);
    setPrompt(agent.system_prompt);
    setSaveState('idle');
  };

  const handleSave = async () => {
    if (!selectedId) return;
    setSaving(true);
    setSaveState('idle');
    const result = await window.jarvis.agentsUpdate(selectedId, prompt);
    setSaving(false);
    if (result.ok) {
      setSaveState('saved');
      setAgents((prev) => prev.map((a) => a.id === selectedId ? { ...a, system_prompt: prompt } : a));
    } else {
      setSaveState('error');
      setSaveError(result.error ?? 'Unknown error');
    }
  };

  const handleReset = () => {
    const agent = agents.find((a) => a.id === selectedId);
    if (agent) setPrompt(agent.system_prompt);
    setSaveState('idle');
  };

  const selected = agents.find((a) => a.id === selectedId);

  return (
    <div class="section">
      <h2>Agent Prompts</h2>
      <div class="agent-tab-row">
        {agents.map((a) => (
          <button
            key={a.id}
            class={`btn-agent-tab${selectedId === a.id ? ' active' : ''}`}
            onClick={() => selectAgent(a.id)}
          >
            {a.name}
          </button>
        ))}
      </div>
      {selected && (
        <>
          <p class="hint" style={{ marginTop: '0.4rem', marginBottom: '0.5rem' }}>{selected.description}</p>
          <textarea
            class="agent-prompt-editor"
            value={prompt}
            rows={18}
            spellcheck={false}
            onInput={(e) => { setPrompt((e.target as HTMLTextAreaElement).value); setSaveState('idle'); }}
          />
          <div class="btn-row" style={{ marginTop: '0.5rem' }}>
            <button class="btn-save" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : saveState === 'saved' ? '\u2713 Saved' : 'Save Prompt'}
            </button>
            <button class="btn-secondary" onClick={handleReset} disabled={saving}>
              Reset
            </button>
          </div>
          {saveState === 'error' && <div class="pat-error" style={{ marginTop: '0.4rem' }}>{saveError}</div>}
        </>
      )}
    </div>
  );
}

// ── OneDrive Section ─────────────────────────────────────────────────────────

function OneDriveSection() {
  const [roots, setRoots] = useState<OnedriveRoot[]>([]);
  const [label, setLabel] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      setRoots(await window.jarvis.onedriveListRoots());
    } catch (err) {
      console.error('[OneDrive] Failed to list roots:', err);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleBrowse = async () => {
    setBrowsing(true);
    setError('');
    const result = await window.jarvis.onedriveBrowseFolder();
    setBrowsing(false);
    if (result.canceled) return;
    setFolderPath(result.folderPath);
  };

  const handleAdd = async () => {
    if (!label.trim()) {
      setError('Please enter a label for this root folder');
      return;
    }
    if (!folderPath) {
      setError('Please select a folder first');
      return;
    }
    setAdding(true);
    setError('');
    const result = await window.jarvis.onedriveAddRoot(label.trim(), folderPath);
    setAdding(false);
    if (result.canceled) return;
    if (!result.ok) {
      setError(result.error ?? 'Failed to add root');
      return;
    }
    setLabel('');
    setFolderPath('');
    await refresh();
  };

  const handleRemove = async (rootId: number, rootLabel: string) => {
    if (!confirm(`Remove OneDrive root "${rootLabel}"? Customer folder links for this root will also be removed.`)) return;
    const result = await window.jarvis.onedriveRemoveRoot(rootId);
    if (!result.ok) {
      setError(result.error ?? 'Failed to remove root');
      return;
    }
    await refresh();
  };

  return (
    <div class="section">
      <h2>OneDrive Customer Data Roots</h2>
      <p class="hint">
        Configure the OneDrive folders where your customer data lives. Jarvis will discover
        customer subfolders by matching group names — no files are downloaded.
        Add one root per entity you work for.
      </p>

      <div class="btn-row" style={{ marginTop: '0.75rem', alignItems: 'flex-end', gap: '0.5rem' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <label for="onedrive-label" style={{ fontSize: '0.82rem', color: '#aaa' }}>
            Label (e.g. "Contoso" or "Personal")
          </label>
          <input
            type="text"
            id="onedrive-label"
            placeholder="Entity name…"
            value={label}
            onInput={(e: Event) => setLabel((e.target as HTMLInputElement).value)}
            onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') void handleAdd(); }}
          />
        </div>
      </div>

      <div class="btn-row" style={{ marginTop: '0.4rem', alignItems: 'center', gap: '0.5rem' }}>
        <div
          style={{
            flex: 1,
            padding: '0.4rem 0.6rem',
            background: '#1a1a28',
            border: '1px solid #333',
            borderRadius: '4px',
            fontSize: '0.8rem',
            color: folderPath ? '#ccd' : '#556',
            fontFamily: 'monospace',
            cursor: 'pointer',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          onClick={() => void handleBrowse()}
        >
          {folderPath || 'Click Browse to select a folder…'}
        </div>
        <button class="btn-secondary" onClick={() => void handleBrowse()} disabled={browsing} style={{ flexShrink: 0 }}>
          {browsing ? 'Browsing…' : 'Browse'}
        </button>
        <button class="btn-save" onClick={() => void handleAdd()} disabled={adding || !label.trim() || !folderPath} style={{ flexShrink: 0 }}>
          {adding ? 'Adding…' : 'Add'}
        </button>
      </div>

      {error && <div class="pat-error" style={{ marginTop: '0.4rem' }}>{error}</div>}

      {roots.length === 0 && (
        <p style={{ fontSize: '0.85rem', color: '#778', marginTop: '0.75rem' }}>
          No OneDrive roots configured yet.
        </p>
      )}

      {roots.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0.75rem 0 0' }}>
          {roots.map((r) => (
            <li
              key={r.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.45rem 0.6rem',
                marginBottom: '0.35rem',
                background: '#1e1e2a',
                borderRadius: '5px',
                border: '1px solid #333',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#dde' }}>{r.label}</div>
                <div style={{ fontSize: '0.75rem', color: '#778', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.path}
                </div>
              </div>
              <button
                class="btn-danger"
                style={{ marginLeft: '0.75rem', padding: '0.2rem 0.5rem', fontSize: '0.78rem', flexShrink: 0 }}
                onClick={() => void handleRemove(r.id, r.label)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

function App() {
  return (
    <>
      <h1>Settings</h1>
      <OAuthSection />
      <PatSection />
      <OneDriveSection />
      <AgentPromptsSection />
    </>
  );
}

// ── Mount ────────────────────────────────────────────────────────────────────

const root = document.getElementById('app')!;
render(<App />, root);
