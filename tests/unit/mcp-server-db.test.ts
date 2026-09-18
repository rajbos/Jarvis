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

describe('MCP database snapshot loader', () => {
  it('loads a fresh snapshot from JARVIS_DB', async () => {
    const SQL = await initSqlJs();
    const source = new SQL.Database();
    source.run('CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES (\'first\')');
    const dbPath = path.join(os.tmpdir(), `jarvis-mcp-${process.pid}-${Date.now()}.db`);
    tempPaths.push(dbPath);
    fs.writeFileSync(dbPath, Buffer.from(source.export()));
    source.close();

    vi.stubEnv('JARVIS_DB', dbPath);
    const { DB_PATH, openSnapshot } = await import('../../src/mcp-server/db');
    expect(DB_PATH).toBe(dbPath);

    const first = await openSnapshot();
    expect(first.exec('SELECT value FROM sample')[0].values[0][0]).toBe('first');
    first.close();

    const updated = new SQL.Database(fs.readFileSync(dbPath));
    updated.run("INSERT INTO sample VALUES ('second')");
    fs.writeFileSync(dbPath, Buffer.from(updated.export()));
    updated.close();

    const second = await openSnapshot();
    expect(second.exec('SELECT value FROM sample ORDER BY rowid')[0].values).toEqual([
      ['first'],
      ['second'],
    ]);
    second.close();
  });

  it('reports the resolved path when the database is missing', async () => {
    const dbPath = path.join(os.tmpdir(), `missing-jarvis-${process.pid}-${Date.now()}.db`);
    tempPaths.push(dbPath);
    vi.stubEnv('JARVIS_DB', dbPath);

    const { openSnapshot } = await import('../../src/mcp-server/db');
    await expect(openSnapshot()).rejects.toThrow(`Jarvis database not found at: ${dbPath}`);
  });
});
