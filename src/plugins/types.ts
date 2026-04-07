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
  collaboration_reason?: string;
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

export interface RepoSecret {
  full_name: string;
  secret_name: string;
  scanned_at: string;
}

export interface SecretFavorite {
  id: number;
  target_type: 'org' | 'repo';
  target_name: string;
  added_at: string;
}

export interface SecretsScanProgress {
  done: number;
  total: number;
  secretsFound: number;
}

export interface SecretsScanResult {
  scanned?: number;
  secretsFound?: number;
  errors?: string[];
  error?: string;
}

export interface LocalScanProgress {
  phase: 'scanning' | 'done';
  foldersScanned: number;
  reposFound: number;
  currentFolder?: string;
}

// ── Agent framework types ─────────────────────────────────────────────────────

export interface AgentDefinition {
  id: number;
  name: string;
  description: string;
  system_prompt: string;
  tools_allowed: string; // JSON array of IPC channel names
  created_at: string;
  updated_at: string;
}

export interface WorkflowRun {
  id: string;
  repo_full_name: string;
  workflow_name: string;
  workflow_id: string;
  head_branch: string;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  run_number: number;
  run_started_at: string;
  updated_at: string;
  html_url: string;
  fetched_at: string;
}

export interface WorkflowJob {
  id: string;
  run_id: string;
  repo_full_name: string;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
  log_excerpt: string | null;
  fetched_at: string;
}

export interface WorkflowRunSummary {
  repo_full_name: string;
  total_runs: number;
  recent_runs: WorkflowRun[];
  jobs_by_run: Record<string, WorkflowJob[]>; // run_id → jobs
}

export interface AgentFinding {
  id: number;
  session_id: number;
  finding_type: 'ignore' | 'investigate' | 'action_required';
  subject: string;
  reason: string;
  pattern: string | null;
  action_type: 'close_notifications' | 'create_issue' | 'clone_repo' | 'none';
  action_data: Record<string, unknown> | null;
  approved: number | null; // null = pending; 1 = approved; 0 = rejected
  approved_at: string | null;
  executed_at: string | null;
  execution_error: string | null;
}

export interface AgentSession {
  id: number;
  agent_id: number;
  agent_name: string;
  scope_type: 'repo' | 'org' | 'global';
  scope_value: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  started_at: string;
  completed_at: string | null;
  summary: string | null;
  findings: AgentFinding[];
}

// ── Dashboard types ───────────────────────────────────────────────────────────

export type HealthWarningKind =
  | 'branch-no-upstream'
  | 'no-remote'
  | 'has-notifications'
  | 'failed-workflows';

export interface HealthWarning {
  kind: HealthWarningKind;
  message: string;
}

export interface RepoHealthStatus {
  localRepoId: number;
  localPath: string;
  repoName: string;
  currentBranch: string | null;
  hasUpstream: boolean;
  upstreamRef: string | null;
  noRemote: boolean;
  remoteCount: number;
  notificationCount: number;
  linkedGithubRepo: string | null;
  failedWorkflowRuns: number;
  exists: boolean;
}

export interface DashboardSummary {
  repos: RepoHealthStatus[];
  warnings: { repoId: number; warnings: HealthWarning[] }[];
  totalRepos: number;
  reposWithWarnings: number;
  totalNotifications: number;
  totalFailedRuns: number;
  generatedAt: string;
}

export interface FailedWorkflowRun {
  id: string;
  repo_full_name: string;
  workflow_name: string;
  head_branch: string;
  conclusion: string;
  run_started_at: string;
  html_url: string;
}

// ── Jarvis preload API contract ───────────────────────────────────────────────
// This augments the global Window type so all plugin components get full
// type-checking on window.jarvis calls without re-declaring it everywhere.
export type { OnboardingStatus } from '../agent/onboarding';
import type { OnboardingStatus } from '../agent/onboarding';
import type {
  AgentSessionStartingPayload,
  AgentAnalysisCompletePayload,
  AgentPhase2ErrorPayload,
  AgentSessionCompletePayload,
  AgentSessionErrorPayload,
  AgentDebugContextPayload,
} from '../types/ipc-payloads';

export type {
  AgentSessionStartingPayload,
  AgentAnalysisCompletePayload,
  AgentPhase2ErrorPayload,
  AgentSessionCompletePayload,
  AgentSessionErrorPayload,
  AgentDebugContextPayload,
} from '../types/ipc-payloads';

