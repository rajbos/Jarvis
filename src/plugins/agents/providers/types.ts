// ── Agent analysis provider seam ─────────────────────────────────────────────
// An AgentProvider turns (systemPrompt, userMessage) into a finished analysis:
// streamed prose for the renderer plus structured findings ready to persist.
// This is what lets runAgentSession run the same session shape against either
// the local Ollama model (the default tier) or the Claude Agent SDK
// escalation tier, without the runner knowing which one it's talking to.
import type { RawFinding } from '../../types';

export type { RawFinding };

export interface AgentRunOutcome {
  /** Full prose analysis text (stored as agent_sessions.raw_result). */
  analysisText: string;
  summary: string | null;
  findings: RawFinding[];
}

export interface AgentRunCallbacks {
  onToken: (token: string) => void;
  /** Signals the renderer that streamed prose is done and findings extraction has begun. */
  onAnalysisComplete: () => void;
  /** Non-fatal: structured findings couldn't be extracted/validated. The run still completes. */
  onFindingsError?: (message: string) => void;
}

export interface AgentRunOptions {
  /** Repo working directory — only meaningful to providers that run their own tool loop (e.g. Claude Agent SDK). */
  cwd?: string;
  signal?: AbortSignal;
}

export interface AgentProvider {
  id: string;
  run(
    model: string,
    systemPrompt: string,
    userMessage: string,
    callbacks: AgentRunCallbacks,
    options?: AgentRunOptions,
  ): Promise<AgentRunOutcome>;
}
