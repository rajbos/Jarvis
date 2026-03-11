import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import './onboarding.css';

// ── Types (from preload API) ─────────────────────────────────────────────────

interface OAuthResult {
  error?: string;
  login?: string;
  name?: string;
  avatarUrl?: string;
  userCode?: string;
  verificationUri?: string;
}

interface DiscoveryProgress {
  phase: string;
  orgsFound: number;
  reposFound: number;
  currentOrg?: string;
}

interface OAuthStatus {
  authenticated: boolean;
  login?: string;
  avatarUrl?: string;
}

interface OllamaModel {
  name: string;
  model: string;
  size: number;
  modified_at: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaStatus {
  available: boolean;
  baseUrl: string;
  models: OllamaModel[];
  error?: string;
}

interface Org {
  login: string;
  repoCount: number;
  discoveryEnabled: boolean;
}

interface OrgListResult {
  orgs: Org[];
  directRepoCount: number;
  starredRepoCount: number;
}

interface Repo {
  name: string;
  full_name: string;
  description?: string;
  language?: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  default_branch?: string;
  last_pushed_at?: string;
  parent_full_name?: string;
}

declare const window: Window & {
  jarvis: {
    checkOllama(): Promise<OllamaStatus>;
    listOllamaModels(): Promise<{ available: boolean; models: OllamaModel[]; error?: string }>;
    getSelectedOllamaModel(): Promise<string | null>;
    setSelectedOllamaModel(modelName: string): Promise<{ ok: boolean }>;
    sendChatMessage(messages: Array<{ role: string; content: string }>): Promise<{ ok: boolean }>;
    abortChat(): Promise<{ ok: boolean }>;
    adjustWindowWidth(delta: number): Promise<{ ok: boolean }>;
    onChatToken(cb: (token: string) => void): void;
    onChatDone(cb: () => void): void;
    onChatError(cb: (err: string) => void): void;
    startGitHubOAuth(): Promise<OAuthResult>;
    getGitHubOAuthStatus(): Promise<OAuthStatus>;
    getDiscoveryStatus(): Promise<{ running: boolean; progress?: DiscoveryProgress }>;
    listOrgs(): Promise<OrgListResult>;
    setOrgEnabled(orgLogin: string, enabled: boolean): Promise<void>;
    searchRepos(query: string): Promise<Repo[]>;
    listReposForOrg(orgLogin: string | null): Promise<Repo[]>;
    listStarred(): Promise<Repo[]>;
    openUrl(url: string): Promise<void>;
    onOAuthComplete(cb: (result: OAuthResult) => void): void;
    onDiscoveryProgress(cb: (progress: DiscoveryProgress) => void): void;
    onDiscoveryComplete(cb: (progress: DiscoveryProgress) => void): void;
  };
};

// ── Small components ─────────────────────────────────────────────────────────

function StatusBadge({ status, label }: { status: 'pending' | 'completed' | 'in-progress'; label: string }) {
  return <span class={`status-badge status-${status}`}>{label}</span>;
}

// ── Ollama step (summary row) ─────────────────────────────────────────────────

function OllamaStep({ ollama, selectedModel, onToggle, onOpenChat }: { ollama: OllamaStatus | null; selectedModel: string | null; onToggle: () => void; onOpenChat?: () => void }) {
  let badgeStatus: 'pending' | 'completed' | 'in-progress' = 'in-progress';
  let badgeLabel = 'Checking...';
  let detail = 'Checking for a local Ollama instance…';

  if (ollama !== null) {
    if (ollama.available) {
      badgeStatus = 'completed';
      badgeLabel = 'Connected';
      if (selectedModel) {
        detail = `Active model: ${selectedModel} — click to change`;
      } else {
        detail = `${ollama.models.length} model${ollama.models.length !== 1 ? 's' : ''} available — click to select`;
      }
    } else {
      badgeStatus = 'pending';
      badgeLabel = 'Not found';
      detail = 'Ollama not running. Install and start Ollama to enable local AI features.';
    }
  }

  return (
    <div
      class={`step${ollama?.available ? ' ollama-step-clickable' : ''}`}
      id="ollama-step"
      onClick={ollama?.available ? onToggle : undefined}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
        <h2 style={{ marginBottom: 0 }}>
          Ollama AI <StatusBadge status={badgeStatus} label={badgeLabel} />
        </h2>
        {ollama?.available && (
          <span style={{ color: '#99a', fontSize: '0.8rem' }}>{'›'}</span>
        )}
      </div>
      <div style={{ fontSize: '0.85rem', color: '#aaa' }}>{detail}</div>
      {ollama?.available && selectedModel && (
        <div style={{ marginTop: '0.6rem' }}>
          <button
            style={{ fontSize: '0.78rem', padding: '0.25rem 0.75rem', background: '#0a3d1f', color: '#51cf66', border: '1px solid #2b8a3e', borderRadius: '5px', cursor: 'pointer' }}
            onClick={(e: MouseEvent) => { e.stopPropagation(); onOpenChat?.(); }}
          >
            {'💬 Open Chat'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Ollama panel (side panel) ─────────────────────────────────────────────────

function OllamaPanel({ ollama, selectedModel, onSelectModel, onClose }: {
  ollama: OllamaStatus;
  selectedModel: string | null;
  onSelectModel: (modelName: string) => void;
  onClose: () => void;
}) {
  return (
    <div class="org-panel ollama-panel">
      <div class="org-panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Ollama</span>
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>
      <div style={{ fontSize: '0.82rem', color: '#99aabb', marginBottom: '0.75rem' }}>
        <code style={{ background: '#0f3460', padding: '0.1rem 0.4rem', borderRadius: '3px' }}>
          {ollama.baseUrl}
        </code>
      </div>
      {ollama.models.length === 0 ? (
        <div style={{ color: '#99a', fontSize: '0.85rem' }}>No models found</div>
      ) : (
        <ul class="ollama-model-list">
          {ollama.models.map((m) => {
            const isSelected = selectedModel === m.name;
            return (
              <li key={m.name} class={`ollama-model-item${isSelected ? ' ollama-model-selected' : ''}`}>
                <span class="ollama-model-name">{m.name}</span>
                {m.details?.parameter_size && (
                  <span class="ollama-model-meta">{m.details.parameter_size}</span>
                )}
                {m.details?.quantization_level && (
                  <span class="ollama-model-meta">{m.details.quantization_level}</span>
                )}
                <span class="ollama-model-meta">{(m.size / 1e9).toFixed(1)} GB</span>
                <button
                  class={`ollama-model-select-btn${isSelected ? ' ollama-model-select-btn-active' : ''}`}
                  title={isSelected ? 'Currently selected' : 'Use this model'}
                  onClick={() => onSelectModel(m.name)}
                >
                  {isSelected ? '\u2713 Selected' : 'Use'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RepoCard({ repo, showOwner, onClick }: { repo: Repo; showOwner?: boolean; onClick: () => void }) {
  const owner = repo.full_name.split('/')[0];
  return (
    <div class="repo-card" onClick={onClick}>
      <div class="repo-card-name">
        {showOwner && <span class="repo-card-owner">{owner} / </span>}
        {repo.name}
      </div>
      {repo.description && <div class="repo-card-desc">{repo.description}</div>}
      <div class="repo-card-meta">
        {repo.language && <span class="repo-card-lang">{repo.language}</span>}
        {!!repo.private && <span class="repo-card-badge">private</span>}
        {!!repo.fork && <span class="repo-card-badge">fork</span>}
        {!!repo.fork && repo.parent_full_name && (
          <span class="repo-card-date">{'\u2190 ' + repo.parent_full_name}</span>
        )}
        {!!repo.archived && <span class="repo-card-badge">archived</span>}
        {repo.default_branch && <span class="repo-card-date">{repo.default_branch}</span>}
        {repo.last_pushed_at && (
          <span class="repo-card-date">
            pushed {new Date(repo.last_pushed_at).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Search bar component ─────────────────────────────────────────────────────

function SearchBar() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Repo[] | null>(null);
  const [showResults, setShowResults] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number>();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  const onInput = useCallback((e: Event) => {
    const q = (e.target as HTMLInputElement).value;
    setQuery(q);
    clearTimeout(timerRef.current);
    if (q.trim().length < 2) {
      setShowResults(false);
      setResults(null);
      return;
    }
    timerRef.current = window.setTimeout(async () => {
      try {
        const r = await window.jarvis.searchRepos(q.trim());
        setResults(r);
        setShowResults(true);
      } catch (err) {
        console.error('[Search]', err);
      }
    }, 200);
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setShowResults(false);
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  return (
    <div class="search-wrap" ref={wrapRef}>
      <span class="search-icon">{'\uD83D\uDD0D'}</span>
      <input
        type="text"
        placeholder={"Search repositories\u2026"}
        autocomplete="off"
        spellcheck={false}
        value={query}
        onInput={onInput}
        onKeyDown={onKeyDown}
      />
      {showResults && (
        <div class="search-results">
          {results && results.length === 0 && (
            <div class="search-empty">No repositories found</div>
          )}
          {results &&
            results.map((repo) => {
              const slash = repo.full_name.indexOf('/');
              const orgPart = slash !== -1 ? repo.full_name.slice(0, slash) : '';
              return (
                <div
                  key={repo.full_name}
                  class="search-result-item"
                  onClick={() => {
                    window.jarvis.openUrl('https://github.com/' + repo.full_name);
                    setShowResults(false);
                  }}
                >
                  <div class="sri-main">
                    <div class="sri-name">{repo.name}</div>
                    <div class="sri-org">{orgPart || 'personal'}</div>
                  </div>
                  <div class="sri-side">
                    {repo.language && <span class="sri-lang">{repo.language}</span>}
                    {!!repo.fork && <span class="sri-badge">fork</span>}
                    {!!repo.archived && <span class="sri-badge">archived</span>}
                    {!!repo.private && <span class="sri-badge">private</span>}
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

// ── Discovery section ────────────────────────────────────────────────────────

function DiscoverySection({
  progress,
  finished,
  onToggleOrgs,
}: {
  progress: DiscoveryProgress | null;
  finished: boolean;
  onToggleOrgs: () => void;
}) {
  let badgeStatus: 'pending' | 'completed' | 'in-progress' = 'in-progress';
  let badgeLabel = 'Starting...';
  let detail = 'Scanning organizations and repositories...';
  const rateLimit = '';

  if (finished || (progress && progress.phase === 'done')) {
    badgeStatus = 'completed';
    badgeLabel = 'Complete';
    const p = progress!;
    detail = `Found ${p.orgsFound.toLocaleString()} org${p.orgsFound !== 1 ? 's' : ''} and ${p.reposFound.toLocaleString()} repo${p.reposFound !== 1 ? 's' : ''}`;
  } else if (progress) {
    badgeStatus = 'in-progress';
    badgeLabel = 'Running';
    const phaseLabels: Record<string, string> = {
      orgs: 'Discovering organizations...',
      repos: `Scanning org repositories... (${progress.reposFound.toLocaleString()} repos so far)`,
      'user-repos': `Scanning personal + collaborator repos... (${progress.reposFound.toLocaleString()} repos so far)`,
      starred: `Fetching starred repos... (${progress.reposFound.toLocaleString()} repos so far)`,
      'pat-repos': progress.currentOrg
        ? `PAT: scanning ${progress.currentOrg}... (${progress.reposFound.toLocaleString()} new repos)`
        : `PAT: scanning collaborator repos... (${progress.reposFound.toLocaleString()} new repos)`,
    };
    detail = phaseLabels[progress.phase] || 'Working...';
    if (progress.orgsFound > 0) {
      detail += ` \u2014 ${progress.orgsFound.toLocaleString()} org${progress.orgsFound !== 1 ? 's' : ''} found`;
    }
  }

  return (
    <div style={{ marginTop: '1rem' }}>
      <div class="discovery-toggle" onClick={onToggleOrgs}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Repository Discovery <span style={{ color: '#99a', fontSize: '0.8rem' }}>{'\u203A'}</span>
          </span>
          <StatusBadge status={badgeStatus} label={badgeLabel} />
        </div>
        <div style={{ fontSize: '0.85rem', color: '#aaa' }}>{detail}</div>
        {rateLimit && <div style={{ fontSize: '0.75rem', color: '#99a', marginTop: '0.25rem' }}>{rateLimit}</div>}
      </div>
    </div>
  );
}

// ── Org panel ────────────────────────────────────────────────────────────────

function OrgPanel({
  orgs,
  directRepoCount,
  starredRepoCount,
  activeOrg,
  onSelectOrg,
}: {
  orgs: Org[];
  directRepoCount: number;
  starredRepoCount: number;
  activeOrg: string | null;
  onSelectOrg: (orgLogin: string | null, displayName: string) => void;
}) {
  return (
    <div class="org-panel">
      <div class="org-panel-header">Organizations</div>
      <div class="org-list">
        {orgs.map((org) => (
          <div
            key={org.login}
            class={`org-item${activeOrg === org.login ? ' active' : ''}`}
            onClick={() => onSelectOrg(org.login, org.login)}
          >
            <span class="org-label">{org.login}</span>
            <span class="org-meta">
              {org.repoCount.toLocaleString()} repo{org.repoCount !== 1 ? 's' : ''}
            </span>
            <label class="toggle" onClick={(e: MouseEvent) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={org.discoveryEnabled}
                onChange={(e: Event) => {
                  e.stopPropagation();
                  window.jarvis.setOrgEnabled(org.login, (e.target as HTMLInputElement).checked);
                }}
              />
              <span class="slider" />
            </label>
          </div>
        ))}
        {directRepoCount > 0 && (
          <div
            class={`org-item${activeOrg === '__direct__' ? ' active' : ''}`}
            onClick={() => onSelectOrg(null, 'Personal & collaborator')}
          >
            <span class="org-label" style={{ fontStyle: 'italic' }}>{'\uD83D\uDC64 Personal & collaborator'}</span>
            <span class="org-meta">
              {directRepoCount.toLocaleString()} repo{directRepoCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}
        {starredRepoCount > 0 && (
          <div
            class={`org-item${activeOrg === '__starred__' ? ' active' : ''}`}
            onClick={() => onSelectOrg('__starred__', '\u2B50 Starred')}
          >
            <span class="org-label" style={{ fontStyle: 'italic' }}>{'\u2B50 Starred'}</span>
            <span class="org-meta">
              {starredRepoCount.toLocaleString()} repo{starredRepoCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Repo detail panel ────────────────────────────────────────────────────────

function RepoPanelView({
  title,
  repos,
  orgLogin,
  currentUserLogin,
  onClose,
}: {
  title: string;
  repos: Repo[];
  orgLogin: string | null;
  currentUserLogin: string | null;
  onClose: () => void;
}) {
  const [hideMyRepos, setHideMyRepos] = useState(true);
  const showFilter = orgLogin === null;
  const showOwner = orgLogin === null || orgLogin === '__starred__';

  const filteredRepos =
    showFilter && hideMyRepos && currentUserLogin
      ? repos.filter((r) => !r.full_name.startsWith(currentUserLogin + '/'))
      : repos;

  return (
    <div class="repo-panel">
      <div class="repo-panel-header">
        <span class="repo-panel-title">{title}</span>
        <button class="repo-panel-close" title="Close" onClick={onClose}>
          &times;
        </button>
      </div>
      {showFilter && (
        <div class="repo-panel-filter">
          <label class="filter-label">
            <input
              type="checkbox"
              checked={hideMyRepos}
              onChange={() => setHideMyRepos(!hideMyRepos)}
            />{' '}
            Hide my repos
          </label>
        </div>
      )}
      {filteredRepos.length === 0 ? (
        <div style={{ color: '#99a', fontSize: '0.85rem', padding: '0.5rem' }}>
          {repos.length === 0 ? 'No repositories found' : 'No repositories (all filtered)'}
        </div>
      ) : (
        filteredRepos.map((repo) => (
          <RepoCard
            key={repo.full_name}
            repo={repo}
            showOwner={showOwner}
            onClick={() => window.jarvis.openUrl('https://github.com/' + repo.full_name)}
          />
        ))
      )}
    </div>
  );
}

// ── GitHub step (OAuth + discovery) ──────────────────────────────────────────

function GitHubStep({
  oauthStatus,
  deviceCode,
  discoveryProgress,
  discoveryFinished,
  onLogin,
  onToggleOrgs,
  loginDisabled,
}: {
  oauthStatus: OAuthStatus | null;
  deviceCode: { userCode: string; verificationUri: string } | null;
  discoveryProgress: DiscoveryProgress | null;
  discoveryFinished: boolean;
  onLogin: () => void;
  onToggleOrgs: () => void;
  loginDisabled: boolean;
}) {
  const authenticated = oauthStatus?.authenticated;
  let badgeStatus: 'pending' | 'completed' | 'in-progress' = 'pending';
  let badgeLabel = 'Pending';
  if (authenticated) {
    badgeStatus = 'completed';
    badgeLabel = 'Connected';
  } else if (deviceCode) {
    badgeStatus = 'in-progress';
    badgeLabel = 'Waiting...';
  }

  return (
    <div class="step" id="github-step">
      <h2>
        GitHub Account <StatusBadge status={badgeStatus} label={badgeLabel} />
      </h2>
      <p>Connect your GitHub account to discover organizations and repositories.</p>

      {!authenticated && !deviceCode && (
        <button onClick={onLogin} disabled={loginDisabled}>
          {loginDisabled ? 'Starting...' : 'Sign in with GitHub'}
        </button>
      )}

      {!authenticated && deviceCode && (
        <div>
          <div class="user-code">{deviceCode.userCode}</div>
          <p class="code-instructions">
            Enter this code at{' '}
            <a href={deviceCode.verificationUri} target="_blank">
              {deviceCode.verificationUri.replace('https://', '')}
            </a>
          </p>
          <p class="code-instructions" style={{ marginTop: '0.5rem' }}>
            Waiting for authorization...
          </p>
        </div>
      )}

      {authenticated && oauthStatus && (
        <div class="user-info">
          {oauthStatus.avatarUrl && <img src={oauthStatus.avatarUrl} alt="avatar" />}
          <div>
            <div class="name">{oauthStatus.login}</div>
            <div class="login">@{oauthStatus.login}</div>
          </div>
        </div>
      )}

      {authenticated && (
        <DiscoverySection
          progress={discoveryProgress}
          finished={discoveryFinished}
          onToggleOrgs={onToggleOrgs}
        />
      )}
    </div>
  );
}

// ── Embedded Chat Panel ───────────────────────────────────────────────────────

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

function renderChatMarkdown(text: string): string {
  let out = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_: string, code: string) =>
    `<pre class="ec-code-block"><code>${code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`,
  );
  out = out.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<span class="ec-inline-code">$1</span>');
  out = out.replace(/^###\s+(.+)$/gm, '<h5 class="ec-heading">$1</h5>');
  out = out.replace(/^##\s+(.+)$/gm, '<h4 class="ec-heading">$1</h4>');
  out = out.replace(/^#\s+(.+)$/gm, '<h3 class="ec-heading">$1</h3>');
  out = out.replace(/\n/g, '<br>');
  return out;
}

function EmbeddedChatPanel({ visible, selectedModel, onClose }: {
  visible: boolean;
  selectedModel: string | null;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const registeredRef = useRef(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem('chat-panel-width');
    return saved ? parseInt(saved, 10) : 380;
  });

  const handleResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: panelWidth };
    const onMove = (mv: MouseEvent) => {
      if (!dragRef.current) return;
      const newW = Math.min(700, Math.max(250, dragRef.current.startWidth + (dragRef.current.startX - mv.clientX)));
      setPanelWidth(newW);
    };
    const onUp = (mv: MouseEvent) => {
      if (!dragRef.current) return;
      const newW = Math.min(700, Math.max(250, dragRef.current.startWidth + (dragRef.current.startX - mv.clientX)));
      const delta = newW - dragRef.current.startWidth;
      if (delta !== 0) void window.jarvis.adjustWindowWidth(delta);
      localStorage.setItem('chat-panel-width', String(newW));
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleClose = () => {
    void window.jarvis.adjustWindowWidth(-panelWidth);
    onClose();
  };

  useEffect(() => {
    if (registeredRef.current) return;
    registeredRef.current = true;
    window.jarvis.onChatToken((token: string) => {
      setStreamText((prev) => prev + token);
    });
    window.jarvis.onChatDone(() => {
      setStreamText((prev) => {
        setMessages((msgs) => [...msgs, { role: 'assistant', content: prev }]);
        return '';
      });
      setStreaming(false);
    });
    window.jarvis.onChatError((err: string) => {
      setError(err);
      setStreaming(false);
      setStreamText('');
    });
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setError(null);
    const newMessages: ChatMsg[] = [...messages, { role: 'user', content: text }];
    setMessages(newMessages);
    setInput('');
    setStreaming(true);
    try {
      await window.jarvis.sendChatMessage(newMessages);
    } catch (e) {
      setError(String(e));
      setStreaming(false);
    }
  }, [input, messages, streaming]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div class={`ec-panel${visible ? '' : ' ec-panel-hidden'}`} style={{ width: `${panelWidth}px` }}>
      <div class="ec-resize-handle" onMouseDown={handleResizeStart} />
      <div class="ec-header">
        <span class="ec-title">Chat</span>
        {selectedModel && <span class="ec-model-badge">{selectedModel.split(':')[0]}</span>}
        <button class="ec-close-btn" title="Close chat" onClick={handleClose}>&times;</button>
      </div>
      <div class="ec-messages">
        {messages.length === 0 && !streaming && (
          <div class="ec-empty">
            {selectedModel
              ? 'Ask anything about your repos, orgs, or starred projects.'
              : 'Select an Ollama model first to start chatting.'}
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} class={`ec-bubble ${msg.role === 'user' ? 'ec-user' : 'ec-assistant'}`}
            dangerouslySetInnerHTML={{ __html: renderChatMarkdown(msg.content) }} />
        ))}
        {streaming && (
          <div class="ec-bubble ec-assistant">
            <span dangerouslySetInnerHTML={{ __html: renderChatMarkdown(streamText) }} />
            <span class="ec-cursor" />
          </div>
        )}
        {error && <div class="ec-error">⚠ {error}</div>}
        <div ref={messagesEndRef} />
      </div>
      <div class="ec-input-row">
        <textarea
          class="ec-input"
          rows={2}
          placeholder={streaming ? 'Waiting…' : 'Ask something…'}
          value={input}
          disabled={streaming || !selectedModel}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
        />
        <button
          class="ec-send"
          disabled={streaming || !input.trim() || !selectedModel}
          onClick={() => void handleSend()}
        >
          {streaming ? '…' : '↑'}
        </button>
      </div>
      {streaming && (
        <div class="ec-hint">
          <button
            style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '0.75rem', padding: '0.25rem' }}
            onClick={() => void window.jarvis.abortChat()}>
            stop
          </button>
        </div>
      )}
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus | null>(null);
  const [deviceCode, setDeviceCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [loginDisabled, setLoginDisabled] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] = useState<DiscoveryProgress | null>(null);
  const [discoveryFinished, setDiscoveryFinished] = useState(false);
  const [showOrgPanel, setShowOrgPanel] = useState(false);
  const [orgData, setOrgData] = useState<OrgListResult | null>(null);
  const [repoPanel, setRepoPanel] = useState<{
    orgLogin: string | null;
    displayName: string;
    repos: Repo[];
  } | null>(null);
  const [activeOrg, setActiveOrg] = useState<string | null>(null);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [showOllamaPanel, setShowOllamaPanel] = useState(false);
  const [selectedOllamaModel, setSelectedOllamaModel] = useState<string | null>(null);
  const [showChatPanel, setShowChatPanel] = useState(false);

  const currentUserLogin = oauthStatus?.login ?? null;

  // Initial status check
  useEffect(() => {
    (async () => {
      try {
        const status = await window.jarvis.getGitHubOAuthStatus();
        if (status.authenticated) {
          setOauthStatus(status);
          const disco = await window.jarvis.getDiscoveryStatus();
          if (disco.running && disco.progress) {
            setDiscoveryProgress(disco.progress);
          } else if (disco.progress?.phase === 'done') {
            setDiscoveryProgress(disco.progress);
            setDiscoveryFinished(true);
          }
        }
      } catch (err) {
        console.error('[Jarvis] Error checking OAuth status:', err);
      }
    })();
  }, []);

  // Ollama status + selected model check on mount
  useEffect(() => {
    window.jarvis.checkOllama()
      .then(setOllamaStatus)
      .catch((err: unknown) => {
        console.error('[Jarvis] Ollama check failed:', err);
        setOllamaStatus({ available: false, baseUrl: 'http://127.0.0.1:11434', models: [], error: String(err) });
      });
    window.jarvis.getSelectedOllamaModel()
      .then((model) => {
        setSelectedOllamaModel(model);
        if (model) {
      const savedWidth = parseInt(localStorage.getItem('chat-panel-width') ?? '380', 10);
        setShowChatPanel(true);
        void window.jarvis.adjustWindowWidth(savedWidth);
        }
      })
      .catch((err: unknown) => console.error('[Jarvis] getSelectedOllamaModel failed:', err));
  }, []);

  const handleSelectOllamaModel = async (modelName: string) => {
    await window.jarvis.setSelectedOllamaModel(modelName);
    setSelectedOllamaModel(modelName);
  };

  const handleOpenChat = () => {
    if (!showChatPanel) {
      const savedWidth = parseInt(localStorage.getItem('chat-panel-width') ?? '380', 10);
      setShowChatPanel(true);
      void window.jarvis.adjustWindowWidth(savedWidth);
    }
  };

  // IPC listeners
  useEffect(() => {
    window.jarvis.onOAuthComplete((result: OAuthResult) => {
      if (result.error) {
        alert('OAuth error: ' + result.error);
        setDeviceCode(null);
        setLoginDisabled(false);
        return;
      }
      setDeviceCode(null);
      setOauthStatus({
        authenticated: true,
        login: result.login,
        avatarUrl: result.avatarUrl,
      });
    });

    window.jarvis.onDiscoveryProgress((progress: DiscoveryProgress) => {
      setDiscoveryProgress(progress);
      setDiscoveryFinished(false);
    });

    window.jarvis.onDiscoveryComplete((progress: DiscoveryProgress) => {
      setDiscoveryProgress(progress);
      setDiscoveryFinished(true);
    });
  }, []);

  // Refresh org list when panel is shown or discovery finishes
  useEffect(() => {
    if (showOrgPanel && oauthStatus?.authenticated) {
      window.jarvis.listOrgs().then(setOrgData).catch(console.error);
    }
  }, [showOrgPanel, discoveryFinished, oauthStatus?.authenticated]);

  const handleLogin = async () => {
    setLoginDisabled(true);
    const result = await window.jarvis.startGitHubOAuth();
    if (result.error) {
      setLoginDisabled(false);
      alert('Error: ' + result.error);
      return;
    }
    setDeviceCode({
      userCode: result.userCode || '',
      verificationUri: result.verificationUri || '',
    });
  };

  const handleToggleOrgs = () => {
    setShowOrgPanel((prev) => !prev);
  };

  const handleSelectOrg = async (orgLogin: string | null, displayName: string) => {
    const key = orgLogin ?? '__direct__';
    setActiveOrg(key);
    try {
      let repos: Repo[];
      if (orgLogin === '__starred__') {
        repos = await window.jarvis.listStarred();
      } else {
        repos = await window.jarvis.listReposForOrg(orgLogin);
      }
      setRepoPanel({ orgLogin, displayName, repos });
    } catch (err) {
      console.error('[Jarvis] Failed to load repos:', err);
    }
  };

  const handleCloseRepos = () => {
    setRepoPanel(null);
    setActiveOrg(null);
  };

  return (
    <div class="app-shell">
      <div class="main-scroll">
        <div class="container">
      <h1>Jarvis</h1>
      <p class="subtitle">Personal Assistant — First Time Setup</p>

      <SearchBar />

      <div class="github-layout">
        <GitHubStep
          oauthStatus={oauthStatus}
          deviceCode={deviceCode}
          discoveryProgress={discoveryProgress}
          discoveryFinished={discoveryFinished}
          onLogin={handleLogin}
          onToggleOrgs={handleToggleOrgs}
          loginDisabled={loginDisabled}
        />

        {showOrgPanel && orgData && (
          <OrgPanel
            orgs={orgData.orgs}
            directRepoCount={orgData.directRepoCount}
            starredRepoCount={orgData.starredRepoCount}
            activeOrg={activeOrg}
            onSelectOrg={handleSelectOrg}
          />
        )}

        {repoPanel && (
          <RepoPanelView
            title={repoPanel.displayName}
            repos={repoPanel.repos}
            orgLogin={repoPanel.orgLogin}
            currentUserLogin={currentUserLogin}
            onClose={handleCloseRepos}
          />
        )}
      </div>

      <div class="step" style={{ opacity: 0.5 }}>
        <h2>
          Local Repositories <StatusBadge status="pending" label="Later" />
        </h2>
        <p>Scan your local directories for Git repositories.</p>
      </div>

      <div class="ollama-layout">
        <div class="ollama-step-wrapper">
          <OllamaStep ollama={ollamaStatus} selectedModel={selectedOllamaModel} onToggle={() => setShowOllamaPanel((p) => !p)} onOpenChat={handleOpenChat} />
        </div>
        {showOllamaPanel && ollamaStatus?.available && (
          <OllamaPanel
            ollama={ollamaStatus}
            selectedModel={selectedOllamaModel}
            onSelectModel={handleSelectOllamaModel}
            onClose={() => setShowOllamaPanel(false)}
          />
        )}
      </div>
        </div>
      </div>
      <EmbeddedChatPanel
        visible={showChatPanel}
        selectedModel={selectedOllamaModel}
        onClose={() => setShowChatPanel(false)}
      />
    </div>
  );
}

// ── Mount ────────────────────────────────────────────────────────────────────

document.body.classList.add('onboarding');
const root = document.getElementById('app')!;
render(<App />, root);
