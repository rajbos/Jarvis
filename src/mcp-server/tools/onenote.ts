// ── OneNote + Groups tools for the Jarvis MCP server ──────────────────────────
import type { Database as SqlJsDatabase } from 'sql.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GroupSummary {
  id: number;
  name: string;
  ruddrProjectNames: string[];
}

export interface OneNoteSection {
  groupId: number;
  groupName: string;
  relativePath: string;
  sectionName: string;
  pageCount: number;
  latestModified: string;
}

export interface OneNotePageSnippet {
  groupId: number;
  groupName: string;
  relativePath: string;
  sectionName: string;
  pageIndex: number;
  pageLevel: number;
  pageTitle: string;
  pageDate: string;
  pageLastModified: string;
  /** Short excerpt of matching content (~300 chars). */
  snippet: string;
}

export interface OneNotePageContent {
  groupId: number;
  groupName: string;
  relativePath: string;
  sectionName: string;
  pageIndex: number;
  pageLevel: number;
  pageTitle: string;
  pageDate: string;
  pageLastModified: string;
  /** Full page content, possibly truncated. */
  content: string;
  truncated: boolean;
  totalChars: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string');
  } catch { /* legacy */ }
  return [raw];
}

function makeSnippet(content: string, query: string, maxLen = 300): string {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return content.slice(0, maxLen);
  const start = Math.max(0, idx - 80);
  const end = Math.min(content.length, idx + 220);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return prefix + content.slice(start, end) + suffix;
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** List all groups (id, name, associated Ruddr project names). */
export function listGroups(db: SqlJsDatabase): GroupSummary[] {
  const stmt = db.prepare(
    'SELECT id, name, ruddr_project_name FROM groups ORDER BY name COLLATE NOCASE',
  );
  const results: GroupSummary[] = [];
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as { id: number; name: string; ruddr_project_name: string | null };
      results.push({ id: r.id, name: r.name, ruddrProjectNames: parseJsonArray(r.ruddr_project_name) });
    }
  } finally {
    stmt.free();
  }
  return results;
}

/** List all OneNote sections across all groups (or filtered to one group). */
export function listOneNoteSections(db: SqlJsDatabase, groupId?: number): OneNoteSection[] {
  const where = groupId != null ? 'AND cf.group_id = ?' : '';
  const stmt = db.prepare(`
    SELECT
      g.id           AS group_id,
      g.name         AS group_name,
      c.relative_path,
      COALESCE(c.section_name, '') AS section_name,
      COUNT(*)       AS page_count,
      MAX(COALESCE(c.page_last_modified, '')) AS latest_modified
    FROM onedrive_onenote_cache c
    JOIN onedrive_customer_folders cf ON cf.id = c.folder_id
    JOIN groups g ON g.id = cf.group_id
    WHERE 1=1 ${where}
    GROUP BY g.id, g.name, c.relative_path, c.section_name
    ORDER BY g.name COLLATE NOCASE, c.relative_path
  `);
  if (groupId != null) stmt.bind([groupId]);

  const results: OneNoteSection[] = [];
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as {
        group_id: number; group_name: string; relative_path: string;
        section_name: string; page_count: number; latest_modified: string;
      };
      results.push({
        groupId: r.group_id,
        groupName: r.group_name,
        relativePath: r.relative_path,
        sectionName: r.section_name,
        pageCount: r.page_count,
        latestModified: r.latest_modified,
      });
    }
  } finally {
    stmt.free();
  }
  return results;
}

/**
 * Full-text search over cached OneNote page content.
 * Returns snippet results (not full content) to keep responses concise.
 */
export function searchOneNotePages(
  db: SqlJsDatabase,
  query: string,
  groupId?: number,
  limit = 20,
): OneNotePageSnippet[] {
  const where = groupId != null ? 'AND cf.group_id = ?' : '';
  // Use LIKE for substring search; % wildcards on both sides.
  const likeQuery = `%${query}%`;
  const stmt = db.prepare(`
    SELECT
      g.id           AS group_id,
      g.name         AS group_name,
      c.relative_path,
      COALESCE(c.section_name, '') AS section_name,
      c.page_index,
      c.page_level,
      COALESCE(c.page_title, '')    AS page_title,
      COALESCE(c.page_date, '')     AS page_date,
      COALESCE(c.page_last_modified, '') AS page_last_modified,
      c.page_content
    FROM onedrive_onenote_cache c
    JOIN onedrive_customer_folders cf ON cf.id = c.folder_id
    JOIN groups g ON g.id = cf.group_id
    WHERE (c.page_title LIKE ? OR c.page_content LIKE ?) ${where}
    ORDER BY c.page_last_modified DESC
    LIMIT ?
  `);
  const params: (string | number)[] = [likeQuery, likeQuery];
  if (groupId != null) params.push(groupId);
  params.push(limit);
  stmt.bind(params);

  const results: OneNotePageSnippet[] = [];
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as {
        group_id: number; group_name: string; relative_path: string;
        section_name: string; page_index: number; page_level: number;
        page_title: string; page_date: string; page_last_modified: string;
        page_content: string | null;
      };
      results.push({
        groupId: r.group_id,
        groupName: r.group_name,
        relativePath: r.relative_path,
        sectionName: r.section_name,
        pageIndex: r.page_index,
        pageLevel: r.page_level,
        pageTitle: r.page_title,
        pageDate: r.page_date,
        pageLastModified: r.page_last_modified,
        snippet: makeSnippet(r.page_content ?? '', query),
      });
    }
  } finally {
    stmt.free();
  }
  return results;
}

/**
 * Retrieve the full content of a specific OneNote page.
 * Identified by group name/id, relative file path, and page index.
 */
export function getOneNotePageContent(
  db: SqlJsDatabase,
  groupId: number,
  relativePath: string,
  pageIndex: number,
  maxChars = 8000,
): OneNotePageContent | null {
  const stmt = db.prepare(`
    SELECT
      g.id           AS group_id,
      g.name         AS group_name,
      c.relative_path,
      COALESCE(c.section_name, '') AS section_name,
      c.page_index,
      c.page_level,
      COALESCE(c.page_title, '')    AS page_title,
      COALESCE(c.page_date, '')     AS page_date,
      COALESCE(c.page_last_modified, '') AS page_last_modified,
      c.page_content
    FROM onedrive_onenote_cache c
    JOIN onedrive_customer_folders cf ON cf.id = c.folder_id
    JOIN groups g ON g.id = cf.group_id
    WHERE cf.group_id = ? AND c.relative_path = ? AND c.page_index = ?
    LIMIT 1
  `);
  stmt.bind([groupId, relativePath, pageIndex]);
  try {
    if (!stmt.step()) return null;
    const r = stmt.getAsObject() as {
      group_id: number; group_name: string; relative_path: string;
      section_name: string; page_index: number; page_level: number;
      page_title: string; page_date: string; page_last_modified: string;
      page_content: string | null;
    };
    const fullContent = r.page_content ?? '';
    const truncated = fullContent.length > maxChars;
    return {
      groupId: r.group_id,
      groupName: r.group_name,
      relativePath: r.relative_path,
      sectionName: r.section_name,
      pageIndex: r.page_index,
      pageLevel: r.page_level,
      pageTitle: r.page_title,
      pageDate: r.page_date,
      pageLastModified: r.page_last_modified,
      content: truncated ? fullContent.slice(0, maxChars) : fullContent,
      truncated,
      totalChars: fullContent.length,
    };
  } finally {
    stmt.free();
  }
}
