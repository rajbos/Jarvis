#!/usr/bin/env node
// ── Jarvis MCP Server ──────────────────────────────────────────────────────────
// Exposes Jarvis local database data (Ruddr projects, OneNote pages) via the
// Model Context Protocol over stdio. Intended for use with Claude Desktop or
// any other MCP-compatible client.
//
// Usage: node dist/mcp-server/index.js
//
// Environment variables:
//   JARVIS_DB  — override the default database path
//                Default: %APPDATA%\Jarvis\jarvis.db

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openSnapshot, DB_PATH } from './db.js';
import {
  listRuddrProjects,
  getRuddrProjectByName,
  getRuddrProjectByPath,
  listGroupsWithRuddr,
} from './tools/ruddr.js';
import {
  listGroups,
  listOneNoteSections,
  searchOneNotePages,
  getOneNotePageContent,
} from './tools/onenote.js';
import { getCustomerBudget, listRuddrBudgets } from './tools/ruddr-budgets.js';
import {
  findAnywhere,
  listNotifications,
  listWorkflowRuns,
  searchGitHubRepos,
  searchLocalRepos,
} from './tools/github.js';

const server = new McpServer(
  { name: 'jarvis', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: `Jarvis local assistant data server.
Exposes data cached by the Jarvis desktop app in its SQLite database at: ${DB_PATH}
Everything is read-only and comes from the cache; this server holds no GitHub or Ruddr credentials
and never calls those services itself.

Tool families:
- github_*  : cached GitHub data: discovered remote repos, local git clones on disk, notifications,
              workflow runs. Start with github_find to locate something when you do not know where it lives.
- ruddr_*   : Ruddr project registry and cached budget/actuals. Use ruddr_customer_budget for
              "what is the budget utilization for customer X".
- groups_*  : customer/client groups that tie repos and Ruddr projects together.
- onenote_* : cached OneNote pages (meeting notes, project documentation).`,
  },
);

// ── Tool: ruddr_list_projects ─────────────────────────────────────────────────

server.registerTool(
  'ruddr_list_projects',
  {
    title: 'List Ruddr projects',
    description:
      'Returns all Ruddr projects cached in the Jarvis database. ' +
      'Each project has a name, a URL path (unique key), optional notes, ' +
      'and an optional cloud folder URL.',
  },
  async () => {
    const db = await openSnapshot();
    try {
      const projects = listRuddrProjects(db);
      return {
        content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }],
      };
    } finally {
      db.close();
    }
  },
);

// ── Tool: ruddr_get_project ───────────────────────────────────────────────────

server.registerTool(
  'ruddr_get_project',
  {
    title: 'Get Ruddr project',
    description:
      'Look up a single Ruddr project. Provide exactly one of `name` (case-insensitive) ' +
      'or `path` (the URL path that is the primary key in Ruddr, e.g. "/projects/acme-corp").',
    inputSchema: {
      name: z.string().optional().describe('Project name (case-insensitive)'),
      path: z.string().optional().describe('Project URL path (primary key)'),
    },
  },
  async ({ name, path }: { name?: string; path?: string }) => {
    if (!name && !path) {
      return { content: [{ type: 'text' as const, text: 'Error: provide either "name" or "path".' }], isError: true };
    }
    const db = await openSnapshot();
    try {
      const project = path
        ? getRuddrProjectByPath(db, path)
        : getRuddrProjectByName(db, name!);
      if (!project) {
        return { content: [{ type: 'text' as const, text: `No project found for ${path ? `path="${path}"` : `name="${name}"`}.` }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(project, null, 2) }] };
    } finally {
      db.close();
    }
  },
);

// ── Tool: groups_list ─────────────────────────────────────────────────────────

server.registerTool(
  'groups_list',
  {
    title: 'List groups',
    description:
      'Returns all customer/client groups configured in Jarvis, with their IDs and ' +
      'associated Ruddr project names. Use group IDs with the OneNote tools.',
  },
  async () => {
    const db = await openSnapshot();
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(listGroups(db), null, 2) }] };
    } finally {
      db.close();
    }
  },
);

