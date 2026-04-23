import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkOllama,
  streamChat,
  chatWithTools,
  ToolsNotSupportedError,
  type OllamaTool,
  type ChatMessage,
} from '../../src/services/ollama';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a fake response body whose reader emits one chunk per string in `lines`. */
function makeMockBody(lines: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader() {
      return {
        read: vi.fn().mockImplementation(async () => {
          if (index < lines.length) {
            return { done: false, value: encoder.encode(lines[index++]) };
          }
          return { done: true, value: undefined };
        }),
        releaseLock: vi.fn(),
      };
    },
  };
}

const MODEL = 'llama3.2:3b';
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'Hello' }];
const TOOLS: OllamaTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_secrets',
      description: 'Search for secrets in a repository',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string', description: 'Search pattern' } },
        required: ['pattern'],
      },
    },
  },
];

// ── checkOllama ───────────────────────────────────────────────────────────────

describe('checkOllama', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns available=true with models when fetch returns 200', async () => {
    const models = [
      { name: 'llama3.2:3b', model: 'llama3.2:3b', size: 1_000_000, digest: 'abc123', modified_at: '2024-01-01' },
    ];
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ models }), { status: 200 }),
    );

    const result = await checkOllama();

    expect(result.available).toBe(true);
    expect(result.models).toHaveLength(1);
    expect(result.models[0].name).toBe('llama3.2:3b');
    expect(result.error).toBeUndefined();
  });

  it('returns available=false with error message when fetch returns non-200', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Service Unavailable', { status: 503 }),
    );

    const result = await checkOllama();

    expect(result.available).toBe(false);
    expect(result.models).toHaveLength(0);
    expect(result.error).toContain('503');
  });

  it('returns available=false with "Connection timed out" on AbortError', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    vi.mocked(fetch).mockRejectedValue(abortError);

    const result = await checkOllama();

    expect(result.available).toBe(false);
    expect(result.error).toBe('Connection timed out');
  });

  it('returns available=false with error message for generic network errors', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await checkOllama();

    expect(result.available).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });
});

// ── streamChat ────────────────────────────────────────────────────────────────

describe('streamChat', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('happy path: calls onToken for each chunk and resolves when stream ends', async () => {
    const lines = [
      '{"message":{"content":"Hello"},"done":false}\n',
      '{"message":{"content":" world"},"done":false}\n',
      '{"done":true}\n',
    ];
    vi.mocked(fetch).mockResolvedValue(
      { ok: true, body: makeMockBody(lines) } as unknown as Response,
    );

    const tokens: string[] = [];
    await streamChat(MODEL, MESSAGES, (t) => tokens.push(t));

    expect(tokens).toEqual(['Hello', ' world']);
  });

  it('throws with HTTP status when response is not ok', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );

    await expect(streamChat(MODEL, MESSAGES, vi.fn()))
      .rejects.toThrow('Ollama chat error: HTTP 500');
  });

  it('throws "Ollama response has no body" when body is null', async () => {
    vi.mocked(fetch).mockResolvedValue(
      { ok: true, body: null } as unknown as Response,
    );

    await expect(streamChat(MODEL, MESSAGES, vi.fn()))
      .rejects.toThrow('Ollama response has no body');
  });

  it('propagates abort when signal fires mid-stream', async () => {
    const abortController = new AbortController();
    const encoder = new TextEncoder();
    let callCount = 0;

    const mockBody = {
      getReader() {
        return {
          read: vi.fn().mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
              return {
                done: false,
                value: encoder.encode('{"message":{"content":"Hi"},"done":false}\n'),
              };
            }
            // Second read — simulate reader being aborted
            throw new DOMException('The operation was aborted', 'AbortError');
          }),
          releaseLock: vi.fn(),
        };
      },
    };

    vi.mocked(fetch).mockResolvedValue(
      { ok: true, body: mockBody } as unknown as Response,
    );

    const onToken = vi.fn();
    await expect(
      streamChat(MODEL, MESSAGES, onToken, abortController.signal),
    ).rejects.toThrow();

    expect(onToken).toHaveBeenCalledWith('Hi');
  });

  it('skips malformed (non-JSON) lines gracefully', async () => {
    const lines = [
      '{"message":{"content":"OK"},"done":false}\n',
      'this is not json at all\n',
      '{"done":true}\n',
    ];
    vi.mocked(fetch).mockResolvedValue(
      { ok: true, body: makeMockBody(lines) } as unknown as Response,
    );

    const tokens: string[] = [];
    await expect(
      streamChat(MODEL, MESSAGES, (t) => tokens.push(t)),
    ).resolves.toBeUndefined();

    expect(tokens).toEqual(['OK']);
  });
});

