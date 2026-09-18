// ── Local repo file index ─────────────────────────────────────────────────────
// Builds a searchable index of the files inside every local git clone Jarvis
// has discovered, so questions like "where is the script I wrote to collect
// Azure DevOps pipeline minutes?" can be answered from file paths and file
// contents rather than only from repo names and descriptions.
//
// The index lives in its OWN SQLite file (jarvis-index.db, next to jarvis.db)
// because sql.js persists a database by rewriting the whole file: keeping tens
// of megabytes of file text out of the main database keeps the app's frequent
// saves cheap. The Electron app writes the index; the MCP server only reads it.
//
// Storage uses an FTS4 virtual table (sql.js does not ship FTS5).

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// ── Location ──────────────────────────────────────────────────────────────────

export const INDEX_DB_FILENAME = 'jarvis-index.db';

/** The index file sits next to the main database so both processes can find it. */
export function getIndexDbPath(mainDbPath: string): string {
  return path.join(path.dirname(mainDbPath), INDEX_DB_FILENAME);
}

// ── Schema ────────────────────────────────────────────────────────────────────

export const INDEX_SCHEMA_VERSION = 1;

export function getIndexSchema(): string {
  return `
    CREATE TABLE IF NOT EXISTS index_meta (
        key   TEXT PRIMARY KEY,
        value TEXT
    );

    -- One row per local repo that has been indexed (or skipped)
    CREATE TABLE IF NOT EXISTS indexed_repos (
        local_path     TEXT PRIMARY KEY,
        name           TEXT,
        file_count     INTEGER DEFAULT 0,
        content_count  INTEGER DEFAULT 0,
        indexed_at     DATETIME,
        duration_ms    INTEGER,
        skipped_reason TEXT
    );

    -- One row per indexed file; size/mtime drive incremental re-indexing
    CREATE TABLE IF NOT EXISTS indexed_files (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_path     TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        extension     TEXT,
        kind          TEXT NOT NULL,
        size          INTEGER,
        mtime_ms      INTEGER,
        has_content   INTEGER DEFAULT 0,
        indexed_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(repo_path, relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_indexed_files_repo ON indexed_files(repo_path);

    -- Full-text index; docid mirrors indexed_files.id
    CREATE VIRTUAL TABLE IF NOT EXISTS indexed_files_fts USING fts4(
        repo_path,
        relative_path,
        content
    );
  `;
}