// ── Tool: groups_with_ruddr ───────────────────────────────────────────────────

server.registerTool(
  'groups_with_ruddr',
  {
    title: 'List groups with Ruddr associations',
    description:
      'Returns only the groups that have at least one Ruddr project linked, ' +
      'showing both the group details and the linked Ruddr project names/paths.',
  },
  async () => {
    const db = await openSnapshot();
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(listGroupsWithRuddr(db), null, 2) }] };
    } finally {
      db.close();
    }
  },
);

// ── Tool: onenote_list_sections ───────────────────────────────────────────────

server.registerTool(
  'onenote_list_sections',
  {
    title: 'List OneNote sections',
    description:
      'Lists all cached OneNote sections (files) with page counts and last-modified dates. ' +
      'Optionally filter to a single group with `groupId`.',
    inputSchema: {
      groupId: z.number().int().optional().describe('Filter to a specific group ID (from groups_list)'),
    },
  },
  async ({ groupId }: { groupId?: number }) => {
    const db = await openSnapshot();
    try {
      const sections = listOneNoteSections(db, groupId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(sections, null, 2) }] };
    } finally {
      db.close();
    }
  },
);

// ── Tool: onenote_search ──────────────────────────────────────────────────────

server.registerTool(
  'onenote_search',
  {
    title: 'Search OneNote pages',
    description:
      'Searches cached OneNote page titles and content for the given keyword or phrase. ' +
      'Returns page metadata and a short content snippet. ' +
      'Optionally filter to a single group with `groupId`, control result count with `limit`.',
    inputSchema: {
      query:   z.string().min(1).describe('Search keyword or phrase'),
      groupId: z.number().int().optional().describe('Limit search to a specific group ID'),
      limit:   z.number().int().min(1).max(100).optional().default(20).describe('Maximum results (default 20, max 100)'),
    },
  },
  async ({ query, groupId, limit }: { query: string; groupId?: number; limit?: number }) => {
    const db = await openSnapshot();
    try {
      const results = searchOneNotePages(db, query, groupId, limit ?? 20);
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: `No pages found matching "${query}".` }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    } finally {
      db.close();
    }
  },
);

// ── Tool: onenote_get_page ────────────────────────────────────────────────────

server.registerTool(
  'onenote_get_page',
  {
    title: 'Get OneNote page content',
    description:
      'Retrieves the full content of a specific OneNote page. ' +
      'Use `groupId`, `relativePath`, and `pageIndex` exactly as returned by ' +
      '`onenote_list_sections` or `onenote_search`. ' +
      'Content is capped at `maxChars` characters (default 8000); ' +
      'check the `truncated` and `totalChars` fields in the response.',
    inputSchema: {
      groupId:      z.number().int().describe('Group ID the page belongs to'),
      relativePath: z.string().describe('Relative path of the .one section file'),
      pageIndex:    z.number().int().min(0).describe('Zero-based page index within the section'),
      maxChars:     z.number().int().min(100).max(50000).optional().default(8000).describe('Maximum content characters to return (default 8000)'),
    },
  },
  async ({ groupId, relativePath, pageIndex, maxChars }: { groupId: number; relativePath: string; pageIndex: number; maxChars?: number }) => {
    const db = await openSnapshot();
    try {
      const page = getOneNotePageContent(db, groupId, relativePath, pageIndex, maxChars ?? 8000);
      if (!page) {
        return { content: [{ type: 'text' as const, text: `Page not found: groupId=${groupId}, path="${relativePath}", index=${pageIndex}` }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(page, null, 2) }] };
    } finally {
      db.close();
    }
  },
);

// ── Tool: ruddr_customer_budget ───────────────────────────────────────────────

