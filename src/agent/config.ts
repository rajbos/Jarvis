import path from 'path';
import fs from 'fs';

export interface JarvisConfig {
  github: {
    oauthClientId: string;
    scopes: string[];
  };
  storage: {
    database: string;
  };
  electron: {
    startMinimized: boolean;
    openAtLogin: boolean;
  };
  preferences: {
    sortByNotifications: boolean;
    localSortByNotifs: boolean;
    localRepoSortKey: 'name' | 'scanned' | 'notifs';
    dashboardDefaultFilter?: 'all' | 'healthy' | 'warnings' | 'notifications' | 'human-notifications' | 'failed-runs';
    dashboardSortMode?: 'attention' | 'local-activity' | 'remote-activity';
    dashboardNotifSort?: 'count' | 'name';
  };
  /** Localhost bridge security settings (browser extension pairing). */
  bridge?: {
    /** Shared secret token required by the browser extension to authenticate. */
    token?: string;
  };
}

const DEFAULT_CONFIG: JarvisConfig = {
  github: {
    oauthClientId: '', // Must be set by the user or via a registered GitHub OAuth App
    // `user` (superset of read:user) is needed to read Copilot AI credit billing usage.
    scopes: ['repo', 'read:org', 'user'],
  },
  storage: {
    database: path.join(
      process.env.JARVIS_CONFIG_DIR || path.join(
        process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
        'jarvis',
      ),
      'jarvis.db',
    ),
  },
  electron: {
    startMinimized: false,
    openAtLogin: true,
  },
  preferences: {
    sortByNotifications: false,
    localSortByNotifs: false,
    localRepoSortKey: 'name' as const,
  },
};

export function getConfigDir(): string {
  const override = process.env.JARVIS_CONFIG_DIR;
  if (override) return override;
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return path.join(appData, 'Jarvis');
}

/**
 * Scopes every GitHub OAuth grant must include, even when config.json pins an
 * older scope list. `user` grants read access to the user's billing usage
 * (Copilot AI credits) and supersedes `read:user`.
 */
export const REQUIRED_GITHUB_SCOPES = ['repo', 'read:org', 'user'];

/** Merge configured scopes with the required ones (dropping read:user, which `user` covers). */
export function resolveGitHubScopes(configured: string[]): string[] {
  const merged = new Set([...configured, ...REQUIRED_GITHUB_SCOPES]);
  if (merged.has('user')) merged.delete('read:user');
  return [...merged];
}

export function loadConfig(): JarvisConfig {
  const configPath = path.join(getConfigDir(), 'config.json');

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const userConfig = JSON.parse(raw) as Partial<JarvisConfig>;

  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    github: { ...DEFAULT_CONFIG.github, ...userConfig.github },
    storage: { ...DEFAULT_CONFIG.storage, ...userConfig.storage },
    electron: { ...DEFAULT_CONFIG.electron, ...userConfig.electron },
    preferences: { ...DEFAULT_CONFIG.preferences, ...userConfig.preferences },
  };
}

export function saveConfig(config: JarvisConfig): void {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
