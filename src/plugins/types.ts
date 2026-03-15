// ── Shared types used across plugins and the renderer shell ─────────────────
// This is the single source of truth for domain types.

export interface OAuthResult {
  error?: string;
  login?: string;
  name?: string;
  avatarUrl?: string;
  userCode?: string;
  verificationUri?: string;
}

export interface DiscoveryProgress {
  phase: string;
  orgsFound: number;
  reposFound: number;
  currentOrg?: string;
}

export interface OAuthStatus {
  authenticated: boolean;
  login?: string;
  avatarUrl?: string;
}

export interface OllamaModel {
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

export interface OllamaStatus {
  available: boolean;
  baseUrl: string;
  models: OllamaModel[];
  error?: string;
}

export interface Org {
  login: string;
  repoCount: number;
  discoveryEnabled: boolean;
}

export interface OrgListResult {
  orgs: Org[];
  directRepoCount: number;
  starredRepoCount: number;
}

export interface NotificationCounts {
  perOrg: Record<string, number>;   // orgLogin → unread count
  perRepo: Record<string, number>;  // full_name → unread count
  total: number;
  starredTotal: number;
  fetchedAt: string | null;
  error?: string;
}

export interface StoredNotification {
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

export interface Repo {
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

export interface LocalRemote {
  name: string;
  url: string;
  githubRepoId?: number | null;
}

export interface LocalRepo {
  id: number;
  localPath: string;
  name: string;
  remotes: LocalRemote[];
  discoveredAt: string;
  lastScanned: string | null;
  linkedGithubRepoId: number | null;
}

export interface ScanFolder {
  id: number;
  path: string;
  addedAt: string;
  repoCount?: number;
}

export interface LocalScanProgress {
  phase: 'scanning' | 'done';
  foldersScanned: number;
  reposFound: number;
  currentFolder?: string;
}

// ── Jarvis preload API contract ───────────────────────────────────────────────
// This augments the global Window type so all plugin components get full
// type-checking on window.jarvis calls without re-declaring it everywhere.

export interface JarvisApi {
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
  dismissNotification(id: string): Promise<void>;
  getRunUrlForCheckSuite(checkSuiteApiUrl: string): Promise<string | null>;
  getPreferences(): Promise<{ sortByNotifications: boolean; localSortByNotifs: boolean; localRepoSortKey: string }>;
  setPreferences(prefs: { sortByNotifications?: boolean; localSortByNotifs?: boolean; localRepoSortKey?: string }): Promise<{ ok: boolean }>;
  onOpenChat(cb: () => void): void;
  onOAuthComplete(cb: (result: OAuthResult) => void): void;
  onDiscoveryProgress(cb: (progress: DiscoveryProgress) => void): void;
  onDiscoveryComplete(cb: (progress: DiscoveryProgress) => void): void;
  // Local repos
  localGetFolders(): Promise<ScanFolder[]>;
  localAddFolder(folderPath?: string): Promise<{ ok?: boolean; path?: string; canceled?: boolean; error?: string }>;
  localRemoveFolder(folderPath: string): Promise<{ ok: boolean }>;
  localGetScanStatus(): Promise<{ running: boolean; progress: LocalScanProgress | null }>;
  localStartScan(): Promise<{ started: boolean }>;
  localListRepos(): Promise<LocalRepo[]>;
  localListReposForFolder(folderPath: string): Promise<LocalRepo[]>;
  localLinkRepo(localRepoId: number, githubRepoId: number | null): Promise<{ ok: boolean }>;
  localOpenFolder(folderPath: string): Promise<void>;
  onLocalScanProgress(cb: (progress: LocalScanProgress) => void): void;
  onLocalScanComplete(cb: (progress: LocalScanProgress) => void): void;
}

declare global {
  interface Window {
    jarvis: JarvisApi;
  }
}
