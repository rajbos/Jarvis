// ── MCP tool result helpers ───────────────────────────────────────────────────
// Convention for every tool in ./index.ts:
//   - errorResult (isError: true) when a prerequisite is missing (database, file
//     index, cache not built yet), the input is invalid, or a lookup by exact
//     key/id finds nothing. MCP clients branch on isError to surface the problem.
//   - textResult / jsonResult (no isError) for successful calls, including a
//     search that legitimately matched nothing: "found nothing" is a valid answer.

import type { FileSearchResult, IndexStatus } from './tools/files.js';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Maps an `{ ok, value | error }` result onto a tool result: errors become isError. */
export function okOrError<T>(result: { ok: true; value: T } | { ok: false; error: string }): ToolResult {
  return result.ok ? jsonResult(result.value) : errorResult(result.error);
}

export function fileIndexMissing(indexPath: string, withScanHint: boolean): ToolResult {
  const hint = withScanHint ? ' Start Jarvis and let the local repo scan finish; the index is built right after it.' : '';
  return errorResult(`No file index found at ${indexPath}.${hint}`);
}

export function searchFilesReply(result: FileSearchResult, indexPath: string): ToolResult {
  if (!result.indexAvailable) return fileIndexMissing(indexPath, true);
  if (result.hits.length === 0) {
    return textResult(`No indexed files match "${result.query}" (index last built ${result.lastIndexedAt ?? 'unknown'}).`);
  }
  return jsonResult(result);
}

export function indexStatusReply(status: IndexStatus | null, indexPath: string): ToolResult {
  if (!status) return fileIndexMissing(indexPath, true);
  return jsonResult({ indexPath, ...status });
}
