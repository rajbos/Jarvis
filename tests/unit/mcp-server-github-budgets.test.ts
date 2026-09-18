/// <reference path="../../src/types/sql.js.d.ts" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import {
  findAnywhere,
  listNotifications,
  listWorkflowRuns,
  queryTerms,
  searchGitHubRepos,
  searchLocalRepos,
} from '../../src/mcp-server/tools/github';
import {
  getCustomerBudget,
  listRuddrBudgets,
  parseRuddrNumber,
  scoreNameMatch,
} from '../../src/mcp-server/tools/ruddr-budgets';

function seedGitHub(db: SqlJsDatabase): void {
  db.run(`INSERT INTO github_orgs (id, login) VALUES (1, 'rajbos'), (2, 'acme')`);
  db.run(
    `INSERT INTO github_repos (id, org_id, full_name, name, description, language, archived, fork, private, starred, last_pushed_at)
     VALUES
       (10, 1, 'rajbos/azdo-pipeline-minutes', 'azdo-pipeline-minutes', 'Script to collect Azure DevOps pipeline minutes per repo', 'PowerShell', 0, 0, 0, 0, '2026-03-01T00:00:00Z'),
       (11, 1, 'rajbos/jarvis', 'jarvis', 'Personal assistant', 'TypeScript', 0, 0, 1, 0, '2026-09-01T00:00:00Z'),
       (12, 2, 'acme/old-pipelines', 'old-pipelines', 'Legacy Azure DevOps pipelines', 'YAML', 1, 0, 0, 0, '2020-01-01T00:00:00Z')`,
  );
  db.run(
    `INSERT INTO local_repos (id, local_path, name, remote_url, github_repo_id)
     VALUES
       (100, 'C:\\code\\azdo-pipeline-minutes', 'azdo-pipeline-minutes', NULL, 10),
       (101, 'C:\\code\\scratch\\devops-scripts', 'devops-scripts', NULL, NULL)`,
  );
  db.run(
    `INSERT INTO local_repo_remotes (local_repo_id, name, url, github_repo_id)
     VALUES
       (100, 'origin', 'https://github.com/rajbos/azdo-pipeline-minutes.git', 10),
       (101, 'origin', 'https://dev.azure.com/acme/_git/devops-scripts', NULL)`,
  );
  db.run(
    `INSERT INTO github_notifications (id, repo_full_name, repo_owner, subject_type, subject_title, subject_url, subject_actor_login, reason, unread, updated_at)
     VALUES
       ('n1', 'rajbos/jarvis', 'rajbos', 'PullRequest', 'Add pipeline minutes report', 'https://api.github.com/x/1', 'bot', 'review_requested', 1, '2026-09-10T00:00:00Z'),
       ('n2', 'rajbos/jarvis', 'rajbos', 'CheckSuite', 'CI failed', NULL, NULL, 'ci_activity', 0, '2026-09-11T00:00:00Z'),
       ('n3', 'acme/old-pipelines', 'acme', 'Issue', 'Something else', NULL, NULL, 'mention', 1, '2026-09-01T00:00:00Z')`,
  );
  db.run(
    `INSERT INTO github_workflow_runs (id, repo_full_name, workflow_name, head_branch, event, status, conclusion, run_number, run_started_at, html_url)
     VALUES
       ('r1', 'rajbos/jarvis', 'CI', 'main', 'push', 'completed', 'failure', 5, '2026-09-11T00:00:00Z', 'https://github.com/rajbos/jarvis/actions/runs/1'),
       ('r2', 'rajbos/jarvis', 'CI', 'main', 'push', 'completed', 'success', 6, '2026-09-12T00:00:00Z', 'https://github.com/rajbos/jarvis/actions/runs/2')`,
  );
}

