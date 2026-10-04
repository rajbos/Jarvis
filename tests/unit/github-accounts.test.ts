/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import {
  parseGitCredentialUsernames,
  parseGhAuthStatus,
  readGlobalGitCredentialHints,
  resolveAccountForRepo,
  setAssignment,
  recordRepoVisibility,
  listAssignments,
  syncGitConfigAssignments,
  saveHostAccountPat,
  listHostAccounts,
  loadHostAccountPat,
  deleteHostAccount,
  listAccounts,
} from '../../src/services/github-accounts';
import {
  saveGitHubAuth,
  saveGitHubPat,
  loadGitHubAuth,
  loadGitHubPat,
  listGitHubAuths,
  getPrimaryGitHubLogin,
  setPrimaryGitHubLogin,
  deleteGitHubAuthFor,
} from '../../src/services/github-oauth';

const GITCONFIG = [
  '[user]',
  '\tname = Test User',
  '\temail = test@example.com',
  '[credential "https://github.com/acme"]',
  '\thelper =',
  '\thelper = manager',
  '\tusername = alice',
  '[credential "https://github.com/globex"]',
  '\tusername = alice-work',
  '[credential "https://github.com/initech/widgets.git"]',
  '\tusername = alice-contract',
  '[credential "https://gist.github.com"]',
  '\tusername = ignored',
  '[credential "https://dev.azure.com"]',
  '\tusername = ignored-too',
  '',
].join('\n');

describe('parseGitCredentialUsernames', () => {
  it('maps github.com owner and repo credential sections to usernames', () => {
    expect(parseGitCredentialUsernames(GITCONFIG)).toEqual([
      { scope: 'owner', host: 'github.com', key: 'acme', login: 'alice' },
      { scope: 'owner', host: 'github.com', key: 'globex', login: 'alice-work' },
      { scope: 'repo', host: 'github.com', key: 'initech/widgets', login: 'alice-contract' },
    ]);
  });

  it('treats a bare github.com section as host-wide', () => {
    expect(parseGitCredentialUsernames('[credential "https://github.com"]\n\tusername = me\n'))
      .toEqual([{ scope: 'host', host: 'github.com', key: 'github.com', login: 'me' }]);
  });

  it('qualifies GHE.com accounts and keys with the host, and ignores unknown hosts', () => {
    const cfg = [
      '[credential "https://corp.ghe.com/acme"]', '\tusername = bob',
      '[credential "https://corp.ghe.com"]', '\tusername = bob',
      '[credential "https://git.example.com/acme"]', '\tusername = mallory',
    ].join('\n');
    expect(parseGitCredentialUsernames(cfg)).toEqual([
      { scope: 'owner', host: 'corp.ghe.com', key: 'corp.ghe.com/acme', login: 'bob@corp.ghe.com' },
      { scope: 'host', host: 'corp.ghe.com', key: 'corp.ghe.com', login: 'bob@corp.ghe.com' },
    ]);
  });

  it('ignores sections without a username', () => {
    expect(parseGitCredentialUsernames('[credential "https://github.com/acme"]\n\thelper = manager\n')).toEqual([]);
  });
});

describe('readGlobalGitCredentialHints', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gitcfg-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('follows plain include paths and tolerates missing files', () => {
    fs.writeFileSync(path.join(dir, 'work.inc'), '[credential "https://github.com/globex"]\n\tusername = alice-work\n');
    fs.writeFileSync(path.join(dir, 'main'), '[include]\n\tpath = work.inc\n[credential "https://github.com/acme"]\n\tusername = alice\n');
    const hints = readGlobalGitCredentialHints([path.join(dir, 'main'), path.join(dir, 'missing')]);
    expect(hints.map((h) => `${h.key}=${h.login}`).sort()).toEqual(['acme=alice', 'globex=alice-work']);
  });
});

describe('parseGhAuthStatus', () => {
  it('lists accounts on github.com and GHE.com with the active one, skipping other hosts', () => {
    const output = [
      'github.com',
      '  ✓ Logged in to github.com account alice (keyring)',
      '  - Active account: true',
      '  - Token: gho_************************************',
      '',
      '  ✓ Logged in to github.com account alice-work (keyring)',
      '  - Active account: false',
      '',
      'corp.ghe.com',
      '  ✓ Logged in to corp.ghe.com account alice-ghe (keyring)',
      '  - Active account: true',
      '',
      'git.example.com',
      '  ✓ Logged in to git.example.com account other (keyring)',
      '  - Active account: true',
    ].join('\n');
    expect(parseGhAuthStatus(output)).toEqual([
      { host: 'github.com', login: 'alice', active: true },
      { host: 'github.com', login: 'alice-work', active: false },
      { host: 'corp.ghe.com', login: 'alice-ghe', active: true },
    ]);
  });

  it('returns nothing when logged out', () => {
    expect(parseGhAuthStatus('You are not logged into any GitHub hosts.')).toEqual([]);
  });
});

