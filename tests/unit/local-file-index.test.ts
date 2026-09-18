/// <reference path="../../src/types/sql.js.d.ts" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildMatchExpression,
  classifyFile,
  createMemoryIndexDatabase,
  getIndexDbPath,
  getIndexStatus,
  indexRepos,
  initializeIndexSchema,
  listRepoFiles,
  openIndexDatabase,
  saveIndexDatabase,
  searchIndexedFiles,
  INDEX_DB_FILENAME,
  INDEX_SCHEMA_VERSION,
} from '../../src/services/local-file-index';

function write(root: string, rel: string, content: string | Buffer): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('local file index', () => {
  let db: SqlJsDatabase;
  let tmp: string;
  let repoA: string;
  let repoB: string;

  beforeEach(async () => {
    db = await createMemoryIndexDatabase();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-index-'));
    repoA = path.join(tmp, 'azdo-tools');
    repoB = path.join(tmp, 'other');
    write(repoA, 'README.md', '# AzDO tools\nHelpers for Azure DevOps.');
    write(repoA, 'scripts/Get-PipelineMinutes.ps1', 'param($org)\n# Collect the pipeline minutes used per project in Azure DevOps\nInvoke-RestMethod ...');
    write(repoA, 'src/app.ts', 'export const version = "1.0";');
    write(repoA, 'node_modules/dep/index.js', 'pipeline minutes should never be indexed');
    write(repoA, 'assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]));
    write(repoA, 'package-lock.json', '{"pipeline": "minutes"}');
    write(repoB, 'notes.txt', 'nothing relevant here');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('derives the index path next to the main database', () => {
    expect(getIndexDbPath('C:\\data\\Jarvis\\jarvis.db')).toBe(path.join('C:\\data\\Jarvis', INDEX_DB_FILENAME));
  });

  it('classifies files by extension and basename', () => {
    expect(classifyFile('scripts/a.ps1').kind).toBe('script');
    expect(classifyFile('README.md').kind).toBe('doc');
    expect(classifyFile('.github/workflows/ci.yml').kind).toBe('config');
    expect(classifyFile('Dockerfile').kind).toBe('config');
    expect(classifyFile('src/app.ts').kind).toBe('source');
    expect(classifyFile('package-lock.json').kind).toBe('other');
    expect(classifyFile('lib/vendor.min.js').kind).toBe('other');
    expect(classifyFile('logo.png')).toEqual({ kind: 'other', extension: 'png' });
  });

  it('builds prefix AND match expressions', () => {
    expect(buildMatchExpression('Azure DevOps pipeline-minutes')).toBe('azure* devops* pipeline* minutes*');
    expect(buildMatchExpression('  ')).toBe('');
  });

  it('lists files (via git or a walk) while excluding vendored folders', async () => {
    const files = await listRepoFiles(repoA);
    expect(files).toContain('scripts/Get-PipelineMinutes.ps1');
    expect(files).toContain('README.md');
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
  });

  it('indexes repos and finds a script by what it does', async () => {
    const done = await indexRepos(db, [
      { localPath: repoA, name: 'azdo-tools' },
      { localPath: repoB, name: 'other' },
    ]);
    expect(done.phase).toBe('done');
    expect(done.reposDone).toBe(2);
    expect(done.filesIndexed).toBeGreaterThanOrEqual(5);

    const hits = searchIndexedFiles(db, 'pipeline minutes');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].relativePath).toBe('scripts/Get-PipelineMinutes.ps1');
    expect(hits[0].kind).toBe('script');
    expect(hits[0].repoName).toBe('azdo-tools');
    expect(hits[0].absolutePath).toBe(path.join(repoA, 'scripts/Get-PipelineMinutes.ps1'));
    expect(hits[0].snippet).toContain('[pipeline]');
    expect(hits[0].hasContent).toBe(true);

    // Lock files and vendored folders never contribute content
    expect(hits.some((h) => h.relativePath === 'package-lock.json')).toBe(false);
    expect(hits.some((h) => h.relativePath.startsWith('node_modules/'))).toBe(false);

    // Path-only matches still work for kinds without content, and binaries are stored without content
    expect(searchIndexedFiles(db, 'logo').map((h) => h.relativePath)).toEqual(['assets/logo.png']);
    expect(searchIndexedFiles(db, 'logo')[0].hasContent).toBe(false);

    // Filters
    expect(searchIndexedFiles(db, 'azure', { kind: 'doc' }).map((h) => h.relativePath)).toEqual(['README.md']);
    expect(searchIndexedFiles(db, 'azure', { repoPath: repoB })).toEqual([]);
    expect(searchIndexedFiles(db, 'zzzz-nothing')).toEqual([]);

    const status = getIndexStatus(db);
    expect(status.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(status.repoCount).toBe(2);
    expect(status.fileCount).toBeGreaterThanOrEqual(6);
    expect(status.lastRunAt).not.toBeNull();
    expect(status.repos.map((r) => r.name)).toEqual(['azdo-tools', 'other']);
  });

  it('re-indexes incrementally: unchanged files are skipped, edits and deletions are picked up', async () => {
    await indexRepos(db, [{ localPath: repoA, name: 'azdo-tools' }]);
    const second = await indexRepos(db, [{ localPath: repoA, name: 'azdo-tools' }]);
    expect(second.filesIndexed).toBe(0);

    // Edit a file (force a different mtime/size) and delete another
    fs.rmSync(path.join(repoA, 'README.md'));
    const script = path.join(repoA, 'scripts/Get-PipelineMinutes.ps1');
    fs.writeFileSync(script, '# now this script counts agent hours instead\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(script, later, later);

    const third = await indexRepos(db, [{ localPath: repoA, name: 'azdo-tools' }]);
    expect(third.filesIndexed).toBe(1);
    expect(searchIndexedFiles(db, 'azdo tools helpers')).toEqual([]);
    expect(searchIndexedFiles(db, 'agent hours')[0].relativePath).toBe('scripts/Get-PipelineMinutes.ps1');
    expect(searchIndexedFiles(db, 'pipeline minutes used')).toEqual([]);
  });

  it('orders files so scripts and shallow paths come first', async () => {
    const { prioritizeFiles } = await import('../../src/services/local-file-index');
    expect(prioritizeFiles(['src/deep/x.ts', 'docs/guide.md', 'README.md', 'tools/run.ps1', 'b.png', 'a.ps1'])).toEqual([
      'a.ps1', 'tools/run.ps1', 'README.md', 'docs/guide.md', 'src/deep/x.ts', 'b.png',
    ]);
  });

  it('caps indexed content per repo, keeping the rest searchable by path', async () => {
    const capped = path.join(tmp, 'capped');
    write(capped, 'first.ps1', 'alpha '.repeat(20));   // 120 bytes, fits
    write(capped, 'second.ps1', 'bravo '.repeat(20));  // would exceed the 150 byte cap
    write(capped, 'notes/third.md', 'charlie '.repeat(5));
    await indexRepos(db, [{ localPath: capped, name: 'capped' }], { maxContentBytesPerRepo: 150 });

    expect(searchIndexedFiles(db, 'alpha').map((h) => h.relativePath)).toEqual(['first.ps1']);
    expect(searchIndexedFiles(db, 'bravo')).toEqual([]);
    expect(searchIndexedFiles(db, 'charlie')).toEqual([]);
    const second = searchIndexedFiles(db, 'second')[0];
    expect(second.relativePath).toBe('second.ps1');
    expect(second.hasContent).toBe(false);
    expect(getIndexStatus(db).contentCount).toBe(1);

    // A second, unchanged run keeps the same accounting
    await indexRepos(db, [{ localPath: capped, name: 'capped' }], { maxContentBytesPerRepo: 150 });
    expect(getIndexStatus(db).contentCount).toBe(1);
  });

  it('prunes repos that disappeared from the list or from disk', async () => {
    await indexRepos(db, [{ localPath: repoA, name: 'a' }, { localPath: repoB, name: 'b' }]);
    await indexRepos(db, [{ localPath: repoA, name: 'a' }]);
    expect(getIndexStatus(db).repos.map((r) => r.localPath)).toEqual([repoA]);

    fs.rmSync(repoA, { recursive: true, force: true });
    await indexRepos(db, [{ localPath: repoA, name: 'a' }]);
    const status = getIndexStatus(db);
    expect(status.repos[0].skippedReason).toBe('missing');
    expect(status.fileCount).toBe(0);
    expect(searchIndexedFiles(db, 'pipeline')).toEqual([]);
  });

  it('reports progress per repo and honours shouldStop', async () => {
    const seen: string[] = [];
    let stop = false;
    const done = await indexRepos(db, [{ localPath: repoA, name: 'a' }, { localPath: repoB, name: 'b' }], {
      onProgress: (p) => { if (p.currentRepo) seen.push(p.currentRepo); },
      onRepoDone: () => { stop = true; },
      shouldStop: () => stop,
    });
    expect(seen).toEqual([repoA]);
    expect(done.reposDone).toBe(1);
  });

  it('saves atomically and reloads; a schema version bump rebuilds the index', async () => {
    await indexRepos(db, [{ localPath: repoA, name: 'a' }]);
    const file = path.join(tmp, INDEX_DB_FILENAME);
    saveIndexDatabase(db, file);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(tmp).some((f) => f.includes('.tmp-'))).toBe(false);

    const reloaded = await openIndexDatabase(file);
    expect(searchIndexedFiles(reloaded, 'pipeline minutes')[0].relativePath).toBe('scripts/Get-PipelineMinutes.ps1');

    reloaded.run('PRAGMA user_version = 999');
    initializeIndexSchema(reloaded);
    expect(getIndexStatus(reloaded).fileCount).toBe(0);
    expect(getIndexStatus(reloaded).schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    reloaded.close();

    // Corrupt file falls back to a fresh database instead of throwing
    fs.writeFileSync(file, 'not a database');
    const fresh = await openIndexDatabase(file);
    expect(getIndexStatus(fresh).repoCount).toBe(0);
    fresh.close();
  });
});
