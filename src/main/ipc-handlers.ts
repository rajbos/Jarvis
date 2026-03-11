import { ipcMain, shell, Notification, BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { loadConfig } from '../agent/config';
import { getOnboardingStatus, completeOnboardingStep } from '../agent/onboarding';
import { saveDatabase, getConfigValue, setConfigValue } from '../storage/database';
import {
  requestDeviceCode,
  pollForToken,
  fetchGitHubUser,
  saveGitHubAuth,
  loadGitHubAuth,
  saveGitHubPat,
  loadGitHubPat,
  deleteGitHubPat,
  deleteGitHubAuth,
} from '../services/github-oauth';
import {
  runDiscovery,
  runLightweightRefresh,
  runPatDiscovery,
  fetchStarredRepos,
  getLastOrgIndexedAt,
  listOrgs,
  setOrgDiscoveryEnabled,
  type DiscoveryState,
  type DiscoveryProgress,
} from '../services/github-discovery';
import { checkOllama, streamChat, chatWithTools, ToolsNotSupportedError, type ChatMessage, type OllamaTool, type OllamaToolCall } from '../services/ollama';

const activeChatAborts = new Map<number, AbortController>();

let activeDeviceFlow: {
  deviceCode: string;
  clientId: string;
  intervalMs: number;
  aborted: boolean;
} | null = null;

let activeDiscovery: DiscoveryState | null = null;
let lastDiscoveryProgress: DiscoveryProgress | null = null;

/**
 * Builds the system prompt injected into every chat request.
 *
 * The prompt has two sections:
 *
 * 1. INSTRUCTIONS — static behavioural rules for the model (what role it plays,
 *    how to format answers, and critically: what to do when the indexed data is
 *    too thin to answer a question).
 *
 * 2. DATA SNAPSHOT — dynamic content queried from the local SQLite database:
 *    - Authenticated GitHub user
 *    - Enabled/disabled organisations and their repo counts
 *    - Up to 40 most-recently-pushed repositories (from enabled orgs only),
 *      with language, description, fork/archived/starred flags
 *
 * Currently stored per-repo: full_name, language, description, archived, fork,
 * starred, last_pushed_at.  Fields NOT yet stored (topics, README, open issue
 * count, contributors, CI status, etc.) are what Jarvis should flag to the user
 * when a question requires them.
 */
function buildSystemContext(db: SqlJsDatabase): string {
  const lines: string[] = [
    'You are Jarvis, a personal GitHub repository assistant.',
    'You have access to the user\'s GitHub data that has been indexed into a local database (snapshot shown below).',
    'Help the user find repos, understand their codebase, and answer questions about their repositories.',
    'Be concise and helpful. When listing repos, use the full_name format (org/repo).',
    '',
    'IMPORTANT — when the indexed data is insufficient to answer a question fully:',
    '1. Tell the user clearly what you do and do not know based on the current snapshot.',
    '2. Specify exactly which additional data would be needed, choosing from this list of fields',
    '   not yet stored in the database:',
    '   - Repository topics / tags',
    '   - README content',
    '   - Open issue count and recent issue titles',
    '   - Open pull-request count',
    '   - Contributor list',
    '   - CI/CD workflow names and last-run status',
    '   - Release tags and latest release date',
    '   - Primary programming language breakdown (beyond the single "language" field)',
    '   - Repository size (disk / LOC estimate)',
    '   - Branch protection rules',
    '3. Suggest the user enables discovery for any organisation that is currently excluded,',
    '   if the missing repos are likely there.',
    'Do NOT fabricate data that is not present in the snapshot below.',
    '',
  ];

  const auth = loadGitHubAuth(db);
  if (auth?.login) lines.push(`GitHub user: ${auth.login}`);

  const { orgs, directRepoCount, starredRepoCount } = listOrgs(db);
  const enabledOrgs = orgs.filter(o => o.discoveryEnabled);
  const disabledOrgs = orgs.filter(o => !o.discoveryEnabled);
  const totalRepos = enabledOrgs.reduce((s, o) => s + o.repoCount, 0) + directRepoCount;
  if (enabledOrgs.length > 0) {
    lines.push(`Organizations (${enabledOrgs.length}): ${enabledOrgs.slice(0, 20).map(o => `${o.login} (${o.repoCount} repos)`).join(', ')}`);
  }
  if (disabledOrgs.length > 0) {
    lines.push(`Excluded organizations (discovery disabled): ${disabledOrgs.map(o => o.login).join(', ')}`);
  }
  lines.push(`Total repositories indexed: ${totalRepos}`);
  if (starredRepoCount > 0) lines.push(`Starred repositories: ${starredRepoCount}`);
  if (directRepoCount > 0) lines.push(`Personal/collaborator repositories: ${directRepoCount}`);
  lines.push('');

  const stmt = db.prepare(
    `SELECT r.full_name, r.language, r.description, r.archived, r.fork, r.starred
     FROM github_repos r
     WHERE r.org_id IS NULL
        OR r.org_id IN (SELECT id FROM github_orgs WHERE discovery_enabled = 1)
     ORDER BY r.last_pushed_at DESC LIMIT 40`
  );
  type RepoRow = { full_name: string; language: string | null; description: string | null; archived: number; fork: number; starred: number };
  const recent: RepoRow[] = [];
  while (stmt.step()) recent.push(stmt.getAsObject() as RepoRow);
  stmt.free();

  if (recent.length > 0) {
    lines.push(`Recently active repositories (${recent.length} shown of ${totalRepos} total):`);
    for (const r of recent) {
      const meta: string[] = [];
      if (r.language) meta.push(r.language);
      if (r.fork) meta.push('fork');
      if (r.archived) meta.push('archived');
      if (r.starred) meta.push('starred');
      const metaStr = meta.length > 0 ? ` [${meta.join(', ')}]` : '';
      const desc = r.description ? `: ${r.description.slice(0, 80)}` : '';
      lines.push(`- ${r.full_name}${metaStr}${desc}`);
    }
  }

  return lines.join('\n');
}

// ── Chat tool: repo search ────────────────────────────────────────────────────

/**
 * Available tools exposed to the LLM during chat.
 * The model can call search_repos(query) to query the local database when it
 * needs richer or more targeted repo data than the system context snapshot.
 */
const CHAT_TOOLS: OllamaTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_repos',
      description:
        'Search the locally indexed GitHub repositories by name, org, description, or language. ' +
        'Use this whenever the user asks about specific repos or you need more detail than the ' +
        'system context snapshot provides. Supports fuzzy matching: the query is split into words ' +
        'and every word must appear somewhere in the repo record (in any order).',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'One or more search terms (space-separated). All terms must match.',
          },
        },
        required: ['query'],
      },
    },
  },
];

