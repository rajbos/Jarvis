/**
 * Synthetic data served by the fake `window.jarvis` API in the headless view tests.
 *
 * Every name, title, path and login here is invented (the fictional "Acme Labs" and
 * "Globex OSS" organizations). Nothing is read from the local database, config files,
 * git settings or environment, so a test run renders the same screens on every
 * machine and never shows anyone's real repositories, groups or notifications.
 * `fixtures-are-synthetic.view.test.ts` guards that the current machine's user and
 * host names do not leak in here.
 */
import type {
  ActiveSessionsSnapshot,
  AgentDefinition,
  AutoDismissLogEntry,
  AutoDismissStats,
  BackgroundTaskStatus,
  BrowserSkill,
  BrowserSkillRun,
  ClaudeRateLimit,
  ClaudeStatus,
  CopilotUsage,
  DashboardSummary,
  GitHubRateLimit,
  Group,
  GroupDetail,
  LocalIndexStatus,
  LocalRepo,
  McpClientConfig,
  NotificationCounts,
  OllamaStatus,
  OnedriveRoot,
  OrgListResult,
  Repo,
  RepoSecret,
  RuddrBudget,
  ScanFolder,
  StoredNotification,
  WorkflowRunSummary,
} from '../../../src/plugins/types';

export const FIXTURE_USER = 'test-user';
export const ORG_ACME = 'acme-labs';
export const ORG_GLOBEX = 'globex-oss';

export const REPO_ROCKET = `${ORG_ACME}/rocket-sled`;
export const REPO_ANVIL = `${ORG_ACME}/anvil-api`;
export const REPO_HAMMOCK = `${ORG_GLOBEX}/hammock`;

export const LOCAL_ROOT = 'C:\\fixtures\\src';
export const GROUP_ACME = 'Acme Retainer';
export const GROUP_GLOBEX = 'Globex Pilot';
export const RUDDR_PROJECT = 'ACME-001 Platform Migration';

const DAY = 24 * 60 * 60 * 1000;

function iso(now: number, offsetMs: number): string {
  return new Date(now + offsetMs).toISOString();
}

function repo(fullName: string, extra: Partial<Repo> = {}): Repo {
  return {
    name: fullName.split('/')[1],
    full_name: fullName,
    description: `Fixture repository ${fullName}`,
    language: 'TypeScript',
    private: false,
    fork: false,
    archived: false,
    default_branch: 'main',
    ...extra,
  };
}

function localRepo(id: number, fullName: string, now: number): LocalRepo {
  const [owner, name] = fullName.split('/');
  return {
    id,
    localPath: `${LOCAL_ROOT}\\${owner}\\${name}`,
    name,
    remotes: [{ name: 'origin', url: `https://github.com/${fullName}.git`, githubRepoId: id }],
    discoveredAt: iso(now, -30 * DAY),
    lastScanned: iso(now, -DAY),
    linkedGithubRepoId: id,
  };
}

function notification(id: string, repoFullName: string, title: string, now: number, extra: Partial<StoredNotification> = {}): StoredNotification {
  return {
    id,
    repo_full_name: repoFullName,
    repo_owner: repoFullName.split('/')[0],
    subject_type: 'PullRequest',
    subject_title: title,
    subject_url: `https://api.github.com/repos/${repoFullName}/pulls/${id}`,
    subject_actor_login: 'fixture-contributor',
    subject_actor_type: 'User',
    reason: 'review_requested',
    unread: 1,
    updated_at: iso(now, -2 * 60 * 60 * 1000),
    ...extra,
  };
}

/**
 * Builds the default dataset. `now` is passed in (instead of calling Date.now()
 * everywhere) so a test can pin it and so relative times like "resets in 2h"
 * stay in the future.
 */
