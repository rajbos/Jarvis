import fs from 'fs';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';

// ── Types ─────────────────────────────────────────────────────────────────────

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

export interface ScanProgress {
  phase: 'scanning' | 'done';
  foldersScanned: number;
  reposFound: number;
  currentFolder?: string;
}

// ── Git config parsing ────────────────────────────────────────────────────────

/**
 * Parse a `.git/config` file and extract all named remotes.
 * Works cross-platform — no child_process / git binary required.
 */
export function parseGitRemotes(repoPath: string): { name: string; url: string }[] {
  const configPath = path.join(repoPath, '.git', 'config');
  if (!fs.existsSync(configPath)) return [];

  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return [];
  }

  const remotes: { name: string; url: string }[] = [];
  let currentRemote: string | null = null;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const sectionMatch = line.match(/^\[remote "(.+)"\]$/);
    if (sectionMatch) {
      currentRemote = sectionMatch[1];
    } else if (currentRemote) {
      const urlMatch = line.match(/^url\s*=\s*(.+)$/);
      if (urlMatch) {
        remotes.push({ name: currentRemote, url: urlMatch[1].trim() });
      }
      if (line.startsWith('[') && !line.startsWith('[remote "')) {
        currentRemote = null;
      }
    }
  }

  return remotes;
}

/**
 * Normalise a git remote URL to `owner/repo` format for GitHub repos.
 * Handles HTTPS, SSH (git@github.com:...) and bare-path variants.
 * Returns null for non-GitHub remotes.
 */
