import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildMcpClientSnippets, buildServerEnv, MCP_SERVER_NAME } from '../../src/services/mcp-config';

const electronState = vi.hoisted(() => ({ packaged: false, appPath: 'C:\\repo\\Jarvis' }));
vi.mock('electron', () => ({
  app: { get isPackaged() { return electronState.packaged; }, getAppPath: () => electronState.appPath },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../../src/storage/database', () => ({ getDatabasePath: () => 'C:\\data\\Jarvis\\jarvis.db' }));

import path from 'node:path';
import { describeLaunch, getMcpClientConfig, resolveServerScriptPath, serverScriptPathFrom } from '../../src/plugins/mcp-server/handler';

/** Where the handler module's own folder resolves the server script to. */
const EXPECTED_DEV_SCRIPT = path.resolve(__dirname, '..', '..', 'src', 'mcp-server', 'index.js');

describe('mcp-config snippets', () => {
  it('builds the server env, adding the Node flag only when packaged', () => {
    expect(buildServerEnv({ dbPath: 'C:\\d\\jarvis.db', indexPath: 'C:\\d\\jarvis-index.db', packaged: false })).toEqual({
      JARVIS_DB: 'C:\\d\\jarvis.db',
      JARVIS_INDEX_DB: 'C:\\d\\jarvis-index.db',
    });
    expect(buildServerEnv({ dbPath: 'a', indexPath: 'b', packaged: true }).ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('renders Claude Desktop, VS Code and Claude Code snippets from one launch', () => {
    const snippets = buildMcpClientSnippets({
      command: 'node',
      serverScriptPath: 'C:\\repo\\dist\\mcp-server\\index.js',
      env: { JARVIS_DB: 'C:\\d\\jarvis.db' },
    });
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
  });
});

describe('mcp-server handler', () => {
  beforeEach(() => {
    electronState.packaged = false;
    electronState.appPath = 'C:\\repo\\Jarvis';
  });

  it('resolves the script next to the compiled plugin, never via app.getAppPath()', () => {
    expect(serverScriptPathFrom('C:\\repo\\Jarvis\\dist\\plugins\\mcp-server')).toBe('C:\\repo\\Jarvis\\dist\\mcp-server\\index.js');
    expect(serverScriptPathFrom('C:\\Program Files\\Jarvis\\resources\\app.asar\\dist\\plugins\\mcp-server')).toBe(
      'C:\\Program Files\\Jarvis\\resources\\app.asar.unpacked\\dist\\mcp-server\\index.js',
    );
    expect(resolveServerScriptPath()).toBe(EXPECTED_DEV_SCRIPT);
  });

  it('uses node and the checkout path in development', () => {
    const launch = describeLaunch();
    expect(launch.command).toBe('node');
    expect(launch.serverScriptPath).toBe(EXPECTED_DEV_SCRIPT);
    expect(launch.env).toEqual({
      JARVIS_DB: 'C:\\data\\Jarvis\\jarvis.db',
      JARVIS_INDEX_DB: 'C:\\data\\Jarvis\\jarvis-index.db',
    });
  });

  it('uses the bundled Electron runtime and the unpacked asar path when installed', () => {
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
    expect(cfg.dbPath).toBe('C:\\data\\Jarvis\\jarvis.db');
    expect(cfg.indexPath).toBe('C:\\data\\Jarvis\\jarvis-index.db');
    expect(JSON.parse(cfg.claudeDesktop).mcpServers.jarvis.env.JARVIS_INDEX_DB).toBe('C:\\data\\Jarvis\\jarvis-index.db');
  });
});
