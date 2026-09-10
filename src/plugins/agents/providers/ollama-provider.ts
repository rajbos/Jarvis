// ── Ollama analysis provider (default tier) ──────────────────────────────────
// Two-phase local-model analysis: stream prose reasoning, then a second call
// asking the model to re-emit its findings as a ```json block. This is a
// workaround for local models that won't reliably produce clean structured
// output in a single pass — the Claude Agent SDK provider does not need it.
import { streamChat } from '../../../services/ollama';
import { extractJsonResult } from '../json-extract';
import type { AgentProvider, AgentRunCallbacks, AgentRunOutcome } from './types';

const PHASE2_TIMEOUT_MS = 60_000;

export const ollamaProvider: AgentProvider = {
  id: 'ollama',

  async run(model, systemPrompt, userMessage, callbacks: AgentRunCallbacks): Promise<AgentRunOutcome> {
    // ── Phase 1: stream the analysis / reasoning to the renderer ────────────
    let analysisResponse = '';
    await streamChat(
      model,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      (token) => {
        analysisResponse += token;
        callbacks.onToken(token);
      },
    );

    callbacks.onAnalysisComplete();

    // ── Phase 2: second call — emit ONLY the structured JSON ─────────────────
    // Pass the phase-1 response back as the assistant turn so the model has
    // full context, then ask it to output nothing but the JSON block.
    // A 60-second timeout guards against the model hanging indefinitely.
    let jsonResponse = '';
    const phase2Controller = new AbortController();
    const phase2Timer = setTimeout(() => phase2Controller.abort(), PHASE2_TIMEOUT_MS);
    try {
      await streamChat(
        model,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
          { role: 'assistant', content: analysisResponse },
          {
            role: 'user',
            content:
              'Based on your analysis above, output ONLY the JSON findings code block — no prose, no explanation. ' +
              'Start with ```json and end with ```. Nothing else.',
          },
        ],
        (token) => { jsonResponse += token; },
        phase2Controller.signal,
      );
    } catch (phase2Err) {
      const isTimeout = phase2Controller.signal.aborted;
      const phase2Msg = isTimeout
        ? 'Phase 2 timed out after 60 s — could not extract structured findings'
        : (phase2Err instanceof Error ? phase2Err.message : String(phase2Err));
      console.warn('[Agents] Phase 2 failed:', phase2Msg);
      callbacks.onFindingsError?.(phase2Msg);
      // Fall through — extractJsonResult will be tried on whatever partial response was received,
      // then fall back to phase-1 text before giving up.
    } finally {
      clearTimeout(phase2Timer);
    }

    // Parse findings from the dedicated JSON response; fall back to phase-1
    // in case the model puts it there anyway (backwards-compat).
    const parsed = extractJsonResult(jsonResponse) ?? extractJsonResult(analysisResponse);
    const summary = parsed?.summary ?? analysisResponse.slice(0, 300);
    const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];

    return { analysisText: analysisResponse, summary: summary ?? null, findings };
  },
};