describe('account assignments', () => {
  let db: SqlJsDatabase;
  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });
  afterEach(() => db.close());

  it('resolves repo → owner → default, case-insensitively', () => {
    setAssignment(db, 'owner', 'Acme', 'alice');
    setAssignment(db, 'repo', 'ACME/special', 'alice-work');

    expect(resolveAccountForRepo(db, 'acme/special', 'main')).toEqual({ login: 'alice-work', via: 'repo', source: 'manual' });
    expect(resolveAccountForRepo(db, 'Acme/other', 'main')).toEqual({ login: 'alice', via: 'owner', source: 'manual' });
    expect(resolveAccountForRepo(db, 'elsewhere/x', 'main')).toEqual({ login: 'main', via: 'default', source: null });
    expect(resolveAccountForRepo(db, 'elsewhere/x', null)).toBeNull();
  });

  it('resolves GHE.com repos through host-qualified keys', () => {
    setAssignment(db, 'owner', 'corp.ghe.com/acme', 'bob@corp.ghe.com');
    expect(resolveAccountForRepo(db, 'corp.ghe.com/Acme/app', 'main')).toEqual({ login: 'bob@corp.ghe.com', via: 'owner', source: 'manual' });
    // The same owner name on github.com is a different owner.
    expect(resolveAccountForRepo(db, 'acme/app', 'main')).toEqual({ login: 'main', via: 'default', source: null });
  });

  it('falls back to an account that discovered the repo when the default cannot see it', () => {
    recordRepoVisibility(db, 'barco/app', 'guest');
    expect(resolveAccountForRepo(db, 'barco/app', 'main')).toEqual({ login: 'guest', via: 'discovered', source: null });

    recordRepoVisibility(db, 'barco/app', 'main');
    expect(resolveAccountForRepo(db, 'barco/app', 'main')).toEqual({ login: 'main', via: 'default', source: null });
    // An explicit assignment still wins.
    setAssignment(db, 'owner', 'barco', 'guest');
    expect(resolveAccountForRepo(db, 'barco/app', 'main')).toMatchObject({ login: 'guest', via: 'owner' });
  });

  it('clears an assignment with a null login', () => {
    setAssignment(db, 'owner', 'acme', 'alice');
    setAssignment(db, 'owner', 'acme', null);
    expect(listAssignments(db)).toEqual([]);
  });

  describe('syncGitConfigAssignments', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sync-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('imports git config hints but never overwrites manual choices', () => {
      const cfg = path.join(dir, 'gitconfig');
      fs.writeFileSync(cfg, GITCONFIG);
      setAssignment(db, 'owner', 'globex', 'someone-else');

      const result = syncGitConfigAssignments(db, { globalFiles: [cfg] });

      expect(result).toEqual({ imported: 2, keptManual: 1 });
      expect(listAssignments(db)).toEqual([
        { scope: 'owner', key: 'acme', login: 'alice', source: 'git-config' },
        { scope: 'owner', key: 'globex', login: 'someone-else', source: 'manual' },
        { scope: 'repo', key: 'initech/widgets', login: 'alice-contract', source: 'git-config' },
      ]);
    });

    it('pins a local repo to the account in its own .git/config', () => {
      const repo = path.join(dir, 'clone');
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.git', 'config'), '[credential "https://github.com"]\n\tusername = alice-work\n');

      syncGitConfigAssignments(db, {
        globalFiles: [path.join(dir, 'none')],
        localRepos: [{ localPath: repo, remoteUrls: ['git@github.com:Globex/App.git', 'https://gitlab.com/x/y.git'] }],
      });

      expect(listAssignments(db)).toEqual([{ scope: 'repo', key: 'globex/app', login: 'alice-work', source: 'git-config' }]);
    });

    it('pins a GHE.com clone to the account named in its own .git/config', () => {
      const repo = path.join(dir, 'ghe-clone');
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.git', 'config'), '[credential "https://corp.ghe.com"]\n\tusername = bob\n');

      syncGitConfigAssignments(db, {
        globalFiles: [path.join(dir, 'none')],
        localRepos: [{ localPath: repo, remoteUrls: ['git@corp.ghe.com:Acme/App.git'] }],
      });

      expect(listAssignments(db)).toEqual([
        { scope: 'repo', key: 'corp.ghe.com/acme/app', login: 'bob@corp.ghe.com', source: 'git-config' },
      ]);
    });
  });
});

