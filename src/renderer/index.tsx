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

interface NotificationCounts {
  perOrg: Record<string, number>;   // orgLogin → unread count
  perRepo: Record<string, number>;  // full_name → unread count
  total: number;
  starredTotal: number;
  fetchedAt: string | null;
  error?: string;
}

interface StoredNotification {
  id: string;
  repo_full_name: string;
  repo_owner: string;
  subject_type: string;
  subject_title: string;
  subject_url: string | null;
  reason: string;
  unread: number;
  updated_at: string;
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
    fetchNotifications(): Promise<NotificationCounts>;
    getNotificationCounts(): Promise<NotificationCounts>;
    fetchNotificationsForOwner(owner: string): Promise<NotificationCounts>;
    fetchNotificationsForRepo(repoFullName: string): Promise<NotificationCounts>;
    listNotificationsForRepo(repoFullName: string): Promise<StoredNotification[]>;
    listNotificationsForOwner(owner: string): Promise<StoredNotification[]>;
    listNotificationsForStarred(): Promise<StoredNotification[]>;
    getRunUrlForCheckSuite(checkSuiteApiUrl: string): Promise<string | null>;
    getPreferences(): Promise<{ sortByNotifications: boolean }>;
    setPreferences(prefs: { sortByNotifications?: boolean }): Promise<{ ok: boolean }>;
    onOpenChat(cb: () => void): void;
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

function RepoCard({ repo, showOwner, notifCount, onClick, onNotifClick }: { repo: Repo; showOwner?: boolean; notifCount?: number; onClick: () => void; onNotifClick?: (e: MouseEvent) => void }) {
  const owner = repo.full_name.split('/')[0];
  return (
    <div class="repo-card" onClick={onClick}>
      <div class="repo-card-name" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>
          {showOwner && <span class="repo-card-owner">{owner} / </span>}
          {repo.name}
        </span>
        {notifCount != null && notifCount > 0 && (
          <span
            class="notif-badge"
            title={`${notifCount} unread notification${notifCount !== 1 ? 's' : ''} — click to view`}
            onClick={onNotifClick}
          >
            {notifCount}
          </span>
        )}
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
  notifCounts,
  notifFetching,
  sortByNotifs,
  currentUserLogin,
  onSelectOrg,
  onNotifDive,
  onSortToggle,
  onRefresh,
}: {
  orgs: Org[];
  directRepoCount: number;
  starredRepoCount: number;
  activeOrg: string | null;
  notifCounts: NotificationCounts | null;
  notifFetching: boolean;
  sortByNotifs: boolean;
  currentUserLogin: string | null;
  onSelectOrg: (orgLogin: string | null, displayName: string) => void;
  onNotifDive: (owner: string, displayName: string, kind: 'owner' | 'starred') => void;
  onSortToggle: () => void;
  onRefresh: () => void;
}) {
  const sorted = sortByNotifs && notifCounts
    ? [...orgs].sort((a, b) => {
        const na = notifCounts.perOrg[a.login] ?? 0;
        const nb = notifCounts.perOrg[b.login] ?? 0;
        return nb - na || a.login.localeCompare(b.login);
      })
    : orgs;

  const personalCount = currentUserLogin ? (notifCounts?.perOrg[currentUserLogin] ?? 0) : 0;
  const starredCount = notifCounts?.starredTotal ?? 0;
  const totalNotifs = notifCounts?.total ?? 0;
  const fetchedAt = notifCounts?.fetchedAt ?? null;

  return (
    <div class="org-panel">
      {/* ── Panel header with aggregate notif summary ── */}
      <div class="org-panel-header" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.6rem' }}>
        <span style={{ fontWeight: 700 }}>Organizations</span>
        <span style={{ flex: 1 }} />
        {notifFetching && (
          <span style={{ fontSize: '0.7rem', color: '#667', fontStyle: 'italic' }}>refreshing…</span>
        )}
        {!notifFetching && fetchedAt && (
          <span style={{ fontSize: '0.7rem', color: '#556' }} title={`Last refreshed ${new Date(fetchedAt).toLocaleTimeString()}`}>
            {new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        <span
          class={`notif-refresh-btn${notifFetching ? ' notif-refresh-btn-spinning' : ''}`}
          title={notifFetching ? 'Refreshing…' : 'Refresh notifications'}
          onClick={notifFetching ? undefined : onRefresh}
        >{'↻'}</span>
        {totalNotifs > 0 && (
          <span
            class={`notif-badge notif-badge-large notif-badge-clickable${sortByNotifs ? ' notif-badge-active' : ''}`}
            title={sortByNotifs ? 'Sorting by notifications — click to reset' : `${totalNotifs} unread — click to sort`}
            onClick={onSortToggle}
          >
            {'\uD83D\uDD14'} {totalNotifs}
          </span>
        )}
        {totalNotifs === 0 && notifCounts !== null && !notifFetching && (
          <span style={{ fontSize: '0.72rem', color: '#556' }}>{'\u2714\uFE0F'}</span>
        )}
      </div>

      <div class="org-list">
        {sorted.map((org) => {
          const nc = notifCounts?.perOrg[org.login] ?? 0;
          return (
            <div
              key={org.login}
              class={`org-item${activeOrg === org.login ? ' active' : ''}`}
              onClick={() => onSelectOrg(org.login, org.login)}
            >
              <span class="org-label">{org.login}</span>
              <span class="org-meta-combined">
                {nc > 0 && (
                  <span
                    class="notif-badge notif-badge-clickable"
                    title={`${nc} unread — click to view`}
                    onClick={(e: MouseEvent) => { e.stopPropagation(); onNotifDive(org.login, org.login, 'owner'); }}
                  >
                    {nc}
                  </span>
                )}
                <span class="org-repos-count">{org.repoCount.toLocaleString()} repo{org.repoCount !== 1 ? 's' : ''}</span>
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
          );
        })}

        {directRepoCount > 0 && (
          <div
            class={`org-item${activeOrg === '__direct__' ? ' active' : ''}`}
            onClick={() => onSelectOrg(null, 'Personal & collaborator')}
          >
            <span class="org-label" style={{ fontStyle: 'italic' }}>{'\uD83D\uDC64 Personal'}</span>
            <span class="org-meta-combined">
              {personalCount > 0 && (
                <span
                  class="notif-badge notif-badge-clickable"
                  title={`${personalCount} unread — click to view`}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    if (currentUserLogin) onNotifDive(currentUserLogin, 'Personal', 'owner');
                  }}
                >
                  {personalCount}
                </span>
              )}
              <span class="org-repos-count">{directRepoCount.toLocaleString()} repo{directRepoCount !== 1 ? 's' : ''}</span>
            </span>
          </div>
        )}

        {starredRepoCount > 0 && (
          <div
            class={`org-item${activeOrg === '__starred__' ? ' active' : ''}`}
            onClick={() => onSelectOrg('__starred__', '\u2B50 Starred')}
          >
            <span class="org-label" style={{ fontStyle: 'italic' }}>{'\u2B50 Starred'}</span>
            <span class="org-meta-combined">
              {starredCount > 0 && (
                <span
                  class="notif-badge notif-badge-clickable"
                  title={`${starredCount} unread — click to view`}
                  onClick={(e: MouseEvent) => { e.stopPropagation(); onNotifDive('', '\u2B50 Starred', 'starred'); }}
                >
                  {starredCount}
                </span>
              )}
              <span class="org-repos-count">{starredRepoCount.toLocaleString()} repo{starredRepoCount !== 1 ? 's' : ''}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Org-level notifications drill-down ───────────────────────────────────────

function OrgNotifPanel({
  title,
  notifications,
  loading,
  onClose,
  onRefresh,
  refreshing,
}: {
  title: string;
  notifications: StoredNotification[];
  loading: boolean;
  onClose: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const typeIcon: Record<string, string> = {
    Issue: '\uD83D\uDC1B',
    PullRequest: '\uD83D\uDD00',
    Release: '\uD83C\uDF89',
    Commit: '\uD83D\uDCBE',
    Discussion: '\uD83D\uDCAC',
    CheckSuite: '\u2705',
  };
  // Group by repo
  const groups: Map<string, StoredNotification[]> = new Map();
  for (const n of notifications) {
    if (!groups.has(n.repo_full_name)) groups.set(n.repo_full_name, []);
    groups.get(n.repo_full_name)!.push(n);
  }

  const openUrl = async (n: StoredNotification) => {
    if (n.subject_type === 'CheckSuite' && n.subject_url) {
      const runUrl = await window.jarvis.getRunUrlForCheckSuite(n.subject_url);
      window.jarvis.openUrl(runUrl ?? `https://github.com/${n.repo_full_name}/actions`);
      return;
    }
    const url = n.subject_url
      ? n.subject_url
          .replace('https://api.github.com/repos/', 'https://github.com/')
          .replace(/\/pulls\/(\d+)$/, '/pull/$1')
          .replace(/\/issues\/(\d+)$/, '/issues/$1')
          .replace(/\/commits\/([a-f0-9]+)$/, '/commit/$1')
          .replace(/\/releases\/(\d+)$/, '/releases')
      : `https://github.com/${n.repo_full_name}`;
    window.jarvis.openUrl(url);
  };

  return (
    <div class="repo-panel">
      <div class="repo-panel-header">
        <span class="repo-panel-title">
          {'\uD83D\uDD14'} {title}
          {!loading && notifications.length > 0 && (
            <span class="notif-badge notif-badge-large" style={{ marginLeft: '0.4rem' }}>
              {notifications.length}
            </span>
          )}
        </span>
        {onRefresh && (
          <span
            class={`notif-refresh-btn${refreshing ? ' notif-refresh-btn-spinning' : ''}`}
            title={refreshing ? 'Refreshing\u2026' : 'Refresh notifications'}
            onClick={refreshing ? undefined : onRefresh}
          >{'\u21bb'}</span>
        )}
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>

      {loading && (
        <div style={{ color: '#99a', fontSize: '0.85rem', padding: '0.5rem' }}>Loading…</div>
      )}

      {!loading && notifications.length === 0 && (
        <div style={{ color: '#99a', fontSize: '0.85rem', padding: '0.5rem' }}>No unread notifications</div>
      )}

      {!loading && Array.from(groups.entries()).map(([repoFullName, items]) => (
        <div key={repoFullName} style={{ marginBottom: '0.5rem' }}>
          {/* Repo header row — same style as org-item */}
          <div
            class="org-item"
            style={{ borderRadius: '6px 6px 0 0', marginBottom: 0, cursor: 'pointer' }}
            onClick={() => window.jarvis.openUrl('https://github.com/' + repoFullName)}
          >
            <span class="org-label">{repoFullName.split('/')[1]}</span>
            <span class="notif-badge">{items.length}</span>
          </div>
          {/* Individual notifications */}
          {items.map((n) => (
            <div
              key={n.id}
              class="org-item"
              style={{ borderRadius: 0, marginBottom: 0, borderTop: '1px solid #0a1f3e', flexDirection: 'column', alignItems: 'flex-start', gap: '0.25rem', cursor: 'pointer' }}
              onClick={() => openUrl(n)}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', width: '100%' }}>
                <span style={{ flexShrink: 0 }}>{typeIcon[n.subject_type] ?? '\u2022'}</span>
                <span class="org-label" style={{ flex: 1, fontWeight: 500, whiteSpace: 'normal', lineHeight: 1.35 }}>{n.subject_title}</span>
                <span class={isDirect(n.reason) ? 'notif-involvement-direct' : 'notif-involvement-following'}>
                  {isDirect(n.reason) ? 'involved' : 'following'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap', paddingLeft: '1.4rem' }}>
                <span class="repo-card-badge">{notifDescription(n.subject_type, n.reason)}</span>
                <span class="repo-card-date">{relativeAge(n.updated_at)}</span>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Repo detail panel ────────────────────────────────────────────────────────

function RepoPanelView({
  title,
  repos,
  loading,
  orgLogin,
  currentUserLogin,
  notifCounts,
  sortByNotifs,
  onSortToggle,
  onClose,
  onOpenRepoNotif,
  onRefreshAll,
  refreshingAll,
}: {
  title: string;
  repos: Repo[];
  loading: boolean;
  orgLogin: string | null;
  currentUserLogin: string | null;
  notifCounts: NotificationCounts | null;
  sortByNotifs: boolean;
  onSortToggle: () => void;
  onClose: () => void;
  onOpenRepoNotif: (repoFullName: string) => void;
  onRefreshAll?: () => void;
  refreshingAll?: boolean;
}) {
  const [hideMyRepos, setHideMyRepos] = useState(true);

  const showFilter = orgLogin === null;
  const showOwner = orgLogin === null || orgLogin === '__starred__';

  let filteredRepos =
    showFilter && hideMyRepos && currentUserLogin
      ? repos.filter((r) => !r.full_name.startsWith(currentUserLogin + '/'))
      : repos;

  if (sortByNotifs && notifCounts) {
    filteredRepos = [...filteredRepos].sort((a, b) => {
      const na = notifCounts.perRepo[a.full_name] ?? 0;
      const nb = notifCounts.perRepo[b.full_name] ?? 0;
      return nb - na;
    });
  }

  const openNotifPanel = (repoFullName: string) => {
    onOpenRepoNotif(repoFullName);
  };

  const repoNotifTotal = notifCounts
    ? filteredRepos.reduce((s, r) => s + (notifCounts.perRepo[r.full_name] ?? 0), 0)
    : 0;

  return (
    <div class="repo-panel">
      <div class="repo-panel-header">
        <span class="repo-panel-title">{title}</span>
        <span style={{ flex: 1 }} />
        {onRefreshAll && notifCounts && repoNotifTotal > 0 && (
          <span
            class={`notif-refresh-btn${refreshingAll ? ' notif-refresh-btn-spinning' : ''}`}
            title={refreshingAll ? 'Refreshing…' : 'Refresh notifications'}
            onClick={refreshingAll ? undefined : onRefreshAll}
          >{'↻'}</span>
        )}
        {notifCounts && repoNotifTotal > 0 && (
          <span
            class={`notif-badge notif-badge-clickable${sortByNotifs ? ' notif-badge-active' : ''}`}
            title={sortByNotifs ? 'Sorting by notifications — click to reset' : `${repoNotifTotal} unread — click to sort`}
            onClick={onSortToggle}
          >
            {'\uD83D\uDD14'} {repoNotifTotal}
          </span>
        )}
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
      {loading && (
        <div class="repo-panel-loading">
          <span class="repo-panel-spinner" />{' '}Loading repositories…
        </div>
      )}
      {!loading && (
        filteredRepos.length === 0 ? (
          <div style={{ color: '#99a', fontSize: '0.85rem', padding: '0.5rem' }}>
            {repos.length === 0 ? 'No repositories found' : 'No repositories (all filtered)'}
          </div>
        ) : (
          filteredRepos.map((repo) => {
            const nc = notifCounts?.perRepo[repo.full_name] ?? 0;
            return (
              <RepoCard
                key={repo.full_name}
                repo={repo}
                showOwner={showOwner}
                notifCount={nc}
                onClick={nc > 0
                  ? () => void openNotifPanel(repo.full_name)
                  : () => window.jarvis.openUrl('https://github.com/' + repo.full_name)}
                onNotifClick={nc > 0 ? (e: MouseEvent) => { e.stopPropagation(); void openNotifPanel(repo.full_name); } : undefined}
              />
            );
          })
        )
      )}
    </div>
  );
}

// ── Notification list helpers ─────────────────────────────────────────────────

function relativeAge(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

function notifDescription(type: string, reason: string): string {
  if (reason === 'assign') return type === 'PullRequest' ? 'PR assigned to you' : 'Issue assigned to you';
  if (reason === 'review_requested') return 'PR review requested';
  if (reason === 'mention') return `@mentioned in ${type === 'PullRequest' ? 'PR' : type.toLowerCase()}`;
  if (reason === 'team_mention') return `Team @mentioned in ${type === 'PullRequest' ? 'PR' : type.toLowerCase()}`;
  if (reason === 'author') return `Your ${type === 'PullRequest' ? 'PR' : type.toLowerCase()} has activity`;
  if (reason === 'comment') return `Comment on ${type === 'PullRequest' ? 'PR' : type.toLowerCase()}`;
  if (reason === 'subscribed') return `Watched ${type === 'PullRequest' ? 'PR' : type.toLowerCase()} updated`;
  if (reason === 'state_change') return `${type === 'PullRequest' ? 'PR' : type} state changed`;
  if (reason === 'ci_activity') return 'CI activity';
  if (reason === 'security_alert') return '\u26A0\uFE0F Security alert';
  return `${type} \u2014 ${reason}`;
}

function isDirect(reason: string): boolean {
  return ['assign', 'review_requested', 'mention', 'team_mention', 'author', 'security_alert'].includes(reason);
}

// ── Notification list for a single repo ──────────────────────────────────────

function NotifRepoPanel({
  repoFullName,
  notifications,
  onClose,
  onRefresh,
  refreshing,
}: {
  repoFullName: string;
  notifications: StoredNotification[];
  onClose: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const typeIcon: Record<string, string> = {
    Issue: '\uD83D\uDC1B',
    PullRequest: '\uD83D\uDD00',
    Release: '\uD83C\uDF89',
    Commit: '\uD83D\uDCBE',
    Discussion: '\uD83D\uDCAC',
    CheckSuite: '\u2705',
  };

  const openUrl = async (n: StoredNotification) => {
    // CheckSuite: look up the specific workflow run URL via the API
    if (n.subject_type === 'CheckSuite') {
      if (n.subject_url) {
        const runUrl = await window.jarvis.getRunUrlForCheckSuite(n.subject_url);
        window.jarvis.openUrl(runUrl ?? `https://github.com/${n.repo_full_name}/actions`);
      } else {
        window.jarvis.openUrl(`https://github.com/${n.repo_full_name}/actions`);
      }
      return;
    }
    // WorkflowRun: API URL maps directly to the html run page after base substitution
    if (n.subject_type === 'WorkflowRun') {
      const url = n.subject_url
        ? n.subject_url.replace('https://api.github.com/repos/', 'https://github.com/')
        : `https://github.com/${n.repo_full_name}/actions`;
      window.jarvis.openUrl(url);
      return;
    }
    const url = n.subject_url
      ? n.subject_url
          .replace('https://api.github.com/repos/', 'https://github.com/')
          .replace(/\/pulls\/(\d+)$/, '/pull/$1')
          .replace(/\/issues\/(\d+)$/, '/issues/$1')
          .replace(/\/commits\/([a-f0-9]+)$/, '/commit/$1')
          .replace(/\/releases\/(\d+)$/, '/releases')
      : `https://github.com/${n.repo_full_name}`;
    window.jarvis.openUrl(url);
  };

  return (
    <div class="repo-panel">
      <div class="repo-panel-header">
        <span class="repo-panel-title">{repoFullName.split('/')[1]}</span>
        <span style={{ flex: 1 }} />
        {onRefresh && (
          <span
            class={`notif-refresh-btn${refreshing ? ' notif-refresh-btn-spinning' : ''}`}
            title={refreshing ? 'Refreshing…' : 'Refresh notifications for this repo'}
            onClick={refreshing ? undefined : onRefresh}
          >{'↻'}</span>
        )}
        <span class="notif-badge notif-badge-large">{notifications.length}</span>
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>
      {notifications.map((n) => (
        <div
          key={n.id}
          class="org-item"
          style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '0.25rem', cursor: 'pointer' }}
          onClick={() => openUrl(n)}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', width: '100%' }}>
            <span style={{ flexShrink: 0 }}>{typeIcon[n.subject_type] ?? '\u2022'}</span>
            <span class="org-label" style={{ flex: 1, fontWeight: 500, whiteSpace: 'normal', lineHeight: 1.35 }}>{n.subject_title}</span>
            <span class={isDirect(n.reason) ? 'notif-involvement-direct' : 'notif-involvement-following'}>
              {isDirect(n.reason) ? 'involved' : 'following'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap', paddingLeft: '1.4rem' }}>
            <span class="repo-card-badge">{notifDescription(n.subject_type, n.reason)}</span>
            <span class="repo-card-date">{relativeAge(n.updated_at)}</span>
          </div>
        </div>
      ))}
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const registeredRef = useRef(false);

  const handlePanelClick = (e: MouseEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'BUTTON' || tag === 'TEXTAREA' || tag === 'A') return;
    inputRef.current?.focus();
  };
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
      localStorage.setItem('chat-panel-width', String(newW));
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleClose = () => {
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
    <div class={`ec-panel${visible ? '' : ' ec-panel-hidden'}`} style={{ width: `${panelWidth}px` }} onClick={handlePanelClick}>
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
          ref={inputRef}
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
    loading: boolean;
  } | null>(null);
  const [activeOrg, setActiveOrg] = useState<string | null>(null);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [showOllamaPanel, setShowOllamaPanel] = useState(false);
  const [selectedOllamaModel, setSelectedOllamaModel] = useState<string | null>(null);
  const [showChatPanel, setShowChatPanel] = useState(false);
  const [notifCounts, setNotifCounts] = useState<NotificationCounts | null>(null);
  const [notifFetching, setNotifFetching] = useState(false);
  const [sortByNotifs, setSortByNotifs] = useState(false);
  const [notifDive, setNotifDive] = useState<{
    title: string;
    owner: string;
    kind: 'owner' | 'starred';
    notifications: StoredNotification[];
    loading: boolean;
  } | null>(null);
  const [notifRepoPanel, setNotifRepoPanel] = useState<{
    repoFullName: string;
    notifications: StoredNotification[];
  } | null>(null);
  const [refreshingOwners, setRefreshingOwners] = useState<Set<string>>(new Set());
  const [refreshingRepos, setRefreshingRepos] = useState<Set<string>>(new Set());

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
          // Load cached notification counts from DB; auto-fetch if nothing cached
          try {
            const counts = await window.jarvis.getNotificationCounts();
            setNotifCounts(counts);
            if (!counts.fetchedAt) {
              setNotifFetching(true);
              try {
                const fresh = await window.jarvis.fetchNotifications();
                setNotifCounts(fresh);
              } catch (fe) {
                console.warn('[Jarvis] Auto-fetch notifications failed:', fe);
              } finally {
                setNotifFetching(false);
              }
            }
          } catch (e) {
            console.warn('[Jarvis] Could not load notification counts:', e);
          }
          // Load sort preference
          try {
            const prefs = await window.jarvis.getPreferences();
            setSortByNotifs(prefs.sortByNotifications ?? false);
          } catch (e) {
            console.warn('[Jarvis] Could not load preferences:', e);
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
          setShowChatPanel(true);
          localStorage.setItem('chat-panel-open', 'true');
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
      setShowChatPanel(true);
      localStorage.setItem('chat-panel-open', 'true');
    }
  };

  // IPC listeners
  useEffect(() => {
    window.jarvis.onOpenChat(handleOpenChat);
  }, []); // run once: registers the IPC listener on mount

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

  // Auto-resize Electron window when panels open/close
  useEffect(() => {
    if (showOrgPanel && oauthStatus?.authenticated) {
      window.jarvis.listOrgs().then(setOrgData).catch(console.error);
    }
  }, [showOrgPanel, discoveryFinished, oauthStatus?.authenticated]);

  const doFetchNotifications = useCallback(async () => {
    if (!oauthStatus?.authenticated) return;
    setNotifFetching(true);
    try {
      const counts = await window.jarvis.fetchNotifications();
      setNotifCounts(counts);
    } catch (err) {
      console.error('[Jarvis] Failed to fetch notifications:', err);
    } finally {
      setNotifFetching(false);
    }
  }, [oauthStatus?.authenticated]);

  const handleRefreshOwner = useCallback(async (owner: string) => {
    if (!oauthStatus?.authenticated) return;
    setRefreshingOwners((prev) => new Set(prev).add(owner));
    try {
      const counts = await window.jarvis.fetchNotificationsForOwner(owner);
      setNotifCounts(counts);
    } catch (err) {
      console.error('[Jarvis] Failed to refresh owner notifications:', err);
    } finally {
      setRefreshingOwners((prev) => { const s = new Set(prev); s.delete(owner); return s; });
    }
  }, [oauthStatus?.authenticated]);

  const handleRefreshRepo = useCallback(async (repoFullName: string) => {
    if (!oauthStatus?.authenticated) return;
    setRefreshingRepos((prev) => new Set(prev).add(repoFullName));
    try {
      const counts = await window.jarvis.fetchNotificationsForRepo(repoFullName);
      setNotifCounts(counts);
    } catch (err) {
      console.error('[Jarvis] Failed to refresh repo notifications:', err);
    } finally {
      setRefreshingRepos((prev) => { const s = new Set(prev); s.delete(repoFullName); return s; });
    }
  }, [oauthStatus?.authenticated]);

  // 5-minute auto-refresh timer
  useEffect(() => {
    if (!oauthStatus?.authenticated) return;
    const id = window.setInterval(() => { void doFetchNotifications(); }, 5 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [oauthStatus?.authenticated, doFetchNotifications]);

  // Keep refs so the effect below can always read the latest panel state
  // without adding them to the dependency array (which would re-fire on every
  // panel interaction rather than only when the underlying data changes).
  const notifDiveRef = useRef(notifDive);
  useEffect(() => { notifDiveRef.current = notifDive; }, [notifDive]);
  const notifRepoPanelRef = useRef(notifRepoPanel);
  useEffect(() => { notifRepoPanelRef.current = notifRepoPanel; }, [notifRepoPanel]);

  // When notifCounts changes (any refresh), re-read the DB for open panels so
  // their list + header counter stays in sync with the updated counts.
  useEffect(() => {
    const dive = notifDiveRef.current;
    const repoPanel = notifRepoPanelRef.current;
    void (async () => {
      if (dive && !dive.loading) {
        try {
          const notifications = dive.kind === 'starred'
            ? await window.jarvis.listNotificationsForStarred()
            : await window.jarvis.listNotificationsForOwner(dive.owner);
          setNotifDive((prev) => prev ? { ...prev, notifications } : null);
        } catch { /* ignore */ }
      }
      if (repoPanel) {
        try {
          const notifications = await window.jarvis.listNotificationsForRepo(repoPanel.repoFullName);
          setNotifRepoPanel((prev) => prev ? { ...prev, notifications } : null);
        } catch { /* ignore */ }
      }
    })();
  }, [notifCounts]);

  const handleSortToggle = async () => {
    const next = !sortByNotifs;
    setSortByNotifs(next);
    try {
      await window.jarvis.setPreferences({ sortByNotifications: next });
    } catch (e) {
      console.warn('[Jarvis] Could not save sort preference:', e);
    }
  };

  const handleNotifDive = async (
    owner: string,
    displayName: string,
    kind: 'owner' | 'starred',
  ) => {
    // Show notif dive alongside any open repo panel
    setNotifDive({ title: displayName, owner, kind, notifications: [], loading: true });
    try {
      const notifications =
        kind === 'starred'
          ? await window.jarvis.listNotificationsForStarred()
          : await window.jarvis.listNotificationsForOwner(owner);
      setNotifDive({ title: displayName, owner, kind, notifications, loading: false });
    } catch (err) {
      console.error('[Jarvis] Failed to load notifications:', err);
      setNotifDive({ title: displayName, owner, kind, notifications: [], loading: false });
    }
  };

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
    // Show panel immediately with spinner if the org is expected to have many repos
    const orgRepoCount = orgLogin === '__starred__'
      ? (orgData?.starredRepoCount ?? 0)
      : orgLogin === null
        ? (orgData?.directRepoCount ?? 0)
        : (orgData?.orgs.find((o) => o.login === orgLogin)?.repoCount ?? 0);
    const showSpinner = orgRepoCount >= 100;
    if (showSpinner) {
      setRepoPanel({ orgLogin, displayName, repos: [], loading: true });
    }
    try {
      let repos: Repo[];
      if (orgLogin === '__starred__') {
        repos = await window.jarvis.listStarred();
      } else {
        repos = await window.jarvis.listReposForOrg(orgLogin);
      }
      setRepoPanel({ orgLogin, displayName, repos, loading: false });
    } catch (err) {
      console.error('[Jarvis] Failed to load repos:', err);
      setRepoPanel(null);
    }
  };

  const handleCloseRepos = () => {
    setRepoPanel(null);
    setActiveOrg(null);
  };

  return (
    <div class="app-shell">
      <div class="main-scroll">
        {!showChatPanel && selectedOllamaModel && (
          <button class="chat-reopen-btn" title="Open Chat" onClick={handleOpenChat}>💬</button>
        )}
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
            notifCounts={notifCounts}
            notifFetching={notifFetching}
            sortByNotifs={sortByNotifs}
            currentUserLogin={currentUserLogin}
            onSelectOrg={handleSelectOrg}
            onNotifDive={handleNotifDive}
            onSortToggle={handleSortToggle}
            onRefresh={doFetchNotifications}
          />
        )}

        {repoPanel && (
          <RepoPanelView
            title={repoPanel.displayName}
            repos={repoPanel.repos}
            loading={repoPanel.loading}
            orgLogin={repoPanel.orgLogin}
            currentUserLogin={currentUserLogin}
            notifCounts={notifCounts}
            sortByNotifs={sortByNotifs}
            onSortToggle={handleSortToggle}
            onClose={handleCloseRepos}
            onOpenRepoNotif={async (repoFullName) => {
              const notifications = await window.jarvis.listNotificationsForRepo(repoFullName);
              setNotifRepoPanel({ repoFullName, notifications });
            }}
            onRefreshAll={repoPanel.orgLogin !== '__starred__'
              ? () => void handleRefreshOwner(repoPanel.orgLogin ?? (currentUserLogin ?? ''))
              : undefined}
            refreshingAll={repoPanel.orgLogin !== '__starred__' &&
              refreshingOwners.has(repoPanel.orgLogin ?? (currentUserLogin ?? ''))}
          />
        )}

        {notifRepoPanel && (
          <NotifRepoPanel
            repoFullName={notifRepoPanel.repoFullName}
            notifications={notifRepoPanel.notifications}
            onClose={() => setNotifRepoPanel(null)}
            onRefresh={() => void handleRefreshRepo(notifRepoPanel.repoFullName)}
            refreshing={refreshingRepos.has(notifRepoPanel.repoFullName)}
          />
        )}

        {notifDive && (
          <OrgNotifPanel
            title={notifDive.title}
            notifications={notifDive.notifications}
            loading={notifDive.loading}
            onClose={() => setNotifDive(null)}
            onRefresh={() => void handleNotifDive(notifDive.owner, notifDive.title, notifDive.kind)}
            refreshing={notifDive.loading}
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
        onClose={() => { setShowChatPanel(false); localStorage.setItem('chat-panel-open', 'false'); }}
      />
    </div>
  );
}

// ── Mount ────────────────────────────────────────────────────────────────────

document.body.classList.add('onboarding');
const root = document.getElementById('app')!;
render(<App />, root);
