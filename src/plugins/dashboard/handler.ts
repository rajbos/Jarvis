import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  checkRepoHealth,
  deriveWarnings,
  type DashboardSummary,
  type RepoHealthStatus,
  type HealthWarning,
} from '../../services/git-health';
import { listLocalRepos } from '../../services/local-discovery';
import { normalizeGitHubUrl } from '../../services/local-discovery';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Look up the GitHub full_name linked to a local repo (via github_repo_id).
 */
function getLinkedGithubFullName(db: SqlJsDatabase, githubRepoId: number | null): string | null {
  if (!githubRepoId) return null;
  const stmt = db.prepare('SELECT full_name FROM github_repos WHERE id = ?');
  stmt.bind([githubRepoId]);
  const found = stmt.step() ? (stmt.getAsObject() as { full_name: string }) : null;
  stmt.free();
  return found?.full_name ?? null;
}

/**
 * Count unread notifications for a given repo full_name.
 */
function getRepoNotifCount(db: SqlJsDatabase, repoFullName: string | null): number {
  if (!repoFullName) return 0;
  const stmt = db.prepare(
    'SELECT COUNT(*) AS cnt FROM github_notifications WHERE repo_full_name = ? AND unread = 1',
  );
  stmt.bind([repoFullName]);
  stmt.step();
  const { cnt } = stmt.getAsObject() as { cnt: number };
  stmt.free();
  return cnt;
}

/**
 * Count failed workflow runs in the last 7 days for a given repo full_name.
 */
function getFailedRunCount(db: SqlJsDatabase, repoFullName: string | null): number {
  if (!repoFullName) return 0;
  const stmt = db.prepare(
    `SELECT COUNT(*) AS cnt FROM github_workflow_runs
     WHERE repo_full_name = ? AND conclusion = 'failure'
       AND run_started_at >= datetime('now', '-7 days')`,
  );
  stmt.bind([repoFullName]);
  stmt.step();
  const { cnt } = stmt.getAsObject() as { cnt: number };
  stmt.free();
  return cnt;
}

/**
 * Get recent failed workflow runs across all repos, newest first.
 */
function getRecentFailedRuns(db: SqlJsDatabase, limit = 20): {
  id: string;
  repo_full_name: string;
  workflow_name: string;
  head_branch: string;
  conclusion: string;
  run_started_at: string;
  html_url: string;
}[] {
  const stmt = db.prepare(
    `SELECT id, repo_full_name, workflow_name, head_branch, conclusion, run_started_at, html_url
     FROM github_workflow_runs
     WHERE conclusion = 'failure'
       AND run_started_at >= datetime('now', '-7 days')
     ORDER BY run_started_at DESC
     LIMIT ?`,
  );
  stmt.bind([limit]);
  const rows: {
    id: string;
    repo_full_name: string;
    workflow_name: string;
    head_branch: string;
    conclusion: string;
    run_started_at: string;
    html_url: string;
  }[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as typeof rows[0]);
  stmt.free();
  return rows;
}

// ── IPC registration ──────────────────────────────────────────────────────────

export function registerHandlers(
  db: SqlJsDatabase,
  _getWindow: () => BrowserWindow | null,
): void {
  /**
   * dashboard:get-summary
   * Build a full dashboard summary by scanning all local repos, enriching
   * with notification counts + workflow run data from the DB.
   */
  ipcMain.handle('dashboard:get-summary', async (): Promise<DashboardSummary> => {
    const localRepos = listLocalRepos(db);

    const repos: RepoHealthStatus[] = [];
    const warnings: { repoId: number; warnings: HealthWarning[] }[] = [];
    let totalNotifications = 0;
    let totalFailedRuns = 0;

    for (const repo of localRepos) {
      // Resolve linked GitHub repo full_name
      let linkedGithubRepo = getLinkedGithubFullName(db, repo.linkedGithubRepoId);

      // Also try resolving via remote URLs if not linked
      if (!linkedGithubRepo && repo.remotes.length > 0) {
        for (const remote of repo.remotes) {
          const fullName = normalizeGitHubUrl(remote.url);
          if (fullName) {
            linkedGithubRepo = fullName;
            break;
          }
        }
      }

      const notifCount = getRepoNotifCount(db, linkedGithubRepo);
      const failedRuns = getFailedRunCount(db, linkedGithubRepo);

      const status = checkRepoHealth(
        repo.id,
        repo.localPath,
        repo.name,
        linkedGithubRepo,
        notifCount,
        failedRuns,
      );

      repos.push(status);

      const repoWarnings = deriveWarnings(status);
      if (repoWarnings.length > 0) {
        warnings.push({ repoId: repo.id, warnings: repoWarnings });
      }

      totalNotifications += notifCount;
      totalFailedRuns += failedRuns;
    }

    return {
      repos,
      warnings,
      totalRepos: repos.length,
      reposWithWarnings: warnings.length,
      totalNotifications,
      totalFailedRuns,
      generatedAt: new Date().toISOString(),
    };
  });

  /**
   * dashboard:get-recent-failed-runs
   * Return the most recent failed workflow runs across all repos.
   */
  ipcMain.handle('dashboard:get-recent-failed-runs', async (): Promise<{
    id: string;
    repo_full_name: string;
    workflow_name: string;
    head_branch: string;
    conclusion: string;
    run_started_at: string;
    html_url: string;
  }[]> => {
    return getRecentFailedRuns(db);
  });

  /**
   * dashboard:push-branch-upstream
   * Run `git push --set-upstream origin <branch>` in the repo directory
   * and return the result so the UI can show success/failure.
   */
  ipcMain.handle(
    'dashboard:push-branch-upstream',
    async (_event, repoPath: string, branch: string): Promise<{ ok: boolean; error?: string; output?: string }> => {
      // Validate the repo path exists and is a git repo
      if (!existsSync(join(repoPath, '.git'))) {
        return { ok: false, error: 'Not a git repository' };
      }
      // Strict branch-name validation to prevent command injection
      if (!/^[\w.\-/]+$/.test(branch)) {
        return { ok: false, error: 'Invalid branch name' };
      }

      return new Promise((resolve) => {
        execFile(
          'git',
          ['push', '--set-upstream', 'origin', branch],
          { cwd: repoPath, timeout: 60_000 },
          (err, stdout, stderr) => {
            if (err) {
              resolve({ ok: false, error: stderr?.trim() || err.message });
            } else {
              resolve({ ok: true, output: (stderr?.trim() || stdout?.trim()) });
            }
          },
        );
      });
    },
  );
}
