/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import { parseGitHubRemote, normalizeGitHubUrl, upsertLocalRepo, autoLinkLocalRepos, listLocalRepos } from '../../src/services/local-discovery';
import { normalizeGitHubUrl as rendererNormalize } from '../../src/plugins/shared/utils';

describe('parseGitHubRemote', () => {
  it('returns the host with owner/repo for github.com and GHE.com remotes', () => {
    expect(parseGitHubRemote('https://github.com/acme/app.git')).toEqual({ host: 'github.com', fullName: 'acme/app' });
    expect(parseGitHubRemote('https://bob@corp.ghe.com/acme/app')).toEqual({ host: 'corp.ghe.com', fullName: 'acme/app' });
    expect(parseGitHubRemote('git@corp.ghe.com:acme/app.git')).toEqual({ host: 'corp.ghe.com', fullName: 'acme/app' });
    expect(parseGitHubRemote('ssh://git@corp.ghe.com/acme/app.git')).toEqual({ host: 'corp.ghe.com', fullName: 'acme/app' });
  });

  it('ignores other hosts', () => {
    for (const url of ['https://gitlab.com/acme/app.git', 'git@git.example.com:acme/app.git', 'https://gist.github.com/acme/app', '']) {
      expect(parseGitHubRemote(url), url).toBeNull();
    }
  });

  it('is what the owner/repo normalisers build on', () => {
    expect(normalizeGitHubUrl('git@corp.ghe.com:acme/app.git')).toBe('acme/app');
    expect(rendererNormalize('git@corp.ghe.com:acme/app.git')).toBe('acme/app');
    expect(rendererNormalize('https://corp.ghe.com/acme/app')).toBe('acme/app');
    expect(rendererNormalize('https://git.example.com/acme/app')).toBeNull();
  });
});

describe('autoLinkLocalRepos across hosts', () => {
  let db: SqlJsDatabase;
  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });
  afterEach(() => db.close());

  it('links a GHE.com clone to the GHE.com repo, not to a same-named github.com one', () => {
    db.run("INSERT INTO github_repos (full_name, name, host) VALUES ('acme/app', 'app', 'github.com')");
    db.run("INSERT INTO github_repos (full_name, name, host) VALUES ('acme/other', 'other', 'corp.ghe.com')");
    upsertLocalRepo(db, 'C:/code/ghe-app', 'ghe-app', [{ name: 'origin', url: 'git@corp.ghe.com:acme/app.git' }]);
    upsertLocalRepo(db, 'C:/code/ghe-other', 'ghe-other', [{ name: 'origin', url: 'git@corp.ghe.com:acme/other.git' }]);
    upsertLocalRepo(db, 'C:/code/gh-app', 'gh-app', [{ name: 'origin', url: 'https://github.com/acme/app.git' }]);

    autoLinkLocalRepos(db);

    const linked = Object.fromEntries(listLocalRepos(db).map((r) => [r.name, r.linkedGithubRepoId]));
    expect(linked['ghe-app']).toBeNull();
    expect(linked['ghe-other']).not.toBeNull();
    expect(linked['gh-app']).not.toBeNull();
  });
});
