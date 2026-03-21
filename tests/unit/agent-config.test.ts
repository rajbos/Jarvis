import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getConfigDir, loadConfig, saveConfig } from '../../src/agent/config';

// ── Helpers ────────────────────────────────────────────────────────────────────

let tmpDir: string;

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-config-test-'));
}

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── getConfigDir ──────────────────────────────────────────────────────────────

describe('getConfigDir', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    process.env.JARVIS_CONFIG_DIR = originalEnv.JARVIS_CONFIG_DIR;
    if (!originalEnv.JARVIS_CONFIG_DIR) delete process.env.JARVIS_CONFIG_DIR;
  });

  it('returns JARVIS_CONFIG_DIR override when set', () => {
    process.env.JARVIS_CONFIG_DIR = '/custom/config/path';
    expect(getConfigDir()).toBe('/custom/config/path');
  });

  it('returns a path ending in "Jarvis" when no override is set', () => {
    delete process.env.JARVIS_CONFIG_DIR;
    const dir = getConfigDir();
    expect(dir.endsWith('Jarvis') || dir.endsWith('Jarvis/')).toBe(true);
  });
});

// ── loadConfig ────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  beforeEach(() => {
    tmpDir = makeTempDir();
    process.env.JARVIS_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    removeDir(tmpDir);
    delete process.env.JARVIS_CONFIG_DIR;
  });

  it('returns defaults when no config file exists', () => {
    const config = loadConfig();
    expect(config.electron.startMinimized).toBe(false);
    expect(config.electron.openAtLogin).toBe(true);
    expect(config.preferences.localRepoSortKey).toBe('name');
    expect(Array.isArray(config.github.scopes)).toBe(true);
  });

  it('merges user config with defaults', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ electron: { startMinimized: true } }),
      'utf-8',
    );
    const config = loadConfig();
    expect(config.electron.startMinimized).toBe(true);
    // Defaults preserved for other keys
    expect(config.electron.openAtLogin).toBe(true);
  });

  it('allows overriding the github oauthClientId', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ github: { oauthClientId: 'my-client-id' } }),
      'utf-8',
    );
    const config = loadConfig();
    expect(config.github.oauthClientId).toBe('my-client-id');
    // Scopes should remain from defaults
    expect(config.github.scopes).toContain('repo');
  });
});

// ── saveConfig ────────────────────────────────────────────────────────────────

describe('saveConfig', () => {
  beforeEach(() => {
    tmpDir = makeTempDir();
    process.env.JARVIS_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    removeDir(tmpDir);
    delete process.env.JARVIS_CONFIG_DIR;
  });

  it('writes config.json to the config directory', () => {
    const config = loadConfig();
    saveConfig(config);
    const configPath = path.join(tmpDir, 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('persists values that are then read back by loadConfig', () => {
    const config = loadConfig();
    config.electron.startMinimized = true;
    config.preferences.sortByNotifications = true;
    saveConfig(config);

    const reloaded = loadConfig();
    expect(reloaded.electron.startMinimized).toBe(true);
    expect(reloaded.preferences.sortByNotifications).toBe(true);
  });

  it('creates the config directory if it does not exist', () => {
    const nestedDir = path.join(tmpDir, 'nested', 'subdir');
    process.env.JARVIS_CONFIG_DIR = nestedDir;
    const config = loadConfig();
    saveConfig(config);
    expect(fs.existsSync(path.join(nestedDir, 'config.json'))).toBe(true);
  });
});
