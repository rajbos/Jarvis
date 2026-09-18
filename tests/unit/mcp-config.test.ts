import { describe, expect, it, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { buildMcpClientSnippets, buildServerEnv, quoteForShell, MCP_SERVER_NAME } from '../../src/services/mcp-config';

// Paths are built with the platform's own separators so the tests pass on
// Windows and on the Linux CI runners alike.
const DB_PATH = path.resolve('data', 'Jarvis', 'jarvis.db');
const INDEX_PATH = path.resolve('data', 'Jarvis', 'jarvis-index.db');

const electronState = vi.hoisted(() => ({ packaged: false }));
vi.mock('electron', () => ({
  app: { get isPackaged() { return electronState.packaged; }, getAppPath: () => 'unused' },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../../src/storage/database', () => ({ getDatabasePath: () => path.resolve('data', 'Jarvis', 'jarvis.db') }));

import { describeLaunch, getMcpClientConfig, resolveServerScriptPath, serverScriptPathFrom } from '../../src/plugins/mcp-server/handler';

/** Where the handler module's own folder resolves the server script to. */
const EXPECTED_DEV_SCRIPT = path.resolve(__dirname, '..', '..', 'src', 'mcp-server', 'index.js');

describe('mcp-config snippets', () => {
  it('builds the server env, adding the Node flag only when packaged', () => {
    expect(buildServerEnv({ dbPath: DB_PATH, indexPath: INDEX_PATH, packaged: false })).toEqual({
      JARVIS_DB: DB_PATH,
      JARVIS_INDEX_DB: INDEX_PATH,
    });
    expect(buildServerEnv({ dbPath: 'a', indexPath: 'b', packaged: true }).ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('quotes for Windows shells without touching backslashes, and rejects embedded double quotes', () => {
    expect(quoteForShell('C:\\Users\\Rob Bos\\jarvis.db', 'win32')).toBe('"C:\\Users\\Rob Bos\\jarvis.db"');
    expect(() => quoteForShell('bad"value', 'win32')).toThrow(/double quote/);
  });

  it('quotes for POSIX shells with single quotes, escaping embedded single quotes', () => {
    expect(quoteForShell('/home/rob/jarvis.db', 'linux')).toBe("'/home/rob/jarvis.db'");
    expect(quoteForShell("it's $HOME `x` \\ \"q\"", 'darwin')).toBe("'it'\\''s $HOME `x` \\ \"q\"'");
  });

  it('renders Claude Desktop, VS Code and Claude Code snippets from one launch', () => {
    const launch = {
      command: 'node',
      serverScriptPath: 'C:\\repo\\dist\\mcp-server\\index.js',
      env: { JARVIS_DB: 'C:\\d\\jarvis.db' },
    };
    const snippets = buildMcpClientSnippets(launch, 'win32');
    const desktop = JSON.parse(snippets.claudeDesktop);
    expect(desktop.mcpServers[MCP_SERVER_NAME]).toEqual({
      command: 'node',
      args: ['C:\\repo\\dist\\mcp-server\\index.js'],
      env: { JARVIS_DB: 'C:\\d\\jarvis.db' },
    });
    const vscode = JSON.parse(snippets.vscode);
    expect(vscode.servers[MCP_SERVER_NAME].type).toBe('stdio');
    expect(vscode.servers[MCP_SERVER_NAME].args).toEqual(['C:\\repo\\dist\\mcp-server\\index.js']);
    expect(snippets.claudeCode).toBe(
      'claude mcp add jarvis --env JARVIS_DB="C:\\d\\jarvis.db" -- "node" "C:\\repo\\dist\\mcp-server\\index.js"',
    );
    expect(snippets.generic.command).toBe('node');

    const posix = buildMcpClientSnippets({ command: 'node', serverScriptPath: '/opt/jarvis/index.js', env: { JARVIS_DB: '/home/rob/jarvis.db' } }, 'linux');
    expect(posix.claudeCode).toBe("claude mcp add jarvis --env JARVIS_DB='/home/rob/jarvis.db' -- 'node' '/opt/jarvis/index.js'");
  });
});

describe('mcp-server handler', () => {
  beforeEach(() => {
    electronState.packaged = false;
  });

  it('resolves the script next to the compiled plugin, never via app.getAppPath()', () => {
    const pluginDir = path.resolve('repo', 'Jarvis', 'dist', 'plugins', 'mcp-server');
    expect(serverScriptPathFrom(pluginDir)).toBe(path.resolve('repo', 'Jarvis', 'dist', 'mcp-server', 'index.js'));

    const asarDir = path.resolve('Jarvis', 'resources', 'app.asar', 'dist', 'plugins', 'mcp-server');
    expect(serverScriptPathFrom(asarDir)).toBe(path.resolve('Jarvis', 'resources', 'app.asar.unpacked', 'dist', 'mcp-server', 'index.js'));

    expect(resolveServerScriptPath()).toBe(EXPECTED_DEV_SCRIPT);
  });

  it('uses node and the checkout path in development', () => {
    const launch = describeLaunch();
    expect(launch.command).toBe('node');
    expect(launch.serverScriptPath).toBe(EXPECTED_DEV_SCRIPT);
    expect(launch.env).toEqual({
      JARVIS_DB: DB_PATH,
      JARVIS_INDEX_DB: INDEX_PATH,
    });
  });

  it('uses the bundled Electron runtime when installed', () => {
    electronState.packaged = true;
    const launch = describeLaunch();
    expect(launch.command).toBe(process.execPath);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('reports whether the script and index exist', () => {
    const cfg = getMcpClientConfig();
    expect(cfg.packaged).toBe(false);
    expect(cfg.serverScriptExists).toBe(false);
    expect(cfg.indexExists).toBe(false);
    expect(cfg.dbPath).toBe(DB_PATH);
    expect(cfg.indexPath).toBe(INDEX_PATH);
    expect(JSON.parse(cfg.claudeDesktop).mcpServers.jarvis.env.JARVIS_INDEX_DB).toBe(INDEX_PATH);
  });
});
