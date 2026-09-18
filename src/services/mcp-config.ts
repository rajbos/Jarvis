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

function quoteForShell(value: string): string {
  // Double quotes work in cmd, PowerShell and POSIX shells for paths without embedded quotes.
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Build all client snippets from one launch description. */
export function buildMcpClientSnippets(launch: McpServerLaunch): McpClientSnippets {
  const server = {
    command: launch.command,
    args: [launch.serverScriptPath],
    env: launch.env,
  };
  const claudeDesktop = JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2);
  const vscode = JSON.stringify({ servers: { [MCP_SERVER_NAME]: { type: 'stdio', ...server } } }, null, 2);
  const envFlags = Object.entries(launch.env).map(([k, v]) => `--env ${k}=${quoteForShell(v)}`).join(' ');
  const claudeCode = `claude mcp add ${MCP_SERVER_NAME} ${envFlags} -- ${quoteForShell(launch.command)} ${quoteForShell(launch.serverScriptPath)}`;
  return { claudeDesktop, vscode, claudeCode, generic: launch };
}
