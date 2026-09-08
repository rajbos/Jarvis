/**
 * About service tests.
 *
 * Covers the two runtime modes:
 * - Packaged: version comes from the installer, release date from GitHub.
 * - Development: the checked-out git branch stands in for the version.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => '1.2.3'),
    getAppPath: vi.fn(() => '/repo'),
  },
  fetch: vi.fn(),
}));

vi.mock('electron', () => ({
  app: mocks.app,
  net: { fetch: mocks.fetch },
}));

import { getAboutInfo, readGitBranch, clearReleaseCache, REPO_URL } from '../../src/services/about';

function makeTempRepo(): string {
  return mkdtempSync(path.join(tmpdir(), 'jarvis-about-'));
}

describe('about service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearReleaseCache();
    mocks.app.isPackaged = true;
    mocks.app.getVersion.mockReturnValue('1.2.3');
    mocks.app.getAppPath.mockReturnValue('/repo');
  });

  describe('readGitBranch', () => {
    it('reads the branch name from .git/HEAD', () => {
      const dir = makeTempRepo();
      try {
        mkdirSync(path.join(dir, '.git'));
        writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/about-popup\n');
        expect(readGitBranch(dir)).toBe('feature/about-popup');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns a short sha for a detached HEAD', () => {
      const dir = makeTempRepo();
      try {
        mkdirSync(path.join(dir, '.git'));
        writeFileSync(path.join(dir, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
        expect(readGitBranch(dir)).toBe('0123456');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('follows a .git file that points at a worktree gitdir', () => {
      const dir = makeTempRepo();
      try {
        mkdirSync(path.join(dir, 'real-git'));
        writeFileSync(path.join(dir, 'real-git', 'HEAD'), 'ref: refs/heads/main\n');
        writeFileSync(path.join(dir, '.git'), 'gitdir: real-git\n');
        expect(readGitBranch(dir)).toBe('main');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns null when there is no git repository', () => {
      const dir = makeTempRepo();
      try {
        expect(readGitBranch(dir)).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('getAboutInfo', () => {
    it('reports the release version and date for a packaged app', async () => {
      mocks.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          published_at: '2026-01-15T10:00:00Z',
          html_url: 'https://github.com/rajbos/Jarvis/releases/tag/v1.2.3',
        }),
      });

      const info = await getAboutInfo();

      expect(mocks.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/rajbos/Jarvis/releases/tags/v1.2.3',
        expect.anything(),
      );
      expect(info).toMatchObject({
        displayVersion: '1.2.3',
        appVersion: '1.2.3',
        isDev: false,
        branch: null,
        releasedAt: '2026-01-15T10:00:00Z',
        releaseUrl: 'https://github.com/rajbos/Jarvis/releases/tag/v1.2.3',
        repoUrl: REPO_URL,
      });
    });

    it('caches the release lookup between calls', async () => {
      mocks.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ published_at: '2026-01-15T10:00:00Z', html_url: null }),
      });

      await getAboutInfo();
      await getAboutInfo();

      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });

    it('still returns version info when the release lookup fails', async () => {
      mocks.fetch.mockRejectedValue(new Error('offline'));

      const info = await getAboutInfo();

      expect(info.displayVersion).toBe('1.2.3');
      expect(info.releasedAt).toBeNull();
      expect(info.releaseUrl).toBeNull();
    });

    it('falls back to no release date on a 404', async () => {
      mocks.fetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });

      const info = await getAboutInfo();

      expect(info.releasedAt).toBeNull();
    });

    it('shows the git branch instead of a version during development', async () => {
      const dir = makeTempRepo();
      try {
        mkdirSync(path.join(dir, '.git'));
        writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/about\n');
        mocks.app.isPackaged = false;
        mocks.app.getAppPath.mockReturnValue(dir);

        const info = await getAboutInfo();

        expect(info).toMatchObject({
          displayVersion: 'feature/about',
          appVersion: '1.2.3',
          isDev: true,
          branch: 'feature/about',
          releasedAt: null,
          repoUrl: REPO_URL,
        });
        expect(mocks.fetch).not.toHaveBeenCalled();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('falls back to the app version in development without a git checkout', async () => {
      const dir = makeTempRepo();
      try {
        mocks.app.isPackaged = false;
        mocks.app.getAppPath.mockReturnValue(dir);

        const info = await getAboutInfo();

        expect(info.displayVersion).toBe('1.2.3 (dev)');
        expect(info.branch).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
