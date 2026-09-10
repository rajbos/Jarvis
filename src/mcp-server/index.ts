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

const server = new McpServer(
  { name: 'jarvis', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: `Jarvis local assistant data server.
Exposes data from the Jarvis SQLite database at: ${DB_PATH}

Available data:
- Ruddr projects (client/project registry)
- Groups (customers/clients with associated repos)
- OneNote cached pages (meeting notes, project documentation)`,
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