describe('PAT accounts on other hosts', () => {
  let db: SqlJsDatabase;
  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });
  afterEach(() => db.close());

  it('stores the PAT encrypted and returns a host-qualified account id', () => {
    const id = saveHostAccountPat(db, 'Corp.GHE.com', 'bob', 'ghp_secret', 'b.png');
    expect(id).toBe('bob@corp.ghe.com');
    expect(listHostAccounts(db)).toEqual([{ id, host: 'corp.ghe.com', login: 'bob', avatarUrl: 'b.png' }]);
    expect(loadHostAccountPat(db, id)).toBe('ghp_secret');
    const raw = db.exec('SELECT pat FROM github_host_accounts')[0].values[0][0] as string;
    expect(raw).not.toContain('ghp_secret');

    deleteHostAccount(db, id);
    expect(listHostAccounts(db)).toEqual([]);
  });

  it('refuses github.com and hosts outside the allow-list', () => {
    expect(() => saveHostAccountPat(db, 'github.com', 'bob', 'x')).toThrow(/Unsupported/);
    expect(() => saveHostAccountPat(db, 'git.example.com', 'bob', 'x')).toThrow(/Unsupported/);
  });
});

describe('multiple stored GitHub sign-ins', () => {
  let db: SqlJsDatabase;
  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    saveGitHubAuth(db, 'alice', 'tok-alice', 'repo', 'a.png');
    saveGitHubAuth(db, 'alice-work', 'tok-work', 'repo,user');
    saveGitHubPat(db, 'alice-work', 'pat-work');
  });
  afterEach(() => db.close());

  it('loads each account by login, case-insensitively', () => {
    expect(loadGitHubAuth(db, 'ALICE')).toMatchObject({ login: 'alice', accessToken: 'tok-alice' });
    expect(loadGitHubAuth(db, 'alice-work')).toMatchObject({ accessToken: 'tok-work', scopes: 'repo,user' });
    expect(loadGitHubAuth(db, 'nobody')).toBeNull();
    expect(loadGitHubPat(db, 'alice-work')).toBe('pat-work');
    expect(loadGitHubPat(db, 'alice')).toBeNull();
  });

  it('lists accounts without exposing tokens', () => {
    expect(listGitHubAuths(db)).toEqual([
      { login: 'alice', scopes: 'repo', avatarUrl: 'a.png', hasPat: false, tokenReadable: true },
      { login: 'alice-work', scopes: 'repo,user', avatarUrl: null, hasPat: true, tokenReadable: true },
    ]);
  });

  it('flags a sign-in whose token can no longer be decrypted, in the account list too', () => {
    db.run("UPDATE github_auth SET access_token = 'not-decryptable' WHERE login = 'alice'");
    expect(listGitHubAuths(db).map((a) => [a.login, a.tokenReadable])).toEqual([['alice', false], ['alice-work', true]]);
    const accounts = listAccounts(db, []);
    expect(accounts.find((a) => a.login === 'alice')?.signInUnreadable).toBe(true);
    expect(accounts.find((a) => a.login === 'alice-work')?.signInUnreadable).toBeUndefined();
  });

  it('keeps the chosen primary account for the single-account loaders', () => {
    expect(setPrimaryGitHubLogin(db, 'alice')).toBe(true);
    // A later sign-in must not steal primary.
    saveGitHubAuth(db, 'alice-work', 'tok-work-2', 'repo,user');
    expect(getPrimaryGitHubLogin(db)).toBe('alice');
    expect(loadGitHubAuth(db)?.login).toBe('alice');
    expect(loadGitHubPat(db)).toBeNull();

    expect(setPrimaryGitHubLogin(db, 'alice-work')).toBe(true);
    expect(loadGitHubPat(db)).toBe('pat-work');
    expect(setPrimaryGitHubLogin(db, 'nobody')).toBe(false);
  });

  it('falls back to another account when the primary is removed', () => {
    setPrimaryGitHubLogin(db, 'alice');
    deleteGitHubAuthFor(db, 'alice');
    expect(getPrimaryGitHubLogin(db)).toBe('alice-work');
    expect(listGitHubAuths(db).map((a) => a.login)).toEqual(['alice-work']);
  });
});
