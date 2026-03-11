const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

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
