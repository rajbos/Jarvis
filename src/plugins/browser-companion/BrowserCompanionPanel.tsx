import { useState, useEffect, useCallback } from 'preact/hooks';
import type {
  BrowserSkill,
  BrowserSkillRun,
  BrowserCompanionStatus,
} from '../types';

// ── Skill form ────────────────────────────────────────────────────────────────

interface SkillFormProps {
  initial?: BrowserSkill | null;
  onSave: (
    name: string,
    description: string,
    startUrl: string,
    instructions: string,
    extractSelector: string,
  ) => Promise<void>;
  onCancel: () => void;
}

function SkillForm({ initial, onSave, onCancel }: SkillFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [startUrl, setStartUrl] = useState(initial?.start_url ?? '');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [extractSelector, setExtractSelector] = useState(initial?.extract_selector ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!name.trim() || !startUrl.trim() || !instructions.trim()) {
      setError('Name, Start URL, and Instructions are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(name, description, startUrl, instructions, extractSelector);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <label style={{ display: 'block', marginBottom: 2, fontWeight: 600, fontSize: 12 }}>
          Skill Name *
        </label>
        <input
          type="text"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          placeholder="e.g. Scrape GitHub trending repos"
          style={{ width: '100%', boxSizing: 'border-box', padding: '4px 6px', borderRadius: 4, border: '1px solid #555', background: '#1e1e1e', color: '#ddd', fontSize: 12 }}
        />
      </div>

      <div>
        <label style={{ display: 'block', marginBottom: 2, fontWeight: 600, fontSize: 12 }}>
          Description
        </label>
        <input
          type="text"
          value={description}
          onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
          placeholder="Optional short description"
          style={{ width: '100%', boxSizing: 'border-box', padding: '4px 6px', borderRadius: 4, border: '1px solid #555', background: '#1e1e1e', color: '#ddd', fontSize: 12 }}
        />
      </div>

      <div>
        <label style={{ display: 'block', marginBottom: 2, fontWeight: 600, fontSize: 12 }}>
          Start URL *
        </label>
        <input
          type="text"
          value={startUrl}
          onInput={(e) => setStartUrl((e.target as HTMLInputElement).value)}
          placeholder="https://example.com/page"
          style={{ width: '100%', boxSizing: 'border-box', padding: '4px 6px', borderRadius: 4, border: '1px solid #555', background: '#1e1e1e', color: '#ddd', fontSize: 12 }}
        />
      </div>

      <div>
        <label style={{ display: 'block', marginBottom: 2, fontWeight: 600, fontSize: 12 }}>
          Navigation Instructions *
        </label>
        <textarea
          value={instructions}
          onInput={(e) => setInstructions((e.target as HTMLTextAreaElement).value)}
          placeholder={"Describe each step:\n1. Click the search box (selector: #search)\n2. Type 'quarterly report'\n3. Click the submit button (selector: button[type=submit])\n4. Wait for results to load"}
          rows={6}
          style={{ width: '100%', boxSizing: 'border-box', padding: '4px 6px', borderRadius: 4, border: '1px solid #555', background: '#1e1e1e', color: '#ddd', fontSize: 12, fontFamily: 'monospace', resize: 'vertical' }}
        />
        <span style={{ fontSize: 10, color: '#888' }}>
          Describe navigation steps with CSS selectors. The extension will execute them in order.
        </span>
      </div>

      <div>
        <label style={{ display: 'block', marginBottom: 2, fontWeight: 600, fontSize: 12 }}>
          Data Extraction Selector
        </label>
        <input
          type="text"
          value={extractSelector}
          onInput={(e) => setExtractSelector((e.target as HTMLInputElement).value)}
          placeholder="e.g. table.results, .data-row, #content"
          style={{ width: '100%', boxSizing: 'border-box', padding: '4px 6px', borderRadius: 4, border: '1px solid #555', background: '#1e1e1e', color: '#ddd', fontSize: 12 }}
        />
        <span style={{ fontSize: 10, color: '#888' }}>
          CSS selector to extract data from the final page (optional).
        </span>
      </div>

      {error && (
        <div style={{ color: '#f88', fontSize: 12, background: '#3a1a1a', padding: '4px 8px', borderRadius: 4 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="submit"
          disabled={saving}
          style={{ flex: 1, padding: '6px 12px', borderRadius: 4, border: 'none', background: '#0d6efd', color: '#fff', cursor: saving ? 'wait' : 'pointer', fontSize: 12 }}
        >
          {saving ? 'Saving…' : initial ? 'Update Skill' : 'Create Skill'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          style={{ padding: '6px 12px', borderRadius: 4, border: '1px solid #555', background: 'transparent', color: '#aaa', cursor: 'pointer', fontSize: 12 }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Run result viewer ─────────────────────────────────────────────────────────

function RunResult({ run }: { run: BrowserSkillRun }) {
  const statusColor = run.status === 'completed' ? '#4caf50' : run.status === 'failed' ? '#f44336' : '#ff9800';

  return (
    <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 4, padding: 8, fontSize: 11 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ color: statusColor, fontWeight: 600, textTransform: 'uppercase' }}>{run.status}</span>
        <span style={{ color: '#888' }}>{run.started_at}</span>
      </div>
      {run.error && (
        <div style={{ color: '#f88', background: '#2a1a1a', padding: '4px 6px', borderRadius: 3, marginTop: 4, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {run.error}
        </div>
      )}
      {run.extracted_data && (
        <div>
          <span style={{ color: '#888', fontSize: 10 }}>Extracted data:</span>
          <pre style={{ margin: '2px 0 0', padding: '4px 6px', background: '#111', borderRadius: 3, overflow: 'auto', maxHeight: 150, fontSize: 10, color: '#ccc', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {typeof run.extracted_data === 'string'
              ? run.extracted_data
              : JSON.stringify(run.extracted_data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function BrowserCompanionPanel({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<BrowserCompanionStatus | null>(null);
  const [skills, setSkills] = useState<BrowserSkill[]>([]);
  const [runs, setRuns] = useState<BrowserSkillRun[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingSkill, setEditingSkill] = useState<BrowserSkill | null>(null);
  const [runningSkillId, setRunningSkillId] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<{ skillId: number; ok: boolean; data?: unknown; error?: string; testMode: boolean } | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<number | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await window.jarvis.browserStatus();
      setStatus(s);
    } catch (e) {
      console.warn('[BrowserCompanion] status error:', e);
    }
  }, []);

  const loadSkills = useCallback(async () => {
    try {
      const list = await window.jarvis.browserListSkills();
      setSkills(list);
    } catch (e) {
      console.warn('[BrowserCompanion] list skills error:', e);
    }
  }, []);

  const loadRuns = useCallback(async (skillId?: number) => {
    try {
      const list = await window.jarvis.browserListRuns(skillId);
      setRuns(list);
    } catch (e) {
      console.warn('[BrowserCompanion] list runs error:', e);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadSkills();
    void loadRuns();

    // Poll connection status every 3 seconds
    const timer = setInterval(() => void loadStatus(), 3000);
    return () => clearInterval(timer);
  }, [loadStatus, loadSkills, loadRuns]);

  // Listen for extension connection events
  useEffect(() => {
    const unsub = window.jarvis.onBrowserExtensionConnected(() => void loadStatus());
    return unsub;
  }, [loadStatus]);

  const handleCreateSkill = async (
    name: string, description: string, startUrl: string,
    instructions: string, extractSelector: string,
  ) => {
    const result = await window.jarvis.browserCreateSkill(name, description, startUrl, instructions, extractSelector);
    if (!result.ok) throw new Error(result.error ?? 'Unknown error');
    setShowForm(false);
    await loadSkills();
  };

  const handleUpdateSkill = async (
    name: string, description: string, startUrl: string,
    instructions: string, extractSelector: string,
  ) => {
    if (!editingSkill) return;
    const result = await window.jarvis.browserUpdateSkill(editingSkill.id, name, description, startUrl, instructions, extractSelector);
    if (!result.ok) throw new Error(result.error ?? 'Unknown error');
    setEditingSkill(null);
    await loadSkills();
  };

  const handleDeleteSkill = async (id: number) => {
    if (!confirm('Delete this browser skill?')) return;
    await window.jarvis.browserDeleteSkill(id);
    if (selectedSkillId === id) setSelectedSkillId(null);
    await loadSkills();
    await loadRuns();
  };

  const handleRunSkill = async (skillId: number, testMode: boolean) => {
    setRunningSkillId(skillId);
    setLastResult(null);
    try {
      const result = await window.jarvis.browserRunSkill(skillId, testMode);
      setLastResult({ skillId, ok: result.ok, data: result.data, error: result.error, testMode });
      await loadRuns(selectedSkillId ?? undefined);
    } catch (e) {
      setLastResult({ skillId, ok: false, error: e instanceof Error ? e.message : String(e), testMode });
    } finally {
      setRunningSkillId(null);
    }
  };

  const connected = (status?.connectedClients ?? 0) > 0;
  const [focusing, setFocusing] = useState(false);

  const handleFocusBrowser = async () => {
    setFocusing(true);
    try {
      await window.jarvis.browserFocusWindow();
    } catch (e) {
      console.warn('[BrowserCompanion] focus-window error:', e);
    } finally {
      setFocusing(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={onBack}
          style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 16, padding: 0 }}
        >
          ←
        </button>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#eee' }}>
          🌐 Browser Companion
        </h2>
      </div>

      {/* Connection status */}
      <div style={{
        background: connected ? '#0d2a0d' : '#2a1a0a',
        border: `1px solid ${connected ? '#2e7d32' : '#795548'}`,
        borderRadius: 6,
        padding: '8px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{ fontSize: 20 }}>{connected ? '🟢' : '🟡'}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: connected ? '#81c784' : '#ffb74d' }}>
            {connected
              ? `Extension connected (${status?.connectedClients ?? 0} client${(status?.connectedClients ?? 0) !== 1 ? 's' : ''})`
              : 'No extension connected'}
          </div>
          <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
            {connected
              ? `Bridge server running on port ${status?.port ?? 35789}`
              : `Install the Jarvis companion extension in Edge/Chrome and enable it. Bridge listening on port ${status?.port ?? 35789}.`}
          </div>
        </div>
        {connected && (
          <button
            onClick={() => void handleFocusBrowser()}
            disabled={focusing}
            title="Bring the browser window to the foreground"
            style={{
              padding: '4px 10px',
              borderRadius: 4,
              border: 'none',
              background: '#1565c0',
              color: '#fff',
              cursor: focusing ? 'not-allowed' : 'pointer',
              fontSize: 12,
              opacity: focusing ? 0.6 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {focusing ? '⏳' : '🪟'} Focus Browser
          </button>
        )}
      </div>

      {/* Install instructions banner */}
      {!connected && (
        <div style={{ background: '#1a1a2e', border: '1px solid #3a3a6e', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#aac' }}>
          <strong>How to connect:</strong>
          <ol style={{ margin: '4px 0 0 16px', padding: 0, lineHeight: 1.8 }}>
            <li>Open Edge/Chrome and navigate to <code>edge://extensions</code> or <code>chrome://extensions</code></li>
            <li>Enable <strong>Developer mode</strong></li>
            <li>Click <strong>Load unpacked</strong> and select the <code>src/browser-extension</code> folder from the Jarvis source directory</li>
            <li>The extension icon should appear in your toolbar — click it to confirm connection</li>
          </ol>
        </div>
      )}

      {/* Skills section */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#ccc' }}>Browser Skills</h3>
          {!showForm && !editingSkill && (
            <button
              onClick={() => setShowForm(true)}
              style={{ padding: '4px 10px', borderRadius: 4, border: 'none', background: '#0d6efd', color: '#fff', cursor: 'pointer', fontSize: 12 }}
            >
              + New Skill
            </button>
          )}
        </div>

        {showForm && (
          <div style={{ background: '#1a1a1a', border: '1px solid #444', borderRadius: 6, padding: 12, marginBottom: 12 }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: '#ddd' }}>New Skill</h4>
            <SkillForm
              onSave={handleCreateSkill}
              onCancel={() => setShowForm(false)}
            />
          </div>
        )}

        {skills.length === 0 && !showForm && (
          <div style={{ color: '#888', fontSize: 12, padding: '8px 0' }}>
            No browser skills defined yet. Create one to automate data collection from live browser tabs.
          </div>
        )}

        {skills.map((skill) => (
          <div
            key={skill.id}
            style={{
              background: selectedSkillId === skill.id ? '#1a2030' : '#151515',
              border: `1px solid ${selectedSkillId === skill.id ? '#3a5a9e' : '#333'}`,
              borderRadius: 6,
              padding: '8px 12px',
              marginBottom: 8,
              cursor: 'pointer',
            }}
            onClick={() => {
              setSelectedSkillId(selectedSkillId === skill.id ? null : skill.id);
              if (selectedSkillId !== skill.id) void loadRuns(skill.id);
            }}
          >
            {editingSkill?.id === skill.id ? (
              <SkillForm
                initial={skill}
                onSave={handleUpdateSkill}
                onCancel={() => setEditingSkill(null)}
              />
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#ddd' }}>{skill.name}</div>
                    {skill.description && (
                      <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{skill.description}</div>
                    )}
                    <div style={{ fontSize: 11, color: '#6a8caf', marginTop: 3, fontFamily: 'monospace' }}>
                      {skill.start_url}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 8 }} onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => void handleRunSkill(skill.id, false)}
                      disabled={!connected || runningSkillId === skill.id}
                      title={connected ? 'Run this skill' : 'Connect extension first'}
                      style={{
                        padding: '3px 8px', borderRadius: 3, border: 'none',
                        background: !connected ? '#333' : '#1b5e20', color: !connected ? '#666' : '#a5d6a7',
                        cursor: !connected || runningSkillId === skill.id ? 'not-allowed' : 'pointer', fontSize: 11,
                      }}
                    >
                      {runningSkillId === skill.id ? '⏳ Running…' : '▶ Run'}
                    </button>
                    <button
                      onClick={() => void handleRunSkill(skill.id, true)}
                      disabled={!connected || runningSkillId === skill.id}
                      title={connected ? 'Test run (navigate only, no data storage)' : 'Connect extension first'}
                      style={{
                        padding: '3px 8px', borderRadius: 3, border: 'none',
                        background: !connected ? '#333' : '#1a237e', color: !connected ? '#666' : '#90caf9',
                        cursor: !connected || runningSkillId === skill.id ? 'not-allowed' : 'pointer', fontSize: 11,
                      }}
                    >
                      🧪 Test
                    </button>
                    <button
                      onClick={() => setEditingSkill(skill)}
                      style={{ padding: '3px 8px', borderRadius: 3, border: '1px solid #555', background: 'transparent', color: '#aaa', cursor: 'pointer', fontSize: 11 }}
                    >
                      ✏️
                    </button>
                    <button
                      onClick={() => void handleDeleteSkill(skill.id)}
                      style={{ padding: '3px 8px', borderRadius: 3, border: 'none', background: '#3a1a1a', color: '#f88', cursor: 'pointer', fontSize: 11 }}
                    >
                      🗑
                    </button>
                  </div>
                </div>

                {/* Inline run result for this skill */}
                {lastResult?.skillId === skill.id && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
                      {lastResult.testMode ? '🧪 Test run result:' : '▶ Run result:'}
                    </div>
                    <RunResult run={{
                      id: 0,
                      skill_id: skill.id,
                      skill_name: skill.name,
                      status: lastResult.ok ? 'completed' : 'failed',
                      started_at: new Date().toISOString(),
                      completed_at: new Date().toISOString(),
                      extracted_data: lastResult.data ?? null,
                      error: lastResult.error ?? null,
                    }} />
                  </div>
                )}

                {/* Run history for selected skill */}
                {selectedSkillId === skill.id && runs.filter((r) => r.skill_id === skill.id).length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Recent runs:</div>
                    {runs
                      .filter((r) => r.skill_id === skill.id)
                      .slice(0, 5)
                      .map((run) => (
                        <div key={run.id} style={{ marginBottom: 4 }}>
                          <RunResult run={run} />
                        </div>
                      ))}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
