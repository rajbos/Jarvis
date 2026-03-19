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

// ── App ──────────────────────────────────────────────────────────────────────

function App() {
  return (
    <>
      <h1>Settings</h1>
      <OAuthSection />
      <PatSection />
      <AgentPromptsSection />
    </>
  );
}

// ── Mount ────────────────────────────────────────────────────────────────────

const root = document.getElementById('app')!;
render(<App />, root);