export function normalizeGitHubUrl(url: string): string | null {
  if (!url) return null;

  // HTTPS:  https://github.com/owner/repo[.git]
  const httpsMatch = url.match(/https?:\/\/(?:[^@]+@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (httpsMatch) return httpsMatch[1];

  // SSH:    git@github.com:owner/repo[.git]
  const sshMatch = url.match(/git@github\.com:([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (sshMatch) return sshMatch[1];

  return null;
}

// ── File-system scanning ──────────────────────────────────────────────────────

/**
 * Check if the given directory is a git repository (contains a `.git` entry).
 */
export function isGitRepo(dirPath: string): boolean {
  try {
    const gitPath = path.join(dirPath, '.git');
    return fs.existsSync(gitPath) && fs.statSync(gitPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively scan `baseDir` for git repositories up to `maxDepth` levels deep.
 * Stops recursing into a directory once a `.git` folder is found.
 * Skips hidden directories and `node_modules`.
 */
export function findGitRepos(
  baseDir: string,
  maxDepth = 3,
  onProgress?: (currentDir: string) => void,
): { localPath: string; name: string; remotes: { name: string; url: string }[] }[] {
  const results: { localPath: string; name: string; remotes: { name: string; url: string }[] }[] = [];

  function scan(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    onProgress?.(dir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const hasGit = entries.some((e) => e.isDirectory() && e.name === '.git');

    if (hasGit) {
      const remotes = parseGitRemotes(dir);
      results.push({ localPath: dir, name: path.basename(dir), remotes });
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      scan(path.join(dir, entry.name), depth + 1);
    }
  }

  scan(baseDir, 0);
  return results;
}

// ── Database helpers ──────────────────────────────────────────────────────────

/** Return all configured scan folders with per-folder repo counts. */
export function getScanFolders(db: SqlJsDatabase): ScanFolder[] {
  const stmt = db.prepare(
    `SELECT f.id, f.path, f.added_at,
            COUNT(r.id) AS repo_count
     FROM local_scan_folders f
     LEFT JOIN local_repos r ON (
       r.local_path = f.path
       OR r.local_path LIKE (f.path || '/%')
       OR r.local_path LIKE (f.path || '\%')
     )
     GROUP BY f.id, f.path, f.added_at
     ORDER BY f.added_at ASC`,
  );
  const rows: ScanFolder[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject() as { id: number; path: string; added_at: string; repo_count: number };
    rows.push({ id: r.id, path: r.path, addedAt: r.added_at, repoCount: r.repo_count });
  }
  stmt.free();
  return rows;
}

/** Add a scan folder (no-op if it already exists). */
export function addScanFolder(db: SqlJsDatabase, folderPath: string): void {
  const normalised = path.normalize(folderPath);
  db.run(
    'INSERT OR IGNORE INTO local_scan_folders (path) VALUES (?)',
    [normalised],
  );
}

/** Remove a scan folder. */
export function removeScanFolder(db: SqlJsDatabase, folderPath: string): void {
  db.run('DELETE FROM local_scan_folders WHERE path = ?', [folderPath]);
}

/** Upsert a single local repo and its remotes. Returns the row id. */
export function upsertLocalRepo(
  db: SqlJsDatabase,
  localPath: string,
  name: string,
  remotes: { name: string; url: string }[],
): number {
  db.run(
    `INSERT INTO local_repos (local_path, name, last_scanned)
       VALUES (?, ?, datetime('now'))
     ON CONFLICT(local_path) DO UPDATE SET
       name        = excluded.name,
       last_scanned = excluded.last_scanned`,
    [localPath, name],
  );

  const idStmt = db.prepare('SELECT id FROM local_repos WHERE local_path = ?');
  idStmt.bind([localPath]);
  idStmt.step();
  const { id } = idStmt.getAsObject() as { id: number };
  idStmt.free();

  for (const remote of remotes) {
    db.run(
      `INSERT INTO local_repo_remotes (local_repo_id, name, url)
         VALUES (?, ?, ?)
       ON CONFLICT(local_repo_id, name) DO UPDATE SET url = excluded.url`,
      [id, remote.name, remote.url],
    );
  }

  if (remotes.length > 0) {
    const placeholders = remotes.map(() => '?').join(',');
    const names = remotes.map((r) => r.name);
    db.run(
      `DELETE FROM local_repo_remotes WHERE local_repo_id = ? AND name NOT IN (${placeholders})`,
      [id, ...names],
    );
  } else {
    db.run('DELETE FROM local_repo_remotes WHERE local_repo_id = ?', [id]);
  }

  return id;
}

/**
 * Auto-link local repos to GitHub repos by matching remote URLs against
 * github_repos.full_name.
 */
export function autoLinkLocalRepos(db: SqlJsDatabase): void {
  const stmt = db.prepare(
    `SELECT lrr.id AS remote_id, lrr.local_repo_id, lrr.url, lrr.github_repo_id
     FROM local_repo_remotes lrr`,
  );
  const rows: { remote_id: number; local_repo_id: number; url: string; github_repo_id: number | null }[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as typeof rows[0]);
  stmt.free();

  for (const row of rows) {
    if (row.github_repo_id) continue;

    const fullName = normalizeGitHubUrl(row.url);
    if (!fullName) continue;

    const ghStmt = db.prepare('SELECT id FROM github_repos WHERE full_name = ?');
    ghStmt.bind([fullName]);
    const found = ghStmt.step() ? (ghStmt.getAsObject() as { id: number }) : null;
    ghStmt.free();

    if (found) {
      db.run(
        'UPDATE local_repo_remotes SET github_repo_id = ? WHERE id = ?',
        [found.id, row.remote_id],
      );
      db.run(
        `UPDATE local_repos SET github_repo_id = ?
         WHERE id = ? AND github_repo_id IS NULL`,
        [found.id, row.local_repo_id],
      );
    }
  }
}

/** Manually link/unlink a local repo to a specific GitHub repo. */
export function linkLocalRepo(
  db: SqlJsDatabase,
  localRepoId: number,
  githubRepoId: number | null,
): void {
  db.run('UPDATE local_repos SET github_repo_id = ? WHERE id = ?', [githubRepoId, localRepoId]);
}

/** List all local repos, with their remotes. */
export function listLocalRepos(db: SqlJsDatabase): LocalRepo[] {
  const repoStmt = db.prepare(
    `SELECT lr.id, lr.local_path, lr.name, lr.discovered_at, lr.last_scanned,
            lr.github_repo_id
     FROM local_repos lr
     ORDER BY lr.name ASC`,
  );
  const repos: LocalRepo[] = [];
  while (repoStmt.step()) {
    const r = repoStmt.getAsObject() as {
      id: number; local_path: string; name: string | null;
      discovered_at: string; last_scanned: string | null; github_repo_id: number | null;
    };
    repos.push({
      id: r.id,
      localPath: r.local_path,
      name: r.name ?? path.basename(r.local_path),
      remotes: [],
      discoveredAt: r.discovered_at,
      lastScanned: r.last_scanned,
      linkedGithubRepoId: r.github_repo_id,
    });
  }
  repoStmt.free();

  for (const repo of repos) {
    const remoteStmt = db.prepare(
      `SELECT lrr.name, lrr.url, lrr.github_repo_id
       FROM local_repo_remotes lrr
       WHERE lrr.local_repo_id = ?`,
    );
    remoteStmt.bind([repo.id]);
    while (remoteStmt.step()) {
      const rr = remoteStmt.getAsObject() as {
        name: string; url: string; github_repo_id: number | null;
      };
      repo.remotes.push({ name: rr.name, url: rr.url, githubRepoId: rr.github_repo_id ?? null });
    }
    remoteStmt.free();
  }

  return repos;
}

/** List local repos that live under a specific scan folder. */
export function listLocalReposForFolder(db: SqlJsDatabase, folderPath: string): LocalRepo[] {
  const all = listLocalRepos(db);
  const sep = path.sep;
  const normalised = path.normalize(folderPath);
  return all.filter((r) => {
    const rNorm = path.normalize(r.localPath);
    return rNorm === normalised || rNorm.startsWith(normalised + sep);
  });
}

// ── Discovery orchestration ───────────────────────────────────────────────────

/**
 * Scan all configured folders, upsert results into the DB, auto-link to GitHub.
 * Calls `onProgress` as scanning proceeds.
 */
export async function runLocalDiscovery(
  db: SqlJsDatabase,
  onProgress?: (progress: ScanProgress) => void,
): Promise<ScanProgress> {
  const folders = getScanFolders(db);
  let foldersScanned = 0;
  let reposFound = 0;

  for (const folder of folders) {
    onProgress?.({ phase: 'scanning', foldersScanned, reposFound, currentFolder: folder.path });

    const found = findGitRepos(folder.path, 3, (cur) => {
      onProgress?.({ phase: 'scanning', foldersScanned, reposFound, currentFolder: cur });
    });

    for (const repo of found) {
      upsertLocalRepo(db, repo.localPath, repo.name, repo.remotes);
      reposFound++;
    }

    foldersScanned++;
  }

  autoLinkLocalRepos(db);

  const done: ScanProgress = { phase: 'done', foldersScanned, reposFound };
  onProgress?.(done);
  return done;
}