/** Create tables; wipe and rebuild when the on-disk schema version is different. */
export function initializeIndexSchema(db: SqlJsDatabase): void {
  const current = readUserVersion(db);
  if (current !== 0 && current !== INDEX_SCHEMA_VERSION) {
    db.run('DROP TABLE IF EXISTS indexed_files_fts');
    db.run('DROP TABLE IF EXISTS indexed_files');
    db.run('DROP TABLE IF EXISTS indexed_repos');
    db.run('DROP TABLE IF EXISTS index_meta');
  }
  db.run(getIndexSchema());
  db.run(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`);
}

function readUserVersion(db: SqlJsDatabase): number {
  const res = db.exec('PRAGMA user_version');
  const v = res[0]?.values[0]?.[0];
  return typeof v === 'number' ? v : 0;
}

// ── Open / save ───────────────────────────────────────────────────────────────

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
async function getSql(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (!SQL) SQL = await initSqlJs();
  return SQL;
}

/** Load (or create) the index database at `filePath`. */
export async function openIndexDatabase(filePath: string): Promise<SqlJsDatabase> {
  const sql = await getSql();
  if (fs.existsSync(filePath)) {
    // sql.js only notices a corrupt file on the first statement, so the
    // schema init has to be inside the try as well.
    const db = new sql.Database(fs.readFileSync(filePath));
    try {
      initializeIndexSchema(db);
      return db;
    } catch (err) {
      console.warn('[FileIndex] Existing index unreadable, starting fresh:', (err as Error).message);
      db.close();
    }
  }
  const db = new sql.Database();
  initializeIndexSchema(db);
  return db;
}

/** Create an empty in-memory index (tests). */
export async function createMemoryIndexDatabase(): Promise<SqlJsDatabase> {
  const sql = await getSql();
  const db = new sql.Database();
  initializeIndexSchema(db);
  return db;
}

/**
 * Persist the index atomically (write to a temp file, then rename) so a reader
 * that opens the file mid-save never sees a truncated database.
 */
export function saveIndexDatabase(db: SqlJsDatabase, filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, filePath);
}

// ── File classification ───────────────────────────────────────────────────────

export type FileKind = 'script' | 'doc' | 'config' | 'source' | 'other';

/** How much of a file's text we keep per kind (bytes). 0 = path only. */
export const CONTENT_BUDGET: Record<FileKind, number> = {
  script: 16 * 1024,
  doc: 16 * 1024,
  config: 8 * 1024,
  source: 2 * 1024,
  other: 0,
};

/**
 * Cap on indexed text per repo. Large upstream clones (docs sites, vendored
 * SDKs) would otherwise dominate the index; beyond the cap files are still
 * indexed by path. Files are processed in priority order (scripts first,
 * shallow paths first) so the cap keeps the most useful content.
 */
export const MAX_CONTENT_BYTES_PER_REPO = 1024 * 1024;

/** Lower is indexed (and ranked) first. */
const KIND_PRIORITY: Record<FileKind, number> = { script: 0, doc: 1, config: 2, source: 3, other: 4 };

/** Order files so the per-repo content cap favours scripts, docs and shallow paths. */
export function prioritizeFiles(files: string[]): string[] {
  const key = (f: string): [number, number, string] => [
    KIND_PRIORITY[classifyFile(f).kind],
    f.split('/').length,
    f.toLowerCase(),
  ];
  return files
    .map((f) => ({ f, k: key(f) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || (a.k[2] < b.k[2] ? -1 : a.k[2] > b.k[2] ? 1 : 0))
    .map((x) => x.f);
}

const SCRIPT_EXT = new Set(['ps1', 'psm1', 'psd1', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'py', 'rb', 'pl', 'fish', 'nu']);
const DOC_EXT = new Set(['md', 'markdown', 'txt', 'rst', 'adoc', 'asciidoc']);
const CONFIG_EXT = new Set(['yml', 'yaml', 'json', 'toml', 'ini', 'cfg', 'conf', 'xml', 'csproj', 'props', 'targets', 'env', 'editorconfig', 'bicep', 'tf', 'tfvars', 'hcl']);
const SOURCE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'cs', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'sql', 'php', 'vue', 'svelte', 'fs', 'fsx', 'scala', 'groovy', 'dart', 'lua', 'r', 'm']);
const CONFIG_BASENAMES = new Set(['dockerfile', 'makefile', 'justfile', 'vagrantfile', 'jenkinsfile', 'procfile', '.gitignore', '.gitattributes', '.npmrc', '.nvmrc']);
const SKIP_BASENAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock', 'poetry.lock', 'composer.lock', 'gemfile.lock', 'packages.lock.json']);

/** Directory names never descended into, even if git would list them. */
export const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'bin', 'obj', 'out', 'vendor', 'coverage',
  '.venv', 'venv', '__pycache__', 'target', 'packages', '.next', '.nuxt', '.terraform',
  '.idea', '.vs', 'bower_components', 'testresults', '.tox',
]);

export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_FILES_PER_REPO = 5000;

export function classifyFile(relativePath: string): { kind: FileKind; extension: string | null } {
  const base = path.basename(relativePath).toLowerCase();
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot + 1) : null;
  if (SKIP_BASENAMES.has(base) || base.includes('.min.')) return { kind: 'other', extension };
  if (CONFIG_BASENAMES.has(base)) return { kind: 'config', extension };
  if (!extension) return { kind: 'other', extension };
  if (SCRIPT_EXT.has(extension)) return { kind: 'script', extension };
  if (DOC_EXT.has(extension)) return { kind: 'doc', extension };
  if (CONFIG_EXT.has(extension)) return { kind: 'config', extension };
  if (SOURCE_EXT.has(extension)) return { kind: 'source', extension };
  return { kind: 'other', extension };
}

function isExcludedPath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/);
  return parts.slice(0, -1).some((p) => EXCLUDED_DIRS.has(p.toLowerCase()));
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// ── File enumeration ──────────────────────────────────────────────────────────

/**
 * List files in a repo relative to its root. Prefers `git ls-files` (tracked +
 * untracked, honouring .gitignore) and falls back to a bounded directory walk
 * when git is unavailable or the folder is not a repo.
 */
export async function listRepoFiles(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    const files = stdout.split('\0').filter((f) => f.length > 0);
    return files.filter((f) => !isExcludedPath(f));
  } catch {
    return walkDirectory(repoPath);
  }
}

function walkDirectory(root: string, maxDepth = 8): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= MAX_FILES_PER_REPO) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES_PER_REPO) return;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!EXCLUDED_DIRS.has(e.name.toLowerCase())) visit(full, depth + 1);
      } else if (e.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  visit(root, 0);
  return out;
}

// ── Indexing ──────────────────────────────────────────────────────────────────

export interface IndexableRepo {
  localPath: string;
  name: string | null;
}

export interface IndexProgress {
  phase: 'indexing' | 'done';
  reposDone: number;
  reposTotal: number;
  filesIndexed: number;
  filesSkipped: number;
  currentRepo?: string;
}

export interface IndexRunOptions {
  onProgress?: (progress: IndexProgress) => void;
  /** Called after each repo so the caller can persist incrementally. */
  onRepoDone?: (repo: IndexableRepo, index: number) => void;
  /** Return true to abort between repos. */
  shouldStop?: () => boolean;
  /** Override the per-repo content cap (tests). */
  maxContentBytesPerRepo?: number;
}

interface ExistingRow {
  id: number;
  size: number | null;
  mtime_ms: number | null;
  has_content: number;
}

function loadExistingRows(db: SqlJsDatabase, repoPath: string): Map<string, ExistingRow> {
  const map = new Map<string, ExistingRow>();
  const stmt = db.prepare('SELECT id, relative_path, size, mtime_ms, has_content FROM indexed_files WHERE repo_path = ?');
  stmt.bind([repoPath]);
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as { id: number; relative_path: string; size: number | null; mtime_ms: number | null; has_content: number };
      map.set(r.relative_path, { id: r.id, size: r.size, mtime_ms: r.mtime_ms, has_content: r.has_content });
    }
  } finally {
    stmt.free();
  }
  return map;
}

function deleteFileRow(db: SqlJsDatabase, id: number): void {
  db.run('DELETE FROM indexed_files_fts WHERE docid = ?', [id]);
  db.run('DELETE FROM indexed_files WHERE id = ?', [id]);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Index (or refresh) a single repo. Returns number of files (re)indexed. */
export async function indexRepo(
  db: SqlJsDatabase,
  repo: IndexableRepo,
  maxContentBytes = MAX_CONTENT_BYTES_PER_REPO,
): Promise<{ indexed: number; skipped: number; total: number }> {
  const started = Date.now();
  const repoPath = repo.localPath;

  if (!fs.existsSync(repoPath)) {
    // Folder is gone: drop everything we had for it.
    for (const row of loadExistingRows(db, repoPath).values()) deleteFileRow(db, row.id);
    db.run(
      `INSERT INTO indexed_repos (local_path, name, file_count, content_count, indexed_at, duration_ms, skipped_reason)
       VALUES (?, ?, 0, 0, CURRENT_TIMESTAMP, ?, 'missing')
       ON CONFLICT(local_path) DO UPDATE SET file_count = 0, content_count = 0, indexed_at = CURRENT_TIMESTAMP,
         duration_ms = excluded.duration_ms, skipped_reason = 'missing'`,
      [repoPath, repo.name, Date.now() - started],
    );
    return { indexed: 0, skipped: 0, total: 0 };
  }

  const files = prioritizeFiles((await listRepoFiles(repoPath)).slice(0, MAX_FILES_PER_REPO));
  const existing = loadExistingRows(db, repoPath);
  const seen = new Set<string>();
  let indexed = 0;
  let skipped = 0;
  let contentCount = 0;
  let contentBytes = 0;
  let sinceYield = 0;

  for (const rel of files) {
    seen.add(rel);
    const abs = path.join(repoPath, rel);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE_BYTES) { skipped++; continue; }

    const { kind, extension } = classifyFile(rel);
    let budget = Math.min(CONTENT_BUDGET[kind], stat.size);
    if (budget > 0 && contentBytes + budget > maxContentBytes) budget = 0;
    const prev = existing.get(rel);
    const mtime = Math.floor(stat.mtimeMs);
    if (prev && prev.size === stat.size && prev.mtime_ms === mtime) {
      // Unchanged since last run; its stored content still counts toward the caps.
      if (prev.has_content === 1) {
        contentCount++;
        contentBytes += Math.min(CONTENT_BUDGET[kind], stat.size);
      }
      continue;
    }

    let content = '';
    if (budget > 0) {
      try {
        const fh = await fs.promises.open(abs, 'r');
        try {
          const buf = Buffer.alloc(budget);
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          const slice = buf.subarray(0, bytesRead);
          if (!looksBinary(slice)) content = slice.toString('utf8');
        } finally {
          await fh.close();
        }
      } catch {
        content = '';
      }
    }

    if (prev) deleteFileRow(db, prev.id);
    db.run(
      `INSERT INTO indexed_files (repo_path, relative_path, extension, kind, size, mtime_ms, has_content, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [repoPath, rel, extension, kind, stat.size, mtime, content ? 1 : 0],
    );
    const idRes = db.exec('SELECT last_insert_rowid()');
    const id = idRes[0].values[0][0] as number;
    db.run('INSERT INTO indexed_files_fts (docid, repo_path, relative_path, content) VALUES (?, ?, ?, ?)', [
      id, repoPath, rel, content,
    ]);
    if (content) {
      contentCount++;
      contentBytes += Buffer.byteLength(content, 'utf8');
    }
    indexed++;

    if (++sinceYield >= 50) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }

  // Remove rows for files that no longer exist.
  for (const [rel, row] of existing) {
    if (!seen.has(rel)) deleteFileRow(db, row.id);
  }

  db.run(
    `INSERT INTO indexed_repos (local_path, name, file_count, content_count, indexed_at, duration_ms, skipped_reason)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, NULL)
     ON CONFLICT(local_path) DO UPDATE SET name = excluded.name, file_count = excluded.file_count,
       content_count = excluded.content_count, indexed_at = CURRENT_TIMESTAMP,
       duration_ms = excluded.duration_ms, skipped_reason = NULL`,
    [repoPath, repo.name, seen.size, contentCount, Date.now() - started],
  );
  return { indexed, skipped, total: seen.size };
}

