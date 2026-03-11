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
    body: JSON.stringify({ model, messages, stream: true }),
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