export function createFixtures(now: number) {
  const localRepos: LocalRepo[] = [
    localRepo(101, REPO_ROCKET, now),
    localRepo(102, REPO_ANVIL, now),
    localRepo(103, REPO_HAMMOCK, now),
  ];

  const notifications: StoredNotification[] = [
    notification('9001', REPO_ROCKET, 'Add turbo boost to the sled launcher', now),
    notification('9002', REPO_ROCKET, 'Bump fixture-lib from 1.0.0 to 1.1.0', now, {
      subject_actor_login: 'dependabot[bot]',
      subject_actor_type: 'Bot',
      reason: 'subscribed',
    }),
    notification('9003', REPO_HAMMOCK, 'Hammock swings too far to the left', now, {
      subject_type: 'Issue',
      subject_url: `https://api.github.com/repos/${REPO_HAMMOCK}/issues/9003`,
      reason: 'mention',
    }),
  ];

  const notificationCounts: NotificationCounts = {
    perOrg: { [ORG_ACME]: 2, [ORG_GLOBEX]: 1 },
    perRepo: { [REPO_ROCKET]: 2, [REPO_HAMMOCK]: 1 },
    total: 3,
    starredTotal: 0,
    fetchedAt: iso(now, -5 * 60 * 1000),
  };

  const orgs: OrgListResult = {
    orgs: [
      { login: ORG_ACME, repoCount: 2, discoveryEnabled: true },
      { login: ORG_GLOBEX, repoCount: 1, discoveryEnabled: true },
    ],
    directRepoCount: 0,
    starredRepoCount: 0,
  };

  const reposByOrg: Record<string, Repo[]> = {
    [ORG_ACME]: [repo(REPO_ROCKET), repo(REPO_ANVIL, { language: 'Go' })],
    [ORG_GLOBEX]: [repo(REPO_HAMMOCK, { language: 'Rust' })],
  };

  const scanFolders: ScanFolder[] = [
    { id: 1, path: LOCAL_ROOT, addedAt: iso(now, -60 * DAY), repoCount: localRepos.length },
  ];

  const dashboard: DashboardSummary = {
    repos: [
      {
        localRepoId: 101, localPath: localRepos[0].localPath, repoName: 'rocket-sled',
        currentBranch: 'main', hasUpstream: true, upstreamRef: 'origin/main', noRemote: false,
        remoteCount: 1, notificationCount: 2, linkedGithubRepo: REPO_ROCKET, failedWorkflowRuns: 1,
        exists: true, lastCommitAt: iso(now, -DAY), lastPushedAt: iso(now, -DAY),
      },
      {
        localRepoId: 102, localPath: localRepos[1].localPath, repoName: 'anvil-api',
        currentBranch: 'feature/heavier-anvil', hasUpstream: false, upstreamRef: null, noRemote: false,
        remoteCount: 1, notificationCount: 0, linkedGithubRepo: REPO_ANVIL, failedWorkflowRuns: 0,
        exists: true, lastCommitAt: iso(now, -2 * DAY), lastPushedAt: iso(now, -3 * DAY),
      },
      {
        localRepoId: 103, localPath: localRepos[2].localPath, repoName: 'hammock',
        currentBranch: 'main', hasUpstream: true, upstreamRef: 'origin/main', noRemote: false,
        remoteCount: 1, notificationCount: 1, linkedGithubRepo: REPO_HAMMOCK, failedWorkflowRuns: 0,
        exists: true, lastCommitAt: iso(now, -5 * DAY), lastPushedAt: iso(now, -5 * DAY),
      },
    ],
    warnings: [
      { repoId: 101, warnings: [{ kind: 'failed-workflows', message: '1 failed workflow run' }, { kind: 'has-notifications', message: '2 notifications' }] },
      { repoId: 102, warnings: [{ kind: 'branch-no-upstream', message: 'Branch feature/heavier-anvil has no upstream' }] },
      { repoId: 103, warnings: [{ kind: 'has-notifications', message: '1 notification' }] },
    ],
    totalRepos: 3,
    reposWithWarnings: 3,
    totalNotifications: 3,
    totalFailedRuns: 1,
    generatedAt: iso(now, 0),
  };

  const workflowSummary: WorkflowRunSummary = {
    repo_full_name: REPO_ROCKET,
    total_runs: 1,
    recent_runs: [{
      id: '7001', repo_full_name: REPO_ROCKET, workflow_name: 'CI', workflow_id: '71',
      workflow_path: '.github/workflows/ci.yml', head_branch: 'main', head_sha: 'abc1234',
      event: 'push', status: 'completed', conclusion: 'failure', run_number: 42,
      run_started_at: iso(now, -3 * 60 * 60 * 1000), updated_at: iso(now, -3 * 60 * 60 * 1000),
      html_url: `https://github.com/${REPO_ROCKET}/actions/runs/7001`, fetched_at: iso(now, -60 * 1000),
    }],
    jobs_by_run: {},
  };

  const groups: Group[] = [
    {
      id: 1, name: GROUP_ACME, createdAt: iso(now, -90 * DAY), updatedAt: iso(now, -DAY),
      localRepoCount: 2, githubRepoCount: 2, fileCount: 0, ruddrProjectNames: [RUDDR_PROJECT],
    },
    {
      id: 2, name: GROUP_GLOBEX, createdAt: iso(now, -20 * DAY), updatedAt: iso(now, -2 * DAY),
      localRepoCount: 1, githubRepoCount: 1, fileCount: 0, ruddrProjectNames: [],
    },
  ];

  const groupDetails: Record<number, GroupDetail> = {
    1: {
      id: 1, name: GROUP_ACME, createdAt: groups[0].createdAt, updatedAt: groups[0].updatedAt,
      localRepos: [
        { id: 101, localPath: localRepos[0].localPath, name: 'rocket-sled', addedAt: iso(now, -80 * DAY) },
        { id: 102, localPath: localRepos[1].localPath, name: 'anvil-api', addedAt: iso(now, -80 * DAY) },
      ],
      githubRepos: [
        { id: 101, fullName: REPO_ROCKET, name: 'rocket-sled', addedAt: iso(now, -80 * DAY) },
        { id: 102, fullName: REPO_ANVIL, name: 'anvil-api', addedAt: iso(now, -80 * DAY) },
      ],
      onedriveFolders: [],
    },
    2: {
      id: 2, name: GROUP_GLOBEX, createdAt: groups[1].createdAt, updatedAt: groups[1].updatedAt,
      localRepos: [{ id: 103, localPath: localRepos[2].localPath, name: 'hammock', addedAt: iso(now, -15 * DAY) }],
      githubRepos: [{ id: 103, fullName: REPO_HAMMOCK, name: 'hammock', addedAt: iso(now, -15 * DAY) }],
      onedriveFolders: [],
    },
  };

  const ruddrBudget: RuddrBudget = {
    ok: true,
    actualBillableHours: '120',
    actualNonBillableHours: '8',
    actualTotalHours: '128',
    budget: '200',
    budgetLeft: '72',
    projectUrl: 'https://example.invalid/ruddr/projects/acme-001',
    note: 'Fixture project note',
    cloudFolderUrl: null,
    fetchedAt: iso(now, -10 * 60 * 1000),
    cached: true,
  };

  const secrets: RepoSecret[] = [
    { full_name: REPO_ROCKET, secret_name: 'FIXTURE_DEPLOY_KEY', scanned_at: iso(now, -DAY) },
    { full_name: REPO_HAMMOCK, secret_name: 'FIXTURE_NPM_TOKEN', scanned_at: iso(now, -DAY) },
  ];

  const ollama: OllamaStatus = {
    available: true,
    baseUrl: 'http://127.0.0.1:11434',
    models: [
      { name: 'fixture-model:7b', model: 'fixture-model:7b', size: 4_100_000_000, modified_at: iso(now, -7 * DAY), details: { family: 'fixture', parameter_size: '7B' } },
      { name: 'tiny-fixture:1b', model: 'tiny-fixture:1b', size: 900_000_000, modified_at: iso(now, -7 * DAY) },
    ],
  };

  const rateLimit: GitHubRateLimit = {
    oauth: { configured: true, resource: { limit: 5000, remaining: 4321, reset: Math.floor((now + 30 * 60 * 1000) / 1000), used: 679 } },
    pat: { configured: false, resource: null },
    fetchedAt: iso(now, 0),
  };

  const claudeStatus: ClaudeStatus = { connected: true, subscriptionType: 'pro', source: 'stored', expiresAt: now + 7 * DAY };
  const claudeRateLimit: ClaudeRateLimit = {
    configured: true,
    limited: false,
    resetAt: null,
    retryAfterSec: null,
    fiveHour: { utilization: 0.25, reset: Math.floor((now + 2 * 60 * 60 * 1000) / 1000), limited: false },
    sevenDay: { utilization: 0.4, reset: Math.floor((now + 3 * DAY) / 1000), limited: false },
    fetchedAt: iso(now, 0),
  };

  const d = new Date(now);
  const copilotUsage: CopilotUsage = {
    configured: true,
    source: 'oauth',
    login: FIXTURE_USER,
    plan: 'business',
    entitlementCredits: 300,
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    resetsAt: now + 10 * DAY,
    creditsUsed: 120,
    includedCreditsUsed: 120,
    billedCredits: 0,
    billedAmountUsd: 0,
    byModel: [{ model: 'fixture-model', credits: 120 }],
    budgetCredits: null,
    projectedCredits: 200,
    fetchedAt: iso(now, 0),
  };

  const activeSessions: ActiveSessionsSnapshot = {
    entries: [{
      session: {
        key: 'copilot:fixture-1', provider: 'copilot', origin: 'cloud', client: 'fixture-client',
        sessionId: 'fixture-1', title: 'Teach the rocket sled to brake', cwd: null,
        repoFullName: REPO_ROCKET, branch: 'copilot/brakes', activity: 'completed',
        startedAt: iso(now, -60 * 60 * 1000), updatedAt: iso(now, -10 * 60 * 1000),
      },
      agent: { light: 'green', label: 'Done', detail: 'Agent finished', blocking: false },
      pr: {
        repoFullName: REPO_ROCKET, prNumber: 77, title: 'Teach the rocket sled to brake',
        url: `https://github.com/${REPO_ROCKET}/pull/77`, state: 'OPEN', isDraft: false,
        headSha: 'def5678', headRef: 'copilot/brakes',
        checks: { light: 'green', label: 'Checks', detail: '3/3 passed', blocking: false, total: 3, pending: 0, failed: 0, passed: 3 },
        copilotReview: { light: 'green', label: 'Review', detail: 'Reviewed', blocking: false, status: 'completed' },
        ready: true, waitingOn: [], checkedAt: iso(now, 0),
      },
      verdict: 'ready',
      verdictLabel: 'Ready for review',
    }],
    sources: {
      copilotLocal: { ok: true, count: 0 },
      claudeLocal: { ok: true, count: 0 },
      copilotCloud: { ok: true, count: 1 },
    },
    readyCount: 1,
    refreshedAt: iso(now, 0),
  };

  const autoDismissLog: AutoDismissLogEntry[] = [{
    id: 1, notification_id: '8001', dismissed_at: iso(now, -60 * 60 * 1000), reason: 'closed_pr_dependabot',
    repo_full_name: REPO_ANVIL, subject_title: 'Bump fixture-lib from 0.9.0 to 1.0.0', subject_type: 'PullRequest',
  }];
  const today = iso(now, 0).slice(0, 10);
  const autoDismissStats: AutoDismissStats = {
    daily: [{ period: today, count: 1 }],
    weekly: [{ period: today, count: 1 }],
    monthly: [{ period: today.slice(0, 7), count: 1 }],
    today: 1,
    thisWeek: 1,
  };

  const backgroundTasks: BackgroundTaskStatus[] = [
    { id: 'notifications', label: 'Fetch notifications', running: false, intervalMs: 15 * 60 * 1000, nextRunAt: iso(now, 10 * 60 * 1000), lastStatus: 'success' },
  ];

  const browserSkills: BrowserSkill[] = [{
    id: 1, name: 'Fixture weather check', description: 'Reads a forecast from a fixture page',
    start_url: 'https://example.invalid/weather', instructions: 'Read the forecast', extract_selector: '.forecast',
    created_at: iso(now, -DAY), updated_at: iso(now, -DAY),
  }];
  const browserRuns: BrowserSkillRun[] = [];

  const agents: AgentDefinition[] = [{
    id: 1, name: 'Notification Triage', description: 'Fixture agent definition',
    system_prompt: 'You are a fixture agent.', tools_allowed: '[]',
    created_at: iso(now, -DAY), updated_at: iso(now, -DAY),
  }];

  const onedriveRoots: OnedriveRoot[] = [
    { id: 1, path: 'C:\\fixtures\\OneDrive - Acme Labs', label: 'Acme Labs', addedAt: iso(now, -30 * DAY) },
  ];

  const localIndexStatus: LocalIndexStatus = {
    running: false, progress: null, error: null, indexPath: 'C:\\fixtures\\index.sqlite',
    status: { schemaVersion: 1, repoCount: 3, fileCount: 120, contentCount: 100, lastRunAt: iso(now, -DAY), repos: [] },
  };

  const mcpConfig: McpClientConfig = {
    claudeDesktop: '{ "mcpServers": {} }',
    vscode: '{ "servers": {} }',
    claudeCode: 'claude mcp add jarvis -- node server.js',
    generic: { command: 'node', serverScriptPath: 'C:\\fixtures\\jarvis\\mcp-server\\index.js', env: {} },
    packaged: false,
    serverScriptExists: true,
    dbPath: 'C:\\fixtures\\jarvis.db',
    indexPath: localIndexStatus.indexPath,
    indexExists: true,
  };

  return {
    localRepos, notifications, notificationCounts, orgs, reposByOrg, scanFolders, dashboard,
    workflowSummary, groups, groupDetails, ruddrBudget, secrets, ollama, rateLimit, claudeStatus,
    claudeRateLimit, copilotUsage, activeSessions, autoDismissLog, autoDismissStats, backgroundTasks,
    browserSkills, browserRuns, agents, onedriveRoots, localIndexStatus, mcpConfig,
  };
}

export type Fixtures = ReturnType<typeof createFixtures>;
