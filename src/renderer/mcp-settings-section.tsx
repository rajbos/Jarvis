// ── Settings: MCP server section ──────────────────────────────────────────────
// Shows how other MCP clients can connect to this Jarvis instance, with
// copyable config snippets, and the state of the local file index the
// server searches.
import { useEffect, useState } from 'preact/hooks';

export interface McpClientConfigView {
  claudeDesktop: string;
  vscode: string;
  claudeCode: string;
  generic: { command: string; serverScriptPath: string; env: Record<string, string> };
  packaged: boolean;
  serverScriptExists: boolean;
  dbPath: string | null;
  indexPath: string | null;
  indexExists: boolean;
}

export interface IndexProgressView {
  phase: 'indexing' | 'done';
  reposDone: number;
  reposTotal: number;
  filesIndexed: number;
  filesSkipped: number;
  currentRepo?: string;
}

export interface IndexStatusView {
  running: boolean;
  progress: IndexProgressView | null;
  error: string | null;
  indexPath: string | null;
  status: { repoCount: number; fileCount: number; contentCount: number; lastRunAt: string | null } | null;
}

export interface McpSectionApi {
  mcpGetClientConfig(): Promise<McpClientConfigView>;
  localGetIndexStatus(): Promise<IndexStatusView>;
  localStartIndex(): Promise<{ started: boolean }>;
  onLocalIndexProgress(cb: (progress: IndexProgressView) => void): () => void;
  onLocalIndexComplete(cb: (progress: IndexProgressView) => void): () => void;
}

type SnippetKey = 'claudeDesktop' | 'vscode' | 'claudeCode';

const SNIPPET_TABS: Array<{ key: SnippetKey; label: string; where: string }> = [
  { key: 'claudeDesktop', label: 'Claude Desktop', where: '%APPDATA%\\Claude\\claude_desktop_config.json' },
  { key: 'vscode', label: 'VS Code', where: '.vscode/mcp.json (or the user-level mcp.json)' },
  { key: 'claudeCode', label: 'Claude Code', where: 'run once in a terminal' },
];

function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function McpServerSection({ api }: { api: McpSectionApi }) {
  const [config, setConfig] = useState<McpClientConfigView | null>(null);
  const [tab, setTab] = useState<SnippetKey>('claudeDesktop');
  const [copied, setCopied] = useState(false);
  const [index, setIndex] = useState<IndexStatusView | null>(null);
  const [progress, setProgress] = useState<IndexProgressView | null>(null);
  const [starting, setStarting] = useState(false);

  const refreshIndex = () => {
    api.localGetIndexStatus().then(setIndex).catch(() => { /* non-fatal */ });
  };

  useEffect(() => {
    api.mcpGetClientConfig().then(setConfig).catch(() => { /* non-fatal */ });
    refreshIndex();
    const unsubProgress = api.onLocalIndexProgress((p) => setProgress(p));
    const unsubComplete = api.onLocalIndexComplete(() => {
      setProgress(null);
      refreshIndex();
      api.mcpGetClientConfig().then(setConfig).catch(() => { /* non-fatal */ });
    });
    return () => { unsubProgress(); unsubComplete(); };
  }, []);

  const handleCopy = async () => {
    if (!config) return;
    try {
      await navigator.clipboard.writeText(config[tab]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const handleIndexNow = async () => {
    setStarting(true);
    try {
      const res = await api.localStartIndex();
      if (res.started) setProgress({ phase: 'indexing', reposDone: 0, reposTotal: 0, filesIndexed: 0, filesSkipped: 0 });
    } finally {
      setStarting(false);
    }
  };

  const running = Boolean(progress) || Boolean(index?.running);
  const current = SNIPPET_TABS.find((t) => t.key === tab)!;

  return (
    <div class="section">
      <h2>MCP server</h2>
      <p class="hint">
        Other AI clients can read this Jarvis instance's cached data (GitHub repos, local clones and their files,
        notifications, Ruddr budgets, OneNote) through a local <a href="https://modelcontextprotocol.io/" target="_blank" rel="noreferrer">MCP</a> server.
        The client starts the server on demand; it only reads the database and holds no credentials.
      </p>

      {config && !config.serverScriptExists && (
        <p class="pat-error">
          Server script not found at <code>{config.generic.serverScriptPath}</code>.
          {config.packaged ? ' Reinstall Jarvis.' : ' Run `npm run build` first.'}
        </p>
      )}

      <div class="agent-tab-row" style={{ marginTop: '0.6rem' }}>
        {SNIPPET_TABS.map((t) => (
          <button
            key={t.key}
            class={`btn-agent-tab${tab === t.key ? ' active' : ''}`}
            onClick={() => { setTab(t.key); setCopied(false); }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p class="hint" style={{ marginTop: '0.4rem' }}>Paste into <code>{current.where}</code>:</p>
      <pre class="mcp-snippet" id="mcp-snippet">{config ? config[tab] : 'Loading…'}</pre>
      <div class="btn-row" style={{ marginTop: '0.4rem' }}>
        <button class="btn-save" onClick={() => void handleCopy()} disabled={!config}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>

      <h3 class="mcp-subheading">File index</h3>
      <p class="hint">
        The <code>github_search_files</code> tool searches inside the files of every local git clone Jarvis has
        discovered. The index is rebuilt after each local repo scan and stored in <code>{config?.indexPath ?? '…'}</code>.
      </p>
      {index?.status && !running && (
        <p class="hint" id="mcp-index-summary">
          {index.status.repoCount} repos, {index.status.fileCount.toLocaleString()} files
          ({index.status.contentCount.toLocaleString()} with text). Last built: {formatWhen(index.status.lastRunAt)}.
        </p>
      )}
      {index && !index.status && !running && (
        <p class="hint" id="mcp-index-summary">Not built yet. Add a local scan folder and run a scan, or press Index now.</p>
      )}
      {running && (
        <p class="hint" id="mcp-index-progress">
          Indexing… {progress ? `${progress.reposDone}/${progress.reposTotal} repos, ${progress.filesIndexed.toLocaleString()} files updated` : ''}
          {progress?.currentRepo ? ` — ${progress.currentRepo}` : ''}
        </p>
      )}
      {index?.error && <p class="pat-error">Last run failed: {index.error}</p>}
      <div class="btn-row">
        <button class="btn-secondary" onClick={() => void handleIndexNow()} disabled={running || starting}>
          {running ? 'Indexing…' : 'Index now'}
        </button>
      </div>
    </div>
  );
}
