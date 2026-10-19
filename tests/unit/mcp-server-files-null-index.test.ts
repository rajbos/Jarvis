import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// src/mcp-server/index.ts branches on these results to show the
// "No file index found ... Start Jarvis" messages, so the null contract matters.
describe('MCP file tools without an index', () => {
  it('reports the index as unavailable end to end when the file is missing', async () => {
    const missing = path.join(os.tmpdir(), `missing-index-tools-${process.pid}-${Date.now()}.db`);
    expect(fs.existsSync(missing)).toBe(false);
    vi.stubEnv('JARVIS_INDEX_DB', missing);

    const { openIndexSnapshot, INDEX_DB_PATH } = await import('../../src/mcp-server/index-db');
    const { searchLocalFiles, describeIndex } = await import('../../src/mcp-server/tools/files');
    expect(INDEX_DB_PATH).toBe(missing);

    const snapshot = await openIndexSnapshot();
    expect(snapshot).toBeNull();

    expect(searchLocalFiles(snapshot, 'deploy')).toEqual({
      query: 'deploy',
      indexAvailable: false,
      lastIndexedAt: null,
      hits: [],
    });
    expect(describeIndex(snapshot)).toBeNull();
  });
});
