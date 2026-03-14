import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { renderChatMarkdown } from '../shared/utils';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

interface EmbeddedChatPanelProps {
  visible: boolean;
  selectedModel: string | null;
  onClose: () => void;
}

export function EmbeddedChatPanel({ visible, selectedModel, onClose }: EmbeddedChatPanelProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const registeredRef = useRef(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem('chat-panel-width');
    return saved ? parseInt(saved, 10) : 380;
  });

  const handlePanelClick = (e: MouseEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'BUTTON' || tag === 'TEXTAREA' || tag === 'A') return;
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
  }, []);

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
      <div class="ec-messages">
        {messages.length === 0 && !streaming && (
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
        {error && <div class="ec-error">\u26A0 {error}</div>}
        <div ref={messagesEndRef} />
      </div>
      <div class="ec-input-row">
        <textarea
          ref={inputRef}
          class="ec-input"
          rows={2}
          placeholder={streaming ? 'Waiting\u2026' : 'Ask something\u2026'}
          value={input}
          disabled={streaming || !selectedModel}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
        />
        <button
          class="ec-send"
          disabled={streaming || !input.trim() || !selectedModel}
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
