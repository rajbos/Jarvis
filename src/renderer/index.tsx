import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import './onboarding.css';

// ── Plugin components ─────────────────────────────────────────────────────────
// Each panel lives in its own plugin folder. To add a new panel:
//   1. Create src/plugins/<feature>/<Component>.tsx
//   2. Import it here and wire it into the App render below
import { OllamaStep } from '../plugins/ollama/OllamaStep';
import { OllamaPanel } from '../plugins/ollama/OllamaPanel';
import { GitHubStep } from '../plugins/github-auth/GitHubStep';
import { OrgPanel } from '../plugins/orgs/OrgPanel';
import { RepoPanelView } from '../plugins/repos/RepoPanelView';
import { OrgNotifPanel } from '../plugins/notifications/OrgNotifPanel';
import { NotifRepoPanel } from '../plugins/notifications/NotifRepoPanel';
import { EmbeddedChatPanel } from '../plugins/chat/EmbeddedChatPanel';
import { SearchBar } from '../plugins/search/SearchBar';
import { StatusBadge } from '../plugins/shared/StatusBadge';

// ── Types (imported from single source of truth in plugins/types.ts) ─────────
// The global augmentation `Window.jarvis` is declared in plugins/types.ts and
// activated by the import below — no need to re-declare it here.
import type {
  OAuthResult,
  OAuthStatus,
  OllamaStatus,
  OrgListResult,
  NotificationCounts,
  StoredNotification,
  Repo,
  DiscoveryProgress,
} from '../plugins/types';
import '../plugins/types'; // activate the global Window augmentation

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
  const [sortByNotifsRepo, setSortByNotifsRepo] = useState(false);
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
          const savedOpen = localStorage.getItem('chat-panel-open');
          // Default to open if no preference has been saved yet; otherwise respect the saved state
          const shouldOpen = savedOpen !== 'false';
          setShowChatPanel(shouldOpen);
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
    setNotifDive(null);
    setNotifRepoPanel(null);
    setSortByNotifsRepo(false);
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
            sortByNotifs={sortByNotifsRepo}
            onSortToggle={() => setSortByNotifsRepo((v) => !v)}
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
            onDismiss={(id) => {
              setNotifRepoPanel((prev) => prev ? { ...prev, notifications: prev.notifications.filter((n) => n.id !== id) } : null);
              setNotifCounts((prev) => prev ? { ...prev, total: Math.max(0, prev.total - 1), perRepo: { ...prev.perRepo, [notifRepoPanel.repoFullName]: Math.max(0, (prev.perRepo[notifRepoPanel.repoFullName] ?? 1) - 1) } } : prev);
            }}
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
            onDismiss={(id) => {
              setNotifDive((prev) => prev ? { ...prev, notifications: prev.notifications.filter((n) => n.id !== id) } : null);
              setNotifCounts((prev) => prev ? { ...prev, total: Math.max(0, prev.total - 1) } : prev);
            }}
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