/** Index every repo in the list, reporting progress; repos no longer in the list are pruned. */
export async function indexRepos(db: SqlJsDatabase, repos: IndexableRepo[], opts: IndexRunOptions = {}): Promise<IndexProgress> {
  const progress: IndexProgress = { phase: 'indexing', reposDone: 0, reposTotal: repos.length, filesIndexed: 0, filesSkipped: 0 };

  // Prune repos that Jarvis no longer knows about.
  const known = new Set(repos.map((r) => r.localPath));
  const stale = db.exec('SELECT local_path FROM indexed_repos')[0]?.values.map((v) => v[0] as string) ?? [];
  for (const p of stale) {
    if (!known.has(p)) {
      for (const row of loadExistingRows(db, p).values()) deleteFileRow(db, row.id);
      db.run('DELETE FROM indexed_repos WHERE local_path = ?', [p]);
    }
  }

  for (let i = 0; i < repos.length; i++) {
    if (opts.shouldStop?.()) break;
    const repo = repos[i];
    progress.currentRepo = repo.localPath;
    opts.onProgress?.({ ...progress });
    try {
      const r = await indexRepo(db, repo, opts.maxContentBytesPerRepo ?? MAX_CONTENT_BYTES_PER_REPO);
      progress.filesIndexed += r.indexed;
      progress.filesSkipped += r.skipped;
    } catch (err) {
      console.warn('[FileIndex] Failed to index', repo.localPath, (err as Error).message);
      db.run(
        `INSERT INTO indexed_repos (local_path, name, indexed_at, skipped_reason) VALUES (?, ?, CURRENT_TIMESTAMP, ?)
         ON CONFLICT(local_path) DO UPDATE SET indexed_at = CURRENT_TIMESTAMP, skipped_reason = excluded.skipped_reason`,
        [repo.localPath, repo.name, `error: ${(err as Error).message}`.slice(0, 200)],
      );
    }
    progress.reposDone = i + 1;
    opts.onRepoDone?.(repo, i);
  }

  db.run("INSERT INTO index_meta (key, value) VALUES ('last_run_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
    new Date().toISOString(),
  ]);
  const done: IndexProgress = { ...progress, phase: 'done', currentRepo: undefined };
  opts.onProgress?.(done);
  return done;
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface FileSearchHit {
  repoPath: string;
  repoName: string | null;
  relativePath: string;
  absolutePath: string;
  kind: FileKind;
  extension: string | null;
  size: number | null;
  modifiedAt: string | null;
  hasContent: boolean;
  /** Matched fragment with [brackets] around hits; from the path when content is not indexed. */
  snippet: string;
}