describe('MCP GitHub tools (cached data only)', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    seedGitHub(db);
  });

  afterEach(() => db.close());

  it('splits queries into lowercase terms', () => {
    expect(queryTerms('  Azure   DevOps ')).toEqual(['azure', 'devops']);
    expect(queryTerms('')).toEqual([]);
  });

  it('searches repos with AND semantics and attaches local clone paths', () => {
    const hits = searchGitHubRepos(db, 'azure devops minutes');
    expect(hits.map((h) => h.fullName)).toEqual(['rajbos/azdo-pipeline-minutes']);
    expect(hits[0].localPaths).toEqual(['C:\\code\\azdo-pipeline-minutes']);
    expect(hits[0].htmlUrl).toBe('https://github.com/rajbos/azdo-pipeline-minutes');
    expect(hits[0].archived).toBe(false);
  });

  it('excludes archived repos unless asked, and filters by owner', () => {
    expect(searchGitHubRepos(db, 'azure devops').map((h) => h.fullName)).toEqual(['rajbos/azdo-pipeline-minutes']);
    expect(searchGitHubRepos(db, 'azure devops', { includeArchived: true }).map((h) => h.fullName)).toEqual([
      'rajbos/azdo-pipeline-minutes',
      'acme/old-pipelines',
    ]);
    expect(searchGitHubRepos(db, 'pipelines', { includeArchived: true, owner: 'ACME' }).map((h) => h.fullName)).toEqual(['acme/old-pipelines']);
  });

  it('lists and filters local repos including remotes and linked GitHub metadata', () => {
    const all = searchLocalRepos(db);
    expect(all).toHaveLength(2);
    const linked = all.find((r) => r.id === 100)!;
    expect(linked.githubFullName).toBe('rajbos/azdo-pipeline-minutes');
    expect(linked.remotes).toEqual([{ name: 'origin', url: 'https://github.com/rajbos/azdo-pipeline-minutes.git' }]);

    // Matches through the remote URL even without a linked GitHub repo
    const viaRemote = searchLocalRepos(db, 'dev.azure.com');
    expect(viaRemote.map((r) => r.localPath)).toEqual(['C:\\code\\scratch\\devops-scripts']);
    expect(viaRemote[0].githubFullName).toBeNull();

    // Matches through the linked repo description
    expect(searchLocalRepos(db, 'pipeline minutes').map((r) => r.id)).toEqual([100]);
    expect(searchLocalRepos(db, 'nomatch')).toEqual([]);
  });

  it('lists notifications newest first with filters', () => {
    expect(listNotifications(db).map((n) => n.id)).toEqual(['n2', 'n1', 'n3']);
    expect(listNotifications(db, { unreadOnly: true }).map((n) => n.id)).toEqual(['n1', 'n3']);
    expect(listNotifications(db, { repo: 'rajbos/jarvis' }).map((n) => n.id)).toEqual(['n2', 'n1']);
    expect(listNotifications(db, { repo: 'acme' }).map((n) => n.id)).toEqual(['n3']);
    expect(listNotifications(db, { since: '2026-09-11T00:00:00Z' }).map((n) => n.id)).toEqual(['n2']);
    expect(listNotifications(db, { query: 'pipeline minutes' }).map((n) => n.id)).toEqual(['n1']);
    expect(listNotifications(db, { limit: 1 }).map((n) => n.id)).toEqual(['n2']);
    expect(listNotifications(db)[0].unread).toBe(false);
  });

  it('lists workflow runs with repo and conclusion filters', () => {
    expect(listWorkflowRuns(db).map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(listWorkflowRuns(db, { conclusion: 'FAILURE' }).map((r) => r.id)).toEqual(['r1']);
    expect(listWorkflowRuns(db, { repo: 'nobody/none' })).toEqual([]);
  });

  it('finds the Azure DevOps pipeline minutes script across all surfaces', () => {
    const result = findAnywhere(db, 'pipeline minutes');
    expect(result.repos.map((r) => r.fullName)).toEqual(['rajbos/azdo-pipeline-minutes']);
    expect(result.localRepos.map((r) => r.localPath)).toEqual(['C:\\code\\azdo-pipeline-minutes']);
    expect(result.notifications.map((n) => n.id)).toEqual(['n1']);
  });
});

