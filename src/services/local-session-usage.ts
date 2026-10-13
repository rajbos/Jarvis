// ── Local agent session usage ─────────────────────────────────────────────────
// Token usage and cost for running local sessions, read from each session's
// transcript / event log by the ai-engineering-fluency session parser
// (@rajbos/ai-engineering-fluency/session). Copilot logs carry the exact billed
// amount in AI credits; Claude Code logs only carry tokens, so those get an
// estimate at Anthropic API rates (a subscription has no per-session bill).

import type { ActiveAgentSession, LocalSessionUsage } from '../plugins/types';
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

/**
 * The package is loaded on first use with require(): tsconfig's node10 module
 * resolution can't see its `exports` subpath, while Node's require can. If it
 * fails to load, sessions simply show no usage.
 */
function loadDefaultAnalyzer(): AnalyzeSessionFile | null {
  if (defaultAnalyzer !== undefined) return defaultAnalyzer;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require('@rajbos/ai-engineering-fluency/session') as { analyzeSessionFile: AnalyzeSessionFile };
    defaultAnalyzer = (filePath) => lib.analyzeSessionFile(filePath);
  } catch (err) {
    logger.warn(`[local-session-usage] session parser unavailable: ${err instanceof Error ? err.message : String(err)}`);
    defaultAnalyzer = null;
  }
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
