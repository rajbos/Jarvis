// ── Claude Agent SDK analysis provider (escalation tier) ─────────────────────
// Runs a single headless Claude Agent SDK session (via services/claude-agent)
// with the repo's local clone as its working directory. Unlike the Ollama
// provider, structured findings come back directly from --json-schema —
// there's no two-phase "now emit only JSON" retry needed.
import { runClaudeAgentQuery } from '../../../services/claude-agent';
import type { AgentProvider, AgentRunCallbacks, AgentRunOptions, AgentRunOutcome } from './types';

export const claudeAgentProvider: AgentProvider = {
  id: 'claude-agent-sdk',

  async run(
    model,
    systemPrompt,
    userMessage,
    callbacks: AgentRunCallbacks,
    options?: AgentRunOptions,
  ): Promise<AgentRunOutcome> {
    if (!options?.cwd) {
      throw new Error(
        'Claude Agent SDK escalation requires a local repo clone — none is linked for this repository.',
      );
    }

    const result = await runClaudeAgentQuery(systemPrompt, userMessage, options.cwd, callbacks.onToken, {
      model,
      signal: options.signal,
    });

    callbacks.onAnalysisComplete();

    if (result.isError) {
      throw new Error(result.errorMessage || 'The Claude Agent SDK session ended in an error state.');
    }

    if (result.findings.length === 0) {
      callbacks.onFindingsError?.('Claude did not return structured findings for this session.');
    }

    return { analysisText: result.analysisText, summary: result.summary, findings: result.findings };
  },
};
