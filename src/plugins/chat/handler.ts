// ── Chat IPC handlers ─────────────────────────────────────────────────────────
import { ipcMain, BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import {
  streamChat,
  chatWithTools,
  ToolsNotSupportedError,
  type ChatMessage,
  type OllamaTool,
  type OllamaToolCall,
} from '../../services/ollama';
import { getConfigValue } from '../../storage/database';
import { buildSystemContext, searchReposForChat, searchSecretsForChat } from './db-helpers';

const activeChatAborts = new Map<number, AbortController>();

// ── Chat tools ────────────────────────────────────────────────────────────────

const CHAT_TOOLS: OllamaTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_secrets',
      description:
        'Search for GitHub Actions secret names across the user\'s personal repositories. ' +
        'Use this when the user asks about secrets, tokens, PATs, credentials, or any named ' +
        'secret stored as a GitHub Actions secret. Supports partial matching on the secret name.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Partial or full secret name to search for (e.g. "PAT", "TOKEN", "AWS").',
          },
        },
        required: ['pattern'],
      },
    },
  },
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

function dispatchToolCall(db: SqlJsDatabase, call: OllamaToolCall): string {
  if (call.function.name === 'search_repos') {
    const query = String(call.function.arguments['query'] ?? '');
    return searchReposForChat(db, query);
  }
  if (call.function.name === 'search_secrets') {
    const pattern = String(call.function.arguments['pattern'] ?? '');
    return searchSecretsForChat(db, pattern);
  }
  return `Unknown tool: ${call.function.name}`;
}

// ── Handler registration ──────────────────────────────────────────────────────

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('chat:send', (event, userMessages: Array<{ role: string; content: string }>) => {
    if (!Array.isArray(userMessages) || userMessages.length === 0) return { ok: false, error: 'Invalid messages' };
    for (const msg of userMessages) {
      if (typeof msg !== 'object' || msg === null) return { ok: false, error: 'Invalid message entry' };
      if (typeof msg.role !== 'string' || typeof msg.content !== 'string') return { ok: false, error: 'Invalid message fields' };
    }

    const model = getConfigValue(db, 'selected_ollama_model');
    if (!model) {
      event.sender.send('chat:error', 'No Ollama model selected. Please select a model in the main window.');
      return { ok: false };
    }

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
        const MAX_TOOL_ROUNDS = 5;
        let round = 0;
        let toolsSupported = true;
        while (round < MAX_TOOL_ROUNDS) {
          round++;
          let content: string;
          let tool_calls: OllamaToolCall[];
          try {
            ({ content, tool_calls } = await chatWithTools(model, messages, CHAT_TOOLS, controller.signal));
          } catch (err) {
            if (err instanceof ToolsNotSupportedError) {
              toolsSupported = false;
              break;
            }
            throw err;
          }

          if (tool_calls.length === 0) {
            const words = content.split(/(\s+)/);
            for (const chunk of words) {
              if (controller.signal.aborted) return;
              if (!event.sender.isDestroyed()) event.sender.send('chat:token', chunk);
            }
            break;
          }

          (messages as Array<ChatMessage & { tool_calls?: OllamaToolCall[] }>).push({
            role: 'assistant',
            content,
            tool_calls,
          });

          for (const call of tool_calls) {
            const result = dispatchToolCall(db, call);
            (messages as Array<ChatMessage & { name?: string }>).push({
              role: 'tool' as ChatMessage['role'],
              content: result,
              name: call.function.name,
            });
          }
        }

        if (!toolsSupported) {
          await streamChat(model, messages, (token) => {
            if (!event.sender.isDestroyed()) event.sender.send('chat:token', token);
          }, controller.signal);
        }

        if (!event.sender.isDestroyed()) event.sender.send('chat:done');
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
}
