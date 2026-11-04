/// <reference path="../../src/types/sql.js.d.ts" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryIndexDatabase, indexRepos } from '../../src/services/local-file-index';
import { searchFilesForChat } from '../../src/plugins/chat/db-helpers';

describe('searchFilesForChat', { timeout: 30_000 }, () => {
  let db: SqlJsDatabase;
  let tmp: string;
  let repo: string;

  beforeEach(async () => {
    db = await createMemoryIndexDatabase();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-chat-files-'));
    repo = path.join(tmp, 'azdo-tools');
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'scripts', 'Get-PipelineMinutes.ps1'), '# Collect the pipeline minutes used per project');
    fs.writeFileSync(path.join(repo, 'README.md'), '# AzDO tools');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('explains that the index is missing when there is no database', () => {
    expect(searchFilesForChat(null, 'pipeline')).toContain('has not been built yet');
  });

  it('explains that the index is missing when it is empty', () => {
    expect(searchFilesForChat(db, 'pipeline')).toContain('has not been built yet');
  });

  it('asks for search terms when the query is blank', () => {
    expect(searchFilesForChat(db, '  ')).toBe('No search terms provided.');
  });

  it('formats hits with path, repo, kind and snippet', async () => {
    await indexRepos(db, [{ localPath: repo, name: 'azdo-tools' }]);
    const out = searchFilesForChat(db, 'pipeline minutes');
    expect(out).toContain('Found 1 file matching "pipeline minutes"');
    expect(out).toContain(path.join(repo, 'scripts', 'Get-PipelineMinutes.ps1'));
    expect(out).toContain('[azdo-tools, script]');
    expect(out).toContain('[pipeline]');
  });

  it('reports no matches with the index age', async () => {
    await indexRepos(db, [{ localPath: repo, name: 'azdo-tools' }]);
    expect(searchFilesForChat(db, 'zzzunmatched')).toContain('No indexed files match "zzzunmatched"');
  });

  it('applies kind and repoPath filters and ignores unknown kinds', async () => {
    await indexRepos(db, [{ localPath: repo, name: 'azdo-tools' }]);
    expect(searchFilesForChat(db, 'pipeline', { kind: 'doc' })).toContain('No indexed files match');
    expect(searchFilesForChat(db, 'pipeline', { kind: 'bogus' })).toContain('Found 1 file');
    expect(searchFilesForChat(db, 'pipeline', { repoPath: path.join(tmp, 'elsewhere') })).toContain('No indexed files match');
  });
});