export interface FileSearchOptions {
  /** Restrict to one repo (absolute local path). */
  repoPath?: string;
  kind?: FileKind;
  limit?: number;
}

/** Turn free text into an FTS4 MATCH expression: every term required, prefix-matched. */
export function buildMatchExpression(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return terms.map((t) => `${t}*`).join(' ');
}

/** Full-text search over indexed file paths and contents. */
export function searchIndexedFiles(db: SqlJsDatabase, query: string, opts: FileSearchOptions = {}): FileSearchHit[] {
  const match = buildMatchExpression(query);
  if (!match) return [];
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const where: string[] = ['indexed_files_fts MATCH ?'];
  const params: Array<string | number> = [match];
  if (opts.repoPath) { where.push('f.repo_path = ?'); params.push(opts.repoPath); }
  if (opts.kind) { where.push('f.kind = ?'); params.push(opts.kind); }
  // Over-fetch, then rank in JS (FTS4 has no bm25).
  params.push(limit * 5);

  const stmt = db.prepare(
    `SELECT f.repo_path, f.relative_path, f.kind, f.extension, f.size, f.mtime_ms, f.has_content,
            r.name AS repo_name,
            snippet(indexed_files_fts, '[', ']', '…', -1, 14) AS snip
     FROM indexed_files_fts
     JOIN indexed_files f ON f.id = indexed_files_fts.docid
     LEFT JOIN indexed_repos r ON r.local_path = f.repo_path
     WHERE ${where.join(' AND ')}
     LIMIT ?`,
  );
  stmt.bind(params);
  const hits: FileSearchHit[] = [];
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as {
        repo_path: string; relative_path: string; kind: FileKind; extension: string | null; size: number | null;
        mtime_ms: number | null; has_content: number; repo_name: string | null; snip: string;
      };
      hits.push({
        repoPath: r.repo_path,
        repoName: r.repo_name,
        relativePath: r.relative_path,
        absolutePath: path.join(r.repo_path, r.relative_path),
        kind: r.kind,
        extension: r.extension,
        size: r.size,
        modifiedAt: r.mtime_ms ? new Date(r.mtime_ms).toISOString() : null,
        hasContent: r.has_content === 1,
        snippet: r.snip,
      });
    }
  } finally {
    stmt.free();
  }

  const terms = match.split(' ').map((t) => t.slice(0, -1));
  const score = (h: FileSearchHit): number => {
    const p = h.relativePath.toLowerCase();
    const pathHits = terms.filter((t) => p.includes(t)).length;
    return KIND_PRIORITY[h.kind] * 10 - pathHits * 3 + Math.min(p.length, 200) / 100;
  };
  return hits.sort((a, b) => score(a) - score(b)).slice(0, limit);
}

