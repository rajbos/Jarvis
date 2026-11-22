import { describe, expect, it } from 'vitest';
import {
  errorResult,
  fileIndexMissing,
  indexStatusReply,
  jsonResult,
  okOrError,
  searchFilesReply,
  textResult,
} from '../../src/mcp-server/results';
import { searchLocalFiles, describeIndex } from '../../src/mcp-server/tools/files';
import type { IndexStatus } from '../../src/mcp-server/tools/files';

const INDEX = 'C:/fake/jarvis-index.db';

describe('MCP tool result helpers', () => {
  it('errorResult sets isError', () => {
    expect(errorResult('boom')).toEqual({ content: [{ type: 'text', text: 'boom' }], isError: true });
  });

  it('textResult and jsonResult leave isError unset', () => {
    expect(textResult('hi')).not.toHaveProperty('isError');
    const json = jsonResult({ a: 1 });
    expect(json).not.toHaveProperty('isError');
    expect(JSON.parse(json.content[0].text)).toEqual({ a: 1 });
  });

  it('okOrError flags failed results (invalid input / missing cache) as errors', () => {
    const bad = okOrError({ ok: false, error: '`from` must be YYYY-MM-DD' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toBe('`from` must be YYYY-MM-DD');

    const good = okOrError({ ok: true, value: { total: 0, rows: [] } });
    expect(good).not.toHaveProperty('isError');
  });

  it('fileIndexMissing is an error with an optional scan hint', () => {
    expect(fileIndexMissing(INDEX, false)).toEqual(errorResult(`No file index found at ${INDEX}.`));
    expect(fileIndexMissing(INDEX, true).content[0].text).toContain('Start Jarvis');
  });
});

describe('github_search_files reply', () => {
  it('reports a missing file index as an error', () => {
    const reply = searchFilesReply(searchLocalFiles(null, 'deploy'), INDEX);
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain(`No file index found at ${INDEX}`);
  });

  it('reports a valid search with no hits as success', () => {
    const reply = searchFilesReply(
      { query: 'nothing-here', indexAvailable: true, lastIndexedAt: '2026-11-01T00:00:00Z', hits: [] },
      INDEX,
    );
    expect(reply).not.toHaveProperty('isError');
    expect(reply.content[0].text).toBe('No indexed files match "nothing-here" (index last built 2026-11-01T00:00:00Z).');
  });
});

describe('github_index_status reply', () => {
  it('reports a missing file index as an error', () => {
    const reply = indexStatusReply(describeIndex(null), INDEX);
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain(`No file index found at ${INDEX}`);
  });

  it('returns the status with the index path as success', () => {
    const status = { repoCount: 0 } as unknown as IndexStatus;
    const reply = indexStatusReply(status, INDEX);
    expect(reply).not.toHaveProperty('isError');
    expect(JSON.parse(reply.content[0].text)).toEqual({ indexPath: INDEX, repoCount: 0 });
  });
});