// ── chatWithTools ─────────────────────────────────────────────────────────────

describe('chatWithTools', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns content and empty tool_calls for a normal text response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ message: { content: 'Sure, I can help!', tool_calls: [] } }),
        { status: 200 },
      ),
    );

    const result = await chatWithTools(MODEL, MESSAGES, TOOLS);

    expect(result.content).toBe('Sure, I can help!');
    expect(result.tool_calls).toEqual([]);
  });

  it('returns structured tool_calls from the tool_calls field', async () => {
    const toolCalls = [
      { function: { name: 'search_secrets', arguments: { pattern: 'PAT' } } },
    ];
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ message: { content: '', tool_calls: toolCalls } }),
        { status: 200 },
      ),
    );

    const result = await chatWithTools(MODEL, MESSAGES, TOOLS);

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].function.name).toBe('search_secrets');
    expect(result.tool_calls[0].function.arguments).toEqual({ pattern: 'PAT' });
    expect(result.content).toBe('');
  });

  it('throws ToolsNotSupportedError on HTTP 400', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Bad Request', { status: 400 }),
    );

    await expect(chatWithTools(MODEL, MESSAGES, TOOLS))
      .rejects.toBeInstanceOf(ToolsNotSupportedError);
  });

  it('ToolsNotSupportedError has the right message and name', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Bad Request', { status: 400 }),
    );

    let err: unknown;
    try {
      await chatWithTools(MODEL, MESSAGES, TOOLS);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ToolsNotSupportedError);
    expect((err as ToolsNotSupportedError).message).toBe('Model does not support tool calling');
    expect((err as ToolsNotSupportedError).name).toBe('ToolsNotSupportedError');
  });

  it('throws on other HTTP errors', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );

    await expect(chatWithTools(MODEL, MESSAGES, TOOLS))
      .rejects.toThrow('Ollama chat error: HTTP 500');
  });

  it('extracts tool calls from plain-text content when tool_calls is empty (shape 1 — name at top level)', async () => {
    // Some models embed the call as {"name":"<tool>", ...} in prose text
    const contentWithToolCall = 'Let me search for that. {"name":"search_secrets"} Result follows.';
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ message: { content: contentWithToolCall, tool_calls: [] } }),
        { status: 200 },
      ),
    );

    const result = await chatWithTools(MODEL, MESSAGES, TOOLS);

    expect(result.content).toBe('');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].function.name).toBe('search_secrets');
  });

  it('does not extract tool calls for unknown tool names in plain-text fallback', async () => {
    // JSON in content referencing a tool not in the tools list — should be ignored
    const contentWithUnknownTool = '{"name":"unknown_tool","parameters":{}}';
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ message: { content: contentWithUnknownTool, tool_calls: [] } }),
        { status: 200 },
      ),
    );

    const result = await chatWithTools(MODEL, MESSAGES, TOOLS);

    // Falls through to the normal return path — content is preserved, no tool calls extracted
    expect(result.tool_calls).toHaveLength(0);
    expect(result.content).toBe(contentWithUnknownTool);
  });
});
