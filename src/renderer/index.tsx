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
import { LocalReposStep } from '../plugins/local-repos/LocalReposStep';
import { LocalFolderConfigPanel } from '../plugins/local-repos/LocalFolderConfigPanel';
import { LocalFolderPanel } from '../plugins/local-repos/LocalFolderPanel';
import { LocalSubfolderPanel } from '../plugins/local-repos/LocalSubfolderPanel';
import { LocalRepoPanelView } from '../plugins/local-repos/LocalRepoPanelView';
import { getReposUnder, hasDeepRepos } from '../plugins/shared/utils';
import { SecretsStep } from '../plugins/secrets/SecretsStep';
import { SecretsScanPanel } from '../plugins/secrets/SecretsScanPanel';
import { DashboardPanel } from '../plugins/dashboard/DashboardPanel';
import { BrowserCompanionPanel } from '../plugins/browser-companion/BrowserCompanionPanel';
import { GroupsStep } from '../plugins/groups/GroupsStep';
import { GroupsPanel } from '../plugins/groups/GroupsPanel';
import { OneNoteSectionPanel } from '../plugins/groups/OneNoteSectionPanel';

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
  LocalRepo,
  ScanFolder,
  LocalScanProgress,
  RepoSecret,
  SecretsScanResult,
  SecretFavorite,
  SecretsScanProgress,
  Group,
} from '../plugins/types';
import '../plugins/types'; // activate the global Window augmentation

