import type { Database as SqlJsDatabase } from 'sql.js';

/** Workflow cache is considered fresh if fetched within this window. */
export const WORKFLOW_CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Returns true if workflow run data for the given repo was fetched recently
 * (within WORKFLOW_CACHE_MAX_AGE_MS). Avoids redundant API calls on rapid
 * restarts (e.g. during agentic dev sessions with hot reload).
 */
export function isWorkflowDataFresh(db: SqlJsDatabase, repoFullName: string): boolean {
  const result = db.exec(
    `SELECT MAX(fetched_at) FROM github_workflow_runs WHERE repo_full_name = ?`,
    [repoFullName],
  );
  const raw = result[0]?.values[0]?.[0] as string | null | undefined;
  if (!raw) return false;
  // SQLite datetime('now') stores UTC without 'Z' suffix — append it before parsing.
  const fetchedAt = new Date(raw.includes('T') ? raw : raw + 'Z');
  return Date.now() - fetchedAt.getTime() < WORKFLOW_CACHE_MAX_AGE_MS;
}