interface RepoSearchRow {
  full_name: string;
  language: string | null;
  description: string | null;
  archived: number;
  fork: number;
  starred: number;
  private: number;
}

/**
 * Fuzzy multi-word search over indexed repos (enabled orgs only).
 * Each word in `query` must match at least one of: full_name, description, language.
 * Returns up to 20 results formatted as a compact text block for the model.
 */
function searchReposForChat(db: SqlJsDatabase, query: string): string {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'No search terms provided.';

  // Build a WHERE clause requiring every word to match somewhere in the row
  const conditions = words.map(() =>
    `(LOWER(r.full_name) LIKE ? OR LOWER(COALESCE(r.description,'')) LIKE ? OR LOWER(COALESCE(r.language,'')) LIKE ?)`,
  ).join(' AND ');

  const params = words.flatMap(w => [`%${w}%`, `%${w}%`, `%${w}%`]);

  const sql = `
    SELECT r.full_name, r.language, r.description, r.archived, r.fork, r.starred, r.private
    FROM github_repos r
    WHERE (r.org_id IS NULL OR r.org_id IN (SELECT id FROM github_orgs WHERE discovery_enabled = 1))
      AND ${conditions}
    ORDER BY r.last_pushed_at DESC
    LIMIT 20`;

  const stmt = db.prepare(sql);
  const rows: RepoSearchRow[] = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as RepoSearchRow);
  } finally {
    stmt.free();
  }

  if (rows.length === 0) return `No repositories found matching: ${query}`;

  const lines = [`Found ${rows.length} repositor${rows.length === 1 ? 'y' : 'ies'} matching "${query}":`];
  for (const r of rows) {
    const meta: string[] = [];
    if (r.language) meta.push(r.language);
    if (r.private) meta.push('private');
    if (r.fork) meta.push('fork');
    if (r.archived) meta.push('archived');
    if (r.starred) meta.push('starred');
    const metaStr = meta.length > 0 ? ` [${meta.join(', ')}]` : '';
    const desc = r.description ? `: ${r.description.slice(0, 100)}` : '';
    lines.push(`- ${r.full_name}${metaStr}${desc}`);
  }
  return lines.join('\n');
}

