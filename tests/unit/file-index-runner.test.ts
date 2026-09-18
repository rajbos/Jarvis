/// <reference path="../../src/types/sql.js.d.ts" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({
  dbPath: null as string | null,
  repos: [] as Array<{ localPath: string; name: string }>,
}));

vi.mock('../../src/storage/database', () => ({
  getDatabasePath: () => state.dbPath,
}));

vi.mock('../../src/services/local-discovery', () => ({
  listLocalRepos: () => state.repos,
}));

import {
  _resetFileIndexStateForTests,
  getFileIndexState,
  resolveIndexPath,
  startFileIndexIfNeeded,
} from '../../src/plugins/local-repos/file-index-runner';
import { INDEX_DB_FILENAME } from '../../src/services/local-file-index';
import { searchLocalFiles, describeIndex } from '../../src/mcp-server/tools/files';
import { openIndexDatabase } from '../../src/services/local-file-index';

async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('file index runner', () => {
  let tmp: string;
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const getWindow = () => ({ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }) as never;

  beforeEach(() => {
    _resetFileIndexStateForTests();
    sent.length = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runner-'));
    state.dbPath = path.join(tmp, 'jarvis.db');
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'scripts', 'minutes.ps1'), '# collect pipeline minutes from azure devops');
    state.repos = [{ localPath: repo, name: 'repo' }];
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves the index path next to the main database', () => {
    expect(resolveIndexPath()).toBe(path.join(tmp, INDEX_DB_FILENAME));
    state.dbPath = null;
    expect(resolveIndexPath()).toBeNull();
  });

  it('does not start without a database path or repos', () => {
    state.dbPath = null;
    expect(startFileIndexIfNeeded({} as never, getWindow)).toBe(false);
    state.dbPath = path.join(tmp, 'jarvis.db');
    state.repos = [];
    expect(startFileIndexIfNeeded({} as never, getWindow)).toBe(false);
  });

  it('builds the index file, emits progress, and refuses to run twice concurrently', async () => {
    expect(startFileIndexIfNeeded({} as never, getWindow)).toBe(true);
    expect(startFileIndexIfNeeded({} as never, getWindow)).toBe(false);
    expect((await getFileIndexState()).running).toBe(true);

    await waitFor(async () => !(await getFileIndexState()).running);

    const indexPath = path.join(tmp, INDEX_DB_FILENAME);
    expect(fs.existsSync(indexPath)).toBe(true);
    expect(sent.some((s) => s.channel === 'local:index-progress')).toBe(true);
    const complete = sent.find((s) => s.channel === 'local:index-complete');
    expect(complete).toBeDefined();
    expect((complete!.payload as { phase: string }).phase).toBe('done');

    const finalState = await getFileIndexState();
    expect(finalState.error).toBeNull();
    expect(finalState.status?.repoCount).toBe(1);
    expect(finalState.status?.fileCount).toBe(1);

    // The MCP-side helpers read the same file the app just wrote
    const idx = await openIndexDatabase(indexPath);
    try {
      const result = searchLocalFiles(idx, 'pipeline minutes');
      expect(result.indexAvailable).toBe(true);
      expect(result.hits[0].relativePath).toBe('scripts/minutes.ps1');
      expect(describeIndex(idx)?.repoCount).toBe(1);
    } finally {
      idx.close();
    }
    expect(searchLocalFiles(null, 'x')).toEqual({ query: 'x', indexAvailable: false, lastIndexedAt: null, hits: [] });
    expect(describeIndex(null)).toBeNull();
  });
});