type AppTab = 'dashboard' | 'browser' | 'setup';

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
  const [dismissedNotifIds, setDismissedNotifIds] = useState<ReadonlySet<string>>(new Set());
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

  // Local repos state
  const [localFolders, setLocalFolders] = useState<ScanFolder[] | null>(null);
  const [showLocalPanel, setShowLocalPanel] = useState(false);
  const [showLocalConfig, setShowLocalConfig] = useState(false);
  const [localNavStack, setLocalNavStack] = useState<{ path: string; repos: LocalRepo[] }[]>([]);
  const [localLeafFolder, setLocalLeafFolder] = useState<{ path: string; repos: LocalRepo[] } | null>(null);
  const localNavStackRef = useRef<{ path: string; repos: LocalRepo[] }[]>([]);
  const [localNotifRepoPanel, setLocalNotifRepoPanel] = useState<{ repoFullName: string; notifications: StoredNotification[] } | null>(null);
  const [localSortByNotifs, setLocalSortByNotifs] = useState(false);
  const [localRepoSortKey, setLocalRepoSortKey] = useState<'name' | 'scanned' | 'notifs'>('name');
  const [localScanProgress, setLocalScanProgress] = useState<LocalScanProgress | null>(null);
  const [localScanFinished, setLocalScanFinished] = useState(false);
  const [localScanning, setLocalScanning] = useState(false);

  // Secrets state
  const [showSecretsPanel, setShowSecretsPanel] = useState(false);
  const [secretsScanning, setSecretsScanning] = useState(false);
  const [secretsScanned, setSecretsScanned] = useState(false);
  const [secretsLastResult, setSecretsLastResult] = useState<SecretsScanResult | null>(null);
  const [secretsScanProgress, setSecretsScanProgress] = useState<SecretsScanProgress | null>(null);
  const [secretsList, setSecretsList] = useState<RepoSecret[]>([]);
  const [favoritedOrgs, setFavoritedOrgs] = useState<Set<string>>(new Set());
  const [favoritedRepos, setFavoritedRepos] = useState<Set<string>>(new Set());

  // Groups state
  const [groups, setGroups] = useState<Group[]>([]);
  const [showGroupsPanel, setShowGroupsPanel] = useState(false);
  const [oneNoteFilePath, setOneNoteFilePath] = useState<string | null>(null);

  const currentUserLogin = oauthStatus?.login ?? null;

  // Tab state
  const [activeTab, setActiveTab] = useState<AppTab>('dashboard');


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
            setLocalSortByNotifs(prefs.localSortByNotifs ?? false);
            setLocalRepoSortKey((prefs.localRepoSortKey as 'name' | 'scanned' | 'notifs') ?? 'name');
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

  // Local folders check on mount
  useEffect(() => {
    (async () => {
      try {
        const folders = await window.jarvis.localGetFolders();
        setLocalFolders(folders);
        const status = await window.jarvis.localGetScanStatus();
        if (status.running) {
          setLocalScanning(true);
          if (status.progress) setLocalScanProgress(status.progress);
        } else if (status.progress?.phase === 'done') {
          setLocalScanProgress(status.progress);
          setLocalScanFinished(true);
        }
      } catch (err) {
        console.error('[Jarvis] Local folders check failed:', err);
        setLocalFolders([]);
      }
    })();
  }, []);

  // Load persisted secrets from DB on mount + register progress listener
  useEffect(() => {
    const unsubSecrets = window.jarvis.onSecretsProgress((progress: SecretsScanProgress) => {
      setSecretsScanProgress(progress);
    });

    (async () => {
      try {
        const persisted = await window.jarvis.listAllSecrets();
        if (persisted.length > 0) {
          setSecretsList(persisted);
          setSecretsScanned(true);
        }
      } catch (err) {
        console.warn('[Jarvis] Could not load persisted secrets:', err);
      }
      try {
        const favs = await window.jarvis.listSecretFavorites();
        const orgs = new Set(favs.filter((f: SecretFavorite) => f.target_type === 'org').map((f: SecretFavorite) => f.target_name));
        const repos = new Set(favs.filter((f: SecretFavorite) => f.target_type === 'repo').map((f: SecretFavorite) => f.target_name));
        setFavoritedOrgs(orgs);
        setFavoritedRepos(repos);
      } catch (err) {
        console.warn('[Jarvis] Could not load secret favorites:', err);
      }
    })();

    return unsubSecrets;
  }, []);

  // Load groups on mount
  useEffect(() => {
    window.jarvis.groupsList()
      .then(setGroups)
      .catch((err: unknown) => console.warn('[Jarvis] Could not load groups:', err));
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
    return window.jarvis.onOpenChat(handleOpenChat);
  }, []); // run once: registers the IPC listener on mount

  useEffect(() => {
    const unsubOAuth = window.jarvis.onOAuthComplete((result: OAuthResult) => {
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

    const unsubDiscoveryProgress = window.jarvis.onDiscoveryProgress((progress: DiscoveryProgress) => {
      setDiscoveryProgress(progress);
      setDiscoveryFinished(false);
    });

    const unsubDiscoveryComplete = window.jarvis.onDiscoveryComplete((progress: DiscoveryProgress) => {
      setDiscoveryProgress(progress);
      setDiscoveryFinished(true);
    });

    const unsubLocalScanProgress = window.jarvis.onLocalScanProgress((progress: LocalScanProgress) => {
      setLocalScanProgress(progress);
      setLocalScanning(true);
      setLocalScanFinished(false);
    });

    const unsubLocalScanComplete = window.jarvis.onLocalScanComplete((progress: LocalScanProgress) => {
      setLocalScanProgress(progress);
      setLocalScanning(false);
      setLocalScanFinished(true);
      window.jarvis.localGetFolders().then(setLocalFolders).catch(console.error);
      // Reload repos in nav stack so counts stay fresh after scan
      const stack = localNavStackRef.current;
      if (stack.length > 0) {
        window.jarvis.localListReposForFolder(stack[0].path)
          .then((repos) => { setLocalNavStack([{ path: stack[0].path, repos }]); setLocalLeafFolder(null); })
          .catch(console.error);
      }
    });

    return () => {
      unsubOAuth();
      unsubDiscoveryProgress();
      unsubDiscoveryComplete();
      unsubLocalScanProgress();
      unsubLocalScanComplete();
    };
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
  useEffect(() => { localNavStackRef.current = localNavStack; }, [localNavStack]);

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

  // ── Panel mutual-exclusivity ─────────────────────────────────────────────────
  // Clicking any step should close all other steps' panels (detail + sub-panels).
  // This prevents sticky sub-panels when switching between steps.
  const closeAllPanels = () => {
    // GitHub
    setShowOrgPanel(false);
    setRepoPanel(null);
    setActiveOrg(null);
    setNotifRepoPanel(null);
    setNotifDive(null);
    // Local repos
    setShowLocalPanel(false);
    setShowLocalConfig(false);
    setLocalNavStack([]);
    setLocalLeafFolder(null);
    setLocalNotifRepoPanel(null);
    // Secrets
    setShowSecretsPanel(false);
    // Groups
    setShowGroupsPanel(false);
    setOneNoteFilePath(null);
    // Ollama + Chat sub-panel
    setShowOllamaPanel(false);
    setShowChatPanel(false);
    localStorage.setItem('chat-panel-open', 'false');
  };

  const handleToggleOrgs = () => {
    const wasOpen = showOrgPanel;
    closeAllPanels();
    if (!wasOpen) setShowOrgPanel(true);
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

  // ── Local repo handlers ───────────────────────────────────────────────────

  const handleLocalStepClick = () => {
    const wasOpen = showLocalPanel || showLocalConfig;
    closeAllPanels();
    if (!wasOpen) {
      if (localFolders && localFolders.length > 0) {
        setShowLocalPanel(true);
        if (localFolders.length === 1) {
          // Auto-navigate into the single configured folder
          void window.jarvis.localListReposForFolder(localFolders[0].path)
            .then((repos) => setLocalNavStack([{ path: localFolders[0].path, repos }]))
            .catch(console.error);
        }
      } else {
        setShowLocalConfig(true);
        setShowLocalPanel(true);
      }
    }
  };

  const handleLocalAddFolder = async () => {
    const result = await window.jarvis.localAddFolder();
    if (result.canceled || result.error) return;
    const folders = await window.jarvis.localGetFolders();
    setLocalFolders(folders);
  };

  const handleLocalRemoveFolder = async (folderPath: string) => {
    await window.jarvis.localRemoveFolder(folderPath);
    const folders = await window.jarvis.localGetFolders();
    setLocalFolders(folders);
    if (localNavStack.length > 0 && localNavStack[0].path === folderPath) {
      setLocalNavStack([]);
      setLocalLeafFolder(null);
    }
  };

  const handleLocalStartScan = async () => {
    setLocalScanning(true);
    await window.jarvis.localStartScan();
  };

  const handleLocalSelectFolder = async (folderPath: string) => {
    try {
      const repos = await window.jarvis.localListReposForFolder(folderPath);
      setLocalNavStack([{ path: folderPath, repos }]);
      setLocalLeafFolder(null);
    } catch (err) {
      console.error('[Jarvis] Failed to load local repos:', err);
    }
  };

  const handleLocalSubfolderClick = (childPath: string) => {
    const parentRepos = localNavStack[localNavStack.length - 1]?.repos ?? [];
    const childRepos = getReposUnder(childPath, parentRepos);
    if (hasDeepRepos(childPath, childRepos)) {
      setLocalNavStack((prev) => [...prev, { path: childPath, repos: childRepos }]);
      setLocalLeafFolder(null);
    } else {
      setLocalLeafFolder({ path: childPath, repos: childRepos });
    }
  };

  const handleLocalNavBack = () => {
    if (localLeafFolder) {
      setLocalLeafFolder(null);
    } else if (localNavStack.length > 1) {
      setLocalNavStack((prev) => prev.slice(0, -1));
    } else {
      setLocalNavStack([]);
      if ((localFolders?.length ?? 0) <= 1) {
        setShowLocalPanel(false);
      }
    }
  };

  const handleCloseLocalRepos = () => {
    setLocalLeafFolder(null);
    setLocalNotifRepoPanel(null);
  };

  const handleOpenLocalRepoNotif = async (repoFullName: string) => {
    setLocalNotifRepoPanel(null);
    const notifications = await window.jarvis.listNotificationsForRepo(repoFullName);
    setLocalNotifRepoPanel({ repoFullName, notifications });
  };

  const handleOpenLocalConfig = () => {
    setShowLocalConfig(true);
    setLocalNavStack([]);
    setLocalLeafFolder(null);
  };

  const handleCloseLocalConfig = () => {
    setShowLocalConfig(false);
    if (localFolders && localFolders.length > 0) {
      setShowLocalPanel(true);
    }
  };

  // Ref for main-scroll to enable scroll-into-view for right-hand panels
  const mainScrollRef = useRef<HTMLDivElement>(null);

  // Scroll rightmost panel into view when a new right-hand panel is opened
  useEffect(() => {
    if (!mainScrollRef.current) return;
    const main = mainScrollRef.current;
    // Defer until after the DOM has reflowed so scrollWidth is correct
    requestAnimationFrame(() => {
      main.scrollTo({ left: main.scrollWidth, behavior: 'smooth' });
    });
  }, [repoPanel, notifRepoPanel, notifDive, showLocalPanel, showLocalConfig, localNavStack, localLeafFolder, localNotifRepoPanel, showOllamaPanel]);

  // ── Secrets handlers ────────────────────────────────────────────────────────

  const handleSecretsStartScan = async () => {
    setSecretsScanning(true);
    setSecretsLastResult(null);
    setSecretsScanProgress(null);
    try {
      const result = await window.jarvis.scanRepoSecrets();
      setSecretsLastResult(result);
      setSecretsScanned(true);
      // Reload full list after scan
      const allSecrets = await loadAllSecrets();
      setSecretsList(allSecrets);
    } catch (err) {
      setSecretsLastResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSecretsScanning(false);
    }
  };

  const loadAllSecrets = async (): Promise<RepoSecret[]> => {
    try {
      return await window.jarvis.listAllSecrets();
    } catch {
      return [];
    }
  };

  const handleSecretsToggle = () => {
    const wasOpen = showSecretsPanel;
    closeAllPanels();
    if (!wasOpen) setShowSecretsPanel(true);
  };

  const handleGroupsToggle = () => {
    const wasOpen = showGroupsPanel;
    closeAllPanels();
    if (!wasOpen) setShowGroupsPanel(true);
  };

  const handleGroupsClose = async () => {
    setShowGroupsPanel(false);
    setOneNoteFilePath(null);
    // Refresh group list so the step badge stays current
    try {
      const list = await window.jarvis.groupsList();
      setGroups(list);
    } catch (err) {
      console.warn('[Jarvis] Could not refresh groups:', err);
    }
  };

  const handleOllamaToggle = () => {
    const wasOpen = showOllamaPanel;
    closeAllPanels();
    if (!wasOpen) setShowOllamaPanel(true);
  };

  const handleToggleFavoriteOrg = async (orgLogin: string) => {
    if (favoritedOrgs.has(orgLogin)) {
      await window.jarvis.removeSecretFavorite(orgLogin);
      setFavoritedOrgs((prev) => { const next = new Set(prev); next.delete(orgLogin); return next; });
    } else {
      await window.jarvis.addSecretFavorite('org', orgLogin);
      setFavoritedOrgs((prev) => new Set(prev).add(orgLogin));
    }
  };

  const handleToggleFavoriteRepo = async (repoFullName: string) => {
    if (favoritedRepos.has(repoFullName)) {
      await window.jarvis.removeSecretFavorite(repoFullName);
      setFavoritedRepos((prev) => { const next = new Set(prev); next.delete(repoFullName); return next; });
    } else {
      await window.jarvis.addSecretFavorite('repo', repoFullName);
      setFavoritedRepos((prev) => new Set(prev).add(repoFullName));
    }
  };

  return (
    <div class="app-shell">
      <div class="main-scroll" ref={mainScrollRef}>
        {!showChatPanel && selectedOllamaModel && (
          <button class="chat-reopen-btn" title="Open Chat" onClick={handleOpenChat}>💬</button>
        )}
        <div class="container">
      <h1>Jarvis</h1>
      <p class="subtitle">Personal Assistant</p>

      <SearchBar />

      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <div class="tab-bar">
        <button
          class={`tab-btn ${activeTab === 'dashboard' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >📊 Dashboard</button>
        <button
          class={`tab-btn ${activeTab === 'browser' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('browser')}
        >🌐 Browser</button>
        <button
          class={`tab-btn ${activeTab === 'setup' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('setup')}
        >⚙️ Setup</button>
      </div>

      {/* ── Dashboard tab ────────────────────────────────────────────────── */}
      {activeTab === 'dashboard' && (
        <DashboardPanel dismissedNotifIds={dismissedNotifIds} />
      )}

      {/* ── Browser Companion tab ─────────────────────────────────────────── */}
      {activeTab === 'browser' && (
        <BrowserCompanionPanel onBack={() => setActiveTab('dashboard')} />
      )}

      {/* ── Setup tab (original content) ─────────────────────────────────── */}
      {activeTab === 'setup' && (<>

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
            favoritedOrgs={favoritedOrgs}
            onToggleFavoriteOrg={handleToggleFavoriteOrg}
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
            favoritedRepos={favoritedRepos}
            onToggleFavoriteRepo={handleToggleFavoriteRepo}
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

      <div class="local-layout">
        <div class="local-step-wrapper">
          <LocalReposStep
            folders={localFolders}
            scanProgress={localScanProgress}
            scanFinished={localScanFinished}
            onToggle={handleLocalStepClick}
          />
        </div>

        {showLocalConfig && localFolders !== null && (
          <LocalFolderConfigPanel
            folders={localFolders}
            onAdd={handleLocalAddFolder}
            onRemove={handleLocalRemoveFolder}
            onStartScan={handleLocalStartScan}
            onClose={handleCloseLocalConfig}
            scanning={localScanning}
          />
        )}

        {/* Folder list — only shown when multiple folders and not yet drilled in */}
        {showLocalPanel && localFolders !== null && !showLocalConfig && localNavStack.length === 0 && localFolders.length > 1 && (
          <LocalFolderPanel
            folders={localFolders}
            activeFolder={null}
            onSelectFolder={handleLocalSelectFolder}
            onConfigure={handleOpenLocalConfig}
          />
        )}

        {/* Subfolder drill-down panel */}
        {showLocalPanel && !showLocalConfig && localNavStack.length > 0 && (
          <LocalSubfolderPanel
            path={localNavStack[localNavStack.length - 1].path}
            repos={localNavStack[localNavStack.length - 1].repos}
            notifCounts={notifCounts}
            canGoBack={(localFolders?.length ?? 0) > 1 || localNavStack.length > 1}
            initialSortByNotifs={localSortByNotifs}
            onSelectChild={handleLocalSubfolderClick}
            onBack={handleLocalNavBack}
            onConfigure={handleOpenLocalConfig}
            onClearNotif={() => setLocalNotifRepoPanel(null)}
            onSortChange={(v) => { setLocalSortByNotifs(v); void window.jarvis.setPreferences({ localSortByNotifs: v }); }}
          />
        )}

        {localLeafFolder && (
          <LocalRepoPanelView
            title={localLeafFolder.path.split(/[\\/]/).filter(Boolean).pop() ?? localLeafFolder.path}
            repos={localLeafFolder.repos}
            notifCounts={notifCounts}
            initialSortKey={localRepoSortKey}
            onOpenRepoNotif={handleOpenLocalRepoNotif}
            onClearNotif={() => setLocalNotifRepoPanel(null)}
            onSortChange={(k) => { setLocalRepoSortKey(k); void window.jarvis.setPreferences({ localRepoSortKey: k }); }}
            onClose={handleCloseLocalRepos}
          />
        )}

        {localNotifRepoPanel && (
          <NotifRepoPanel
            repoFullName={localNotifRepoPanel.repoFullName}
            notifications={localNotifRepoPanel.notifications}
            onClose={() => setLocalNotifRepoPanel(null)}
            onRefresh={() => void handleRefreshRepo(localNotifRepoPanel.repoFullName)}
            refreshing={refreshingRepos.has(localNotifRepoPanel.repoFullName)}
            onDismiss={(id) => {
              setLocalNotifRepoPanel((prev) => prev ? { ...prev, notifications: prev.notifications.filter((n) => n.id !== id) } : null);
              setNotifCounts((prev) => prev ? { ...prev, total: Math.max(0, prev.total - 1), perRepo: { ...prev.perRepo, [localNotifRepoPanel.repoFullName]: Math.max(0, (prev.perRepo[localNotifRepoPanel.repoFullName] ?? 1) - 1) } } : prev);
            }}
          />
        )}
      </div>

      <div class="secrets-layout">
        <div class="secrets-step-wrapper">
          <SecretsStep
            scanned={secretsScanned}
            scanning={secretsScanning}
            secretCount={secretsList.length}
            repoCount={new Set(secretsList.map((s) => s.full_name)).size}
            onToggle={handleSecretsToggle}
          />
        </div>

        {showSecretsPanel && (
          <SecretsScanPanel
            scanning={secretsScanning}
            scanProgress={secretsScanProgress}
            lastResult={secretsLastResult}
            secrets={secretsList}
            onScan={handleSecretsStartScan}
            onClose={() => setShowSecretsPanel(false)}
          />
        )}
      </div>

      <div class="groups-layout">
        <div class="groups-step-wrapper">
          <GroupsStep groups={groups} onToggle={handleGroupsToggle} />
        </div>

        {showGroupsPanel && (
          <GroupsPanel
            onClose={() => void handleGroupsClose()}
            onOpenOneNote={(path) => setOneNoteFilePath(path)}
          />
        )}

        {oneNoteFilePath && (
          <OneNoteSectionPanel
            filePath={oneNoteFilePath}
            onClose={() => setOneNoteFilePath(null)}
          />
        )}
      </div>

      <div class="ollama-layout">
        <div class="ollama-step-wrapper">
          <OllamaStep ollama={ollamaStatus} selectedModel={selectedOllamaModel} onToggle={handleOllamaToggle} onOpenChat={handleOpenChat} />
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

      </>)}
        </div>
      </div>
      <EmbeddedChatPanel
        visible={showChatPanel}
        selectedModel={selectedOllamaModel}
        onClose={() => { setShowChatPanel(false); localStorage.setItem('chat-panel-open', 'false'); }}
        onAgentStart={handleOpenChat}
        onNotificationsDismissed={(ids) => {
          console.log('[App] onNotificationsDismissed called with ids:', ids);
          const idSet = new Set(ids.map(String));
          setDismissedNotifIds((prev) => {
            const next = new Set(prev);
            for (const id of ids) next.add(String(id));
            console.log('[App] dismissedNotifIds updated, size:', next.size);
            return next;
          });
          const removeIds = (notifs: StoredNotification[]) => notifs.filter((n) => !idSet.has(String(n.id)));
          setNotifRepoPanel((prev) => prev ? { ...prev, notifications: removeIds(prev.notifications) } : null);
          setLocalNotifRepoPanel((prev) => prev ? { ...prev, notifications: removeIds(prev.notifications) } : null);
          setNotifDive((prev) => prev ? { ...prev, notifications: removeIds(prev.notifications) } : null);
          setNotifCounts((prev) => {
            if (!prev) return prev;
            const newPerRepo = { ...prev.perRepo };
            for (const id of ids) {
              const sid = String(id);
              // find which repo owns this notification from current panel state
              const repo =
                notifRepoPanel?.notifications.find((n) => String(n.id) === sid)?.repo_full_name ??
                localNotifRepoPanel?.notifications.find((n) => String(n.id) === sid)?.repo_full_name ??
                notifDive?.notifications.find((n) => String(n.id) === sid)?.repo_full_name;
              if (repo) newPerRepo[repo] = Math.max(0, (newPerRepo[repo] ?? 1) - 1);
            }
            return { ...prev, total: Math.max(0, prev.total - ids.length), perRepo: newPerRepo };
          });
        }}
      />
    </div>
  );
}

// ── Mount ────────────────────────────────────────────────────────────────────

// Guard: only mount once.  During `npm run dev` the esbuild/tsc watchers can
// cause the renderer script to be re-evaluated; without this check each
// execution appends a second Preact tree instead of replacing the first one.
const root = document.getElementById('app')!;
if (!root.dataset.mounted) {
  root.dataset.mounted = '1';
  document.body.classList.add('onboarding');
  render(<App />, root);
}

