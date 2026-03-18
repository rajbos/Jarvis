const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OllamaModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  modified_at: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaStatus {
  available: boolean;
  baseUrl: string;
  models: OllamaModel[];
  error?: string;
}

/**
 * Check if Ollama is running and return its models.
 * Uses a short timeout so startup is not delayed significantly.
 */
export async function checkOllama(): Promise<OllamaStatus> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    let response: Response;
    try {
      response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return {
        available: false,
        baseUrl: OLLAMA_BASE_URL,
        models: [],
        error: `Ollama responded with HTTP ${response.status}`,
      };
    }

    const data = (await response.json()) as { models?: OllamaModel[] };
    const models: OllamaModel[] = data.models ?? [];

    console.log(`[Ollama] Available — ${models.length} model(s):`, models.map((m) => m.name).join(', ') || '(none)');

    return {
      available: true,
      baseUrl: OLLAMA_BASE_URL,
      models,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = message.includes('abort') || message.includes('AbortError');
    const reason = isAbort ? 'Connection timed out' : message;

    console.log('[Ollama] Not available:', reason);
    return {
      available: false,
      baseUrl: OLLAMA_BASE_URL,
      models: [],
      error: reason,
    };
  }
}

/**
 * Stream a chat completion from Ollama. Calls onToken for each text chunk.
 */
export async function streamChat(
  model: string,
  messages: ChatMessage[],
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options: { num_ctx: 16384 } }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Ollama chat error: HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error('Ollama response has no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { message?: { content?: string }; done: boolean };
          if (parsed.message?.content) {
            onToken(parsed.message.content);
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Tool-calling support ──────────────────────────────────────────────────────

export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required?: string[];
    };
  };
}

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * Thrown by chatWithTools when the model returns HTTP 400, which indicates
 * it does not support tool/function calling.
 */
export class ToolsNotSupportedError extends Error {
  constructor() { super('Model does not support tool calling'); this.name = 'ToolsNotSupportedError'; }
}

/**
 * Non-streaming chat request that supports tool calls.
 * Returns the assistant message. If the model wants to call a tool, the
 * `tool_calls` array will be populated and `content` will be empty/null.
 * Throws ToolsNotSupportedError on HTTP 400 (model doesn't support tools).
 */
export async function chatWithTools(
  model: string,
  messages: ChatMessage[],
  tools: OllamaTool[],
  signal?: AbortSignal,
): Promise<{ content: string; tool_calls: OllamaToolCall[] }> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: false, options: { num_ctx: 16384 } }),
    signal,
  });

  if (response.status === 400) {
    throw new ToolsNotSupportedError();
  }

  if (!response.ok) {
    throw new Error(`Ollama chat error: HTTP ${response.status}`);
  }

  const data = await response.json() as {
    message?: { content?: string; tool_calls?: OllamaToolCall[] };
  };

  const content = data.message?.content ?? '';
  const structuredToolCalls = data.message?.tool_calls ?? [];

  // Some small models (e.g. llama3.2:3b) emit tool calls as raw JSON text in
  // `content` rather than in the structured `tool_calls` field. Detect and
  // parse that fallback so they still work.
  if (structuredToolCalls.length === 0 && content.trim()) {
    const extracted = extractTextToolCalls(content, tools);
    if (extracted.length > 0) {
      return { content: '', tool_calls: extracted };
    }
  }

  return { content, tool_calls: structuredToolCalls };
}

/**
 * Try to extract tool calls from plain-text content when the model emits them
 * as JSON rather than using the structured tool_calls field.
 * Handles both {"name":...,"parameters":{...}} and {"function":{...}} shapes.
 */
function extractTextToolCalls(
  content: string,
  tools: OllamaTool[],
): OllamaToolCall[] {
  const toolNames = new Set(tools.map((t) => t.function.name));
  const results: OllamaToolCall[] = [];

  // Find all {...} blocks and try to parse them as tool calls
  const jsonRegex = /\{[\s\S]*?\}/g;
  let match: RegExpExecArray | null;
  while ((match = jsonRegex.exec(content)) !== null) {
    try {
      const obj = JSON.parse(match[0]) as Record<string, unknown>;

      // Shape 1: {"name": "search_secrets", "parameters": {"pattern": "PAT"}}
      if (typeof obj['name'] === 'string' && toolNames.has(obj['name'])) {
        const args = (obj['parameters'] ?? obj['arguments'] ?? {}) as Record<string, unknown>;
        results.push({ function: { name: obj['name'], arguments: args } });
        continue;
      }

      // Shape 2: {"function": {"name": "search_secrets", "parameters": {...}}}
      const fn = obj['function'] as Record<string, unknown> | undefined;
      if (fn && typeof fn['name'] === 'string' && toolNames.has(fn['name'])) {
        const args = (fn['parameters'] ?? fn['arguments'] ?? {}) as Record<string, unknown>;
        results.push({ function: { name: fn['name'], arguments: args } });
      }
    } catch {
      // not valid JSON, keep scanning
    }
  }
  return results;
}