/**
 * Dispatch a tool call made by the model and return the result string.
 */
function dispatchToolCall(db: SqlJsDatabase, call: OllamaToolCall): string {
  if (call.function.name === 'search_repos') {
    const query = String(call.function.arguments['query'] ?? '');
    return searchReposForChat(db, query);
  }
  return `Unknown tool: ${call.function.name}`;
}

export function registerIpcHandlers(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle('onboarding:status', () => {
    return getOnboardingStatus(db);
  });

  ipcMain.handle('ollama:status', async () => {
    return checkOllama();
  });

  ipcMain.handle('ollama:list-models', async () => {
    const result = await checkOllama();
    return { available: result.available, models: result.models, error: result.error };
  });

  ipcMain.handle('ollama:get-selected-model', () => {
    return getConfigValue(db, 'selected_ollama_model');
  });

  ipcMain.handle('ollama:set-selected-model', (_event, modelName: string) => {
    setConfigValue(db, 'selected_ollama_model', modelName);
    saveDatabase();
    return { ok: true };
  });

  ipcMain.handle('chat:send', (event, userMessages: Array<{ role: string; content: string }>) => {
    const model = getConfigValue(db, 'selected_ollama_model');
    if (!model) {
      event.sender.send('chat:error', 'No Ollama model selected. Please select a model in the main window.');
      return { ok: false };
    }

    // Abort any in-flight stream for this window
    const existing = activeChatAborts.get(event.sender.id);
    if (existing) {
      existing.abort();
      activeChatAborts.delete(event.sender.id);
    }

    const controller = new AbortController();
    activeChatAborts.set(event.sender.id, controller);

    const systemContext = buildSystemContext(db);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemContext },
      ...userMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    void (async () => {
      try {
        // ── Tool-call loop ────────────────────────────────────────────────
        // Let the model call tools (e.g. search_repos) until it produces a
        // plain text response, then stream that final answer to the renderer.
        // Falls back to plain streaming if the model doesn't support tools.
        const MAX_TOOL_ROUNDS = 5;
        let round = 0;
        let toolsSupported = true;
        while (round < MAX_TOOL_ROUNDS) {
          round++;
          let content: string;
          let tool_calls: OllamaToolCall[];
          try {
            ({ content, tool_calls } = await chatWithTools(
              model, messages, CHAT_TOOLS, controller.signal,
            ));
          } catch (err) {
            if (err instanceof ToolsNotSupportedError) {
              toolsSupported = false;
              break;
            }
            throw err;
          }

          if (tool_calls.length === 0) {
            // No more tool calls — stream the final content token-by-token
            // (split on words to give the UI a streaming feel since
            //  chatWithTools is non-streaming)
            const words = content.split(/(\s+)/);
            for (const chunk of words) {
              if (controller.signal.aborted) return;
              if (!event.sender.isDestroyed()) {
                event.sender.send('chat:token', chunk);
              }
            }
            break;
          }

          // Record the assistant turn that requested tool calls
          (messages as Array<ChatMessage & { tool_calls?: OllamaToolCall[] }>).push({
            role: 'assistant',
            content,
            tool_calls,
          });

          // Execute each tool and append the results
          for (const call of tool_calls) {
            const result = dispatchToolCall(db, call);
            (messages as Array<ChatMessage & { name?: string }>).push({
              role: 'tool' as ChatMessage['role'],
              content: result,
              name: call.function.name,
            });
          }
        }

        // Fallback: model doesn't support tools — plain streaming
        if (!toolsSupported) {
          await streamChat(model, messages, (token) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('chat:token', token);
            }
          }, controller.signal);
        }

        if (!event.sender.isDestroyed()) {
          event.sender.send('chat:done');
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        if (!event.sender.isDestroyed()) {
          event.sender.send('chat:error', err instanceof Error ? err.message : String(err));
        }
      } finally {
        activeChatAborts.delete(event.sender.id);
      }
    })();

    return { ok: true };
  });

  ipcMain.handle('chat:abort', (event) => {
    const ctrl = activeChatAborts.get(event.sender.id);
    if (ctrl) {
      ctrl.abort();
      activeChatAborts.delete(event.sender.id);
    }
    return { ok: true };
  });

  ipcMain.handle('window:adjust-width', (event, delta: number) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false };
    const [w, h] = win.getSize();
    win.setSize(Math.max(400, w + delta), h);
    return { ok: true };
  });

  ipcMain.handle('github:oauth-status', async () => {
    console.log('[IPC] github:oauth-status called');
    const auth = loadGitHubAuth(db);
    if (auth) {
      console.log('[IPC] Found existing auth for:', auth.login);
      let avatarUrl = auth.avatarUrl;

      // Backfill avatar_url if it was never stored (pre-migration rows)
      if (!avatarUrl) {
        try {
          const user = await fetchGitHubUser(auth.accessToken);
          if (user.avatar_url) {
            avatarUrl = user.avatar_url;
            saveGitHubAuth(db, auth.login, auth.accessToken, auth.scopes, avatarUrl);
            saveDatabase();
          }
        } catch (e) {
          console.warn('[IPC] Could not backfill avatar_url:', e);
        }
      }

      return { authenticated: true, login: auth.login, scopes: auth.scopes, avatarUrl };
    }
    console.log('[IPC] No existing GitHub auth found');
    return { authenticated: false };
  });

  ipcMain.handle('github:discovery-status', () => {
    // If discovery ran this session, return live progress
    if (lastDiscoveryProgress) {
      return {
        running: activeDiscovery !== null && !activeDiscovery.aborted,
        progress: lastDiscoveryProgress,
        rateLimit: activeDiscovery?.lastRateLimit ?? null,
      };
    }

    // Otherwise, build progress from stored DB data
    const { orgs, directRepoCount } = listOrgs(db);
    const totalRepos = orgs.reduce((sum, o) => sum + o.repoCount, 0) + directRepoCount;
    return {
      running: activeDiscovery !== null && !activeDiscovery.aborted,
      progress: orgs.length > 0 || directRepoCount > 0
        ? { phase: 'done' as const, orgsFound: orgs.length, reposFound: totalRepos }
        : null,
      rateLimit: null,
    };
  });

  ipcMain.handle('github:start-discovery', () => {
    startDiscoveryIfAuthed(db, getWindow, true);
    return { started: true };
  });

  ipcMain.handle('github:start-pat-discovery', () => {
    const pat = loadGitHubPat(db);
    if (!pat) return { error: 'No PAT configured' };

    runPatDiscovery(db, pat, undefined, undefined, (progress) => {
      lastDiscoveryProgress = progress;
      getWindow()?.webContents.send('github:discovery-progress', progress);
    }).then(() => {
      const doneProgress: DiscoveryProgress = {
        phase: 'done',
        orgsFound: lastDiscoveryProgress?.orgsFound ?? 0,
        reposFound: lastDiscoveryProgress?.reposFound ?? 0,
      };
      lastDiscoveryProgress = doneProgress;
      getWindow()?.webContents.send('github:discovery-progress', doneProgress);
      getWindow()?.webContents.send('github:discovery-complete', doneProgress);
      console.log('[Discovery] PAT-only discovery finished');
    }).catch((err) => {
      console.error('[Discovery] PAT-only discovery failed:', err);
    });
    return { started: true };
  });

  ipcMain.handle('github:list-orgs', () => {
    return listOrgs(db);
  });

  ipcMain.handle('github:set-org-enabled', (_event, orgLogin: string, enabled: boolean) => {
    setOrgDiscoveryEnabled(db, orgLogin, enabled);
    saveDatabase();
    return { ok: true };
  });

  ipcMain.handle('github:save-pat', async (_event, pat: string) => {
    const auth = loadGitHubAuth(db);
    if (!auth) return { error: 'Not authenticated' };
    // Validate the PAT by calling /user
    try {
      const user = await fetchGitHubUser(pat);
      if (user.login.toLowerCase() !== auth.login.toLowerCase()) {
        return { error: `PAT belongs to ${user.login}, but you are signed in as ${auth.login}` };
      }
    } catch {
      return { error: 'Invalid token — could not authenticate with GitHub' };
    }
    saveGitHubPat(db, auth.login, pat);
    // A new PAT means we should re-discover to pick up repos it can see
    setConfigValue(db, 'force_pat_discovery', '1');
    saveDatabase();
    return { ok: true };
  });

  ipcMain.handle('github:delete-pat', () => {
    const auth = loadGitHubAuth(db);
    if (!auth) return { ok: false };
    deleteGitHubPat(db, auth.login);
    saveDatabase();
    return { ok: true };
  });

  ipcMain.handle('github:logout', () => {
    deleteGitHubAuth(db);
    saveDatabase();
    return { ok: true };
  });

  ipcMain.handle('github:start-oauth-discovery', () => {
    setConfigValue(db, 'force_oauth_discovery', '1');
    saveDatabase();
    startDiscoveryIfAuthed(db, getWindow);
    return { ok: true };
  });

  ipcMain.handle('github:pat-status', async () => {
    const pat = loadGitHubPat(db);
    if (!pat) return { hasPat: false };
    try {
      const user = await fetchGitHubUser(pat);
      return { hasPat: true, login: user.login, name: user.name, avatarUrl: user.avatar_url };
    } catch {
      return { hasPat: true };
    }
  });

  ipcMain.handle('github:open-url', (_event, url: string) => {
    if (typeof url === 'string' && url.startsWith('https://github.com/')) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle('github:search-repos', (_event, query: string) => {
    if (!query || query.trim().length < 2) return [];

    // Split into individual words so "myorg reponame" matches across org and repo name
    const words = query.trim().split(/\s+/).filter((w) => w.length > 0);
    const bindParams: string[] = [];

    // Each word must appear in full_name OR name (AND between words = narrowing)
    const conditions = words.map((w) => {
      bindParams.push(`%${w}%`, `%${w}%`);
      return `(r.full_name LIKE ? OR r.name LIKE ?)`;
    }).join(' AND ');

    // For ordering: repos whose name matches the first word rank higher
    const firstPattern = `%${words[0]}%`;
    bindParams.push(firstPattern);

    const sql = `SELECT r.full_name, r.name, r.description, r.language, r.private, r.fork, r.archived
       FROM github_repos r
       LEFT JOIN github_orgs o ON o.id = r.org_id
       WHERE (${conditions})
         AND (r.org_id IS NULL OR o.discovery_enabled = 1)
       ORDER BY
         CASE WHEN r.name LIKE ? THEN 0 ELSE 1 END,
         r.last_pushed_at DESC
       LIMIT 50`;

    const stmt = db.prepare(sql);
    const rows: { full_name: string; name: string; description: string | null; language: string | null; private: number; fork: number; archived: number }[] = [];
    stmt.bind(bindParams);
    while (stmt.step()) rows.push(stmt.getAsObject() as typeof rows[0]);
    stmt.free();
    return rows;
  });

  ipcMain.handle('github:list-repos-for-org', (_event, orgLogin: string | null) => {
    let stmt;
    if (orgLogin === null) {
      // Direct repos (personal + collaborator)
      stmt = db.prepare(
        `SELECT r.full_name, r.name, r.description, r.language, r.private, r.fork, r.archived,
                r.default_branch, r.parent_full_name, r.last_pushed_at, r.last_updated_at
         FROM github_repos r
         WHERE r.org_id IS NULL
         ORDER BY r.last_pushed_at DESC`,
      );
      stmt.bind([]);
    } else {
      stmt = db.prepare(
        `SELECT r.full_name, r.name, r.description, r.language, r.private, r.fork, r.archived,
                r.default_branch, r.parent_full_name, r.last_pushed_at, r.last_updated_at
         FROM github_repos r
         JOIN github_orgs o ON o.id = r.org_id
         WHERE o.login = ?
         ORDER BY r.last_pushed_at DESC`,
      );
      stmt.bind([orgLogin]);
    }
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  });

  ipcMain.handle('github:list-starred', () => {
    const stmt = db.prepare(
      `SELECT full_name, name, description, language, private, fork, archived,
              default_branch, parent_full_name, last_pushed_at
       FROM github_repos
       WHERE starred = 1
       ORDER BY last_pushed_at DESC`,
    );
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  });

  ipcMain.handle('github:start-oauth', async () => {
    console.log('[IPC] github:start-oauth called');

    // Abort any existing flow
    if (activeDeviceFlow) {
      activeDeviceFlow.aborted = true;
      activeDeviceFlow = null;
    }

    const config = loadConfig();
    const clientId = config.github.oauthClientId;
    console.log('[IPC] Client ID:', clientId ? `${clientId.substring(0, 8)}...` : 'NOT SET');

    if (!clientId) {
      return { error: 'GitHub OAuth Client ID is not configured. Set it in config.json.' };
    }

    try {
      console.log('[IPC] Requesting device code from GitHub...');
      const deviceCode = await requestDeviceCode(clientId, config.github.scopes);
      console.log('[IPC] Got device code, user_code:', deviceCode.user_code);

      const flow = {
        deviceCode: deviceCode.device_code,
        clientId,
        intervalMs: deviceCode.interval * 1000,
        aborted: false,
      };
      activeDeviceFlow = flow;

      // Open the verification URL in the default browser
      shell.openExternal(deviceCode.verification_uri);

      // Kick off polling in the background — main process owns the timing
      startPollingLoop(flow, db, getWindow);

      return {
        status: 'pending',
        userCode: deviceCode.user_code,
        verificationUri: deviceCode.verification_uri,
        expiresIn: deviceCode.expires_in,
      };
    } catch (err) {
      return { error: String(err) };
    }
  });
}

async function startPollingLoop(
  flow: { deviceCode: string; clientId: string; intervalMs: number; aborted: boolean },
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const deadline = Date.now() + 15 * 60 * 1000; // 15-minute max

  while (!flow.aborted && Date.now() < deadline) {
    await sleep(flow.intervalMs);

    if (flow.aborted) break;

    try {
      const result = await pollForToken(flow.clientId, flow.deviceCode, flow);
      console.log('[Poll] pollForToken result:', result ? 'got token' : 'still pending');

      if (!result) continue;

      // Got a token — save it and notify
      activeDeviceFlow = null;
      const user = await fetchGitHubUser(result.access_token);
      console.log('[Poll] GitHub user:', user.login);

      saveGitHubAuth(db, user.login, result.access_token, result.scope, user.avatar_url);
      completeOnboardingStep(db, 'github_oauth');
      saveDatabase();
      console.log('[Poll] Auth saved, pushing oauth-complete to renderer');

      // Kick off background discovery now that we have auth
      startDiscoveryIfAuthed(db, getWindow, true);

      new Notification({
        title: 'Jarvis',
        body: `Signed in as ${user.login}. GitHub connection ready!`,
      }).show();

      getWindow()?.webContents.send('github:oauth-complete', {
        login: user.login,
        name: user.name,
        avatarUrl: user.avatar_url,
      });
      return;
    } catch (err: unknown) {
      const msg = String(err);
      if (msg.includes('slow_down')) {
        // slow_down is now handled inside pollForToken by adjusting flow.intervalMs
        continue;
      }
      console.error('[Poll] Fatal error, aborting:', msg);
      activeDeviceFlow = null;
      getWindow()?.webContents.send('github:oauth-complete', { error: msg });
      return;
    }
  }

  if (!flow.aborted) {
    console.log('[Poll] Device flow timed out');
    activeDeviceFlow = null;
    getWindow()?.webContents.send('github:oauth-complete', { error: 'Authorization timed out. Please try again.' });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startDiscoveryIfAuthed(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
  force = false,
): void {
  const auth = loadGitHubAuth(db);
  if (!auth) return;

  if (activeDiscovery && !activeDiscovery.aborted) {
    console.log('[Discovery] Already running, skipping');
    return;
  }

  // Check config flags for forced re-runs
  const forceOAuthFlag = getConfigValue(db, 'force_oauth_discovery') === '1';
  const forcePatFlag = getConfigValue(db, 'force_pat_discovery') === '1';

  if (forceOAuthFlag) {
    console.log('[Discovery] force_oauth_discovery flag is set — running full discovery');
    force = true;
    setConfigValue(db, 'force_oauth_discovery', '0');
    saveDatabase();
  }

  // If only the PAT flag is set (no full re-run needed), run just the PAT pass
  if (!force && forcePatFlag) {
    const pat = loadGitHubPat(db);
    if (pat) {
      console.log('[Discovery] force_pat_discovery flag is set — running PAT-only discovery');
      setConfigValue(db, 'force_pat_discovery', '0');
      saveDatabase();

      runPatDiscovery(db, pat, undefined, undefined, (progress) => {
        lastDiscoveryProgress = progress;
        getWindow()?.webContents.send('github:discovery-progress', progress);
      }).then(() => {
        // Emit done after PAT-only pass
        const doneProgress: DiscoveryProgress = {
          phase: 'done',
          orgsFound: lastDiscoveryProgress?.orgsFound ?? 0,
          reposFound: lastDiscoveryProgress?.reposFound ?? 0,
        };
        lastDiscoveryProgress = doneProgress;
        getWindow()?.webContents.send('github:discovery-progress', doneProgress);
        getWindow()?.webContents.send('github:discovery-complete', doneProgress);
        console.log('[Discovery] PAT-only discovery finished');
      }).catch((err) => {
        console.error('[Discovery] PAT-only discovery failed:', err);
      });
      return;
    } else {
      // No PAT configured, just clear the flag
      setConfigValue(db, 'force_pat_discovery', '0');
      saveDatabase();
    }
  }

  // Clear PAT flag if doing a full run (full run includes PAT pass)
  if (force && forcePatFlag) {
    setConfigValue(db, 'force_pat_discovery', '0');
    saveDatabase();
  }

  // Skip automatic discovery if orgs already exist (data was persisted from a previous run)
  if (!force) {
    const existing = listOrgs(db);
    if (existing.orgs.length > 0) {
      // Check if data is stale (> 1 hour old) — run lightweight refresh if so
      const lastIndexed = getLastOrgIndexedAt(db);
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const isStale = !lastIndexed || (Date.now() - new Date(lastIndexed + 'Z').getTime()) > ONE_HOUR_MS;

      if (isStale) {
        console.log('[Discovery] Data is stale, running lightweight refresh (orgs + collaborator repos)');
        const pat = loadGitHubPat(db);
        runLightweightRefresh(db, auth.accessToken, (progress) => {
          lastDiscoveryProgress = progress;
          getWindow()?.webContents.send('github:discovery-progress', progress);
        }, pat).then(() => {
          console.log('[Discovery] Lightweight refresh finished');
          getWindow()?.webContents.send('github:discovery-complete', lastDiscoveryProgress);
        }).catch((err) => {
          console.error('[Discovery] Lightweight refresh failed:', err);
        });
      } else {
        console.log(`[Discovery] Already have ${existing.orgs.length} org(s) in DB and data is fresh, skipping.`);

        // First boot after starred feature was added — fetch stars standalone
        if (existing.starredRepoCount === 0) {
          console.log('[Discovery] No starred repos indexed yet — fetching stars now');
          const starState: DiscoveryState = { callsSinceLastPause: 0, aborted: false, lastRateLimit: null };
          const starProgress: DiscoveryProgress = { phase: 'starred', orgsFound: 0, reposFound: 0 };
          fetchStarredRepos(db, auth.accessToken, starState, starProgress, (p) => {
            lastDiscoveryProgress = p;
            getWindow()?.webContents.send('github:discovery-progress', p);
          }).then(() => {
            const done: DiscoveryProgress = { phase: 'done', orgsFound: 0, reposFound: starProgress.reposFound };
            lastDiscoveryProgress = done;
            getWindow()?.webContents.send('github:discovery-complete', done);
          }).catch((err) => console.error('[Discovery] Starred-only fetch failed:', err));
        }
      }
      return;
    }
  }

  console.log('[Discovery] Starting background discovery for', auth.login);
  const pat = loadGitHubPat(db);
  runDiscovery(db, auth.accessToken, (progress) => {
    lastDiscoveryProgress = progress;
    getWindow()?.webContents.send('github:discovery-progress', progress);
  }, pat).then((_state) => {
    activeDiscovery = null;
    console.log('[Discovery] Finished');
    getWindow()?.webContents.send('github:discovery-complete', lastDiscoveryProgress);
  }).catch((err) => {
    activeDiscovery = null;
    console.error('[Discovery] Failed:', err);
  });
}
