// ── IPC event payload types ────────────────────────────────────────────────────
// Typed interfaces for every IPC event emitted from the main process to the
// renderer via ipcRenderer.on(). Using named interfaces instead of
// Record<string, unknown> gives full IDE completion and makes payload
// mismatches a compile-time error.

export interface AgentSessionStartingPayload {
  sessionId: number;
  agentName: string;
  scopeType: string;
  scopeValue: string;
  workflowRunCount: number;
}

export interface AgentAnalysisCompletePayload {
  sessionId: number;
}

export interface AgentPhase2ErrorPayload {
  sessionId: number;
  message: string;
}

export interface AgentSessionCompletePayload {
  sessionId: number;
}

export interface AgentSessionErrorPayload {
  sessionId: number;
  message: string;
}

export interface AgentDebugContextPayload {
  sessionId: number;
  systemPrompt: string;
  userMessage: string;
}
