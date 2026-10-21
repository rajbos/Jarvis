// ── Local agent session usage ─────────────────────────────────────────────────
// Token usage and cost for running local sessions, read from each session's
// transcript / event log by the ai-engineering-fluency session parser
// (@rajbos/ai-engineering-fluency/session). Copilot logs carry the exact billed
// amount in AI credits; Claude Code logs only carry tokens, so those get an
// estimate at Anthropic API rates (a subscription has no per-session bill).

import type { ActiveAgentSession, LocalSessionUsage } from '../plugins/types';
import path from 'path';
import { Worker } from 'worker_threads';
import { logger } from './logger';

/** The fields Jarvis reads from the package's `SessionUsage`. */
export interface ParsedSessionUsage {
  models: readonly string[];
  modelUsage: { readonly [model: string]: { readonly inputTokens: number; readonly outputTokens: number } };
  totalTokens: number;
  copilotCredits: number | null;
  estimatedCostUsd: { readonly provider: number; readonly copilot: number };
}

export type AnalyzeSessionFile = (filePath: string) => Promise<ParsedSessionUsage | null>;

let defaultAnalyzer: AnalyzeSessionFile | null | undefined;

interface WorkerReply {
  id: number;
  usage?: ParsedSessionUsage | null;
  error?: string;
}

/**
 * The parser runs in a worker thread: it loads the Copilot CLI's 90+ MB
 * session-store.db into sql.js whenever that file changes (the CLI rewrites it
 * constantly), which blocked the main thread for 10+ s per sweep. If the worker
 * can't start, sessions simply show no usage.
 */
function createWorkerAnalyzer(): AnalyzeSessionFile {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (u: ParsedSessionUsage | null) => void; reject: (e: Error) => void }>();

  const failAll = (err: Error): void => {
    worker = null;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const start = (): Worker => {
    const w = new Worker(path.join(__dirname, 'local-session-usage-worker.js'));
    w.unref();
    w.on('message', (reply: WorkerReply) => {
      const p = pending.get(reply.id);
      if (!p) return;
      pending.delete(reply.id);
      if (reply.error !== undefined) p.reject(new Error(reply.error));
      else p.resolve(reply.usage ?? null);
    });
    w.on('error', (err) => failAll(err instanceof Error ? err : new Error(String(err))));
    w.on('exit', () => failAll(new Error('session parser worker exited')));
    return w;
  };

  return (filePath) => new Promise((resolve, reject) => {
    try {
      worker ??= start();
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, filePath });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function loadDefaultAnalyzer(): AnalyzeSessionFile | null {
  if (defaultAnalyzer !== undefined) return defaultAnalyzer;
  defaultAnalyzer = createWorkerAnalyzer();
  return defaultAnalyzer;
}

/** Map the parser's result to what the panel shows. Exported for tests. */
export function toLocalSessionUsage(provider: ActiveAgentSession['provider'], usage: ParsedSessionUsage): LocalSessionUsage {
  let primaryModel: string | null = null;
  let most = -1;
  for (const [model, u] of Object.entries(usage.modelUsage)) {
    const tokens = u.inputTokens + u.outputTokens;
    if (tokens > most) {
      most = tokens;
      primaryModel = model;
    }
  }
  return {
    primaryModel,
    models: [...usage.models],
    totalTokens: usage.totalTokens,
    credits: usage.copilotCredits,
    estimatedUsd: provider === 'copilot' ? usage.estimatedCostUsd.copilot : usage.estimatedCostUsd.provider,
  };
}

/**
 * Fill `localUsage` on every local session that has a session file. The parser
 * caches per file (path + mtime + size), so polling an unchanged session is a
 * few stats. A failure for one session leaves only that session without usage.
 */
export async function attachLocalSessionUsage(
  sessions: ActiveAgentSession[],
  analyze: AnalyzeSessionFile | null = loadDefaultAnalyzer(),
): Promise<void> {
  if (!analyze) return;
  await Promise.all(
    sessions.map(async (session) => {
      if (session.origin !== 'local' || !session.sessionFile) return;
      try {
        const usage = await analyze(session.sessionFile);
        session.localUsage = usage ? toLocalSessionUsage(session.provider, usage) : null;
      } catch (err) {
        logger.warn(`[local-session-usage] ${session.key}: ${err instanceof Error ? err.message : String(err)}`);
        session.localUsage = null;
      }
    }),
  );
}