describe('MCP Ruddr budget tools', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    db.run(
      `INSERT INTO ruddr_projects (name, path, note, cloud_folder_url)
       VALUES ('Acme Platform', '/projects/acme-platform', 'main engagement', 'https://cloud/acme'),
              ('Acme Support', '/projects/acme-support', NULL, NULL),
              ('Globex Migration', '/projects/globex', NULL, NULL)`,
    );
    db.run(
      `INSERT INTO groups (id, name, ruddr_project_name, ruddr_project_paths)
       VALUES (1, 'Acme Corp', '["Acme Platform","Acme Support"]', '["/projects/acme-platform","/projects/acme-support"]'),
              (2, 'Initech', NULL, NULL)`,
    );
    db.run(
      `INSERT INTO ruddr_budgets (project_name, project_url, actual_billable_hours, actual_non_billable_hours, actual_total_hours, budget, budget_left, fetched_at)
       VALUES ('Acme Platform', 'https://www.ruddr.io/projects/acme-platform/overview', '750', '50', '800', '1,000', '200', '2026-09-17T10:00:00Z'),
              ('Acme Support', NULL, '120', '0', '120', '100', '-20', '2026-09-17T10:00:00Z'),
              ('Globex Migration', NULL, '10', '0', '10', NULL, NULL, '2026-09-17T10:00:00Z')`,
    );
  });

  afterEach(() => db.close());

  it('parses scraped Ruddr numbers in EU and US formats', () => {
    expect(parseRuddrNumber('1,000')).toBe(1000);
    expect(parseRuddrNumber('1.5')).toBe(1.5);
    expect(parseRuddrNumber('1,5')).toBe(1.5);
    expect(parseRuddrNumber('12,345,678')).toBe(12345678);
    expect(parseRuddrNumber('1.234,5')).toBe(1234.5);
    expect(parseRuddrNumber('1,234.5')).toBe(1234.5);
    expect(parseRuddrNumber('-20')).toBe(-20);
    expect(parseRuddrNumber('€ 500')).toBe(500);
    expect(parseRuddrNumber('n/a')).toBeNull();
    expect(parseRuddrNumber(null)).toBeNull();
  });

  it('scores fuzzy customer names', () => {
    expect(scoreNameMatch('acme corp', 'Acme Corp')).toBe(1);
    expect(scoreNameMatch('acme', 'Acme Corp')).toBe(0.9);
    expect(scoreNameMatch('corp acme', 'Acme Corp')).toBeGreaterThanOrEqual(0.5);
    expect(scoreNameMatch('zzz', 'Acme Corp')).toBe(0);
  });

  it('answers budget utilization for a customer group', () => {
    const summary = getCustomerBudget(db, 'acme');
    expect(summary.resolution).toBe('group');
    expect(summary.customer?.name).toBe('Acme Corp');
    expect(summary.budgetCacheAvailable).toBe(true);
    expect(summary.projects.map((p) => p.projectName)).toEqual(['Acme Platform', 'Acme Support']);

    const platform = summary.projects[0];
    expect(platform.budgetHours).toBe(1000);
    expect(platform.budgetLeftHours).toBe(200);
    expect(platform.utilization).toBeCloseTo(0.8);
    expect(platform.overBudget).toBe(false);
    expect(platform.projectUrl).toBe('https://www.ruddr.io/projects/acme-platform/overview');
    expect(platform.cloudFolderUrl).toBe('https://cloud/acme');

    const support = summary.projects[1];
    expect(support.utilization).toBeCloseTo(1.2);
    expect(support.overBudget).toBe(true);
    expect(support.projectUrl).toBe('https://www.ruddr.io/projects/acme-support');

    expect(summary.totals).toEqual({
      budgetHours: 1100,
      budgetLeftHours: 180,
      actualTotalHours: 920,
      utilization: (1100 - 180) / 1100,
      projectsWithBudget: 2,
    });
  });

  it('falls back to Ruddr project names when no group matches', () => {
    const summary = getCustomerBudget(db, 'globex');
    expect(summary.resolution).toBe('project');
    expect(summary.customer).toBeNull();
    expect(summary.projects.map((p) => p.projectName)).toEqual(['Globex Migration']);
    expect(summary.projects[0].utilization).toBeNull();
    expect(summary.projects[0].overBudget).toBeNull();
    expect(summary.totals.projectsWithBudget).toBe(0);
    expect(summary.totals.utilization).toBeNull();
  });

  it('reports nothing found for unknown customers', () => {
    const summary = getCustomerBudget(db, 'unknown customer');
    expect(summary.resolution).toBe('none');
    expect(summary.projects).toEqual([]);
  });

  it('lists all cached budgets joined with project paths', () => {
    const all = listRuddrBudgets(db);
    expect(all.map((b) => b.projectName)).toEqual(['Acme Platform', 'Acme Support', 'Globex Migration']);
    expect(all[2].projectPath).toBe('/projects/globex');
  });

  it('degrades gracefully when the budget cache table does not exist', () => {
    db.run('DROP TABLE ruddr_budgets');
    expect(listRuddrBudgets(db)).toEqual([]);
    const summary = getCustomerBudget(db, 'acme');
    expect(summary.budgetCacheAvailable).toBe(false);
    expect(summary.resolution).toBe('group');
    expect(summary.projects).toHaveLength(2);
    expect(summary.projects.every((p) => p.budget === null && p.utilization === null)).toBe(true);
  });
});
