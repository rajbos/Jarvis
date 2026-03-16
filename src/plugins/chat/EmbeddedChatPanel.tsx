import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { renderChatMarkdown } from '../shared/utils';
import { AgentApprovalPanel } from '../agents/AgentApprovalPanel';
import type { AgentSession } from '../types';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

interface EmbeddedChatPanelProps {
  visible: boolean;
  selectedModel: string | null;
  onClose: () => void;
  onAgentStart?: () => void; // called when first agent token arrives (so parent can show the panel)
  onNotificationsDismissed?: (ids: string[]) => void;
}

export function EmbeddedChatPanel({ visible, selectedModel, onClose, onAgentStart, onNotificationsDismissed }: EmbeddedChatPanelProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [agentStreaming, setAgentStreaming] = useState(false);
  const [agentStreamText, setAgentStreamText] = useState('');
  const [agentSession, setAgentSession] = useState<AgentSession | null>(null);
  const [agentSessionInfo, setAgentSessionInfo] = useState<{ agentName: string; scopeValue: string; workflowRunCount: number } | null>(null);
  const [agentDebugContext, setAgentDebugContext] = useState<{ systemPrompt: string; userMessage: string } | null>(null);
  const [debugExpanded, setDebugExpanded] = useState(false);
  const [extractingFindings, setExtractingFindings] = useState(false);
  const [extractingError, setExtractingError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const registeredRef = useRef(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const agentStreamRef = useRef('');
  const agentStartedRef = useRef(false);

  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem('chat-panel-width');
    return saved ? parseInt(saved, 10) : 380;
  });

  const handlePanelClick = (e: MouseEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'BUTTON' || tag === 'TEXTAREA' || tag === 'A') return;
    // Don't steal focus when the user just finished selecting text
    if (window.getSelection()?.toString()) return;
    inputRef.current?.focus();
  };

  const handleResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: panelWidth };
    const onMove = (mv: MouseEvent) => {
      if (!dragRef.current) return;
      const newW = Math.min(700, Math.max(250, dragRef.current.startWidth + (dragRef.current.startX - mv.clientX)));
      setPanelWidth(newW);
    };
    const onUp = (mv: MouseEvent) => {
      if (!dragRef.current) return;
      const newW = Math.min(700, Math.max(250, dragRef.current.startWidth + (dragRef.current.startX - mv.clientX)));
      localStorage.setItem('chat-panel-width', String(newW));
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  useEffect(() => {
    if (registeredRef.current) return;
    registeredRef.current = true;
    window.jarvis.onChatToken((token: string) => {
      setStreamText((prev) => prev + token);
    });
    window.jarvis.onChatDone(() => {
      setStreamText((prev) => {
        setMessages((msgs) => [...msgs, { role: 'assistant', content: prev }]);
        return '';
      });
      setStreaming(false);
    });
    window.jarvis.onChatError((err: string) => {
      setError(err);
      setStreaming(false);
      setStreamText('');
    });

    // ── Agent streaming listeners ──────────────────────────────────────────
    window.jarvis.onAgentSessionStarting?.((data) => {
      const { agentName, scopeValue, workflowRunCount } = data as { agentName: string; scopeValue: string; workflowRunCount: number };
      agentStreamRef.current = '';
      agentStartedRef.current = true;
      setMessages([]);
      setAgentStreamText('');
      setAgentStreaming(true);
      setAgentSession(null);
      setAgentSessionInfo({ agentName, scopeValue, workflowRunCount });
      setAgentDebugContext(null);
      setDebugExpanded(false);
      const runNote = workflowRunCount > 0 ? ` (${workflowRunCount} cached run${workflowRunCount !== 1 ? 's' : ''})` : ' (no cached runs — fetch first)';
      setMessages((msgs) => [...msgs, { role: 'user', content: `\ud83e\udd16 Analyse **${scopeValue}** for workflow failures${runNote}` }]);
      onAgentStart?.();
    });

    window.jarvis.onAgentDebugContext?.((data) => {
      const { systemPrompt, userMessage } = data as { systemPrompt: string; userMessage: string };
      setAgentDebugContext({ systemPrompt, userMessage });
    });

    window.jarvis.onAgentToken?.((token: string) => {
      agentStreamRef.current += token;
      setAgentStreamText(agentStreamRef.current);
      if (!agentStartedRef.current) {
        agentStartedRef.current = true;
        setAgentStreaming(true);
        setAgentSession(null);
        onAgentStart?.();
      }
    });

    window.jarvis.onAgentAnalysisComplete?.(({ sessionId: _sid }: { sessionId: number }) => {
      // Phase 1 done — flush analysis text and show extraction spinner
      const analysisText = agentStreamRef.current;
      agentStreamRef.current = '';
      setAgentStreamText('');
      if (analysisText) {
        // Strip the JSON findings block — the structured data is shown in the
        // approval panel below, not as raw text in the chat history.
        const textOnly = analysisText.replace(/```json[\s\S]*?```/g, '').trim();
        if (textOnly) {
          setMessages((msgs) => [...msgs, { role: 'assistant', content: textOnly }]);
        }
      }
      setExtractingFindings(true);
      setExtractingError(null);
    });

    window.jarvis.onAgentPhase2Error?.(({ message }: { sessionId: number; message: string }) => {
      setExtractingError(message);
    });

    window.jarvis.onAgentSessionComplete?.(({ sessionId }: { sessionId: number }) => {
      agentStreamRef.current = '';
      agentStartedRef.current = false;
      setAgentStreamText('');
      setAgentStreaming(false);
      setAgentSessionInfo(null);
      setExtractingFindings(false);
      setExtractingError(null);
      // Fetch full session with findings for approval panel
      window.jarvis.agentsGetSession?.(sessionId)
        .then((session) => {
          if (session) setAgentSession(session);
        })
        .catch((err: unknown) => console.error('[Chat] agentsGetSession:', err));
    });

    window.jarvis.onAgentSessionError?.(({ message }: { message: string }) => {
      agentStreamRef.current = '';
      agentStartedRef.current = false;
      setAgentStreamText('');
      setAgentStreaming(false);
      setError(`Agent failed: ${message}`);
    });
  }, [onAgentStart]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setError(null);
    const newMessages: ChatMsg[] = [...messages, { role: 'user', content: text }];
    setMessages(newMessages);
    setInput('');
    setStreaming(true);
    try {
      await window.jarvis.sendChatMessage(newMessages);
    } catch (e) {
      setError(String(e));
      setStreaming(false);
    }
  }, [input, messages, streaming]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div class={`ec-panel${visible ? '' : ' ec-panel-hidden'}`} style={{ width: `${panelWidth}px` }} onClick={handlePanelClick}>
      <div class="ec-resize-handle" onMouseDown={handleResizeStart} />
      <div class="ec-header">
        <span class="ec-title">Chat</span>
        {selectedModel && <span class="ec-model-badge">{selectedModel.split(':')[0]}</span>}
        <button class="ec-close-btn" title="Close chat" onClick={onClose}>&times;</button>
      </div>

      {/* Agent mode banner */}
      {(agentStreaming || agentSession) && (
        <div class="ec-agent-banner">
          {'🤖 '}
          {agentStreaming
            ? `Analysing ${agentSession?.scope_value ?? agentSessionInfo?.scopeValue ?? ''}…`
            : `Agent: ${agentSession?.agent_name ?? agentSessionInfo?.agentName ?? ''} — ${agentSession?.scope_value ?? agentSessionInfo?.scopeValue ?? ''}`}
          {agentStreaming && <span class="ec-agent-spinner" />}
        </div>
      )}

      <div class="ec-messages">
        {messages.length === 0 && !streaming && !agentStreaming && !agentSession && (
          <div class="ec-empty">
            {selectedModel
              ? 'Ask anything about your repos, orgs, or starred projects.'
              : 'Select an Ollama model first to start chatting.'}
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} class={`ec-bubble ${msg.role === 'user' ? 'ec-user' : 'ec-assistant'}`}
            dangerouslySetInnerHTML={{ __html: renderChatMarkdown(msg.content) }} />
        ))}
        {streaming && (
          <div class="ec-bubble ec-assistant">
            <span dangerouslySetInnerHTML={{ __html: renderChatMarkdown(streamText) }} />
            <span class="ec-cursor" />
          </div>
        )}
        {agentStreaming && !agentStreamText && (
          <div class="ec-bubble ec-assistant ec-agent-thinking">
            <span>
              {'Assembling context'}
              {agentSessionInfo && agentSessionInfo.workflowRunCount > 0
                ? ` (${agentSessionInfo.workflowRunCount} run${agentSessionInfo.workflowRunCount !== 1 ? 's' : ''})`
                : ''}
              {' and waiting for model response…'}
            </span>
            <span class="ec-cursor" />
          </div>
        )}
        {agentStreaming && agentStreamText && (
          <div class="ec-bubble ec-assistant ec-agent-stream">
            <span dangerouslySetInnerHTML={{ __html: renderChatMarkdown(agentStreamText) }} />
            <span class="ec-cursor" />
          </div>
        )}
        {extractingFindings && !extractingError && (
          <div class="ec-bubble ec-assistant ec-agent-thinking ec-extracting">
            <span class="ec-extracting-icon">{'🔍'}</span>
            <span>{'Parsing analysis and extracting structured findings…'}</span>
            <span class="ec-cursor" />
          </div>
        )}
        {extractingFindings && extractingError && (
          <div class="ec-bubble ec-assistant ec-extracting ec-extracting--error">
            <span class="ec-extracting-icon">{'⚠️'}</span>
            <span>{`Finding extraction failed: ${extractingError}`}</span>
          </div>
        )}
        {error && <div class="ec-error">{'\u26A0 '}{error}</div>}
        <div ref={messagesEndRef} />
      </div>

      {/* Debug context viewer — shown when LLM prompt context is available */}
      {agentDebugContext && (
        <div class="ec-debug-section">
          <button class="ec-debug-toggle" onClick={() => setDebugExpanded((v) => !v)}>
            {debugExpanded ? '\u25BC' : '\u25B6'}{' Debug: LLM prompt context'}
          </button>
          {debugExpanded && (
            <div class="ec-debug-body">
              <div class="ec-debug-label">System prompt</div>
              <pre class="ec-debug-pre">{agentDebugContext.systemPrompt}</pre>
              <div class="ec-debug-label">User message (assembled context)</div>
              <pre class="ec-debug-pre">{agentDebugContext.userMessage}</pre>
            </div>
          )}
        </div>
      )}

      {/* Approval panel rendered after agent session completes */}
      {agentSession && !agentStreaming && (
        <AgentApprovalPanel
          session={agentSession}
          onFindingUpdate={(sessionId) => {
            window.jarvis.agentsGetSession?.(sessionId)
              .then((s) => { if (s) setAgentSession(s); })
              .catch((err: unknown) => console.error('[Chat] agentsGetSession refresh:', err));
          }}
          onNotificationsDismissed={onNotificationsDismissed}
        />
      )}

      <div class="ec-input-row">
        <textarea
          ref={inputRef}
          class="ec-input"
          rows={2}
          placeholder={streaming || agentStreaming ? 'Waiting\u2026' : 'Ask something\u2026'}
          value={input}
          disabled={streaming || agentStreaming || !selectedModel}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
        />
        <button
          class="ec-send"
          disabled={streaming || agentStreaming || !input.trim() || !selectedModel}
          onClick={() => void handleSend()}
        >
          {streaming ? '\u2026' : '\u2191'}
        </button>
      </div>
      {streaming && (
        <div class="ec-hint">
          <button
            style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '0.75rem', padding: '0.25rem' }}
            onClick={() => void window.jarvis.abortChat()}>
            stop
          </button>
        </div>
      )}
    </div>
  );
}
