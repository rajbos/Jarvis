/**
 * Guards that the view-test data stays synthetic: the fixtures must not pick up
 * anything identifying the machine or person running the tests (OS user, host
 * name, git identity, home directory). Those values would make screenshots and
 * failures leak local data and make the tests machine-dependent.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import os from 'node:os';
import { createFixtures } from './harness/fixtures';

function gitConfig(key: string): string | null {
  try {
    return execSync(`git config --get ${key}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function localIdentifiers(): string[] {
  const values = [
    os.userInfo().username,
    os.hostname(),
    os.homedir(),
    process.env.USERNAME,
    process.env.USER,
    process.env.USERDOMAIN,
    process.env.GITHUB_ACTOR,
    gitConfig('user.name'),
    gitConfig('user.email'),
  ];
  // Very short values ("ci", "me") would match unrelated fixture text.
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim().length >= 4))];
}

describe('view fixtures', () => {
  it('contain no identifiers of the local machine or user', () => {
    const serialized = JSON.stringify(createFixtures(Date.now())).toLowerCase();
    // JSON doubles backslashes in Windows paths; compare against both spellings.
    const leaks = localIdentifiers().filter((id) => {
      const needle = id.toLowerCase();
      return serialized.includes(needle) || serialized.includes(JSON.stringify(needle).slice(1, -1));
    });
    expect(leaks).toEqual([]);
  });

  it('are deterministic for a given clock', () => {
    const now = Date.UTC(2030, 0, 15, 12, 0, 0);
    expect(createFixtures(now)).toEqual(createFixtures(now));
  });
});