server.registerTool(
  'ruddr_customer_budget',
  {
    title: 'Customer budget utilization',
    description:
      'Answers "what is the budget utilization for customer X?". Resolves the customer name to a ' +
      'Jarvis group (fuzzy match), then returns cached Ruddr budget, budget left, actual hours and a ' +
      'computed utilization fraction (0..1, >1 = over budget) for every linked project, plus totals. ' +
      'Falls back to matching Ruddr project names directly when no group matches. ' +
      'Check `budgetCacheAvailable` and `fetchedAt`: data is a cache scraped by the Jarvis app, not live.',
    inputSchema: {
      customer: z.string().min(1).describe('Customer / group name, e.g. "Acme" (fuzzy, case-insensitive)'),
    },
  },
  async ({ customer }: { customer: string }) => {
    const db = await openSnapshot();
    try {
      const summary = getCustomerBudget(db, customer);
      if (summary.resolution === 'none') {
        const hint = summary.candidates.length > 0
          ? ` Closest groups: ${summary.candidates.map((c) => c.name).join(', ')}.`
          : ' Use groups_list to see available customers.';
        return { content: [{ type: 'text' as const, text: `No customer or Ruddr project matched "${customer}".${hint}` }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }] };
    } finally {
      db.close();
    }
  },
);

// ── Tool: ruddr_list_budgets ──────────────────────────────────────────────────

server.registerTool(
  'ruddr_list_budgets',
  {
    title: 'List all cached Ruddr budgets',
    description:
      'Returns budget, budget left, actual hours and computed utilization for every Ruddr project ' +
      'that has a cached budget. Empty when the Jarvis app has not scraped budgets yet.',
  },
  async () => {
    const db = await openSnapshot();
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(listRuddrBudgets(db), null, 2) }] };
    } finally {
      db.close();
    }
  },
);

// ── Tool: github_find ─────────────────────────────────────────────────────────