export interface JarvisApi {
  getOnboardingStatus(): Promise<OnboardingStatus>;
  startDiscovery(): Promise<{ started: boolean }>;
  startPatDiscovery(): Promise<{ started?: boolean; error?: string }>;
  startOAuthDiscovery(): Promise<{ ok: boolean }>;
  savePat(pat: string): Promise<{ ok: boolean; error?: string }>;
  deletePat(): Promise<{ ok: boolean }>;
  getPatStatus(): Promise<{ hasPat: boolean; login?: string; name?: string; avatarUrl?: string }>;
  logout(): Promise<{ ok: boolean }>;
  checkOllama(): Promise<OllamaStatus>;
  listOllamaModels(): Promise<{ available: boolean; models: OllamaModel[]; error?: string }>;
  getSelectedOllamaModel(): Promise<string | null>;
  setSelectedOllamaModel(modelName: string): Promise<{ ok: boolean }>;
  sendChatMessage(messages: Array<{ role: string; content: string }>): Promise<{ ok: boolean }>;
  abortChat(): Promise<{ ok: boolean }>;
  adjustWindowWidth(delta: number): Promise<{ ok: boolean }>;
  onChatToken(cb: (token: string) => void): () => void;
  onChatDone(cb: () => void): () => void;
  onChatError(cb: (err: string) => void): () => void;
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
  getPreferences(): Promise<{ sortByNotifications: boolean; localSortByNotifs: boolean; localRepoSortKey: 'name' | 'scanned' | 'notifs' }>;
  setPreferences(prefs: { sortByNotifications?: boolean; localSortByNotifs?: boolean; localRepoSortKey?: 'name' | 'scanned' | 'notifs' }): Promise<{ ok: boolean }>;
  onOpenChat(cb: () => void): () => void;
  onOAuthComplete(cb: (result: OAuthResult) => void): () => void;
  onDiscoveryProgress(cb: (progress: DiscoveryProgress) => void): () => void;
  onDiscoveryComplete(cb: (progress: DiscoveryProgress) => void): () => void;
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
  // Secrets
  scanRepoSecrets(): Promise<SecretsScanResult>;
  listSecretsForRepo(repoFullName: string): Promise<RepoSecret[]>;
  listAllSecrets(): Promise<RepoSecret[]>;
  listSecretFavorites(): Promise<SecretFavorite[]>;
  addSecretFavorite(targetType: 'org' | 'repo', targetName: string): Promise<{ ok: boolean }>;
  removeSecretFavorite(targetName: string): Promise<{ ok: boolean }>;
  onSecretsProgress(cb: (progress: SecretsScanProgress) => void): () => void;
  onLocalScanProgress(cb: (progress: LocalScanProgress) => void): () => void;
  onLocalScanComplete(cb: (progress: LocalScanProgress) => void): () => void;
  // Agents
  agentsList(): Promise<AgentDefinition[]>;
  agentsUpdate(agentId: number, systemPrompt: string): Promise<{ ok: boolean; error?: string }>;
  agentsRun(agentId: number, scopeType: 'repo' | 'org' | 'global', scopeValue: string, workflowFilter?: string): Promise<{ sessionId: number; error?: string }>;
  agentsGetSession(sessionId: number): Promise<AgentSession | null>;
  agentsApproveFinding(findingId: number): Promise<{ ok: boolean }>;
  agentsRejectFinding(findingId: number): Promise<{ ok: boolean }>;
  agentsExecuteFinding(findingId: number): Promise<{ ok: boolean; error?: string; dismissedIds?: string[] }>;
  onAgentSessionStarting(cb: (data: AgentSessionStartingPayload) => void): () => void;
  onAgentDebugContext(cb: (data: AgentDebugContextPayload) => void): () => void;
  onAgentToken(cb: (token: string) => void): () => void;
  onAgentAnalysisComplete(cb: (data: AgentAnalysisCompletePayload) => void): () => void;
  onAgentPhase2Error(cb: (data: AgentPhase2ErrorPayload) => void): () => void;
  onAgentSessionComplete(cb: (result: AgentSessionCompletePayload) => void): () => void;
  onAgentSessionError(cb: (error: AgentSessionErrorPayload) => void): () => void;
  // Workflow data
  githubFetchWorkflowRuns(repoFullName: string): Promise<{ ok: boolean; count?: number; error?: string }>;
  githubGetWorkflowSummary(repoFullName: string): Promise<WorkflowRunSummary>;
  githubGetCachedWorkflowInfo(repoFullName: string): Promise<{ fetchedAt: string | null; runCount: number }>;
  // Dashboard
  dashboardGetSummary(): Promise<DashboardSummary>;
  dashboardGetRecentFailedRuns(): Promise<FailedWorkflowRun[]>;
  dashboardPushBranchUpstream(repoPath: string, branch: string): Promise<{ ok: boolean; error?: string; output?: string }>;
}

declare global {
  interface Window {
    jarvis: JarvisApi;
  }
}
