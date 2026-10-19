/// <reference path="../../src/types/sql.js.d.ts" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tempPaths: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { force: true });
  }
});

async function writeIndex(label: string, values: string[]): Promise<string> {
  const SQL = await initSqlJs();
  const source = new SQL.Database();
  source.run('CREATE TABLE sample (value TEXT)');
  for (const v of values) source.run('INSERT INTO sample VALUES (?)', [v]);
  const dbPath = path.join(os.tmpdir(), `jarvis-index-${label}-${process.pid}-${Date.now()}.db`);
  tempPaths.push(dbPath);
  fs.writeFileSync(dbPath, Buffer.from(source.export()));
  source.close();
  return dbPath;
}

describe('MCP index snapshot loader', () => {
  it('loads a snapshot from JARVIS_INDEX_DB', async () => {
    const dbPath = await writeIndex('load', ['first']);
    vi.stubEnv('JARVIS_INDEX_DB', dbPath);
    const { INDEX_DB_PATH, openIndexSnapshot } = await import('../../src/mcp-server/index-db');
    expect(INDEX_DB_PATH).toBe(dbPath);

    const db = await openIndexSnapshot();
    expect(db!.exec('SELECT value FROM sample')[0].values[0][0]).toBe('first');
  });

  it('reuses the parsed database while the file is unchanged', async () => {
    const dbPath = await writeIndex('cache', ['only']);
    vi.stubEnv('JARVIS_INDEX_DB', dbPath);
    const { openIndexSnapshot } = await import('../../src/mcp-server/index-db');
    const readSpy = vi.spyOn(fs, 'readFileSync');

    const first = await openIndexSnapshot();
    const second = await openIndexSnapshot();
    expect(second).toBe(first);
    expect(readSpy.mock.calls.filter(([p]) => p === dbPath)).toHaveLength(1);

    fs.appendFileSync(dbPath, Buffer.alloc(1));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(dbPath, future, future);
    const third = await openIndexSnapshot();
    expect(third).not.toBe(first);
    expect(readSpy.mock.calls.filter(([p]) => p === dbPath)).toHaveLength(2);
    readSpy.mockRestore();
  });

  it('returns null instead of throwing when the index is missing', async () => {
    const dbPath = path.join(os.tmpdir(), `missing-index-${process.pid}-${Date.now()}.db`);
    tempPaths.push(dbPath);
    vi.stubEnv('JARVIS_INDEX_DB', dbPath);
    const { openIndexSnapshot } = await import('../../src/mcp-server/index-db');
    await expect(openIndexSnapshot()).resolves.toBeNull();
  });

  it('drops the cached handle when the index is deleted and recreated', async () => {
    const dbPath = await writeIndex('recreate', ['old']);
    vi.stubEnv('JARVIS_INDEX_DB', dbPath);
    const { openIndexSnapshot } = await import('../../src/mcp-server/index-db');

    const first = await openIndexSnapshot();
    const stat = fs.statSync(dbPath);
    fs.rmSync(dbPath);
    expect(await openIndexSnapshot()).toBeNull();

    // Same size and mtime, different content: only a cleared cache notices.
    const replacement = await writeIndex('recreate-new', ['new']);
    expect(fs.statSync(replacement).size).toBe(stat.size);
    fs.renameSync(replacement, dbPath);
    fs.utimesSync(dbPath, stat.atime, stat.mtime);

    const second = await openIndexSnapshot();
    expect(second).not.toBe(first);
    expect(second!.exec('SELECT value FROM sample')[0].values[0][0]).toBe('new');
  });
});