server.registerTool(
  'github_find',
  {
    title: 'Find across all cached GitHub data',
    description:
      'One-shot search across cached remote GitHub repos, local git clones on disk and GitHub ' +
      'notifications. Use this first when you do not know where something lives (e.g. "azure devops ' +
      'pipeline minutes script"). All words must match; matching is over repo names, descriptions, ' +
      'languages, local paths, remote URLs and notification titles. Remote hits include any known ' +
      'local clone paths. Note: file contents inside repos are not indexed, only repo-level metadata.',
    inputSchema: {
      query: z.string().min(1).describe('Search words (all must match)'),
      limitPerSource: z.number().int().min(1).max(50).optional().default(10).describe('Max hits per source (default 10)'),
    },
  },
  async ({ query, limitPerSource }: { query: string; limitPerSource?: number }) => {
    const db = await openSnapshot();
    try {
      const result = findAnywhere(db, query, limitPerSource ?? 10);
      const total = result.repos.length + result.localRepos.length + result.notifications.length;
      if (total === 0) {
        return { content: [{ type: 'text' as const, text: `Nothing cached matches "${query}". Try fewer or different words.` }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } finally {
      db.close();
    }
  },
);

// ── Tool: github_search_repos ─────────────────────────────────────────────────

server.registerTool(
  'github_search_repos',
  {
    title: 'Search cached GitHub repos',
    description:
      'Search remote GitHub repos discovered by Jarvis (own, org and starred repos) by words in the ' +
      'full name, description or language. Returns metadata plus any local clone paths. ' +
      'Archived repos are excluded unless `includeArchived` is true.',
    inputSchema: {
      query: z.string().min(1).describe('Search words (all must match)'),
      owner: z.string().optional().describe('Restrict to one owner/org login'),
      includeArchived: z.boolean().optional().default(false),
      limit: z.number().int().min(1).max(200).optional().default(20),
    },
  },
  async ({ query, owner, includeArchived, limit }: { query: string; owner?: string; includeArchived?: boolean; limit?: number }) => {
    const db = await openSnapshot();
    try {
      const repos = searchGitHubRepos(db, query, { owner, includeArchived: includeArchived ?? false, limit: limit ?? 20 });
      if (repos.length === 0) {
        return { content: [{ type: 'text' as const, text: `No cached repos match "${query}".` }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(repos, null, 2) }] };
    } finally {
      db.close();
    }
  },
);

// ── Tool: github_local_repos ──────────────────────────────────────────────────

server.registerTool(
  'github_local_repos',
  {
    title: 'List local git clones',
    description:
      'Lists git repositories Jarvis found on this machine, with their absolute paths, remotes and ' +
      'the linked GitHub repo (if any). Optional `query` filters by words in the folder name, path, ' +
      'remote URL or linked repo name/description.',
    inputSchema: {
      query: z.string().optional().describe('Filter words (all must match); omit to list everything'),
      limit: z.number().int().min(1).max(500).optional().default(50),
    },
  },
  async ({ query, limit }: { query?: string; limit?: number }) => {
    const db = await openSnapshot();
    try {
      const repos = searchLocalRepos(db, query, limit ?? 50);
      if (repos.length === 0) {
        return { content: [{ type: 'text' as const, text: query ? `No local repos match "${query}".` : 'No local repos have been discovered yet.' }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(repos, null, 2) }] };
    } finally {
      db.close();
    }
  },
);

// ── Tool: github_notifications ────────────────────────────────────────────────

server.registerTool(
  'github_notifications',
  {
    title: 'List cached GitHub notifications',
    description:
      'Returns GitHub notifications cached by Jarvis, newest first. Filter by `repo` ("owner/repo" ' +
      'or just "owner"), `unreadOnly`, `since` (ISO timestamp) and free-text `query` over the title, ' +
      'repo and actor.',
    inputSchema: {
      query: z.string().optional().describe('Search words over subject title, repo name and actor'),
      repo: z.string().optional().describe('"owner/repo" for one repo or "owner" for all repos of an owner'),
      unreadOnly: z.boolean().optional().default(false),
      since: z.string().optional().describe('ISO 8601 timestamp; only notifications updated at or after it'),
      limit: z.number().int().min(1).max(500).optional().default(50),
    },
  },
  async ({ query, repo, unreadOnly, since, limit }: { query?: string; repo?: string; unreadOnly?: boolean; since?: string; limit?: number }) => {
    const db = await openSnapshot();
    try {
      const items = listNotifications(db, { query, repo, unreadOnly: unreadOnly ?? false, since, limit: limit ?? 50 });
      if (items.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No cached notifications match the given filters.' }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }] };
    } finally {
      db.close();
    }
  },
);

// ── Tool: github_workflow_runs ────────────────────────────────────────────────

server.registerTool(
  'github_workflow_runs',
  {
    title: 'List cached GitHub Actions runs',
    description:
      'Returns GitHub Actions workflow runs cached by Jarvis, newest first. Filter by `repo` ' +
      '("owner/repo") and `conclusion` (e.g. "failure", "success").',
    inputSchema: {
      repo: z.string().optional().describe('"owner/repo"'),
      conclusion: z.string().optional().describe('e.g. "failure", "success", "cancelled"'),
      limit: z.number().int().min(1).max(500).optional().default(50),
    },
  },
  async ({ repo, conclusion, limit }: { repo?: string; conclusion?: string; limit?: number }) => {
    const db = await openSnapshot();
    try {
      const runs = listWorkflowRuns(db, { repo, conclusion, limit: limit ?? 50 });
      if (runs.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No cached workflow runs match the given filters.' }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(runs, null, 2) }] };
    } finally {
      db.close();
    }
  },
);

// ── Start ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so stdout remains clean for MCP protocol messages
  process.stderr.write(`[Jarvis MCP] Server started. Database: ${DB_PATH}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`[Jarvis MCP] Fatal: ${String(err)}\n`);
  process.exit(1);
});
