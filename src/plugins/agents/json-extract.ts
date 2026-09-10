// ── Structured-findings JSON extraction ──────────────────────────────────────
import type { AgentJsonResult } from '../types';

export type { AgentJsonResult, RawFinding } from '../types';

/**
 * Extract the first ```json ... ``` block from the agent response.
 * Returns null if none found or JSON is invalid.
 */
export function extractJsonResult(text: string): AgentJsonResult | null {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as AgentJsonResult;
  } catch {
    return null;
  }
}
