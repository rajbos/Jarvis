// ── MCP client configuration builder ──────────────────────────────────────────
// Produces the ready-to-paste configuration other MCP clients need to spawn
// the Jarvis MCP server. Pure functions so the snippets can be unit-tested;
// the plugin handler supplies the runtime facts (paths, packaged or not).

export interface McpServerLaunch {
  /** Executable that runs the server script: "node" in dev, Electron's own binary when packaged. */
  command: string;
  /** Absolute path to dist/mcp-server/index.js. */
  serverScriptPath: string;
  /** Environment the server needs (database + index locations, runtime flags). */
  env: Record<string, string>;
}

export interface McpClientSnippets {
  /** JSON for %APPDATA%\Claude\claude_desktop_config.json */
  claudeDesktop: string;
  /** JSON for VS Code's mcp.json (user or .vscode/mcp.json) */
  vscode: string;
  /** One-line `claude mcp add` command for Claude Code */
  claudeCode: string;
  /** The launch triple itself, for clients not covered above */
  generic: McpServerLaunch;
}

export const MCP_SERVER_NAME = 'jarvis';

/** Environment variables the server reads. Index path is derived from JARVIS_DB unless overridden. */
export function buildServerEnv(opts: { dbPath: string; indexPath: string; packaged: boolean }): Record<string, string> {
  const env: Record<string, string> = {
    JARVIS_DB: opts.dbPath,
    JARVIS_INDEX_DB: opts.indexPath,
  };
  // When the installed app's own Electron binary is the runtime, this flag turns it into plain Node.
  if (opts.packaged) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

/**
 * Quote one argument for the shell the snippet will be pasted into.
 * - POSIX: single quotes, with embedded single quotes closed/escaped/reopened.
 *   Nothing else is special inside single quotes, so backslashes need no escaping.
 * - Windows (cmd / PowerShell): double quotes. Backslashes are ordinary path
 *   characters there and must stay as-is; a double quote inside a path cannot
 *   occur on Windows, so it is rejected rather than escaped.
 */
export function quoteForShell(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    if (value.includes('"')) throw new Error(`Cannot quote a value containing a double quote for Windows shells: ${value}`);
    return `"${value}"`;
  }
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** Build all client snippets from one launch description. */
export function buildMcpClientSnippets(launch: McpServerLaunch, platform: NodeJS.Platform = process.platform): McpClientSnippets {
  const server = {
    command: launch.command,
    args: [launch.serverScriptPath],
    env: launch.env,
  };
  const claudeDesktop = JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2);
  const vscode = JSON.stringify({ servers: { [MCP_SERVER_NAME]: { type: 'stdio', ...server } } }, null, 2);
  const q = (v: string) => quoteForShell(v, platform);
  const envFlags = Object.entries(launch.env).map(([k, v]) => `--env ${k}=${q(v)}`).join(' ');
  const claudeCode = `claude mcp add ${MCP_SERVER_NAME} ${envFlags} -- ${q(launch.command)} ${q(launch.serverScriptPath)}`;
  return { claudeDesktop, vscode, claudeCode, generic: launch };
}