// ── Status ────────────────────────────────────────────────────────────────────

export interface IndexStatus {
  schemaVersion: number;
  repoCount: number;
  fileCount: number;
  contentCount: number;
  lastRunAt: string | null;
  repos: Array<{ localPath: string; name: string | null; fileCount: number; indexedAt: string | null; skippedReason: string | null }>;
}

export function getIndexStatus(db: SqlJsDatabase): IndexStatus {
  const counts = db.exec('SELECT COUNT(*), COALESCE(SUM(file_count), 0), COALESCE(SUM(content_count), 0) FROM indexed_repos')[0]?.values[0] ?? [0, 0, 0];
  const last = db.exec("SELECT value FROM index_meta WHERE key = 'last_run_at'")[0]?.values[0]?.[0];
  const repos: IndexStatus['repos'] = [];
  const stmt = db.prepare('SELECT local_path, name, file_count, indexed_at, skipped_reason FROM indexed_repos ORDER BY local_path');
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as { local_path: string; name: string | null; file_count: number; indexed_at: string | null; skipped_reason: string | null };
      repos.push({ localPath: r.local_path, name: r.name, fileCount: r.file_count, indexedAt: r.indexed_at, skippedReason: r.skipped_reason });
    }
  } finally {
    stmt.free();
  }
  return {
    schemaVersion: readUserVersion(db),
    repoCount: counts[0] as number,
    fileCount: counts[1] as number,
    contentCount: counts[2] as number,
    lastRunAt: typeof last === 'string' ? last : null,
    repos,
  };
}
